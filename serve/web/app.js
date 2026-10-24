// serve/web/app.js - the Strata web app: Chat, Monitor, About. No framework, no network beyond this server.
// The Monitor tab rebuilds PR #22's dashboard idea (code-martin) on the server's own /metrics.
"use strict";

const $ = (id) => document.getElementById(id);
// the sprite symbols are inlined into the page by the server (serve/server.py, _page_bytes), so a reference is
// same-document and the file is never requested - it used to be re-fetched as new icons appeared while output
// streamed.  Empty on purpose: the "#" in icon() is the whole path.
const SPRITE = "";
const icon = (name, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, {maximumFractionDigits: d, minimumFractionDigits: d}));
const kfmt = (n) => (n == null ? "–" : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n));
// a context size: 32768 -> "32K" (powers of two), else like kfmt
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));   // memory: binary GB, as Windows shows it

const store = {
  get(k, d) { try { const v = localStorage.getItem("strata." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("strata." + k, JSON.stringify(v)); } catch (e) { /* private mode: in memory only */ } },
};

// ------------------------------------------------------------------ toasts
function toast(kind, title, text = "", ms = 3500, action = null) {
  const names = {info: "info", success: "check", warn: "warning", error: "error"};
  const el = document.createElement("div");
  el.className = `st-toast st-toast--${kind}`;
  el.innerHTML = `${icon(names[kind] || "info")}<div><div class="st-toast__title"></div><div class="t-text"></div></div>`;
  el.querySelector(".st-toast__title").textContent = title;
  el.querySelector(".t-text").textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.className = "st-btn st-btn--secondary";
    b.style.height = "32px";
    b.style.marginLeft = "auto";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function copyText(text, btn, title = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {                                   // http on another host: no async clipboard
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const use = btn.querySelector("use");
    use.setAttribute("href", `${SPRITE}#i-check`);
    setTimeout(() => use.setAttribute("href", `${SPRITE}#i-copy`), 1500);
  }
  toast("success", title, "", 1800);
}

// ------------------------------------------------------------------ theme and tabs
// the system's theme until the user picks one (only a click is saved)
function setTheme(t, save) {
  document.documentElement.dataset.theme = t;
  if (save) try { localStorage.setItem("strata.theme", t); } catch (e) { /* ignore */ }
  $("theme-icon").setAttribute("href", `${SPRITE}#i-${t === "dark" ? "sun" : "moon"}`);
  $("dark-toggle").setAttribute("aria-checked", String(t === "dark"));
}
const flipTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
$("theme-btn").onclick = flipTheme;
$("dark-toggle").onclick = flipTheme;
setTheme(document.documentElement.dataset.theme || "light", false);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let saved = null;
  try { saved = localStorage.getItem("strata.theme"); } catch (err) { /* ignore */ }
  if (!saved) setTheme(e.matches ? "dark" : "light", false);
});

let tab = "chat";
function showTab(name) {
  tab = ["chat", "monitor", "about"].includes(name) ? name : "chat";
  for (const b of document.querySelectorAll(".st-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of ["chat", "monitor", "about"]) $(`view-${v}`).hidden = v !== tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", tab === "chat" ? location.pathname : `#${tab}`);
  if (tab === "chat") $("input").focus();
  if (tab === "monitor") loadMcp();
  if (tab === "about") loadConfig();
  if (lastMetrics) render(lastMetrics);
  pollNow();                       // the tab we just moved to wants its own kind of answer now (?lite vs full)
}
for (const b of document.querySelectorAll(".st-tab")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------------ server access
function headers(json = false) {
  const h = {};
  const key = store.get("apikey", "");
  if (key) h.Authorization = "Bearer " + key;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
$("api-key").value = store.get("apikey", "");
$("api-key").onchange = () => { store.set("apikey", $("api-key").value.trim()); toast("success", "API key saved", "Kept in this browser only."); };

let health = {model: "strata", images: false, max_context: 0};
async function loadHealth() {
  try {
    health = await (await fetch("health")).json();
    $("attach-btn").title = health.images ? "Attach a text file or a picture (or drop it here)"
                                          : "Attach a text file (or drop it here)";
    $("chat-empty-sub").textContent = `${health.model} runs on this PC. Nothing leaves it.`;
  } catch (e) {
    setTimeout(loadHealth, 2000);
  }
}

// ------------------------------------------------------------------ Monitor
const METRICS = [
  {key: "speed", label: "Speed", icon: "gauge", unit: "t/s", series: "tok_s"},
  {key: "gpu", label: "GPU load", icon: "gpu", unit: "%", series: "gpu_util", max: 100},
  {key: "vram", label: "VRAM", icon: "layers", unit: "GB", series: "gpu_mem_used"},
  {key: "temp", label: "GPU temp", icon: "thermometer", unit: "°C", series: "gpu_temp", tone: "warn"},
  {key: "power", label: "Power", icon: "bolt", unit: "W", series: "gpu_power"},
  {key: "pcie", label: "PCIe", icon: "link", unit: "", series: "gpu_pcie_rx_mb", tone: "info"},
  {key: "cpu", label: "CPU", icon: "cpu", unit: "%", series: "cpu", max: 100},
  {key: "disk", label: "Disk read", icon: "disk", unit: "MB/s", series: "disk_read_mb", tone: "info"},
];
$("metrics").innerHTML = METRICS.map((m) => `
  <div class="st-card metric-card"><div class="st-metric">
    <span class="st-metric__label">${icon(m.icon, "st-icon st-icon--sm")}${esc(m.label)}</span>
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
  </div></div>`).join("");

function spark(id, values, max) {
  const svg = $(id);
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  const top = Math.max(max || 0, ...v, 1);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}
function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
}

let lastMetrics = null, metricsFailures = 0, keyWarned = false, mcpTick = 0;
let reqShowAll = false;   // the Monitor's request table: the last 12, or every one the server keeps (issue #35)
// todo #metrics-lite: /metrics is 7,317 bytes and the Chat tab shows none of it but the header pill, which reads about
// 256 bytes of it.  So: ask for ?lite=1 off the Monitor and About tabs, and go quiet when nothing is happening
// or the window is in another tab.  Measured before the change: one full poll a second whatever the tab and
// whether the page was even visible - about 26 MB an hour per open tab, and the server rebuilt the telemetry
// snapshot and re-read the engine log to do it.
const POLL_FULL_MS = 1000, POLL_LIVE_MS = 1000, POLL_IDLE_MS = 15000, POLL_HIDDEN_MS = 60000;
const ACTIVE_STATES = ["reading", "generating", "running-tool", "queued"];
function pollUrl() {
  if (tab === "monitor") return reqShowAll ? "metrics?requests=all" : "metrics";
  // About draws three blocks: engine facts and the two hardware ones. It has no sparklines, no request table
  // and no conversation cache, so it asks for lite plus hardware rather than the whole answer (todo #metrics-lite).
  if (tab === "about") return "metrics?lite=1&hw=1";
  return "metrics?lite=1";          // the Chat tab: the pill and the projection flag, nothing else
}
function pollDelay(m) {
  if (document.hidden) return POLL_HIDDEN_MS;                    // another window: nothing here is being seen
  if (tab === "monitor") return POLL_FULL_MS;                    // the cards and sparklines need their own cadence
  if (busy || (m && ACTIVE_STATES.includes(m.live && m.live.state))) return POLL_LIVE_MS;
  return POLL_IDLE_MS;                                           // idle: the pill has nothing new to say
}
// one scheduler, so a fresh poll can always cancel the pending one: storing the handle is what makes
// pollNow() mean "now" instead of "and also a second chain from here on"
let pollTimer = null;
function schedulePoll(delay) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, delay); }
function pollNow() { schedulePoll(0); }
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollNow(); });

