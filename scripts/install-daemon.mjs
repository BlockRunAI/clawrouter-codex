#!/usr/bin/env node
// install-daemon — install a macOS LaunchAgent that runs scripts/start.mjs at
// login and keeps it alive, so the Codex↔BlockRun link is always up. Re-running
// reinstalls. Pass `uninstall` to remove it.
//
//   node scripts/install-daemon.mjs            # install + load now
//   node scripts/install-daemon.mjs uninstall  # unload + remove
//
// Machine-specific settings are captured from the ENVIRONMENT at install time
// and baked into the plist, e.g. to use a funded wallet living outside ~/.openclaw:
//   WALLET_KEY_FILE=~/.blockrun/.session ISOLATE_HOME=1 node scripts/install-daemon.mjs

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const LABEL = "ai.blockrun.clawrouter-codex";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const STATE = join(homedir(), ".clawrouter-codex");
const LOG = join(STATE, "daemon.log");

function tryExec(cmd) { try { execSync(cmd, { stdio: "ignore" }); } catch { /* ignore */ } }

function uninstall() {
  tryExec(`launchctl unload -w ${JSON.stringify(PLIST)}`);
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log(`[daemon] uninstalled (${PLIST} removed)`);
}

function plistEnv() {
  // Forward only the settings start.mjs understands; values come from the
  // install-time environment so nothing machine-specific is committed.
  const keys = ["PORT", "PROXY_PORT", "CLAWROUTER_CMD", "BLOCKRUN_WALLET_KEY", "WALLET_KEY_FILE", "ISOLATE_HOME"];
  const entries = keys
    .filter((k) => process.env[k])
    .map((k) => `      <key>${k}</key>\n      <string>${process.env[k].replace(/^~/, homedir())}</string>`);
  // Ensure PATH includes common node/npx locations for npx-launched proxy.
  entries.push(`      <key>PATH</key>\n      <string>${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}</string>`);
  return `    <key>EnvironmentVariables</key>\n    <dict>\n${entries.join("\n")}\n    </dict>`;
}

function install() {
  if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${process.execPath}</string>
      <string>${join(ROOT, "scripts", "start.mjs")}</string>
    </array>
${plistEnv()}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key>
    <string>${LOG}</string>
    <key>StandardErrorPath</key>
    <string>${LOG}</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
  writeFileSync(PLIST, plist);
  // Free the ports so the daemon starts + owns fresh children.
  for (const p of [Number(process.env.PORT ?? 8403), Number(process.env.PROXY_PORT ?? 8404)]) {
    tryExec(`bash -c 'lsof -ti:${p} | xargs kill 2>/dev/null'`);
  }
  tryExec(`launchctl unload ${JSON.stringify(PLIST)}`);
  execSync(`launchctl load -w ${JSON.stringify(PLIST)}`);
  console.log(`[daemon] installed → ${PLIST}`);
  console.log(`[daemon] logs: ${LOG}`);
  console.log(`[daemon] starts at login + now; supervises proxy + bridge.`);
}

if (process.argv[2] === "uninstall") uninstall();
else install();
