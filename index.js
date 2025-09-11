// ==== Helpers ====
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const currencies = ["BRL","USD","EUR","CLP","ARS","GBP","JPY","CAD","AUD","CHF","CNY","MXN","COP","PEN"];

function fillCurrencySelects(){
  const trip = $("#tripCurrency");
  const user = $("#userCurrency");
  trip.innerHTML = currencies.map(c=>`<option>${c}</option>`).join("");
  user.innerHTML = currencies.map(c=>`<option>${c}</option>`).join("");
  trip.value = "USD";
  user.value = "BRL";
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

// ==== State ====
const STORAGE_KEY = "tripplanner:v2";
let memoryState = { trips:{}, order:[] };
let activeTripId = null; // para modal
let activeDayKey = null;  // para modal

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

// ==== Trips UI ====
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

    const stats = calcStatsForTrip(t);
    const summary = el("div","trip-sub");
    summary.textContent = ` ${t.settings.tripCurrency} ${stats.spent.toFixed(2)} • restante ${t.settings.tripCurrency} ${Math.max(0, (t.settings.budget||0) - stats.spent).toFixed(2)}`;

    // actions: resumo + excluir
    const actions = el("div","trip-actions");
    actions.appendChild(summary);
    const delBtn = el("button","action-btn red");
    delBtn.textContent = "Excluir calendário";
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation(); // não colapsar ao excluir
      if (!confirm(`Excluir o calendário "${t.name}"? Esta ação não pode ser desfeita.`)) return;
      const S = loadState();
      const idx = S.order.indexOf(t.id);
      if (idx > -1) S.order.splice(idx,1);
      delete S.trips[t.id];
      saveState(S);
      renderTrips();
    });

    actions.appendChild(delBtn);

    header.appendChild(left);
    header.appendChild(actions);

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
      list.forEach((act, i) => {
        const row = el("div","activity");

        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = !!act.done;
        check.addEventListener("change", () => {
          act.done = check.checked;
          const s = loadState();
          s.trips[trip.id].days[key][i] = act;
          saveState(s);
          renderTrips();
        });

        const text = el("div","activity-text"); text.textContent = act.activity;
        const cost = el("div","activity-cost"); cost.textContent = `${trip.settings.tripCurrency} ${Number(act.cost||0).toFixed(2)}`;

        const right = el("div"); right.style.display = "flex"; right.style.gap = "8px"; right.style.alignItems = "center";

        const maps = document.createElement("a");
        maps.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(act.activity)}`;
        maps.target = "_blank"; maps.rel = "noopener noreferrer";
        maps.className = "action-btn blue"; maps.textContent = "Maps";

        const del = el("button","action-btn red"); del.textContent = "Excluir";
        del.addEventListener("click", () => {
          const s = loadState();
          s.trips[trip.id].days[key].splice(i,1);
          saveState(s);
          renderTrips();
        });

        row.appendChild(check);
        row.appendChild(text);
        row.appendChild(cost);
        right.appendChild(maps);
        right.appendChild(del);
        row.appendChild(right);
        listEl.appendChild(row);
      });
    }

    card.appendChild(header);
    card.appendChild(listEl);
    grid.appendChild(card);
  });

  return grid;
}

// ==== Modal ====
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

    const maps = document.createElement("a");
    maps.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(act.activity)}`;
    maps.target = "_blank"; maps.rel = "noopener noreferrer";
    maps.className = "action-btn blue"; maps.textContent = "Maps";

    const del = el("button","action-btn red"); del.textContent = "Excluir";
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
    right.appendChild(maps);
    right.appendChild(del);
    row.appendChild(right);
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

// ==== Events ====
function attachEvents(){
  // Gerar calendário: se controles colapsados -> expandir. Se visíveis -> criar trip e colapsar novamente.
  $("#generate").addEventListener("click", () => {
    const controls = document.querySelector(".controls");
    if (controls.classList.contains("collapsed")){
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
        tripCurrency: $("#tripCurrency").value,
        userCurrency: $("#userCurrency").value,
        rate: Number($("#exchangeRateInput").value || 1),
        budget: Number($("#budget").value || 0)
      },
      days:{},
      collapsed:true   // cria já colapsado (mostrar só o título)
    };
    state.trips[id] = trip;
    state.order.unshift(id); // mais recente em cima
    saveState(state);
    renderTrips();

    // Auto-colapsa controles e limpa os campos de nome/datas para a próxima criação
    controls.classList.add("collapsed");
    $("#tripName").value = "";
    // Mantém moedas/orçamento caso o usuário vá criar outro similar
  });

  $("#modalAddBtn").addEventListener("click", addActivity);
  $("#modal").addEventListener("click", (e) => {
    if (e.target.matches("[data-close]") || e.target.classList.contains("modal")) closeModal();
  });
  document.addEventListener("keydown",(e)=>{
    if (e.key === "Escape" && $("#modal").classList.contains("show")) closeModal();
  });

  // Enter no modal adiciona
  ["modalActivityInput","modalCostInput"].forEach(id=>{
    const elx = document.getElementById(id);
    elx.addEventListener("keydown", (ev) => { if (ev.key === "Enter") addActivity(ev); });
  });
}

// ==== Boot ====
(function init(){
  fillCurrencySelects();
  attachEvents();
  renderTrips();
})();
