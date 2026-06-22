#!/usr/bin/env node
// desktop-toggle — flip Codex Desktop between native GPT (ChatGPT subscription)
// and ClawRouter, by editing the ROOT keys of ~/.codex/config.toml in place.
//
// The desktop app has no profile selector, so the only "switch" it honors is the
// base config. This script edits ONLY the root keys (model / model_provider /
// model_catalog_json) that sit before the first [table]; every table is left
// untouched. Restart Codex Desktop (Cmd+Q then reopen) for it to take effect.
//
//   node desktop-toggle.mjs on       # → ClawRouter (blockrun/auto, wallet/x402)
//   node desktop-toggle.mjs off      # → native GPT (gpt-5.5, ChatGPT subscription)
//   node desktop-toggle.mjs status   # → print current mode
//
// Customize via env: NATIVE_MODEL (default gpt-5.5), CLAW_MODEL (default
// blockrun/auto), CATALOG (default ~/.codex/clawrouter-catalog.json).

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG = join(homedir(), ".codex", "config.toml");
const CATALOG = process.env.CATALOG ?? join(homedir(), ".codex", "clawrouter-catalog.json");
const NATIVE_MODEL = process.env.NATIVE_MODEL ?? "gpt-5.5";
const CLAW_MODEL = process.env.CLAW_MODEL ?? "blockrun/auto";

const ROOT_KEYS = ["model", "model_provider", "model_catalog_json"];

/** Split config into [rootLines, tableLines] at the first `[` table header. */
function splitRoot(text) {
  const lines = text.split("\n");
  let firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTable === -1) firstTable = lines.length;
  return [lines.slice(0, firstTable), lines.slice(firstTable)];
}

/** Remove the given root keys from the root line block. */
function stripKeys(rootLines, keys) {
  return rootLines.filter((l) => !keys.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(l)));
}

/** Set a root key = value, replacing any existing line, else appending. */
function setKey(rootLines, key, valueToml) {
  const idx = rootLines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  const line = `${key} = ${valueToml}`;
  if (idx >= 0) rootLines[idx] = line;
  else rootLines.push(line);
  return rootLines;
}

/** Ensure the [model_providers.clawrouter] table exists somewhere in the tables block. */
function ensureProviderTable(tableLines) {
  if (tableLines.some((l) => /^\s*\[model_providers\.clawrouter\]/.test(l))) return tableLines;
  return [
    ...tableLines,
    "",
    "[model_providers.clawrouter]",
    'name = "ClawRouter"',
    'base_url = "http://localhost:8403/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
  ];
}

function currentMode(text) {
  const [root] = splitRoot(text);
  const provLine = root.find((l) => /^\s*model_provider\s*=/.test(l));
  return provLine && /clawrouter/.test(provLine) ? "on" : "off";
}

function main() {
  const cmd = process.argv[2];
  if (!existsSync(CONFIG)) {
    console.error(`config not found: ${CONFIG}`);
    process.exit(1);
  }
  const text = readFileSync(CONFIG, "utf8");

  if (cmd === "status") {
    const mode = currentMode(text);
    console.log(
      mode === "on"
        ? "ClawRouter ON  (desktop default → ClawRouter, wallet/x402)"
        : "ClawRouter OFF (desktop default → native GPT, ChatGPT subscription)",
    );
    return;
  }
  if (cmd !== "on" && cmd !== "off") {
    console.error("usage: desktop-toggle.mjs <on|off|status>");
    process.exit(1);
  }

  // Back up once per run.
  copyFileSync(CONFIG, `${CONFIG}.bak-toggle`);

  let [root, tables] = splitRoot(text);
  root = stripKeys(root, ROOT_KEYS);

  if (cmd === "on") {
    setKey(root, "model", JSON.stringify(CLAW_MODEL));
    setKey(root, "model_provider", '"clawrouter"');
    setKey(root, "model_catalog_json", JSON.stringify(CATALOG));
    tables = ensureProviderTable(tables);
  } else {
    setKey(root, "model", JSON.stringify(NATIVE_MODEL));
    // off: drop provider + catalog so the native (subscription) catalog returns.
  }

  // Trim trailing blank lines in root before the first table for tidiness.
  while (root.length && root[root.length - 1].trim() === "") root.pop();
  const out = [...root, "", ...tables].join("\n");
  writeFileSync(CONFIG, out);
  console.log(`ClawRouter ${cmd.toUpperCase()} → wrote ${CONFIG}`);
  console.log("Restart Codex Desktop (Cmd+Q, reopen) to apply. CLI picks it up on next run.");
}

main();
