/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera command surface: window side. Loaded into each browser window by
// aequera-main.js. Gathers this window's sources (workspaces, closed tabs)
// for the pure model (command-model.js) and runs the actions of picked rows.
// The urlbar provider (aequera-urlbar.sys.mjs) is a thin bridge to here.

var AequeraCommand = (() => {
  const TAB_KEY = "aequera-workspace";

  // Registers the provider once per process; later windows reuse it.
  ChromeUtils.importESModule("chrome://browser/content/aequera/command/aequera-urlbar.sys.mjs");

  function workspaceSources() {
    const controller = window.AequeraWorkspaces;
    const state = controller?.state;
    if (!state) {
      return { workspaces: [], active: null };
    }
    const counts = new Map(state.workspaces.map(w => [w.id, 0]));
    for (const tab of gBrowser.tabs) {
      if (!tab.pinned && !tab.closing) {
        const id = controller.workspaceOf(tab);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return {
      workspaces: state.workspaces.map(w => ({ id: w.id, name: w.name, tabCount: counts.get(w.id) ?? 0 })),
      active: state.active,
    };
  }

  function closedSources(names) {
    let data;
    try {
      data = SessionStore.getClosedTabDataForWindow(window);
    } catch (error) {
      console.error("aequera-command: closed tabs unavailable", error);
      return [];
    }
    return data
      .filter(item => typeof item.closedId == "number")
      .map(item => {
        const entries = item.state?.entries ?? [];
        const entry = entries[(item.state?.index ?? entries.length) - 1] ?? entries.at(-1);
        const workspace = item.state?.extData?.[TAB_KEY];
        return {
          closedId: item.closedId,
          title: item.title || entry?.title || "",
          url: entry?.url || "",
          workspace: names.get(workspace) ?? null,
        };
      });
  }

  const command = {
    /** The Aequera rows for `query` in this window (plain data). */
    rows(query) {
      const { workspaces, active } = workspaceSources();
      const names = new Map(workspaces.map(w => [w.id, w.name]));
      return AequeraCommandModel.rows(query, { workspaces, active, closed: closedSources(names) });
    },

    /** Run a row's action. Unknown or stale actions do nothing. */
    run(action) {
      switch (action?.type) {
        case "switch-workspace":
          if (window.AequeraWorkspaces?.state?.workspaces.some(w => w.id === action.id)) {
            window.AequeraWorkspaces.switchTo(action.id);
          }
          break;
        case "restore-closed":
          if (typeof action.closedId == "number") {
            SessionStore.undoCloseById(action.closedId, true, window);
          }
          break;
        case "command":
          this.runCommand(action.id);
          break;
      }
    },

    runCommand(id) {
      switch (id) {
        case "new-tab":
          BrowserCommands.openTab();
          break;
        case "new-workspace":
          window.AequeraWorkspaces?.newWorkspace();
          break;
        case "restore-closed":
          if (SessionStore.getClosedTabCountForWindow(window)) {
            SessionStore.undoCloseTab(window, 0);
          }
          break;
        case "sort-by-site":
          window.AequeraWorkspaces?.sortBySite();
          break;
      }
    },
  };

  return command;
})();
