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

/* Library data: history is live-logged by navigate(); bookmarks are curated
   seeds; recently-closed derives from every workspace's closed stack. */
store.history = [
  { url: "https://developer.mozilla.org", title: "MDN Web Docs", at: 3 },
  { url: "https://example.org/papers", title: "Reading list", at: 2 },
  { url: "https://firefox-source-docs.mozilla.org", title: "Firefox Source Docs", at: 1 },
];
store.bookmarks = [
  { url: "https://developer.mozilla.org", title: "MDN Web Docs" },
  { url: "https://example.org/papers", title: "Reading list" },
  { url: "aequera:start", title: "Aequera Start" },
];
let libraryView = null; // null | "history" | "bookmarks" | "closed"

function recentClosed() {
  const all = [];
  for (const w of store.workspaces) {
    for (let i = w.closed.length - 1; i >= 0; i--) {
      all.push({ ws: w.name, tab: w.closed[i].tab });
    }
  }
  return all.slice(0, 20);
}

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
  libraryView = null;
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
function createWorkspace() {
  const id = nid();
  store.workspaces.push({ id, name: `Workspace ${store.workspaces.length + 1}`,
                          tabs: [], activeTab: null, closed: [] });
  store.activeWs = id;
  return id;
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
  libraryView = null;
  // Live history: newest first, deduped consecutively, capped.
  if (!store.history.length || store.history[0].url !== url) {
    store.history.unshift({ url, title, at: Date.now() });
    store.history = store.history.slice(0, 50);
  }
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
  renderTabs(); renderLibrary(); renderPinbar(); renderBookmarkbar(); renderPage();
}

/* Bookmark toolbar: horizontal strip under the top bar, Firefox-style
   visibility modes. Hidden by default — hovering (or tabbing into) the top
   bar reveals it on the shared frame as the page card yields, exactly like
   the rail widens: no layout shift, no reserved space.
   Never is the full opt-out; Always pins it (content shifts, like
   Firefox's pinned toolbar); New tab only pins it on new-tab pages. */
const BBMODES = ["hover", "always", "newtab", "never"];
const BB_DEFAULT = "hover";
function validBBMode(v) { return BBMODES.includes(v) ? v : BB_DEFAULT; }
let bbHover = false; // pointer inside topbar-or-strip
let bbFocus = false; // keyboard focus inside topbar-or-strip
function bbPinned() {
  if (tune.bookmarkbar === "always") return true;
  if (tune.bookmarkbar === "newtab") {
    const w = activeWs();
    const t = w && tabOf(w, w.activeTab);
    return !!t && t.url === "aequera:newtab";
  }
  return false;
}
function bbShown() {
  if (tune.bookmarkbar === "never") return false;
  return bbPinned() || tune.bookmarkbar === "hover" && (bbHover || bbFocus);
}
function renderBookmarkbar() {
  const pinned = bbPinned();
  document.body.classList.toggle("has-bb", pinned);
  const bar = $("#bookmarkbar");
  bar.innerHTML = store.bookmarks.map((b, i) =>
    `<button class="bb-chip" data-bb="${i}" title="${esc(b.title)} · ${esc(b.url)}">`
    + `<img src="${fav(b.url)}" alt=""><span>${esc(b.title)}</span></button>`).join("");
  updateBBVisibility();
}
/* Open/close is a class flip only: CSS clips the page card back to uncover
   the frame and wipes the chips in (see styles.css). Closed, the strip is inert so it
   takes no hits, focus, or AT attention while it animates out. */
