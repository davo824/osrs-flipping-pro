// OSRS Flipping Pro — Finalized JS (readable build)
// - Robust element ID fallbacks
// - Defensive guards, small optimizations
// - Works with either #modeSel/#filterMode, #sigSel/#signalSel, #sigMode/#signalMode, #volWin/#volWindow

// ---------- helpers & state ----------
const API = "https://prices.runescape.wiki/api/v1/osrs";
const qs = s => document.querySelector(s);
const qsa = s => Array.from(document.querySelectorAll(s));
const els = {
  searchInput: qs('#searchInput'),
  cash:   qs('#cash'),
  cap:    qs('#itemsCap'),
  minHr:  qs('#minHrVol'),
  minRoi: qs('#minRoi'),
  fresh:  qs('#freshMins'),
  alloc:  qs('#allocPct'),
  sort:   qs('#sortSel'),
  // fallbacks for alternate IDs used in prior HTMLs
  mode:   qs('#modeSel')    || qs('#filterMode'),
  sig:    qs('#sigSel')     || qs('#signalSel'),
  sigMode:qs('#sigMode')    || qs('#signalMode'),
  scope:  qs('#scopeSel'),
  tbody:  qs('#tbl tbody'),
  diag:   qs('#diag'),
  volWin: qs('#volWin')     || qs('#volWindow')
};

const PIN_KEY  = 'osrsfp_pins_lite';
const SIG_KEY  = 'osrsfp_sig_lite';
const COLS_KEY = 'osrsfp_cols_full';
const ADV_KEY  = 'osrsfp_adv_lite';

let pinned = new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]'));
let lastSignals = JSON.parse(localStorage.getItem(SIG_KEY) || '{}');
function savePins(){ localStorage.setItem(PIN_KEY, JSON.stringify([...pinned])); }
function saveSignals(){ localStorage.setItem(SIG_KEY, JSON.stringify(lastSignals)); }

let mapping = {}, latest = {}, hr = {}, fiv = {};
function fmt(n){ return n==null ? '-' : Number(n).toLocaleString(); }

// ---------- data fetch ----------
async function getJson(u){
  const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
  if(!r.ok) throw new Error('HTTP '+r.status+' @ '+u);
  return r.json();
}
async function loadAll(){
  const [m,l,h,f] = await Promise.all([
    getJson(API+'/mapping'),
    getJson(API+'/latest'),
    getJson(API+'/1h'),
    getJson(API+'/5m')
  ]);
  mapping = {}; for(const it of (m||[])) mapping[it.id] = it;
  latest  = (l && l.data) || {};
  hr      = {}; if(h&&h.data){ if(Array.isArray(h.data)){ for(const r of h.data){ if(r&&r.id!=null) hr[r.id]=r; } } else { for(const k in h.data){ hr[+k]=h.data[k]; } } }
  fiv     = {}; if(f&&f.data){ if(Array.isArray(f.data)){ for(const r of f.data){ if(r&&r.id!=null) fiv[r.id]=r; } } else { for(const k in f.data){ fiv[+k]=f.data[k]; } } }
}

// ---------- pricing & signals ----------
function blended(id){
  const p = latest[id], h = hr[id] || {};
  const lowL = p?.low||0, highL = p?.high||0;
  const lowA = h?.avgLowPrice||lowL, highA = h?.avgHighPrice||highL;
  const wL = 0.6, wA = 0.4;
  return { low: Math.round(lowL*wL + lowA*wA), high: Math.round(highL*wL + highA*wA) };
}
function pricePlan(id){
  const p = latest[id]; if(!p) return null;
  const mode = els.sigMode?.value || 'stable';
  const pr = (mode === 'stable') ? blended(id) : { low: p.low, high: p.high };
  if(!pr.low || !pr.high) return null;
  const buy = pr.low + 1, sell = Math.max(1, pr.high - 1);
  const roi = ((sell*0.98 - buy) / buy) * 100;
  const marginPct = ((pr.high - pr.low) / pr.low) * 100;
  return { pr, buy, sell, roi, marginPct };
}
function activity(id){
  const h = hr[id] || {}, f = fiv[id] || {};
  const v1h = (h.highPriceVolume ?? h.lowPriceVolume ?? h.volume ?? 0) || 0;
  const v5  =  f.highPriceVolume ?? f.lowPriceVolume ?? f.volume ?? 0;
  const expected5 = v1h/12;
  const act = expected5>0 ? Math.max(0, Math.min(1.5, v5/expected5)) : 0;
  return { v1h, v5, act };
}
function confidence(id, roi, marginPct){
  const now = Math.floor(Date.now()/1000);
  const p = latest[id], h = hr[id] || {};
  const freshSecs = Math.min(now-(p?.highTime||0), now-(p?.lowTime||0));
  const freshLimit = (+els.fresh?.value || 8) * 60;
  const freshScore = Math.max(0, 1 - (freshSecs/(freshLimit*1.2)));
  const vol = (h.highPriceVolume ?? h.lowPriceVolume ?? h.volume ?? 0);
  const volScore = Math.min(1, vol/Math.max(1, (+els.minHr?.value||1000)));
  const stable = (marginPct>=2 && marginPct<=12) ? 1 : 0.5;
  const roiScore = Math.min(1, roi/8);
  return { c: Math.max(0, Math.min(1, freshScore*0.35 + volScore*0.25 + stable*0.2 + roiScore*0.2)), fresh: freshSecs, vol };
}
function rawSig(roi, c, marginPct){
  const minR = Math.max(2, (+els.minRoi?.value||3));
  if(roi < minR || marginPct < 2) return 'DODGE';
  if(c>=0.7 && roi>=minR) return 'BUY';
  if(c>=0.5) return 'HOLD';
  return 'DODGE';
}
const PIN_HYST = 2;
function stickySig(id, prop){
  const prev = lastSignals[id]?.sig || null;
  const conf = lastSignals[id]?.confirms || 0;
  if(!pinned.has(id)){ lastSignals[id] = {sig:prop, confirms:0}; return prop; }
  if(prev===null){ lastSignals[id] = {sig:prop, confirms:0}; return prop; }
  if(prop===prev){ lastSignals[id] = {sig:prev, confirms:0}; return prev; }
  const next = conf+1;
  if(prev==='BUY' && (prop==='DODGE'||prop==='HOLD')){
    if(next<PIN_HYST){ lastSignals[id] = {sig:prev, confirms:next}; return prev; }
  }
  lastSignals[id] = {sig:prop, confirms:0}; return prop;
}
function why({fresh, marginPct, vol, roi, mode}){
  const a=[];
  a.push((mode==='stable') ? '🧠 stable' : '⚡ live');
  const lim = ((+els.fresh?.value||8)*60);
  a.push((fresh<=lim)?'fresh':'stale');
  a.push((marginPct>=2 && marginPct<=12)?'spread ok':'spread risk');
  a.push(vol>=(+els.minHr?.value||1000)?'high vol':'low vol');
  a.push(roi>=(+els.minRoi?.value||3)?'roi ok':'roi low');
  return a.join(' · ');
}
function suggestQty(low){
  const stack = +(els.cash?.value || 10000000);
  const alloc = (+(els.alloc?.value || 20))/100;
  const cap   = Math.max(1, +(els.cap?.value || 6));
  if(!isFinite(low) || low<=0 || stack<=0) return 0;
  const per = stack*alloc, par = stack/cap, spend = Math.min(per, par);
  return Math.max(0, Math.floor(spend/low));
}

