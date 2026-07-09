// direct.js — decoupled payment path.
//
// Instead of forwarding to a locally-spawned `@blockrun/clawrouter` proxy, this
// adapter pays BlockRun directly via the official `@blockrun/llm` SDK (x402 on
// Base, plain per-request — no pre-auth cache, so no underpayment bug). It
// exposes a `fetch`-shaped function that serves the exact proxy API surface the
// bridge already calls (`/chat/completions`, `/models`, `/exa/search`,
// `/health`, `/stats`), so server.js / translate.js are reused unchanged.
//
//   Codex → bridge (translate) → @blockrun/llm → blockrun.ai      (no proxy)

import { readFileSync } from "node:fs";
import { LLMClient, SearchClient } from "@blockrun/llm";
import { resolvePrivateKey, paths } from "@blockrun/core";

const DEFAULT_API = process.env.BLOCKRUN_API_URL ?? "https://blockrun.ai/api";
// Fallback model when smart routing is unavailable. Override w/ BLOCKRUN_DEFAULT_MODEL.
const DEFAULT_MODEL = process.env.BLOCKRUN_DEFAULT_MODEL ?? "anthropic/claude-opus-4.5";
const AUTO = new Set(["blockrun/auto", "auto", ""]);

// Smart routing: reuse ClawRouter's real routing engine (rules-based, <1ms,
// local) so `blockrun/auto` picks the cheapest capable model — but keep paying
// via @blockrun/llm with the full messages + tools (the SDK's own `smartChat`
// is prompt-only). Loaded lazily; if unavailable, `auto` falls back to
// DEFAULT_MODEL. Set BLOCKRUN_NO_ROUTING=1 to disable.
let _router; // undefined = not tried, null = unavailable, object = ready
async function getRouter() {
  if (_router !== undefined) return _router;
  if (process.env.BLOCKRUN_NO_ROUTING === "1") return (_router = null);
  try {
    const { route, DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS } = await import("@blockrun/clawrouter");
    const modelPricing = new Map(
      BLOCKRUN_MODELS.filter((m) => !AUTO.has(m.id)).map((m) => [
        m.id,
        { inputPrice: m.inputPrice, outputPrice: m.outputPrice },
      ]),
    );
    _router = { route, opts: { config: DEFAULT_ROUTING_CONFIG, modelPricing } };
  } catch {
    _router = null; // @blockrun/clawrouter not resolvable — degrade to default model
  }
  return _router;
}

/** Resolve `blockrun/auto` to a concrete model via ClawRouter's router (full
 *  request context), returning { model, fallbackModels }. Falls back to
 *  DEFAULT_MODEL when routing is unavailable; passes concrete models through. */
async function resolveRouting(model, messages, maxTokens, hasTools) {
  if (!AUTO.has(model ?? "")) return { model };
  const r = await getRouter();
  if (!r) return { model: DEFAULT_MODEL };
  const sys = messages.filter((m) => m?.role === "system" && typeof m.content === "string").map((m) => m.content).join("\n") || undefined;
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content : "";
  try {
    const d = r.route(prompt, sys, Number(maxTokens) || 1024, { ...r.opts, hasTools: Boolean(hasTools) });
    if (d?.model) {
      // eslint-disable-next-line no-console
      console.log(`[clawrouter-codex] auto → ${d.model} (${d.tier})`);
      return { model: d.model, fallbackModels: Array.isArray(d.fallbacks) ? d.fallbacks : undefined };
    }
  } catch { /* fall through */ }
  return { model: DEFAULT_MODEL };
}

/**
 * Resolve the EVM wallet key: explicit env → ~/.blockrun/.session.
 *
 * Delegated to `@blockrun/core` so the resolution order (env
 * BLOCKRUN_WALLET_KEY|BASE_CHAIN_WALLET_KEY → ~/.blockrun/.session → legacy
 * wallet.key) is the single source of truth shared with the SDK, the umbrella
 * `blockrun` CLI, and every other BlockRun product. Returns undefined when no
 * wallet exists (the SDK then surfaces a funding error on first paid call).
 */
export function resolveWalletKey() {
  return resolvePrivateKey()?.privateKey;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Chat endpoints in the SDK cost log (LLM spend — excludes image/video/etc).
const CHAT_ENDPOINTS = new Set(["/v1/chat/completions", "/api/v1/chat/completions", "/v1/messages"]);

/**
 * Build a 7-day spend summary from the SDK's local cost log
 * (~/.blockrun/cost_log.jsonl, one JSON CostEntry per line), filtered to chat
 * endpoints. Shapes the result for the dashboard's spend panel. Returns an
 * empty window if the log is missing/unreadable.
 */
function buildStats() {
  const empty = { days: 7, totalRequests: 0, totalCost: 0, dailyBreakdown: [], byModel: {} };
  let raw;
  try {
    // Path from @blockrun/core so BLOCKRUN_HOME isolation and any future layout
    // change apply here too (previously hand-joined against os.homedir()).
    raw = readFileSync(paths().costLog, "utf8");
  } catch {
    return empty;
  }
  const nowSec = Date.now() / 1000;
  const weekAgo = nowSec - 7 * 86_400;
  const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const byDay = new Map();
  const byModel = {};
  let totalCost = 0;
  let totalRequests = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.ts !== "number" || e.ts < weekAgo) continue;
    if (e.endpoint && !CHAT_ENDPOINTS.has(e.endpoint)) continue;
    const cost = Number(e.cost_usd) || 0;
    totalCost += cost;
    totalRequests += 1;
    if (e.model) byModel[e.model] = (byModel[e.model] ?? 0) + cost;
    const d = byDay.get(dayKey(e.ts)) ?? { cost: 0, requests: 0 };
    d.cost += cost;
    d.requests += 1;
    byDay.set(dayKey(e.ts), d);
  }
  const dailyBreakdown = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(nowSec - i * 86_400);
    const d = byDay.get(key) ?? { cost: 0, requests: 0 };
    dailyBreakdown.push({ date: key, cost: d.cost, requests: d.requests });
  }
  return { days: 7, totalRequests, totalCost, dailyBreakdown, byModel };
}