function updateBBVisibility() {
  const show = bbShown();
  $("#bookmarkbar").inert = !show;
  document.body.classList.toggle("bb-open", show);
}
/* The strip is a child of the top bar, so one hover/focus region covers
   both: moving from bar to strip keeps it open; leaving the bar closes it.
   Focus mirrors hover for keyboard. */
{
  const topbar = $("#topbar");
  topbar.addEventListener("mouseenter", () => { bbHover = true; updateBBVisibility(); });
  topbar.addEventListener("mouseleave", () => { bbHover = false; updateBBVisibility(); });
  topbar.addEventListener("focusin", () => { bbFocus = true; updateBBVisibility(); });
  topbar.addEventListener("focusout", (ev) => {
    if (!topbar.contains(ev.relatedTarget)) { bbFocus = false; updateBBVisibility(); }
  });
}

/* Pinned pills: one icon button per pinned tab across all workspaces.
   Created only by drag-to-pin; the bar reclaims the space on last unpin. */
function findTab(id) {
  const num = Number(id);
  for (const w of store.workspaces) {
    const tab = w.tabs.find((t) => t.id === num);
    if (tab) return { ws: w, tab };
  }
  return null;
}
function renderPinbar() {
  const pins = [];
  for (const w of store.workspaces) {
    for (const t of w.tabs) {
      if (t.pinned) pins.push({ ws: w, tab: t });
    }
  }
  $("#pinbar").innerHTML = pins.map(({ ws, tab }) =>
    `<button class="pinpill" draggable="true" data-pinpill="${tab.id}"`
    + ` aria-selected="${ws.id === store.activeWs && tab.id === ws.activeTab}"`
    + ` aria-label="${esc(tab.title)} · ${esc(ws.name)} (pinned)" title="${esc(tab.title)} · ${esc(ws.name)} — drag back to unpin">`
    + `<img src="${tab.fav}" alt=""></button>`).join("");
}

/* Library section: History / Bookmarks / Recently closed as tab-geometry
   rows (icons alone collapsed, labels wiped in expanded). Counts live. */
const LIB_DEFS = [
  { kind: "history", label: "History", icon: "◷" },
  { kind: "bookmarks", label: "Bookmarks", icon: "★" },
  { kind: "closed", label: "Recently closed", icon: "↺" },
];
/* Library: Settings / History / Bookmarks / Recently closed, always shown
   directly — no folding, no accordion. Stacked icon boxes collapsed; one
   centered horizontal icon line expanded. Counts live. */
function libCount(kind) {
  if (kind === "history") return store.history.length;
  if (kind === "bookmarks") return store.bookmarks.length;
  return recentClosed().length;
}
function renderLibrary() {
  const tuneOpen = !$("#tune").hidden;
  $("#lib-list").innerHTML =
    `<button class="tab-row" data-act="settings" data-tune-toggle aria-label="Settings" aria-expanded="${tuneOpen}" title="Settings">`
    + `<span class="nic" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.4v2.1M8 12.5v2.1M1.4 8h2.1M12.5 8h2.1M3.3 3.3l1.5 1.5M11.2 11.2l1.5 1.5M12.7 3.3l-1.5 1.5M4.8 11.2l-1.5 1.5"/></g></svg></span><span class="t">Settings</span>`
    + `</button>`
    + LIB_DEFS.map((d) =>
      `<button class="tab-row" data-lib="${d.kind}" aria-selected="${libraryView === d.kind}"`
      + ` aria-label="${d.label}, ${libCount(d.kind)} items" title="${d.label}">`
      + `<span class="nic" aria-hidden="true">${d.icon}</span>`
      + `<span class="t">${d.label}</span><span class="wn">${libCount(d.kind)}</span>`
      + `</button>`).join("");
}

/* One list for both states: collapsed shows favicons (CSS clips the rest),
   expanded reveals titles + URLs next to the unmoved icons. */