// ---------- filters (quick + advanced) ----------
const filters = { volume:null, traders:null };
let pop = null, advPop = null;

function placePop(anchor, el, w){
  const r = anchor.getBoundingClientRect(), m=8, vw=innerWidth, vh=innerHeight;
  let L = Math.min(vw-w-m, Math.max(m, r.right-w)), T = r.bottom + m;
  document.body.appendChild(el);
  requestAnimationFrame(()=>{
    const pr = el.getBoundingClientRect();
    if(pr.bottom > vh - m) T = Math.max(m, vh - pr.height - m);
    if(pr.right  > vw - m) L = Math.max(m, vw - pr.width  - m);
    el.style.left = L+'px'; el.style.top = T+'px';
  });
}
function openFilter(col, anchor){
  if(advPop){ advPop.remove(); advPop=null; }
  if(pop){ pop.remove(); pop=null; }
  pop = document.createElement('div'); pop.className = 'pop';
  const f = filters[col] || {op:'gte', a:0, b:''};
  pop.innerHTML = `<h4>${col} filter</h4>
    <div class="row">
      <label>Op <select id="op">
        <option value="gte" ${f.op==='gte'?'selected':''}>≥</option>
        <option value="lte" ${f.op==='lte'?'selected':''}>≤</option>
        <option value="between" ${f.op==='between'?'selected':''}>Between</option>
      </select></label>
      <label>A <input id="a" type="number" value="${f.a}"></label>
      <label id="bwrap" style="display:${f.op==='between'?'block':'none'}">B <input id="b" type="number" value="${f.b||''}"></label>
    </div>
    <div class="row" style="justify-content:flex-end">
      <button id="clear">Clear</button><button id="apply">Apply</button>
    </div>`;
  placePop(anchor, pop, 260);
  const op = pop.querySelector('#op'), a = pop.querySelector('#a'), b = pop.querySelector('#b'), bw = pop.querySelector('#bwrap');
  op.onchange = ()=> bw.style.display = (op.value==='between')?'block':'none';
  pop.querySelector('#clear').onclick = ()=>{ filters[col]=null; pop.remove(); pop=null; rebuild(); };
  pop.querySelector('#apply').onclick = ()=>{ filters[col] = {op:op.value, a:+a.value||0, b:+(b?.value||0)}; pop.remove(); pop=null; rebuild(); };
}
document.addEventListener('click', e=>{
  const fb = e.target.closest('.filter-btn');
  if(fb){ openFilter(fb.dataset.col, fb); return; }
  if(pop && !e.target.closest('.pop')){ pop.remove(); pop=null; }
});

function simpleFilter(list){
  return list.filter(r=>{
    let ok = true;
    if(filters.volume){
      const f = filters.volume, v = r.volDisp || 0;
      if(f.op==='gte') ok &= v>=f.a;
      else if(f.op==='lte') ok &= v<=f.a;
      else ok &= v>=Math.min(f.a,f.b) && v<=Math.max(f.a,f.b);
    }
    if(ok && filters.traders && r.traders != null){
      const f = filters.traders, t = r.traders;
      if(f.op==='gte') ok &= t>=f.a;
      else if(f.op==='lte') ok &= t<=f.a;
      else ok &= t>=Math.min(f.a,f.b) && t<=Math.max(f.a,f.b);
    }
    return !!ok;
  });
}

function advDefaults(){ return {
  logic:'all', rules:{
    price:{e:false,op:'gte',a:10000,b:''},
    roi:{e:false,op:'gte',a:3,b:''},
    volume:{e:false,op:'gte',a:1200,b:''},
    traders:{e:false,op:'gte',a:3,b:''},
    profitEach:{e:false,op:'gte',a:500,b:''},
    profitQty:{e:false,op:'gte',a:10000,b:''}
}}}
function advLoad(){ try { return Object.assign(advDefaults(), JSON.parse(localStorage.getItem(ADV_KEY)||'{}')); } catch { return advDefaults(); } }
function advSave(v){ localStorage.setItem(ADV_KEY, JSON.stringify(v||advDefaults())); }

