// dashboard — a loopback web panel for the Codex↔ClawRouter link: the master
// provider switch (ChatGPT subscription ⇄ ClawRouter), wallet balance + funding,
// spend/usage, the models in your picker (clickable to set default), web search,
// and provider errors. Served by the bridge at /dashboard. Loopback only — it
// reads wallet state and edits Codex config.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

export function toggleStates() {
  const webSearch = WS_HEADER_RE.test(read(BASE)) || WS_HEADER_RE.test(read(PROFILE));
  const clawrouter = read(BASE).split("\n").some((l) => /^\s*model_provider\s*=\s*"clawrouter"/.test(l));
  return { webSearch, clawrouter };
}

function currentDefaultModel() {
  for (const f of [BASE, PROFILE]) {
    const t = read(f);
    if (!/model_provider\s*=\s*"clawrouter"/.test(t)) continue;
    const m = t.match(/^\s*model\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  }
  return null;
}

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

export function applyToggle(name, on) {
  const script = { websearch: "websearch-toggle.mjs", desktop: "desktop-toggle.mjs" }[name];
  if (!script) throw new Error(`unknown toggle: ${name}`);
  execFileSync(process.execPath, [join(SCRIPTS, script), on ? "on" : "off"], { stdio: "ignore" });
  return toggleStates();
}

export function regenCatalog(upstream) {
  const proxy = upstream.endsWith("/v1") ? upstream : `${upstream}/v1`;
  execFileSync(process.execPath, [join(SCRIPTS, "..", "src", "gen-catalog.mjs"), "--proxy", proxy, "--out", CATALOG], {
    stdio: "ignore",
  });
  return catalogModels().length;
}

export function setDefaultModel(model) {
  if (!model || typeof model !== "string") throw new Error("model required");
  const safe = JSON.stringify(model);
  for (const f of [PROFILE, BASE]) {
    if (!existsSync(f)) continue;
    const t = readFileSync(f, "utf8");
    if (!/^\s*model_provider\s*=\s*"clawrouter"/m.test(t)) continue;
    writeFileSync(f, t.replace(/^\s*model\s*=\s*("(?:\\.|[^"])*"|'[^']*')\s*$/m, `model = ${safe}`));
  }
  return model;
}

export async function getData(upstream, fetchImpl = fetch) {
  const root = upstream.replace(/\/v1$/, "");
  const out = {
    wallet: null, stats: null, toggles: toggleStates(), catalog: catalogModels(),
    defaultModel: currentDefaultModel(), upstream, error: null,
  };
  try { out.wallet = await (await fetchImpl(`${root}/health?full=true`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch (e) { out.error = `wallet: ${e.message}`; }
  try { out.stats = await (await fetchImpl(`${root}/stats?days=7`, { signal: AbortSignal.timeout(8000) })).json(); }
  catch (e) { out.error = (out.error ? out.error + "; " : "") + `stats: ${e.message}`; }
  return out;
}

export const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ClawRouter · Codex</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<style>
:root{--bg:#0a0c10;--card:#13171e;--card2:#171c25;--line:#232a34;--line2:#2c343f;--fg:#eef2f7;
  --dim:#8b96a5;--dim2:#6b7585;--accent:#6ea8fe;--accent2:#4d7cfe;--good:#46c46a;--warn:#e3a008;--bad:#f0626e;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}html,body{margin:0}
body{background:radial-gradient(1200px 600px at 50% -200px,#16202f 0%,var(--bg) 60%);color:var(--fg);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh}
.wrap{max-width:880px;margin:0 auto;padding:34px 22px 60px}
header{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#9b6dff);
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:#0a0c10}
h1{font-size:17px;font-weight:650;margin:0}.sub{color:var(--dim2);font-size:11.5px;margin:2px 0 22px;font-family:var(--mono)}
.seg{display:flex;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:5px;margin-bottom:18px;gap:5px}
.seg button{flex:1;border:0;background:transparent;color:var(--dim);font:inherit;font-weight:650;padding:13px 10px;
  border-radius:10px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;align-items:center;gap:2px}
.seg button .s{font-size:11px;font-weight:500;color:var(--dim2)}.seg button:hover{color:var(--fg)}
.seg button.active{background:linear-gradient(135deg,var(--accent2),#6b59ff);color:#fff;box-shadow:0 4px 14px rgba(77,124,254,.35)}
.seg button.active .s{color:rgba(255,255,255,.85)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:16px;padding:18px}
.card h2{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim2);margin:0 0 12px;font-weight:600;
  display:flex;align-items:center;justify-content:space-between;gap:8px}
.bal{font-size:32px;font-weight:700;letter-spacing:-.5px;line-height:1}
.addr{color:var(--dim);font-family:var(--mono);font-size:11px;margin-top:9px;word-break:break-all}
.row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.row .k{color:var(--dim)}.row .v{font-weight:600}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:700}
.ok{background:rgba(70,196,106,.14);color:var(--good)}.bad{background:rgba(240,98,110,.14);color:var(--bad)}
.full{grid-column:1/-1}
.sw{display:flex;align-items:center;justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--line)}.sw:last-child{border:0}
.sw b{font-weight:650}.sw .d{color:var(--dim2);font-size:12px;margin-top:1px}
.toggle{width:48px;height:28px;border-radius:999px;border:1px solid var(--line2);background:#0c0f14;position:relative;cursor:pointer;transition:.18s;flex:none}
.toggle::after{content:"";position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:var(--dim);transition:.18s}
.toggle.on{background:linear-gradient(135deg,var(--accent2),#6b59ff);border-color:transparent}.toggle.on::after{left:23px;background:#fff}
.btn{border:1px solid var(--line2);background:#1a212b;color:var(--fg);font:inherit;font-size:12px;font-weight:600;
  padding:6px 12px;border-radius:9px;cursor:pointer;transition:.15s}.btn:hover{border-color:var(--accent2);color:var(--accent)}
.btn:active{transform:scale(.97)}.btn.mini{padding:4px 9px;font-size:11px}
.bars{display:flex;align-items:flex-end;gap:4px;height:46px;margin-top:14px}
.bars div{flex:1;background:linear-gradient(180deg,var(--accent),#6b59ff);border-radius:3px 3px 0 0;min-height:2px;opacity:.85}
.fam{margin:12px 0 6px;font-size:10.5px;font-weight:700;color:var(--dim2);text-transform:uppercase;letter-spacing:.06em}
.fam:first-child{margin-top:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;padding:4px 11px;border-radius:999px;background:#0d1117;border:1px solid var(--line);color:var(--fg);cursor:pointer;transition:.12s}
.chip:hover{border-color:var(--line2)}.chip.cur{background:linear-gradient(135deg,var(--accent2),#6b59ff);border-color:transparent;color:#fff}
.fund{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);display:none}
.fund.show{display:block}.fund img{background:#fff;padding:8px;border-radius:10px;width:132px;height:132px}
.errs td{padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px}.errs td:last-child{text-align:right;color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:7px 0;border-bottom:1px solid var(--line)}tr:last-child td{border:0}
.note{color:var(--accent);font-size:12px;margin-top:14px;min-height:16px}.err{color:var(--warn);font-size:12px;margin-top:8px}
.spark{height:3px;border-radius:2px;background:linear-gradient(90deg,var(--accent),#9b6dff);margin-top:10px;opacity:.6}
</style></head><body><div class="wrap">
<header><div class="logo">C</div><h1>ClawRouter · Codex</h1></header>
<div class="sub" id="sub">loading…</div>

<div class="seg" id="seg">
  <button id="seg-sub" onclick="setProvider(false)"><span>ChatGPT Subscription</span><span class="s">native GPT · your plan</span></button>
  <button id="seg-claw" onclick="setProvider(true)"><span>ClawRouter</span><span class="s">latest models · wallet</span></button>
</div>

<div class="grid">
  <div class="card"><h2>Wallet <button class="btn mini" onclick="toggleFund()">Fund</button></h2>
    <div class="bal" id="bal">—</div><div class="spark"></div>
    <div class="addr" id="addr">—</div><div id="chain" style="margin-top:10px"></div>
    <div class="fund" id="fund"><div style="color:var(--dim);font-size:12px;margin-bottom:10px">Send <b>USDC on Base</b> to this address:</div>
      <div id="qr"></div><button class="btn mini" id="copy" style="margin-top:10px" onclick="copyAddr()">Copy address</button></div>
  </div>
  <div class="card"><h2>Spend · last 7 days</h2>
    <div class="row"><span class="k">Requests</span><span class="v" id="reqs">—</span></div>
    <div class="row"><span class="k">Cost</span><span class="v" id="cost">—</span></div>
    <div class="row"><span class="k">Saved vs baseline</span><span class="v" id="saved">—</span></div>
    <div class="row"><span class="k">Avg latency</span><span class="v" id="lat">—</span></div>
    <div class="bars" id="bars"></div>
  </div>
  <div class="card full"><h2>Switches</h2>
    <div class="sw"><div><b>Web search</b><div class="d">Bridge runs BlockRun Exa inline · wallet-paid</div></div>
      <div class="toggle" id="sw-web" onclick="flip('websearch')"></div></div>
  </div>
  <div class="card full" id="errcard" style="display:none"><h2>Provider errors · 7 days</h2><table class="errs"><tbody id="errs"></tbody></table></div>
  <div class="card full"><h2>Models in your picker · <span id="mcount">—</span>
      <button class="btn mini" id="upd" onclick="updateModels()">↻ Update models</button></h2>
    <div style="color:var(--dim2);font-size:11.5px;margin:-4px 0 8px">click a model to set it as the default</div>
    <div id="picker"></div></div>
</div>
<div class="note" id="note"></div><div class="err" id="err"></div></div>
<script>
let busy=false,addr='';
async function load(){
  const d=await (await fetch('/dashboard/api')).json();
  const w=d.wallet||{},s=d.stats||{},t=d.toggles||{};addr=w.wallet||'';
  document.getElementById('sub').textContent='proxy '+(d.upstream||'')+' · '+new Date().toLocaleTimeString();
  const empty=w.isEmpty,low=!empty&&w.balance&&parseFloat(String(w.balance).replace(/[^0-9.]/g,''))<1;
  document.getElementById('bal').textContent=w.balance||'—';
  document.getElementById('bal').style.color=empty?'var(--bad)':low?'var(--warn)':'var(--fg)';
  document.getElementById('addr').textContent=addr||'—';
  document.getElementById('chain').innerHTML=(w.paymentChain?'<span class="pill ok">'+w.paymentChain.toUpperCase()+'</span> ':'')
    +(empty?'<span class="pill bad">EMPTY — fund to use paid models</span>':low?'<span class="pill bad">LOW</span>':'');
  document.getElementById('reqs').textContent=s.totalRequests??'—';
  document.getElementById('cost').textContent=s.totalCost!=null?'$'+Number(s.totalCost).toFixed(4):'—';
  document.getElementById('saved').textContent=s.savingsPercentage!=null?Number(s.savingsPercentage).toFixed(0)+'%':'—';
  document.getElementById('lat').textContent=s.avgLatencyMs!=null?Math.round(s.avgLatencyMs)+' ms':'—';
  const days=s.dailyBreakdown||[];const max=Math.max(1,...days.map(x=>x.cost||x.requests||0));
  document.getElementById('bars').innerHTML=days.slice(-7).map(x=>'<div title="$'+Number(x.cost||0).toFixed(3)+'" style="height:'+Math.round((x.cost||x.requests||0)/max*100)+'%"></div>').join('')||'';
  document.getElementById('seg-sub').classList.toggle('active',!t.clawrouter);
  document.getElementById('seg-claw').classList.toggle('active',!!t.clawrouter);
  document.getElementById('sw-web').classList.toggle('on',!!t.webSearch);
  const pe=s.providerErrors||{};const ek=Object.keys(pe);
  document.getElementById('errcard').style.display=ek.length?'block':'none';
  document.getElementById('errs').innerHTML=ek.slice(0,8).map(k=>'<tr><td style="font-family:var(--mono)">'+k+'</td><td>'+(typeof pe[k]==='object'?JSON.stringify(pe[k]):pe[k])+'</td></tr>').join('');
  const cat=d.catalog||[];document.getElementById('mcount').textContent=cat.length+' models';
  const fam={};cat.forEach(m=>{(fam[m.family]=fam[m.family]||[]).push(m);});
  const pk=document.getElementById('picker');pk.innerHTML='';
  if(!cat.length)pk.innerHTML='<div style="color:var(--dim2);font-size:12px">no catalog — click ↻ Update models</div>';
  Object.entries(fam).forEach(([f,models])=>{
    const h=document.createElement('div');h.className='fam';h.textContent=f;pk.appendChild(h);
    const c=document.createElement('div');c.className='chips';
    models.forEach(m=>{const s2=document.createElement('span');s2.className='chip'+(m.slug===d.defaultModel?' cur':'');s2.textContent=m.name;
      s2.onclick=()=>setDefault(m.slug,m.name);c.appendChild(s2);});
    pk.appendChild(c);
  });
  document.getElementById('err').textContent=d.error?('⚠ '+d.error):'';
}
function toggleFund(){const f=document.getElementById('fund');f.classList.toggle('show');
  if(f.classList.contains('show')&&addr&&window.qrcode){const q=qrcode(0,'M');q.addData(addr);q.make();document.getElementById('qr').innerHTML=q.createImgTag(4,0);}}
function copyAddr(){navigator.clipboard.writeText(addr).then(()=>note('Address copied.'));}
function note(m){const n=document.getElementById('note');n.textContent=m;clearTimeout(n._t);n._t=setTimeout(()=>n.textContent='',6000);}
async function post(url,msg){busy=true;try{const r=await fetch(url,{method:'POST'});if(msg)note(msg);return r;}finally{busy=false;await load();}}
async function setProvider(claw){if(busy)return;await post('/dashboard/api/toggle?name=desktop&on='+(claw?1:0),'Saved — restart Codex (Cmd+Q) to apply.');}
async function flip(name){if(busy)return;const cur=document.getElementById('sw-web').classList.contains('on');await post('/dashboard/api/toggle?name='+name+'&on='+(cur?0:1),'Saved — restart Codex to apply.');}
async function setDefault(slug,name){if(busy)return;await post('/dashboard/api/setdefault?model='+encodeURIComponent(slug),'Default → '+name+' (restart Codex).');}
async function updateModels(){if(busy)return;const b=document.getElementById('upd');b.textContent='Updating…';try{const r=await(await fetch('/dashboard/api/regen',{method:'POST'})).json();note('Catalog updated — '+(r.count||0)+' models. Restart Codex.');}catch(e){note('Update failed: '+e.message);}b.textContent='↻ Update models';await load();}
load();setInterval(()=>{if(!busy)load();},15000);
</script></body></html>`;
