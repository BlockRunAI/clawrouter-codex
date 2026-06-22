// clawrouter-codex — a thin front-adapter that lets OpenAI Codex talk to a
// running ClawRouter proxy.
//
//   Codex ──/v1/responses──▶ [this bridge] ──/v1/chat/completions──▶ ClawRouter ──x402──▶ BlockRun
//
// The bridge holds NO wallet and signs NO payments: routing, x402 micropayments
// and model fallback all stay in the canonical ClawRouter proxy. This process
// only translates the Responses wire format ⇄ Chat Completions, exactly the way
// the Hermes adapter forwards to a spawned `npx @blockrun/clawrouter` proxy.

import { createServer } from "node:http";
import { responsesToChat, chatToResponsesEvents, eventsToSSE } from "./translate.js";

const DEFAULT_PORT = 8403;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8402/v1";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeSSE(res, sse) {
  res.write(sse);
}

/** Emit a Responses `response.failed` event so Codex surfaces a real error. */
function failEvent(message) {
  return eventsToSSE([
    {
      type: "response.failed",
      data: {
        type: "response.failed",
        response: { status: "failed", error: { code: "upstream_error", message } },
      },
    },
  ]);
}

export async function handleResponses(req, res, { upstream, fetchImpl = fetch }) {
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = JSON.parse(raw.toString() || "{}");
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `invalid JSON body: ${err.message}` } }));
    return;
  }

  const chatBody = responsesToChat(parsed);

  // Codex always sends stream:true and expects an SSE response, so open the
  // stream up front regardless of how we fetch upstream.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  // Forward client headers, but DROP the ChatGPT auth that Codex attaches when
  // the provider is configured with `requires_openai_auth = true`. We set that
  // flag only to keep Codex Desktop in "ChatGPT mode" (so the model picker
  // renders custom models — see filter_by_auth in codex-rs); ClawRouter itself
  // authenticates with the wallet via x402, so the ChatGPT token is irrelevant
  // and must not leak upstream. We never forward it to OpenAI either → no ToS issue.
  const STRIP = new Set([
    "host", "connection", "content-length", "transfer-encoding", "accept",
    "authorization", "chatgpt-account-id",
  ]);
  const headers = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP.has(k) || k.startsWith("x-codex-") || k.startsWith("openai-")) continue;
    if (typeof v === "string") headers[k] = v;
  }

  let upstreamResp;
  try {
    upstreamResp = await fetchImpl(`${upstream}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(chatBody),
    });
  } catch (err) {
    writeSSE(res, failEvent(`cannot reach ClawRouter proxy at ${upstream}: ${err.message}`));
    res.end();
    return;
  }

  const textBody = await upstreamResp.text();
  if (!upstreamResp.ok) {
    writeSSE(res, failEvent(`upstream ${upstreamResp.status}: ${textBody.slice(0, 500)}`));
    res.end();
    return;
  }

  let chatJson;
  try {
    chatJson = JSON.parse(textBody);
  } catch (err) {
    writeSSE(res, failEvent(`upstream returned non-JSON: ${err.message}`));
    res.end();
    return;
  }

  const allowedTools = Array.isArray(parsed.tools)
    ? parsed.tools.map((t) => t?.name ?? t?.function?.name).filter(Boolean)
    : [];
  const events = chatToResponsesEvents(chatJson, { model: chatBody.model, allowedTools });
  writeSSE(res, eventsToSSE(events));
  res.end();
}

/**
 * Ollama-native model list. Codex's built-in "ollama" OSS provider populates its
 * (desktop-visible) model picker by GETting `/api/tags` and reading models[].name.
 * We synthesize it from ClawRouter's OpenAI-style `/v1/models`, so impersonating an
 * Ollama server on :11434 makes all ClawRouter models show up — and switchable —
 * in the same lane Ollama uses. See codex-rs/ollama/src/client.rs.
 */
async function handleOllamaTags(req, res, { upstream, fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(`${upstream}/models`, { method: "GET" });
    const list = await r.json();
    const data = Array.isArray(list?.data) ? list.data : [];
    const models = data.map((m) => ({
      name: m.id,
      model: m.id,
      modified_at: "1970-01-01T00:00:00Z",
      size: 0,
      digest: "",
      details: { family: "clawrouter", parameter_size: "", quantization_level: "" },
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models }));
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `cannot list models from ${upstream}: ${err.message}` } }));
  }
}

/** Ollama version probe — Codex checks this to confirm a live Ollama host. */
function handleOllamaVersion(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ version: "clawrouter-codex" }));
}

/** Pass GET /v1/models (and other GETs) straight through to the proxy. */
async function passthrough(req, res, { upstream, fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(`${upstream}${req.url.replace(/^\/v1/, "")}`, { method: req.method });
    const body = await r.text();
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
}

export function createBridge({ upstream = DEFAULT_UPSTREAM, fetchImpl = fetch } = {}) {
  return createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", upstream }));
      return;
    }
    // Ollama-native surface — lets this process impersonate an Ollama server so
    // ClawRouter models appear in Codex's desktop-visible OSS model picker.
    if (req.method === "GET" && req.url === "/api/tags") {
      handleOllamaTags(req, res, { upstream, fetchImpl });
      return;
    }
    if (req.method === "GET" && (req.url === "/api/version" || req.url?.startsWith("/api/version?"))) {
      handleOllamaVersion(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      handleResponses(req, res, { upstream, fetchImpl }).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(failEvent(err.message));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/v1/")) {
      passthrough(req, res, { upstream, fetchImpl });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
}

export function startBridge({ port = DEFAULT_PORT, upstream = DEFAULT_UPSTREAM } = {}) {
  const server = createBridge({ upstream });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      // eslint-disable-next-line no-console
      console.log(`[clawrouter-codex] bridge listening on http://127.0.0.1:${addr.port}`);
      // eslint-disable-next-line no-console
      console.log(`[clawrouter-codex] forwarding to ClawRouter proxy at ${upstream}`);
      resolve({ server, port: addr.port });
    });
  });
}

// CLI entry: `node src/server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  startBridge({
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    upstream: process.env.CLAWROUTER_PROXY_URL ?? DEFAULT_UPSTREAM,
  });
}

export const _config = { DEFAULT_PORT, DEFAULT_UPSTREAM };
