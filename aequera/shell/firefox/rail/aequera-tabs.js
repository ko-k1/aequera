/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera tab list (prototype/shell #tab-list). Loaded into each browser
// window by aequera-main.js.
//
// Firefox's own vertical tab rows switch between two layouts (display
// toggles, re-sized backgrounds) and cannot animate like the prototype, so the
// rail renders its own list of the unpinned tabs, in the prototype's row
// language: the icon never moves, the row grows with the rail, the title is
// revealed by the widening and fades in (aequera-tabs.css). Firefox's tab
// elements stay the source of truth (gBrowser); the rows are a view of them:
//   - click selects; middle-click and the close button close;
//   - right-click opens Firefox's own tab context menu for that tab (rows
//     carry `.tab`, which TabContextMenu resolves its target from);
//   - drag reorders through gBrowser.moveTabTo;
//   - hidden tabs (other workspaces, extensions) are not listed.
// Pinned tabs stay in Firefox's pinned container (the essentials grid).
var AequeraTabs = (() => {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";
  const STRUCTURE_EVENTS = ["TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned", "TabShow", "TabHide"];
  const ROW_EVENTS = ["TabSelect", "TabAttrModified"];

  const list = {
    element: null,
    rows: new WeakMap(),
    newTabRow: null,
    dragged: null,

    /** Tabs shown as rows, in tab order. */
    tabs() {
      return gBrowser.tabs.filter(tab => !tab.pinned && !tab.hidden && !tab.closing);
    },

    createRow(tab) {
      const row = document.createElementNS(HTML_NS, "div");
      row.className = "aequera-tab";
      row.setAttribute("role", "tab");
      row.draggable = true;
      const icon = document.createElementNS(HTML_NS, "img");
      icon.className = "aequera-tab-icon";
      icon.alt = "";
      const title = document.createElementNS(HTML_NS, "span");
      title.className = "aequera-tab-title";
      const close = document.createElementNS(HTML_NS, "span");
      close.className = "aequera-tab-close";
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "Close tab");
      close.textContent = "×";
      row.append(icon, title, close);
      // TabContextMenu resolves its target from triggerNode.tab.
      for (const node of [row, icon, title, close]) {
        node.tab = tab;
      }
      this.rows.set(tab, row);
      this.updateRow(tab);
      return row;
    },

    updateRow(tab) {
      const row = this.rows.get(tab);
      if (!row) {
        return;
      }
      const label = tab.label || "";
      row.setAttribute("aria-selected", String(tab.selected));
      row.setAttribute("aria-label", label);
      row.title = label;
      row.toggleAttribute("busy", tab.hasAttribute("busy"));
      row.toggleAttribute("soundplaying", tab.hasAttribute("soundplaying"));
      row.toggleAttribute("muted", tab.hasAttribute("muted"));
      row.querySelector(".aequera-tab-title").textContent = label;
      const image = tab.getAttribute("image") || DEFAULT_ICON;
      const icon = row.querySelector(".aequera-tab-icon");
      if (icon.getAttribute("src") != image) {
        icon.setAttribute("src", image);
      }
    },

    /** Put exactly the listed tabs' rows in tab order (nodes are reused). */
    render() {
      if (!this.element) {
        return;
      }
      const rows = this.tabs().map(tab => this.rows.get(tab) ?? this.createRow(tab));
      this.element.replaceChildren(...rows, this.newTabRow);
    },

    handleEvent(event) {
      const tab = event.target.tab ?? event.target;
      switch (event.type) {
        case "TabSelect":
          for (const t of this.tabs()) {
            this.updateRow(t);
          }
          break;
        case "TabAttrModified":
          this.updateRow(tab);
          break;
        case "mousedown":
          this.onMouseDown(event);
          break;
        case "click":
          this.onClick(event);
          break;
        case "auxclick":
          if (event.button == 1 && event.target.tab) {
            gBrowser.removeTab(event.target.tab, { animate: true });
          }
          break;
        case "contextmenu":
          this.onContextMenu(event);
          break;
        case "dragstart":
        case "dragover":
        case "drop":
        case "dragend":
          this.onDrag(event);
          break;
        default:
          // Structure changed (open/close/move/pin/show/hide). TabClose fires
          // while the tab is still in gBrowser.tabs (filtered as closing).
          this.render();
      }
    },

    onMouseDown(event) {
      const target = event.target;
      if (event.button != 0 || !target.tab || target.classList.contains("aequera-tab-close")) {
        return;
      }
      gBrowser.selectedTab = target.tab;
    },

    onClick(event) {
      const target = event.target;
      if (event.button != 0) {
        return;
      }
      if (target.classList.contains("aequera-tab-close") && target.tab) {
        gBrowser.removeTab(target.tab, { animate: true });
      } else if (target.closest(".aequera-newtab")) {
        BrowserCommands.openTab();
      }
    },

    onContextMenu(event) {
      if (!event.target.tab) {
        return;
      }
      event.preventDefault();
      document
        .getElementById("tabContextMenu")
        .openPopupAtScreen(event.screenX, event.screenY, true, event);
    },

    onDrag(event) {
      const row = event.target.closest?.(".aequera-tab");
      switch (event.type) {
        case "dragstart":
          if (!row) {
            return;
          }
          this.dragged = row.tab;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/x-moz-aequera-tab", "");
          break;
        case "dragover":
          if (this.dragged && row) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
          break;
        case "drop":
          if (this.dragged && row && row.tab != this.dragged) {
            event.preventDefault();
            const box = row.getBoundingClientRect();
            const after = event.clientY > box.top + box.height / 2;
            const target = gBrowser.tabs.indexOf(row.tab);
            const from = gBrowser.tabs.indexOf(this.dragged);
            let tabIndex = after ? target + 1 : target;
            if (from < tabIndex) {
              tabIndex -= 1; // the dragged tab leaves its old slot first
            }
            gBrowser.moveTabTo(this.dragged, { tabIndex });
          }
          break;
        case "dragend":
          this.dragged = null;
          break;
      }
    },

    init() {
      const main = document.querySelector("#sidebar-container > sidebar-main");
      const verticalTabs = document.getElementById("vertical-tabs");
      if (!main || !verticalTabs) {
        console.error("aequera-tabs: rail not found; tab list disabled");
        return;
      }
      const element = document.createElementNS(HTML_NS, "div");
      element.id = "aequera-tabs";
      element.setAttribute("role", "tablist");
      element.setAttribute("aria-label", "Tabs");
      element.setAttribute("aria-orientation", "vertical");
      const newTab = document.createElementNS(HTML_NS, "div");
      newTab.className = "aequera-tab aequera-newtab";
      newTab.setAttribute("role", "button");
      newTab.setAttribute("aria-label", "New tab");
      newTab.title = "New tab";
      const plus = document.createElementNS(HTML_NS, "span");
      plus.className = "aequera-tab-icon aequera-newtab-icon";
      plus.setAttribute("aria-hidden", "true");
      plus.textContent = "+";
      newTab.append(plus);
      this.newTabRow = newTab;
      verticalTabs.after(element);
      this.element = element;

      for (const type of ["mousedown", "click", "auxclick", "contextmenu", "dragstart", "dragover", "drop", "dragend"]) {
        element.addEventListener(type, this);
      }
      const container = gBrowser.tabContainer;
      for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
        container.addEventListener(type, this);
      }
      window.addEventListener(
        "unload",
        () => {
          for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
            container.removeEventListener(type, this);
          }
        },
        { once: true }
      );
      this.render();
      // Last: Firefox's own rows are hidden only once this list is live
      // (aequera-tabs.css), so a failed init never leaves the window tabless.
      document.documentElement.setAttribute("aequera-tabs", "true");
    },
  };

  window.delayedStartupPromise.then(() => list.init());
  return list;
})();
