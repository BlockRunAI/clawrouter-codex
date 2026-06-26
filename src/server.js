// clawrouter-codex — a front-adapter that lets OpenAI Codex run on BlockRun
// models. It translates Codex's Responses wire format ⇄ Chat Completions.
//
//   Codex ──/v1/responses──▶ [this bridge] ──▶ BlockRun
//
// Two payment paths, both via the injected `fetchImpl`:
//   • direct (default): src/direct.js pays BlockRun itself via @blockrun/llm
//     (plain per-request x402 on Base — one process, no proxy).
//   • proxy (BRIDGE_MODE=proxy): forward to a local `@blockrun/clawrouter`
//     proxy that holds the wallet and adds smart routing.

import { createServer } from "node:http";
import { responsesToChat, chatToResponsesEvents, eventsToSSE } from "./translate.js";
import * as Dashboard from "./dashboard.js";

const DEFAULT_PORT = 8403;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8402/v1";
// Sentinel upstream for decoupled mode: the host is irrelevant — requests are
// served by the @blockrun/llm-backed directFetch, not an HTTP proxy.
const DIRECT_UPSTREAM = "http://direct/v1";

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

// Web search the bridge executes INLINE (like a hosted tool), so it never reaches
// Codex's tool router. Enabled per-request via the `x-web-search` header (set by
// scripts/websearch-toggle.mjs) or the WEB_SEARCH=1 env. Backed by BlockRun Exa.
const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web (BlockRun Exa neural search). Returns ranked results " +
      "with titles, URLs, dates and snippets. Use for current events, latest docs, " +
      "versions, or anything past your training cutoff.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        numResults: { type: "number", description: "Max results (default 6)" },
      },
      required: ["query"],
    },
  },
};

async function runExaSearch(upstream, args, fetchImpl) {
  const body = { query: String(args.query ?? ""), numResults: Math.min(Number(args.numResults ?? 6), 15) };
  const r = await fetchImpl(`${upstream}/exa/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) return `web_search failed (${r.status}): ${t.slice(0, 200)}`;
  let j;
  try { j = JSON.parse(t); } catch { return `web_search returned non-JSON`; }
  const p = j.results ? j : j.data ?? j;
  const hits = Array.isArray(p.results) ? p.results : [];
  if (!hits.length) return `No web results for "${body.query}".`;
  return hits
    .slice(0, body.numResults)
    .map((h) => {
      const date = h.publishedDate ? ` (${String(h.publishedDate).slice(0, 10)})` : "";
      const snip = (h.text ?? h.snippet ?? "").toString().replace(/\s+/g, " ").trim().slice(0, 300);
      return `• ${h.title ?? "(untitled)"}${date}\n  ${h.url ?? ""}${snip ? `\n  ${snip}` : ""}`;
    })
    .join("\n");
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

  // Enable inline web search for this turn.
  const webSearch = process.env.WEB_SEARCH === "1" || req.headers["x-web-search"] === "1";
  if (webSearch) {
    chatBody.tools = [...(chatBody.tools ?? []), WEB_SEARCH_TOOL];
    if (chatBody.tool_choice === undefined) chatBody.tool_choice = "auto";
  }

  // Loop: call upstream; if the model asks ONLY for web_search, run it via Exa,
  // feed the results back, and re-ask — until it answers or calls a Codex tool.
  let chatJson;
  for (let iter = 0; iter < 4; iter++) {
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
    try {
      chatJson = JSON.parse(textBody);
    } catch (err) {
      writeSSE(res, failEvent(`upstream returned non-JSON: ${err.message}`));
      res.end();
      return;
    }

    if (!webSearch) break;
    const msg = chatJson.choices?.[0]?.message ?? {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const ws = calls.filter((c) => c.function?.name === "web_search");
    const others = calls.filter((c) => c.function?.name !== "web_search");
    // Only resolve inline when the model asked for web_search and nothing else;
    // mixed/other tool calls (shell, apply_patch…) belong to Codex.
    if (ws.length === 0 || others.length > 0) break;

    chatBody.messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const c of ws) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
      const result = await runExaSearch(upstream, args, fetchImpl).catch((e) => `web_search error: ${e.message}`);
      chatBody.messages.push({ role: "tool", tool_call_id: c.id, content: result });
    }
  }

  // Drop any unresolved web_search calls (loop cap hit, or mixed with a Codex
  // tool) — Codex has no executor for the bridge's inline tool, so leaking it as
  // a function_call would surface "unsupported call".
  const finalMsg = chatJson.choices?.[0]?.message;
  if (webSearch && Array.isArray(finalMsg?.tool_calls)) {
    finalMsg.tool_calls = finalMsg.tool_calls.filter((c) => c.function?.name !== "web_search");
    if (finalMsg.tool_calls.length === 0) delete finalMsg.tool_calls;
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
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      // `?full=true` surfaces wallet/balance — direct mode answers from the SDK,
      // proxy mode forwards to the proxy's /health. Used by `doctor` + dashboard.
      if (req.url.includes("full=true")) {
        fetchImpl(`${upstream}/health?full=true`)
          .then((r) => r.json())
          .then((d) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...d, upstream })); })
          .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", upstream, walletError: e.message })); });
        return;
      }
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
    // Dashboard: wallet balance, spend/usage, master switches.
    if (req.method === "GET" && (req.url === "/dashboard" || req.url === "/dashboard/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(Dashboard.HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/dashboard/api") {
      Dashboard.getData(upstream, fetchImpl)
        .then((d) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(d)); })
        .catch((e) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      return;
    }
    if (req.method === "POST" && req.url === "/dashboard/api/regen") {
      try {
        const count = Dashboard.regenCatalog(upstream);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, count }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/dashboard/api/setdefault")) {
      const model = new URL(req.url, "http://localhost").searchParams.get("model");
      try {
        Dashboard.setDefaultModel(model);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, model }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/dashboard/api/toggle")) {
      const params = new URL(req.url, "http://localhost").searchParams;
      try {
        const toggles = Dashboard.applyToggle(params.get("name"), params.get("on") === "1");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, toggles }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
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

export function startBridge({ port = DEFAULT_PORT, upstream = DEFAULT_UPSTREAM, fetchImpl = fetch } = {}) {
  const server = createBridge({ upstream, fetchImpl });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      // eslint-disable-next-line no-console
      console.log(`[clawrouter-codex] bridge listening on http://127.0.0.1:${addr.port}`);
      // eslint-disable-next-line no-console
      console.log(
        upstream === DIRECT_UPSTREAM
          ? `[clawrouter-codex] direct mode — paying BlockRun via @blockrun/llm (no proxy)`
          : `[clawrouter-codex] forwarding to ClawRouter proxy at ${upstream}`,
      );
      resolve({ server, port: addr.port });
    });
  });
}

// CLI entry: `node src/server.js`  (BLOCKRUN_DIRECT=1 → decoupled, pays via SDK)
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = { port: Number(process.env.PORT ?? DEFAULT_PORT) };
  if (process.env.BLOCKRUN_DIRECT === "1") {
    const { createDirectFetch } = await import("./direct.js");
    opts.fetchImpl = createDirectFetch();
    opts.upstream = DIRECT_UPSTREAM;
  } else {
    opts.upstream = process.env.CLAWROUTER_PROXY_URL ?? DEFAULT_UPSTREAM;
  }
  startBridge(opts);
}

export const _config = { DEFAULT_PORT, DEFAULT_UPSTREAM };
