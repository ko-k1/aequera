/* Aequera shell-chrome wireup v0.
 *
 * Maps the prototype store (prototype/shell/app.js) and aequera-core
 * (Browser/Workspace/Tab) onto stable Firefox WebExtensions APIs:
 *
 *   Workspace <-> Firefox window (name kept in sessions window value "aequera-workspace")
 *   Tab       <-> browser.tabs tab (pinned via tabs.update)
 *   Closed    <-> browser.sessions recently-closed + restore
 *   Commands  <-> manifest command aequera-focus-command (palette focus hook)
 *
 * Boundaries (docs/ARCHITECTURE.md, docs/RESTRICTIONS.md):
 * - no fetch, no XMLHttpRequest, no WebSocket, no telemetry;
 * - least privilege: tabs, sessions, storage (v0 adapter) plus history,
 *   bookmarks (palette slice, read-only search; still no remote);
 * - no Firefox source patch; worktree/firefox stays clean;
 * - workspace persistence beyond window values is a later slice.
 */

const WS_KEY = "aequera-workspace";

// URL allowlist for open-url actions (RESTRICTIONS.md: customization must not
// become privilege escalation). Palette sources are history/bookmarks/closed
// URLs plus about:newtab; bookmarklets and other privileged schemes must never
// reach tabs.create through this path.
const ALLOWED_ABOUT_URLS = new Set(["about:newtab", "about:blank", "about:home"]);

function isAllowedUrl(raw) {
  if (typeof raw !== "string") return false;
  const url = raw.trim();
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return true;
  return ALLOWED_ABOUT_URLS.has(lower);
}

function assertTabId(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tabId must be an integer");
}

function assertWindowId(windowId) {
  if (!Number.isInteger(windowId)) throw new Error("windowId must be an integer");
}

// Only our own extension pages may drive palette actions. No
// externally_connectable is declared so web pages cannot reach this listener,
// but a compromised sibling context must not be able to escalate through it.
// Extension pages always carry a moz-extension:// URL; an empty sender is
// rejected so tests must exercise the real path.
function isTrustedSender(sender) {
  try {
    const url = (sender && sender.url) || "";
    if (!url) return false;
    // Prefer an exact own-extension prefix when available: any other
    // moz-extension:// uuid must not pass (RESTRICTIONS.md: extension
    // privilege boundaries).
    if (
      typeof browser !== "undefined" &&
      browser.runtime &&
      typeof browser.runtime.getURL === "function"
    ) {
      const ownPrefix = browser.runtime.getURL("");
      if (ownPrefix && url.startsWith(ownPrefix)) return true;
      if (browser.runtime.id && sender && sender.id) {
        return sender.id === browser.runtime.id && url.startsWith("moz-extension://");
      }
      return false;
    }
    if (typeof browser !== "undefined" && browser.runtime && browser.runtime.id) {
      if (sender && sender.id && sender.id !== browser.runtime.id) return false;
    }
    return url.startsWith("moz-extension://");
  } catch {
    return false;
  }
}

async function listWorkspaces() {
  const windows = await browser.windows.getAll({ populate: true });
  return Promise.all(
    windows.map(async (w) => ({
      windowId: w.id,
      name: (await browser.sessions.getWindowValue(w.id, WS_KEY)) || `Window ${w.id}`,
      tabs: (w.tabs || []).map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        pinned: t.pinned,
        active: t.active,
      })),
    })),
  );
}

async function createWorkspace(name) {
  if (!name || !name.trim()) throw new Error("name must not be empty");
  const win = await browser.windows.create({});
  await browser.sessions.setWindowValue(win.id, WS_KEY, name.trim());
  return win.id;
}

async function switchWorkspace(windowId) {
  assertWindowId(windowId);
  await browser.windows.update(windowId, { focused: true });
}

async function openTab(windowId, url) {
  assertWindowId(windowId);
  if (!isAllowedUrl(url)) throw new Error("refusing to open non-http(s)/about URL");
  const tab = await browser.tabs.create({ windowId, url });
  return tab.id;
}

async function switchTab(tabId) {
  assertTabId(tabId);
  await browser.tabs.update(tabId, { active: true });
  const tab = await browser.tabs.get(tabId);
  await browser.windows.update(tab.windowId, { focused: true });
}

async function closeTab(tabId) {
  assertTabId(tabId);
  await browser.tabs.remove(tabId);
}

async function restoreClosed() {
  const closed = await browser.sessions.getRecentlyClosed();
  const session = closed.find((s) => s.tab || s.window);
  if (!session) throw new Error("nothing to restore");
  await browser.sessions.restore(session.sessionId);
}