// Hovering the Monitor tab fetches the full answer before the click, so its cards paint at once instead of
// appearing a second later. Only Monitor needs this: Chat and About already poll their own tiers, so their
// data is at most one interval old when you land on them.
// The guard is a throttle, not a debounce: at most one hover fetch per second, so a mouse crossing the tab
// bar cannot stack requests, and the first hover fires at once rather than after a delay. It runs outside
// the poll scheduler, so it cannot fork a second chain (the bug item 40 had to fix).
const HOVER_THROTTLE_MS = 1000;
let lastHoverFetch = 0;
function prefetchFull() {
  fetch("metrics", {headers: headers()})
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => { if (m) lastMetrics = m; })
    .catch(() => {});                          // a failed prefetch is not a failure of anything
}
function hoverTab(name) {
  if (name !== "monitor" || tab === "monitor") return;
  const now = Date.now();
  if (now - lastHoverFetch <= HOVER_THROTTLE_MS) return;
  lastHoverFetch = now;
  prefetchFull();
}
for (const b of document.querySelectorAll(".st-tab")) {
  b.addEventListener("mouseenter", () => hoverTab(b.dataset.tab));
}
async function poll() {
  try {
    const r = await fetch(pollUrl(), {headers: headers()});
    if (r.status === 401) {
      setPill("error", "API key needed");
      if (!keyWarned) { keyWarned = true; toast("warn", "API key needed", "This server needs a key: add it under About > Settings.", 6000); }
    } else if (r.ok) {
      const m = await r.json();
      metricsFailures = 0;
      // a lite answer has no sparklines, request table or cache in it: paint what it does carry, and merge it
      // into the last full answer so a switch to the Monitor paints at once
      if (m.lite) { lastMetrics = {...(lastMetrics || {}), ...m}; renderLite(m); }
      else { lastMetrics = m; render(m); }
      schedulePoll(pollDelay(m));
      if (tab === "monitor" && ++mcpTick % 10 === 0) loadMcp();   // server states change rarely: every 10 s
      return;
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    if (++metricsFailures === 3) setPill("error", "Server not reachable");
  }
  schedulePoll(pollDelay(lastMetrics));
}
// the header pill on its own, which is all a lite answer carries
function renderPill(m) {
  const live = m.live || {};
  if (live.state === "reading") {
    const pct = live.prompt_total ? Math.round((100 * live.prompt_read) / live.prompt_total) : null;
    setPill("reading", pct != null ? `Reading prompt · ${pct}%` : "Reading prompt");
  } else if (live.state === "generating") {
    setPill("generating", `Generating · ${fmt(live.tok_s, 1)} tok/s`);
  } else if (live.state === "running-tool") {
    // "reading", not "generating": the palette makes colour one decision per state - the engine produces no
    // tokens while a tool runs, exactly as while a prompt is being read, so both are --st-info blue
    // (components.css:20-21). The Monitor's badge and state card already said blue; the pill was the outlier.
    setPill("reading", `Waiting · ${live.tool || "a tool"}`);   // todo #waiting-state: an MCP call running is not idle
  } else {
    setPill("idle", "Idle");
  }
  if (live.queued > 0) setPill("queued", `${live.queued} queued`);
}

// what a lite answer can paint: always the pill, and About's cards when the answer asked for them (?lite=1&hw=1).
// It has no sparkline history, no request table and no conversation cache, so the Monitor never asks for lite.
function renderLite(m) {
  renderPill(m);
  if (m.hardware) renderAbout(m.engine || {}, m.hardware, m.hardware_static || {});
}
function setPill(state, text) {
  $("pill").dataset.state = state === "error" ? "queued" : state;
  $("pill-text").textContent = text;
}

function render(m) {
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];
  renderPill(m);                                    // one place decides what the pill says (also used by ?lite)
  if (tab === "monitor") renderMonitor(live, hw, st, eng, h, last, m.requests || [], m.totals, m.requests_kept);
  if (tab === "monitor") renderConvCache(m.conversation_cache);
  if (tab === "about") renderAbout(eng, hw, st);
}

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
function renderMonitor(live, hw, st, eng, h, last, requests, totals, kept) {
  // model state
  const on = live.queued > 0 ? "queued" : live.state;
  for (const b of document.querySelectorAll("#state-badges .st-badge")) b.classList.toggle("on", b.dataset.s === on || b.dataset.s === live.state);
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
  } else if (live.state === "running-tool") {
    label = `Waiting · ${live.tool || "a tool call"}`;
    prog.dataset.tone = "info";                    // the engine is not producing tokens right now
    pct = 0;
    detail = live.elapsed_s != null ? `${fmt(live.elapsed_s, 1)} s into this turn` : "running";
  } else if (live.state === "generating") {
    label = live.phase ? live.phase[0].toUpperCase() + live.phase.slice(1) : "Generating";
    delete prog.dataset.tone;
    pct = live.max_tokens ? Math.min(100, (100 * live.generated) / live.max_tokens) : 0;
    detail = `${fmt(live.generated)} tokens · ${fmt(live.tok_s, 1)} tok/s`;
  } else if (last) {
    delete prog.dataset.tone;
    detail = `last: ${fmt(last.output_tokens)} tokens${last.decode_tok_s ? ` at ${fmt(last.decode_tok_s, 1)} tok/s` : ""}`;
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  $("state-bar").style.width = `${pct}%`;

  // the eight cards
  const speed = live.state === "generating" ? live.tok_s : last ? last.decode_tok_s : null;
  setMetric("speed", speed == null ? null : fmt(speed, 1), "t/s",
            live.state === "generating" ? "Decode now" : last ? "Decode last request" : "Decode");
  const prefill = live.state !== "idle" ? live.prefill_tok_s_mean
                : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  setMetric("prefill", prefill == null ? null : fmt(prefill), "t/s",
            live.state === "reading" ? "Prefill now" : live.state === "generating" ? "Prefill this request" : last ? "Prefill last request" : "Prefill");
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s_mean);
  // a model split across several cards (issue #112): the cards show their total / mean / hottest, and each card's own
  const per = (f) => (hw.gpus || []).map((g) => `GPU ${g.index} ${f(g)}`).join(" · ");
  const multi = (hw.gpus || []).length > 1;
  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%",
            multi ? per((g) => (g.util == null ? "–" : `${fmt(g.util)}%`)) : st.gpu_name || (st.gpu_note ? "not available" : ""));
  spark("sp-gpu", h.gpu_util, 100);
  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
            multi ? per((g) => (g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`))
                  : eng.expert_slots ? `${fmt(eng.expert_slots)} experts cached` : (st.gpu_note ? "not available on Windows AMD yet" : ""));
  spark("sp-vram", h.gpu_mem_used, hw.gpu_mem_total);
  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C",
            multi ? per((g) => (g.temp == null ? "–" : `${fmt(g.temp)}°`)) : "");
  spark("sp-temp", h.gpu_temp, 90);
  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W", hw.gpu_power_limit ? `of ${fmt(hw.gpu_power_limit)} W limit` : "");
  spark("sp-power", h.gpu_power, hw.gpu_power_limit);
  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
            hw.gpu_pcie_rx_mb == null ? "" : `to GPU ${fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)} MB/s` +
            (hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? ` · idle Gen${hw.gpu_pcie_gen}` : ""));
  spark("sp-pcie", h.gpu_pcie_rx_mb);
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", st.threads ? `${st.cores ? `${st.cores} cores · ` : ""}${st.threads} threads` : "");
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : "needs psutil (setup installs it)");
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

  // recent requests
  const body = $("req-body");
  if (!requests.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted">No requests yet</td></tr>`;
  } else {
    const badge = {stop: ["", "Done"], length: ["", "Max tokens"], cancel: ["st-badge--queued", "Stopped"],
                   disconnect: ["st-badge--queued", "Closed"], error: ["st-badge--error", "Error"]};
    body.innerHTML = requests.slice(0, reqShowAll ? requests.length : 12).map((r) => {
      const [cls, text] = badge[r.finish] || ["", r.finish || "–"];
      const t = new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const proj = r.projection == null ? "" : ` <span class="st-badge${r.projection ? " st-badge--reading" : ""}" title="experimental speed projection ${r.projection ? "on" : "off"}">${r.projection ? "ESP" : "stock"}</span>`;
      // #588: the VRAM share; the PCIe share (--pcie-frac) beside it when there is one
      const hit = r.hit_rate == null ? "–" : `${(r.hit_rate * 100).toFixed(1)}%` +
        (r.pcie_share ? ` <span class="muted" title="routed experts the GPU read over PCIe (--pcie-frac) or another GPU computed">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
      // Reused tokens are not prefetched again. Match the Monitor's existing Prefill metric.
      const fresh = r.prompt_tokens == null ? null : Math.max(0, r.prompt_tokens - (r.reused || 0));
      const prefillRate = fresh > 0 && r.prompt_ms > 0 ? fresh / (r.prompt_ms / 1000) : null;
      return `<tr><td>${esc(t)}</td><td><span class="st-badge ${cls}">${esc(text)}</span>${proj}</td><td class="num">${fmt(r.prompt_tokens)}</td>
        <td class="num">${fmt(r.reused)}</td><td class="num">${fmt(r.output_tokens)}</td><td class="num">${fmt(prefillRate)}</td><td class="num">${fmt(r.decode_tok_s, 1)}</td>
        <td class="num">${hit}</td><td class="num">${fmt(r.duration_s, 1)} s</td></tr>`;
    }).join("");
  }
  const all = $("req-all");
  kept = kept == null ? requests.length : kept;
  all.hidden = kept <= 12;
  all.textContent = reqShowAll ? "Show fewer" : `Show all (${kept})`;
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(totals);
}

function facts(el, rows) {
  el.innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v, copy]) =>
    `<dt>${esc(k)}</dt><dd>${copy ? `<code>${esc(v)}</code><button class="st-btn st-btn--icon" data-copy="${esc(v)}" aria-label="Copy">${icon("copy")}</button>` : esc(v)}</dd>`).join("");
}
// INFO cvec=project:4-44[:singleL] | add:A-B | 0
function projectionText(c) {
  if (!c || c === "0" || c === 0) return null;
  const [mode, range, single] = String(c).split(":");
  const [a, b] = (range || "").split("-");
  return `${mode === "project" ? "Projection" : "Additive"} control vector on layers ${a}–${b}` +
         `${single ? ` (layer ${single.replace("single", "")}'s direction)` : ""}. Per chat in Sampling. Its package ` +
         "describes the vector as a refusal-direction projection; measure the speed yourself";
}
function renderAbout(eng, hw, st) {
  const kv = {int8: "8-bit", q4_0: "4-bit (Hadamard-rotated)", fp16: "16-bit"}[eng.kv] || eng.kv;
  facts($("facts-engine"), [
    ["Model", eng.model],
    ["Engine", eng.version ? `v${eng.version}` : "built from source"],
    ["Context", eng.max_context ? `${fmt(eng.max_context)} tokens` : null],
    ["KV cache", kv ? `${kv}${eng.kv_resident ? `, streamed: ${fmt(eng.kv_resident)} positions per layer in VRAM, the rest in RAM` : ", all in VRAM"}` : null],
    ["Experts in VRAM", eng.expert_slots ? `${fmt(eng.expert_slots)} (${gb((eng.expert_cache_mib || 0) * 1048576)} GB)` : null],
    ["Speculation", eng.spec ? `MTP drafts up to ${Math.max(0, (eng.mtp_max || eng.spec) - 1)} tokens${eng.lookup ? ", prompt lookup on" : ""}` : null],
    ["Images", eng.images ? "on" : "off"],
    ["Experimental speed projection", projectionText(eng.cvec)],
  ]);
  facts($("facts-hw"), [
    ["GPU", st.gpu_name ? `${st.gpu_name}${hw.gpu_mem_total ? `, ${gb(hw.gpu_mem_total, 0)} GB` : ""}` : (st.gpu_note || "not readable (NVML)")],
    ["CPU", st.cpu_name ? `${st.cpu_name}${st.threads ? `, ${st.threads} threads` : ""}` : null],
    ["RAM", hw.ram_total ? `${gb(hw.ram_total, 0)} GB` : null],
  ]);
  const base = location.origin;
  facts($("facts-api"), [
    ["OpenAI base URL", `${base}/v1`, true],
    ["Anthropic base URL", base, true],
    ["Model name", eng.model, true],
  ]);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.dataset.copy, b);
});
$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); });

// ------------------------------------------------------------------ MCP servers (GET /mcp)
// Tools from the MCP servers in the run config: the chat offers them to the model (opt-in per request,
// "strata_mcp": true, which only this page sends); the Monitor lists the servers and what they offer.
let mcpInfo = {servers: [], tools: 0}, mcpRetry = null;
async function loadMcp() {
  try {
    const r = await fetch("mcp", {headers: headers()});
    if (!r.ok) return;
    mcpInfo = await r.json();
  } catch (e) { return; /* an older server: no MCP */ }
  renderMcp();
  clearTimeout(mcpRetry);                          // right after the start, servers may still be starting (npx downloads)
  if ((mcpInfo.servers || []).some((s) => s.status === "starting")) mcpRetry = setTimeout(loadMcp, 3000);
}
const MCP_STATE = {ready: ["st-badge--generating", "Connected"], starting: ["st-badge--reading", "Starting"],
                   failed: ["st-badge--error", "Failed"], stopped: ["st-badge--queued", "Stopped"], idle: ["", "Waiting"]};
function renderMcp() {
  const servers = mcpInfo.servers || [];
  $("mcp-card").hidden = !servers.length;
  $("mcp-row").hidden = !servers.length;
  const ready = servers.filter((s) => s.status === "ready" || s.status === "stopped");
  $("mcp-sum").textContent = servers.length ? `${fmt(mcpInfo.tools)} tools · ${ready.length} of ${servers.length} servers connected` : "";
  $("mcp-row-sub").textContent = mcpInfo.tools ? `${fmt(mcpInfo.tools)} tools from ${ready.map((s) => s.name).join(", ")}; the model calls them when it decides to`
                                               : "no server is connected yet (see the Monitor)";
  $("mcp-list").innerHTML = servers.map((s) => {
    const [cls, text] = MCP_STATE[s.status] || ["", s.status];
    const info = s.info && s.info.name ? ` · ${s.info.name}${s.info.version ? ` ${s.info.version}` : ""}` : "";
    return `<div class="mcp-server"><div class="mcp-server__head"><span class="st-badge ${cls}">${esc(text)}</span>` +
      `<strong>${esc(s.name)}</strong><span class="muted small">${esc(s.transport)} · ${fmt(s.tools.length)} tools${esc(info)}</span></div>` +
      (s.error ? `<div class="msg-error">${esc(s.error)}</div>` : "") +
      (s.tools.length ? `<div class="mcp-server__tools">${s.tools.map((t) => `<span class="chip" title="${esc(t.description || "")}">${esc(t.tool)}</span>`).join("")}</div>` : "") +
      `</div>`;
  }).join("");
}

// ------------------------------------------------------------------ Model settings (GET / POST /config, #564)
// A few documented keys of the run config (strata-<model>.json), for every client, from the next start on.  The
// server lists them, checks every value and keeps every other key of the file as it is.
let cfgKeys = [];
async function loadConfig() {
  let r;
  try { r = await fetch("config", {headers: headers()}); } catch (e) { return; }
  if (!r.ok) { $("cfg-card").hidden = true; return; }       // no run config, an older server, or no key yet
  const c = await r.json();
  cfgKeys = c.keys || [];
  $("cfg-file").textContent = c.file || "";
  $("cfg-form").innerHTML = cfgKeys.map((k, i) => {
    const id = `cfg-${i}`, v = k.value;
    let input;
    if (k.kind === "bool" || k.kind === "enum") {
      const opts = k.kind === "bool" ? [["true", "on"], ["false", "off"]] : k.choices.map((x) => [x, x]);
      const cur = v == null ? "" : String(v);
      input = `<select class="st-input" id="${id}"><option value=""${cur === "" ? " selected" : ""}>default</option>` +
        opts.map(([val, text]) => `<option value="${esc(val)}"${cur === val ? " selected" : ""}>${esc(text)}</option>`).join("") + `</select>`;
    } else {
      const text = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
      input = `<input class="st-input" id="${id}" ${k.kind === "number" ? 'type="number" step="any" min="0"' : 'type="text"'} ` +
        `value="${esc(text)}" placeholder="default" autocomplete="off">`;
    }
    return `<label for="${id}" title="${esc(k.help)}">${esc(k.help)}<code>${esc(k.key)}</code></label>${input}`;
  }).join("");
  $("cfg-card").hidden = false;
}
function configValue(k, el) {
  const s = el.value.trim();
  if (s === "") return null;
  if (k.kind === "bool") return s === "true";
  if (k.kind === "number") return Number(s);
  return s;                                         // enum, or names (the server splits them at commas)
}
$("cfg-save").addEventListener("click", async () => {
  const set = {};
  cfgKeys.forEach((k, i) => {
    const v = configValue(k, $(`cfg-${i}`));
    const old = Array.isArray(k.value) ? k.value.join(", ") : k.value;
    if (JSON.stringify(v) !== JSON.stringify(old ?? null)) set[k.key] = v;
  });
  if (!Object.keys(set).length) { $("cfg-msg").textContent = "Nothing changed."; return; }
  try {
    const r = await fetch("config", {method: "POST", headers: headers(true), body: JSON.stringify({set})});
    const b = await r.json();
    if (!r.ok) throw new Error((b.error || {}).message || `HTTP ${r.status}`);
    $("cfg-msg").textContent = b.changed.length
      ? `Saved (${b.changed.join(", ")}); the earlier file is ${b.file}.bak. Start the model again to use it.` : "Nothing changed.";
    loadConfig();
  } catch (e) {
    $("cfg-msg").textContent = "";
    toast("error", "Not saved", String(e.message || e), 6000);
  }
});

// ------------------------------------------------------------------ Markdown (escaped first, then formatted)
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[+i])}</code>`);
}
function codeBlock(lang, code) {
  return `<div class="st-code"><div class="st-code__head"><span>${esc(lang || "code")}</span>` +
    `<button class="st-btn st-btn--icon" data-code-copy aria-label="Copy code">${icon("copy")}</button></div>` +
    `<pre><code>${esc(code)}</code></pre></div>`;
}
function blocks(text) {
  const out = [], lines = text.split("\n");
  let para = [], list = null;
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flushPara(); flushList(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<${m[1].length <= 2 ? "h3" : "h4"}>${inline(m[2])}</${m[1].length <= 2 ? "h3" : "h4"}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      i--;
      out.push(html + "</tbody></table>");
      continue;
    }
    if ((m = l.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = {tag, items: []}; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out;                          // one entry per top-level element; renderBubble inserts them one by one
}
// the answer as a list of blocks rather than one string: while it streams, only the last block can change, so
// the page writes the earlier ones once and updates the last one in place (see renderBubble)
function markdownBlocks(text) {
  const out = [];
  let rest = text;
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { out.push(...blocks(rest)); break; }
    out.push(...blocks(rest.slice(0, m.index)));
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```[ \t]*(\n|$)/);
    if (!end) { out.push(codeBlock(m[2].trim(), rest)); break; }         // still streaming
    out.push(codeBlock(m[2].trim(), rest.slice(0, end.index)));
    rest = rest.slice(end.index + end[0].length);
  }
  return out;
}
// the same thing as one string.  renderBubble() does not use it - it inserts the blocks one by one so the
// settled ones keep their elements - but it is what anything else that wants the answer as HTML should call
function markdown(text) { return markdownBlocks(text).join(""); }

// ------------------------------------------------------------------ Chat
const DEFAULTS = {thinking: "high", temperature: 0.6, top_p: 0.95, top_k: 20, max: "", seed: "", show: "live", mdmine: false, mdtheirs: true, esp: true, mcp: true, mcpthink: false};
// "Show thinking" used to be four switches (show / openthink / opentools / autofold) that overlapped and
// half-contradicted each other.  They are one choice now - "folded" | "live" | "always" - and an old stored
// object still has them as booleans, so map it once on load rather than letting a saved true/false decide
// how the drawer looks.  The old default (thinking open while it streams, calls closed) had no name; it
// becomes the new default, "live".
const SHOWS = ["folded", "live", "always"];
function migrateShow(s) {
  if (SHOWS.includes(s.show)) return s;
  const out = {...s};
  out.show = s.autofold === true ? "live"                                  // the fold switch from earlier today
           : (s.openthink === true || s.opentools === true) ? "always"     // either "keep ... open" switch
           : s.show === false ? "folded"                                   // "Show thinking" off
           : DEFAULTS.show;                                                // the old default
  for (const k of ["openthink", "opentools", "autofold"]) delete out[k];
  return out;
}
let settings = {...DEFAULTS, ...migrateShow(store.get("sampling", {}))};
let attachments = [];                 // {name, url}
let busy = null;                      // {controller, msg}

// ------------------------------------------------------------------ the chat list (this browser only, opt-in)
// "strata.history" is the switch and it is off by default: with it off the page keeps one chat under
// "strata.chat" exactly as before. With it on the conversations live in IndexedDB (database "strata", store
// "chats", one record per chat), because a conversation can be several megabytes and localStorage is capped at
// about 5 MB for the whole page. The small keys - the switch and which chat is open - stay in localStorage. A
// browser that only had "strata.chat" gets it as the first record.
const TITLE_MAX = 60;
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
  if (text != null) n.textContent = text; return n; };

function newChat() {
  return {id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
          title: "", time: Date.now(), messages: []};
}
// the name in the list: what the user called it, else the first line of their first question
function chatTitle(c) {
  if (c.title) return c.title;
  const first = (c.messages.find((m) => m.role === "user") || {}).text || "";
  return first.split("\n")[0].trim().slice(0, TITLE_MAX) || "New chat";
}

// A tool block's open/closed click is display state, not conversation, and it used to be saved with the chat -
// which is why one tap pinned a call open through every reload after it.  cleanMessages drops it on the way
// out; this drops it on the way in, for records an older page already wrote.  Only the tool's open field is
// touched: a very old record that still carries a picture's data URL is left exactly as it is.
const dropToolOpen = (list) => list.map((m) => (m && m.tools ? {...m, tools: m.tools.map((t) => ({...t, open: undefined}))} : m));
const cleanMessages = (list) => list.map((m) => ({...m, images: (m.images || []).map((i) => ({name: i.name})),
                                                  files: (m.files || []).map((f) => ({name: f.name})),
                                                  tools: (m.tools || []).map((t) => ({...t, open: undefined}))}));
const cleanChat = (c) => ({...c, messages: cleanMessages(c.messages)});

let historyOn = store.get("history", false);
let chats = [], chat = null, chatId = "", db = null;
let messages = store.get("chat", []);         // off: the single chat; on: the open chat's messages
let sidebarQuery = "", sidebarOpen = true, storageWarned = false;

// the composer's text is kept per conversation: switching chats swaps it, and a reload finds it back.
// A chat that has no messages yet is keyed as "blank" instead of by its id: newChat() invents a fresh id on
// every page load and blank chats are never written to the store, so an id-keyed draft would be orphaned by a
// reload - and persisting blank chats just to keep an id stable would fill the list with empty chats. One blank
// draft is the right amount, because one blank chat is as good as another (startChat reuses the one it has).
const draftKeyOf = (id, blank) => "draft." + (blank ? "blank" : id);
const draftKey = () => draftKeyOf(chatId, !messages.length);
function saveDraft() { store.set(draftKey(), $("input").value); }
function loadDraft() { const t = store.get(draftKey(), ""); if ($("input").value !== t) { $("input").value = t; autosize(); } }

function warnStorage(text) {
  if (storageWarned) return;
  storageWarned = true;
  toast("warn", "Chat list not saved", text, 6000);
}
function openDb() {
  return new Promise((resolve) => {
    let r;
    try { r = indexedDB.open("strata", 1); } catch (e) { resolve(null); return; }      // private mode: memory only
    r.onupgradeneeded = () => { const d = r.result;
      if (!d.objectStoreNames.contains("chats")) d.createObjectStore("chats", {keyPath: "id"}); };
    // a database already at version 1 does not run onupgradeneeded, so the store may not be there
    r.onsuccess = () => resolve(r.result.objectStoreNames.contains("chats") ? r.result : null);
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);           // another tab holds an older version of the database
  });
}
function allChats() {
  return new Promise((resolve) => {
    // the result is on the request, not on the store: reading it at oncomplete gives nothing
    const req = db.transaction("chats", "readonly").objectStore("chats").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
    req.transaction.onabort = () => resolve([]);
  });
}
// a request that fails because the storage is full aborts the transaction, so it fires abort rather than error
function onQuota(t) {
  const warn = () => warnStorage(t.error && t.error.name === "QuotaExceededError"
    ? "This browser cannot keep more; the chats on the screen are still there."
    : "The chat list could not be saved; the chats on the screen are still there.");   // a transaction also aborts on a bad record or an I/O error
  t.onerror = warn; t.onabort = warn;
}
// one record per chat: rewriting the whole list for one message is wasteful when a chat is megabytes.
// Another tab's writes do not show up here until that page is reloaded - there is no event for them.
function writeChat(c) {                           // the record only; the caller renders the list once
  if (!db) return;
  const t = db.transaction("chats", "readwrite");
  t.objectStore("chats").put(cleanChat(c));
  onQuota(t);
}
function dropRecord(c) {
  if (!db) return;
  const t = db.transaction("chats", "readwrite");
  t.objectStore("chats").delete(c.id);
  onQuota(t);
}
function putChat(c) { writeChat(c); renderSidebar(); }   // memory only: the change still has to show
function dropChat(c) { dropRecord(c); renderSidebar(); }

// turning the switch on: the chat on the screen becomes the first record. Only when the switch is flipped in
// this session: on a page load the list is the list, so a fresh chat stays empty and "strata.chat" is read once,
// when the store is empty.
async function openHistory(fromScreen) {
  db = await openDb();
  chats = db ? await allChats() : [];
  // a tool block's open/closed click is display state, not conversation, and an older page saved it with the
  // chat (see dropToolOpen).  Stripped where the records arrive, in place: the array from getAll is ours.
  for (const c of chats) c.messages = dropToolOpen(c.messages || []);
  if (!chats.length) {
    const old = fromScreen ? messages : dropToolOpen(store.get("chat", []));   // the single chat from before the sidebar
    if (old.length) {
      const c = {...newChat(), messages: old, time: old[old.length - 1].time || Date.now()};
      chats = [c];
      if (db) putChat(c);                                   // the migrated chat is a record like the others
    }
  }
  chat = chats.find((c) => c.id === store.get("chatId", "")) || chats[0] || newChat();
  if (!chats.includes(chat)) chats.push(chat);
  chatId = chat.id;
  messages = chat.messages;
  if (!store.get(draftKey(), "")) saveDraft();      // text typed before the store opened belongs to this chat
  loadDraft();
  if (!db) warnStorage("This browser will not keep IndexedDB; the list lives in memory until the page is closed.");
}

function saveChat(c = chat) {
  if (!historyOn) { store.set("chat", cleanMessages(messages)); return; }   // off: one chat, as before
  c.time = Date.now();
  putChat(c);                                       // the chat that owns the turn, which may not be the open one
}
function timeStr(t) { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

function groupName(t) {
  const days = Math.floor((Date.now() - t) / 86400000);
  if (!days) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}
function chatItem(c) {
  const t = chatTitle(c);
  // a turn answering in a conversation you are NOT looking at.  On the one you are in, the streaming answer is
  // itself the indicator, so a spinner there would be noise (the human's ask)
  const running = !!busy && busy.chatId === c.id && c.id !== chatId;
  const drafted = !!String(store.get(draftKeyOf(c.id, !c.messages.length), "")).trim();
  // run and new sit in the row's left gutter, absolutely placed, so they cost no title width at all; a draft is
  // an asterisk on the name itself, because it belongs to the text rather than to what is happening to the
  // conversation.  A reply you have not read outranks a draft in the gutter: go read beats go type.
  const state = running ? "run" : c.unread ? "new" : "";
  const tip = running ? "answering" : c.unread ? "unread reply" : "";
  const row = node("div", `chat-item${c.id === chatId ? " on" : ""}`);
  row.dataset.id = c.id;
  row.innerHTML = `<button class="chat-item__title${drafted ? " draft" : ""}" data-open-chat` +
    ` title="${esc(t)}${tip ? ` (${esc(tip)})` : ""}${drafted ? " (has draft)" : ""}">${esc(t)}</button>` +
    (state ? `<span class="chat-item__state ${state}" title="${esc(tip)}" aria-hidden="true"></span>` : "") +
    `<span class="chat-item__actions">` +
    `<button class="st-btn st-btn--icon" data-rename aria-label="Rename this chat" title="Rename">${icon("edit")}</button>` +
    `<button class="st-btn st-btn--icon" data-delete aria-label="Delete this chat" title="Delete">${icon("trash")}</button>` +
    `</span>`;
  return row;
}
function renderSidebar() {
  // the search reads every chat's message text, so the whole store is in memory after the first load
  const q = sidebarQuery.trim().toLowerCase();
  const list = chats.filter((c) => !q || chatTitle(c).toLowerCase().includes(q) ||
                                   c.messages.some((m) => (m.text || "").toLowerCase().includes(q)))
                     .sort((a, b) => b.time - a.time);
  const box = $("sidebar-list");
  box.innerHTML = "";
  if (!list.length) {
    box.appendChild(node("p", "muted small sidebar-empty", q ? "No chat matches" : "No chats yet"));
  } else {
    let group = "";
    for (const c of list) {
      const g = groupName(c.time);
      if (g !== group) { group = g; box.appendChild(node("p", "sidebar-group", g)); }
      box.appendChild(chatItem(c));
    }
  }
  $("sidebar-foot").textContent = `${fmt(chats.length)} chat${chats.length === 1 ? "" : "s"} · kept in this browser`;
}

function showChat(c) {
  if (c.id !== chatId) saveDraft();            // what you typed belongs to the chat you are leaving
  chat = c; chatId = c.id; messages = c.messages;
  store.set("chatId", chatId);
  c.unread = false;           // opening it is how a reply stops being unread
  writeChat(chat);            // renderChat renders the list, so the write here does not render it again
  loadDraft();                // and the box takes on the text that belongs to the chat you are entering
  renderChat();
}
function openChat(id) {
  // no busy guard: the answer keeps streaming into its own message object, and paint() finds the row again when
  // you come back, so reading another conversation mid-turn is safe (todo #switch-while-running)
  const c = chats.find((x) => x.id === id);
  if (c) showChat(c);
}
function startChat() {
  if (!messages.length) { $("input").focus(); return; }        // already a fresh chat
  const prev = chatId;
  // one blank chat is as good as another: making a second one only fills the list with rows that all say
  // "New chat", and each would then want its own draft. Reuse the blank one the list already has.
  const blank = chats.find((c) => !c.messages.length);
  if (blank) {
    showChat(blank);
    $("input").focus();
    toast("info", "New chat", "You already had a blank chat - it is in the list on the left.", 6000,
          {label: "Undo", run: () => openChat(prev)});
    return;
  }
  const c = newChat();
  chats.push(c);
  showChat(c);
  $("input").focus();
  toast("info", "New chat", "The one you were in is in the list on the left.", 6000,
        {label: "Undo", run: () => openChat(prev)});
}
function deleteChat(c) {
  if (busy && c.id === busy.chatId) { toast("warn", "Still writing", "Stop the answer first."); return; }
  const i = chats.indexOf(c), wasOpen = c.id === chatId;
  if (i < 0) return;                                // the list only ever passes a chat it holds
  chats.splice(i, 1);
  const dkey = draftKeyOf(c.id, !c.messages.length);   // a delete that is undone should not cost you the text
  const draft = store.get(dkey, "");                   // you were typing into it
  store.set(dkey, "");
  dropRecord(c);                                    // the record; the Undo puts it back
  if (wasOpen) {
    const next = chats[0] || newChat();
    if (!chats.includes(next)) chats.push(next);
    showChat(next);
  } else renderSidebar();
  toast("info", "Chat deleted", chatTitle(c), 6000, {label: "Undo", run: () => {
    if (chats.includes(c)) return;                  // already put back
    chats.splice(Math.min(i, chats.length), 0, c);  // the display is sorted by time, so only the index matters
    if (draft) store.set(dkey, draft);                // before showChat, which reads the draft back
    if (wasOpen) showChat(c); else { writeChat(c); renderSidebar(); }
  }});
}
// rename: the row turns into a field; Enter or a click outside keeps the name, Escape gives it up
function renameChat(row, c) {
  const title = row.querySelector(".chat-item__title");
  const input = node("input", "st-input chat-item__input");
  input.value = chatTitle(c);
  input.setAttribute("aria-label", "Name for this chat");
  title.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (keep) { c.title = input.value.trim(); putChat(c); } else renderSidebar();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function setSidebar(open, save) {
  sidebarOpen = open;
  $("sidebar").dataset.open = String(open);
  if (save) store.set("sidebar", open);
}
$("sidebar-toggle").onclick = () => setSidebar(!sidebarOpen, true);
$("sidebar-new").onclick = startChat;
$("sidebar-search").addEventListener("input", () => { sidebarQuery = $("sidebar-search").value; renderSidebar(); });
$("sidebar-list").addEventListener("click", (e) => {
  // a click inside the rename field is caret placement, not a click on the row: the row's handler would
  // open the chat, which re-renders the list and takes the field away mid-click
  if (e.target.closest(".chat-item__input")) return;
  const row = e.target.closest(".chat-item");
  if (!row) return;
  const c = chats.find((x) => x.id === row.dataset.id);
  if (!c) return;
  if (e.target.closest("[data-delete]")) { deleteChat(c); return; }
  if (e.target.closest("[data-rename]")) { renameChat(row, c); return; }
  openChat(c.id);
});

// the switch under About > Settings. Off is the old page: one chat, "New chat" clears it.
function setHistory(on, save, fromScreen) {
  historyOn = on;
  $("history-toggle").setAttribute("aria-checked", String(on));
  $("sidebar").hidden = !on;
  $("new-btn").title = on ? "New chat (the one you are in stays in the list)" : "New chat";
  if (save) store.set("history", on);
  // off writes the single chat here as well, so a reload shows the chat you were in, not the one from before the switch
  if (!on) { messages = chat ? chat.messages : messages; store.set("chat", cleanMessages(messages)); renderChat(); return; }
  openHistory(fromScreen).then(renderChat);          // the store is opened before the list can be read
}
$("history-toggle").onclick = () => setHistory($("history-toggle").getAttribute("aria-checked") !== "true", true, true);

// markdown for one message: its own choice (the "md" button in its meta row) wins; otherwise the default for its
// author - mine off (the page draws exactly what you typed, as it always did), the model's on (also as before).
// The choice is stored on the message (m.md), so it is kept with the chat and survives a reload.
const msgMd = (m) => (m.md === undefined ? (m.role === "user" ? settings.mdmine === true : settings.mdtheirs !== false) : !!m.md);
const mdBtn = (m) => `<button class="st-btn st-btn--md" data-md-toggle role="switch" aria-checked="${msgMd(m)}"` +
  ` title="Render this message as markdown (${msgMd(m) ? "on" : "off"})">md</button>`;

function msgEl(m, i) {
  const el = document.createElement("div");
  el.className = `st-msg st-msg--${m.role}`;
  el.dataset.i = i;
  if (m.role === "user") {
    if (m.files && m.files.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const f of m.files) {
        const c = document.createElement("span");
        c.className = "chip";
        c.innerHTML = icon("attach", "st-icon st-icon--sm");
        c.append(f.name);
        wrap.appendChild(c);
      }
      el.appendChild(wrap);
    }
    if (m.images && m.images.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const im of m.images) {
        if (im.url) { const img = document.createElement("img"); img.src = im.url; img.alt = im.name || "image"; wrap.appendChild(img); }
        else { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = icon("image", "st-icon st-icon--sm"); c.append(im.name || "image"); wrap.appendChild(c); }
      }
      el.appendChild(wrap);
    }
    const b = document.createElement("div");
    b.className = "st-bubble";
    // off (the default for my own messages): exactly the characters typed.  on: the answers' renderer, which
    // escapes first (inline() calls esc() before any formatting, codeBlock() escapes the code, and only http(s)
    // targets become anchors), so nothing typed can become markup.  Only the display changes: the prompt is
    // still built from m.text by userText()/apiMessages(), byte for byte.
    if (msgMd(m)) b.innerHTML = markdown(m.text || ""); else b.textContent = m.text;
    el.appendChild(b);
    const meta = document.createElement("div");
    meta.className = "st-msg__meta";
    meta.innerHTML = `<span class="meta-text"></span>${mdBtn(m)}`;
    meta.querySelector(".meta-text").textContent = `You · ${timeStr(m.time)}`;
    el.appendChild(meta);
  } else {
    // todo #think-per-round: the thinking blocks are parts of the bubble now, in the order the model produced them, so the
    // template only makes the bubble and the row under it
    el.innerHTML = `<div class="st-bubble"></div><div class="st-msg__meta"><span class="meta-text"></span>` +
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="Copy the answer"` +
      ` title="Copy the answer - Shift: with the thinking, Ctrl+Shift: everything including the tool calls">${icon("copy")}</button>${mdBtn(m)}</div>`;
    updateAssistant(el, m, false);
  }
  return el;
}
// One MCP tool call in the answer: a compact block (name, state, a one-line preview) that opens to the arguments and
// the result as the model read it.  Its body is built only while open: a result can be 20,000 characters.
const TOOL_STATE = {writing: ["st-badge--reading", "Writing"], running: ["st-badge--generating", "Running"], done: ["", "Done"],
                    error: ["st-badge--error", "Error"], skipped: ["st-badge--queued", "Not run"]};
// A tool block's open state lives on the tool while the turn runs (the answer is rebuilt every frame, so it
// has to survive a repaint).  One control, "Show thinking", decides what happens when nobody has clicked one:
// "folded" never opens it, "live" opens only a call that is still happening - being written, or running - so it
// collapses on its own once it settles, "always" opens it and leaves it.  A click wins over the control for the
// rest of the turn, and no further: the click is dropped when the turn ends (send) and is never written to the
// chat record (cleanMessages), because it is how the page is showing the work, not part of the conversation.
// It used to be written, and that is why one tap pinned a call open through every reload after it.
const toolLive = (t) => t.state === "writing" || t.state === "running";
const toolOpen = (t) => t.open !== undefined ? !!t.open
  : settings.show === "always" ? true
  : settings.show === "live" ? toolLive(t)
  : false;
// what an open tool block holds: the arguments, and the result as the model read it.  Built only while the block
// is open - a result can be 20,000 characters - so opening one with a click fills it in here (see the toggle
// listener below), exactly as the thinking body is filled when it opens.
// the strings a tool block shows, in one place: toolHtml() writes them once when the block is made and
// toolSync() compares against them afterwards, so the two can never drift apart
// the arguments as the reader should see them: a finished call's, pretty-printed; while the model is still
// writing one, the raw JSON arriving piece by piece (todo #tool-args-stream) instead of a static "(being written)"
const toolArgsText = (t) => (t.arguments != null ? JSON.stringify(t.arguments, null, 2) : (t.argsText || ""));
const toolArgs = (t) => toolArgsText(t) || "(being written)";
// a finished call previews the result the model saw; one still being written previews the JSON arriving now
const toolPreview = (t) => (t.result != null ? t.result : toolArgsText(t)).replace(/\s+/g, " ").slice(0, 200);
const toolMs = (t) => (t.ms != null && t.state !== "skipped" ? `${fmt(t.ms / 1000, 1)} s` : "");
const toolResultLabel = (t) => (t.result == null ? "" : `${t.ok ? "Result" : "Error"}` +
                               `${t.chars ? ` · ${fmt(t.chars)} characters` : ""}${t.truncated ? ", cut for the model" : ""}`);
function toolBodyHtml(t) {
  let body = `<div class="tool-call__label">Arguments</div>` +
             `<pre class="tool-call__pre tool-call__pre-args">${esc(toolArgs(t))}</pre>`;
  if (t.result != null) {
    body += `<div class="tool-call__label tool-call__label-result">${esc(toolResultLabel(t))}</div>` +
            `<pre class="tool-call__pre tool-call__pre-result">${esc(t.result)}</pre>`;
  }
  return body;
}
function toolHtml(t, k) {
  const [cls, label] = TOOL_STATE[t.state] || ["", t.state];
  const open = toolOpen(t);
  return `<details class="st-collapse tool-call" data-tool="${k}" data-state="${esc(t.state)}"${open ? " open" : ""}>` +
    `<summary>${icon("tool", "st-icon st-icon--sm")}<span class="tool-call__name" title="${esc(t.name || "")}">${esc(t.tool || t.name || "tool")}</span>` +
    `<span class="muted small tool-call__server">${esc(t.server || "")}</span>` +
    `<span class="tool-call__preview muted">${esc(toolPreview(t))}</span>` +
    `<span class="st-badge ${cls}">${esc(label)}</span>` +
    `<span class="muted small tool-call__ms">${esc(toolMs(t))}</span>` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body">${open ? toolBodyHtml(t) : ""}</div></details>`;
}
// the body of an open tool block: built once, then its text is replaced.  Re-parsing a 20,000-character result
// every frame is what made an open block the most expensive part of a paint.
function syncToolBody(box, t) {
  if (!box._built) { box.innerHTML = toolBodyHtml(t); box._built = true; box._hasResult = t.result != null; return; }
  const args = box.querySelector(".tool-call__pre-args");
  const wantArgs = toolArgs(t);
  // a call being written streams its JSON: follow it the way the thinking follows, only if the reader is at the
  // bottom of that box already (todo #tool-args-stream)
  const follow = t.state === "writing" && nearEnd(args, 48);
  if (args.textContent !== wantArgs) {
    args.textContent = wantArgs;
    if (follow) args.scrollTop = args.scrollHeight;
  }
  if (t.result == null) return;
  if (!box._hasResult) {                                  // the result arrived after the block was first opened
    box.insertAdjacentHTML("beforeend", `<div class="tool-call__label tool-call__label-result"></div>` +
                                        `<pre class="tool-call__pre tool-call__pre-result"></pre>`);
    box._hasResult = true;
  }
  const lab = box.querySelector(".tool-call__label-result"), pre = box.querySelector(".tool-call__pre-result");
  if (lab.textContent !== toolResultLabel(t)) lab.textContent = toolResultLabel(t);
  if (pre.textContent !== t.result) pre.textContent = t.result;
}
// a tool block already in the page: update only the text that changed.  Its two sprite icons, its summary and
// its pre elements stay the same elements, which is the whole point - they were being remade 60 times a second.
function toolSync(d, t) {
  const [cls, label] = TOOL_STATE[t.state] || ["", t.state];
  if (d.dataset.state !== t.state) d.dataset.state = t.state;
  const open = toolOpen(t);
  if (d.open !== open) d.open = open;      // fires a toggle event; the listener tells ours from a click by
                                           // comparing the element against toolOpen(), not by consuming a flag
  const name = d.querySelector(".tool-call__name");
  const nm = t.tool || t.name || "tool";
  if (name.textContent !== nm) name.textContent = nm;
  if (name.getAttribute("title") !== (t.name || "")) name.setAttribute("title", t.name || "");
  const server = d.querySelector(".tool-call__server");
  if (server.textContent !== (t.server || "")) server.textContent = t.server || "";
  const prev = d.querySelector(".tool-call__preview");
  const pv = toolPreview(t);
  if (prev.textContent !== pv) prev.textContent = pv;
  const badge = d.querySelector(".st-badge");
  const bc = `st-badge ${cls}`;
  if (badge.className !== bc) badge.className = bc;
  if (badge.textContent !== label) badge.textContent = label;
  const ms = d.querySelector(".tool-call__ms");
  if (ms.textContent !== toolMs(t)) ms.textContent = toolMs(t);
  if (open) syncToolBody(d.querySelector(".st-collapse__body"), t);
}
// where the thinking runs are: a tool call records rat = how long the reasoning was when it started
// (onTool), so the reasoning string is already segmented by round.  Nothing here rewrites m.reasoning:
// those same offsets are what assistantMessages() replays to the server, and a one-character difference
// breaks the engine's prompt prefix (serve/server.py:4470-4481, #2100).
function roundCuts(m) {
  const cuts = [];
  let lastRat = -1;
  (m.tools || []).forEach((t, k) => {
    const rat = t.rat || 0;
    if (rat > lastRat) { cuts.push({first: k, rat}); lastRat = rat; }   // parallel calls share one boundary
  });
  return cuts;
}
function thinkRuns(m) {
  const reas = m.reasoning || "", cuts = roundCuts(m), out = [];
  let from = 0;
  cuts.forEach((c) => { out.push({from, to: c.rat}); from = c.rat; });
  if (reas.length > from) out.push({from, to: reas.length, secs: null});
  return out.map((r, i) => {
    // a run's seconds are stamped (in send) on the last call of the round that run led to, which is the tool
    // whose arrival ended the thinking
    const last = (i < cuts.length ? (i + 1 < cuts.length ? cuts[i + 1].first : (m.tools || []).length) - 1 : -1);
    const secs = last >= 0 && m.tools[last].tsec != null ? m.tools[last].tsec : (i === 0 ? m.thinkSecs : null);
    // cut: a call started at the end of this run, so the thinking that led to it is over even though this is
    // still the last run (the next round's reasoning has not arrived yet).
    // tstart: how much answer text existed when this run began, stamped in send() as m.rts (display only - it
    // touches neither m.text nor m.reasoning, so the replay is untouched).  Text grown past it means the model
    // stopped thinking and started writing.  A run with no stamp - a chat from before this existed - reports
    // null and is never folded by this rule.  "Show thinking: Fold when done" uses cut and tstart.
    return {...r, i, secs, cut: i < cuts.length, tstart: (m.rts || [])[i]};
  });
}
// the answer cut at the calls: each round's text before its call, then the calls.  The last text run has
// no call after it - that is the answer, and it stays outside every container.
function flatParts(m) {
  const text = m.text || "", out = [];
  let lastAt = 0;
  (m.tools || []).forEach((t, k) => {
    const at = Math.min(Math.max(t.at || 0, lastAt), text.length);
    if (at > lastAt) out.push({kind: "text", from: lastAt, to: at});
    lastAt = at;
    out.push({kind: "tool", k});
  });
  if (text.length > lastAt) out.push({kind: "text", from: lastAt, to: text.length});
  return out;
}
// the layout, final after two tries at nesting: everything is top level, in the order it happened - thinking
// run, the text that round wrote, its calls, the next thinking run, and so on, with the answer last.  The
// human's verdict on both nested versions: the container added a click to reach the calls and swallowed the
// narration.  Per-round thinking blocks stayed; the box did not.
function bubbleParts(m) {
  const cuts = roundCuts(m), tools = m.tools || [], runs = thinkRuns(m), flat = flatParts(m);
  const out = [];
  const thinkPart = (i) => ({kind: "think", i, from: runs[i].from, to: runs[i].to, secs: runs[i].secs,
                             cut: runs[i].cut, tstart: runs[i].tstart, runs: runs.length});
  let fi = 0;
  for (let i = 0; i < cuts.length; i++) {
    const stop = i + 1 < cuts.length ? cuts[i + 1].first : tools.length;      // this round's tool range
    if (i < runs.length) out.push(thinkPart(i));
    while (fi < flat.length) {
      const q = flat[fi];
      if (q.kind === "tool") { if (q.k >= stop) break; out.push(q); fi++; continue; }
      const next = flat.slice(fi).find((x) => x.kind === "tool");   // the call this text leads up to
      if (!next || next.k >= stop) break;                           // it leads a later round, or none: leave it
      out.push(q); fi++;
    }
  }
  if (runs.length > cuts.length) out.push(thinkPart(cuts.length));            // thinking before the answer
  for (; fi < flat.length; fi++) out.push(flat[fi]);                          // and the answer itself
  return out;
}
const dropPart = (p) => (p.els || [p.el]).forEach((e) => e && e.remove());
function addBlocks(host, p, blks) {
  for (const b of blks) { host.insertAdjacentHTML("beforeend", b); p.els.push(host.lastElementChild); }
  p.n = blks.length; p.last = blks[blks.length - 1] || "";
}
// The answer bubble, updated in place.  A part is one element the page owns and then only edits by text:
// a thinking block, a work container, a tool call, or a run of markdown.  Nothing here re-assigns the
// bubble's innerHTML, which is what used to remake every sprite icon in it 60 times a second (LESSONS.md,
// "The web app's flash is the innerHTML assignment"), and it is why a part is created once and then synced.
//
// Layout (todo #think-per-round, the human's rule): a thinking block is always top level, and the container that holds
// that round's text and calls starts right after it.  So reading down a multi-round turn gives you the
// model's thoughts at arm's reach and the work each thought produced folded under it.
const THINK_SHELL = `<details class="st-collapse think" data-think hidden><summary>${icon("thinking", "st-icon st-icon--sm")}` +
  `<span class="think-title"></span><span class="think-preview muted"></span>` +
  `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary>` +
  `<div class="st-collapse__body thinking"></div></details>`;
// one line of a thinking run for the collapsed summary, the way a tool block previews its result.  The first
// 200 characters are taken and CSS ellipsises what does not fit, so the line never wraps.
const thinkPreview = (t) => t.replace(/\s+/g, " ").trim().slice(0, 200);
// One control, "Show thinking", decides how a thinking block is shown, and the same three answers cover the
// tool calls beside it: "folded" never opens one, "live" opens the work while it is happening and closes it
// when it is done, "always" opens it and leaves it.  A block the reader opened or closed by hand wins over the
// control for the rest of the turn (det.dataset.touched), and that choice lives on the element only -
// renderChat rebuilds the elements, so after a reload the control decides again.  The open state is worked out
// before the body is filled: filling first leaves an auto-opened block open and blank, because the toggle
// listener skips the fill for an open we asked for ourselves (it sees det._auto).
//
// "Done" for a thought is not "it is the last run": while a tool round runs thinkRuns still reports one run,
// so that rule would hold the thought open through the whole call.  Two signals say it is over - p.cut, a call
// starting exactly where the run ends, and p.tstart, answer text grown past where the run began.
function syncThink(det, m, p, streaming) {           // det IS the details: querySelector looks at descendants only
  const thinkingNow = streaming && p.i === p.runs - 1 && !m.text;
  const text = (m.reasoning || "").slice(p.from, p.to);
  det.querySelector(".think-title").textContent = thinkingNow ? "Thinking\u2026" :
    p.secs != null ? `Thought for ${fmt(p.secs, 1)} s` : "Thoughts";
  const prev = det.querySelector(".think-preview");
  const pv = thinkPreview(text);
  if (prev.textContent !== pv) prev.textContent = pv;      // the collapsed line; CSS hides it once open
  const liveRun = p.i === p.runs - 1 && streaming && !p.cut && !(p.tstart != null && m.text.length > p.tstart);
  const wantOpen = settings.show === "always" ? true
    : settings.show === "live" ? liveRun : false;
  if (det.dataset.touched !== "1" && det.open !== wantOpen) { det._auto = true; det.open = wantOpen; }
  const body = det.querySelector(".thinking");
  const follow = streaming && p.i === p.runs - 1 && nearEnd(body, 48);   // only the live block follows its own text
  if (det.open || thinkingNow) {
    body.textContent = text;
    if (follow) body.scrollTop = body.scrollHeight;
  } else body.dataset.pending = "1";
  det.hidden = !text;
}
function renderBubble(el, m, streaming) {
  const bubble = el.querySelector(".st-bubble");
  if (m.error) {
    bubble.innerHTML = `<div class="msg-error"></div>`;
    bubble.querySelector(".msg-error").textContent = m.error;      // not firstChild: it is the div we just wrote
    bubble._parts = null; bubble._blocks = [];
    return;
  }
  const plain = !msgMd(m);
  if (bubble._plain !== undefined && bubble._plain !== plain) {   // this message's md button was clicked: redraw
    bubble.innerHTML = ""; bubble._parts = null; bubble._blocks = [];
  }
  bubble._plain = plain;
  const want = bubbleParts(m), have = bubble._parts || [];
  syncLevel(bubble, m, want, have);
  bubble._parts = have;
  bubble._blocks = have.filter((p) => p.kind === "think");        // the toggle listener fills a block from here
  for (let i = 0; i < have.length; i++) updatePart(bubble, m, have[i], want[i], streaming);
}
// parts are only ever added at the end, so a prefix that matches what is already on screen keeps its elements
// and only the tail is built.  That is safe because a call's place in the text (at) and a thinking run's place
// in the reasoning (rat) are fixed when they are made, and both strings only grow - so a part that has been
// drawn never moves and is never re-created.

function syncLevel(host, m, want, have, streaming) {
  let i = 0;
  while (i < want.length && i < have.length && samePart(want[i], have[i])) i++;
  for (let j = have.length - 1; j >= i; j--) dropPart(have[j]);
  have.length = i;
  for (; i < want.length; i++) have.push(makePart(host, want[i], m));
}
const samePart = (w, h) => w.kind === h.kind &&
  (w.kind === "tool" ? w.k === h.k : w.kind === "text" ? w.from === h.from : w.i === h.i);
function makePart(host, w, m) {
  const p = {...w, els: [], _to: w.to};
  if (w.kind === "tool") { host.insertAdjacentHTML("beforeend", toolHtml(m.tools[w.k], w.k)); p.el = host.lastElementChild; }
  else if (w.kind === "think") {
    host.insertAdjacentHTML("beforeend", THINK_SHELL); p.el = host.lastElementChild;
    p.el.dataset.think = w.i;                          // which run this block is: the toggle listener needs it
    p.body = p.el.querySelector(".st-collapse__body thinking");
  } else if (host._plain) {                     // plain text: one element, updated by textContent
    host.insertAdjacentHTML("beforeend", `<div class="md-plain"></div>`);
    p.els = [host.lastElementChild]; p.n = 1; p.plain = true;
  } else addBlocks(host, p, markdownBlocks(m.text.slice(w.from, w.to)));
  return p;
}
function updatePart(host, m, p, w, streaming) {
  if (p.kind === "tool") { toolSync(p.el, m.tools[p.k]); return; }
  if (p.kind === "think") {
    // the live run's slice grows: from/to/runs must come from this paint, not from when the part was made, or
    // the block keeps showing only what it held at creation (the "first word only" bug)
    p.from = w.from; p.to = w.to; p.runs = w.runs;
    p.secs = w.secs; p.cut = w.cut;                     // a run's seconds are stamped when the NEXT run starts, and
                                                       // cut turns true when a call lands at the end of it.  Not
                                                       // tstart: that is fixed when the run begins and makePart
                                                       // copies it, so there is no stale version to refresh
    syncThink(p.el, m, p, streaming);
    return;
  }
  if (p.plain) {
    const t = m.text.slice(p.from, w.to);
    p._to = w.to;
    if (p.els[0].textContent !== t) p.els[0].textContent = t;    // the raw characters, newlines and all
    return;
  }
  if (w.to === p._to) return;                              // nothing new written here: leave its elements alone
  const blks = markdownBlocks(m.text.slice(p.from, w.to));
  p._to = w.to;
  if (blks.length === p.n && blks.length) {                // a settled block cannot change: only the last one
    const last = blks[blks.length - 1];
    if (last !== p.last) {
      const old = p.els[p.els.length - 1];
      old.insertAdjacentHTML("afterend", last);            // one element per block, so this is exact
      p.els[p.els.length - 1] = old.nextElementSibling;
      old.remove();
      p.last = last;
    }
    return;
  }
  p.els.forEach((e) => e.remove());
  p.els = [];                                              // the block count changed: rebuild this part (the tail)
  addBlocks(host, p, blks);
}
function onTool(m, x) {
  if (x.event === "limit") { m.limit = x.max_rounds; return; }
  m.tools = m.tools || [];
  let t = m.tools.find((y) => y.id === x.id);
  if (!t) { t = {id: x.id, name: x.name, at: m.text.length, rat: m.reasoning.length, state: "writing"}; m.tools.push(t); }
  if (x.event === "call") {
    Object.assign(t, {name: x.name, server: x.server, tool: x.tool, arguments: x.arguments, round: x.round, state: "running"});
    delete t.argsText;                    // the finished arguments replace the pieces that streamed in
  } else if (x.event === "args") {
    t.argsText = (t.argsText || "") + (x.text || "");     // todo #tool-args-stream: the call's JSON arriving piece by piece
  } else if (x.event === "result") {
    Object.assign(t, {result: x.text, ok: x.ok, chars: x.chars, truncated: x.truncated, ms: x.ms,
                      state: x.skipped ? "skipped" : x.ok ? "done" : "error"});
  }
}
function updateAssistant(el, m, streaming) {
  renderBubble(el, m, streaming);
  const bubble = el.querySelector(".st-bubble");
  el.querySelector(".meta-text").textContent = m.meta || (streaming ? "" : m.stopped ? "Stopped" : "");
  el.querySelector("[data-msg-copy]").hidden = streaming || !m.text;
  // todo #no-placeholder: nothing that only pretends to be output.  There is no box until the model has produced something
  // real - an answer, a tool call, an error.  Thinking now lives inside the bubble, so a thinking-only message
  // keeps the element (hiding it would hide the thinking with it) and drops its chrome: .thinking-only below.
  // A finished message that delivered nothing keeps its meta row, so a stopped or empty turn is still visible
  // as one.
  const hasOutput = !!m.text || !!(m.tools && m.tools.length) || !!m.error;
  bubble.hidden = !hasOutput && !m.reasoning;
  if (!hasOutput && m.reasoning) bubble.classList.add("thinking-only"); else bubble.classList.remove("thinking-only");
  el.querySelector(".st-msg__meta").hidden = !hasOutput && streaming;
}
function renderChat() {
  const chat = $("chat");
  chat.querySelectorAll(".st-msg").forEach((e) => e.remove());
  $("chat-empty").hidden = messages.length > 0;
  messages.forEach((m, i) => chat.appendChild(msgEl(m, i)));
  if (historyOn) renderSidebar();                   // the name in the list follows the first question
  scrollDown(true);
}
// the row for a message in the chat currently on screen.  send() used to capture one element and paint into it
// for the whole turn, which broke the moment the chat was re-rendered - renderChat() removes every .st-msg, so
// the stream kept painting a detached node and the answer vanished (LESSONS.md, "Four traps in that same render
// path", trap 1).  Resolving it each frame is what makes switching chats safe.
function rowOf(m) {
  const i = messages.indexOf(m);                    // -1 when a different chat is on screen: nothing to paint
  if (i < 0) return null;
  // +e.dataset.i: dataset values are text in a real DOM and numbers in the stub; neither should matter
  return Array.from($("chat").children).find((e) => +e.dataset.i === i) || null;
}
// how far from the bottom of a scroll container still counts as "at the bottom"
const nearEnd = (s, px) => s.scrollHeight - s.scrollTop - s.clientHeight < px;
function nearBottom() { return nearEnd($("chat-scroll"), 120); }
function scrollDown(force) { const s = $("chat-scroll"); if (force || nearBottom()) s.scrollTop = s.scrollHeight; }

$("chat").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) { copyText(cc.closest(".st-code").querySelector("pre").textContent, cc); return; }
  const mc = e.target.closest("[data-msg-copy]");
  if (mc) {
    const m = messages[+mc.closest(".st-msg").dataset.i];
    // plain click = the answer (as it always was); Shift = the answer and the thinking; Ctrl/Cmd+Shift =
    // everything, the tool calls and their results included
    const level = (e.ctrlKey || e.metaKey) && e.shiftKey ? 2 : (e.shiftKey ? 1 : 0);
    const txt = level ? turnMarkdown(m, level) : (m.text || "");
    // a tool result can be 20,000 characters, so say how much actually went onto the clipboard
    copyText(txt, mc, ["Copy the answer", "Copied the answer and the thinking",
                       `Copied everything (${fmt(txt.length)} characters, tool calls included)`][level]);
    return;
  }
  const mb = e.target.closest("[data-md-toggle]");
  if (mb) {
    const el = mb.closest(".st-msg"), m = messages[+el.dataset.i];
    if (!m) return;
    m.md = !msgMd(m);                                   // this message now has a choice of its own
    mb.setAttribute("aria-checked", String(m.md));
    mb.title = `Render this message as markdown (${m.md ? "on" : "off"})`;
    if (m.role === "user") {
      const b = el.querySelector(".st-bubble");
      if (m.md) b.innerHTML = markdown(m.text || ""); else b.textContent = m.text;
    } else renderBubble(el, m, !!busy && busy.msg === m);   // the parts machinery redraws it, mode and all
    if (!busy) saveChat();                              // the choice belongs to the chat, not to this page load
    return;
  }
  // tool blocks are not opened here: a click handler that prevented the default and asked for a rebuild lost the
  // click whenever the rebuild replaced the node between mousedown and mouseup, which is most of the time while
  // the answer streams.  The browser opens them; the toggle listener below remembers it.
});
$("chat").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS") return;
  if (d.classList.contains("tool-call")) {
    const el = d.closest(".st-msg"), m = messages[+el.dataset.i];
    const t = m && m.tools && m.tools[+d.dataset.tool];
    if (!t) return;
    // Is this the reader, or us?  toolSync sets d.open itself, and a browser queues the toggle event, so a
    // one-shot flag is not safe: with two events in flight the first eats the flag and the second - our own
    // change - is read as a click.  That sets t.open, toolOpen short-circuits on it, and the block never folds
    // again until send() clears it at the end of the turn.  Compare instead: if the element now holds what the
    // rule already wants, nobody clicked.
    if (d.open === toolOpen(t)) return;
    t.open = d.open;                                  // no longer undefined: this block's own choice decides now
    if (d.open) syncToolBody(d.querySelector(".st-collapse__body"), t);   // built only while open: a result can be 20,000 characters
    return;
  }
  if (!d.classList.contains("think")) return;
  if (d._auto) { d._auto = false; return; }          // our own open/close, not the user's
  d.dataset.touched = "1";                           // and from here on the page never touches this one again
  const body = d.querySelector(".thinking");
  if (d.open && body.dataset.pending) {              // a block that was closed while it streamed fills on opening
    const el = d.closest(".st-msg"), m = messages[+el.dataset.i];
    const p = (el.querySelector(".st-bubble")._blocks || []).find((x) => x.i === +d.dataset.think);
    if (p && m) body.textContent = (m.reasoning || "").slice(p.from, p.to);
    delete body.dataset.pending;
  }
}, true);

