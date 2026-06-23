#!/usr/bin/env node
// doctor — verify the Codex↔ClawRouter link end to end and point at whatever's
// missing. Read-only.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.PORT ?? "8403";
const PROXY_PORT = process.env.PROXY_PORT ?? "8404";
const CODEX = join(homedir(), ".codex");
const BASE = join(CODEX, "config.toml");
const PROFILE = join(CODEX, "clawrouter.config.toml");
const CATALOG = join(CODEX, "clawrouter-catalog.json");

let fails = 0;
function line(ok, label, note, hint) {
  if (!ok) fails++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${note ? ` — ${note}` : ""}`);
  if (!ok && hint) console.log(`       ↳ ${hint}`);
}
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

console.log("\nclawrouter-codex doctor\n");

// 1. bridge
try {
  const h = await get(`http://127.0.0.1:${PORT}/health`);
  line(h.status === "ok", `bridge :${PORT}`, `→ ${h.upstream}`);
} catch (e) {
  line(false, `bridge :${PORT}`, e.message, "start it: `npm start`");
}

// 2. proxy + wallet + balance
try {
  const h = await get(`http://127.0.0.1:${PROXY_PORT}/health?full=true`);
  line(!!h.wallet, `proxy :${PROXY_PORT} wallet`, `${(h.wallet || "").slice(0, 12)}… ${h.balance ?? ""}`);
  line(!h.isEmpty, "wallet funded", h.isEmpty ? "empty — paid models fall back to free" : "ok",
    "send USDC (Base) to the wallet above");
} catch (e) {
  line(false, `proxy :${PROXY_PORT}`, e.message, "`npm start` brings it up");
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

console.log(`\n${fails === 0 ? "✅ all good — `codex --profile clawrouter`" : `❌ ${fails} issue(s) above`}\n`);
process.exit(fails === 0 ? 0 : 1);