function applyAdv(rows){
  const st = advLoad();
  const enabled = Object.entries(st.rules).filter(([,r])=>r.e);
  if(!enabled.length) return rows;
  const pass = (r)=>{
    const checks = enabled.map(([k,ru])=>{
      const between = (val)=> val>=Math.min(ru.a,ru.b) && val<=Math.max(ru.a,ru.b);
      if(k==='price'){ const val=r.low; return ru.op==='gte'?val>=ru.a : ru.op==='lte'?val<=ru.a : between(val); }
      if(k==='roi'){   const val=r.roi; return ru.op==='gte'?val>=ru.a : ru.op==='lte'?val<=ru.a : between(val); }
      if(k==='volume'){const val=r.volDisp||0; return ru.op==='gte'?val>=ru.a : ru.op==='lte'?val<=ru.a : between(val); }
      if(k==='traders'){const val=r.traders??-1; return ru.op==='gte'?val>=ru.a : ru.op==='lte'?val<=ru.a : between(val); }
      if(k==='profitEach'){const val=Math.floor(r.margin||0); return ru.op==='gte'?val>=ru.a : ru.op==='lte'?val<=ru.a : between(val); }
      if(k==='profitQty'){ const val=r.pq||0; return ru.op==='gte'?val>=ru.a : ru.op==='lte'?val<=ru.a : between(val); }
      return true;
    });
    return st.logic==='all' ? checks.every(Boolean) : checks.some(Boolean);
  };
  return rows.filter(pass);
}
function openAdv(){
  if(advPop){ advPop.remove(); advPop=null; return; }
  if(pop){ pop.remove(); pop=null; }
  const st = advLoad();
  const P = document.createElement('div'); P.className='pop adv-pop';

  const mk = (k,l,u,h)=>`<div class="row">
    <label><input type="checkbox" class="en" data-k="${k}"> ${l}</label>
    <select class="op" data-k="${k}">
      <option value="gte">≥</option><option value="lte">≤</option><option value="between">Between</option>
    </select>
    <input class="a" data-k="${k}" type="number">
    <input class="b" data-k="${k}" type="number" style="display:none">
    <span class="muted">${u||''}</span>
  </div><div class="muted" style="margin-top:-6px">${h||''}</div>`;

  P.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <h4 style="margin:0">Advanced filters</h4>
      <button id="closeX" aria-label="Close" title="Close" style="font-weight:bold">×</button>
    </div>
    <label>Match <select id="logic"><option value="all">All</option><option value="any">Any</option></select></label>
    ${mk('price','Item price (Low)','gp','Ignore junk (e.g., ≥ 10,000gp)')}
    ${mk('roi','ROI %','','After tax')}
    ${mk('volume','Volume','','Uses chosen window')}
    ${mk('traders','Traders','','~4h lower bound')}
    ${mk('profitEach','Profit each','gp','(high-1)*0.98 - (low+1)')}
    ${mk('profitQty','Profit@Qty','gp','For suggested qty')}
    <div class="row" style="justify-content:flex-end">
      <button id="clear">Clear</button>
      <button id="apply" class="primary">Apply</button>
    </div>`;

  advPop = P; placePop(qs('#advBtn')||document.body, P, 320);

  // wire state
  const logic = P.querySelector('#logic'); logic.value = st.logic;
  for(const [k,r] of Object.entries(st.rules)){
    const en=P.querySelector(`.en[data-k="${k}"]`), op=P.querySelector(`.op[data-k="${k}"]`),
          a=P.querySelector(`.a[data-k="${k}"]`), b=P.querySelector(`.b[data-k="${k}"]`);
    en.checked=!!r.e; op.value=r.op; a.value=r.a; b.value=r.b||'';
    b.style.display = op.value==='between'?'inline-block':'none';
    op.onchange = ()=> b.style.display = (op.value==='between')?'inline-block':'none';
  }

  // buttons
  const closeAll = ()=>{ P.remove(); advPop=null; };
  P.querySelector('#closeX').onclick = closeAll;
  P.querySelector('#clear').onclick = ()=>{ advSave(advDefaults()); closeAll(); rebuild(); };
  P.querySelector('#apply').onclick = ()=>{
    const out = advDefaults(); out.logic = logic.value;
    for(const k of Object.keys(out.rules)){
      const en=P.querySelector(`.en[data-k="${k}"]`), op=P.querySelector(`.op[data-k="${k}"]`),
            a=P.querySelector(`.a[data-k="${k}"]`), b=P.querySelector(`.b[data-k="${k}"]`);
      out.rules[k] = { e:en.checked, op:op.value, a:+a.value||0, b:+b.value||0 };
    }
    advSave(out); closeAll(); rebuild();
  };

  // click-outside + Esc
  const btn = document.querySelector('#advBtn');
  const onDocClick = (e) => {
    if (!P.contains(e.target) && e.target !== btn) {
      closeAll();
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onEsc);
    }
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') {
      closeAll();
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onEsc);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  document.addEventListener('keydown', onEsc);
}


// ---------- item chart: series fetch (with timestep + cache) ----------
const __seriesCache = new Map(); // key: `${id}:${timestep}` -> data array

async function fetchSeries(id, timestep = '5m'){
  const key = `${id}:${timestep}`;
  if (__seriesCache.has(key)) return __seriesCache.get(key);
  try{
    const r = await fetch(`${API}/timeseries?id=${id}&timestep=${encodeURIComponent(timestep)}`, {
      headers:{'Accept':'application/json'}
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j = await r.json();
    const data = j?.data || j?.series || [];
    __seriesCache.set(key, data);
    return data;
  }catch(e){
    console.error('timeseries fail', e);
    return [];
  }
}


function openItemChart(id, name){
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="box">
      <header>
        <div class="hdr" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div><b>${name}</b> · price history</div>
          <div id="rangeBtns" style="display:flex;gap:6px">
            <button data-r="1h" aria-pressed="false">1h</button>
            <button data-r="1d" aria-pressed="true">1d</button>
            <button data-r="1w" aria-pressed="false">1w</button>
            <button data-r="1m" aria-pressed="false">1m</button>
          </div>
    <div id="chartMeta" class="chart-meta" style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px">
  <div class="mi" style="display:flex;gap:6px;align-items:center;background:rgba(255,255,255,.06);padding:4px 8px;border-radius:8px">
    <label style="font-weight:600;opacity:.8">Volume</label><span id="metaVol">—</span>
  </div>
  <div class="mi" style="display:flex;gap:6px;align-items:center;background:rgba(255,255,255,.06);padding:4px 8px;border-radius:8px">
    <label style="font-weight:600;opacity:.8">Last buy</label><span id="metaBuy">—</span>
  </div>
  <div class="mi" style="display:flex;gap:6px;align-items:center;background:rgba(255,255,255,.06);padding:4px 8px;border-radius:8px">
    <label style="font-weight:600;opacity:.8">Last sell</label><span id="metaSell">—</span>
  </div>
</div>

          <button id="close" style="border-radius:8px;padding:6px 10px">Close</button>
        </div>
      </header>
      <div class="body">
        <div class="legend"><span><span class="sw buy"></span>Instabuy (avgHigh)</span><span><span class="sw sell"></span>Instasell (avgLow)</span></div>
        <div id="chart"></div>
      </div>
    </div>
    <div class="tip" id="tip"></div>`;
  document.body.appendChild(modal);

  const box = modal.querySelector('.box');
  const tipEl   = modal.querySelector('#tip');
  const chartEl = modal.querySelector('#chart');
  const btnWrap = modal.querySelector('#rangeBtns');

  // close handlers (outside + Esc + button)
  const closeAll = ()=>{
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('keydown', onEsc, true);
    modal.remove();
  };
  const onDocClick = (e)=>{ if (!box.contains(e.target)) closeAll(); };
  const onEsc = (e)=>{ if (e.key === 'Escape') closeAll(); };
  modal.querySelector('#close').onclick = closeAll;
  setTimeout(()=>{ // avoid catching the opening click
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onEsc, true);
  },0);

  // ranges + timesteps
  const RANGES = {
    '1h': { secs: 60*60,        ts: '5m'  },
    '1d': { secs: 24*60*60,     ts: '5m'  },
    '1w': { secs: 7*24*60*60,   ts: '1h'  },
    '1m': { secs: 30*24*60*60,  ts: '6h'  }
  };
  let current = '1d'; // default requested

  btnWrap.addEventListener('click', async (e)=>{
    const b = e.target.closest('button[data-r]');
    if(!b) return;
    const next = b.dataset.r;
    if(next === current) return;
    // toggle aria-pressed correctly for all buttons including 1h/1d
    btnWrap.querySelectorAll('button[data-r]').forEach(x=>x.setAttribute('aria-pressed', x.dataset.r===next ? 'true' : 'false'));
    current = next;
    await loadAndDraw();
  });

async function loadAndDraw(){
  const cfg = RANGES[current];
  const raw = await fetchSeries(id, cfg.ts);

  // ✅ update the meta bar for this range
  updateChartMeta(raw, cfg.secs);

  drawBasicChart(raw, chartEl, tipEl, cfg.secs, current);
}

  
  
  // Summarise volume and last buy/sell for the current window
