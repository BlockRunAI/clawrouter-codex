// Pure translation between the OpenAI Responses API (what Codex speaks) and the
// OpenAI Chat Completions API (what the ClawRouter proxy speaks).
//
// No I/O, no dependencies — every function here is a pure transform so it can be
// unit-tested in isolation. The wire contract these functions target was read
// directly out of the Codex source (codex-rs/codex-api/src/sse/responses.rs):
//
//   * Codex sends  POST /v1/responses  with { model, instructions, input[],
//     tools[], tool_choice, parallel_tool_calls, store:false, stream:true }.
//   * Codex parses SSE `data:` JSON and dispatches on the `type` field. The
//     minimum it needs to complete a turn is:
//       response.created          { response:{id} }
//       response.output_item.done { item: <ResponseItem> }   ← the actual output
//       response.completed        { response:{id, usage} }    ← REQUIRED to end turn
//     A function call is an item of type "function_call"; assistant text is an
//     item of type "message" with content [{type:"output_text", text}].

/**
 * Flatten a Responses-API content value to plain text.
 * Content can be a bare string or an array of typed parts
 * ({type:"input_text"|"output_text"|..., text}).
 */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/**
 * Responses tools are FLAT: {type:"function", name, description, parameters, strict?}.
 * Chat tools are NESTED:    {type:"function", function:{name, description, parameters}}.
 * Translate flat → nested, while tolerating an already-nested shape.
 */
function translateTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (tool.function && typeof tool.function === "object") return tool; // already chat-shaped
  if (tool.type === "function" || tool.name) {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
      },
    };
  }
  return null; // unsupported tool type (web_search, etc.) — drop, don't crash
}

/**
 * Translate a single Responses `input` item into one or more Chat messages.
 * Returns an array (function_call → one assistant message; others → one message).
 */
function inputItemToMessages(item) {
  // Bare string shorthand: treat as a user message.
  if (typeof item === "string") return [{ role: "user", content: item }];
  if (!item || typeof item !== "object") return [];

  switch (item.type) {
    case "message": {
      const role = item.role ?? "user";
      return [{ role, content: contentToText(item.content) }];
    }
    case "function_call": {
      // Codex's prior assistant turn that invoked a tool.
      return [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id ?? item.id,
              type: "function",
              function: {
                name: item.name,
                arguments:
                  typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        },
      ];
    }
    case "function_call_output": {
      // The tool's result, fed back. tool_call_id MUST match the call_id we
      // emitted earlier or multi-turn tool loops break.
      return [
        {
          role: "tool",
          tool_call_id: item.call_id,
          content:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output ?? ""),
        },
      ];
    }
    case "reasoning":
      // Encrypted/again-sent reasoning items have no chat equivalent — drop.
      return [];
    default:
      // Unknown item type: best-effort fall back to its text, else drop.
      if (item.content !== undefined) {
        return [{ role: item.role ?? "user", content: contentToText(item.content) }];
      }
      return [];
  }
}

/**
 * Responses request body  →  Chat Completions request body.
 * Always forces stream:false: the ClawRouter proxy buffers a single JSON
 * completion internally anyway, and we synthesize the Responses SSE ourselves.
 */
