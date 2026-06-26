#!/usr/bin/env node
// start — bring up the full Codex↔BlockRun link with one command, and keep it up.
//
//   Codex → bridge (PORT, default 8403) → ClawRouter proxy (PROXY_PORT, default 8404) → blockrun.ai
//
// It health-checks first and only starts what's down, then supervises both
// children (restart on exit). Safe to run repeatedly and as a login daemon.
//
// Env:
//   PORT                bridge port (default 8403)
//   PROXY_PORT          ClawRouter proxy port (default 8404)
//   CLAWROUTER_CMD      command to launch the proxy (default "npx -y @blockrun/clawrouter")
//   BLOCKRUN_WALLET_KEY raw 0x EVM key for x402 (optional; overrides discovery)
//   WALLET_KEY_FILE     read the key from this file instead (e.g. ~/.blockrun/.session)
//   ISOLATE_HOME=1      run the proxy under a fresh HOME so a saved ~/.openclaw
//                       wallet can't shadow the provided key (use with a funded
//                       key that lives outside ~/.openclaw)

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT ?? 8403);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8404);
// @latest so the proxy's built-in model registry stays current (it ships the
// model list per version — a stale ClawRouter is missing the newest models).
const CLAWROUTER_CMD = process.env.CLAWROUTER_CMD ?? "npx -y @blockrun/clawrouter@latest";
const ISOLATE_HOME = process.env.ISOLATE_HOME === "1";
const STATE = join(homedir(), ".clawrouter-codex");

function log(s) { console.log(`[start] ${s}`); }

async function healthy(port, path = "/health") {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function waitHealthy(port, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await healthy(port)) { log(`${label} healthy on :${port}`); return true; }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Canonical local BlockRun wallet (~/.blockrun/.session). Lives OUTSIDE
// ~/.openclaw, so when we use it we also isolate HOME so ClawRouter's saved
// ~/.openclaw wallet can't shadow it.
const BLOCKRUN_WALLET = join(homedir(), ".blockrun", ".session");

function rd(p) { return readFileSync(p.replace(/^~/, homedir()), "utf8").trim(); }

function resolveWallet() {
  if (process.env.BLOCKRUN_WALLET_KEY) {
    return { key: process.env.BLOCKRUN_WALLET_KEY.trim(), isolate: ISOLATE_HOME };
  }
  const f = process.env.WALLET_KEY_FILE;
  if (f && existsSync(f.replace(/^~/, homedir()))) {
    return { key: rd(f), isolate: ISOLATE_HOME };
  }
  // Auto-detect the local BlockRun wallet — no config needed.
  if (existsSync(BLOCKRUN_WALLET)) {
    return { key: rd(BLOCKRUN_WALLET), isolate: true, auto: true };
  }
  return { key: undefined, isolate: ISOLATE_HOME }; // ClawRouter discovers/generates
}

const children = [];
function supervise(label, cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit", shell: false });
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    log(`${label} exited (code ${code}); restarting in 2s`);
    setTimeout(() => supervise(label, cmd, args, env), 2000);
  });
  return child;
}

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { shuttingDown = true; children.forEach((c) => c.kill()); process.exit(0); });
}

// Direct mode (default): the bridge pays BlockRun itself via @blockrun/llm —
// one process, no proxy. Opt into the legacy proxy path with BRIDGE_MODE=proxy
// (or by pointing CLAWROUTER_PROXY_URL at an already-running proxy).
const PROXY_MODE = process.env.BRIDGE_MODE === "proxy" || Boolean(process.env.CLAWROUTER_PROXY_URL);

async function startDirect() {
  if (await healthy(PORT)) { log(`bridge already up on :${PORT}`); return; }
  const { key, auto } = resolveWallet();
  if (auto) log(`auto-detected BlockRun wallet at ${BLOCKRUN_WALLET}`);
  log(`starting bridge on :${PORT} — direct mode (pays BlockRun via @blockrun/llm, no proxy)`);
  supervise("bridge", process.execPath, [join(ROOT, "src", "server.js")], {
    PORT: String(PORT),
    BLOCKRUN_DIRECT: "1",
    ...(key ? { BLOCKRUN_WALLET_KEY: key } : {}),
  });
  if (!(await waitHealthy(PORT, "bridge"))) throw new Error("bridge failed to come up");
}

// `up` runs setup once the bridge is healthy — writes the Codex profile and
// generates the model catalog (gen-catalog reads the now-running bridge).
function runSetupOnce() {
  if (process.env.WITH_SETUP !== "1") return;
  try {
    log("running setup (Codex profile + model catalog)…");
    execFileSync(process.execPath, [join(ROOT, "scripts", "setup.mjs")], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(PORT) },
    });
  } catch (e) {
    log(`setup failed: ${e.message} — run \`npx @blockrun/clawrouter-codex setup\` manually`);
  }
}

async function main() {
  if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });

  if (!PROXY_MODE) {
    await startDirect();
    runSetupOnce();
    log(`✅ link up (direct) — point Codex at http://localhost:${PORT}/v1`);
    if (children.length === 0) { log("bridge already running; exiting"); process.exit(0); }
    return;
  }

  // 1. ClawRouter proxy (holds the wallet, does x402)
  if (await healthy(PROXY_PORT)) {
    log(`proxy already up on :${PROXY_PORT}`);
  } else {
    const { key, isolate, auto } = resolveWallet();
    if (auto) log(`auto-detected BlockRun wallet at ${BLOCKRUN_WALLET}`);
    const env = {};
    if (key) env.BLOCKRUN_WALLET_KEY = key;
    if (isolate) {
      const h = join(STATE, "proxy-home");
      if (!existsSync(h)) mkdirSync(h, { recursive: true });
      env.HOME = h; // a saved ~/.openclaw wallet won't shadow the provided key
    }
    const [cmd, ...base] = CLAWROUTER_CMD.split(" ");
    log(`starting proxy: ${CLAWROUTER_CMD} --port ${PROXY_PORT}${key ? " (wallet from key)" : ""}`);
    supervise("proxy", cmd, [...base, "--port", String(PROXY_PORT)], env);
    if (!(await waitHealthy(PROXY_PORT, "proxy"))) throw new Error("proxy failed to come up");
  }

  // 2. Bridge (Responses ⇄ chat, what Codex talks to)
  if (await healthy(PORT)) {
    log(`bridge already up on :${PORT}`);
  } else {
    log(`starting bridge on :${PORT} → proxy :${PROXY_PORT}`);
    supervise("bridge", process.execPath, [join(ROOT, "src", "server.js")], {
      PORT: String(PORT),
      CLAWROUTER_PROXY_URL: `http://127.0.0.1:${PROXY_PORT}/v1`,
    });
    if (!(await waitHealthy(PORT, "bridge"))) throw new Error("bridge failed to come up");
  }

  runSetupOnce();
  log(`✅ link up — point Codex at http://localhost:${PORT}/v1`);
  if (children.length === 0) { log("nothing to supervise (both were already running); exiting"); process.exit(0); }
}

main().catch((e) => { console.error(`[start] ${e.message}`); process.exit(1); });
