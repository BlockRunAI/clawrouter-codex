#!/usr/bin/env node
// setup — wire Codex to ClawRouter in one command: generate the model catalog
// and write the `clawrouter` profile (~/.codex/clawrouter.config.toml). The base
// config is left untouched, so your ChatGPT-subscription default is preserved —
// use `codex --profile clawrouter` for ClawRouter models, `npm run desktop on`
// to surface them in Codex Desktop's picker. Run `npm start` first (or alongside)
// so the catalog can be generated from the live model list.

import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CODEX = join(homedir(), ".codex");
const PROFILE = join(CODEX, "clawrouter.config.toml");
const CATALOG = join(CODEX, "clawrouter-catalog.json");
const PORT = process.env.PORT ?? "8403";
const PROXY = process.env.CLAWROUTER_PROXY_URL ?? `http://localhost:${PORT}/v1`;

if (!existsSync(CODEX)) mkdirSync(CODEX, { recursive: true });

// 1. Generate the catalog from the live model list (needs the bridge running).
let catalogOk = false;
try {
  execFileSync(process.execPath, [join(ROOT, "src", "gen-catalog.mjs"), "--proxy", PROXY, "--out", CATALOG], {
    stdio: "inherit",
  });
  catalogOk = existsSync(CATALOG);
} catch {
  console.error("[setup] couldn't generate the catalog — is the bridge up? run `npm start` then re-run `npm run setup`.");
}

// 2. Write the CLI profile (base config stays as-is → subscription default kept).
const profile = `# ClawRouter profile for Codex — use with:  codex --profile clawrouter
# Base ~/.codex/config.toml is untouched, so plain \`codex\` stays on your default.
# Requires the local link up:  npm start  (proxy :8404 + bridge :${PORT})

model = "blockrun/auto"
model_provider = "clawrouter"
${catalogOk ? `model_catalog_json = "${CATALOG}"\n` : ""}
[model_providers.clawrouter]
name = "ClawRouter"
base_url = "http://localhost:${PORT}/v1"
wire_api = "responses"
requires_openai_auth = false
`;
writeFileSync(PROFILE, profile);
console.log(`[setup] wrote ${PROFILE}`);

const legacy = existsSync(join(CODEX, "config.toml"))
  ? /\[profiles\.clawrouter\]/.test(readFileSync(join(CODEX, "config.toml"), "utf8"))
  : false;
if (legacy) {
  console.log("[setup] ⚠ your config.toml has a legacy [profiles.clawrouter] table — remove it (Codex uses the separate clawrouter.config.toml now).");
}

console.log(`
Done. Next:
  npm start                    # bring up proxy + bridge (if not already)
  codex --profile clawrouter   # use ClawRouter models in the CLI
  npm run desktop on           # also show them in Codex Desktop's picker
  npm run websearch on         # enable live web search
  npm run doctor               # verify the whole link
`);