function renderTabs() {
  const w = activeWs();
  $("#tab-list").innerHTML = w.tabs.map((t) =>
    `<li><button class="tab-row${t.pinned ? " pinned" : ""}" role="tab" data-tab="${t.id}" draggable="true"`
    + ` aria-selected="${t.id === w.activeTab}" aria-label="${esc(t.title)}" title="Drag to the top bar to pin">`
    + `<img src="${t.fav}" alt="">`
    + `<span class="t">${esc(t.title)}</span>`
    + `<span class="x" role="button" tabindex="-1" data-close="${t.id}" aria-label="Close ${esc(t.title)}">×</span>`
    + `</button></li>`).join("")
    // New tab speaks the same row language: icon box only, no label —
    // it aligns with favicons in every state by sharing .tab-row geometry.
    + `<li><button id="newtab-rail" class="tab-row" data-act="newtab" aria-label="New tab">`
    + `<span class="nic" aria-hidden="true">+</span>`
    + `</button></li>`;
  $("#ws-dots .clip").innerHTML = `<div class="scroll">` + store.workspaces.map((x) =>
    `<button data-ws="${x.id}" aria-selected="${x.id === store.activeWs}"`
    + ` aria-label="${esc(x.name)}, ${x.tabs.length} tabs" title="${esc(x.name)}">`
    + `<span class="wdot"></span></button>`).join("") + `</div>`;
  $("#ws-rows .clip").innerHTML = `<div class="scroll">` + store.workspaces.map((x) =>
    `<button class="tab-row" data-ws="${x.id}" aria-selected="${x.id === store.activeWs}"`
    + ` aria-label="${esc(x.name)}, ${x.tabs.length} tabs">`
    + `<span class="wdot"></span><span class="t">${esc(x.name)}</span>`
    + `<span class="wn">${x.tabs.length}</span></button>`).join("")
    + `<button class="tab-row" data-act="new-workspace" aria-label="New workspace">`
    + `<span class="nic" aria-hidden="true">+</span><span class="t">New workspace</span>`
    + `</button></div>`;
  revealActive("#ws-dots");
  revealActive("#ws-rows");
  positionWsIndicator();
}

/* Keep the active workspace inside its scroll window (both layers cap at
   5 visible). No-op when everything fits. Also marks overflowing layers so
   CSS can hint scrollability (scrollbars stay hidden by design). */
function revealActive(layerSel) {
  const sc = document.querySelector(layerSel + " .scroll");
  const btn = sc && sc.querySelector(`[data-ws="${store.activeWs}"]`);
  if (!sc || !btn) return;
  sc.classList.toggle("scrollable", sc.scrollHeight > sc.clientHeight + 1);
  const top = btn.offsetTop - sc.offsetTop;
  if (top < sc.scrollTop) sc.scrollTop = top;
  else if (top + btn.offsetHeight > sc.scrollTop + sc.clientHeight) {
    sc.scrollTop = top + btn.offsetHeight - sc.clientHeight;
  }
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
  // offsetTop is layout position; subtract the scroller offset so the dot
  // tracks the VISIBLE button when the dock is scrolled.
  const scroller = document.querySelector("#ws-dots .scroll");
  const scrolled = scroller ? scroller.scrollTop : 0;
  const y = active.offsetTop - scrolled + (active.offsetHeight - INDICATOR_SIZE) / 2;
  ind.style.transform = `translateY(${y}px)`;
}

