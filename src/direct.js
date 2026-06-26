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
import { homedir } from "node:os";
import { join } from "node:path";
import { LLMClient, SearchClient } from "@blockrun/llm";

const DEFAULT_API = process.env.BLOCKRUN_API_URL ?? "https://blockrun.ai/api";

/** Resolve the EVM wallet key: explicit env → ~/.blockrun/.session (raw 0x key). */
export function resolveWalletKey() {
  const env = process.env.BLOCKRUN_WALLET_KEY ?? process.env.BASE_CHAIN_WALLET_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const raw = readFileSync(join(homedir(), ".blockrun", ".session"), "utf8");
    const m = raw.match(/0x[0-9a-fA-F]{64}/);
    if (m) return m[0];
  } catch {
    /* no local wallet — SDK will surface a funding error on first paid call */
  }
  return undefined;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
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
        const resp = await llm.chatCompletion(b.model, messages, {
          maxTokens: b.max_tokens,
          temperature: b.temperature,
          topP: b.top_p,
          tools: b.tools,
          toolChoice: b.tool_choice,
          stop: b.stop,
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

      // Spend stats: direct mode has no server-side ledger; return an empty
      // window so the dashboard renders without error.
      if (path.endsWith("/stats")) {
        return json({ days: 7, total: 0, daily: [] });
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