function apiMessages() {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = (m.images || []).filter((i) => i.url);
      const text = userText(m);
      out.push({role: "user", content: imgs.length ? [{type: "text", text},
        ...imgs.map((i) => ({type: "image_url", image_url: {url: i.url}}))] : text});
    } else if (!(busy && busy.msg === m)) {            // the answer being asked for now is not history yet
      out.push(...assistantMessages(m, settings.mcpthink === true));
    }
  }
  return out;
}
// An answer that used MCP tools goes back as the model wrote it: per round the text before the calls, the calls and
// their results (as the model read them), then the rest - so the next question can build on what the tools found.
function assistantMessages(m, keepThinking) {
  const ran = (m.tools || []).filter((t) => t.round != null && t.result != null && t.state !== "skipped");
  // #1392: a turn with no answer text (only reasoning, a stop before the first content token, or an error) still goes
  // back as an assistant turn, so the history keeps alternating and a reasoning model sees that it already answered.
  // The server leaves such a turn out of the prompt itself (serve/frontend.py, #843); reasoning_content rides along.
  if (!ran.length) {
    const msg = {role: "assistant", content: m.text || ""};
    if (!m.text && m.reasoning) msg.reasoning_content = m.reasoning;
    return [msg];
  }
  const out = [];
  let pos = 0, rpos = 0;
  const reas = m.reasoning || "";
  for (const r of [...new Set(ran.map((t) => t.round))]) {
    const calls = ran.filter((t) => t.round === r);
    const at = Math.min(Math.max(pos, calls[0].at || 0), m.text.length);
    const msg = {role: "assistant", content: m.text.slice(pos, at).trim(),
                 tool_calls: calls.map((t) => ({id: t.id, type: "function", function: {name: t.name, arguments: JSON.stringify(t.arguments || {})}}))};
    // #2100: only when the switch is on does the round's thinking go back, and it must match what the server put in
    // the prompt for that round (serve/server.py, run_with_mcp): the two rebuilds have to tokenize identically, or the
    // engine's checkpoint stops matching and the chat re-reads everything past the first tool round.  t.rat is the
    // thinking length when the call started, which is where this round's thinking ends.
    if (keepThinking) {
      const rat = Math.min(Math.max(rpos, calls[0].rat || 0), reas.length);
      const think = reas.slice(rpos, rat).trim();
      if (think) msg.reasoning_content = think;
      rpos = rat;
    }
    out.push(msg);
    for (const t of calls) out.push({role: "tool", tool_call_id: t.id, content: t.result});
    pos = at;
  }
  const rest = m.text.slice(pos).trim();
  if (rest) out.push({role: "assistant", content: rest});
  return out;
}