function updateChartMeta(rawData, secs){
  const metaVol  = modal.querySelector('#metaVol');
  const metaBuy  = modal.querySelector('#metaBuy');
  const metaSell = modal.querySelector('#metaSell');
  if(!metaVol || !metaBuy || !metaSell) return;

  const now = Date.now(), cutoff = now - (secs||24*60*60)*1000;
  // keep points inside selected window
  const pts = (rawData||[]).filter(d => ((d.timestamp||d.ts||0)*1000) >= cutoff);

  // sum volume for window (prefer split vols; else single)
  let vol = 0;
  for(const d of pts){
    const hv = (d.avgHighPriceVolume ?? d.highPriceVolume ?? 0) | 0;
    const lv = (d.avgLowPriceVolume  ?? d.lowPriceVolume  ?? 0) | 0;
    const v  = (d.volume ?? d.v ?? 0) | 0;
    vol += (hv || lv) ? (hv + lv) : v;
  }

  // latest point in window, else latest overall
  const last = pts.length ? pts[pts.length-1] : (rawData && rawData[rawData.length-1]);
  const lastBuy  = last ? (last.avgLowPrice  ?? last.low  ?? null) : null;
  const lastSell = last ? (last.avgHighPrice ?? last.high ?? null) : null;

  const fmt = n => (n==null ? '—' : n.toLocaleString());
  metaVol.textContent  = fmt(vol);
  metaBuy.textContent  = lastBuy  != null ? `${fmt(lastBuy)} gp`  : '—';
  metaSell.textContent = lastSell != null ? `${fmt(lastSell)} gp` : '—';
}


  // initial draw
  loadAndDraw();
}



function drawBasicChart(data, container, tip, rangeSecs, rangeKey){
  // filter by range (server may send more; we trim client-side)
  const nowMs = Date.now();
  const cutoffMs = rangeSecs ? (nowMs - rangeSecs*1000) : 0;

  // canvas sizing
  const W = container.clientWidth || 900, H = container.clientHeight || 380;
  const LPAD = 64, RPAD = 20, TPAD = 16, BPAD = 32;
  const plotW = W - LPAD - RPAD, plotH = H - TPAD - BPAD;

  const c = document.createElement('canvas'); c.width = W; c.height = H;
  container.innerHTML=''; container.appendChild(c);
  const ctx = c.getContext('2d');

  // points
  const pts = (data||[]).map(d=>({
    tms: (d.timestamp||d.ts||0) * 1000,
    high: d.avgHighPrice ?? null,
    low:  d.avgLowPrice  ?? null,
    hv:   d.avgHighPriceVolume ?? d.highPriceVolume ?? null,
    lv:   d.avgLowPriceVolume  ?? d.lowPriceVolume  ?? null
  }))
  .filter(p => (p.high||p.low))
  .filter(p => !cutoffMs || p.tms >= cutoffMs);

  if(!pts.length){
    ctx.fillStyle='#8ea2b9';
    ctx.fillText('No series data for this range.', 20, 24);
    return;
  }

  // scales
  const highs = pts.map(p=>p.high || p.low);
  const lows  = pts.map(p=>p.low  || p.high);
  const yMinRaw = Math.min(...lows.filter(Boolean));
  const yMaxRaw = Math.max(...highs.filter(Boolean));
  const yPad = Math.max(1, Math.round(0.05 * (yMaxRaw - yMinRaw)));
  const yMin = yMinRaw - yPad;
  const yMax = yMaxRaw + yPad;

  const tMin = pts[0].tms;
  const tMax = pts[pts.length-1].tms;

  const x = t => LPAD + ((t - tMin) / Math.max(1, tMax - tMin)) * plotW;
  const y = v => TPAD + (1 - (v - yMin) / Math.max(1, (yMax - yMin))) * plotH;

  // formatters
  const fmtK = n=>{
    if (n>=1_000_000_000) return (n/1_000_000_000).toFixed(2).replace(/\.00$/,'')+'b';
    if (n>=1_000_000)     return (n/1_000_000).toFixed(2).replace(/\.00$/,'')+'m';
    if (n>=1_000)         return (n/1_000).toFixed(1).replace(/\.0$/,'')+'k';
    return String(Math.round(n));
  };
  const tz = 'Australia/Brisbane';
  const fmtTimeShort = (ms)=> new Date(ms).toLocaleTimeString('en-AU',{ timeZone: tz, hour:'2-digit', minute:'2-digit' });
  const fmtDayShort  = (ms)=> new Date(ms).toLocaleDateString('en-AU',{ timeZone: tz, month:'short', day:'numeric' });
  // Special request: for 1m show D/M (e.g., 1/10)
  const fmtDayCompactDM = (ms)=>{
    const d = new Date(ms);
    const D = d.toLocaleDateString('en-AU',{ timeZone: tz, day:'numeric' });
    const M = d.toLocaleDateString('en-AU',{ timeZone: tz, month:'numeric' });
    return `${D}/${M}`;
  };

  // ticks
  // Y: 5 ticks
  const yTicks = 5;
  const yStep = (yMax - yMin) / (yTicks - 1);
  const yVals = Array.from({length:yTicks}, (_,i)=> Math.round(yMin + i*yStep));

  // X: cadence depends on span
  const spanMs = Math.max(1, tMax - tMin);
  const oneHour = 3600e3, oneDay = 24*oneHour;
  let xTickEveryMs;
  if (spanMs <= 6*oneHour)       xTickEveryMs = oneHour;
  else if (spanMs <= 2*oneDay)   xTickEveryMs = 3*oneHour;
  else if (spanMs <= 14*oneDay)  xTickEveryMs = oneDay;
  else                           xTickEveryMs = 3*oneDay;

  const align = (ms, step) => ms - (ms % step) + step;
  const xVals = [];
  for (let ms = align(tMin, xTickEveryMs); ms < tMax; ms += xTickEveryMs) xVals.push(ms);
  if (xVals.length === 0) xVals.push((tMin + tMax)/2);

  // background
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#0b1022'; ctx.fillRect(0,0,W,H);
  ctx.fillStyle = '#0f1731'; ctx.fillRect(LPAD, TPAD, plotW, plotH);

  // grid
  ctx.strokeStyle = '#1f2948'; ctx.lineWidth = 1;
  yVals.forEach(v=>{ const yy = y(v); ctx.beginPath(); ctx.moveTo(LPAD, yy); ctx.lineTo(LPAD+plotW, yy); ctx.stroke(); });
  xVals.forEach(ms=>{ const xx = x(ms); ctx.beginPath(); ctx.moveTo(xx, TPAD); ctx.lineTo(xx, TPAD+plotH); ctx.stroke(); });

  // axis labels
  ctx.fillStyle = '#c9d1e6'; ctx.font = '12px sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  yVals.forEach(v=> ctx.fillText(fmtK(v)+' gp', LPAD-6, y(v)));

  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  xVals.forEach((ms)=>{
    let label;
    if (rangeKey === '1m')       label = fmtDayCompactDM(ms);        // D/M e.g., 1/10
    else if (spanMs >= oneDay)   label = fmtDayShort(ms);            // e.g., 1 Oct
    else                         label = fmtTimeShort(ms);           // e.g., 13:30
    ctx.fillText(label, x(ms), TPAD+plotH+6);
  });

  // price lines
  const drawSeries = (prop, stroke) => {
    ctx.lineWidth = 2; ctx.strokeStyle = stroke;
    ctx.beginPath();
    pts.forEach((p,i)=>{
      const xv = x(p.tms), yv = y(p[prop] || (prop==='high'?p.low:p.high));
      if(i===0) ctx.moveTo(xv, yv); else ctx.lineTo(xv, yv);
    });
    ctx.stroke();
  };
  drawSeries('high', '#2ecc71');
  drawSeries('low',  '#ff6b81');

  // guides (Buy@ / Sell@ from latest)
  const last = pts[pts.length-1];
  const buyAt  = (last.low  ? last.low  + 1 : null);
  const sellAt = (last.high ? Math.max(1, last.high - 1) : null);

  ctx.setLineDash([6,6]); ctx.lineWidth = 1.5;
  if (sellAt){
    ctx.strokeStyle = '#2ecc71'; const ys = y(sellAt);
    ctx.beginPath(); ctx.moveTo(LPAD, ys); ctx.lineTo(LPAD+plotW, ys); ctx.stroke();
    ctx.fillStyle = '#2ecc71'; ctx.textAlign='left'; ctx.textBaseline='bottom';
    ctx.fillText(`Sell @ ${fmtK(sellAt)} gp`, LPAD+6, ys-2);
  }
  if (buyAt){
    ctx.strokeStyle = '#ff6b81'; const yb = y(buyAt);
    ctx.beginPath(); ctx.moveTo(LPAD, yb); ctx.lineTo(LPAD+plotW, yb); ctx.stroke();
    ctx.fillStyle = '#ff6b81'; ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText(`Buy @ ${fmtK(buyAt)} gp`, LPAD+6, yb+2);
  }
  ctx.setLineDash([]);

  // hover tooltip
  c.addEventListener('mousemove', e=>{
    const rect = c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const tAtMouse = tMin + Math.min(1, Math.max(0, (mx - LPAD)/plotW)) * (tMax - tMin);
    let bestI = 0, bestD = Infinity;
    for (let k=0;k<pts.length;k++){
      const dx = Math.abs(pts[k].tms - tAtMouse);
      if (dx < bestD){ bestD = dx; bestI = k; }
    }
    const p = pts[bestI]; if(!p) return;

    const buy = (p.low? p.low+1 : null), sell = (p.high? Math.max(1, p.high-1) : null);
    const profitEach = (sell&&buy) ? Math.floor(sell*0.98 - buy) : null;
    const roi = (sell&&buy&&buy>0) ? ((profitEach)/buy*100) : null;

    const html = `<b>${new Date(p.tms).toLocaleString('en-AU',{ timeZone:'Australia/Brisbane' })}</b><br>` +
      `${p.high?`Instabuy: <b>${p.high.toLocaleString()}</b><br>`:''}` +
      `${p.low?`Instasell: <b>${p.low.toLocaleString()}</b><br>`:''}` +
      `${(p.hv??p.lv)!=null?`Buy vol: ${(p.hv??0).toLocaleString()} · Sell vol: ${(p.lv??0).toLocaleString()}<br>`:''}` +
      `${(profitEach!=null)?`Profit(each): <b>${profitEach.toLocaleString()}</b><br>`:''}` +
      `${(roi!=null)?`ROI: <b>${roi.toFixed(1)}%</b>`:''}`;

    tip.innerHTML = html; tip.style.display='block';
    tip.style.left = (e.clientX + 12) + 'px';
    tip.style.top  = (e.clientY + 12) + 'px';
  });
  c.addEventListener('mouseleave', ()=>{ tip.style.display='none'; });
}

