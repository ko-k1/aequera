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
//
// Sort tabs by site (site-sort-model.js) runs only on request: Ctrl+Alt+S
// (Cmd+Opt+S on macOS), the end of the tab context menu, or the
// command surface.
//
// Ctrl+1..8 switch to workspace 1..8 and Ctrl+9 to the last one (Alt+digit
// on Windows, where Firefox's tabs own Ctrl+digit). Middle-clicking a dock
// row closes that workspace and its tabs, asking first when it holds more
// than one.

var AequeraWorkspaces = (() => {
  const WINDOW_KEY = "aequera-workspaces";
  const TAB_KEY = "aequera-workspace";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SORT_OVER_PREF = "aequera.tabs.sortBySite.over";
  const SORT_KEY_ID = "aequera-key-sort-tabs";
  const WARN_CLOSE_PREF = "aequera.workspaces.warnOnClose";
  // The modifier Firefox's own tab digits leave free on this OS.
  const DIGIT_MODIFIER = AequeraPlatform.workspaceDigitModifier;

  // Loaded before this script by aequera-main.js.
  const {
    WORKSPACE_SOURCE,
    normalizeState,
    createWorkspace,
    withActive,
    workspaceForDigit,
    digitForWorkspace,
    planClose,
    removeWorkspace,
    membershipOf,
    planSwitch,
  } = AequeraWorkspaceModel;
  const { DEFAULT_OVER, planSort } = AequeraSiteSortModel;

  const controller = {
    state: null,
    dock: null,
    /** workspace id -> its dock button, reused across renders. */
    buttons: new Map(),
    newButton: null,
    /** workspace id -> WeakRef(tab) last selected there (this session). */
    lastSelected: new Map(),
    /** digit -> { label (as menus show it), aria (aria-keyshortcuts) }. */
    digitShortcuts: new Map(),
    /** Resolves once state is loaded and the dock is mounted. */
    ready: null,

    async init() {
      await window.delayedStartupPromise;
      await SessionStore.promiseInitialized;
      this.reload();
      this.mountDock();
      this.mountKeys();
      this.mountSortMenuItem();
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

    planCloseOf(id) {
      const tabs = gBrowser.tabs.filter(t => !t.closing);
      return planClose(this.state, tabs.map(t => this.tabInfo(t)), id);
    },

    /**
     * Close workspace `id` and its tabs (they go to recently closed tabs,
     * like any closed tab). The window's only workspace never closes. With
     * more than one tab it asks first (aequera.workspaces.warnOnClose).
     * A page that asks before being left can keep its tab; the workspace then
     * stays with what remains.
     */
    async closeWorkspace(id) {
      let plan = this.planCloseOf(id);
      if (!plan) {
        return;
      }
      if (plan.close.length > 1 && Services.prefs.getBoolPref(WARN_CLOSE_PREF, true)) {
        if (!(await this.confirmClose(id, plan.close.length))) {
          return;
        }
        // The prompt is async: plan again from what is there now.
        plan = this.planCloseOf(id);
        if (!plan) {
          return;
        }
      }
      if (plan.switchTo) {
        // Park the closing tabs first: no visible tab closes, so Firefox
        // never walks the selection through them.
        this.switchTo(plan.switchTo);
      }
      if (plan.close.length) {
        const close = () => gBrowser.removeTabs(plan.close, { animate: false });
        if (window.AequeraTabs) {
          AequeraTabs.batch(close);
        } else {
          close();
        }
      }
      if (plan.close.some(tab => tab.isConnected && !tab.closing)) {
        this.render();
        return;
      }
      this.state = removeWorkspace(this.state, id);
      this.lastSelected.delete(id);
      this.save();
      // Repair: a beforeunload prompt may have switched to the closing
      // workspace while its tabs closed.
      this.apply(this.state.active);
      this.render();
    },

    /** "Close “Work” and its 9 tabs?" with Firefox's window-modal prompt;
     *  unchecking the box turns the question off. */
    async confirmClose(id, count) {
      const name = this.state.workspaces.find(w => w.id === id)?.name ?? "";
      const prompt = Services.prompt;
      const result = await prompt.asyncConfirmEx(
        window.browsingContext,
        prompt.MODAL_TYPE_INTERNAL_WINDOW,
        `Close “${name}” and its ${count} tabs?`,
        null,
        prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0 + prompt.BUTTON_TITLE_CANCEL * prompt.BUTTON_POS_1,
        "Close Workspace",
        null,
        null,
        "Ask before closing a workspace with several tabs",
        true
      );
      const bag = result.QueryInterface(Ci.nsIPropertyBag2);
      const confirmed = bag.get("buttonNumClicked") == 0;
      if (confirmed && !bag.get("checked")) {
        Services.prefs.setBoolPref(WARN_CLOSE_PREF, false);
      }
      return confirmed;
    },

    /** Registrable domain of a web page (the host where there is none, as
     *  for localhost or an IP address); null for every other page. */
    siteOf(uri) {
      if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
        return null;
      }
      try {
        return Services.eTLD.getBaseDomain(uri);
      } catch {
        return uri.asciiHost || null;
      }
    },

    sortInfo(tab) {
      let uri = tab.linkedBrowser?.currentURI;
      // A tab waiting to be restored shows about:blank until it loads; sort
      // it by the page it will load.
      if (tab.hasAttribute("pending") && (!uri || uri.spec === "about:blank")) {
        try {
          const { entries, index } = JSON.parse(SessionStore.getTabState(tab));
          const url = entries?.[(index ?? entries.length) - 1]?.url;
          if (url) {
            uri = Services.io.newURI(url);
          }
        } catch {}
      }
      return {
        key: tab,
        url: uri?.spec ?? "",
        site: this.siteOf(uri),
        sortable: !tab.group && !tab.splitview,
        selected: tab.selected,
        sharing: !!tab.linkedBrowser?._sharingState?.webRTC?.sharing,
        lastAccessed: tab.lastAccessed,
      };
    },

    /**
     * Sort the active workspace's tabs by site, and move each site with more
     * than aequera.tabs.sortBySite.over tabs to a workspace named after it.
     * Tabs in a tab group or split view keep their place. The workspace
     * stays active; the dock shows where tabs went.
     */
    sortBySite() {
      const tabs = gBrowser.tabs.filter(t => !t.pinned && !t.hidden && !t.closing);
      const over = Services.prefs.getIntPref(SORT_OVER_PREF, DEFAULT_OVER);
      const plan = planSort(this.state.workspaces, this.state.active, tabs.map(t => this.sortInfo(t)), { over });
      for (const move of plan.moves) {
        if (!move.workspace) {
          const { state, workspace } = createWorkspace(this.state, move.name);
          this.state = state;
          move.workspace = workspace.id;
        }
      }
      this.save();
      // The rail lists the result once instead of after every move.
      const apply = () => this.applySort(plan);
      if (window.AequeraTabs) {
        AequeraTabs.batch(apply);
      } else {
        apply();
      }
      this.render();
    },

    applySort(plan) {
      // The sorted tabs stay where the first of them was (pinned tabs and
      // other workspaces' hidden tabs around them do not matter); a tab
      // already right after its predecessor is not moved.
      const anchor = plan.order.reduce((first, t) => (!first || t.index < first.index ? t : first), null);
      plan.order.forEach((tab, i) => {
        if (i === 0) {
          if (tab !== anchor) {
            gBrowser.moveTabBefore(tab, anchor);
          }
        } else if (tab.index !== plan.order[i - 1].index + 1) {
          gBrowser.moveTabAfter(tab, plan.order[i - 1]);
        }
      });

      // Selection first: Firefox refuses to hide the selected tab.
      if (plan.select) {
        gBrowser.selectedTab = plan.select;
      }
      for (const move of plan.moves) {
        for (const tab of move.keys) {
          SessionStore.setCustomTabValue(tab, TAB_KEY, move.workspace);
          // After the workspace's own tabs, in sorted order.
          gBrowser.moveTabToEnd(tab);
          gBrowser.hideTab(tab, WORKSPACE_SOURCE);
        }
        // Opening the site's workspace returns to the tab that was in use.
        const used = move.keys.reduce((best, t) => (!best || t.lastAccessed > best.lastAccessed ? t : best), null);
        this.lastSelected.set(move.workspace, new WeakRef(used));
      }
    },

    /**
     * The window's Aequera shortcuts, in a keyset of their own (as WebExtension
     * shortcuts are): Ctrl+Alt+S sorts tabs by site; Ctrl+1..8 switch to
     * workspace 1..8 and Ctrl+9 to the last one (Alt+digit on Windows).
     */
    mountKeys() {
      const keyset = document.createXULElement("keyset");
      keyset.id = "aequera-keyset";
      const addKey = (id, char, modifiers, run) => {
        const key = document.createXULElement("key");
        key.id = id;
        key.setAttribute("key", char);
        key.setAttribute("modifiers", modifiers);
        key.addEventListener("command", run);
        keyset.append(key);
        return key;
      };
      addKey(SORT_KEY_ID, "S", "accel,alt", () => this.sortBySite());
      for (let digit = 1; digit <= 9; digit++) {
        const key = addKey(`aequera-key-workspace-${digit}`, String(digit), DIGIT_MODIFIER, () => {
          const id = workspaceForDigit(this.state, digit);
          if (id) {
            this.switchTo(id);
          }
        });
        this.digitShortcuts.set(digit, {
          label: ShortcutUtils.prettifyShortcut(key),
          aria: `${DIGIT_MODIFIER == "alt" ? "Alt" : "Control"}+${digit}`,
        });
      }
      document.documentElement.append(keyset);
    },

    /**
     * "Sort Tabs by Site" at the end of the tab context menu. The end is the
     * menu's open section, where WebExtension items go: Firefox's menu layout
     * (TabContextMenu.MENU_SECTIONS) refuses unknown items anywhere else.
     */
    mountSortMenuItem() {
      const item = document.createXULElement("menuitem");
      item.id = "aequera-context-sort-tabs";
      item.setAttribute("label", "Sort Tabs by Site");
      item.setAttribute("key", SORT_KEY_ID);
      item.addEventListener("command", () => this.sortBySite());
      const separator = document.createXULElement("menuseparator");
      separator.id = "aequera-context-sort-separator";
      const menu = document.getElementById("tabContextMenu");
      if (menu) {
        menu.append(separator, item);
      } else {
        console.error("aequera-workspaces: tabContextMenu missing; sort menu item not added");
      }
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
      // Middle-click closes a workspace, as it closes a tab.
      dock.addEventListener("auxclick", event => {
        const button = event.target.closest("button");
        if (event.button == 1 && button?.dataset.ws) {
          this.closeWorkspace(button.dataset.ws).catch(error => {
            console.error("aequera-workspaces: close failed", error);
          });
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
        const shortcut = this.digitShortcuts.get(digitForWorkspace(this.state, w.id));
        button.title = shortcut ? `${w.name} (${shortcut.label})` : w.name;
        if (shortcut) {
          button.setAttribute("aria-keyshortcuts", shortcut.aria);
        } else {
          button.removeAttribute("aria-keyshortcuts");
        }
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
