/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera workspaces: window controller + dock. Loaded into each browser
// window by aequera-main.js. Decisions come from the pure model
// (workspace-model.js); this file only translates plans into gBrowser calls,
// persists with SessionStore, and renders the dock.
//
// Persistence: window value "aequera-workspaces" (JSON state), tab value
// "aequera-workspace" (membership). Firefox's own session restore carries
// both, plus each tab's native hidden flag.

var AequeraWorkspaces = (() => {
  const WINDOW_KEY = "aequera-workspaces";
  const TAB_KEY = "aequera-workspace";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  // Loaded just before this script by aequera-main.js.
  const { WORKSPACE_SOURCE, normalizeState, createWorkspace, withActive, membershipOf, planSwitch } =
    AequeraWorkspaceModel;

  const controller = {
    state: null,
    dock: null,
    /** workspace id -> its dock button, reused across renders. */
    buttons: new Map(),
    newButton: null,
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
      const add = this.createButton("aequera-ws-name");
      add.classList.add("aequera-ws-new");
      add.dataset.action = "new-workspace";
      add.setAttribute("aria-label", "New workspace");
      add.title = "New workspace";
      add.querySelector(".aequera-ws-dot").textContent = "+";
      add.querySelector(".aequera-ws-name").textContent = "New workspace";
      main.append(dock);
      this.dock = dock;
      this.newButton = add;
    },

    /** A dock row: dot, then text spans of the given classes. */
    createButton(...textClasses) {
      const button = document.createElementNS(HTML_NS, "button");
      button.className = "aequera-ws";
      const dot = document.createElementNS(HTML_NS, "span");
      dot.className = "aequera-ws-dot";
      button.append(dot);
      for (const className of textClasses) {
        const span = document.createElementNS(HTML_NS, "span");
        span.className = className;
        button.append(span);
      }
      return button;
    },

    buttonFor(workspace) {
      let button = this.buttons.get(workspace.id);
      if (!button) {
        button = this.createButton("aequera-ws-name", "aequera-ws-count");
        button.dataset.ws = workspace.id;
        button.setAttribute("role", "tab");
        this.buttons.set(workspace.id, button);
      }
      return button;
    },

    /**
     * Bring the dock in line with the state. Buttons are updated in place and
     * only moved when out of order, never re-created: a focused button (a
     * keyboard switch) keeps focus.
     */
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
      const ids = new Set(this.state.workspaces.map(w => w.id));
      for (const [id, button] of this.buttons) {
        if (!ids.has(id)) {
          button.remove();
          this.buttons.delete(id);
        }
      }
      const setText = (node, text) => {
        if (node.textContent !== text) {
          node.textContent = text;
        }
      };
      const rows = this.state.workspaces.map(w => {
        const button = this.buttonFor(w);
        const count = counts.get(w.id);
        button.setAttribute("aria-selected", String(w.id === this.state.active));
        button.setAttribute("aria-label", `${w.name}, ${count} tabs`);
        button.title = w.name;
        setText(button.querySelector(".aequera-ws-name"), w.name);
        setText(button.querySelector(".aequera-ws-count"), String(count));
        return button;
      });
      [...rows, this.newButton].forEach((node, index) => {
        if (this.dock.children[index] !== node) {
          this.dock.insertBefore(node, this.dock.children[index] ?? null);
        }
      });
    },
  };

  controller.ready = controller.init().catch(error => {
    console.error("aequera-workspaces: init failed", error);
  });
  return controller;
})();