// Add this entire new function
function drawMiniChart(canvas, data, rangeSecs) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const nowMs = Date.now();
  const cutoffMs = rangeSecs ? (nowMs - rangeSecs * 1000) : 0;

  const pts = (data || [])
    .map(d => ({
      tms: (d.timestamp || d.ts || 0) * 1000,
      high: d.avgHighPrice ?? null,
      low: d.avgLowPrice ?? null,
    }))
    .filter(p => (p.high || p.low))
    .filter(p => !cutoffMs || p.tms >= cutoffMs);

  if (pts.length < 2) return;

  const yMin = Math.min(...pts.map(p => p.low || p.high).filter(Boolean));
  const yMax = Math.max(...pts.map(p => p.high || p.low).filter(Boolean));
  const tMin = pts[0].tms;
  const tMax = pts[pts.length - 1].tms;

  const x = t => ((t - tMin) / Math.max(1, tMax - tMin)) * W;
  const y = v => (1 - (v - yMin) / Math.max(1, yMax - yMin)) * H;

  const drawLine = (prop, stroke) => {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const val = p[prop] || (prop === 'high' ? p.low : p.high);
      if (val) {
        const xPos = x(p.tms), yPos = y(val);
        if (ctx.beginPath, i === 0 || !isFinite(yPos)) ctx.moveTo(xPos, yPos);
        else ctx.lineTo(xPos, yPos);
      }
    });
    ctx.stroke();
  };

  drawLine('high', '#2ecc71');
  drawLine('low', '#ff6b81');
}


// ---------- rows ----------
function tradersEst(win, v5, v1h, lim){
  if(!lim || lim<=0) return null;
  let vol4=0;
  if(win==='10m') vol4 = Math.round((v5*2)*24);
  else if(win==='1d') vol4 = Math.round((v1h*24)/6);
  else vol4 = Math.round(v1h*4);
  return Math.max(0, Math.ceil(vol4/lim));
}
function priceRow(id){
  const map = mapping[id]; if(!map) return null;
  const plan = pricePlan(id); if(!plan) return null;
  const {pr, buy, sell, roi, marginPct} = plan;
  const lim = map.limit || 0;
  const act = activity(id);
  if(act.v1h < (+els.minHr?.value || 0)) return null;
  const conf = confidence(id, roi, marginPct);
  let sig = stickySig(id, rawSig(roi, conf.c, marginPct));
  const m = els.mode?.value || 'davo';
  // Quick-flip logic (relaxed a touch to avoid empty screens)
  if(m==='hv' && (lim||0)<1000) return null;
  if(m==='hm' && (lim||0)>=100) return null;
  if(m==='qf'){
    if(conf.fresh > (+els.fresh?.value||8)*60) return null;
    if(act.act < 0.6) return null;
    if(marginPct < 1.5 || marginPct > 12) return null;
    if(act.v1h < Math.max(800, (+els.minHr?.value||0))) return null;
  }
  const isPinned = pinned.has(id);
  const qty = Math.min(lim||Infinity, suggestQty(pr.low));
  const profitEach = Math.floor(sell*0.98 - buy);
  const pq = Math.max(0, profitEach*qty);
  const limitProfit = Math.max(0, Math.floor((pr.high*0.98 - pr.low))*(lim||0));
  const win = els.volWin?.value || '1h';
  let volDisp = act.v1h;
  if(win==='10m') volDisp = Math.round(act.v5*2);
  else if(win==='1d') volDisp = Math.round(act.v1h*24);
  const explain = why({ fresh:conf.fresh, marginPct, vol:act.v1h, roi, mode:els.sigMode?.value||'stable' });
  const traders = tradersEst(win, act.v5, act.v1h, lim);
  return { id, name:map.name, low:pr.low, high:pr.high, margin:profitEach, roi, lim, traders, volDisp, conf:conf.c, sig, buy, sell, qty, pq, limitProfit, isPinned, explain, fresh:conf.fresh };
}
function scopeIds(){
  const sc = els.scope?.value || 'all';
  if(sc==='pinned') return [...pinned];
  return Object.keys(latest).map(Number).filter(id=>mapping[id]);
}
function buildRows(){
  const ids = scopeIds(); let kept=0, all=0; const rows=[];
  for(const id of ids){ all++; const r = priceRow(id); if(!r) continue; rows.push(r); kept++; }
  if(els.diag) els.diag.textContent = `Loaded ${all} ids · Passing filters: ${kept}`;
  return rows;
}

