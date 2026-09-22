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
      activeTab: 3, closed: [],
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
  if (/^aequera:/i.test(url)) {
    return faviconSvg("A", 220);
  }
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ""); }
  catch { /* custom schemes keep the raw string */ }
  const letter = (host[0] || "?").toUpperCase();
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return faviconSvg(letter, h);
}

function faviconSvg(letter, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">`
    + `<rect width="32" height="32" rx="7" fill="hsl(${hue},55%,42%)"/>`
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
  renderTabs(); renderPage();
}

/* One list for both states: collapsed shows favicons (CSS clips the rest),
   expanded reveals titles + URLs next to the unmoved icons. */
function renderTabs() {
  const w = activeWs();
  $("#tab-list").innerHTML = w.tabs.map((t) =>
    `<li><button class="tab-row${t.pinned ? " pinned" : ""}" role="tab" data-tab="${t.id}"`
    + ` aria-selected="${t.id === w.activeTab}" aria-label="${esc(t.title)}">`
    + `<img src="${t.fav}" alt="">`
    + `<span class="t">${esc(t.title)}<small>${esc(t.url)}</small></span>`
    + `<span class="x" role="button" tabindex="-1" data-close="${t.id}" aria-label="Close ${esc(t.title)}">×</span>`
    + `</button></li>`).join("");
  $("#ws-dots").innerHTML = store.workspaces.map((x) =>
    `<button data-ws="${x.id}" aria-selected="${x.id === store.activeWs}"`
    + ` aria-label="${esc(x.name)}, ${x.tabs.length} tabs" title="${esc(x.name)}">`
    + `<span class="wdot"></span><span class="wname">${esc(x.name)}</span>`
    + `<span class="wn">${x.tabs.length}</span></button>`).join("");
  positionWsIndicator();
}

/* Glide the active-workspace dot to its new home. Pure transform, so a
   rapid re-switch supersedes the running animation instead of queueing.
   Position math uses constants, never measured sizes: measuring is wrong
   whenever the indicator is hidden (display:none reports height 0, which
   used to land the dot 5px low after switching while expanded). */
const INDICATOR_SIZE = 10;
function positionWsIndicator() {
  const ind = $("#ws-indicator");
  const active = document.querySelector(`#ws-dots [data-ws="${store.activeWs}"]`);
  if (!active) {
    ind.style.opacity = "0";
    return;
  }
  ind.style.opacity = "1";
  const y = active.offsetTop + (active.offsetHeight - INDICATOR_SIZE) / 2;
  ind.style.transform = `translateY(${y}px)`;
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
}
function maybeCollapse() {
  if (document.body.classList.contains("pinned")) return;
  if (sidebar.contains(document.activeElement)) return;
  document.body.classList.remove("expanded");
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

/* ---------------- tuning: basement, profiles, custom overlays --------
   BASEMENT is the single source of truth under test. Profiles apply deltas
   over it (minus / default / plus); any edited field becomes a custom
   overlay (accent-bordered) that survives profile switches. The user will
   later declare the winning basement; until then everything stays editable.
   Persisted to localStorage — this machine only. */
const TUNE_KEY = "aequera-proto-tune-v2";
const BASEMENT = {
  top: 52, rail: 56, panel: 272, ctl: 34, row: 38, gap: 6, rad: 10,
  blur: 24, sat: 1.5, dur: 140, fs: 13, tl: 12, easing: "snappy",
};
const PROFILE_DELTA = {
  minus:   { top: -6, rail: -8, panel: -32, ctl: -6, row: -8, gap: -2, rad: -2, fs: -1 },
  default: {},
  plus:    { top: 6, rail: 12, panel: 32, ctl: 8, row: 8, gap: 2, rad: 2, fs: 1 },
};
const EASINGS = {
  snappy: "cubic-bezier(0.2,0.9,0.25,1)",
  smooth: "cubic-bezier(0.4,0,0.2,1)",
  swift: "cubic-bezier(0.3,0.7,0.3,1)",
};
/* input id, token key, unit, decimals */
const TUNE_FIELDS = [
  ["t-top", "top"], ["t-rail", "rail"], ["t-panel", "panel"], ["t-ctl", "ctl"], ["t-row", "row"],
  ["t-gap", "gap"], ["t-rad", "rad"], ["t-blur", "blur"], ["t-sat", "sat"],
  ["t-fs", "fs"], ["t-tl", "tl"],
];

let tune = (() => {
  try {
    const raw = localStorage.getItem(TUNE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && PROFILE_DELTA[p.profile]) {
        return { profile: p.profile, dur: p.dur ?? BASEMENT.dur,
                 easing: p.easing ?? BASEMENT.easing, custom: p.custom || {} };
      }
    }
  } catch { /* private mode: tuning stays session-only */ }
  return { profile: "default", dur: BASEMENT.dur, easing: BASEMENT.easing, custom: {} };
})();

