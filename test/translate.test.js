import { test } from "node:test";
import assert from "node:assert/strict";
import {
  responsesToChat,
  chatToResponsesEvents,
  eventsToSSE,
  scavengeToolCalls,
} from "../src/translate.js";

test("scavenge: JSON tool-call leaked into content becomes a function_call", () => {
  // The exact leak shape seen in the desktop: {"type":"function","name":"get_goal","parameters":{}}
  const text = 'Let me check.\n{"type": "function", "name": "get_goal", "parameters": {}}\nDone.';
  const { toolCalls, cleanedText } = scavengeToolCalls(text, new Set(["get_goal"]));
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "get_goal");
  assert.ok(!cleanedText.includes("get_goal")); // stripped from visible prose
});

test("scavenge: ignores JSON whose name is not an allowed tool (no false positive)", () => {
  const text = '{"name":"not_a_tool","arguments":{}}';
  const { toolCalls } = scavengeToolCalls(text, new Set(["get_goal"]));
  assert.equal(toolCalls.length, 0);
});

test("scavenge: handles nested OpenAI and R1 shapes", () => {
  const nested = '{"type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}';
  const r1 = '{"tool_name":"shell","tool_args":{"cmd":"ls"}}';
  assert.equal(scavengeToolCalls(nested, new Set(["shell"])).toolCalls[0].function.name, "shell");
  assert.equal(scavengeToolCalls(r1, new Set(["shell"])).toolCalls[0].function.name, "shell");
});

test("leaked JSON tool call in chat content surfaces as a Responses function_call item", () => {
  const events = chatToResponsesEvents(
    {
      id: "c1",
      choices: [{ message: { role: "assistant", content: '{"type":"function","name":"get_goal","parameters":{}}' }, finish_reason: "stop" }],
    },
    { allowedTools: ["get_goal"] },
  );
  const fc = events.find((e) => e.type === "response.output_item.done" && e.data.item.type === "function_call");
  assert.ok(fc, "leaked JSON call should become a function_call item");
  assert.equal(fc.data.item.name, "get_goal");
  // and it should NOT also appear as a visible message
  const msg = events.find((e) => e.type === "response.output_item.done" && e.data.item.type === "message");
  assert.ok(!msg, "no visible message when content was purely the leaked call");
});

test("instructions become a leading system message", () => {
  const chat = responsesToChat({
    model: "blockrun/auto",
    instructions: "You are Codex.",
    input: [{ type: "message", role: "user", content: "hi" }],
  });
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "You are Codex.");
  assert.equal(chat.messages[1].role, "user");
  assert.equal(chat.messages[1].content, "hi");
  assert.equal(chat.stream, false);
});

test("typed content parts flatten to text", () => {
  const chat = responsesToChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] },
    ],
  });
  assert.equal(chat.messages[0].content, "ab");
});

test("Responses flat tools translate to nested chat tools", () => {
  const chat = responsesToChat({
    model: "m",
    input: [],
    tools: [
      { type: "function", name: "shell", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
  });
  assert.equal(chat.tools[0].type, "function");
  assert.equal(chat.tools[0].function.name, "shell");
  assert.deepEqual(chat.tools[0].function.parameters.properties.cmd, { type: "string" });
  assert.equal(chat.tool_choice, "auto");
  assert.equal(chat.parallel_tool_calls, true);
});

test("function_call + function_call_output round-trip with matching ids", () => {
  const chat = responsesToChat({
    model: "m",
    input: [
      { type: "message", role: "user", content: "list files" },
      { type: "function_call", call_id: "call_42", name: "shell", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_42", output: "a.txt\nb.txt" },
    ],
  });
  const assistant = chat.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tool_calls[0].id, "call_42");
  assert.equal(assistant.tool_calls[0].function.name, "shell");
  const tool = chat.messages.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, "call_42"); // MUST match the call_id
  assert.equal(tool.content, "a.txt\nb.txt");
});

test("reasoning items are dropped", () => {
  const chat = responsesToChat({
    model: "m",
    input: [{ type: "reasoning", summary: [], encrypted_content: "xxx" }],
  });
  assert.equal(chat.messages.length, 0);
});

test("assistant text completion → created/output_item.done/completed", () => {
  const events = chatToResponsesEvents(
    {
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    { model: "blockrun/auto" },
  );
  const types = events.map((e) => e.type);
  assert.ok(types.includes("response.created"));
  assert.ok(types.includes("response.output_item.done"));
  assert.equal(types[types.length - 1], "response.completed");

  const done = events.find((e) => e.type === "response.output_item.done");
  assert.equal(done.data.item.type, "message");
  assert.equal(done.data.item.content[0].type, "output_text");
  assert.equal(done.data.item.content[0].text, "hello world");

  const completed = events.at(-1);
  assert.equal(completed.data.response.usage.input_tokens, 10);
  assert.equal(completed.data.response.usage.output_tokens, 2);
});

test("tool call completion → function_call output item", () => {
  const events = chatToResponsesEvents({
    id: "chatcmpl-2",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_7", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const fc = events.find((e) => e.type === "response.output_item.done" && e.data.item.type === "function_call");
  assert.ok(fc, "should emit a function_call item");
  assert.equal(fc.data.item.call_id, "call_7");
  assert.equal(fc.data.item.name, "shell");
  assert.equal(fc.data.item.arguments, '{"cmd":"ls"}');
});

test("eventsToSSE emits type in both event line and data JSON", () => {
  const sse = eventsToSSE([{ type: "response.completed", data: { type: "response.completed", response: { id: "r1" } } }]);
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /data: \{"type":"response\.completed"/);
  assert.match(sse, /\n\n$/);
});
