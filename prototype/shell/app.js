/* Aequera shell prototype — behavior.
   A small store mirroring aequera-core semantics (workspaces own tabs;
   mutations are named like core ops: openTab, closeTab, restoreClosed,
   switchTab/Workspace, navigate with per-tab history). Rendering is a full
   re-render per mutation: fine at prototype scale, explicitly NOT the
   production strategy (shell will diff/project). No network, no storage. */
"use strict";

const $ = (s) => document.querySelector(s);
const sidebar = $("#sidebar");
const addr = $("#addr");
const resultsEl = $("#results");

let nextId = 1;
const nid = () => nextId++;

const store = {
  activeWs: 1,
  workspaces: [
    {
      id: 1, name: "Personal",
      tabs: [
        mkTab("aequera:start", "Aequera Start"),
        mkTab("https://firefox-source-docs.mozilla.org", "Firefox Source Docs"),
      ],
      activeTab: 2, closed: [],
    },
    {
      id: 4, name: "Research",
      tabs: [mkTab("https://example.org/papers", "Reading list")],
      activeTab: 5, closed: [],
    },
  ],
};
nextId = 6;

function mkTab(url, title) {
  const id = nid();
  return { id, url, title, pinned: false, fav: fav(url),
           hist: [{ url, title }], hi: 0 };
}

function ws(id) { return store.workspaces.find((w) => w.id === id); }
function activeWs() { return ws(store.activeWs); }
function tabOf(w, id) { return w.tabs.find((t) => t.id === id); }

