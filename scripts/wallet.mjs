#!/usr/bin/env node
// wallet — print the full funding wallet address without requiring the dashboard.

import { resolveWalletKey } from "../src/direct.js";
import { walletAddressFromKey } from "../src/wallet.js";

const PORT = process.env.PORT ?? "8403";
const json = process.argv.includes("--json");

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
    const message = "No BlockRun wallet found. Start the bridge with `npx @blockrun/clawrouter-codex up` or set BLOCKRUN_WALLET_KEY.";
    if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(message);
    process.exit(1);
  }

  const address = walletAddressFromKey(key);
  const health = await bridgeWallet();
  const balance = typeof health.balance === "string" || typeof health.balance === "number" ? String(health.balance) : undefined;
  const dashboard = `http://127.0.0.1:${PORT}/dashboard`;

  if (json) {
    console.log(JSON.stringify({ ok: true, address, balance, dashboard }, null, 2));
  } else {
    console.log("BlockRun wallet");
    console.log(`Address:   ${address}`);
    console.log(`Balance:   ${balance ?? `unavailable (start the bridge for live balance)`}`);
    console.log(`Dashboard: ${dashboard}`);
    console.log("");
    console.log("Fund with USDC on Base.");
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(`wallet: ${message}`);
  process.exit(1);
}
