#!/usr/bin/env node
// wallet — print the full funding wallet address without requiring the dashboard.
//
// `--json` emits the BlockRun output contract from @blockrun/core
// ({ok,data}/{ok,error}) so agents and the umbrella `blockrun` CLI can parse
// every product the same way.

import { resolveWalletKey } from "../src/direct.js";
import { walletAddressFromKey } from "../src/wallet.js";
import { ok, err, render } from "@blockrun/core";

const PORT = process.env.PORT ?? "8403";
const json = process.argv.includes("--json");

const emit = (env) => {
  if (json) console.log(render(env, "json"));
  process.exit(env.ok ? 0 : 1);
};

async function bridgeWallet() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health?full=true`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

try {
  const key = resolveWalletKey();
  if (!key) {
    const message =
      "No BlockRun wallet found. Start the bridge with `npx @blockrun/clawrouter-codex up` or set BLOCKRUN_WALLET_KEY.";
    if (json) emit(err("wallet", message, 404));
    console.error(message);
    process.exit(1);
  }

  const address = walletAddressFromKey(key);
  const health = await bridgeWallet();
  const balance =
    typeof health.balance === "string" || typeof health.balance === "number" ? String(health.balance) : undefined;
  const dashboard = `http://127.0.0.1:${PORT}/dashboard`;

  if (json) emit(ok({ address, balance, dashboard }));

  console.log("BlockRun wallet");
  console.log(`Address:   ${address}`);
  console.log(`Balance:   ${balance ?? `unavailable (start the bridge for live balance)`}`);
  console.log(`Dashboard: ${dashboard}`);
  console.log("");
  console.log("Fund with USDC on Base.");
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (json) emit(err("wallet", message));
  console.error(`wallet: ${message}`);
  process.exit(1);
}