/* Favicons are generated locally (letter + hostname hash). No network. */
function fav(url) {
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ""); }
  catch { /* custom schemes like aequera:start keep the raw string */ }
  const letter = (host[0] || "?").toUpperCase();
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">`
    + `<rect width="32" height="32" rx="7" fill="hsl(${h},55%,42%)"/>`
    + `<text x="16" y="22" font-size="17" text-anchor="middle" fill="white"`
    + ` font-family="sans-serif" font-weight="bold">${letter}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/* ---------------- mutations (core-op mirrors) ---------------- */
function openTab(w, url, title) {
  const t = { id: nid(), url, title, pinned: false, fav: fav(url),
              hist: [{ url, title }], hi: 0 };
  w.tabs.push(t);
  w.activeTab = t.id;
  return t.id;
}
function closeTab(w, id) {
  const i = w.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [gone] = w.tabs.splice(i, 1);
  w.closed.push({ tab: gone, index: i });
  if (w.activeTab === id) {
    const next = w.tabs[i] || w.tabs[w.tabs.length - 1];
    w.activeTab = next ? next.id : null;
  }
}
function restoreClosed(w) {
  const c = w.closed.pop();
  if (!c) return;
  w.tabs.splice(Math.min(c.index, w.tabs.length), 0, c.tab);
  w.activeTab = c.tab.id;
}
function navigate(t, raw) {
  let url = raw.trim();
  if (!url) return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.includes("://")) url = "https://" + url;
  let title = url;
  try { title = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep raw */ }
  t.hist = t.hist.slice(0, t.hi + 1);
  t.hist.push({ url, title });
  t.hi = t.hist.length - 1;
  t.url = url; t.title = title; t.fav = fav(url);
}
function histGo(t, dir) {
  const hi = t.hi + dir;
  if (hi < 0 || hi >= t.hist.length) return;
  t.hi = hi;
  t.url = t.hist[hi].url; t.title = t.hist[hi].title; t.fav = fav(t.url);
}

/* ---------------- rendering ---------------- */
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

function render() {
  renderRail(); renderExpander(); renderPill(); renderPage();
}

function renderPill() {
  const w = activeWs();
  const t = w && tabOf(w, w.activeTab);
  $("#addr-pill-host").textContent = t ? shortHost(t.url) : "";
}

function shortHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function renderRail() {
  const w = activeWs();
  $("#tab-rail").innerHTML = w.tabs.map((t) =>
    `<li><button role="tab" data-tab="${t.id}" aria-selected="${t.id === w.activeTab}"`
    + ` aria-label="${esc(t.title)}" class="${t.pinned ? "pinned" : ""}">`
    + `<img src="${t.fav}" alt=""></button></li>`).join("");
  $("#ws-rail").innerHTML = store.workspaces.map((x) =>
    `<button data-ws="${x.id}" aria-selected="${x.id === store.activeWs}"`
    + ` aria-label="${esc(x.name)}" title="${esc(x.name)}"></button>`).join("");
}

function renderExpander() {
  const w = activeWs();
  $("#tab-list").innerHTML = w.tabs.map((t) =>
    `<li><button class="tab-row" role="tab" data-tab="${t.id}"`
    + ` aria-selected="${t.id === w.activeTab}" aria-label="${esc(t.title)}">`
    + `<img src="${t.fav}" alt="">`
    + `<span class="t">${esc(t.title)}<small>${esc(t.url)}</small></span>`
    + `<span class="x" role="button" tabindex="-1" data-close="${t.id}" aria-label="Close ${esc(t.title)}">×</span>`
    + `</button></li>`).join("");
  $("#ws-list").innerHTML = store.workspaces.map((x) =>
    `<button data-ws="${x.id}" aria-selected="${x.id === store.activeWs}">`
    + `<span class="dot"></span>${esc(x.name)}<span class="n">${x.tabs.length}</span></button>`).join("");
}

function renderPage() {
  const w = activeWs();
  const t = w && tabOf(w, w.activeTab);
  const page = $("#page");
  if (!t) {
    page.innerHTML = `<div class="page-card"><h1>No tab open</h1>`
      + `<p>Press <kbd>+</kbd> for a new tab.</p></div>`;
    return;
  }
  page.innerHTML = `<div class="page-card"><img src="${t.fav}" alt="">`
    + `<h1>${esc(t.title)}</h1><p>${esc(t.url)}</p>`
    + `<p>history ${t.hi + 1} of ${t.hist.length} · ${esc(w.name)}</p>`
    + `<p><kbd>Ctrl/⌘ K</kbd> address &amp; commands · <kbd>1–9</kbd> switch tab ·`
    + ` <kbd>Esc</kbd> close</p></div>`;
}

/* ---------------- unified address/command surface ---------------- */
let selIndex = -1;
function candidates(q) {
  q = q.trim().toLowerCase();
  const items = [];
  for (const w of store.workspaces) {
    for (const t of w.tabs) {
      if (!q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) {
        items.push({ kind: "Tab", title: t.title, sub: `${t.url} · ${w.name}`,
                     run: () => { store.activeWs = w.id; w.activeTab = t.id; } });
      }
    }
    if (!q || w.name.toLowerCase().includes(q)) {
      items.push({ kind: "Workspace", title: w.name, sub: `${w.tabs.length} tabs`,
                   run: () => { store.activeWs = w.id; } });
    }
  }
  const cmds = [
    { title: "New tab", run: () => openTab(activeWs(), "aequera:newtab", "New Tab") },
    { title: "New workspace", run: () => {
        const id = nid();
        store.workspaces.push({ id, name: `Workspace ${store.workspaces.length + 1}`,
                                tabs: [], activeTab: null, closed: [] });
        store.activeWs = id;
    } },
    { title: "Restore closed tab",
      run: () => restoreClosed(activeWs()),
      enabled: () => activeWs().closed.length > 0 },
  ];
  for (const c of cmds) {
    if ((!q || c.title.toLowerCase().includes(q)) && (!c.enabled || c.enabled())) {
      items.push({ kind: "Command", title: c.title, sub: "", run: c.run });
    }
  }
  return items.slice(0, 9);
}

let currentItems = [];
function renderResults() {
  const q = addr.value;
  currentItems = candidates(q);
  selIndex = currentItems.length ? 0 : -1;
  addr.setAttribute("aria-expanded", String(currentItems.length > 0 && document.activeElement === addr));
  if (!currentItems.length || document.activeElement !== addr) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = "";
    return;
  }
  resultsEl.hidden = false;
  resultsEl.innerHTML = currentItems.map((it, i) =>
    `<button class="result${i === selIndex ? " sel" : ""}" role="option" data-i="${i}"`
    + ` aria-selected="${i === selIndex}">`
    + `<span class="kind">${it.kind}</span>`
    + `<span><span>${esc(it.title)}</span>`
    + (it.sub ? `<span class="sub">${esc(it.sub)}</span>` : "") + `</span></button>`).join("");
}
function runSelected() {
  const it = currentItems[selIndex];
  if (!it) return false;
  it.run();
  return true;
}
function collapseResults() {
  resultsEl.hidden = true;
  resultsEl.innerHTML = "";
  currentItems = [];
  selIndex = -1;
  addr.setAttribute("aria-expanded", "false");
}

/* ---------------- actions ---------------- */
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 1800);
}

function expand() {
  document.body.classList.add("expanded");
  $("#expander").setAttribute("aria-hidden", "false");
}
function maybeCollapse() {
  if (document.body.classList.contains("pinned")) return;
  if (sidebar.contains(document.activeElement)) return;
  document.body.classList.remove("expanded");
  $("#expander").setAttribute("aria-hidden", "true");
}

const actions = {
  "back": () => { const w = activeWs(); const t = tabOf(w, w.activeTab); if (t) { histGo(t, -1); render(); } },
  "fwd": () => { const w = activeWs(); const t = tabOf(w, w.activeTab); if (t) { histGo(t, +1); render(); } },
  "reload": () => {
    const page = $("#page");
    page.classList.add("flash");
    setTimeout(() => page.classList.remove("flash"), 130);
  },
  "newtab": () => { openTab(activeWs(), "aequera:newtab", "New Tab"); expand(); addr.focus(); addr.select(); render(); renderResults(); },
  "win-close": () => toast("Prototype — window controls are decorative."),
  "win-min": () => { document.body.classList.remove("expanded", "pinned"); syncPin(); },
  "win-pin": () => {
    document.body.classList.toggle("pinned");
    if (document.body.classList.contains("pinned")) expand();
    syncPin();
  },
};
function syncPin() {
  const pinned = document.body.classList.contains("pinned");
  document.querySelector('.tl.max').setAttribute("aria-pressed", String(pinned));
}

document.addEventListener("click", (ev) => {
  const close = ev.target.closest("[data-close]");
  if (close) {
    ev.stopPropagation();
    const w = activeWs();
    closeTab(w, Number(close.dataset.close));
    render();
    return;
  }
  const tab = ev.target.closest("[data-tab]");
  if (tab) {
    const w = activeWs();
    w.activeTab = Number(tab.dataset.tab);
    render();
    return;
  }
  const wsel = ev.target.closest("[data-ws]");
  if (wsel) {
    store.activeWs = Number(wsel.dataset.ws);
    collapseResults();
    render();
    return;
  }
  const res = ev.target.closest(".result");
  if (res) {
    const it = currentItems[Number(res.dataset.i)];
    if (it) {
      it.run();
      addr.value = "";
      collapseResults();
      render();
      addr.blur();
    }
    return;
  }
  const act = ev.target.closest("[data-act]");
  if (act && actions[act.dataset.act]) {
    actions[act.dataset.act]();
    return;
  }
  if (ev.target.closest("#addr-pill")) {
    expand();
    addr.focus();
    addr.select();
  }
});

sidebar.addEventListener("mouseenter", expand);
sidebar.addEventListener("mouseleave", maybeCollapse);
addr.addEventListener("focus", () => { expand(); renderResults(); });
addr.addEventListener("blur", () => setTimeout(() => { collapseResults(); maybeCollapse(); }, 120));
addr.addEventListener("input", renderResults);
addr.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (!currentItems.length) return;
    selIndex = (selIndex + (ev.key === "ArrowDown" ? 1 : -1) + currentItems.length) % currentItems.length;
    renderResultsKeepQuery();
  } else if (ev.key === "Enter") {
    if (currentItems.length && selIndex >= 0 && runSelected()) {
      addr.value = "";
      collapseResults();
      render();
      addr.blur();
    } else {
      const w = activeWs();
      const t = tabOf(w, w.activeTab);
      if (t && addr.value.trim()) {
        navigate(t, addr.value);
        addr.value = "";
        collapseResults();
        render();
        addr.blur();
      }
    }
  } else if (ev.key === "Escape") {
    addr.value = "";
    collapseResults();
    addr.blur();
    maybeCollapse();
  }
});
function renderResultsKeepQuery() {
  // Re-render highlight without resetting selection to the top.
  const keep = selIndex;
  renderResults();
  selIndex = keep;
  [...resultsEl.children].forEach((el, i) => {
    el.classList.toggle("sel", i === selIndex);
    el.setAttribute("aria-selected", String(i === selIndex));
  });
}

document.addEventListener("keydown", (ev) => {
  const typing = document.activeElement === addr;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    expand();
    addr.focus();
    addr.select();
    return;
  }
  if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key >= "1" && ev.key <= "9") {
    const w = activeWs();
    const t = w.tabs[Number(ev.key) - 1];
    if (t) { w.activeTab = t.id; render(); }
  } else if (ev.key === "Escape") {
    maybeCollapse();
  }
});

/* ---------------- tuning: density + live geometry/motion ----------------
   Density presets rescale every control (compact/default/large); numeric
   fields overlay individual axes. Persisted to localStorage — this machine
   only, cleared by Reset. */
const TUNE_KEY = "aequera-proto-tune";
const DENSITY_BASE = {
  compact: { rail: 48, gap: 4 },
  default: { rail: 56, gap: 6 },
  large: { rail: 68, gap: 8 },
};
const TUNE_DEFAULTS = { density: "default", dur: 140, rail: null, gap: null, rad: 10, blur: 24 };

let tune = (() => {
  try {
    const raw = localStorage.getItem(TUNE_KEY);
    if (raw) return { ...structuredClone(TUNE_DEFAULTS), ...JSON.parse(raw) };
  } catch { /* private mode: tuning stays session-only */ }
  return { ...TUNE_DEFAULTS };
})();

function saveTune() {
  try { localStorage.setItem(TUNE_KEY, JSON.stringify(tune)); } catch { /* session-only */ }
}
function effRail() { return tune.rail ?? DENSITY_BASE[tune.density].rail; }
function effGap() { return tune.gap ?? DENSITY_BASE[tune.density].gap; }

function applyTune() {
  document.body.dataset.density = tune.density;
  const root = document.documentElement.style;
  root.setProperty("--dur", tune.dur + "ms");
  root.setProperty("--rail-w", effRail() + "px");
  root.setProperty("--gap", effGap() + "px");
  root.setProperty("--radius", tune.rad + "px");
  root.setProperty("--blur", tune.blur + "px");
  document.querySelectorAll("[data-density]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.density === tune.density)));
  $("#t-dur").value = tune.dur;
  $("#t-dur-v").textContent = tune.dur + "ms";
  $("#t-rail").value = effRail();
  $("#t-gap").value = effGap();
  $("#t-rad").value = tune.rad;
  $("#t-blur").value = tune.blur;
}

document.querySelectorAll("[data-density]").forEach((b) =>
  b.addEventListener("click", () => { tune.density = b.dataset.density; applyTune(); saveTune(); }));
$("#t-dur").addEventListener("input", (ev) => {
  tune.dur = Number(ev.target.value);
  applyTune(); saveTune();
});
for (const [id, key] of [["t-rail", "rail"], ["t-gap", "gap"], ["t-rad", "rad"], ["t-blur", "blur"]]) {
  $("#" + id).addEventListener("change", (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v)) { tune[key] = v; applyTune(); saveTune(); }
  });
}
$("#t-replay").addEventListener("click", () => {
  // Collapse and re-expand so the current duration can be felt in isolation.
  document.body.classList.remove("expanded");
  void sidebar.offsetWidth;
  expand();
});
$("#t-reset").addEventListener("click", () => {
  tune = { ...TUNE_DEFAULTS };
  applyTune(); saveTune();
  toast("Tuning reset to defaults.");
});
$("#tune-toggle").addEventListener("click", () => {
  const panel = $("#tune");
  const show = panel.hidden;
  panel.hidden = !show;
  $("#tune-toggle").setAttribute("aria-expanded", String(show));
});

/* ---------------- frame meter (local only) ---------------- */
let last = performance.now(), ema = 16.7, frames = 0, lastPaint = performance.now();
function meter(now) {
  const dt = now - last;
  last = now;
  if (dt < 250) ema = ema * 0.9 + dt * 0.1; // ignore tab-switch gaps
  frames++;
  if (now - lastPaint > 500) {
    lastPaint = now;
    $("#fps").textContent = `${Math.round(1000 / ema)} fps · ${ema.toFixed(1)} ms`;
  }
  requestAnimationFrame(meter);
}

applyTune();
render();
requestAnimationFrame(meter);