// ---------- quick controls helper (pure) ----------
function applyQuickControls(rows){
  let out = rows.slice();
  // Min ROI
  const minR = +els.minRoi?.value || 0;
  out = out.filter(r => (r.roi ?? -Infinity) >= minR);
  // Signal
  const sigVal = (els.sig?.value || 'any').toUpperCase();
  if (sigVal !== 'ANY') out = out.filter(r => (r.sig || '').toUpperCase() === sigVal);
  // Freshness
  const freshMins = +els.fresh?.value || 0;
  if (freshMins > 0) {
    const maxAge = freshMins * 60; // seconds
    out = out.filter(r => (r.fresh ?? Infinity) <= maxAge);
  }
  return out;
}

// ---------- recommendations ----------
function renderRecommendations(rows){
  const box = qs('#reco'); if(!box) return;
  if(!rows || !rows.length){ box.textContent='No data yet'; return; }
  const maxPq = Math.max(1, ...rows.map(r=>r.pq||0));
  const maxTr = Math.max(1, ...rows.map(r=>r.traders||0));
  const scored = rows.map(r=>{
    const s = 0.6*(r.pq/maxPq) + 0.4*((r.traders||0)/maxTr);
    return Object.assign({score:s}, r);
  }).sort((a,b)=>b.score-a.score).slice(0,5);
  box.innerHTML = scored.map(r=>`<div style="margin:6px 0;padding:8px;border:1px solid #2a3154;border-radius:10px">
    <b>${r.name}</b> — <span class="pos">${r.roi.toFixed(1)}% ROI</span>
    <div class="small muted">Qty ${r.qty} · Profit@Qty <b class="pos">${fmt(r.pq)}</b> gp · Traders ${fmt(r.traders||0)}</div>
  </div>`).join('');
}

