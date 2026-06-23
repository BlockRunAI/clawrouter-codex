// dashboard — a loopback web panel for the Codex↔ClawRouter link: the master
// provider switch (ChatGPT subscription ⇄ ClawRouter), wallet balance, spend/
// usage, top models, and the web-search switch. Served by the bridge at
// /dashboard. Loopback only — it reads wallet state and edits Codex config.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts");
const CODEX = join(homedir(), ".codex");
const BASE = join(CODEX, "config.toml");
const PROFILE = join(CODEX, "clawrouter.config.toml");
const CATALOG = join(CODEX, "clawrouter-catalog.json");
const WS_HEADER_RE = /x-web-search/;

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

/** The models currently in the Codex picker (the generated catalog). */
export function catalogModels() {
  try {
    return (JSON.parse(read(CATALOG)).models || []).map((m) => ({
      name: m.display_name,
      slug: m.slug,
      family: m.slug.includes("/") ? m.slug.split("/")[0] : "blockrun",
    }));
  } catch {
    return [];
  }
}

/** Current switch state, read from the Codex config files. */
export function toggleStates() {
  const webSearch = WS_HEADER_RE.test(read(BASE)) || WS_HEADER_RE.test(read(PROFILE));
  // "desktop" = base config routes the default through ClawRouter (vs native).
  const clawrouter = read(BASE).split("\n").some((l) => /^\s*model_provider\s*=\s*"clawrouter"/.test(l));
  return { webSearch, clawrouter };
}

/** Flip a switch by delegating to the (tested) toggle scripts. */
export function applyToggle(name, on) {
  const script = { websearch: "websearch-toggle.mjs", desktop: "desktop-toggle.mjs" }[name];
  if (!script) throw new Error(`unknown toggle: ${name}`);
  execFileSync(process.execPath, [join(SCRIPTS, script), on ? "on" : "off"], { stdio: "ignore" });
  return toggleStates();
}

