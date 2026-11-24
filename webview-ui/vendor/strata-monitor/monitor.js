// Vendored from Strata (github.com/Niko1221/Strata, MIT License), serve/web/app.js
// at commit afcf3746a0613eb5c21c422ba0ca864ba08fb15b. Copied as JavaScript.
// Every change from the original is marked "Forge:" and listed in README.md.
"use strict";

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
// Forge: SPRITE is empty, so icon() emits `<use href="#i-…">` and resolves
// against the sprite inlined in this document (an external `<use href>` across
// the webview origin is unreliable).
const SPRITE = "";
const icon = (name, cls = "st-icon") => name === "forge"
  ? `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/><rect x="9" y="4" width="1.5" height="3" rx="0.5" fill="currentColor"/><rect x="13.5" y="4" width="1.5" height="3" rx="0.5" fill="currentColor"/><rect x="9" y="17" width="1.5" height="3" rx="0.5" fill="currentColor"/><rect x="13.5" y="17" width="1.5" height="3" rx="0.5" fill="currentColor"/><rect x="4" y="9" width="3" height="1.5" rx="0.5" fill="currentColor"/><rect x="4" y="13.5" width="3" height="1.5" rx="0.5" fill="currentColor"/><rect x="17" y="9" width="3" height="1.5" rx="0.5" fill="currentColor"/><rect x="17" y="13.5" width="3" height="1.5" rx="0.5" fill="currentColor"/></svg>`
  : name === "close" ? `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
  : `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, {maximumFractionDigits: d, minimumFractionDigits: d}));
const kfmt = (n) => (n == null ? "–" : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n));
// a context size: 32768 -> "32K" (powers of two), else like kfmt
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));   // memory: binary GB, as Windows shows it

// Forge: the panel has no localStorage. `store` keeps the same keys and the same
// call shape, but persists through the webview's own state, which VS Code keeps
// for the panel (so a card layout survives closing and reopening the tab).
const vscode = acquireVsCodeApi();
const state = () => ({...(vscode.getState() || {})});
const store = {
  get(k, d) { const s = state(); return Object.hasOwn(s, k) ? s[k] : d; },
  set(k, v) { const s = state(); s[k] = v; vscode.setState(s); return true; },
};