export function responsesToChat(body) {
  const messages = [];
  if (body.instructions && typeof body.instructions === "string") {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = Array.isArray(body.input)
    ? body.input
    : body.input != null
      ? [body.input]
      : [];
  for (const item of input) {
    messages.push(...inputItemToMessages(item));
  }

  const chat = {
    model: body.model,
    messages,
    stream: false,
  };

  const tools = Array.isArray(body.tools)
    ? body.tools.map(translateTool).filter(Boolean)
    : [];
  if (tools.length > 0) {
    chat.tools = tools;
    if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
    if (body.parallel_tool_calls !== undefined)
      chat.parallel_tool_calls = body.parallel_tool_calls;
  }

  if (typeof body.max_output_tokens === "number") {
    chat.max_tokens = body.max_output_tokens;
  }

  return chat;
}

/** Map chat usage → responses usage field names. */
function translateUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens:
      usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

let monotonic = 0;
function nextId(prefix) {
  monotonic += 1;
  return `${prefix}_${monotonic.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Tool-call scavenging — recover function calls that a model emits as raw JSON
// inside text content instead of structured tool_calls. Handles the three common
// shapes (flat {name,arguments}, OpenAI-nested {type,function}, and {tool_name,
// tool_args}). Gated on the request's declared tool names so prose that merely
// mentions a tool is ignored.
// Example leak this catches: {"type":"function","name":"get_goal","parameters":{}}
// ---------------------------------------------------------------------------

/** Yield every brace-balanced top-level JSON object substring in `text`. */
function* iterateJsonObjects(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inString = false, escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escaped) { escaped = false; continue; }
      if (inString) {
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { yield [text.slice(i, j + 1), i, j + 1]; i = j; break; }
      }
    }
  }
}

function argsToString(raw) {
  if (raw == null) return "{}";
  if (typeof raw === "string") return raw;
  try { return JSON.stringify(raw); } catch { return "{}"; }
}

/** Coerce one candidate JSON object into {name, arguments} if it names an allowed tool. */
function coerceToolCall(candidateJson, allowed) {
  let obj;
  try { obj = JSON.parse(candidateJson); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  // Pattern 1 — { name, arguments|parameters } (flat). Covers the get_goal leak.
  if (typeof obj.name === "string" && allowed.has(obj.name)) {
    return { name: obj.name, arguments: argsToString(obj.arguments ?? obj.parameters) };
  }
  // Pattern 2 — OpenAI nested { type:"function", function:{ name, arguments } }.
  if (obj.type === "function" && obj.function && typeof obj.function === "object") {
    const fn = obj.function;
    if (typeof fn.name === "string" && allowed.has(fn.name)) {
      return { name: fn.name, arguments: argsToString(fn.arguments ?? fn.parameters) };
    }
  }
  // Pattern 3 — { tool_name, tool_args } (DeepSeek R1 free-form).
  if (typeof obj.tool_name === "string" && allowed.has(obj.tool_name)) {
    return { name: obj.tool_name, arguments: argsToString(obj.tool_args) };
  }
  return null;
}

/**
 * Scan assistant text for leaked JSON tool calls naming an allowed tool.
 * Returns { toolCalls, cleanedText } — recovered calls plus the text with those
 * JSON spans removed (so they don't surface as visible assistant prose).
 */
export function scavengeToolCalls(text, allowedNames, max = 8) {
  if (!text || !allowedNames || allowedNames.size === 0) {
    return { toolCalls: [], cleanedText: text ?? "" };
  }
  const toolCalls = [];
  const cuts = [];
  for (const [json, start, end] of iterateJsonObjects(text)) {
    if (toolCalls.length >= max) break;
    const call = coerceToolCall(json, allowedNames);
    if (call) {
      toolCalls.push({
        id: nextId("call"),
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      });
      cuts.push([start, end]);
    }
  }
  let cleanedText = text;
  for (let i = cuts.length - 1; i >= 0; i--) {
    cleanedText = cleanedText.slice(0, cuts[i][0]) + cleanedText.slice(cuts[i][1]);
  }
  return { toolCalls, cleanedText: cleanedText.trim() };
}

/**
 * Chat Completion JSON  →  ordered list of Responses-API SSE events.
 * Each element is { type, data } where `data` is the object to JSON-encode on
 * the SSE `data:` line. Caller serializes with eventsToSSE().
 *
 * Order: response.created → [output_text.delta] → output_item.done(message) →
 *        output_item.done(function_call)* → response.completed
 */
export function chatToResponsesEvents(chat, { responseId, model, allowedTools } = {}) {
  const id = responseId ?? nextId("resp");
  const choice = (chat.choices && chat.choices[0]) || {};
  const msg = choice.message || {};
  const events = [];
  const outputItems = [];

  events.push({
    type: "response.created",
    data: {
      type: "response.created",
      response: { id, object: "response", status: "in_progress", model: model ?? chat.model },
    },
  });

  let text = typeof msg.content === "string" ? msg.content : "";
  const structuredToolCalls = Array.isArray(msg.tool_calls) ? [...msg.tool_calls] : [];

  // Recover any tool calls the model leaked as JSON into the text content, and
  // strip them out so they don't surface as visible assistant prose.
  if (structuredToolCalls.length === 0 && text) {
    const { toolCalls, cleanedText } = scavengeToolCalls(text, new Set(allowedTools || []));
    if (toolCalls.length > 0) {
      structuredToolCalls.push(...toolCalls);
      text = cleanedText;
    }
  }
  if (text) {
    const itemId = nextId("msg");
    // Responses protocol: a text delta must have an ACTIVE item first, so open
    // the message item (output_item.added) BEFORE emitting output_text.delta —
    // otherwise Codex logs "OutputTextDelta without active item".
    events.push({
      type: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
      },
    });
    events.push({
      type: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    });
    const messageItem = {
      type: "message",
      id: itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    outputItems.push(messageItem);
    events.push({
      type: "response.output_item.done",
      data: { type: "response.output_item.done", output_index: 0, item: messageItem },
    });
  }

  structuredToolCalls.forEach((tc, i) => {
    const fnItem = {
      type: "function_call",
      id: nextId("fc"),
      call_id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments ?? "{}",
      status: "completed",
    };
    outputItems.push(fnItem);
    events.push({
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputItems.length - 1 + i,
        item: fnItem,
      },
    });
  });

  events.push({
    type: "response.completed",
    data: {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        model: model ?? chat.model,
        output: outputItems,
        usage: translateUsage(chat.usage),
      },
    },
  });

  return events;
}

/** Serialize event objects to an SSE wire string. */
export function eventsToSSE(events) {
  return (
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join("")
  );
}

export const _internal = { contentToText, translateTool, inputItemToMessages, translateUsage };