// closing the tab or reloading mid-request ends the request: the server sees the disconnect and stops the
// model, so nothing you were waiting for is kept.  While one is running the browser is asked to confirm first.
// The listener exists only while a request is running - a permanent one is what makes a browser refuse to
// keep the page in its back/forward cache.
function warnOnLeave(e) {
  e.preventDefault();
}
function setBusy(on) {
  $("stop-btn").hidden = !on;
  $("send-btn").disabled = on;
  $("composer-hint").textContent = on ? "" : "Shift+Enter: new line";
  if (on) window.addEventListener("beforeunload", warnOnLeave);
  else window.removeEventListener("beforeunload", warnOnLeave);
  if (historyOn) renderSidebar();      // the list shows which conversation is answering (chatItem reads busy)
}

async function send() {
  const text = $("input").value.trim();
  if ((!text && !attachments.length) || busy) return;
  const key = draftKey();                    // taken before the message lands: a blank chat is keyed differently
  messages.push({role: "user", text, images: attachments.filter((a) => a.kind !== "file"),
                 files: attachments.filter((a) => a.kind === "file"), time: Date.now()});
  attachments = [];
  renderAttachments();
  $("input").value = "";
  autosize();
  store.set(key, "");                                          // sent: that draft is spent
  const m = {role: "assistant", text: "", reasoning: "", time: Date.now()};
  messages.push(m);
  renderChat();
  const controller = new AbortController();
  busy = {controller, msg: m, chat, chatId};      // which conversation this turn belongs to, not which is open
  setBusy(true);

  const body = {model: health.model, messages: apiMessages(), stream: true,
                reasoning_effort: settings.thinking};
  if (settings.temperature > 0) {
    Object.assign(body, {temperature: +settings.temperature, top_p: +settings.top_p, top_k: +settings.top_k});
  } else {
    body.temperature = 0;
  }
  if (settings.seed) body.seed = +settings.seed;
  if (settings.max) body.max_tokens = +settings.max;
  if (projectionLoaded()) body.experimental_speed_projection = !!settings.esp;
  if (settings.mcp !== false && mcpInfo.tools > 0) {          // this server may run MCP tools for it
    body.strata_mcp = true;
    body.strata_mcp_args = true;               // todo #tool-args-stream: show the call's JSON as it is written, not "(being written)"
    // #2100: the same choice assistantMessages() renders with, so the two rebuilds of a tool turn agree
    body.strata_mcp_thinking = settings.mcpthink === true;
  }

  let firstAt = null, thinkStart = null, usage = null, frame = 0;
  // the row is looked up every frame: switching chats rebuilds them, and a captured node would keep painting a
  // detached element.  No row means another chat is on screen - the turn keeps running, it just does not paint.
  const paint = () => { frame = 0; const el = rowOf(m); if (el) { updateAssistant(el, m, true); scrollDown(); } };
  try {
    const r = await fetch("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body),
                                                   signal: controller.signal});
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
      if (r.status === 401) msg = "This server needs an API key: add it under About > Settings.";
      throw new Error(msg);
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;              // ": keep-alive" comments while a long prompt is read
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || "the engine reported an error");
        if (j.usage) usage = j.usage;
        if (j.strata_mcp) onTool(m, j.strata_mcp);
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        const lastTool = m.tools && m.tools.length ? m.tools[m.tools.length - 1] : null;   // a new round after a tool
        if (d.reasoning_content) {
          if (!firstAt) firstAt = performance.now();
          if (!thinkStart) thinkStart = performance.now();
          const newRun = !m.reasoning || (lastTool && lastTool.rat === m.reasoning.length);
          if (lastTool && m.reasoning && lastTool.rat === m.reasoning.length) {
            m.reasoning += "\n\n";                   // the separator assistantMessages() replays: keep it as it was
            if (thinkStart) {                        // and that closes the previous thinking run: stamp its seconds
              lastTool.tsec = (performance.now() - thinkStart) / 1000;
              thinkStart = performance.now();
            }
          }
          // A thinking run starts here: remember how much answer text already existed, which is what tells a
          // later paint the thought is over as soon as the model writes again.  roundCuts(m).length is the index
          // of the run this chunk begins - 0 with no calls yet, one past the last call's round after one.
          // Display only: m.rts holds numbers, never text, so the replay is untouched.
          if (newRun) (m.rts = m.rts || [])[roundCuts(m).length] = m.text.length;
          m.reasoning += d.reasoning_content;
        }
        if (d.content) {
          if (!firstAt) firstAt = performance.now();
          if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
          if (lastTool && m.text && lastTool.at === m.text.length) m.text += "\n\n";
          m.text += d.content;
        }
        if (!frame) frame = requestAnimationFrame(paint);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") m.stopped = true;
    else { m.error = e.message || String(e); toast("error", "The request failed", m.error, 6000); }
  }
  if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
  const n = usage ? usage.completion_tokens : null;
  if (n && firstAt) {
    const secs = (performance.now() - firstAt) / 1000;
    m.meta = `${fmt(n)} tokens${secs > 0.25 ? ` · ${fmt(n / secs, 1)} tok/s` : ""}${m.stopped ? " · stopped" : ""}` +
             (projectionLoaded() ? (settings.esp ? " · projection on" : " · projection off") : "");
  } else if (m.stopped) {
    m.meta = "Stopped";
  }
  for (const t of m.tools || []) if (t.state === "writing" || t.state === "running") { t.state = "skipped"; t.ms = null; }
  // a click on a tool block holds for the turn and no further (todo #click-not-persisted): the open choice is
  // dropped here, before the final paint below re-decides it from "Show thinking", and cleanMessages keeps it
  // out of the saved record.  A click on a finished message's block still holds until the chat is redrawn.
  for (const t of m.tools || []) delete t.open;
  const ran = (m.tools || []).filter((t) => t.state === "done" || t.state === "error").length;
  if (ran) m.meta = `${m.meta ? `${m.meta} · ` : ""}${ran} tool call${ran > 1 ? "s" : ""}`;
  if (m.limit) m.meta = `${m.meta || ""} · stopped at the limit of ${m.limit} tool rounds (mcp.max_rounds)`;
  const turn = busy;                                // which conversation this turn belonged to
  busy = null;
  // a reply that landed in a conversation you are not looking at is worth a mark (todo #chat-state-marker); set it before
  // setBusy(false), which is what redraws the list
  if (historyOn && turn.chat && turn.chatId !== chatId) turn.chat.unread = true;
  setBusy(false);                                   // the spinner clears; elsewhere a dot appears
  if (frame) cancelAnimationFrame(frame);
  const fin = rowOf(m);
  if (fin) { updateAssistant(fin, m, false); scrollDown(); }
  saveChat(turn.chat);                              // write it into ITS chat, not whichever one is open now
}