// ---------- render ----------
function render(rows){
  const origRows = rows.slice();
  // Popover quick filters first (volume/traders)
  rows = simpleFilter(rows);
  // Advanced filter panel
  rows = applyAdv(rows);
  // Top quick controls
  rows = applyQuickControls(rows);

  const s = els.sort?.value || 'profit';
  rows.sort((a,b)=>{
    if(a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if(s==='profit') return b.pq - a.pq;
    if(s==='roi') return b.roi - a.roi;
    if(s==='limitProfit') return b.limitProfit - a.limitProfit;
    if(s==='volume') return (b.volDisp||0) - (a.volDisp||0);
    if(s==='traders') return (b.traders||0) - (a.traders||0);
    if(s==='speed') return 0;
    if(s==='name') return a.name.localeCompare(b.name);
    return b.pq - a.pq;
  });

  // auto-fallback: keep UI from blanking in Quick Flips
  if(!rows.length && origRows.length===0 && (els.mode?.value==='qf')){
    const oldMode = els.mode.value;
    els.mode.value = 'all';
    const alt = buildRows(); rows = alt;
    if(els.diag) els.diag.textContent += ' · No quick flips met criteria → showing All mode (temporary)';
    els.mode.value = oldMode;
  }
  renderRecommendations(rows);
  if(!els.tbody) return;
  els.tbody.innerHTML='';
  const MAX=350;

for(const r of rows.slice(0,MAX)){
    const cPct = Math.round(r.conf*100);
    const tr = document.createElement('tr');
    if(r.isPinned) tr.style.outline='1px solid #2a3154';
    tr.dataset.id = r.id; tr.dataset.name = r.name;
    tr.innerHTML = `
<td>
  <button class="pin" data-id="${r.id}" data-pinned="${r.isPinned ? 1 : 0}" aria-pressed="${r.isPinned}">
    ${r.isPinned ? '★' : '☆'}
  </button>
</td>
<td class="open-chart" style="text-align:left;cursor:pointer">${r.name}</td>
<td class="col-graph"><canvas class="mini-chart-canvas" width="150" height="45" data-id="${r.id}"></canvas></td>
<td>${fmt(r.low)} gp</td>
<td>${fmt(r.high)} gp</td>
<td>${fmt(r.margin)} gp</td>
<td class="${r.roi>=3?'pos':'warn'}">${r.roi.toFixed(1)}%</td>
<td>${r.lim?fmt(r.lim):'-'}</td>
<td>${r.traders!=null?fmt(r.traders):'-'}</td>
<td>${fmt(r.volDisp)}</td>
<td><span class="badge ${r.conf>=.7?'BUY':(r.conf>=.5?'HOLD':'DODGE')}">${cPct}%</span></td>
<td><span class="badge ${r.sig}">${r.sig}</span></td>
<td class="col-why muted" style="text-align:left">${r.explain||''}</td>
<td>${fmt(r.buy)} gp</td>
<td>${fmt(r.sell)} gp</td>
<td>${fmt(r.qty)}</td>
<td class="${r.pq>0?'pos':'neg'}">${fmt(r.pq)} gp</td>
<td class="muted">${fmt(r.limitProfit)} gp</td>`;

    const graphCell = tr.querySelector('.col-graph');
    if (graphCell) {
      const canvas = graphCell.querySelector('canvas');
      const RANGES = { '1h': { secs: 3600, ts: '5m' }, '1d': { secs: 86400, ts: '5m' }, '1w': { secs: 604800, ts: '1h' }, '1m': { secs: 2592000, ts: '6h' } };
      const cfg = RANGES[currentGlobalRange]; // Use the global range
      if (cfg) {
        fetchSeries(r.id, cfg.ts).then(data => {
          drawMiniChart(canvas, data, cfg.secs);
        });
      }
    }

    tr.addEventListener('click', ev=>{
      if(ev.target.closest('button.pin') || ev.target.closest('.col-graph')) return;
      openItemChart(r.id, r.name);
    });
    els.tbody.appendChild(tr);
  }
}
function rebuild(){ try { render(buildRows()); saveSignals(); } catch(e){ if(els.diag) els.diag.innerHTML='<b style="color:#ff8a8a">Render fail:</b> '+(e.message||e); } }
// Debounce helper
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Filter rows by search term (case-insensitive substring match on item name)
function filterBySearch(rows, term) {
  if (!term) return rows;
  const lowerTerm = term.toLowerCase();
  return rows.filter(r => r.name.toLowerCase().includes(lowerTerm));
}

// Wrap original buildRows to add search filtering
const originalBuildRows = buildRows;
function buildRowsWithSearch() {
  const rows = originalBuildRows();
  if (!els.searchInput) return rows;
  const term = els.searchInput.value.trim();
  return filterBySearch(rows, term);
}

// Override rebuild to use new buildRowsWithSearch
function rebuild() {
  try {
    render(buildRowsWithSearch());
    saveSignals();
  } catch (e) {
    if (els.diag) els.diag.innerHTML = '<b style="color:#ff8a8a">Render fail:</b> ' + (e.message || e);
  }
}

// Add event listener to search input with debounce
if (els.searchInput) {
  els.searchInput.addEventListener('input', debounce(() => {
    rebuild();
  }, 300));
}


// ---------- events (null-safe) ----------
['#cash','#itemsCap','#minHrVol','#minRoi','#freshMins','#allocPct','#sortSel','#modeSel','#filterMode','#sigSel','#signalSel','#sigMode','#signalMode','#scopeSel','#volWin','#volWindow']
.forEach(sel=>{ const el=qs(sel); if(el){ el.addEventListener('input',rebuild); el.addEventListener('change',rebuild); } });
const colsBtn = qs('#colsBtn'); if(colsBtn) colsBtn.onclick = ()=> openCols();
const advBtn  = qs('#advBtn');  if(advBtn)  advBtn.onclick  = ()=> openAdv();
const refreshBtn = qs('#refresh');
if(refreshBtn) refreshBtn.onclick = async ()=>{
  try{ if(els.diag) els.diag.textContent='Refreshing…'; await loadAll(); rebuild(); if(els.diag) els.diag.textContent=''; }
  catch(e){ if(els.diag) els.diag.innerHTML='<b style="color:#ff8a8a">Refresh failed:</b> '+(e.message||e); }
};
document.addEventListener('click', e=>{
  const p = e.target.closest('.pin');
  if(p){ const id = +p.dataset.id; pinned.has(id)?pinned.delete(id):pinned.add(id); savePins(); rebuild(); return; }
  const fb = e.target.closest('.filter-btn'); if(fb){ openFilter(fb.dataset.col, fb); }
});

// ---------- columns popover ----------
function getColState(){ try { return JSON.parse(localStorage.getItem(COLS_KEY)||'{}'); } catch { return {}; } }
function saveColState(v){ localStorage.setItem(COLS_KEY, JSON.stringify(v||{})); }
function applyCols(state){
  const defaults = {item:true,low:true,high:true,margin:true,roi:true,limit:true,traders:false,volume:true,conf:false,signal:false,why:false,buy:true,sell:true,qty:false,profit:false,limitprofit:false};
  const s = Object.assign(defaults, state||{});
  const tbl = qs('#tbl'); if(!tbl) return;
  tbl.classList.toggle('hide-col-item', s.item===false);
  tbl.classList.toggle('hide-col-graph', s.graph===false);
  tbl.classList.toggle('hide-col-low', s.low===false);
  tbl.classList.toggle('hide-col-high', s.high===false);
  tbl.classList.toggle('hide-col-margin', s.margin===false);
  tbl.classList.toggle('hide-col-roi', s.roi===false);
  tbl.classList.toggle('hide-col-limit', s.limit===false);
  tbl.classList.toggle('hide-col-traders', s.traders===false);
  tbl.classList.toggle('hide-col-volume', s.volume===false);
  tbl.classList.toggle('hide-col-conf', s.conf===false);
  tbl.classList.toggle('hide-col-signal', s.signal===false);
  tbl.classList.toggle('hide-col-why', s.why===false);
  tbl.classList.toggle('hide-col-buy', s.buy===false);
  tbl.classList.toggle('hide-col-sell', s.sell===false);
  tbl.classList.toggle('hide-col-qty', s.qty===false);
  tbl.classList.toggle('hide-col-profit', s.profit===false);
  tbl.classList.toggle('hide-col-limitprofit', s.limitprofit===false);
}
function openCols(){
  const existing = document.querySelector('.pop.cols');
  if (existing) { existing.remove(); return; }

const defaults = {
    item:true, graph:false, low:true, high:true, margin:true, roi:true, limit:true,
    traders:false, volume:true, conf:false, signal:false, why:false,
    buy:true, sell:true, qty:false, profit:false, limitprofit:false
  };
  const state = Object.assign({}, defaults, getColState());

  const cols = [
    ["item","Item"],["graph","Graph"],["low","Low"],["high","High"],["margin","Margin"],["roi","ROI %"],
    ["limit","Limit"],["traders","Traders"],["volume","Volume"],["conf","Conf"],
    ["signal","Signal"],["why","Why"],["buy","Buy @"],["sell","Sell @"],
    ["qty","Qty"],["profit","Profit@Qty"],["limitprofit","Limit Profit"]
  ];

  const pop = document.createElement('div'); pop.className='pop cols';
  pop.innerHTML =
    '<div class="row" style="justify-content:space-between;align-items:center">' +
      '<h4 style="margin:0">Columns</h4>' +
      '<button id="closeX" aria-label="Close" title="Close" style="font-weight:bold">×</button>' +
    '</div>' +
    '<div class="grid">' +
      cols.map(([k,l]) =>
        `<label><input type="checkbox" data-k="${k}" ${state[k]!==false ? 'checked' : ''}/> ${l}</label>`
      ).join('') +
    '</div>' +
    `<div class="row" style="justify-content:flex-end;margin-top:10px"><button id="close">Close</button></div>`;

  document.body.appendChild(pop);

  const btn = document.querySelector('#colsBtn');
  const r = btn ? btn.getBoundingClientRect() : { right:560, bottom:8 };
  pop.style.left = Math.max(8, Math.min(innerWidth - 600, r.right - 560)) + 'px';
  pop.style.top  = (r.bottom + 8) + 'px';

  pop.addEventListener('change', e => {
    const key = e.target?.dataset?.k; if (!key) return;
    state[key] = e.target.checked;
    applyCols(state);
    saveColState(state);
  });

  const closeAll = ()=> pop.remove();
  pop.querySelector('#close').onclick = closeAll;
  pop.querySelector('#closeX').onclick = closeAll;

  const onDocClick = (e) => {
    if (!pop.contains(e.target) && e.target !== btn) {
      closeAll();
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);

  document.addEventListener('keydown', function onEsc(e){
    if (e.key === 'Escape') {
      closeAll();
      document.removeEventListener('keydown', onEsc);
    }
  });
}


applyCols(getColState());

// ---------- profit calculator ----------
function setupCalc(){
  const wrap = qs('#calc'); if(!wrap) return;
  const buy=qs('#c_buy'), sell=qs('#c_sell'), qty=qs('#c_qty');
  const outSell=qs('#c_sell_out'), outBuy=qs('#c_buy_out'), outTax=qs('#c_tax'), outP=qs('#c_profit_each'), outR=qs('#c_roi');
  const num = v=>{ const n=parseFloat(v); return isFinite(n)?n:0; };
  const draw = ()=>{
    const b = num(buy.value), s = num(sell.value), q = Math.max(0, Math.floor(num(qty.value)));
    const sellTot=s*q, buyTot=b*q;
    const taxEach=Math.floor(s*0.02), taxTot=taxEach*q;
    const profitEach=Math.floor(s*0.98 - b), profitTot=profitEach*q;
    const roi = b>0 ? ((profitEach)/b*100) : 0;
    outSell.textContent = `${fmt(s)} (${fmt(sellTot)})`;
    outBuy.textContent  = `-${fmt(b)} (${fmt(buyTot)})`;
    outTax.textContent  = `-${fmt(taxEach)} (${fmt(taxTot)})`;
    outP.textContent    = `${fmt(profitEach)} (${fmt(profitTot)})`;
    outR.textContent    = `${roi>=0?'+':''}${roi.toFixed(1)}%`;
  };
  [buy,sell,qty].forEach(e=>e&&e.addEventListener('input', draw));
  const toggle = qs('#calc_toggle'); if(toggle) toggle.onclick = ()=> wrap.classList.toggle('open');
  draw();
}

// ---------- sticky offset ----------
function computeStickyTop(){
  const head = document.querySelector('header');
  const controls = document.querySelector('section.card .row');
  const h = head? head.getBoundingClientRect().height : 0;
  const c = controls? controls.getBoundingClientRect().height : 0;
  const off = Math.max(0, Math.round(h + c + 6));
  document.documentElement.style.setProperty('--stickyTop', off+'px');
}
window.addEventListener('resize', computeStickyTop);
try { new ResizeObserver(()=>computeStickyTop()).observe(document.body); } catch { /* older browsers */ }

// ---- sortable headers (DOM-only, no data reload) ----
(function enableHeaderSort(){
  const tbl = document.querySelector('#tbl'); if(!tbl) return;
  const ths = tbl.querySelectorAll('thead th');
  ths.forEach((th,i)=>{
    if(i<2) return; // skip pin + name
    th.classList.add('sortable');
    th.addEventListener('click', ()=>{
      const asc = !(th.classList.contains('sorted-asc'));
      ths.forEach(t=>t.classList.remove('sorted-asc','sorted-desc'));
      th.classList.add(asc?'sorted-asc':'sorted-desc');
      const rows = [...tbl.querySelectorAll('tbody tr')];
      rows.sort((a,b)=>{
        const av=(a.children[i]?.textContent||'').replace(/[^0-9.-]+/g,'');
        const bv=(b.children[i]?.textContent||'').replace(/[^0-9.-]+/g,'');
        const an=parseFloat(av)||0, bn=parseFloat(bv)||0;
        return asc ? an-bn : bn-an;
      });
      const tb = tbl.querySelector('tbody'); tb.innerHTML=''; rows.forEach(r=>tb.appendChild(r));
    });
  });
})();

  
// ---------- Global Graph Controls ----------
let currentGlobalRange = '1d';

function setupGlobalGraphControls() {
  const controls = qs('#graph-range-controls');
  if (!controls) return;

  const RANGES = {
    '1h': { secs: 3600, ts: '5m' },
    '1d': { secs: 86400, ts: '5m' },
    '1w': { secs: 604800, ts: '1h' },
    '1m': { secs: 2592000, ts: '6h' }
  };

  controls.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-r]');
    if (!btn) return;

    const newRange = btn.dataset.r;
    if (newRange === currentGlobalRange) return;

    // Update global state and button appearance
    currentGlobalRange = newRange;
    controls.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');

    // Redraw all visible charts
    const allCanvases = qsa('#tbl tbody .mini-chart-canvas');
    const cfg = RANGES[newRange];
    if (!cfg) return;

    for (const canvas of allCanvases) {
      const id = canvas.dataset.id;
      if (id) {
        const data = await fetchSeries(id, cfg.ts);
        drawMiniChart(canvas, data, cfg.secs);
      }
    }
  });
}
  
