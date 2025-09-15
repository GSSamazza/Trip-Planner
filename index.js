// ===== Helpers básicos =======================================================
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const currencies = ["BRL","USD","EUR","CLP","ARS","GBP","JPY","CAD","AUD","CHF","CNY","MXN","COP","PEN"];

// nomes PT para as mais usadas (as demais virão da API de símbolos)
const NAMES_PT = {
  BRL: "Real brasileiro", USD: "Dólar americano", EUR: "Euro",
  CLP: "Peso chileno", ARS: "Peso argentino", GBP: "Libra esterlina",
  JPY: "Iene japonês", CAD: "Dólar canadense", AUD: "Dólar australiano",
  CHF: "Franco suíço", CNY: "Yuan chinês", MXN: "Peso mexicano",
  COP: "Peso colombiano", PEN: "Sol peruano"
};
let SYMBOL_NAMES = { ...NAMES_PT }; // vai ser enriquecido pela API de símbolos

function fillCurrencySelects(){
  const trip = $("#tripCurrency");
  const user = $("#userCurrency");
  if (trip) trip.innerHTML = currencies.map(c=>`<option>${c}</option>`).join("");
  if (user) user.innerHTML = currencies.map(c=>`<option>${c}</option>`).join("");
  if (trip) trip.value = "USD";
  if (user) user.value = "BRL";
}

// ===== Card de câmbio (selects) ==============================================

function fxLabel(code){ return SYMBOL_NAMES[code] ? `${code} — ${SYMBOL_NAMES[code]}` : code; }

function fillFxSelectsFromCodes(codes){
  const from = $("#fxFromSelect");
  const to   = $("#fxToSelect");
  if (!from || !to) return;
  const opts = codes.map(c=>`<option value="${c}">${fxLabel(c)}</option>`).join("");
  from.innerHTML = opts;
  to.innerHTML   = opts;
  if (!from.value) from.value = "USD";
  if (!to.value)   to.value   = "BRL";
}

async function tryEnrichSymbols(){
  // mostra algo imediatamente (fallback)
  fillFxSelectsFromCodes(currencies);

  try{
    const r = await fetch("https://api.exchangerate.host/symbols", {mode:"cors"});
    if(!r.ok) throw 0;
    const j = await r.json();
    if (j && j.symbols){
      Object.entries(j.symbols).forEach(([code, obj])=>{
        if (!SYMBOL_NAMES[code]) SYMBOL_NAMES[code] = obj.description || code;
      });
      const allCodes = Object.keys(j.symbols).sort();
      fillFxSelectsFromCodes(allCodes);
    }
  }catch{ /* mantém fallback */ }
}

// Helper para pegar select com default
function getSelVal(id, fallback){
  const el = document.getElementById(id);
  if (!el) return fallback;
  if (!el.value) el.value = fallback;
  return el.value;
}