$("composer").onsubmit = (e) => { e.preventDefault(); send(); };
$("stop-btn").onclick = () => { if (busy) busy.controller.abort(); };
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
function autosize() { const t = $("input"); t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, innerHeight * 0.4)}px`; }
$("input").addEventListener("input", () => { autosize(); saveDraft(); });

$("new-btn").onclick = () => {
  if (!historyOn) {                                   // off: the old behaviour, clear with an Undo
    if (busy) { toast("warn", "Still writing", "Stop the answer first."); return; }   // one chat: this clears it
    if (!messages.length) return;
    const backup = messages;
    messages = [];
    saveChat();
    renderChat();
    toast("info", "New chat", "The last one was cleared.", 6000,
          {label: "Undo", run: () => { messages = backup; saveChat(); renderChat(); }});
    return;
  }
  startChat();
};
// The saved chat follows the screen: the same parts, in the same order, from bubbleParts().  The old export
// wrote three piles instead - all thinking, then every call, then the text - so a saved multi-round turn lost
// which thought led to which call.  One source for the order means the two cannot drift again.
function toolMarkdown(t) {
  const ms = t.ms != null && t.state !== "skipped" ? ` · ${fmt(t.ms / 1000, 1)} s` : "";
  return `<details><summary>Tool ${t.server ? `${t.server} / ` : ""}${t.tool || t.name}${ms}${t.ok ? "" : " (error)"}</summary>\n\n` +
    `\`\`\`json\n${JSON.stringify(t.arguments || {}, null, 2)}\n\`\`\`\n\n\`\`\`\n${t.result}\n\`\`\`\n\n</details>\n\n`;
}
// One walk, one format, three sizes.  The export takes everything (level 2, the default) and so does
// Ctrl+Shift+copy; Shift+copy takes the thinking and the text but not the calls; a plain copy stays the bare
// answer, which the caller passes straight from m.text.  Keeping a single builder is the point - the screen,
// the saved file and the clipboard cannot then disagree, and the clipboard gets the same <details> blocks the
// file has.  The order comes from bubbleParts(), the same parts the bubble draws.
function turnMarkdown(m, level = 2) {
  const out = [];
  for (const p of bubbleParts(m)) {
    if (p.kind === "think") {
      if (level < 1) continue;
      const t = (m.reasoning || "").slice(p.from, p.to).trim();
      if (t) out.push(`<details><summary>${p.secs != null ? `Thought for ${fmt(p.secs, 1)} s` : "Thoughts"}</summary>\n\n${t}\n\n</details>\n\n`);
    } else if (p.kind === "text") {
      const t = (m.text || "").slice(p.from, p.to).trim();
      if (t) out.push(`${t}\n\n`);
    } else if (level >= 2 && m.tools[p.k].result != null) {
      out.push(toolMarkdown(m.tools[p.k]));          // a call that never finished is not in the record
    }
  }
  if (m.error && level >= 1) out.push(`> ${m.error}\n\n`);   // an error is part of the turn, not a footnote
  return out.join("");
}

