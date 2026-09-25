/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera tab rail (prototype/shell #sidebar). Loaded into each browser
// window by aequera-main.js.
//
// With vertical tabs on and the sidebar revamp off (patches/browser/
// aequera-rail makes that combination possible), Firefox's own vertical tab
// strip (#vertical-tabs, a customizable area holding tabbrowser-tabs) sits in
// #sidebar-container, whose revamp launcher component is never loaded. Aequera
// shows that container as its rail and owns everything the launcher used to:
//   - width: collapsed = Firefox's --tab-collapsed-width, expanded =
//     aequera.rail.expandedWidth, a plain CSS width transition (interruptible
//     by construction: a new target restarts from the current width);
//   - hover intent: open after aequera.hover.openDelayMs, linger
//     aequera.hover.closeDelayMs before collapsing;
//   - holds: keyboard focus (:focus-visible) in the rail, a popup opened from
//     the rail (e.g. the tab context menu), the address bar when
//     aequera.rail.expandOnAddressFocus is on (prototype unified search);
//   - pinned (aequera.rail.pinned): always expanded, taking layout space;
//   - two states: the TARGET (:root[aequera-rail-expanded]) flips at once and
//     drives the width, the page clip, and the drawer edge; the CONTENT
//     (:root[aequera-rail-content-expanded] + tabbrowser-tabs[expanded],
//     which Firefox's tab CSS uses for full rows) widens at once but only
//     collapses after the width transition, so the narrowing rail clips the
//     wide content away instead of it snapping to icons mid-animation.
// The widened rail overlays the page; the page card clips back in step
// (aequera-shell.css) so the rail stays on the frame material.
var AequeraRail = (() => {
  const PREFS = {
    revamp: "sidebar.revamp",
    verticalTabs: "sidebar.verticalTabs",
    openDelay: "aequera.hover.openDelayMs",
    closeDelay: "aequera.hover.closeDelayMs",
    expandedWidth: "aequera.rail.expandedWidth",
    pinned: "aequera.rail.pinned",
    addressFocus: "aequera.rail.expandOnAddressFocus",
  };
  const ROOT = document.documentElement;

  const rail = {
    container: null,
    hovered: false,
    expanded: false,
    timer: 0,
    contentTimer: 0,
    /** Popups opened from inside the rail (context menus, tab menus). */
    openPopups: new Set(),

    /** The rail exists when vertical tabs run without the revamp launcher. */
    get active() {
      return (
        Services.prefs.getBoolPref(PREFS.verticalTabs, false) &&
        !Services.prefs.getBoolPref(PREFS.revamp, false)
      );
    },

    get pinned() {
      return Services.prefs.getBoolPref(PREFS.pinned, false);
    },

    wantsExpanded() {
      if (!this.active) {
        return false;
      }
      if (this.pinned || this.hovered || this.openPopups.size) {
        return true;
      }
      if (Services.prefs.getBoolPref(PREFS.addressFocus, true) && gURLBar.focused) {
        return true;
      }
      const el = document.activeElement;
      return !!el && this.container.contains(el) && el.matches(":focus-visible");
    },

    /** Re-decide after `delay` ms; a newer call supersedes a pending one. */
    settle(delay) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.update(), delay);
    },

    update() {
      clearTimeout(this.timer);
      const expanded = this.wantsExpanded();
      if (expanded === this.expanded) {
        return;
      }
      this.expanded = expanded;
      ROOT.toggleAttribute("aequera-rail-expanded", expanded);
      clearTimeout(this.contentTimer);
      if (expanded) {
        this.setContentExpanded(true);
      } else {
        // Keep the wide layout until the width transition has finished.
        const duration = parseFloat(
          getComputedStyle(ROOT).getPropertyValue("--aequera-motion-duration")
        );
        const delay = window.gReduceMotion ? 0 : duration || 0;
        this.contentTimer = setTimeout(() => {
          if (!this.expanded) {
            this.setContentExpanded(false);
          }
        }, delay);
      }
    },

    setContentExpanded(expanded) {
      ROOT.toggleAttribute("aequera-rail-content-expanded", expanded);
      gBrowser.tabContainer.toggleAttribute("expanded", expanded);
    },

    refresh() {
      const active = this.active;
      ROOT.toggleAttribute("aequera-rail", active);
      ROOT.toggleAttribute("aequera-rail-pinned", active && this.pinned);
      ROOT.style.setProperty(
        "--aequera-rail-expanded-width",
        `${Services.prefs.getIntPref(PREFS.expandedWidth, 220)}px`
      );
      if (!active) {
        this.hovered = false;
        this.openPopups.clear();
      }
      this.update();
    },

    delay(pref, fallback) {
      return Services.prefs.getIntPref(pref, fallback);
    },

    handleEvent(event) {
      switch (event.type) {
        // mouseover/mouseout rather than the slower mouseenter/leave (Gecko
        // flags those in chrome): entering is the first over; leaving is an
        // out whose destination is outside the rail.
        case "mouseover":
          if (!this.hovered) {
            this.hovered = true;
            this.settle(this.delay(PREFS.openDelay, 40));
          }
          break;
        case "mouseout":
          if (!this.container.contains(event.relatedTarget)) {
            this.hovered = false;
            this.settle(this.delay(PREFS.closeDelay, 150));
          }
          break;
        case "focusin":
          // Address-bar focus is an explicit intent: act now.
          if (gURLBar.focused) {
            this.update();
          } else {
            this.settle(this.delay(PREFS.openDelay, 40));
          }
          break;
        case "focusout":
          this.settle(this.delay(PREFS.closeDelay, 150));
          break;
        case "popupshown":
          if (this.container.contains(event.target.triggerNode)) {
            this.openPopups.add(event.target);
            this.update();
          }
          break;
        case "popuphidden":
          if (this.openPopups.delete(event.target)) {
            this.settle(this.delay(PREFS.closeDelay, 150));
          }
          break;
      }
    },

    observe() {
      this.refresh();
    },

    init() {
      this.container = document.getElementById("sidebar-container");
      if (!this.container) {
        console.error("aequera-rail: #sidebar-container missing; rail disabled");
        return;
      }
      this.container.addEventListener("mouseover", this);
      this.container.addEventListener("mouseout", this);
      // Rail keyboard focus and the address bar both count, so focus is
      // watched window-wide.
      window.addEventListener("focusin", this);
      window.addEventListener("focusout", this);
      document.addEventListener("popupshown", this);
      document.addEventListener("popuphidden", this);
      const prefs = Object.values(PREFS);
      for (const pref of prefs) {
        Services.prefs.addObserver(pref, this);
      }
      window.addEventListener(
        "unload",
        () => {
          clearTimeout(this.timer);
          clearTimeout(this.contentTimer);
          for (const pref of prefs) {
            Services.prefs.removeObserver(pref, this);
          }
        },
        { once: true }
      );
      this.refresh();
    },
  };

  window.addEventListener("load", () => rail.init(), { once: true });
  return rail;
})();
