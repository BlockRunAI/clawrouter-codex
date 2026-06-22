#!/usr/bin/env node
// websearch-toggle — switch live web search on/off for ClawRouter models in Codex.
//
// Codex's built-in (hosted) web_search can't run through a custom provider, so the
// bridge executes web search ITSELF via BlockRun Exa. It does so when the request
// carries an `x-web-search: 1` header. This script flips that header on the
// `[model_providers.clawrouter]` provider in your Codex config(s). Restart Codex
// after toggling.
//
//   node scripts/websearch-toggle.mjs on
//   node scripts/websearch-toggle.mjs off
//   node scripts/websearch-toggle.mjs status

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Both the base config (desktop) and the profile layer (CLI --profile clawrouter)
// can define the provider; toggle every file that does.
const FILES = [
  join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".codex", "clawrouter.config.toml"),
];
const PROVIDER = /^\s*\[model_providers\.clawrouter\]\s*$/;
const HEADER_LINE = `http_headers = { "x-web-search" = "1" }`;
const HEADER_RE = /^\s*http_headers\s*=\s*\{[^}]*x-web-search[^}]*\}\s*$/;

function setHeader(text, on) {
  const lines = text.split("\n").filter((l) => !HEADER_RE.test(l)); // remove existing
  if (!on) return lines.join("\n");
  const out = [];
  for (const l of lines) {
    out.push(l);
    if (PROVIDER.test(l)) out.push(HEADER_LINE); // insert right under the provider header
  }
  return out.join("\n");
}

function hasProvider(text) {
  return text.split("\n").some((l) => PROVIDER.test(l));
}

function main() {
  const cmd = process.argv[2];
  if (cmd === "status") {
    let on = false;
    for (const f of FILES) {
      if (existsSync(f) && readFileSync(f, "utf8").split("\n").some((l) => HEADER_RE.test(l))) on = true;
    }
    console.log(on ? "web search: ON" : "web search: OFF");
    return;
  }
  if (cmd !== "on" && cmd !== "off") {
    console.error("usage: websearch-toggle.mjs <on|off|status>");
    process.exit(1);
  }
  let touched = 0;
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    if (!hasProvider(text)) continue;
    copyFileSync(f, `${f}.bak-websearch`);
    writeFileSync(f, setHeader(text, cmd === "on"));
    touched++;
  }
  console.log(`web search ${cmd.toUpperCase()} (updated ${touched} config file(s)).`);
  console.log("Restart Codex (CLI next run / Desktop Cmd+Q) to apply.");
}

main();