// ---------- init ----------
(async function init(){
  try{
    computeStickyTop();
    setupCalc();
    setupGlobalGraphControls(); // Add this line
    await loadAll();
    rebuild();
    setInterval(async()=>{ try{ await loadAll(); rebuild(); } catch(e){} }, 60000);
  }catch(e){
    if(els.diag) els.diag.innerHTML = '<b style="color:#ff8a8a">Init failed:</b> '+(e.message||e);
  }
})();

// ---------- self-tests (light, safe) ----------
(function tests(){
  try{
    console.group('Self-tests');
    console.assert(typeof suggestQty(1000) === 'number', 'suggestQty returns number');

    // NEW tests for quick filters
    const testRows = [
      { roi: 5, sig: 'BUY', fresh: 100, pq: 1000, isPinned:false },
      { roi: 2, sig: 'HOLD', fresh: 999999, pq: 500, isPinned:false },
      { roi: 10, sig: 'DODGE', fresh: 60, pq: 2000, isPinned:true }
    ];
    const prevMin = els.minRoi ? els.minRoi.value : null;
    const prevSig = els.sig ? els.sig.value : null;
    const prevFresh = els.fresh ? els.fresh.value : null;

    if(els.minRoi) els.minRoi.value = 4;
    if(els.sig) els.sig.value = 'any';
    if(els.fresh) els.fresh.value = 0;
    let out = applyQuickControls(testRows);
    console.assert(out.length === 2, 'Min ROI filter keeps rows with ROI >= 4');

    if(els.sig) els.sig.value = 'BUY';
    out = applyQuickControls(testRows);
    console.assert(out.length === 1 && out[0].sig==='BUY', 'Signal filter BUY works');

    if(els.sig) els.sig.value = 'any';
    if(els.fresh) els.fresh.value = 1/60; // 1 second equivalent -> should keep only very fresh
    out = applyQuickControls(testRows);
    console.assert(out.length >= 1, 'Freshness filter applies (non-zero)');

    // restore
    if(els.minRoi && prevMin!=null) els.minRoi.value = prevMin;
    if(els.sig && prevSig!=null) els.sig.value = prevSig;
    if(els.fresh && prevFresh!=null) els.fresh.value = prevFresh;

    // columns popup toggles
    if(qs('#colsBtn')){ openCols(); console.assert(!!document.querySelector('.pop.cols'),'Columns popup opens'); openCols(); console.assert(!document.querySelector('.pop.cols'),'Columns popup closes'); }
    console.groupEnd();
  }catch(err){ console.error('Self-tests failed', err); }
})();

// (Optional UI toggle helper from your snippet; safe if the elements don't exist)
document.addEventListener("DOMContentLoaded", () => {
  const button = document.querySelector(".expand-button");
  const innerRow = document.querySelector(".main-row > .x-row-inner");

  if (!button || !innerRow) return;

  let collapsed = false;

  button.addEventListener("click", () => {
    collapsed = !collapsed;

    const odds  = innerRow.querySelectorAll(":scope > *:nth-child(2n + 1)");
    const evens = innerRow.querySelectorAll(":scope > *:nth-child(2n)");
    const innerContent = document.querySelectorAll(".col-inner-content");

    if (collapsed) {
      evens.forEach(el => { el.style.flexBasis = "calc(100px - clamp(0px, var(--gap), 9999px))"; });
      odds.forEach(el => { el.style.flexBasis = "calc(100% - 100px - clamp(0px, var(--gap), 9999px))"; });
      innerContent.forEach(el => { el.style.display = "none"; });
      button.style.transform = "scaleX(-1)";
    } else {
      [...odds, ...evens].forEach(el => { el.style.flexBasis = ""; });
      innerContent.forEach(el => { el.style.display = ""; });
      button.style.transform = "scaleX(1)";
    }
  });
});
