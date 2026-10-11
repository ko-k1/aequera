/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera command surface: pure model (no Firefox APIs; unit-tested with node).
//
// The address bar is the command surface (prototype/shell: one input for
// URL/search, tabs, workspaces, history, bookmarks, closed tabs, commands).
// Firefox's urlbar already covers URL/search, open tabs (across workspaces:
// selecting a hidden tab switches to its workspace), history, and bookmarks.
// This model adds the rest: workspaces, this window's closed tabs, and shell
// commands. A classic script for the same reason as workspace-model.js;
// defines AequeraCommandModel in the window and exports it under node.

var AequeraCommandModel = (() => {
  "use strict";

  /** At most this many Aequera rows per query, so Firefox's own results keep
   *  the rest of the list (Firefox caps its secondary actions at 3 too). */
  const MAX_ROWS = 3;

  /** Commands only match from this many characters on, so a one- or
   *  two-letter URL prefix does not push history aside with "New tab". */
  const COMMAND_MIN_LENGTH = 3;

  const COMMANDS = [
    { id: "new-tab", title: "New tab", keywords: ["open tab"] },
    { id: "new-workspace", title: "New workspace", keywords: ["create workspace", "add workspace"] },
    { id: "restore-closed", title: "Restore closed tab", keywords: ["reopen closed tab", "undo close tab"] },
  ];

  /** Lowercased, trimmed, whitespace-collapsed query. */
  function normalizeQuery(query) {
    return String(query ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  /**
   * Firefox's tab-group rule (ActionsProviderTabGroups): a single character
   * matches the start of a word, anything longer matches when every token
   * occurs somewhere in one of the texts.
   *
   * @param {string} query normalized query (normalizeQuery)
   * @param {...string} texts
   */
  function matches(query, ...texts) {
    if (!query) {
      return false;
    }
    const lowered = texts.filter(Boolean).map(text => String(text).toLowerCase());
    if (query.length === 1) {
      return lowered.some(text => text.split(/[\s/.:_-]+/).some(word => word.startsWith(query)));
    }
    const tokens = query.split(" ");
    return lowered.some(text => tokens.every(token => text.includes(token)));
  }

  /**
   * @typedef {{ id: string, name: string, tabCount: number }} WorkspaceSource
   * @typedef {{ closedId: number, title: string, url: string, workspace: string|null }} ClosedSource
   * @typedef {{ workspaces: WorkspaceSource[], active: string|null, closed: ClosedSource[] }} Sources
   *
   * @typedef {object} Row
   * @property {"workspace"|"closed"|"command"} kind
   * @property {string} title
   * @property {string} detail   short secondary text (action label)
   * @property {{ type: string, [key: string]: * }} action  plain data, run by the window
   */

  /**
   * The Aequera rows for a query, in prototype section order (workspaces,
   * closed tabs, commands), capped at MAX_ROWS. Empty query: no rows, so
   * Firefox's zero-prefix list (top sites) stays as it is.
   *
   * @param {string} query raw input
   * @param {Sources} sources
   * @returns {Row[]}
   */
  function rows(query, sources) {
    const q = normalizeQuery(query);
    if (!q) {
      return [];
    }
    const out = [];
    for (const w of sources.workspaces ?? []) {
      if (w.id !== sources.active && matches(q, w.name)) {
        const tabs = w.tabCount === 1 ? "1 tab" : `${w.tabCount ?? 0} tabs`;
        out.push({
          kind: "workspace",
          title: w.name,
          detail: `Switch to workspace · ${tabs}`,
          action: { type: "switch-workspace", id: w.id },
        });
      }
    }
    for (const c of sources.closed ?? []) {
      if (matches(q, c.title, c.url)) {
        out.push({
          kind: "closed",
          title: c.title || c.url || "",
          detail: c.workspace ? `Reopen closed tab · ${c.workspace}` : "Reopen closed tab",
          action: { type: "restore-closed", closedId: c.closedId },
        });
      }
    }
    if (q.length >= COMMAND_MIN_LENGTH) {
      const canRestore = (sources.closed ?? []).length > 0;
      for (const c of COMMANDS) {
        if (c.id === "restore-closed" && !canRestore) {
          continue;
        }
        if (matches(q, c.title, ...c.keywords)) {
          out.push({ kind: "command", title: c.title, detail: "Command", action: { type: "command", id: c.id } });
        }
      }
    }
    return out.slice(0, MAX_ROWS);
  }

  return { MAX_ROWS, COMMAND_MIN_LENGTH, COMMANDS, normalizeQuery, matches, rows };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraCommandModel;
}