/**
 * Build a `fetch`-compatible function backed by @blockrun/llm. Only the path is
 * significant (the host is ignored), so the bridge can keep calling
 * `${upstream}/chat/completions` etc. with a dummy upstream like
 * `http://direct/v1`.
 */
export function createDirectFetch(opts = {}) {
  const privateKey = opts.privateKey ?? resolveWalletKey();
  const apiUrl = opts.apiUrl ?? DEFAULT_API;
  const llm = new LLMClient({ privateKey, apiUrl });
  const search = new SearchClient({ privateKey, apiUrl });

  return async function directFetch(url, init = {}) {
    const path = new URL(url, "http://direct").pathname;
    const method = (init.method ?? "GET").toUpperCase();
    try {
      // Chat completion (the hot path). Map OpenAI snake_case → SDK camelCase.
      if (path.endsWith("/chat/completions") && method === "POST") {
        const b = JSON.parse(init.body);
        // The gateway accepts only system/user/assistant/tool. Codex emits a
        // `developer` role (and the ClawRouter proxy used to fold it into
        // system); do the same here so the direct path matches.
        const messages = (b.messages ?? []).map((m) =>
          m && m.role === "developer" ? { ...m, role: "system" } : m,
        );
        // `blockrun/auto` → smart-routed model (full request context); concrete
        // models pass through. Routing decision also yields a fallback chain.
        const { model, fallbackModels } = await resolveRouting(
          b.model, messages, b.max_tokens, b.tools?.length,
        );
        const resp = await llm.chatCompletion(model, messages, {
          maxTokens: b.max_tokens,
          temperature: b.temperature,
          topP: b.top_p,
          tools: b.tools,
          toolChoice: b.tool_choice,
          stop: b.stop,
          fallbackModels,
        });
        return json(resp);
      }

      // Model list — live from blockrun.ai (source of truth), shaped like the
      // proxy's OpenAI `/v1/models`.
      if (path.endsWith("/models") && method === "GET") {
        const models = await llm.listModels();
        return json({ object: "list", data: models });
      }

      // Inline web search (the bridge's web_search switch). The SDK returns a
      // synthesized summary + citations; expose it in the {results:[…]} shape
      // runExaSearch already parses.
      if (path.endsWith("/exa/search") && method === "POST") {
        const b = JSON.parse(init.body);
        const r = await search.search(String(b.query ?? ""), {
          maxResults: Number(b.numResults) || undefined,
        });
        const cites = Array.isArray(r.citations) ? r.citations : [];
        const results = cites.length
          ? cites.map((c) => ({ title: c.title ?? "source", url: c.url ?? "", text: c.snippet ?? c.text ?? "" }))
          : [{ title: "Web search", url: cites[0]?.url ?? "", text: r.summary ?? "" }];
        return json({ results, summary: r.summary, citations: cites });
      }

      // Health + wallet/balance for the dashboard.
      if (path.endsWith("/health")) {
        if (!String(url).includes("full=true")) return json({ status: "ok", mode: "direct" });
        let balance = 0;
        let address = "";
        try { balance = await llm.getBalance(); } catch { /* leave 0 */ }
        try { address = search.getWalletAddress(); } catch { /* leave "" */ }
        return json({
          status: "ok",
          mode: "direct",
          paymentChain: "base",
          wallet: address,
          address,
          balance: `$${balance.toFixed(2)}`,
          isEmpty: balance <= 0,
        });
      }

      // Spend stats: build a 7-day window from the SDK's local cost log
      // (~/.blockrun/cost_log.jsonl) — direct mode has no server-side ledger,
      // but the SDK records every settled payment with a timestamp.
      if (path.endsWith("/stats")) {
        return json(buildStats());
      }

      return json({ error: { message: `direct: unsupported ${method} ${path}` } }, 404);
    } catch (e) {
      // Surface as a non-ok HTTP response so the bridge's `!resp.ok` path turns
      // it into a Responses `response.failed` event for Codex.
      const message = e?.message ?? String(e);
      const status = Number.isInteger(e?.statusCode) ? e.statusCode : 502;
      return json({ error: { message } }, status);
    }
  };
}