function parseDateInput(value){
  const [y,m,d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m-1, d, 12, 0, 0));
}
function formatDateHuman(dt){
  return dt.toLocaleDateString("pt-BR", { weekday:"short", day:"2-digit", month:"2-digit" });
}
function inclusiveDays(start, end){
  const days = [];
  const cur = new Date(start.getTime());
  while (cur.getTime() <= end.getTime()){
    days.push(new Date(cur.getTime()));
    cur.setUTCDate(cur.getUTCDate()+1);
  }
  return days;
}
function uid(){ return Math.random().toString(36).slice(2,9); }
const mapsUrl = (q)=>`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

// ===== Estado =================================================================
const STORAGE_KEY = "tripplanner:v2";
let memoryState = { trips:{}, order:[] };
let activeTripId = null; // modal
let activeDayKey = null; // modal

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) memoryState = JSON.parse(raw);
    return memoryState;
  }catch(e){
    console.warn("[TripPlanner] localStorage indisponível, usando memória volátil.", e);
    return memoryState;
  }
}
function saveState(state){
  memoryState = state;
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch(e){ console.warn("[TripPlanner] Falha ao salvar no localStorage; persistindo em memória.", e); }
}

// ====== COTAÇÃO: provedores + cache (estável + desempenho) ===================

const FRANKFURTER_CODES = new Set([
  "EUR","USD","GBP","JPY","AUD","BGN","BRL","CAD","CHF","CNY","CZK","DKK","HKD",
  "HUF","IDR","ILS","INR","ISK","KRW","MXN","MYR","NOK","NZD","PHP","PLN","RON",
  "SEK","SGD","THB","TRY","ZAR"
]);

const ratesCache = new Map();     // key: `${from}|${to}` -> {v, t}
const historyCache = new Map();   // key: `${span}|${from}|${to}` -> {arr, t}
const RATE_TTL_MS = 5 * 60 * 1000;   // 5 minutos
const HIST_TTL_MS = 60 * 60 * 1000;   // 1 hora

function getCache(map, key, ttlMs){
  const hit = map.get(key);
  if (hit && (Date.now() - hit.t) < ttlMs) return hit.v;
  return null;
}
function setCache(map, key, v){ map.set(key, {v, t: Date.now()}); }

async function provider_exchangerate_host(from,to){
  const r=await fetch(`https://api.exchangerate.host/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=1`,{mode:"cors"});
  if(!r.ok) throw 0; const j=await r.json(); if(typeof j.result!=="number") throw 0; return j.result;
}
async function provider_frankfurter(from,to){
  const r=await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,{mode:"cors"});
  if(!r.ok) throw 0; const j=await r.json(); const v=j?.rates?.[to]; if(typeof v!=="number") throw 0; return v;
}
async function provider_erapi(from,to){
  const r=await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`,{mode:"cors"});
  if(!r.ok) throw 0; const j=await r.json(); const v=j?.rates?.[to]; if(typeof v!=="number") throw 0; return v;
}

async function fetchRate(from,to){
  from = (from||"").toUpperCase();
  to   = (to||"").toUpperCase();
  if (from === to) return 1;

  const key = `${from}|${to}`;
  const cached = getCache(ratesCache, key, RATE_TTL_MS);
  if (cached != null) return cached;

  const frankOk = FRANKFURTER_CODES.has(from) && FRANKFURTER_CODES.has(to);
  const providers = frankOk
    ? [provider_frankfurter, provider_exchangerate_host, provider_erapi]
    : [provider_exchangerate_host, provider_erapi, provider_frankfurter];

  for (const p of providers){
    try {
      const v = await p(from,to);
      setCache(ratesCache, key, v);
      return v;
    } catch {}
  }
  throw new Error("Nenhum provedor retornou a cotação");
}

// Histórico (para o gráfico)
function dateToISO(d){ return d.toISOString().slice(0,10); }
function daysAgo(n){ const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return d; }

async function fetchHistory_frankfurter(from,to,span){
  const end=new Date();
  const start= span==="5D" ? daysAgo(7) : span==="1A" ? daysAgo(365) : daysAgo(31);
  const r=await fetch(`https://api.frankfurter.app/${dateToISO(start)}..${dateToISO(end)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,{mode:"cors"});
  if(!r.ok) throw 0;
  const j=await r.json();
  const s=Object.keys(j.rates||{}).sort().map(d=>({date:d,value:+j.rates[d][to]})).filter(x=>!isNaN(x.value));
  if(!s.length) throw 0;
  return s;
}
async function fetchHistory_exhost(from,to,span){
  const end=new Date();
  const start= span==="5D" ? daysAgo(7) : span==="1A" ? daysAgo(365) : daysAgo(31);
  const url=`https://api.exchangerate.host/timeseries?start_date=${dateToISO(start)}&end_date=${dateToISO(end)}&base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  const r=await fetch(url,{mode:"cors"});
  if(!r.ok) throw 0;
  const j=await r.json();
  const s=Object.keys(j.rates||{}).sort().map(d=>({date:d,value:+j.rates[d][to]})).filter(x=>!isNaN(x.value));
  if(!s.length) throw 0;
  return s;
}
async function fetchHistory(from,to,span){
  from = (from||"").toUpperCase(); to=(to||"").toUpperCase();
  const key = `${span}|${from}|${to}`;
  const cached = getCache(historyCache, key, HIST_TTL_MS);
  if (cached) return cached;

  const frankOk = FRANKFURTER_CODES.has(from) && FRANKFURTER_CODES.has(to);
  let arr;
  try{
    arr = frankOk ? await fetchHistory_frankfurter(from,to,span) : await fetchHistory_exhost(from,to,span);
  }catch{
    arr = frankOk ? await fetchHistory_exhost(from,to,span) : await fetchHistory_frankfurter(from,to,span);
  }
  setCache(historyCache, key, arr);
  return arr;
}

// ===== Render de TRIPs ========================================================
function renderTrips(){
  const state = loadState();
  const container = $("#trips");
  container.innerHTML = "";
  if (state.order.length === 0){
    const empty = el("div","empty");
    empty.textContent = "Nenhum calendário ainda. Clique em “Gerar calendário” para criar o primeiro.";
    container.appendChild(empty);
    return;
  }

  state.order.forEach(id => {
    const t = state.trips[id];
    const tripEl = el("section","trip" + (t.collapsed ? " collapsed" : ""));

    // Header
    const header = el("div","trip-header");
    const left = el("div","trip-title");
    const chev = el("span","chevron"); chev.textContent = "▸";
    const title = el("span"); title.textContent = t.name || "Calendário sem nome";
    const sub = el("span","trip-sub"); sub.textContent = ` ${t.settings.start} → ${t.settings.end}`;
    left.appendChild(chev); left.appendChild(title); left.appendChild(sub);

    const summary = el("div","trip-sub");
    const stats = calcStatsForTrip(t);
    summary.textContent = ` ${t.settings.tripCurrency} ${stats.spent.toFixed(2)} • restante ${t.settings.tripCurrency} ${Math.max(0, (t.settings.budget||0) - stats.spent).toFixed(2)}`;

    // Apenas EXCLUIR
    const btnDel = el("button","action-btn red");
    btnDel.textContent = "Excluir";
    btnDel.addEventListener("click",(ev)=>{
      ev.stopPropagation();
      if(!confirm(`Excluir o calendário "${t.name}"?`)) return;
      const s = loadState(); const i = s.order.indexOf(t.id);
      if (i>-1) s.order.splice(i,1); delete s.trips[t.id]; saveState(s); renderTrips();
    });

    const actionsWrap = el("div");
    actionsWrap.style.display="flex"; actionsWrap.style.gap="8px"; actionsWrap.style.alignItems="center";
    actionsWrap.appendChild(summary);
    actionsWrap.appendChild(btnDel);

    header.appendChild(left);
    header.appendChild(actionsWrap);
    header.addEventListener("click", () => {
      t.collapsed = !t.collapsed;
      saveState(state);
      renderTrips();
    });

    // Body
    const body = el("div","trip-body");
    const bodyStats = renderStats(t);
    const cal = renderCalendar(t);
    body.appendChild(bodyStats);
    body.appendChild(cal);

    tripEl.appendChild(header);
    tripEl.appendChild(body);
    container.appendChild(tripEl);
  });
}

function calcStatsForTrip(trip){
  let spent = 0;
  let done = 0;
  Object.values(trip.days).forEach(list => {
    list.forEach(a => { spent += Number(a.cost||0); if (a.done) done++; });
  });
  return { spent, done };
}

function renderStats(trip){
  const rate = Number(trip.settings.rate || 1);
  const tripCur = trip.settings.tripCurrency;
  const userCur = trip.settings.userCurrency;
  const budget = Number(trip.settings.budget || 0);
  const { spent, done } = calcStatsForTrip(trip);
  const spentUser = spent * rate;
  const remainingTrip = Math.max(0, budget - spent);

  const wrap = el("section","stats");
  wrap.innerHTML = `
    <div class="stat"><span>Atividades concluídas</span><strong>${done}</strong></div>
    <div class="stat"><span>Gasto total</span><strong>${tripCur} ${spent.toFixed(2)}  •  ${userCur} ${spentUser.toFixed(2)}</strong></div>
    <div class="stat"><span>Restante do orçamento</span><strong>${tripCur} ${remainingTrip.toFixed(2)}</strong></div>
  `;
  return wrap;
}

function dayKeyFromDate(dt){
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth()+1).padStart(2,"0");
  const d = String(dt.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}

function renderCalendar(trip){
  const start = parseDateInput(trip.settings.start);
  const end   = parseDateInput(trip.settings.end);
  const range = inclusiveDays(start, end);

  const grid = el("main","calendar");

  if (!range.length){
    const e = el("div","empty");
    e.textContent = "Defina datas para este calendário.";
    grid.appendChild(e);
    return grid;
  }

  range.forEach(dt => {
    const key = dayKeyFromDate(dt);
    const list = trip.days[key] || [];

    const card = el("section","day-card");
    const header = el("div","day-header");
    const title = el("div","day-title"); title.textContent = formatDateHuman(dt);
    title.style.cursor="pointer";
    title.title = "Clique para ver/editar as atividades do dia";
    title.addEventListener("click", () => openModalForDay(trip.id, key, formatDateHuman(dt)));

    const actions = el("div","day-actions");
    const addBtn = el("button","icon-btn"); addBtn.textContent = "➕ Adicionar";
    addBtn.addEventListener("click", () => openModalForDay(trip.id, key, formatDateHuman(dt)));

    actions.appendChild(addBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const listEl = el("div","list");
    if (list.length === 0){
      const empty = el("div","empty");
      empty.textContent = "Nada planejado ainda. Clique em “Adicionar” para incluir atividades.";
      listEl.appendChild(empty);
    }else{
      // VISÃO COMPACTA: somente o nome da atividade (sem checkbox/custo/botões)
      list.forEach((act) => {
        const row = el("div","activity");
        row.style.display = "block";
        const text = el("div","activity-text"); 
        text.textContent = act.activity;
        row.appendChild(text);
        listEl.appendChild(row);
      });
    }

    card.appendChild(header);
    card.appendChild(listEl);
    grid.appendChild(card);
  });

  return grid;
}

// ===== Modal de atividades ====================================================
function openModalForDay(tripId, key, human){
  activeTripId = tripId;
  activeDayKey = key;
  $("#modalDayTitle").textContent = `Atividades em ${human}`;
  $("#modal").classList.add("show");
  $("#modal").setAttribute("aria-hidden","false");
  $("#modalActivityInput").value = "";
  $("#modalCostInput").value = "";
  $("#modalActivityInput").focus();
  renderModalList();
}
function closeModal(){
  $("#modal").classList.remove("show");
  $("#modal").setAttribute("aria-hidden","true");
  activeDayKey = null;
  activeTripId = null;
}

function renderModalList(){
  const listEl = $("#modalList");
  listEl.innerHTML = "";
  if (!activeDayKey || !activeTripId) return;
  const s = loadState();
  const trip = s.trips[activeTripId];
  const list = trip.days[activeDayKey] || [];

  if (list.length === 0){
    listEl.innerHTML = `<div class="empty">Sem atividades ainda.</div>`;
    return;
  }

  list.forEach((act, i) => {
    const row = el("div","activity");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !!act.done;
    check.addEventListener("change", () => {
      act.done = check.checked;
      const st = loadState();
      st.trips[activeTripId].days[activeDayKey][i] = act;
      saveState(st);
      renderModalList();
      renderTrips();
    });

    const text = el("div","activity-text"); text.textContent = act.activity;
    const cost = el("div","activity-cost"); cost.textContent = `${trip.settings.tripCurrency} ${Number(act.cost||0).toFixed(2)}`;

    const right = el("div"); right.style.display = "flex"; right.style.gap = "8px"; right.style.alignItems = "center";

    // novo botão: abre o mapa EMBUTIDO em um modal
    const mapInlineBtn = el("button","action-btn blue"); 
    mapInlineBtn.textContent = "Mapa";
    mapInlineBtn.addEventListener("click", () => openMapModal(act.activity));

    const del = el("button","activity-del"); del.setAttribute("title","Excluir"); del.textContent = "×";
    del.addEventListener("click", () => {
      const st = loadState();
      st.trips[activeTripId].days[activeDayKey].splice(i,1);
      saveState(st);
      renderModalList();
      renderTrips();
    });

    row.appendChild(check);
    row.appendChild(text);
    row.appendChild(cost);
    right.appendChild(mapInlineBtn);
    row.appendChild(right);
    row.appendChild(del);
    listEl.appendChild(row);
  });
}

function addActivity(ev){
  if (ev){ ev.preventDefault(); ev.stopPropagation(); }
  const activity = $("#modalActivityInput").value.trim();
  let cost = parseFloat($("#modalCostInput").value);
  if (isNaN(cost)) cost = 0;
  if (!activeTripId || !activeDayKey || !activity) return;
  const s = loadState();
  const t = s.trips[activeTripId];
  if (!t.days[activeDayKey]) t.days[activeDayKey] = [];
  t.days[activeDayKey].push({ activity, cost, done:false });
  saveState(s);
  $("#modalActivityInput").value = "";
  $("#modalCostInput").value = "";
  renderModalList();
  renderTrips();
}

// ===== MAP MODAL (Google Maps embed no próprio app) =====
function ensureMapModal(){
  let holder = document.getElementById("mapModal");
  if (holder) {
    // se já existe, garanta que as refs estão disponíveis
    holder._mapFrame = holder._mapFrame || holder.querySelector("#mapFrame");
    holder._openLink = holder._openLink || holder.querySelector("#openInMaps");
    return holder;
  }

  holder = document.createElement("div");
  holder.id = "mapModal";
  holder.className = "modal";
  holder.setAttribute("aria-hidden","true");

  holder.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-card" style="width:min(900px,92vw);">
      <button class="modal-close" title="Fechar" data-close>&times;</button>
      <h3 style="margin:4px 0 10px">Mapa do local</h3>
      <div style="border:1px solid rgba(255,255,255,.08); border-radius:12px; overflow:hidden">
        <iframe id="mapFrame" style="width:100%; height:60vh; border:0" loading="lazy"
                referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
      </div>
      <div style="display:flex; justify-content:flex-end; margin-top:10px; gap:8px">
        <a id="openInMaps" class="action-btn blue" target="_blank" rel="noopener noreferrer">Abrir no Maps</a>
        <button class="action-btn red" data-close>Fechar</button>
      </div>
    </div>
  `;
  document.body.appendChild(holder);

  const frame = holder.querySelector("#mapFrame");
  const openLink = holder.querySelector("#openInMaps");

  const close = () => {
    holder.classList.remove("show");
    holder.setAttribute("aria-hidden","true");
    if (frame) frame.src = "about:blank";
  };

  // Fecha pelos botões [data-close]
  holder.querySelectorAll("[data-close]").forEach(btn =>
    btn.addEventListener("click", (ev)=>{ ev.preventDefault(); ev.stopPropagation(); close(); })
  );

  // Fecha clicando no backdrop
  holder.querySelector(".modal-backdrop").addEventListener("click", close);

  // Evita fechar ao clicar dentro do card
  holder.querySelector(".modal-card").addEventListener("click", e => e.stopPropagation());

  // Fecha com ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && holder.classList.contains("show")) close();
  });

  // guarda helpers para uso no openMapModal
  holder._mapFrame = frame;
  holder._openLink = openLink;

  return holder;
}

