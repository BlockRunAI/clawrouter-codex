// dashboard — a small loopback web panel for the Codex↔ClawRouter link: wallet
// balance, spend/usage (from the proxy's /stats), and the master switches
// (web search, desktop ClawRouter mode). Served by the bridge at /dashboard.
// Bind loopback only — it reads wallet state and flips config.

import { readFileSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = join(homedir(), ".codex", "config.toml");
const PROFILE = join(homedir(), ".codex", "clawrouter.config.toml");
const WS_HEADER_RE = /^\s*http_headers\s*=\s*\{[^}]*x-web-search[^}]*\}\s*$/;

function read(f) { return existsSync(f) ? readFileSync(f, "utf8") : ""; }

/** Current state of the master switches, read from the Codex config files. */
export function toggleStates() {
  const webSearch = [BASE, PROFILE].some((f) => read(f).split("\n").some((l) => WS_HEADER_RE.test(l)));
  // Desktop mode = base config routes globally through clawrouter.
  const desktop = read(BASE).split("\n").some((l) => /^\s*model_provider\s*=\s*"clawrouter"/.test(l));
  return { webSearch, desktop };
}

/** Flip the web-search header on the clawrouter provider in both config files. */
export function setWebSearch(on) {
  const HEADER = `http_headers = { "x-web-search" = "1" }`;
  const PROV = /^\s*\[model_providers\.clawrouter\]\s*$/;
  for (const f of [BASE, PROFILE]) {
    if (!existsSync(f)) continue;
    const lines = read(f).split("\n").filter((l) => !WS_HEADER_RE.test(l));
    if (!lines.some((l) => PROV.test(l))) continue;
    copyFileSync(f, `${f}.bak-dash`);
    const out = [];
    for (const l of lines) { out.push(l); if (on && PROV.test(l)) out.push(HEADER); }
    writeFileSync(f, out.join("\n"));
  }
}

/** Aggregate wallet + spend + switches for the dashboard JSON. */
export async function getData(upstream, fetchImpl = fetch) {
  const out = { wallet: null, stats: null, toggles: toggleStates(), upstream, error: null };
  try {
    const h = await fetchImpl(`${upstream.replace(/\/v1$/, "")}/health?full=true`, { signal: AbortSignal.timeout(8000) });
    out.wallet = await h.json();
  } catch (e) { out.error = `wallet: ${e.message}`; }
  try {
    const s = await fetchImpl(`${upstream.replace(/\/v1$/, "")}/stats?days=7`, { signal: AbortSignal.timeout(8000) });
    out.stats = await s.json();
  } catch (e) { out.error = (out.error ? out.error + "; " : "") + `stats: ${e.message}`; }
  return out;
}

export const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawRouter · Codex</title><style>
:root{--bg:#0b0d10;--card:#15181d;--line:#262b33;--fg:#e7ecf2;--dim:#8b95a3;--accent:#5b8cff;--good:#3fb950;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px 20px}
h1{font-size:18px;margin:0 0 2px}.sub{color:var(--dim);font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 10px;font-weight:600}
.big{font-size:26px;font-weight:650}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.row .k{color:var(--dim)}.muted{color:var(--dim);font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.ok{background:rgba(63,185,80,.15);color:var(--good)}.bad{background:rgba(210,153,34,.15);color:var(--warn)}
.sw{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}.sw:last-child{border:0}
button.t{border:1px solid var(--line);background:#1c2128;color:var(--fg);border-radius:999px;padding:5px 14px;cursor:pointer;font-weight:600}
button.t.on{background:var(--accent);border-color:var(--accent);color:#fff}
.full{grid-column:1/-1}.err{color:var(--warn);font-size:12px;margin-top:8px}
table{width:100%;border-collapse:collapse}td{padding:5px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}
</style></head><body><div class="wrap">
<h1>ClawRouter · Codex</h1><div class="sub" id="sub">loading…</div>
<div class="grid">
  <div class="card"><h2>Wallet</h2><div class="big" id="bal">—</div><div class="muted mono" id="addr">—</div><div id="chain" style="margin-top:8px"></div></div>
  <div class="card"><h2>Spend · last 7 days</h2>
    <div class="row"><span class="k">Requests</span><span id="reqs">—</span></div>
    <div class="row"><span class="k">Cost</span><span id="cost">—</span></div>
    <div class="row"><span class="k">Saved vs baseline</span><span id="saved">—</span></div>
    <div class="row"><span class="k">Avg latency</span><span id="lat">—</span></div>
  </div>
  <div class="card full"><h2>Switches</h2>
    <div class="sw"><div><b>Web search</b><div class="muted">Bridge runs BlockRun Exa inline · wallet-paid</div></div><button class="t" id="sw-web" onclick="flip('websearch')">—</button></div>
    <div class="sw"><div><b>Desktop → ClawRouter</b><div class="muted">Base config routes Codex Desktop through ClawRouter</div></div><span class="pill" id="sw-desk">—</span></div>
  </div>
  <div class="card full"><h2>Top models · 7 days</h2><table id="models"><tbody></tbody></table></div>
</div>
<div class="err" id="err"></div></div>
<script>
async function load(){
  const d=await (await fetch('/dashboard/api')).json();
  const w=d.wallet||{},s=d.stats||{};
  document.getElementById('sub').textContent='proxy '+(d.upstream||'')+' · '+new Date().toLocaleString();
  document.getElementById('bal').textContent=w.balance||'—';
  document.getElementById('addr').textContent=w.wallet||'—';
  document.getElementById('chain').innerHTML=(w.paymentChain?'<span class="pill ok">'+w.paymentChain+'</span>':'')+(w.isEmpty?' <span class="pill bad">empty</span>':'');
  document.getElementById('reqs').textContent=s.totalRequests??'—';
  document.getElementById('cost').textContent=(s.totalCost!=null?'$'+Number(s.totalCost).toFixed(4):'—');
  document.getElementById('saved').textContent=(s.savingsPercentage!=null?s.savingsPercentage+'%':'—');
  document.getElementById('lat').textContent=(s.avgLatencyMs!=null?Math.round(s.avgLatencyMs)+' ms':'—');
  const web=document.getElementById('sw-web');web.textContent=d.toggles.webSearch?'ON':'OFF';web.className='t'+(d.toggles.webSearch?' on':'');
  document.getElementById('sw-desk').textContent=d.toggles.desktop?'ON':'OFF';document.getElementById('sw-desk').className='pill '+(d.toggles.desktop?'ok':'bad');
  const tb=document.querySelector('#models tbody');tb.innerHTML='';
  const bm=s.byModel||{};Object.entries(bm).sort((a,b)=>(b[1].requests||b[1].count||0)-(a[1].requests||a[1].count||0)).slice(0,8)
    .forEach(([m,v])=>{const tr=document.createElement('tr');tr.innerHTML='<td class="mono">'+m+'</td><td>'+(v.requests||v.count||0)+' req</td>';tb.appendChild(tr);});
  document.getElementById('err').textContent=d.error?('⚠ '+d.error):'';
}
async function flip(name){await fetch('/dashboard/api/toggle?name='+name,{method:'POST'});await load();}
load();setInterval(load,15000);
</script></body></html>`;
