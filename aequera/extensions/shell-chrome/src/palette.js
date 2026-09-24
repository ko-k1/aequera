/* Aequera palette ranking — pure function, no browser.* dependency.
 *
 * Ports prototype/shell/app.js candidates(q) semantics 1:1 so the extension
 * command surface filters exactly like the proven prototype:
 * - query trimmed + lowercased; empty query returns everything;
 * - section order: Tab, Workspace, History, Bookmark, Closed, Command;
 * - substring match on title/url (tabs, history, bookmarks, closed) or
 *   name (workspaces) or command title;
 * - "Restore closed tab" offered only when canRestore is true;
 * - result list capped at 9.
 *
 * Sources are plain data so this file is unit-testable under node --test.
 * Live gathering and action execution live in background.js.
 */

const PALETTE_CAP = 9;

function matchText(q, title, url) {
  if (!q) return true;
  return (
    (title || "").toLowerCase().includes(q) ||
    (url || "").toLowerCase().includes(q)
  );
}

/**
 * @param {string} query raw user input
 * @param {object} sources { tabs, workspaces, history, bookmarks, closed, canRestore }
 *   tabs: [{ title, url, workspace, tabId, windowId }]
 *   workspaces: [{ name, tabCount, windowId }]
 *   history/bookmarks: [{ title, url }]
 *   closed: [{ title, url, workspace }]
 * @returns {Array<{ kind, title, sub, action }>} capped at PALETTE_CAP
 */
function rankCandidates(query, sources) {
  const q = (query || "").trim().toLowerCase();
  const items = [];
  const tabs = sources.tabs || [];
  const workspaces = sources.workspaces || [];

  for (const t of tabs) {
    if (matchText(q, t.title, t.url)) {
      items.push({
        kind: "Tab",
        title: t.title,
        sub: `${t.url} · ${t.workspace}`,
        action: { type: "switch-tab", tabId: t.tabId, windowId: t.windowId },
      });
    }
  }
  for (const w of workspaces) {
    if (!q || (w.name || "").toLowerCase().includes(q)) {
      items.push({
        kind: "Workspace",
        title: w.name,
        sub: `${w.tabCount} tabs`,
        action: { type: "switch-workspace", windowId: w.windowId },
      });
    }
  }
  for (const h of sources.history || []) {
    if (matchText(q, h.title, h.url)) {
      items.push({
        kind: "History",
        title: h.title,
        sub: h.url,
        action: { type: "open-url", url: h.url, title: h.title },
      });
    }
  }
  for (const b of sources.bookmarks || []) {
    if (matchText(q, b.title, b.url)) {
      items.push({
        kind: "Bookmark",
        title: b.title,
        sub: b.url,
        action: { type: "open-url", url: b.url, title: b.title },
      });
    }
  }
  for (const c of sources.closed || []) {
    if (matchText(q, c.title, c.url)) {
      items.push({
        kind: "Closed",
        title: c.title,
        sub: `${c.url} · ${c.workspace}`,
        action: { type: "open-url", url: c.url, title: c.title },
      });
    }
  }
  const cmds = [
    { title: "New tab", action: { type: "new-tab" } },
    { title: "New workspace", action: { type: "new-workspace" } },
    {
      title: "Restore closed tab",
      enabled: () => !!sources.canRestore,
      action: { type: "restore-closed" },
    },
  ];
  for (const c of cmds) {
    if (
      (!q || c.title.toLowerCase().includes(q)) &&
      (!c.enabled || c.enabled())
    ) {
      items.push({ kind: "Command", title: c.title, sub: "", action: c.action });
    }
  }
  return items.slice(0, PALETTE_CAP);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { rankCandidates, PALETTE_CAP };
}
