/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera workspaces: window controller + dock. Loaded into each browser
// window by aequera-shell.js. Decisions come from the pure model
// (workspace-model.mjs); this file only translates plans into gBrowser calls,
// persists with SessionStore, and renders the dock.
//
// Persistence: window value "aequera-workspaces" (JSON state), tab value
// "aequera-workspace" (membership). Firefox's own session restore carries
// both, plus each tab's native hidden flag.

var AequeraWorkspaces = (() => {
  const MODEL_URL = "chrome://browser/content/aequera/workspaces/workspace-model.mjs";
  const WINDOW_KEY = "aequera-workspaces";
  const TAB_KEY = "aequera-workspace";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const { WORKSPACE_SOURCE, normalizeState, createWorkspace, withActive, membershipOf, planSwitch } =
    ChromeUtils.importESModule(MODEL_URL, { global: "current" });

  const controller = {
    state: null,
    dock: null,
    /** workspace id -> WeakRef(tab) last selected there (this session). */
    lastSelected: new Map(),
    /** Resolves once state is loaded and the dock is mounted. */
    ready: null,

    async init() {
      await window.delayedStartupPromise;
      await SessionStore.promiseInitialized;
      this.reload();
      this.mountDock();
      gBrowser.tabContainer.addEventListener("TabOpen", this);
      gBrowser.tabContainer.addEventListener("TabSelect", this);
      gBrowser.tabContainer.addEventListener("TabClose", this);
      gBrowser.tabContainer.addEventListener("TabPinned", this);
      gBrowser.tabContainer.addEventListener("TabUnpinned", this);
      window.addEventListener("SSWindowRestored", this);
      window.addEventListener("unload", this, { once: true });
      this.render();
    },

    /** Re-read persisted state and make visibility match it. */
    reload() {
      this.state = normalizeState(SessionStore.getCustomWindowValue(window, WINDOW_KEY));
      for (const tab of gBrowser.tabs) {
        this.ensureMember(tab);
      }
      this.save();
      this.apply(this.state.active);
    },

    save() {
      SessionStore.setCustomWindowValue(window, WINDOW_KEY, JSON.stringify(this.state));
    },

    workspaceOf(tab) {
      return membershipOf({ workspace: SessionStore.getCustomTabValue(tab, TAB_KEY) || null }, this.state);
    },

    /** Give a tab without (valid) membership the active workspace. */
    ensureMember(tab) {
      if (tab.pinned) {
        return;
      }
      const current = SessionStore.getCustomTabValue(tab, TAB_KEY);
      if (!this.state.workspaces.some(w => w.id === current)) {
        SessionStore.setCustomTabValue(tab, TAB_KEY, this.state.active);
      }
    },

    tabInfo(tab) {
      return {
        key: tab,
        workspace: SessionStore.getCustomTabValue(tab, TAB_KEY) || null,
        pinned: tab.pinned,
        hidden: tab.hidden,
        hiddenBy: SessionStore.getCustomTabValue(tab, "hiddenBy") || null,
        selected: tab.selected,
        sharing: !!tab.linkedBrowser?._sharingState?.webRTC?.sharing,
      };
    },

    /** Make `id` the active workspace. Also used to repair visibility. */
    apply(id) {
      const tabs = gBrowser.tabs.filter(t => !t.closing);
      const plan = planSwitch(this.state, tabs.map(t => this.tabInfo(t)), id, {
        lastSelected: this.lastSelected.get(id)?.deref(),
      });
      this.state = withActive(this.state, id);
      this.save();
      // Selection first: Firefox refuses to hide the selected tab.
      if (plan.openNew) {
        gBrowser.selectedTab = gBrowser.addTrustedTab(BROWSER_NEW_TAB_URL);
      } else if (plan.select) {
        gBrowser.selectedTab = plan.select;
      }
      for (const tab of plan.show) {
        gBrowser.showTab(tab);
      }
      for (const tab of plan.hide) {
        gBrowser.hideTab(tab, WORKSPACE_SOURCE);
      }
    },

    switchTo(id) {
      if (id === this.state.active) {
        return;
      }
      this.apply(id);
      this.render();
    },

    newWorkspace() {
      const { state, workspace } = createWorkspace(this.state);
      this.state = state;
      this.save();
      this.switchTo(workspace.id);
    },

    handleEvent(event) {
      const tab = event.target;
      switch (event.type) {
        case "TabOpen":
          this.ensureMember(tab);
          this.render();
          break;
        case "TabSelect": {
          if (tab.pinned) {
            break;
          }
          const owner = this.workspaceOf(tab);
          // Reaching a tab of another workspace (tab search, all-tabs menu,
          // extension) switches to that workspace instead of stranding it.
          if (owner !== this.state.active) {
            this.switchTo(owner);
          }
          this.lastSelected.set(owner, new WeakRef(tab));
          break;
        }
        case "TabUnpinned":
          // A tab leaving the global pinned set joins the active workspace.
          SessionStore.setCustomTabValue(tab, TAB_KEY, this.state.active);
          this.render();
          break;
        case "TabClose":
        case "TabPinned":
          this.render();
          break;
        case "SSWindowRestored":
          this.reload();
          this.render();
          break;
        case "unload":
          gBrowser.tabContainer.removeEventListener("TabOpen", this);
          gBrowser.tabContainer.removeEventListener("TabSelect", this);
          gBrowser.tabContainer.removeEventListener("TabClose", this);
          gBrowser.tabContainer.removeEventListener("TabPinned", this);
          gBrowser.tabContainer.removeEventListener("TabUnpinned", this);
          window.removeEventListener("SSWindowRestored", this);
          break;
      }
    },

    mountDock() {
      const main = document.querySelector("sidebar-main");
      if (!main) {
        console.error("aequera-workspaces: sidebar-main missing; dock not mounted");
        return;
      }
      const dock = document.createElementNS(HTML_NS, "div");
      dock.id = "aequera-workspace-dock";
      // Same slot as the tab list, after it: the dock sits under the tabs.
      dock.slot = "tabstrip";
      dock.setAttribute("role", "tablist");
      dock.setAttribute("aria-label", "Workspaces");
      dock.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (button?.dataset.ws) {
          this.switchTo(button.dataset.ws);
        } else if (button?.dataset.action === "new-workspace") {
          this.newWorkspace();
        }
      });
      main.append(dock);
      this.dock = dock;
    },

    render() {
      if (!this.dock) {
        return;
      }
      const counts = new Map(this.state.workspaces.map(w => [w.id, 0]));
      for (const tab of gBrowser.tabs) {
        if (!tab.pinned && !tab.closing) {
          const id = this.workspaceOf(tab);
          counts.set(id, counts.get(id) + 1);
        }
      }
      const buttons = this.state.workspaces.map(w => {
        const count = counts.get(w.id);
        const button = document.createElementNS(HTML_NS, "button");
        button.className = "aequera-ws";
        button.dataset.ws = w.id;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(w.id === this.state.active));
        button.setAttribute("aria-label", `${w.name}, ${count} tabs`);
        button.title = w.name;
        const dot = document.createElementNS(HTML_NS, "span");
        dot.className = "aequera-ws-dot";
        const name = document.createElementNS(HTML_NS, "span");
        name.className = "aequera-ws-name";
        name.textContent = w.name;
        const badge = document.createElementNS(HTML_NS, "span");
        badge.className = "aequera-ws-count";
        badge.textContent = String(count);
        button.append(dot, name, badge);
        return button;
      });
      const add = document.createElementNS(HTML_NS, "button");
      add.className = "aequera-ws aequera-ws-new";
      add.dataset.action = "new-workspace";
      add.setAttribute("aria-label", "New workspace");
      add.title = "New workspace";
      const plus = document.createElementNS(HTML_NS, "span");
      plus.className = "aequera-ws-dot";
      plus.textContent = "+";
      const label = document.createElementNS(HTML_NS, "span");
      label.className = "aequera-ws-name";
      label.textContent = "New workspace";
      add.append(plus, label);
      this.dock.replaceChildren(...buttons, add);
    },
  };

  controller.ready = controller.init().catch(error => {
    console.error("aequera-workspaces: init failed", error);
  });
  return controller;
})();