// ------------------------------------------------------------------ Monitor
const METRICS = [
  {key: "speed", label: "Speed", icon: "gauge", unit: "t/s", series: "tok_s"},
  {key: "gpu", label: "GPU load", icon: "gpu", unit: "%", series: "gpu_util", max: 100},
  {key: "vram", label: "VRAM", icon: "layers", unit: "GB", series: "gpu_mem_used"},
  {key: "temp", label: "GPU temp", icon: "thermometer", unit: "°C", series: "gpu_temp", tone: "warn"},
  {key: "power", label: "Power", icon: "bolt", unit: "W", series: "gpu_power"},
  {key: "pcie", label: "PCIe", icon: "link", unit: "", series: "gpu_pcie_rx_mb", tone: "info"},
  {key: "cpu", label: "CPU load", icon: "cpu", unit: "%", series: "cpu", max: 100},
  {key: "disk", label: "Disk read", icon: "disk", unit: "MB/s", series: "disk_read_mb", tone: "info"},
];
const metricMarkup = Object.fromEntries(METRICS.map((m) => [m.key, `
  <div class="st-card metric-card" id="${m.key}" data-card-key="${m.key}"><button class="metric-card__hide st-btn st-btn--icon" data-hide-card="${m.key}" aria-label="Hide ${esc(m.label)}" title="Hide ${esc(m.label)}">${icon("close", "st-icon st-icon--sm")}</button><div class="st-metric">
    <span class="st-metric__label" id="ml-${m.key}">${icon(m.icon, "st-icon st-icon--sm")}${esc(m.label)}</span>
    ${m.key === "speed" ? `<div class="speed-values">
      <div><span class="st-metric__value" id="mv-speed">-</span><span class="st-metric__sub" id="ms-speed">Decode</span></div>
      <div class="speed-prefill"><span class="st-metric__value" id="mv-prefill">-</span><span class="st-metric__sub" id="ms-prefill">Prefill</span></div>
    </div>` : `<span class="st-metric__value" id="mv-${m.key}">–</span>
    <span class="st-metric__sub" id="ms-${m.key}"></span>`}
    <svg class="st-metric__spark" id="sp-${m.key}" viewBox="0 0 100 32" preserveAspectRatio="none"${m.tone ? ` data-tone="${m.tone}"` : ""}>
      <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${m.key === "speed" ? `<g id="sp-prefill" class="speed-prefill"><path class="area" fill="currentColor" opacity=".12"/>
        <path class="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/></g>` : ""}</svg>
  </div></div>`]));

const STAT_CARDS = [
  {key: "speculation", label: "Speculation", icon: "bolt", spark: true},
  {key: "reuse", label: "Prompt reuse", icon: "layers", spark: true},
  {key: "prefill-time", label: "Prefill time", icon: "clock", spark: true},
  {key: "vram-free", label: "VRAM free", icon: "layers", spark: true},
  {key: "cpu-temp", label: "CPU temp", icon: "thermometer", spark: true},
  {key: "all-power", label: "All GPU power", icon: "bolt", spark: true},
  {key: "session", label: "Session", icon: "clock", spark: false},
  {key: "forge", label: "Forge", icon: "forge", spark: false},
  {key: "ups", label: "UPS", icon: "bolt", spark: false},
];
const statMarkup = Object.fromEntries(STAT_CARDS.map((card) => [card.key, `
  <div class="st-card metric-card stats-card" id="${card.key}" data-card-key="${card.key}"${["all-power", "cpu-temp", "forge", "ups"].includes(card.key) ? " hidden" : ""}>
    <button class="metric-card__hide st-btn st-btn--icon" data-hide-card="${card.key}" aria-label="Hide ${esc(card.label)}" title="Hide ${esc(card.label)}">${icon("close", "st-icon st-icon--sm")}</button>
    <div class="st-metric">
      <span class="st-metric__label" id="sl-${card.key}">
        ${icon(card.icon, "st-icon st-icon--sm")}<span id="slt-${card.key}">${esc(card.label)}</span></span>
      <span class="st-metric__value" id="sv-${card.key}">–</span>
      <span class="st-metric__sub" id="ss-${card.key}"></span>
      ${card.key === "vram-free" ? `<div class="st-progress stats-vram-bar" id="vram-free-progress">
        <div class="st-progress__bar" id="vram-free-bar" style="width:0%"></div></div>` : ""}
      ${card.spark ? `<svg class="st-metric__spark" id="sp-${card.key}" viewBox="0 0 100 32"
        preserveAspectRatio="none">
        <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"
        vector-effect="non-scaling-stroke"/></svg>` : ""}
      ${["reuse", "prefill-time"].includes(card.key)
        ? `<div class="stats-graph-note" id="gn-${card.key}" hidden>graph after 2 requests</div>` : ""}
    </div>
  </div>`]));

// One grid for every Monitor card, so a card can be dragged to any position; the rows come from wrapping.
const METRIC_CARDS = ["speed", "prefill-time", "reuse", "speculation", "gpu", "vram", "vram-free", "temp",
  "power", "all-power", "pcie", "cpu-temp", "cpu", "disk", "session", "forge", "ups"];
const metricGrid = $("metric-cards");
metricGrid.innerHTML = METRIC_CARDS.map((key) => metricMarkup[key] || statMarkup[key]).join("");
const CARD_ORDER_KEY = "monitor.cardOrder";
// Cards hidden with the x stay hidden across reloads; Reset layout brings them back.
const HIDDEN_CARDS_KEY = "monitor.hiddenCards";
const savedHidden = store.get(HIDDEN_CARDS_KEY, []);
const userHiddenCards = new Set(Array.isArray(savedHidden) ? savedHidden.filter((key) => METRIC_CARDS.includes(key)) : []);
for (const key of userHiddenCards) $(key).hidden = true;
const cardKeys = () => [...metricGrid.children].map((card) => card.dataset.cardKey);
function updateResetCardOrder() {
  const hidden = userHiddenCards.size;
  const button = $("reset-card-order");
  button.textContent = hidden ? `Reset layout · ${hidden} icon${hidden === 1 ? "" : "s"} hidden` : "Reset layout";
  button.parentElement.hidden = !hidden && cardKeys().join("\0") === METRIC_CARDS.join("\0");
}
function applySavedCardOrder() {
  const saved = store.get(CARD_ORDER_KEY, null);
  const known = Array.isArray(saved)
    ? saved.filter((key, index, list) => METRIC_CARDS.includes(key) && list.indexOf(key) === index) : [];
  const cards = new Map([...metricGrid.children].map((card) => [card.dataset.cardKey, card]));
  for (const key of [...known, ...METRIC_CARDS.filter((key) => !known.includes(key))]) metricGrid.appendChild(cards.get(key));
  updateResetCardOrder();
}
function saveCardOrder() {
  store.set(CARD_ORDER_KEY, cardKeys());
  updateResetCardOrder();
}
applySavedCardOrder();
$("reset-card-order").addEventListener("click", () => {
  // Forge: the two localStorage.removeItem calls become store writes, so the
  // card order and the hidden set clear in the webview state instead.
  store.set(CARD_ORDER_KEY, null);
  store.set(HIDDEN_CARDS_KEY, null);
  userHiddenCards.clear();
  for (const key of METRIC_CARDS) {
    const card = metricGrid.querySelector(`[data-card-key="${key}"]`);
    metricGrid.appendChild(card);
    card.hidden = card.dataset.metricDataHidden === "true";
  }
  updateResetCardOrder();
});
const cardPositionLive = $("card-position-live");
let cardDrag = null;
let pendingCardDrag = null;
function startCardDrag(card, event) {
  if (cardDrag) return;
  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "metric-card-placeholder";
  placeholder.style.width = `${rect.width}px`;
  placeholder.style.height = `${rect.height}px`;
  card.parentNode.insertBefore(placeholder, card);
  cardDrag = {card, placeholder, grid: card.parentNode,
    next: placeholder.nextSibling, x: event.clientX, y: event.clientY, style: card.getAttribute("style")};
  card.classList.add("is-dragging");
  card.style.position = "fixed";
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.style.width = `${rect.width}px`;
  card.style.height = `${rect.height}px`;
  card.style.zIndex = "10";
  card.setPointerCapture(event.pointerId);
}
function placeCardDrag(event) {
  if (!cardDrag) return;
  const {card, placeholder, grid, x, y} = cardDrag;
  card.style.transform = `translate3d(${event.clientX - x}px, ${event.clientY - y}px, 0)`;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".metric-card");
  if (!target || target === card || target.parentNode !== grid || target.hidden) return;
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2 ||
    (event.clientY <= rect.bottom && event.clientX < rect.left + rect.width / 2);
  grid.insertBefore(placeholder, before ? target : target.nextSibling);
}
function finishCardDrag(event, cancel = false) {
  if (!cardDrag) return;
  const drag = cardDrag;
  cardDrag = null;
  // Released outside the card area (over the state card, say): the card goes back where it was.
  const valid = !cancel && Boolean(document.elementFromPoint(event.clientX, event.clientY)?.closest("#metrics"));
  drag.card.classList.remove("is-dragging");
  if (drag.style === null) drag.card.removeAttribute("style");
  else drag.card.setAttribute("style", drag.style);
  if (valid) {
    drag.grid.insertBefore(drag.card, drag.placeholder);
    saveCardOrder();
  } else if (drag.next?.parentNode === drag.grid) drag.grid.insertBefore(drag.card, drag.next);
  else drag.grid.appendChild(drag.card);
  drag.placeholder.remove();
}
document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const card = event.target.closest(".metric-card[data-card-key]");
  if (!card || card.hidden || event.target.closest("button,a,select,input,textarea,[contenteditable='true']")) return;
  const touch = event.pointerType === "touch";
  const pending = {card, event, x: event.clientX, y: event.clientY, timer: null, started: false};
  pendingCardDrag = pending;
  if (touch) pending.timer = setTimeout(() => {
    pending.started = true;
    startCardDrag(card, event);
  }, 250);
});
document.addEventListener("pointermove", (event) => {
  const pending = pendingCardDrag;
  if (pending && !pending.started && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= 6) {
    clearTimeout(pending.timer);
    if (event.pointerType !== "touch") { pending.started = true; startCardDrag(pending.card, event); }
    else pendingCardDrag = null;
  }
  if (cardDrag) placeCardDrag(event);
});
document.addEventListener("pointerup", (event) => {
  if (pendingCardDrag) { clearTimeout(pendingCardDrag.timer); pendingCardDrag = null; }
  if (cardDrag) finishCardDrag(event);
});
// Touch: once the press-and-hold has started a drag, the finger must move the card, not scroll the page (the
// browser would take the gesture for a pan and cancel the pointer). Needs a non-passive listener.
document.addEventListener("touchmove", (event) => { if (cardDrag) event.preventDefault(); }, {passive: false});
document.addEventListener("contextmenu", (event) => { if (cardDrag || pendingCardDrag?.started) event.preventDefault(); });
document.addEventListener("pointercancel", (event) => {
  if (pendingCardDrag) { clearTimeout(pendingCardDrag.timer); pendingCardDrag = null; }
  if (cardDrag) finishCardDrag(event, true);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && cardDrag) { finishCardDrag(event, true); return; }
  if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key) || !(event.target instanceof Element)) return;
  if (!event.target.closest("[data-hide-card]")) return;
  const card = event.target.closest(".metric-card[data-card-key]");
  if (!card) return;
  const cards = [...card.parentNode.children].filter((candidate) => !candidate.hidden);
  const index = cards.indexOf(card), next = index + (event.key === "ArrowLeft" ? -1 : 1);
  if (next < 0 || next >= cards.length) return;
  event.preventDefault();
  card.parentNode.insertBefore(card, event.key === "ArrowLeft" ? cards[next] : cards[next].nextSibling);
  saveCardOrder();
  const label = card.querySelector(".st-metric__label, [id^='slt-']")?.textContent.trim() || card.dataset.cardKey;
  cardPositionLive.textContent = `Moved ${label} to position ${next + 1} of ${cards.length}`;
});
function setCardHidden(card, dataHidden) {
  card.dataset.metricDataHidden = String(Boolean(dataHidden));
  card.hidden = Boolean(dataHidden) || userHiddenCards.has(card.dataset.cardKey || card.id);
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-hide-card]");
  if (!button) return;
  const card = $(button.dataset.hideCard);
  if (!card) return;
  const order = [...document.querySelectorAll(".metric-card")];
  const index = order.indexOf(card);
  if (!("metricDataHidden" in card.dataset)) card.dataset.metricDataHidden = String(card.hidden);
  userHiddenCards.add(button.dataset.hideCard);
  store.set(HIDDEN_CARDS_KEY, [...userHiddenCards]);
  card.hidden = true;
  updateResetCardOrder();
  const next = order.slice(index + 1).find((candidate) => !candidate.hidden)
    || order.slice(0, index).reverse().find((candidate) => !candidate.hidden);
  if (next) next.querySelector("[data-hide-card]").focus();
  else document.querySelector('.st-tab[data-tab="monitor"]')?.focus();
});

// `fit`: scale to the series' own range (at least 10 units) instead of from 0, so a temperature moving between
// 25 and 30 degrees is visible rather than a flat line near the top.
function spark(id, values, max, fit) {
  const svg = $(id);
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  // Upstream 6a7c6f82 raised the axis floor from 1e-9 to 1 so an idle counter
  // stops drawing a full-amplitude square wave; keep that floor and add our
  // fit= auto-range, which is what makes cpu-temp readable.
  let bottom = 0, top = Math.max(max || 0, ...v, 1);
  const known = fit ? (values || []).filter((x) => x != null) : [];
  if (known.length) {
    bottom = Math.max(0, Math.min(...known) - 2);
    top = Math.max(Math.max(...known) + 2, bottom + 10);
  }
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (Math.max(0, x - bottom) / (top - bottom)) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}
function setMetric(key, value, unit, sub, options = {}) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
  $(`ms-${key}`).title = "";
  const card = $(key);   // "prefill" is a value inside the Speed card, not a card of its own
  if (card) setCardHidden(card, options.hidden);
}

let gpuSelection = String(store.get("monitor.gpu", "all"));
let gpuSelectorSignature = "";
function updateGpuSelector(hw, st) {
  const engineCards = (Array.isArray(hw.gpus) ? hw.gpus : []).map((g) => ({...g, inModel: true}));
  const otherCards = (Array.isArray(hw.other_gpus) ? hw.other_gpus : []).map((g) => ({...g, inModel: false}));
  const cards = [...engineCards, ...otherCards];
  const indexes = cards.map((g) => String(g.index));
  if (gpuSelection !== "all" && !indexes.includes(gpuSelection)) {
    gpuSelection = "all";
    store.set("monitor.gpu", gpuSelection);
  }
  const multiple = cards.length > 1;
  const buttonsMode = cards.length <= 6;
  const seg = $("gpu-seg"), selectWrap = $("gpu-select-wrap"), select = $("gpu-select"), selector = $("gpu-selector");
  selector.hidden = !multiple;
  $("gpu-seg-label").hidden = !multiple || !buttonsMode;
  seg.hidden = !multiple || !buttonsMode;
  selectWrap.hidden = !multiple || buttonsMode;
  const splitNames = typeof st.gpu_name === "string" ? st.gpu_name.split(" + ") : [];
  const engineNames = splitNames.length === engineCards.length ? splitNames : [];
  const otherNames = Array.isArray(st.other_gpu_names) ? st.other_gpu_names : [];
  const names = [...engineCards.map((_, i) => engineNames[i] || ""),
    ...otherCards.map((_, i) => otherNames[i] || "")];
  const signature = JSON.stringify([buttonsMode, indexes, names, engineCards.length]);
  if (signature !== gpuSelectorSignature) {
    gpuSelectorSignature = signature;
    const options = [{value: "all", label: "All", card: null},
      ...cards.map((card, i) => ({value: String(card.index), label: `GPU ${card.index}`, card, name: names[i]}))];
    const optionTitle = (option) => !option.card ? "" : option.card.inModel ? option.name || ""
      : `${option.label}${option.name ? ` (${option.name})` : ""} is not in use by the model`;
    if (buttonsMode) {
      seg.replaceChildren();
      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "radio");
        button.dataset.value = option.value;
        button.appendChild(document.createTextNode(option.label));
        if (option.card && !option.card.inModel) {
          const marker = document.createElement("span");
          marker.className = "gpu-seg__other";
          marker.setAttribute("aria-hidden", "true");
          marker.textContent = " (not in use)";
          button.appendChild(marker);
        }
        button.title = optionTitle(option);
        seg.appendChild(button);
      }
    } else {
      select.replaceChildren();
      for (const option of options) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = `${option.label}${option.card && !option.card.inModel ? " (not in use)" : ""}`;
        el.title = optionTitle(option);
        select.appendChild(el);
      }
    }
  }
  for (const button of seg.querySelectorAll('[role="radio"]')) {
    button.setAttribute("aria-checked", String(button.dataset.value === gpuSelection));
  }
  select.value = gpuSelection;
  return {cards, engineCards, otherCards, indexes, names};
}
function setGpuSelection(value, refocus = false) {
  gpuSelection = value;
  store.set("monitor.gpu", gpuSelection);
  if (lastMetrics) render(lastMetrics);
  if (refocus) {
    const button = [...$("gpu-seg").querySelectorAll('[role="radio"]')]
      .find((el) => el.dataset.value === gpuSelection);
    if (button) button.focus();
  }
}
$("gpu-seg").addEventListener("click", (event) => {
  const button = event.target.closest('[role="radio"]');
  if (button) setGpuSelection(button.dataset.value, true);
});
$("gpu-seg").addEventListener("keydown", (event) => {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
  const buttons = [...$("gpu-seg").querySelectorAll('[role="radio"]')];
  if (!buttons.length) return;
  event.preventDefault();
  const current = buttons.findIndex((button) => button === document.activeElement);
  const from = current < 0 ? Math.max(0, buttons.findIndex((button) => button.dataset.value === gpuSelection)) : current;
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
  const next = buttons[(from + step + buttons.length) % buttons.length];
  setGpuSelection(next.dataset.value, true);
});
$("gpu-select").addEventListener("change", (event) => setGpuSelection(event.target.value));

function gpuMetricData(hw, h, selector) {
  const cards = selector.cards;
  const selected = cards.length > 1 && gpuSelection !== "all"
    ? cards.find((g) => String(g.index) === gpuSelection) : null;
  if (!selected) return {hw, history: h, cards, engineCards: selector.engineCards,
    otherCards: selector.otherCards, selected: null, names: selector.names};
  const history = h.gpus && h.gpus[gpuSelection] ? h.gpus[gpuSelection] : {};
  return {
    hw: {...hw, gpu_util: selected.util, gpu_mem_used: selected.mem_used, gpu_mem_total: selected.mem_total,
      gpu_temp: selected.temp, gpu_power: selected.power, gpu_power_limit: selected.power_limit,
      gpu_pcie_rx_mb: selected.pcie_rx_mb, gpu_pcie_tx_mb: selected.pcie_tx_mb,
      gpu_pcie_gen: selected.pcie_gen, gpu_pcie_gen_max: selected.pcie_gen_max,
      gpu_pcie_width: selected.pcie_width},
    history, cards, engineCards: selector.engineCards, otherCards: selector.otherCards,
    selected, names: selector.names,
  };
}

// A one-line summary of a reading over several cards (the tightest or the highest); `title` lists every card.
function perCardLine(cards, value, format, options = {}) {
  const rows = cards.map((card) => ({card, score: value(card), text: `GPU ${card.index} ${format(card)}`}));
  const full = rows.map((row) => row.text).join(" · ");
  if (cards.length === 1) return {text: full, title: full};
  if (options.summary === "tightest") {
    const tightest = rows.filter((row) => Number.isFinite(row.score)).reduce(
      (best, row) => !best || row.score < best.score ? row : best, null);
    return {text: tightest ? `${cards.length} cards · GPU ${tightest.card.index} tightest` : `${cards.length} cards`,
      title: full};
  }
  const highest = rows.filter((row) => Number.isFinite(row.score)).reduce(
    (best, row) => !best || row.score > best.score ? row : best, null);
  const count = `${cards.length} ${options.countLabel || "cards"}`;
  return {text: highest ? `${count} · max ${format(highest.card)} on GPU ${highest.card.index}` : count, title: full};
}

function allGpuLine(engineCards, otherCards, value, format) {
  const rows = [...engineCards, ...otherCards].map((card) => ({card,
    text: `GPU ${card.index} ${format(card)}${card.inModel ? "" : " (not in use)"}`}));
  const details = rows.map((row) => row.text).join(" · ");
  if (engineCards.length + otherCards.length <= 3) return {text: details, title: ""};
  const summary = perCardLine(engineCards, value, format, {countLabel: "cards in use"});
  return {text: `${summary.text}${otherCards.length ? ` · ${otherCards.length} not in use` : ""}`,
    title: details};
}

// ------------------------------------------------------------------ the data
// Forge: Strata polls GET /metrics here. This panel has no server of its own: the
// extension host sends the same JSON as a `monitorMetrics` message, and the page
// calls the same render path. `lastMetrics`, `reqShowAll` and `reqClearedAfter`
// are the bookkeeping the render and the buttons need; the fetch, the 401/API-key
// path, the load/unload hold (metricsHold/metricsAgree), the retry counter and the
// MCP tick are not part of this page, so they are gone.
let lastMetrics = null;
let reqShowAll = false;   // the Monitor's request table: the last 12, or every one the server keeps (issue #35)
let reqClearedAfter = null;

function render(m) {
  // Forge: when the host has no reading for the model being shown it sends {error}, and
  // the state row says why instead of leaving an empty dashboard to be guessed at.
  if (typeof m.error === "string" && m.error) {
    $("state-label").textContent = m.error;
    $("state-detail").textContent = "";
    return;
  }
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];
  renderMonitor(live, hw, st, eng, h, last, m.requests || [],
    m.monitor_totals || m.totals, m.requests_kept, m.forge, m.ups, m.monitor_totals_reset);
  renderConvCache(m.conversation_cache);
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "monitorMetrics" || !data.metrics) return;
  lastMetrics = data.metrics;
  render(lastMetrics);
});
// Ask the host for the first reading, as Strata's first poll() did.
vscode.postMessage({type: "ready"});

// #596: the conversation cache - the prompt's state the engine keeps between requests (always), and the whole
// conversations it parks in RAM when "--conversation-cache-mib N" is in the run config's args (opt-in)
function since(t) {
  if (!t) return "";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${fmt(s / 60)} min ago` : `${fmt(s / 3600, 1)} h ago`;
}
function renderConvCache(c) {
  $("cc-card").hidden = !c;
  if (!c) return;                                  // an older server
  const pct = (a, b) => (b ? `${Math.min(100, (100 * a) / b)}%` : "0%");
  $("cc-bars").hidden = !c.enabled;
  if (c.enabled) {
    $("cc-slots-text").textContent = `${fmt(c.parked)} / ${fmt(c.slots)}`;
    $("cc-slots-bar").style.width = pct(c.parked, c.slots);
    const budget = c.budget_mib * 1048576;
    $("cc-mem-text").textContent = `${gb(c.bytes)} / ${gb(budget)} GB`;
    $("cc-mem-bar").style.width = pct(c.bytes, budget);
  }
  $("cc-sum").textContent = c.requests ? `${fmt(c.requests_reused)} of ${fmt(c.requests)} requests reused part of their prompt` : "";
  const share = c.prompt_tokens ? ` (${fmt((100 * c.reused_tokens) / c.prompt_tokens)}% of all prompt tokens)` : "";
  const event = c.last_event ? `${c.last_event === "parked" ? "Parked" : "Restored"} ${fmt(c.last_tokens)} tokens, ${since(c.last_at)}` : null;
  facts($("cc-facts"), [
    ["Last request", c.last_prompt != null ? `${fmt(c.last_reused || 0)} of ${fmt(c.last_prompt)} prompt tokens reused` : null],
    ["Reused since start", c.requests ? `${fmt(c.reused_tokens)} tokens${share}` : null],
    ["Parked / restored", c.enabled ? `${fmt(c.parks)} / ${fmt(c.restores)}${c.evictions ? ` · ${fmt(c.evictions)} evicted` : ""}` : null],
    ["Last switch", c.enabled ? event : null],
  ]);
  $("cc-note").textContent = c.enabled
    ? "A request that continues a parked conversation gets its state back instead of reading it again; the oldest goes when the slots or the memory are full."
    : "The engine keeps the last conversation's state, so a follow-up reads only what is new. To keep several conversations (agents taking turns), add \"--conversation-cache-mib\", \"8192\" to the run config's args (docs/DETAILS.md).";
}

function renderTotals(t) {
  if (!t || !t.requests) return "";
  const since = new Date(t.since * 1000).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"});
  const read = t.prompt_tokens - t.reused;
  const pSpeed = t.prompt_ms > 0 && read > 0 ? ` at ${fmt(read / (t.prompt_ms / 1000))} tok/s` : "";
  const oSpeed = t.decode_ms > 0 && t.output_tokens > 0 ? ` at ${fmt(t.output_tokens / (t.decode_ms / 1000), 1)} tok/s` : "";
  return `Since ${since}: ${fmt(t.requests)} requests · ${fmt(read)} prompt tokens read${pSpeed} (${fmt(t.reused)} reused) · ` +
         `${fmt(t.output_tokens)} written${oSpeed}`;
}
function setStat(key, value, unit, sub, values, max, options = {}) {
  $(`sv-${key}`).innerHTML = options.mutedValue
    ? `<span class="stats-empty-value">${esc(options.mutedValue)}</span>`
    : value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ss-${key}`).textContent = sub || "";
  $(`ss-${key}`).title = options.subTitle || "";
  $(`sl-${key}`).title = options.title || "";
  const card = $(key);
  setCardHidden(card, options.hidden);
  card.title = options.cardTitle || "";
  if (options.tone) card.dataset.tone = options.tone; else delete card.dataset.tone;
  if (key === "vram-free") {
    const progress = $("vram-free-progress");
    const bar = $("vram-free-bar");
    if (options.tone) progress.dataset.tone = options.tone; else delete progress.dataset.tone;
    bar.style.width = `${options.ratio == null ? 0 : Math.max(0, Math.min(100, options.ratio))}%`;
  }
  if (values !== undefined) {
    spark(`sp-${key}`, values, max, key === "cpu-temp");
    if (key === "reuse" || key === "prefill-time") {
      const graph = $(`sp-${key}`), note = $(`gn-${key}`);
      if (options.graphState === "unreported") {
        graph.hidden = true;
        note.hidden = true;
      } else {
        const waiting = options.graphState === "waiting" || values.length < 2;
        graph.hidden = waiting;
        note.hidden = !waiting;
      }
    }
  }
}
const pct = (part, whole) => Number.isFinite(part) && Number.isFinite(whole) && whole > 0 ? 100 * part / whole : null;
// NUT's ups.status words (Network UPS Tools): the primary state leads the card, and whatever else is
// going on with the UPS goes under it.  Unknown words are shown as they come, not swallowed.
const UPS_TOKENS = {
  OL: "On line", OB: "On battery", OFF: "Off", BYB: "Bypass", VRFC: "In simulator", NULL: "No reading",
  LB: "low battery", RB: "replace battery", FSD: "forced shutdown", ALARM: "ALARM", CHRG: "charging",
  DISCHRG: "discharging", OVER: "overloaded", BYPS: "wired bypass", TRIM: "trimming voltage",
  BOOST: "boosting voltage", WAIT: "waiting",
};
const UPS_PRIMARY = ["OFF", "OB", "OL", "BYB", "VRFC", "NULL"];
const UPS_DANGER = ["LB", "RB", "FSD", "ALARM"];
const UPS_WARN = ["CHRG", "DISCHRG", "OVER", "BYPS", "WAIT"];
function upsStateWords(status) {
  const tokens = String(status || "").trim().split(/\s+/).filter(Boolean);
  const primary = tokens.find((t) => UPS_PRIMARY.includes(t)) || "";
  const word = primary ? (UPS_TOKENS[primary] || primary)
    : tokens.length ? (UPS_TOKENS[tokens[0]] || tokens[0]) : "No reading";
  return {primary, word, tokens, label: tokens.map((t) => UPS_TOKENS[t] || t).join(" · ") || "No reading"};
}
// The runtime the UPS predicts, rounded once, in the shape the session card already uses: read as
// hours and minutes separately the two parts could disagree, and 7199 s came out as "1 h 60 min".
const upsDuration = (s) => { const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : m >= 1 ? `${m} min` : "<1 min"; };
function renderStats(eng, hw, st, h, requests, totals, forge, ups, totalsReset) {
  const cpuTempMissing = hw.cpu_temp == null;
  const cpuTempNotice = cpuTempMissing && st.os === "windows";
  const cpuTempHint = "Run LibreHardwareMonitor with its web server on (Options > Remote Web Server, port 8085), or set STRATA_LHM_URL.";
  setStat("cpu-temp", cpuTempMissing ? null : fmt(hw.cpu_temp), "°C",
    cpuTempMissing ? "" : st.cpu_name || "", h.cpu_temp, 100,
    {tone: "warn", hidden: cpuTempMissing && !cpuTempNotice,
      mutedValue: cpuTempNotice ? "Needs LibreHardwareMonitor" : "", title: cpuTempNotice ? cpuTempHint : "",
      cardTitle: cpuTempNotice ? cpuTempHint : ""});
  const rows = Array.isArray(requests) ? requests : [];
  const newest = rows[0] || null;
  const noRequests = !rows.length || Number(totals && totals.requests) === 0;
  const offeredTotal = Number(totals && totals.drafts_offered);
  const acceptedTotal = Number(totals && totals.drafts_accepted);
  const specEnabled = Number(eng && eng.spec) > 0;
  const specSeries = rows.slice().reverse().filter((r) => Number.isFinite(r.drafts_offered) && r.drafts_offered > 0 &&
    Number.isFinite(r.drafts_accepted)).map((r) => pct(r.drafts_accepted, r.drafts_offered));
  const specValue = newest && pct(newest.drafts_accepted, newest.drafts_offered);
  const specSince = pct(acceptedTotal, offeredTotal);
  setStat("speculation", noRequests || specValue == null ? null : fmt(specValue, 1), "%",
    noRequests ? "" : specSince == null ? "" : `since ${totalsReset ? "clear" : "start"} ${fmt(specSince, 1)}%`, specSeries, 100,
    {hidden: !specEnabled, mutedValue: noRequests ? "No requests yet" : !(offeredTotal > 0) ? "No drafts yet" : ""});

  const reuseSeries = rows.slice().reverse().filter((r) => Number.isFinite(r.prompt_tokens) && r.prompt_tokens > 0 &&
    Number.isFinite(r.reused)).map((r) => pct(r.reused, r.prompt_tokens));
  const reuseReported = rows.some((r) => Number.isFinite(r.prompt_tokens) && Number.isFinite(r.reused));
  const reuseValue = newest && pct(newest.reused, newest.prompt_tokens);
  const reuseSince = pct(Number(totals && totals.reused), Number(totals && totals.prompt_tokens));
  const reuseEmpty = noRequests ? "No requests yet" : !reuseReported ? "Not reported by this engine" : "";
  setStat("reuse", reuseEmpty || reuseValue == null ? null : fmt(reuseValue, 1), "%",
    reuseEmpty ? "" : `since ${totalsReset ? "clear" : "start"} ${reuseSince == null ? "–" : `${fmt(reuseSince, 1)}%`} · ` +
      `${fmt(totals && totals.reused || 0)} tokens`, reuseSeries, 100,
    {mutedValue: reuseEmpty, graphState: noRequests ? "waiting" : !reuseReported ? "unreported" : ""});

  const newTokens = newest && Number.isFinite(newest.prompt_tokens)
    ? Math.max(0, newest.prompt_tokens - (Number.isFinite(newest.reused) ? newest.reused : 0)) : null;
  const promptMs = newest && Number.isFinite(newest.prompt_ms) ? newest.prompt_ms : null;
  const promptSpeed = promptMs > 0 && newTokens != null ? newTokens / (promptMs / 1000) : null;
  const prefillSeries = rows.slice().reverse().filter((r) => Number.isFinite(r.prompt_ms))
    .map((r) => r.prompt_ms / 1000);
  const prefillReported = rows.some((r) => Number.isFinite(r.prompt_ms));
  const prefillEmpty = noRequests ? "No requests yet" : !prefillReported ? "Not reported by this engine" : "";
  setStat("prefill-time", prefillEmpty || promptMs == null ? null : fmt(promptMs / 1000, 1), "s",
    prefillEmpty ? "" : newTokens == null ? "" : `${fmt(newTokens)} new tokens${promptSpeed == null ? "" : ` at ${fmt(promptSpeed)} t/s`}`,
    prefillSeries, undefined,
    {mutedValue: prefillEmpty, graphState: noRequests ? "waiting" : !prefillReported ? "unreported" : ""});

  const engineCards = Array.isArray(hw.gpus) && hw.gpus.length ? hw.gpus :
    hw.gpu_mem_total != null && hw.gpu_mem_used != null
      ? [{index: null, mem_total: hw.gpu_mem_total, mem_used: hw.gpu_mem_used}] : [];
  const otherGpuCards = Array.isArray(hw.other_gpus) ? hw.other_gpus : [];
  const selectedEngineCard = gpuSelection !== "all"
    ? engineCards.find((g) => String(g.index) === gpuSelection) : null;
  const selectedOtherCard = gpuSelection !== "all"
    ? otherGpuCards.find((g) => String(g.index) === gpuSelection) : null;
  const selectedCard = selectedEngineCard || selectedOtherCard;
  const freeCards = selectedCard ? [selectedCard] : engineCards;
  const freeInfo = freeCards.map((g) => ({...g,
    free: Number.isFinite(g.mem_total) && Number.isFinite(g.mem_used) ? g.mem_total - g.mem_used : null}));
  const readableFree = freeInfo.filter((x) => Number.isFinite(x.free));
  const tightest = readableFree.reduce((best, x) => !best || x.free < best.free ? x : best, null);
  const freeGiB = tightest ? tightest.free / 1073741824 : null;
  const totalGiB = tightest ? tightest.mem_total / 1073741824 : null;
  const engineCount = Number.isFinite(Number(st.gpu_count)) ? Number(st.gpu_count) : engineCards.length;
  const freeLine = !selectedCard && engineCards.length > 1
    ? perCardLine(freeInfo, (g) => g.free, (g) => g.free == null ? "–" : `${fmt(g.free / 1073741824, 2)} GiB free`,
      {summary: "tightest"}) : null;
  let freeSub = "";
  if (tightest && selectedOtherCard) freeSub = `GPU ${tightest.index} · not in use · of ${fmt(totalGiB, 1)} GiB`;
  else if (tightest && engineCards.length === 1) freeSub = `of ${fmt(totalGiB, 1)} GiB`;
  else if (tightest && selectedCard) freeSub = `GPU ${tightest.index} selected · ${engineCount} cards · ` +
    `of ${fmt(totalGiB, 1)} GiB`;
  else if (tightest) freeSub = `${freeLine.text} · of ${fmt(totalGiB, 1)} GiB`;
  else if (engineCount > 1) freeSub = `${engineCount} cards · free VRAM unavailable`;
  const freeTitle = freeLine ? freeLine.title : freeInfo.map((gpu) => {
    const label = gpu.index == null ? "GPU" : `GPU ${gpu.index}`;
    return `${label}: ${gpu.free == null ? "–" : `${fmt(gpu.free / 1073741824, 2)} GiB free`}`;
  }).join(" · ");
  let freeSeries = [];
  if (tightest && engineCards.length === 1 && tightest.index == null) {
    freeSeries = (h.gpu_mem_used || []).map((used) => used == null ? null : hw.gpu_mem_total - used);
    freeSeries = freeSeries.map((free) => free == null ? null : free / 1073741824);
  } else if (tightest && h.gpus && h.gpus[String(tightest.index)]) {
    const total = tightest.mem_total;
    freeSeries = (h.gpus[String(tightest.index)].mem_used || []).map((used) =>
      used == null ? null : (total - used) / 1073741824);
  }
  const tone = freeGiB == null ? "" : freeGiB < 0.5 ? "danger" : freeGiB < 1 ? "warn" : "";
  setStat("vram-free", freeGiB == null ? null : fmt(freeGiB, 2), "GiB", freeSub, freeSeries,
    totalGiB, {tone, ratio: freeGiB == null || !totalGiB ? 0 : 100 * freeGiB / totalGiB,
      title: tone ? "little VRAM left: a growing context or the vision encoder may not fit"
        : selectedCard ? "free VRAM on the selected GPU" : "the smallest free VRAM over the cards that run the model",
      subTitle: freeTitle});

  const measuredPower = hw.measured_power != null;
  $("slt-all-power").textContent = measuredPower ? "GPUs + CPU" : "All GPU power";
  const power = measuredPower ? hw.measured_power : hw.all_gpu_power;
  const powerHistory = measuredPower ? h.measured_power : h.all_gpu_power;
  setStat("all-power", power == null ? null : fmt(power), "W",
    measuredPower && hw.cpu_power != null
      ? `GPUs ${fmt(hw.measured_power - hw.cpu_power)} W · CPU ${fmt(hw.cpu_power)} W`
      : `${engineCount + otherGpuCards.length} NVIDIA cards · ${engineCount} in use`, powerHistory,
    undefined, {hidden: otherGpuCards.length === 0 && !measuredPower});

  const since = Number(totals && totals.since);
  const elapsed = Number.isFinite(since) ? Math.max(0, Math.floor(Date.now() / 1000 - since)) : null;
  const minutes = elapsed == null ? null : Math.floor(elapsed / 60);
  const uptime = minutes == null ? null : minutes >= 60
    ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
  const sessionSub = `${fmt(totals && totals.requests || 0)} requests · ` +
    `${fmt(totals && totals.output_tokens || 0)} tokens written`;
  setStat("session", uptime, "", sessionSub);

  // A local NUT server (STRATA_NUT_UPS) puts the UPS on the page: the state word is the headline, so a
  // power cut is visible beside the model's numbers; the volts, the load and the runtime go under it.
  const upsVars = ups || {};
  const upsNum = (key) => { const v = upsVars[key], n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : null; };
  $("slt-ups").textContent = ups && upsVars["device.model"] ? `UPS · ${String(upsVars["device.model"]).trim()}` : "UPS";
  const upsState = ups ? upsStateWords(ups["ups.status"]) : null;
  // Amber for anything that is not a healthy on-line UPS: what we know to be bad turns red, what we
  // know to be worth watching turns amber - and a word this page has never seen is worth watching.
  const upsTone = !upsState ? ""
    : UPS_DANGER.some((t) => upsState.tokens.includes(t)) ? "danger"
      : UPS_WARN.some((t) => upsState.tokens.includes(t)) || upsState.primary !== "OL" ||
        upsState.tokens.some((t) => !UPS_TOKENS[t]) ? "warn" : "";
  let upsSub = "";
  if (upsState) {
    const details = [];
    if (upsNum("ups.load") != null) details.push(`load ${fmt(upsNum("ups.load"))}%`);
    if (upsNum("input.voltage") != null) details.push(`in ${fmt(upsNum("input.voltage"))} V`);
    if (upsNum("output.voltage") != null) details.push(`out ${fmt(upsNum("output.voltage"))} V`);
    if (upsNum("battery.charge") != null) details.push(`battery ${fmt(upsNum("battery.charge"))}%`);
    if (upsNum("battery.runtime") != null) details.push(`runtime ${upsDuration(upsNum("battery.runtime"))}`);
    upsSub = [upsState.label !== upsState.word ? upsState.label : "", details.join(" · ")].filter(Boolean).join(" · ");
  }
  const upsTitle = ups ? [
    [upsVars["device.mfr"], upsVars["device.model"], upsVars["ups.serial"]]
      .map((s) => String(s || "").trim()).filter(Boolean).join(" "),
    `status ${upsVars["ups.status"] || "–"}`,
    upsVars["battery.voltage"] ? `battery ${upsVars["battery.voltage"]} V` : "",
    upsVars["ups.test.result"] ? `self-test ${upsVars["ups.test.result"]}` : "",
    [upsVars["driver.name"], upsVars["driver.version"]].filter(Boolean).join(" "),
    upsVars["driver.version.usb"] || "",
    ups.stale ? "stale" : "",
  ].filter(Boolean).join(" · ") : "";
  setStat("ups", ups ? upsState.word : null, "", upsSub, undefined, undefined,
    {hidden: !ups, tone: upsTone, cardTitle: upsTitle});

  // Forge's `session` block is the run that made today's newest request (null: none today). A Forge without the field
  // predates it; its day-wide totals are shown, labelled as such.
  const hasSession = Boolean(forge) && "session" in forge;
  const forgeChat = hasSession ? forge.session : null;
  const forgeToday = (hasSession ? forgeChat : forge && forge.today) || {};
  const forgeLast = hasSession ? forgeChat && forgeChat.last_request : forge && forge.last_request;
  $("slt-forge").textContent = hasSession ? "Forge · last run" : forge ? "Forge · today" : "Forge";
  const compact = (n) => {
    if (!Number.isFinite(Number(n))) return "?";
    const value = Number(n), abs = Math.abs(value);
    if (abs >= 1e6) return `${fmt(value / 1e6, 1)}M`;
    if (abs >= 1e3) return `${fmt(value / 1e3, abs >= 10000 ? 0 : 1)}K`;
    return fmt(value);
  };
  const tools = Number(forgeToday.tool_calls) || 0;
  const failures = Number(forgeToday.tool_failures) || 0;
  const failedPct = tools > 0 ? fmt(100 * failures / tools, 1) : "0";
  let forgeSub = `${fmt(forgeToday.compactions || 0)} compactions` +
    (Number(forgeToday.compaction_attempts_failed) > 0 ? ` (${fmt(forgeToday.compaction_attempts_failed)} failed)` : "") +
    ` · ${fmt(tools)} tools, ${failedPct}% failed · in ${compact(forgeToday.input_tokens)} / out ${compact(forgeToday.output_tokens)} tokens`;
  if (Number(forgeToday.turn_errors) > 0) forgeSub += ` · ${fmt(forgeToday.turn_errors)} errors`;
  let forgeTitle = "";
  if (forgeLast) {
    const input = fmt(forgeLast.input_tokens);
    const limit = Number(forgeLast.context_limit);
    const context = forgeLast.context_limit == null ? (input === "?" ? "" : " tokens")
      : ` / ${fmt(limit)} tokens${limit > 0 ? ` (${fmt(100 * forgeLast.input_tokens / limit, 1)}%)` : ""}`;
    forgeTitle = `${forgeLast.model || "Forge"} · last request ${input}${context}`;
  }
  if (forge && forge.stale) forgeTitle += `${forgeTitle ? " · " : ""}stale`;
  if (hasSession && !forgeChat) {
    setStat("forge", null, "", "", undefined, undefined,
      {hidden: false, cardTitle: forgeTitle, mutedValue: "No Forge run today"});
    return;
  }
  setStat("forge", forge ? fmt(forgeToday.turns || 0) : null, "turns", forgeSub,
    undefined, undefined, {hidden: !forge, cardTitle: forgeTitle});
}
function renderMonitor(live, hw, st, eng, h, last, requests, totals, kept, forge, ups, totalsReset) {
  const gpu = gpuMetricData(hw, h, updateGpuSelector(hw, st));
  const ghw = gpu.hw, gh = gpu.history, cards = gpu.cards, selected = gpu.selected;
  const engineCards = gpu.engineCards, otherCards = gpu.otherCards;
  const multi = cards.length > 1 && !selected;
  const multiEngine = engineCards.length > 1 && !selected;
  const cardName = selected ? gpu.names[cards.indexOf(selected)] || `GPU ${selected.index}` : "";
  const selectedSub = selected && !selected.inModel ? `${cardName} · not in use` : cardName;
  // model state
  // Forge: this panel sends no Load/Unload and runs no chat of its own, so Strata's
  // page-local flags (modelOp, busy, imageBusy through imageLive) have no source
  // here. The engine's own live.state drives the pills and the sentence.
  const on = live.queued > 0 ? "queued" : live.state;
  for (const b of document.querySelectorAll("#state-badges .st-badge")) {
    b.classList.toggle("on", b.dataset.s === on || b.dataset.s === live.state);
  }
  const prog = $("state-progress");
  let label = "Waiting for a request", detail = "", pct = 0;
  if (live.state === "reading") {
    label = "Reading prompt";
    prog.dataset.tone = "info";
    if (live.prompt_total) {
      pct = (100 * live.prompt_read) / live.prompt_total;
      detail = `${fmt(live.prompt_read)} / ${fmt(live.prompt_total)} tokens · ${fmt(pct)}%`;
    } else {
      detail = `${fmt(live.prompt_tokens)} tokens`;
    }
  } else if (live.state === "generating") {
    label = live.phase ? live.phase[0].toUpperCase() + live.phase.slice(1) : "Generating";
    delete prog.dataset.tone;
    pct = live.max_tokens ? Math.min(100, (100 * live.generated) / live.max_tokens) : 0;
    detail = `${fmt(live.generated)} tokens · ${fmt(live.tok_s, 1)} tok/s`;
  } else if (live.state === "unloaded") {
    label = "Unloaded";
    delete prog.dataset.tone;
    detail = "Load brings it back. A message does too.";
  } else if (last) {
    delete prog.dataset.tone;
    detail = `last: ${fmt(last.output_tokens)} tokens${last.decode_tok_s ? ` at ${fmt(last.decode_tok_s, 1)} tok/s` : ""}`;
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  $("state-bar").style.width = `${pct}%`;

  // the eight cards
  // Idle: not the last request's speed (one request is noisy) but the run's average from the server's totals
  // (token-weighted, the same figure the engine's DONE lines and Prometheus report). Live stays live.
  const avgDecode = totals && totals.decode_ms > 0 && totals.output_tokens > 0 ? totals.output_tokens / (totals.decode_ms / 1000) : null;
  const readTokens = totals ? totals.prompt_tokens - (totals.reused || 0) : 0;
  const avgPrefill = totals && totals.prompt_ms > 0 && readTokens > 0 ? readTokens / (totals.prompt_ms / 1000) : null;
  const speed = live.state === "generating" ? live.tok_s : avgDecode != null ? avgDecode : last ? last.decode_tok_s : null;
  setMetric("speed", speed == null ? null : fmt(speed, 1), "t/s",
            live.state === "generating" ? "Decode now" : avgDecode != null ? "Decode · run average" : last ? "Decode last request" : "Decode");
  const prefill = live.state !== "idle" ? live.prefill_tok_s_mean
                : avgPrefill != null ? avgPrefill : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  setMetric("prefill", prefill == null ? null : fmt(prefill), "t/s",
            live.state === "reading" ? "Prefill now" : live.state === "generating" ? "Prefill this request" : avgPrefill != null ? "Prefill · run average" : last ? "Prefill last request" : "Prefill");
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s_mean);
  // a model split across several cards (issue #112): the cards show their total / mean / hottest, and each card's own
  const loadLine = multi ? allGpuLine(engineCards, otherCards, (g) => g.util,
    (g) => g.util == null ? "–" : `${fmt(g.util)}%`) : null;
  setMetric("gpu", ghw.gpu_util == null ? null : fmt(ghw.gpu_util), "%",
            selected ? selectedSub : multi ? loadLine.text : st.gpu_name || (st.gpu_note ? "not available" : ""),
            {hidden: ghw.gpu_util == null && ghw.gpu_mem_used == null && ghw.gpu_temp == null && ghw.gpu_power == null});
  if (loadLine) $("ms-gpu").title = loadLine.title;
  spark("sp-gpu", selected ? gh.util : h.gpu_util, 100);

  const vramLine = multi ? allGpuLine(engineCards, otherCards, (g) => g.mem_used,
    (g) => g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`) : null;
  setMetric("vram", ghw.gpu_mem_used == null ? null : gb(ghw.gpu_mem_used),
            ghw.gpu_mem_total ? `/ ${gb(ghw.gpu_mem_total, 0)} GB` : "GB",
            selected ? selectedSub : multi ? vramLine.text
              : eng.expert_slots ? `${fmt(eng.expert_slots)} experts cached` : (st.gpu_note ? "not available on Windows AMD yet" : ""),
            {hidden: ghw.gpu_mem_used == null && ghw.gpu_mem_total == null});
  if (vramLine) $("ms-vram").title = vramLine.title;
  spark("sp-vram", selected ? gh.mem_used : h.gpu_mem_used, ghw.gpu_mem_total);

  const tempLine = multi ? allGpuLine(engineCards, otherCards, (g) => g.temp,
    (g) => g.temp == null ? "–" : `${fmt(g.temp)}°`) : null;
  setMetric("temp", ghw.gpu_temp == null ? null : fmt(ghw.gpu_temp), "°C",
            selected ? selectedSub : multi ? tempLine.text : "", {hidden: ghw.gpu_temp == null});
  if (tempLine) $("ms-temp").title = tempLine.title;
  spark("sp-temp", selected ? gh.temp : h.gpu_temp, 90, true);

  const powerLine = multi ? allGpuLine(engineCards, otherCards, (g) => g.power,
    (g) => g.power == null ? "–" : `${fmt(g.power)} W`) : null;
  setMetric("power", ghw.gpu_power == null ? null : fmt(ghw.gpu_power), "W",
            selected ? !selected.inModel ? selectedSub : ghw.gpu_power_limit == null ? "" : `of ${fmt(ghw.gpu_power_limit)} W limit`
              : multi ? powerLine.text : ghw.gpu_power_limit ? `of ${fmt(ghw.gpu_power_limit)} W limit` : "",
            {hidden: ghw.gpu_power == null && ghw.gpu_power_limit == null});
  if (powerLine) $("ms-power").title = powerLine.title;
  const limitLine = multi ? allGpuLine(engineCards, otherCards, (g) => g.power_limit,
    (g) => g.power_limit == null ? "–" : `${fmt(g.power_limit)} W limit`) : null;
  const limits = selected
    ? (ghw.gpu_power_limit == null ? selectedSub : `${selectedSub}: ${fmt(ghw.gpu_power_limit)} W limit`)
    : multi ? limitLine.title || limitLine.text : "";
  $("ml-power").title = limits;
  spark("sp-power", selected ? gh.power : h.gpu_power, ghw.gpu_power_limit);

  const gen = ghw.gpu_pcie_gen_max || ghw.gpu_pcie_gen;
  let pcieSub = "", pcieTitle = "";
  const idle = ghw.gpu_pcie_gen && gen && ghw.gpu_pcie_gen < gen ? `idle Gen${ghw.gpu_pcie_gen}` : "";
  const hasCardPcie = engineCards.some((g) => g.pcie_rx_mb != null || g.pcie_tx_mb != null);
  if (selected) {
    pcieSub = `in ${ghw.gpu_pcie_rx_mb == null ? "–" : fmt(ghw.gpu_pcie_rx_mb, ghw.gpu_pcie_rx_mb < 10 ? 1 : 0)} MB/s` +
      ` · out ${ghw.gpu_pcie_tx_mb == null ? "–" : fmt(ghw.gpu_pcie_tx_mb, ghw.gpu_pcie_tx_mb < 10 ? 1 : 0)} MB/s`;
    if (!selected.inModel) pcieSub += " · not in use";
    pcieTitle = "in = host to GPU, out = GPU to host";
  } else if (multiEngine && hasCardPcie) {
    const rates = (g) => `${g.pcie_rx_mb == null ? "–" : fmt(g.pcie_rx_mb, g.pcie_rx_mb < 10 ? 1 : 0)} in / ` +
      `${g.pcie_tx_mb == null ? "–" : fmt(g.pcie_tx_mb, g.pcie_tx_mb < 10 ? 1 : 0)} out`;
    const rows = engineCards.map((g) => ({gpu: g, score: g.pcie_rx_mb == null && g.pcie_tx_mb == null
      ? null : (g.pcie_rx_mb || 0) + (g.pcie_tx_mb || 0), text: `GPU ${g.index}: ${rates(g)}`}));
    const full = rows.map((row) => `${row.text} MB/s`).join(" · ");
    if (engineCards.length <= 3) {
      pcieSub = `${rows.map((row) => row.text).join(" · ")} MB/s`;
      pcieTitle = "in = host to GPU, out = GPU to host";
    } else {
      const busiest = rows.filter((row) => Number.isFinite(row.score)).reduce(
        (best, row) => !best || row.score > best.score ? row : best, null);
      pcieSub = busiest ? `${engineCards.length} cards · busiest GPU ${busiest.gpu.index}: ${rates(busiest.gpu)} MB/s`
                         : `${engineCards.length} cards`;
      pcieTitle = `${full} · in = host to GPU, out = GPU to host`;
    }
  } else {
    // One card, or several without per-card PCIe readings: the aggregate wording.
    pcieSub = ghw.gpu_pcie_rx_mb == null ? ""
      : `to GPU ${fmt(ghw.gpu_pcie_rx_mb, ghw.gpu_pcie_rx_mb < 10 ? 1 : 0)} MB/s`;
  }
  if (idle) pcieSub += `${pcieSub ? " · " : ""}${idle}`;
  const noPcieSource = gen == null && ghw.gpu_pcie_rx_mb == null && ghw.gpu_pcie_tx_mb == null;
  setMetric("pcie", gen ? `Gen${gen}` : null, ghw.gpu_pcie_width ? `x${ghw.gpu_pcie_width}` : "", pcieSub,
            {hidden: noPcieSource});
  $("ms-pcie").title = pcieTitle;
  spark("sp-pcie", selected ? gh.pcie_rx_mb : h.gpu_pcie_rx_mb);
  const cpuSensors = hw.cpu_power == null ? "" : `${fmt(hw.cpu_power, 1)} W package`;
  const cpuThreads = st.threads ? `${st.cores ? `${st.cores} cores · ` : ""}${st.threads} threads` : "";
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", cpuSensors || cpuThreads,
            {hidden: hw.cpu == null && hw.cpu_power == null && !st.threads});
  $("ms-cpu").title = cpuSensors && cpuThreads ? cpuThreads : "";
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : "needs psutil (setup installs it)",
              {hidden: !st.psutil});
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0), big ? "GB/s" : "MB/s",
              hw.disk_write_mb == null ? "" : `write ${fmt(hw.disk_write_mb, 1)} MB/s`);
  }
  spark("sp-disk", h.disk_read_mb);

  // context fill: the running request, else the last one
  const ctx = eng.max_context || 0;
  let used = 0;
  if (live.state !== "idle") used = (live.prompt_tokens || 0) + (live.generated || 0);
  else if (last) used = (last.prompt_tokens || 0) + (last.output_tokens || 0);
  const frac = ctx ? Math.min(1, used / ctx) : 0;
  $("ctx-fill").setAttribute("stroke-dasharray", `${(235.6 * frac).toFixed(1)} 314.2`);
  $("ctx-fill").style.opacity = 235.6 * frac >= 3 ? "1" : "0";         // a near-zero arc would draw just its round cap
  $("ctx-pct").textContent = `${Math.round(frac * 100)}%`;
  $("ctx-sub").textContent = ctx ? `${kfmt(used)} / ${ctxfmt(ctx)}` : "–";
  const cacheBytes = (eng.expert_cache_mib || 0) * 1048576;
  $("slots-text").textContent = eng.expert_slots ? `${fmt(eng.expert_slots)} · ${gb(cacheBytes)} GB` : "–";
  $("slots-bar").style.width = hw.gpu_mem_total ? `${Math.min(100, (100 * cacheBytes) / hw.gpu_mem_total)}%` : "0%";
  $("ram-text").textContent = hw.ram_total ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = hw.ram_total ? (100 * hw.ram_used) / hw.ram_total : 0;
  $("ram-bar").style.width = `${ramPct}%`;
  if (ramPct > 92) $("ram-progress").dataset.tone = "danger"; else delete $("ram-progress").dataset.tone;
  $("temp-text").textContent = hw.gpu_temp == null ? "–" : `${fmt(hw.gpu_temp)} °C`;
  $("temp-bar").style.width = hw.gpu_temp == null ? "0%" : `${Math.min(100, hw.gpu_temp)}%`;
  $("cpu-temp-text").textContent = hw.cpu_temp == null ? "–" : `${fmt(hw.cpu_temp)} °C`;
  $("cpu-temp-bar").style.width = hw.cpu_temp == null ? "0%" : `${Math.min(100, hw.cpu_temp)}%`;

  // recent requests
  const body = $("req-body");
  const visibleRequests = reqClearedAfter == null ? requests : requests.filter((r) => r.time > reqClearedAfter);
  if (!visibleRequests.length) {
    body.innerHTML = `<tr><td colspan="10" class="muted">${reqClearedAfter == null ? "No requests yet" : "Cleared. New requests will appear here (refresh to see all)"}</td></tr>`;
  } else {
    const badge = {stop: ["", "Done"], length: ["", "Max tokens"], cancel: ["st-badge--queued", "Stopped"],
                   disconnect: ["st-badge--queued", "Closed"], error: ["st-badge--error", "Error"],
                   timeout: ["st-badge--queued", "Timeout"]};
    body.innerHTML = visibleRequests.slice(0, reqShowAll ? visibleRequests.length : 12).map((r) => {
      const [cls, text] = badge[r.finish] || ["", r.finish || "–"];
      const t = new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const proj = r.projection == null ? "" : ` <span class="st-badge${r.projection ? " st-badge--reading" : ""}" title="experimental speed projection ${r.projection ? "on" : "off"}">${r.projection ? "ESP" : "stock"}</span>`;
      // #588: the VRAM share; the PCIe share (--pcie-frac) beside it when there is one
      const hit = r.hit_rate == null ? "–" : `${(r.hit_rate * 100).toFixed(1)}%` +
        (r.pcie_share ? ` <span class="muted" title="routed experts the GPU read over PCIe (--pcie-frac) or another GPU computed">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
      const prefill = r.prompt_ms == null ? "–" : `${fmt(r.prompt_ms / 1000, 1)} s`;
      const drafts = Number.isFinite(r.drafts_offered) && r.drafts_offered > 0 && Number.isFinite(r.drafts_accepted)
        ? `${fmt(100 * r.drafts_accepted / r.drafts_offered, 1)}%` : "–";
      const draftTitle = drafts === "–" ? "No draft tokens offered"
        : `${fmt(r.drafts_accepted)} accepted / ${fmt(r.drafts_offered)} offered`;
      return `<tr><td>${esc(t)}</td><td><span class="st-badge ${cls}">${esc(text)}</span>${proj}</td><td class="num">${fmt(r.prompt_tokens)}</td>
        <td class="num">${fmt(r.reused)}</td>
        <td class="num" title="time spent reading the new prompt tokens">${prefill}</td>
        <td class="num">${fmt(r.output_tokens)}</td><td class="num">${fmt(r.decode_tok_s, 1)}</td>
        <td class="num" title="${draftTitle}">${drafts}</td>
        <td class="num">${hit}</td><td class="num">${fmt(r.duration_s, 1)} s</td></tr>`;
    }).join("");
  }
  const all = $("req-all");
  kept = reqClearedAfter == null ? (kept == null ? requests.length : kept) : visibleRequests.length;
  all.hidden = kept <= 12;
  all.textContent = reqShowAll ? "Show fewer" : `Show all (${kept})`;
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(totals);
  renderStats(eng, hw, st, h, visibleRequests, totals, forge, ups, totalsReset);
}

function facts(el, rows) {
  el.innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v, copy]) =>
    `<dt>${esc(k)}</dt><dd>${copy ? `<code>${esc(v)}</code><button class="st-btn st-btn--icon" data-copy="${esc(v)}" aria-label="Copy">${icon("copy")}</button>` : esc(v)}</dd>`).join("");
}

$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); });
// Forge: Strata's Clear also POSTs metrics/reset to its own server and re-polls.
// The host owns the fetch here, so the button keeps only what it does to this
// view: the client-side cutoff (reqClearedAfter) that hides the rows already shown.
$("req-clear").addEventListener("click", () => {
  const rows = lastMetrics && Array.isArray(lastMetrics.requests) ? lastMetrics.requests : [];
  reqClearedAfter = rows.length ? Math.max(...rows.map((r) => r.time)) : Date.now() / 1000;
  if (lastMetrics) render(lastMetrics);
});
