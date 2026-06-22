// End-to-end: spin a MOCK ClawRouter upstream + the real bridge, send a
// Codex-shaped /v1/responses request, and verify the SSE we stream back parses
// the way Codex's own parser does (dispatch on the data-JSON `type` field).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createBridge } from "../src/server.js";

/** Minimal mock of the ClawRouter proxy: records the chat body, returns canned JSON. */
function startMockUpstream(responder) {
  return new Promise((resolve) => {
    const received = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        received.push({ url: req.url, body });
        const json = responder(body, received.length);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, received, upstream: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function startBridgeOn(upstream) {
  return new Promise((resolve) => {
    const server = createBridge({ upstream });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Parse an SSE string the way Codex does: collect each `data:` JSON, keyed by its `type`. */
function parseSSE(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const json = JSON.parse(dataLine.slice("data:".length).trim());
    events.push(json); // Codex dispatches on json.type
  }
  return events;
}

test("text turn: Responses request → translated chat call → Codex-parseable SSE", async () => {
  const mock = await startMockUpstream((_body) => ({
    id: "chatcmpl-abc",
    object: "chat.completion",
    model: "nvidia/deepseek-v4",
    choices: [{ index: 0, message: { role: "assistant", content: "2 + 2 = 4" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  }));
  const bridge = await startBridgeOn(mock.upstream);

  const resp = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "blockrun/auto",
      instructions: "You are Codex.",
      input: [{ type: "message", role: "user", content: "what is 2+2?" }],
      stream: true,
      store: false,
    }),
  });
  assert.equal(resp.headers.get("content-type"), "text/event-stream");
  const events = parseSSE(await resp.text());
  const types = events.map((e) => e.type);

  // Codex's hard requirements
  assert.ok(types.includes("response.created"));
  assert.ok(types.includes("response.output_item.done"));
  assert.equal(types.at(-1), "response.completed"); // else "stream closed before response.completed"

  const msg = events.find((e) => e.type === "response.output_item.done").item;
  assert.equal(msg.type, "message");
  assert.equal(msg.content[0].text, "2 + 2 = 4");
  assert.equal(events.at(-1).response.usage.input_tokens, 20);

  // The upstream actually received a correctly translated chat call
  const sent = mock.received[0];
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.body.stream, false); // we force non-streaming internally
  assert.equal(sent.body.messages[0].role, "system");
  assert.equal(sent.body.messages[1].content, "what is 2+2?");

  mock.server.close();
  bridge.server.close();
});

test("tool turn: function_call surfaces as a Responses function_call item", async () => {
  const mock = await startMockUpstream(() => ({
    id: "chatcmpl-tool",
    object: "chat.completion",
    model: "openai/gpt-5.3-codex",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_99", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
  }));
  const bridge = await startBridgeOn(mock.upstream);

  const resp = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "blockrun/auto",
      input: [{ type: "message", role: "user", content: "list files" }],
      tools: [{ type: "function", name: "shell", description: "run a shell command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      stream: true,
    }),
  });
  const events = parseSSE(await resp.text());

  const fc = events.find((e) => e.type === "response.output_item.done" && e.item.type === "function_call");
  assert.ok(fc, "expected a function_call output item");
  assert.equal(fc.item.call_id, "call_99");
  assert.equal(fc.item.name, "shell");
  assert.equal(fc.item.arguments, '{"cmd":"ls"}');
  assert.equal(events.at(-1).type, "response.completed");

  // Tools were translated flat → nested for the upstream chat call
  const sentTool = mock.received[0].body.tools[0];
  assert.equal(sentTool.function.name, "shell");

  mock.server.close();
  bridge.server.close();
});

test("multi-turn: function_call_output feeds back with matching tool_call_id", async () => {
  // Second turn: Codex sends back the prior function_call + its output.
  const mock = await startMockUpstream(() => ({
    id: "chatcmpl-2",
    choices: [{ index: 0, message: { role: "assistant", content: "Found 2 files." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
  }));
  const bridge = await startBridgeOn(mock.upstream);

  await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "blockrun/auto",
      input: [
        { type: "message", role: "user", content: "list files" },
        { type: "function_call", call_id: "call_99", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_99", output: "a.txt\nb.txt" },
      ],
      stream: true,
    }),
  }).then((r) => r.text());

  const msgs = mock.received[0].body.messages;
  const assistant = msgs.find((m) => m.role === "assistant" && m.tool_calls);
  const toolMsg = msgs.find((m) => m.role === "tool");
  assert.equal(assistant.tool_calls[0].id, "call_99");
  assert.equal(toolMsg.tool_call_id, "call_99"); // the round-trip the whole thing hinges on
  assert.equal(toolMsg.content, "a.txt\nb.txt");

  mock.server.close();
  bridge.server.close();
});

test("Ollama /api/tags lists ClawRouter models for the picker", async () => {
  // Mock upstream that answers GET /v1/models like ClawRouter does.
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "blockrun/auto" }, { id: "nvidia/deepseek-v4" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${server.address().port}/v1`;
  const bridge = await startBridgeOn(upstream);

  const resp = await fetch(`http://127.0.0.1:${bridge.port}/api/tags`);
  const json = await resp.json();
  const names = json.models.map((m) => m.name);
  assert.deepEqual(names, ["blockrun/auto", "nvidia/deepseek-v4"]); // what Codex reads into the picker

  server.close();
  bridge.server.close();
});

test("upstream error becomes a response.failed event", async () => {
  // Mock that returns a 500-ish by throwing JSON the bridge can't treat as ok.
  const server = createServer((req, res) => {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "payment required" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${server.address().port}/v1`;
  const bridge = await startBridgeOn(upstream);

  const resp = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "blockrun/auto", input: [{ type: "message", role: "user", content: "hi" }], stream: true }),
  });
  const events = parseSSE(await resp.text());
  assert.equal(events.at(-1).type, "response.failed");
  assert.match(events.at(-1).response.error.message, /402/);

  server.close();
  bridge.server.close();
});