async function moveTab(tabId, windowId, index) {
  assertTabId(tabId);
  assertWindowId(windowId);
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
    throw new Error("index must be a non-negative integer");
  }
  await browser.tabs.move(tabId, { windowId, index });
}

async function togglePin(tabId) {
  assertTabId(tabId);
  const tab = await browser.tabs.get(tabId);
  await browser.tabs.update(tabId, { pinned: !tab.pinned });
  return !tab.pinned;
}

if (typeof browser !== "undefined" && browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener(async (command) => {
    if (command !== "aequera-focus-command") return;
    // v0: acknowledge the palette hook; the full command surface (filter across
    // workspaces/history/commands per prototype spec) is the next slice.
    await browser.storage.local.set({ "aequera.last-focus": Date.now() });
  });
}

/* Unified palette (prototype candidates(q) parity): gather live sources,
 * rank via rankCandidates from palette.js (loaded first in manifest),
 * execute the chosen action through the v0 adapter above. */

async function collectSources() {
  const windows = await browser.windows.getAll({ populate: true });
  const tabs = [];
  const workspaces = [];
  for (const w of windows) {
    const name =
      (await browser.sessions.getWindowValue(w.id, WS_KEY)) || `Window ${w.id}`;
    workspaces.push({ name, tabCount: (w.tabs || []).length, windowId: w.id });
    for (const t of w.tabs || []) {
      tabs.push({ title: t.title, url: t.url, workspace: name, tabId: t.id, windowId: w.id });
    }
  }
  const history = (await browser.history.search({ text: "", maxResults: 50 }))
    .filter((h) => isAllowedUrl(h.url))
    .map((h) => ({
      title: h.title, url: h.url,
    }));
  // Bookmark folders/separators have no URL; bookmarklets and other privileged
  // schemes are excluded here so the palette never shows an unopenable entry
  // (executeAction would otherwise throw on click).
  const bookmarks = (await browser.bookmarks.search({}))
    .filter((b) => isAllowedUrl(b.url))
    .slice(0, 50)
    .map((b) => ({
      title: b.title, url: b.url,
    }));
  const closedRaw = await browser.sessions.getRecentlyClosed();
  const closed = closedRaw
    .filter((s) => s.tab && isAllowedUrl(s.tab.url))
    .slice(0, 10)
    .map((s) => ({ title: s.tab.title, url: s.tab.url, workspace: "recently closed" }));
  return { tabs, workspaces, history, bookmarks, closed, canRestore: closedRaw.length > 0 };
}

async function executeAction(action) {
  if (!action || typeof action.type !== "string") throw new Error("action must have a type");
  switch (action.type) {
    case "switch-tab":
      assertTabId(action.tabId);
      return switchTab(action.tabId);
    case "switch-workspace":
      assertWindowId(action.windowId);
      return switchWorkspace(action.windowId);
    case "open-url": {
      const url = typeof action.url === "string" ? action.url.trim() : "";
      if (!isAllowedUrl(url)) throw new Error("refusing to open non-http(s)/about URL");
      const wins = await browser.windows.getAll({});
      if (!wins.length) throw new Error("no window to open in");
      const current = await browser.windows.getCurrent();
      const target = wins.some((w) => w.id === current.id) ? current.id : wins[0].id;
      return openTab(target, url);
    }
    case "new-tab": {
      const current = await browser.windows.getCurrent();
      return openTab(current.id, "about:newtab");
    }
    case "new-workspace":
      return createWorkspace("Workspace");
    case "restore-closed":
      return restoreClosed();
    default:
      throw new Error("unknown palette action: " + action.type);
  }
}

// Popup/sidebar pages (next slice) call: searchPalette(query) -> ranked items,
// then runtime.sendMessage({ aequeraRun: action }) to execute the choice.
async function searchPalette(query) {
  return rankCandidates(query, await collectSources());
}

if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener(async (msg, sender) => {
    if (!isTrustedSender(sender)) return undefined;
    if (msg && msg.aequeraRun) {
      await executeAction(msg.aequeraRun);
      return { ok: true };
    }
    if (msg && msg.aequeraSearch !== undefined) {
      if (typeof msg.aequeraSearch !== "string") throw new Error("aequeraSearch must be a string");
      return { items: await searchPalette(msg.aequeraSearch) };
    }
    return undefined;
  });
}

// Exported for tests / future shell wiring (extension pages import this file).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    WS_KEY,
    listWorkspaces,
    createWorkspace,
    switchWorkspace,
    openTab,
    switchTab,
    closeTab,
    restoreClosed,
    moveTab,
    togglePin,
    executeAction,
    searchPalette,
    collectSources,
    isAllowedUrl,
    isTrustedSender,
  };
}