function renderPage() {
  const page = $("#page");
  if (libraryView) {
    renderLibraryView(page);
    return;
  }
  const w = activeWs();
  const t = w && tabOf(w, w.activeTab);
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

/* Library content view: click an entry to open it in the active workspace
   (or a fresh tab when the workspace is empty). Back returns to the page. */
function libraryItems() {
  if (libraryView === "history") {
    return store.history.map((h) => ({ title: h.title, sub: h.url, url: h.url }));
  }
  if (libraryView === "bookmarks") {
    return store.bookmarks.map((b) => ({ title: b.title, sub: b.url, url: b.url }));
  }
  return recentClosed().map((c) => ({
    title: c.tab.title, sub: `${c.tab.url} · ${c.ws}`, url: c.tab.url,
  }));
}
function renderLibraryView(page) {
  const def = LIB_DEFS.find((d) => d.kind === libraryView);
  const items = libraryItems();
  page.innerHTML = `<div class="page-card lib-card"><h1>${def ? esc(def.label) : "Library"}</h1>`
    + `<p>${items.length} item${items.length === 1 ? "" : "s"}</p>`
    + `<div class="lib-list">` + items.map((it, i) =>
      `<button class="result" data-lib-open="${i}" role="listitem">`
      + `<span class="kind">${esc(def ? def.label : "")}</span>`
      + `<span><span>${esc(it.title)}</span><span class="sub">${esc(it.sub)}</span></span></button>`
      ).join("") + `</div>`
    + `<p><button data-lib-back>← Back to page</button></p></div>`;
}
function openOrNavigate(url, title) {
  const w = activeWs();
  const t = w && tabOf(w, w.activeTab);
  if (t) navigate(t, url);
  else openTab(w, url, title);
  render();
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
  const matchText = (title, url) =>
    !q || title.toLowerCase().includes(q) || url.toLowerCase().includes(q);
  for (const h of store.history) {
    if (matchText(h.title, h.url)) {
      items.push({ kind: "History", title: h.title, sub: h.url,
                   run: () => openOrNavigate(h.url, h.title) });
    }
  }
  for (const b of store.bookmarks) {
    if (matchText(b.title, b.url)) {
      items.push({ kind: "Bookmark", title: b.title, sub: b.url,
                   run: () => openOrNavigate(b.url, b.title) });
    }
  }
  for (const c of recentClosed()) {
    if (matchText(c.tab.title, c.tab.url)) {
      items.push({ kind: "Closed", title: c.tab.title, sub: `${c.tab.url} · ${c.ws}`,
                   run: () => openOrNavigate(c.tab.url, c.tab.title) });
    }
  }
  const cmds = [
    { title: "New tab", run: () => openTab(activeWs(), "aequera:newtab", "New Tab") },
    { title: "New workspace", run: () => { createWorkspace(); } },
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

/* Expansion state machine: expanded while PINNED, hovered, address-focused,
   or keyboard-focused inside the bar — collapsed only when all are false.
   expansionIntent() reads live state at decision time, so a click that moves
   focus into the bar never collapses it out from under the user. */
let hoverSide = false;
function expansionIntent() {
  return (
    document.body.classList.contains("pinned") ||
    hoverSide ||
    sidebar.contains(document.activeElement) ||
    document.activeElement === addr
  );
}
function expand() {
  cancelHoverTimers();
  document.body.classList.add("expanded");
  // The dots lay out differently per state; reposition for the live one.
  positionWsIndicator();
}
function collapse() {
  cancelHoverTimers();
  document.body.classList.remove("expanded");
  positionWsIndicator();
}
/* Hover hysteresis: boundary jitter must never oscillate the bar. Expand is
   quick (a beat, to debounce single-frame flicker); collapse lingers so
   pointer travel to content, tune, or results never whiplashes. Either timer
   cancels the other, and explicit intents (focus, pin, replay) bypass both
   by calling expand()/collapse() directly. */
let expandTimer = 0;
let collapseTimer = 0;
function cancelHoverTimers() {
  clearTimeout(expandTimer);
  clearTimeout(collapseTimer);
}
function scheduleExpand() {
  clearTimeout(collapseTimer);
  clearTimeout(expandTimer);
  expandTimer = setTimeout(() => {
    if (expansionIntent()) expand();
  }, 40);
}
function scheduleCollapse() {
  clearTimeout(expandTimer);
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (!expansionIntent()) collapse();
  }, 150);
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
  "new-workspace": () => { createWorkspace(); render(); },
  "settings": () => toggleTune(),
  "win-close": () => toast("Prototype — window controls are decorative."),
  "win-min": () => { document.body.classList.remove("pinned"); collapse(); syncPin(); },
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
    libraryView = null;
    render();
    return;
  }
  const pill = ev.target.closest("[data-pinpill]");
  if (pill) {
    const found = findTab(pill.dataset.pinpill);
    if (found) {
      store.activeWs = found.ws.id;
      found.ws.activeTab = found.tab.id;
      libraryView = null;
      render();
    }
    return;
  }
  // Library rows/items/back must precede the generic .result branch: library
  // items reuse .result styling but carry data-lib-open instead of data-i.
  const libRow = ev.target.closest("[data-lib]");
  if (libRow) {
    libraryView = libRow.dataset.lib;
    render();
    return;
  }
  const libOpen = ev.target.closest("[data-lib-open]");
  if (libOpen) {
    const items = libraryItems();
    const it = items[Number(libOpen.dataset.libOpen)];
    if (it) openOrNavigate(it.url, it.title);
    return;
  }
  if (ev.target.closest("[data-lib-back]")) {
    libraryView = null;
    render();
    return;
  }
  const bb = ev.target.closest("[data-bb]");
  if (bb) {
    const b = store.bookmarks[Number(bb.dataset.bb)];
    if (b) openOrNavigate(b.url, b.title);
    return;
  }
  const wsel = ev.target.closest("[data-ws]");
  if (wsel) {
    store.activeWs = Number(wsel.dataset.ws);
    libraryView = null;
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

/* Drag-to-pin: rail tabs carry their id; the top bar accepts the drop and
   pins (creating a pill); dropping a pill back on the sidebar unpins.
   Foreign drags (text, files) are ignored via the dataTransfer type gate. */
function pinDragTypes(dt) {
  return dt && Array.prototype.slice.call(dt.types || []).indexOf("text/tab-id") >= 0;
}
document.addEventListener("dragstart", (ev) => {
  const pill = ev.target.closest && ev.target.closest("[data-pinpill]");
  const row = ev.target.closest && ev.target.closest("[data-tab]");
  const id = pill ? pill.dataset.pinpill : row ? row.dataset.tab : null;
  if (!id || !ev.dataTransfer) return;
  ev.dataTransfer.setData("text/tab-id", String(id));
  if (pill) ev.dataTransfer.setData("text/aequera-unpin", "1");
  ev.dataTransfer.effectAllowed = "move";
});
const topbar = $("#topbar");
topbar.addEventListener("dragover", (ev) => {
  if (!pinDragTypes(ev.dataTransfer)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
  topbar.classList.add("pinning");
});
topbar.addEventListener("dragleave", () => topbar.classList.remove("pinning"));
topbar.addEventListener("drop", (ev) => {
  topbar.classList.remove("pinning");
  if (!pinDragTypes(ev.dataTransfer)) return;
  ev.preventDefault();
  const found = findTab(ev.dataTransfer.getData("text/tab-id"));
  if (!found || found.tab.pinned) return;
  found.tab.pinned = true;
  render();
  toast(`Pinned “${found.tab.title}”.`);
});
sidebar.addEventListener("dragover", (ev) => {
  if (!pinDragTypes(ev.dataTransfer)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
});
sidebar.addEventListener("drop", (ev) => {
  if (!pinDragTypes(ev.dataTransfer)) return;
  if (Array.prototype.indexOf.call(ev.dataTransfer.types || [], "text/aequera-unpin") < 0) return;
  ev.preventDefault();
  const found = findTab(ev.dataTransfer.getData("text/tab-id"));
  if (!found || !found.tab.pinned) return;
  found.tab.pinned = false;
  render();
});

sidebar.addEventListener("mouseenter", () => { hoverSide = true; scheduleExpand(); });
sidebar.addEventListener("mouseleave", () => { hoverSide = false; scheduleCollapse(); });
sidebar.addEventListener("focusin", scheduleExpand);
sidebar.addEventListener("focusout", scheduleCollapse);
addr.addEventListener("focus", () => { expand(); renderResults(); });
addr.addEventListener("blur", () => {
  // Results hide on their own click-safe delay; the collapse check starts
  // immediately in parallel instead of stacking behind it, so deselecting
  // the address bar answers in ~150ms rather than ~270ms. Both re-verify
  // intent at fire time, so a focus move into the bar still holds it open.
  setTimeout(collapseResults, 120);
  scheduleCollapse();
});
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
    collapse();
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
    if (t) { w.activeTab = t.id; libraryView = null; render(); }
  } else if (ev.key === "Escape") {
    scheduleCollapse();
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
  top: 42, rail: 42, panel: 220, ctl: 30, rpy: 7, rpx: 7,
  gap: 6, rad: 9,
  blur: 24, sat: 1.5, dur: 250, fs: 14, tl: 12, easing: "swift",
};
const PROFILE_DELTA = {
  minus:   { top: -6, rail: -8, panel: -32, ctl: -6, rpy: -2, rpx: -2, gap: -2, rad: -2, fs: -1 },
  default: {},
  plus:    { top: 6, rail: 12, panel: 32, ctl: 8, rpy: 2, rpx: 2, gap: 2, rad: 2, fs: 1 },
};
const EASINGS = {
  snappy: "cubic-bezier(0.2,0.9,0.25,1)",
  smooth: "cubic-bezier(0.4,0,0.2,1)",
  swift: "cubic-bezier(0.3,0.7,0.3,1)",
};
/* input id, token key, unit, decimals */
const TUNE_FIELDS = [
  ["t-top", "top"], ["t-rail", "rail"], ["t-panel", "panel"], ["t-ctl", "ctl"],
  ["t-rpy", "rpy"], ["t-rpx", "rpx"],
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
                 easing: p.easing ?? BASEMENT.easing, custom: p.custom || {},
                 bookmarkbar: validBBMode(p.bookmarkbar) };
      }
    }
  } catch { /* private mode: tuning stays session-only */ }
  return { profile: "default", dur: BASEMENT.dur, easing: BASEMENT.easing, custom: {},
           bookmarkbar: BB_DEFAULT };
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
  root.setProperty("--row-py", eff("rpy") + "px");
  root.setProperty("--row-px", eff("rpx") + "px");
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
  $("#t-bbmode").value = tune.bookmarkbar;
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
$("#t-bbmode").addEventListener("change", (ev) => {
  if (BBMODES.includes(ev.target.value)) {
    tune.bookmarkbar = ev.target.value;
    applyTune(); saveTune(); render();
  }
});
for (const [id, key] of TUNE_FIELDS) {
  const input = $("#" + id);
  input.title = "Double-click to clear this override";
  input.addEventListener("change", (ev) => {
    const v = Number(ev.target.value);
    if (Number.isFinite(v)) { tune.custom[key] = v; applyTune(); saveTune(); }
  });
  input.addEventListener("dblclick", () => {
    delete tune.custom[key];
    applyTune(); saveTune();
  });
}
$("#t-replay").addEventListener("click", () => {
  // Collapse and re-expand so the current duration can be felt in isolation.
  cancelHoverTimers();
  document.body.classList.remove("expanded");
  void sidebar.offsetWidth;
  expand();
});
$("#t-reset").addEventListener("click", () => {
  tune = { profile: "default", dur: BASEMENT.dur, easing: BASEMENT.easing, custom: {},
           bookmarkbar: BB_DEFAULT };
  applyTune(); saveTune(); render();
  toast("Tuning reset to basement default profile.");
});
function toggleTune() {
  const panel = $("#tune");
  const show = panel.hidden;
  panel.hidden = !show;
  document.querySelectorAll("[data-tune-toggle]").forEach((b) =>
    b.setAttribute("aria-expanded", String(show)));
}
$("#tune-toggle").addEventListener("click", toggleTune);

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