// a file named for the conversation, not just for the day: a folder full of strata-chat-*.md says nothing.
// A title can carry anything the model or the user typed, so drop what a filesystem refuses, trim the tail
// Windows dislikes (dots and spaces), and cap the length.
function safeFileName(t) {
  let s = String(t || "").replace(/[<>:"/\\|?*\u0000-\u001f\u0060]/g, " ")   // \u0060 = backtick: titles carry them
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (s.length > 48) {                                  // cut at a word boundary, not mid-word
    s = s.slice(0, 48);
    const cut = s.lastIndexOf(" ");
    if (cut >= 24) s = s.slice(0, cut);
  }
  return s.trim() || "strata-chat";
}
$("export-btn").onclick = () => {
  if (!messages.length) { toast("info", "Nothing to save yet"); return; }
  const md = messages.map((m) => m.role === "user" ? `## You\n\n${m.text}\n` : `## ${health.model}\n\n${turnMarkdown(m)}`).join("\n");
  const name = `${safeFileName(chatTitle(chat || {title: "", messages}))}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], {type: "text/markdown"}));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// pictures and text files: the attach button, dropping them on the chat, or pasting a picture (issue #30)
const TEXT_EXT = /\.(txt|md|markdown|rst|tex|py|pyi|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|c|cc|cpp|cxx|h|hh|hpp|cu|cuh|rs|go|java|kt|kts|swift|rb|php|pl|lua|r|jl|scala|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|diff|patch|gradle|cmake|mk|dockerfile|gitignore|proto|graphql)$/i;
const MAX_TEXT_FILE = 512 * 1024;
function isTextFile(f) {
  return f.type.startsWith("text/") || /json|xml|javascript|yaml|toml|x-sh|x-python/.test(f.type) ||
         TEXT_EXT.test(f.name) || /(^|[\\/])(makefile|dockerfile|readme|license)$/i.test(f.name);
}
function addFiles(files) {
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      if (!health.images) { toast("warn", "Pictures are off", "This model was set up for text only."); continue; }
      if (f.size > 20e6) { toast("warn", "Picture too large", `${f.name} is over 20 MB.`); continue; }
      const r = new FileReader();
      r.onload = () => { attachments.push({kind: "image", name: f.name || "pasted image", url: r.result}); renderAttachments(); };
      r.readAsDataURL(f);
      continue;
    }
    if (!isTextFile(f)) { toast("warn", "Not a text file", `${f.name}: attach text files (code, notes, logs, data)${health.images ? " or pictures" : ""}.`); continue; }
    if (f.size > MAX_TEXT_FILE) { toast("warn", "File too large", `${f.name} is over 512 KB.`); continue; }
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      if (text.includes("\u0000")) { toast("warn", "Not a text file", `${f.name} looks like a binary file.`); return; }
      attachments.push({kind: "file", name: f.name, text});
      renderAttachments();
    };
    r.readAsText(f);
  }
}
// a file's text in the message, fenced with more backticks than it contains itself
function fileBlock(f) {
  const longest = Math.max(2, ...(f.text.match(/`+/g) || []).map((s) => s.length));
  const fence = "`".repeat(longest + 1);
  return `File: ${f.name}\n${fence}\n${f.text}\n${fence}`;
}
function userText(m) {
  const files = (m.files || []).filter((f) => f.text != null);
  return [m.text, ...files.map(fileBlock)].filter((s) => s).join("\n\n");
}
function renderAttachments() {
  const box = $("attachments");
  box.hidden = !attachments.length;
  box.innerHTML = "";
  attachments.forEach((a, i) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = icon(a.kind === "file" ? "attach" : "image", "st-icon st-icon--sm");
    c.append(a.name);
    const x = document.createElement("button");
    x.type = "button"; x.className = "st-btn st-btn--icon"; x.setAttribute("aria-label", "Remove");
    x.innerHTML = icon("trash");
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    c.appendChild(x);
    box.appendChild(c);
  });
}
$("attach-btn").onclick = () => $("file").click();
// drop files on the chat or the message box
for (const id of ["chat", "composer"]) {
  const el = $(id);
  el.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer || {}).types || []].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dragging");
  });
  el.addEventListener("dragleave", () => $("composer").classList.remove("dragging"));
  el.addEventListener("drop", (e) => {
    $("composer").classList.remove("dragging");
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
    $("input").focus();
  });
}
$("file").onchange = () => { addFiles($("file").files); $("file").value = ""; };
$("input").addEventListener("paste", (e) => {
  if (!health.images) return;
  const files = [...(e.clipboardData || {}).files || []].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ------------------------------------------------------------------ the sampling drawer
function openDrawer(open) {
  $("drawer").dataset.open = String(open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) { loadDrawer(); loadShared(); loadMcp(); }
}
function loadDrawer(s = settings) {
  for (const b of $("s-thinking").children) b.setAttribute("aria-checked", String(b.dataset.v === s.thinking));
  $("s-temp").value = s.temperature; $("s-topp").value = s.top_p; $("s-topk").value = s.top_k;
  $("s-max").value = s.max; $("s-seed").value = s.seed;
  for (const b of $("s-show").children) b.setAttribute("aria-checked", String(b.dataset.v === s.show));
  $("s-mdmine").setAttribute("aria-checked", String(s.mdmine === true));
  $("s-mdtheirs").setAttribute("aria-checked", String(s.mdtheirs !== false));
  $("s-esp").setAttribute("aria-checked", String(s.esp !== false));
  $("esp-row").hidden = !projectionLoaded();
  $("s-mcp").setAttribute("aria-checked", String(s.mcp !== false));
  $("s-mcpthink").setAttribute("aria-checked", String(s.mcpthink === true));
  $("mcp-think-row").hidden = !(mcpInfo.tools > 0);
  $("s-share").setAttribute("aria-checked", String(sharedOn));
  outputs();
}
// "Use for other apps too": the server keeps these settings as every client's defaults (GET/POST /settings)
let sharedOn = false;
async function loadShared() {
  try {
    const r = await fetch("settings", {headers: headers()});
    if (r.ok) sharedOn = !!(await r.json()).shared;
  } catch (e) { /* an older server: the switch just stays off */ }
  $("s-share").setAttribute("aria-checked", String(sharedOn));
}
function sharedDefaults(s) {
  const d = {reasoning_effort: s.thinking, temperature: +s.temperature};
  if (+s.temperature > 0) Object.assign(d, {top_p: +s.top_p, top_k: +s.top_k});
  if (s.seed) d.seed = +s.seed;
  if (s.max) d.max_tokens = +s.max;
  if (projectionLoaded()) d.experimental_speed_projection = s.esp !== false;
  return d;
}
async function saveShared(on, s) {
  const r = await fetch("settings", {method: "POST", headers: headers(true),
                                      body: JSON.stringify({defaults: on ? sharedDefaults(s) : null})});
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  sharedOn = !!(await r.json()).shared;
}
// the engine was started with the experimental-speed-projection control vector (INFO cvec=...)
function projectionLoaded() {
  const c = lastMetrics && lastMetrics.engine ? lastMetrics.engine.cvec : 0;
  return !!c && c !== "0";
}
function outputs() {
  const t = +$("s-temp").value;
  $("o-temp").textContent = t === 0 ? "0 · greedy" : t.toFixed(2);
  $("o-topp").textContent = (+$("s-topp").value).toFixed(2);
  $("o-topk").textContent = $("s-topk").value;
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  $("o-thinking").textContent = sel ? {none: "answers right away", low: "short", medium: "medium", high: "thorough (default)"}[sel.dataset.v] : "";
  const sh = [...$("s-show").children].find((b) => b.getAttribute("aria-checked") === "true");
  $("o-show").textContent = sh ? {folded: "closed, click to read", live: "open while it happens (default)",
                                  always: "open, and stays open"}[sh.dataset.v] : "";
  for (const id of ["s-topp", "s-topk"]) $(id).disabled = t === 0;
}
for (const b of $("s-thinking").children) b.onclick = () => { for (const x of $("s-thinking").children) x.setAttribute("aria-checked", String(x === b)); outputs(); };
for (const id of ["s-temp", "s-topp", "s-topk"]) $(id).oninput = outputs;
for (const b of $("s-show").children) b.onclick = () => { for (const x of $("s-show").children) x.setAttribute("aria-checked", String(x === b)); outputs(); };
$("s-mdmine").onclick = () => $("s-mdmine").setAttribute("aria-checked", String($("s-mdmine").getAttribute("aria-checked") !== "true"));
$("s-mdtheirs").onclick = () => $("s-mdtheirs").setAttribute("aria-checked", String($("s-mdtheirs").getAttribute("aria-checked") !== "true"));
$("s-esp").onclick = () => $("s-esp").setAttribute("aria-checked", String($("s-esp").getAttribute("aria-checked") !== "true"));
$("s-mcp").onclick = () => $("s-mcp").setAttribute("aria-checked", String($("s-mcp").getAttribute("aria-checked") !== "true"));
// #2100: flipping this changes how a tool turn is rebuilt, so the next request in every chat that used tools stops
// matching the tokens the engine holds and re-reads its history once.  Say so before allowing it.
$("s-mcpthink").onclick = () => {
  const on = $("s-mcpthink").getAttribute("aria-checked") !== "true";
  const warn = on
    ? "Turn tool-round thinking ON?\n\nThe model re-reads its own reasoning on later tool rounds, and the chat grows by that thinking every round.\n\nThe next request in each chat that used tools re-reads its history once."
    : "Turn tool-round thinking OFF?\n\nLater tool rounds no longer see the reasoning of earlier ones, and the chat stops growing by it.\n\nThe next request in each chat that used tools re-reads its history once.";
  if (!confirm(warn)) return;
  $("s-mcpthink").setAttribute("aria-checked", String(on));
};
$("s-share").onclick = () => $("s-share").setAttribute("aria-checked", String($("s-share").getAttribute("aria-checked") !== "true"));
// what the drawer's controls say, without applying it.  Apply and the "you have unapplied changes" check both
// read through this, so the two can never drift apart (the same reason toolSync compares against toolHtml's
// helpers rather than re-deriving the strings).
function drawerSettings() {
  // the two segmented controls (Thinking, Show thinking) are read the same way; `on` is for the switches
  const seg = (id, d) => { const b = [...$(id).children].find((x) => x.getAttribute("aria-checked") === "true");
                           return b ? b.dataset.v : d; };
  const on = (id) => $(id).getAttribute("aria-checked") === "true";
  return {thinking: seg("s-thinking", DEFAULTS.thinking), temperature: +$("s-temp").value,
          top_p: +$("s-topp").value, top_k: +$("s-topk").value, max: $("s-max").value.trim(),
          seed: $("s-seed").value.trim(), show: seg("s-show", DEFAULTS.show),
          mdmine: on("s-mdmine"), mdtheirs: on("s-mdtheirs"),
          esp: on("s-esp"), mcp: on("s-mcp"), mcpthink: on("s-mcpthink")};
}
// only Apply writes, so closing the panel with switches changed throws the changes away.  The share switch is
// counted too: it decides what Apply sends the server, and until Apply it is worth nothing.
function drawerDirty() {
  const d = drawerSettings();
  if (Object.keys(DEFAULTS).some((k) => String(d[k]) !== String(settings[k]))) return true;
  return ($("s-share").getAttribute("aria-checked") === "true") !== sharedOn;
}
function closeDrawer() {
  if (drawerDirty() && !confirm("Discard the changes in this panel?\n\nThey take effect only when you press Apply, so closing now leaves every setting as it was.")) return;
  openDrawer(false);
}
$("s-reset").onclick = () => loadDrawer(DEFAULTS);
$("s-apply").onclick = async () => {
  const mdWas = settings.mdmine, thWas = settings.mdtheirs;
  settings = drawerSettings();
  store.set("sampling", settings);
  // these two switches are about how the messages on the screen are drawn, so redraw them - but not while an
  // answer is streaming: the turn would be rebuilt under the reader mid-frame. (It is no longer unsafe the way
  // it was - paint() resolves its row each frame now - it is just a jump for no benefit.)
  if ((settings.mdmine !== mdWas || settings.mdtheirs !== thWas) && !busy) renderChat();
  const share = $("s-share").getAttribute("aria-checked") === "true";
  openDrawer(false);
  if (share || sharedOn) {
    try {
      await saveShared(share, settings);
      toast("success", "Sampling saved", share ? "Other apps (omp, API clients) use these settings from their next request."
                                               : "Other apps use their own settings again.");
    } catch (e) {
      toast("error", "Saved here, but not for other apps", e.message, 6000);
    }
    return;
  }
  toast("success", "Sampling saved", settings.temperature === 0 ? "Greedy: the same question gives the same answer." : "");
};
$("sampling-btn").onclick = () => openDrawer(true);
$("drawer-close").onclick = closeDrawer;
$("scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").dataset.open === "true") closeDrawer(); });

// ------------------------------------------------------------------ start
setBusy(false);
// a narrow screen starts with the list closed so the chat has room
setSidebar(store.get("sidebar", true) && !matchMedia("(max-width: 760px)").matches, false);
setHistory(historyOn, false, false);                   // off by default: the page as it was
if (!historyOn) loadDraft();                           // on: openHistory reads it once the store has answered
const startQuestion = new URLSearchParams(location.search).get("q");   // /?q=... starts a chat (a shortcut)
if (startQuestion) history.replaceState(null, "", location.pathname + location.hash);
loadHealth().then(loadMcp).then(() => { if (startQuestion) { $("input").value = startQuestion; send(); } });
showTab(location.hash.slice(1) || "chat");
// showTab scheduled the first poll (it calls pollNow), so there is no second one here: one scheduler, one chain
