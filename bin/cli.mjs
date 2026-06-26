#!/usr/bin/env node
// clawrouter-codex CLI — dispatches to the package's scripts so the whole flow
// works via `npx @blockrun/clawrouter-codex <command>` without cloning.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [cmd, ...args] = process.argv.slice(2);

const COMMANDS = {
  up: "scripts/start.mjs",
  start: "scripts/start.mjs",
  setup: "scripts/setup.mjs",
  doctor: "scripts/doctor.mjs",
  bridge: "src/server.js",
  direct: "src/server.js",
  "gen-catalog": "src/gen-catalog.mjs",
  desktop: "scripts/desktop-toggle.mjs",
  websearch: "scripts/websearch-toggle.mjs",
  daemon: "scripts/install-daemon.mjs",
};

// Per-command env overrides.
//  - `up` = start + auto-run setup once the bridge is healthy (one command).
//  - `direct` runs the bridge standalone, paying BlockRun via @blockrun/llm.
const COMMAND_ENV = {
  up: { WITH_SETUP: "1" },
  direct: { BLOCKRUN_DIRECT: "1" },
};

function help() {
  console.log(`clawrouter-codex — run OpenAI Codex on ClawRouter/BlockRun models

Usage: npx @blockrun/clawrouter-codex <command>

  up                 start the bridge AND run setup — one command, ready to use
  start              bring up the bridge (direct mode) and supervise it
  setup              write the Codex profile + generate the model catalog
  doctor             verify the link end to end
  gen-catalog        (re)generate the model catalog from the live model list
  desktop on|off     show ClawRouter models in the Codex Desktop picker
  websearch on|off   enable/disable live web search (BlockRun Exa)
  daemon             install a login daemon (macOS) to keep it up
  bridge             run only the Responses bridge (forwards to a ClawRouter proxy)
  direct             run the bridge standalone — pay BlockRun directly via the
                     @blockrun/llm SDK, no proxy (decoupled mode)

Quick start:  npx @blockrun/clawrouter-codex up
              codex --profile clawrouter`);
}

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  help();
  process.exit(0);
}
const target = COMMANDS[cmd];
if (!target) {
  console.error(`unknown command: ${cmd}\n`);
  help();
  process.exit(1);
}
spawn(process.execPath, [join(ROOT, target), ...args], {
  stdio: "inherit",
  env: { ...process.env, ...(COMMAND_ENV[cmd] ?? {}) },
}).on("exit", (c) => process.exit(c ?? 0));