/** Aggregate wallet + spend + switches for the dashboard JSON. */
export async function getData(upstream, fetchImpl = fetch) {
  const root = upstream.replace(/\/v1$/, "");
  const out = { wallet: null, stats: null, toggles: toggleStates(), catalog: catalogModels(), upstream, error: null };
  try { out.wallet = await (await fetchImpl(`${root}/health?full=true`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch (e) { out.error = `wallet: ${e.message}`; }
  try { out.stats = await (await fetchImpl(`${root}/stats?days=7`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch (e) { out.error = (out.error ? out.error + "; " : "") + `stats: ${e.message}`; }
  return out;
}

export const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ClawRouter · Codex</title>
<style>
:root{
  --bg:#0a0c10;--bg2:#0e1116;--card:#13171e;--card2:#171c25;--line:#232a34;--line2:#2c343f;
  --fg:#eef2f7;--dim:#8b96a5;--dim2:#6b7585;--accent:#6ea8fe;--accent2:#4d7cfe;
  --good:#46c46a;--warn:#e3a008;--bad:#f0626e;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}html,body{margin:0}
body{background:radial-gradient(1200px 600px at 50% -200px,#16202f 0%,var(--bg) 60%);
  color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
.wrap{max-width:880px;margin:0 auto;padding:34px 22px 60px}
header{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#9b6dff);
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#0a0c10}
h1{font-size:17px;font-weight:650;margin:0;letter-spacing:.2px}
.sub{color:var(--dim2);font-size:11.5px;margin:2px 0 22px;font-family:var(--mono)}
.seg{display:flex;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:5px;margin-bottom:18px;gap:5px}
.seg button{flex:1;border:0;background:transparent;color:var(--dim);font:inherit;font-weight:650;
  padding:13px 10px;border-radius:10px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;align-items:center;gap:2px}
.seg button .s{font-size:11px;font-weight:500;color:var(--dim2)}
.seg button:hover{color:var(--fg)}
.seg button.active{background:linear-gradient(135deg,var(--accent2),#6b59ff);color:#fff;box-shadow:0 4px 14px rgba(77,124,254,.35)}
.seg button.active .s{color:rgba(255,255,255,.85)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:16px;padding:18px}
.card h2{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim2);margin:0 0 12px;font-weight:600}
.bal{font-size:32px;font-weight:700;letter-spacing:-.5px;line-height:1}
.addr{color:var(--dim);font-family:var(--mono);font-size:11.5px;margin-top:9px;word-break:break-all}
.row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.row .k{color:var(--dim)}.row .v{font-weight:600}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.02em}
.ok{background:rgba(70,196,106,.14);color:var(--good)}.bad{background:rgba(240,98,110,.14);color:var(--bad)}
.full{grid-column:1/-1}
.sw{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--line)}.sw:last-child{border:0}
.sw b{font-weight:650}.sw .d{color:var(--dim2);font-size:12px;margin-top:1px}
.toggle{width:48px;height:28px;border-radius:999px;border:1px solid var(--line2);background:#0c0f14;position:relative;cursor:pointer;transition:.18s;flex:none}
.toggle::after{content:"";position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:var(--dim);transition:.18s}
.toggle.on{background:linear-gradient(135deg,var(--accent2),#6b59ff);border-color:transparent}.toggle.on::after{left:23px;background:#fff}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:7px 0;border-bottom:1px solid var(--line)}tr:last-child td{border:0}td:last-child{text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
.note{color:var(--accent);font-size:12px;margin-top:14px;min-height:16px;transition:.2s}
.err{color:var(--warn);font-size:12px;margin-top:8px}
.spark{height:3px;border-radius:2px;background:linear-gradient(90deg,var(--accent),#9b6dff);margin-top:10px;opacity:.6}
.fam{margin:12px 0 6px;font-size:10.5px;font-weight:700;color:var(--dim2);text-transform:uppercase;letter-spacing:.06em}
.fam:first-child{margin-top:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;padding:4px 11px;border-radius:999px;background:#0d1117;border:1px solid var(--line);color:var(--fg)}
.chip.new{border-color:var(--accent2);color:var(--accent)}
</style></head><body><div class="wrap">
<header><div class="logo">C</div><h1>ClawRouter · Codex</h1></header>
<div class="sub" id="sub">loading…</div>

<div class="seg" id="seg">
  <button id="seg-sub" onclick="setProvider(false)"><span>ChatGPT Subscription</span><span class="s">native GPT · your plan</span></button>
  <button id="seg-claw" onclick="setProvider(true)"><span>ClawRouter</span><span class="s">55+ models · wallet</span></button>
</div>

<div class="grid">
  <div class="card"><h2>Wallet</h2><div class="bal" id="bal">—</div><div class="spark"></div>
    <div class="addr" id="addr">—</div><div id="chain" style="margin-top:10px"></div></div>
  <div class="card"><h2>Spend · last 7 days</h2>
    <div class="row"><span class="k">Requests</span><span class="v" id="reqs">—</span></div>
    <div class="row"><span class="k">Cost</span><span class="v" id="cost">—</span></div>
    <div class="row"><span class="k">Saved vs baseline</span><span class="v" id="saved">—</span></div>
    <div class="row"><span class="k">Avg latency</span><span class="v" id="lat">—</span></div>
  </div>
  <div class="card full"><h2>Switches</h2>
    <div class="sw"><div><b>Web search</b><div class="d">Bridge runs BlockRun Exa inline · wallet-paid</div></div>
      <div class="toggle" id="sw-web" onclick="flip('websearch')"></div></div>
  </div>
  <div class="card full"><h2>Top models · 7 days</h2><table id="models"><tbody></tbody></table></div>
  <div class="card full"><h2>Models in your picker · <span id="mcount">—</span></h2><div id="picker"></div></div>
</div>
<div class="note" id="note"></div><div class="err" id="err"></div></div>
<script>
let busy=false;
async function load(){
  const d=await (await fetch('/dashboard/api')).json();
  const w=d.wallet||{},s=d.stats||{},t=d.toggles||{};
  document.getElementById('sub').textContent='proxy '+(d.upstream||'')+' · '+new Date().toLocaleTimeString();
  document.getElementById('bal').textContent=w.balance||'—';
  document.getElementById('addr').textContent=w.wallet||'—';
  document.getElementById('chain').innerHTML=(w.paymentChain?'<span class="pill ok">'+w.paymentChain.toUpperCase()+'</span> ':'')+(w.isEmpty?'<span class="pill bad">EMPTY</span>':'');
  document.getElementById('reqs').textContent=s.totalRequests??'—';
  document.getElementById('cost').textContent=s.totalCost!=null?'$'+Number(s.totalCost).toFixed(4):'—';
  document.getElementById('saved').textContent=s.savingsPercentage!=null?Number(s.savingsPercentage).toFixed(0)+'%':'—';
  document.getElementById('lat').textContent=s.avgLatencyMs!=null?Math.round(s.avgLatencyMs)+' ms':'—';
  document.getElementById('seg-sub').classList.toggle('active',!t.clawrouter);
  document.getElementById('seg-claw').classList.toggle('active',!!t.clawrouter);
  document.getElementById('sw-web').classList.toggle('on',!!t.webSearch);
  const tb=document.querySelector('#models tbody');tb.innerHTML='';
  Object.entries(s.byModel||{}).map(([m,v])=>[m,v.requests||v.count||0]).sort((a,b)=>b[1]-a[1]).slice(0,8)
    .forEach(([m,n])=>{const tr=document.createElement('tr');tr.innerHTML='<td style="font-family:var(--mono);font-size:12px">'+m+'</td><td>'+n+' req</td>';tb.appendChild(tr);});
  if(!Object.keys(s.byModel||{}).length)tb.innerHTML='<tr><td style="color:var(--dim2)">no usage yet</td><td></td></tr>';
  const cat=d.catalog||[];document.getElementById('mcount').textContent=cat.length+' models';
  const fam={};cat.forEach(m=>{(fam[m.family]=fam[m.family]||[]).push(m.name);});
  const pk=document.getElementById('picker');pk.innerHTML='';
  if(!cat.length)pk.innerHTML='<div style="color:var(--dim2);font-size:12px">no catalog — run <span style="font-family:var(--mono)">npm run gen-catalog</span></div>';
  Object.entries(fam).forEach(([f,names])=>{
    const h=document.createElement('div');h.className='fam';h.textContent=f;pk.appendChild(h);
    const c=document.createElement('div');c.className='chips';
    names.forEach(n=>{const s=document.createElement('span');s.className='chip';s.textContent=n;c.appendChild(s);});
    pk.appendChild(c);
  });
  document.getElementById('err').textContent=d.error?('⚠ '+d.error):'';
}
async function post(url){busy=true;try{await fetch(url,{method:'POST'});note('Saved — restart Codex (Cmd+Q) to apply.');}finally{busy=false;await load();}}
function note(m){const n=document.getElementById('note');n.textContent=m;clearTimeout(n._t);n._t=setTimeout(()=>n.textContent='',6000);}
async function setProvider(claw){if(busy)return;await post('/dashboard/api/toggle?name=desktop&on='+(claw?1:0));}
async function flip(name){if(busy)return;const cur=document.getElementById('sw-web').classList.contains('on');await post('/dashboard/api/toggle?name='+name+'&on='+(cur?0:1));}
load();setInterval(()=>{if(!busy)load();},15000);
</script></body></html>`;
