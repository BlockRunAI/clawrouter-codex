#!/usr/bin/env node
// doctor — verify the Codex↔ClawRouter link end to end and point at whatever's
// missing. Read-only.
//
// `--json` emits the BlockRun output contract from @blockrun/core
// ({ok,data:{checks,fails}}) so the umbrella `blockrun` CLI and agents can
// parse it; human output is unchanged.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok as okEnv, err as errEnv, render } from "@blockrun/core";

const PORT = process.env.PORT ?? "8403";
const CODEX = join(homedir(), ".codex");
const BASE = join(CODEX, "config.toml");
const PROFILE = join(CODEX, "clawrouter.config.toml");
const CATALOG = join(CODEX, "clawrouter-catalog.json");
const json = process.argv.includes("--json");

let fails = 0;
const checks = [];
function line(ok, label, note, hint) {
  if (!ok) fails++;
  checks.push({ ok, label, ...(note ? { note } : {}), ...(!ok && hint ? { hint } : {}) });
  if (json) return;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${note ? ` — ${note}` : ""}`);
  if (!ok && hint) console.log(`       ↳ ${hint}`);
}
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

if (!json) console.log("\nclawrouter-codex doctor\n");

// 1. bridge + mode
let direct = true;
try {
  const h = await get(`http://127.0.0.1:${PORT}/health`);
  direct = h.upstream === "http://direct/v1";
  line(h.status === "ok", `bridge :${PORT}`, direct ? "direct mode (pays via @blockrun/llm, no proxy)" : `proxy mode → ${h.upstream}`);
} catch (e) {
  line(false, `bridge :${PORT}`, e.message, "start it: `npx @blockrun/clawrouter-codex start`");
}

// 2. wallet + balance (same endpoint in both modes — the bridge surfaces it)
try {
  const h = await get(`http://127.0.0.1:${PORT}/health?full=true`);
  line(!!h.wallet, "wallet", `${(h.wallet || "").slice(0, 12)}… ${h.balance ?? ""}`);
  line(!h.isEmpty, "wallet funded", h.isEmpty ? "empty — paid models fall back to free" : "ok",
    "send USDC (Base) to the wallet above");
} catch (e) {
  line(false, "wallet", e.message, "is the bridge up? `npx @blockrun/clawrouter-codex start`");
}

// 3. catalog
let n = 0;
try { n = JSON.parse(read(CATALOG)).models.length; } catch {}
line(n > 0, "model catalog", n ? `${n} models` : "missing", "`npm run gen-catalog` (bridge must be up)");

// 4. Codex config wiring
const profileOk = /\[model_providers\.clawrouter\]/.test(read(PROFILE));
line(profileOk, "CLI profile (clawrouter.config.toml)", profileOk ? "ok" : "missing", "`npm run setup`");
const desktopOn = read(BASE).split("\n").some((l) => /^\s*model_provider\s*=\s*"clawrouter"/.test(l));
line(true, "desktop mode", desktopOn ? "ON (base routes to ClawRouter)" : "off (base = native default)");
const webOn = [BASE, PROFILE].some((f) => /x-web-search/.test(read(f)));
line(true, "web search", webOn ? "ON" : "off");

// 5. legacy guard
if (/\[profiles\.clawrouter\]/.test(read(BASE))) {
  line(false, "no legacy profile table", "config.toml still has [profiles.clawrouter]",
    "remove it — Codex v2 uses the separate clawrouter.config.toml");
}

if (json) {
  const env = fails === 0 ? okEnv({ checks, fails }) : errEnv("doctor", `${fails} issue(s)`, undefined);
  // Attach the checks to failures too, so agents always see the full picture.
  console.log(render(fails === 0 ? env : { ...env, error: { ...env.error, checks } }, "json"));
} else {
  console.log(`\n${fails === 0 ? "✅ all good — `codex --profile clawrouter`" : `❌ ${fails} issue(s) above`}\n`);
}
process.exit(fails === 0 ? 0 : 1);