function openMapModal(query){
  const modal = ensureMapModal();

  // revalida refs (por segurança em hot reload)
  const frame = modal._mapFrame || modal.querySelector("#mapFrame");
  const openA = modal._openLink || modal.querySelector("#openInMaps");

  const src = `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
  if (frame) frame.src = src;
  if (openA) openA.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

  modal.classList.add("show");
  modal.setAttribute("aria-hidden","false");
}




// ====== Conversor / Card de câmbio (gráfico + tooltip) =======================
let chartSpan = "1M";
let currentRate = 1;

function niceNum(x,round){ const e=Math.floor(Math.log10(x)); const f=x/Math.pow(10,e);
  let nf; if(round){ if(f<1.5) nf=1; else if(f<3) nf=2; else if(f<7) nf=5; else nf=10; }
  else { if(f<=1) nf=1; else if(f<=2) nf=2; else if(f<=5) nf=5; else nf=10; }
  return nf*Math.pow(10,e);
}
function niceTicks(min,max,nt=5){ const range=niceNum(max-min,false); const step=niceNum(range/(nt-1),true); const nmin=Math.floor(min/step)*step; const nmax=Math.ceil(max/step)*step; const t=[]; for(let v=nmin;v<=nmax+1e-9;v+=step)t.push(v); return {ticks:t,niceMin:nmin,niceMax: nmax}; }

let chartState=null; // {series,padL,padR,padT,padB,xFor,yFor,w,h}
let hoverIndex = -1;

function drawChart(canvas, series){
  if(!canvas) return;
  const DPR=window.devicePixelRatio||1;
  const w=canvas.clientWidth, h=canvas.clientHeight;
  canvas.width=Math.round(w*DPR); canvas.height=Math.round(h*DPR);
  const ctx=canvas.getContext("2d"); ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,w,h);
  const padL=56, padR=10, padT=10, padB=22;

  if(!series || !series.length){ chartState=null; return; }

  const values=series.map(p=>p.value);
  const min=Math.min(...values), max=Math.max(...values);
  const {ticks,niceMin,niceMax}=niceTicks(min,max,5);
  const span=(niceMax-niceMin)||1e-6;
  const xFor=i => padL + (i*(w-padL-padR))/((series.length-1)||1);
  const yFor=v => padT + (h-padT-padB) * (1 - (v-niceMin)/span);

  ctx.font="12px Inter, system-ui, sans-serif";
  ctx.fillStyle="rgba(231,238,251,.65)";
  ctx.strokeStyle="rgba(255,255,255,.1)";
  ctx.lineWidth=1;
  ticks.forEach(t=>{
    const y=yFor(t);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
    ctx.fillText(new Intl.NumberFormat("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}).format(t), 6, y+4);
  });

  const grad=ctx.createLinearGradient(0,padT,0,h-padB);
  grad.addColorStop(0,"rgba(0,255,150,.30)");
  grad.addColorStop(1,"rgba(0,255,150,0)");
  ctx.beginPath(); ctx.moveTo(padL,h-padB);
  series.forEach((p,i)=> ctx.lineTo(xFor(i), yFor(p.value)));
  ctx.lineTo(w-padR, h-padB); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();

  ctx.beginPath();
  series.forEach((p,i)=> i? ctx.lineTo(xFor(i), yFor(p.value)) : ctx.moveTo(xFor(i), yFor(p.value)));
  ctx.strokeStyle="rgba(0,255,150,.9)"; ctx.lineWidth=2; ctx.stroke();

  if(hoverIndex>=0){
    const p=series[hoverIndex], x=xFor(hoverIndex), y=yFor(p.value);
    ctx.save(); ctx.setLineDash([5,5]); ctx.strokeStyle="rgba(255,255,255,.45)";
    ctx.beginPath(); ctx.moveTo(x,padT); ctx.lineTo(x,h-padB); ctx.stroke(); ctx.restore();
    ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fillStyle="var(--bg)"; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle="rgba(0,255,150,.95)"; ctx.stroke();
  }

  chartState={series,padL,padR,padT,padB,xFor,yFor,w,h};
  updateTooltip();
}

async function updateChart(){
  const canvas=$("#rateChart"); const from=$("#fxFromSelect")?.value; const to=$("#fxToSelect")?.value;
  if(!canvas || !from || !to) return;
  try{
    const data=await fetchHistory(from,to,chartSpan);
    drawChart(canvas,data);
  }catch{/* ignora */}
}

// Tooltip
let tooltipEl = null;
function ensureTooltip(){
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.style.position="absolute";
  tooltipEl.style.pointerEvents="none";
  tooltipEl.style.background="rgba(15,17,21,.9)";
  tooltipEl.style.border="1px solid rgba(255,255,255,.15)";
  tooltipEl.style.borderRadius="8px";
  tooltipEl.style.padding="6px 8px";
  tooltipEl.style.font="12px Inter, system-ui, sans-serif";
  tooltipEl.style.color="#e7eefb";
  tooltipEl.style.transform="translate(-50%,-120%)";
  tooltipEl.style.display="none";
  $(".chart-wrap")?.appendChild(tooltipEl);
  return tooltipEl;
}
function updateTooltip(){
  const canvas=$("#rateChart");
  if(!canvas || !chartState) return;
  const tip = ensureTooltip();
  if (hoverIndex<0){ tip.style.display="none"; return; }

  const p = chartState.series[hoverIndex];
  const x = chartState.xFor(hoverIndex), y = chartState.yFor(p.value);
  tip.style.left = `${x}px`;
  tip.style.top  = `${y}px`;
  const vfmt = new Intl.NumberFormat("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2}).format(p.value);
  const dfmt = new Date(p.date+"T00:00:00Z").toLocaleDateString("pt-BR",{day:"2-digit",month:"short",weekday:"short"});
  tip.innerHTML = `<strong>${vfmt}</strong> — ${dfmt}`;
  tip.style.display="block";
}

function handleChartHover(e){
  if(!chartState) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  let bestI = -1, bestDx = 1e9;
  for(let i=0;i<chartState.series.length;i++){
    const xi = chartState.xFor(i);
    const dx = Math.abs(x - xi);
    if (dx < bestDx){ bestDx = dx; bestI = i; }
  }
  hoverIndex = bestI;
  drawChart(e.currentTarget, chartState.series);
}
function clearChartHover(){
  hoverIndex = -1;
  const canvas=$("#rateChart");
  if (chartState && canvas) drawChart(canvas, chartState.series);
}

// ===== Refresh de taxa ========================================================
let fetchingCtrl=null;
async function refreshRate(){
  const from = getSelVal("fxFromSelect","USD");
  const to   = getSelVal("fxToSelect","BRL");

  const updBtn = $("#updateRate");
  if (updBtn) updBtn.style.display = "none";

  if(fetchingCtrl) fetchingCtrl.abort();
  fetchingCtrl=new AbortController();
  try{
    const rate=await fetchRate(from,to);
    currentRate=rate;

    const ex = $("#exchangeRateInput"); if (ex) ex.value = String(rate);

    const headline=$("#fxHeadline");
    if(headline){
      const fmt = new Intl.NumberFormat("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
      headline.textContent=`1 ${from} igual a ${fmt.format(rate)} ${to}`;
    }

    const a=parseFloat($("#fxFromValue")?.value||"");
    if(!isNaN(a) && $("#fxToValue")) $("#fxToValue").value=(a*rate).toFixed(2);

    const info=$("#rateInfo");
    if(info) info.textContent=`Atualizado agora — ${new Date().toLocaleTimeString()}`;

    await updateChart();
  }catch{
    const info=$("#rateInfo");
    if(info) info.textContent="Não foi possível obter a cotação agora.";
  }
}

// ===== Eventos ===============================================================
function attachEvents(){
  // Gerar calendário
  $("#generate")?.addEventListener("click", () => {
    const controls = document.querySelector(".controls");
    if (controls && controls.classList.contains("collapsed")){
      controls.classList.remove("collapsed");
      const first = controls.querySelector(".field input, .field select");
      if (first) first.focus();
      return;
    }

    const name = $("#tripName").value.trim();
    const s = $("#startDate").value;
    const e = $("#endDate").value;
    if (!name){ alert("Dê um nome ao calendário (ex.: Calendário Santiago)."); return; }
    if (!s || !e){ alert("Informe as datas de início e fim."); return; }
    const start = parseDateInput(s);
    const end = parseDateInput(e);
    if (end < start){ alert("A data final deve ser maior ou igual à inicial."); return; }

    const state = loadState();
    const id = uid();
    const trip = {
      id,
      name,
      settings:{
        start:s, end:e,
        tripCurrency: $("#tripCurrency")?.value || "USD",
        userCurrency: $("#userCurrency")?.value || "BRL",
        rate: Number($("#exchangeRateInput").value || 1),
        budget: Number($("#budget").value || 0)
      },
      days:{},
      collapsed:false
    };
    state.trips[id] = trip;
    state.order.unshift(id);
    saveState(state);
    renderTrips();

    const controlsEl = document.querySelector(".controls");
    if (controlsEl) controlsEl.classList.add("collapsed");
    $("#tripName").value = "";
  });

  $("#modalAddBtn")?.addEventListener("click", addActivity);
  $("#modal")?.addEventListener("click", (e) => {
    if (e.target.matches("[data-close]") || e.target.classList.contains("modal")) closeModal();
  });
  document.addEventListener("keydown",(e)=>{
    if (e.key === "Escape" && $("#modal")?.classList.contains("show")) closeModal();
  });

  ["modalActivityInput","modalCostInput"].forEach(id=>{
    const elx = document.getElementById(id);
    elx?.addEventListener("keydown", (ev) => { if (ev.key === "Enter") addActivity(ev); });
  });

  // Conversor de câmbio
  $("#fxFromSelect")?.addEventListener("change", ()=> refreshRate());
  $("#fxToSelect")?.addEventListener("change", ()=> refreshRate());
  $("#fxFromValue")?.addEventListener("input", ()=>{
    const v=parseFloat($("#fxFromValue").value);
    if(!isNaN(v) && currentRate && $("#fxToValue")) $("#fxToValue").value=(v*currentRate).toFixed(2);
  });
  $("#fxToValue")?.addEventListener("input", ()=>{
    const v=parseFloat($("#fxToValue").value);
    if(!isNaN(v) && currentRate && $("#fxFromValue")) $("#fxFromValue").value=(v/currentRate).toFixed(2);
  });
  $("#fxSwap")?.addEventListener("click", ()=>{
    const fs=$("#fxFromSelect"), ts=$("#fxToSelect");
    if(fs && ts){ const tmp=fs.value; fs.value=ts.value; ts.value=tmp; refreshRate(); }
  });

  document.querySelectorAll(".chart-btn").forEach(b=>{
    b.addEventListener("click", async ()=>{
      document.querySelectorAll(".chart-btn").forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      chartSpan=b.dataset.span||"1M";
      await updateChart();
    });
  });

  const canvas = $("#rateChart");
  canvas?.addEventListener("mousemove", handleChartHover);
  canvas?.addEventListener("mouseleave", clearChartHover);
}

// ===== Boot ==================================================================
(async function init(){
  fillCurrencySelects();
  await tryEnrichSymbols();
  attachEvents();
  renderTrips();
  if ($("#fxFromSelect") && $("#fxToSelect")) await refreshRate();
})();