function saveTune() {
  try { localStorage.setItem(TUNE_KEY, JSON.stringify(tune)); } catch { /* session-only */ }
}
/* Effective value: custom overlay wins, else basement + profile delta. */
function eff(key) {
  if (tune.custom[key] !== undefined) return tune.custom[key];
  if (key === "dur") return tune.dur;
  if (key === "easing") return tune.easing;
  return BASEMENT[key] + (PROFILE_DELTA[tune.profile][key] || 0);
}

function applyTune() {
  const root = document.documentElement.style;
  root.setProperty("--dur", eff("dur") + "ms");
  root.setProperty("--snap", EASINGS[tune.easing] || EASINGS.snappy);
  root.setProperty("--top-h", eff("top") + "px");
  root.setProperty("--rail-w", eff("rail") + "px");
  root.setProperty("--panel-w", eff("panel") + "px");
  root.setProperty("--ctl", eff("ctl") + "px");
  root.setProperty("--row-h", eff("row") + "px");
  root.setProperty("--gap", eff("gap") + "px");
  root.setProperty("--radius", eff("rad") + "px");
  root.setProperty("--blur", eff("blur") + "px");
  root.setProperty("--sat", eff("sat"));
  root.setProperty("--fs", eff("fs") + "px");
  root.setProperty("--tl", eff("tl") + "px");
  document.querySelectorAll("[data-profile]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.profile === tune.profile)));
  $("#t-dur").value = eff("dur");
  $("#t-dur-v").textContent = eff("dur") + "ms";
  $("#t-ease").value = tune.easing;
  for (const [id, key] of TUNE_FIELDS) {
    const input = $("#" + id);
    input.value = eff(key);
    input.classList.toggle("custom", tune.custom[key] !== undefined);
  }
  const ease = $("#t-ease");
  ease.classList.toggle("custom", tune.easing !== BASEMENT.easing);
}

document.querySelectorAll("[data-profile]").forEach((b) =>
  b.addEventListener("click", () => { tune.profile = b.dataset.profile; applyTune(); saveTune(); }));
$("#t-dur").addEventListener("input", (ev) => {
  tune.dur = Number(ev.target.value);
  applyTune(); saveTune();
});
$("#t-ease").addEventListener("change", (ev) => {
  if (EASINGS[ev.target.value]) { tune.easing = ev.target.value; applyTune(); saveTune(); }
});
for (const [id, key] of TUNE_FIELDS) {
  $("#" + id).addEventListener("change", (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v)) { tune.custom[key] = v; applyTune(); saveTune(); }
  });
}
$("#t-replay").addEventListener("click", () => {
  // Collapse and re-expand so the current duration can be felt in isolation.
  document.body.classList.remove("expanded");
  void sidebar.offsetWidth;
  expand();
});
$("#t-reset").addEventListener("click", () => {
  tune = { profile: "default", dur: BASEMENT.dur, easing: BASEMENT.easing, custom: {} };
  applyTune(); saveTune();
  toast("Tuning reset to basement default profile.");
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
// Testing aid: index.html#expanded opens the sidebar pinned (shareable state).
if (location.hash === "#expanded") {
  document.body.classList.add("expanded", "pinned");
  syncPin();
}
render();
requestAnimationFrame(meter);
