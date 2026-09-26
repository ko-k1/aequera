/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera bookmarks drawer (prototype/shell bookmark bar, "hover" mode).
// Loaded into each browser window by aequera-main.js.
//
// With aequera.bookmarks.hoverPeek on and Firefox's toolbar visibility set
// to "always", the Bookmarks Toolbar stays built (no per-hover rebuild) but
// leaves the page flow: it is a drawer under the top bar that
//   - opens when the pointer rests on the top bar (hover-intent delay) and
//     immediately when the address bar is focused;
//   - stays open while the pointer is on the top bar or the drawer (its whole
//     area, also while the wipe is still revealing it: aequera-bookmarks.css),
//     while a menu or panel opened from them is showing (a bookmark's context
//     menu, a folder), and while the address bar is focused or keyboard focus
//     (:focus-visible) is in the top bar; a mouse-clicked button never holds
//     it open, and a menu never opens it;
//   - closes after the linger delay once none of that holds.
// The page card clips back from the top while it is open (AequeraFrame), so
// the drawer sits on the frame material and the page never reflows.
// Timing is the tab rail's: aequera.hover.* delays and the shared motion
// tokens (published by AequeraFrame).
var AequeraBookmarks = (() => {
  const PEEK_PREF = "aequera.bookmarks.hoverPeek";
  const VISIBILITY_PREF = "browser.toolbars.bookmarks.visibility";
  const OPEN_DELAY_PREF = "aequera.hover.openDelayMs";
  const CLOSE_DELAY_PREF = "aequera.hover.closeDelayMs";
  const ROOT = document.documentElement;

  const drawer = {
    toolbar: null,
    toolbox: null,
    hovered: false,
    open: false,
    /** Menus and panels opened from the top bar or drawer while it was open. */
    openPopups: new Set(),
    height: 0,
    timer: 0,
    customizing: false,

    /** Peek mode applies only on top of Firefox's "always" visibility. */
    get active() {
      return (
        !this.customizing &&
        Services.prefs.getBoolPref(PEEK_PREF, false) &&
        Services.prefs.getCharPref(VISIBILITY_PREF, "") === "always"
      );
    },

    /** Address bar focus, or keyboard focus anywhere in the top bar. */
    focusIntent() {
      if (gURLBar.focused) {
        return true;
      }
      const el = document.activeElement;
      return !!el && this.toolbox.contains(el) && el.matches(":focus-visible");
    },

    wantsOpen() {
      return this.active && (this.hovered || this.openPopups.size > 0 || this.focusIntent());
    },

    /** A menu or panel of the top bar or drawer (not a tooltip). */
    isOwnPopup(popup) {
      return (
        popup.localName != "tooltip" &&
        [popup, popup.triggerNode, popup.anchorNode].some(node => this.toolbox.contains(node))
      );
    },

    /** Re-decide after `delay` ms; a newer call supersedes a pending one. */
    settle(delay) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.update(), delay);
    },

    update() {
      clearTimeout(this.timer);
      for (const popup of this.openPopups) {
        // A popup removed while open never fires popuphidden.
        if (!popup.isConnected || popup.state == "closed") {
          this.openPopups.delete(popup);
        }
      }
      const open = this.wantsOpen();
      if (open === this.open) {
        return;
      }
      this.open = open;
      ROOT.toggleAttribute("aequera-bookmarks-open", open);
      AequeraFrame.setTop(open ? this.height : 0);
    },

    refreshMode() {
      const active = this.active;
      ROOT.toggleAttribute("aequera-bookmarks-peek", active);
      this.update();
    },

    handleEvent(event) {
      switch (event.type) {
        // mouseover/mouseout (not the slower mouseenter/leave, which Gecko
        // flags in chrome): entering is the first over; leaving is an out
        // whose destination is outside the top bar.
        case "mouseover":
          if (!this.hovered) {
            this.hovered = true;
            this.settle(Services.prefs.getIntPref(OPEN_DELAY_PREF, 40));
          }
          break;
        case "mouseout":
          if (!this.toolbox.contains(event.relatedTarget)) {
            this.hovered = false;
            this.settle(Services.prefs.getIntPref(CLOSE_DELAY_PREF, 150));
          }
          break;
        case "focusin":
          // Address bar focus is an explicit intent: open now.
          if (gURLBar.focused) {
            this.update();
          } else {
            this.settle(Services.prefs.getIntPref(OPEN_DELAY_PREF, 40));
          }
          break;
        case "focusout":
          this.settle(Services.prefs.getIntPref(CLOSE_DELAY_PREF, 150));
          break;
        case "popupshown":
          // Holds an open drawer while in use; never opens a closed one (a
          // shortcut opening a toolbar panel is not a request for bookmarks).
          if (this.open && this.isOwnPopup(event.target)) {
            this.openPopups.add(event.target);
          }
          break;
        case "popuphidden":
          if (this.openPopups.delete(event.target)) {
            this.settle(Services.prefs.getIntPref(CLOSE_DELAY_PREF, 150));
          }
          break;
        case "customizationstarting":
          this.customizing = true;
          this.refreshMode();
          break;
        case "aftercustomization":
          this.customizing = false;
          this.refreshMode();
          break;
      }
    },

    observe() {
      // Pref observer: peek or toolbar visibility changed.
      this.refreshMode();
    },

    init() {
      this.toolbar = document.getElementById("PersonalToolbar");
      this.toolbox = document.getElementById("navigator-toolbox");
      const tabbox = document.getElementById("tabbrowser-tabbox");
      if (!this.toolbar || !this.toolbox || !tabbox) {
        console.error("aequera-bookmarks: toolbar/toolbox missing; drawer disabled");
        return;
      }
      // Customize mode's events are dispatched on the toolbox (as
      // CustomizableUI listens for them), so everything registers there.
      for (const type of [
        "mouseover",
        "mouseout",
        "focusin",
        "focusout",
        "customizationstarting",
        "aftercustomization",
      ]) {
        this.toolbox.addEventListener(type, this);
      }
      // Menus and panels are not in the toolbox's subtree (context menus,
      // panels) or are shown outside it, so listen document-wide.
      document.addEventListener("popupshown", this);
      document.addEventListener("popuphidden", this);
      const prefs = [PEEK_PREF, VISIBILITY_PREF];
      for (const pref of prefs) {
        Services.prefs.addObserver(pref, this);
      }

      // Drawer height -> the page's top inset. Setting that inset never
      // resizes the toolbar, so this observer cannot feed itself.
      const heightObserver = new ResizeObserver(entries => {
        const entry = entries[entries.length - 1];
        const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        if (height !== this.height) {
          this.height = height;
          // The drawer's hit area while open (aequera-bookmarks.css).
          this.toolbox.style.setProperty("--aequera-drawer-height", `${height}px`);
          if (this.open) {
            AequeraFrame.setTop(height);
          }
        }
      });
      heightObserver.observe(this.toolbar);

      // The page's start edge -> where the drawer begins (it spans the page,
      // not the rail). Applying it resizes the drawer, which heightObserver
      // watches, so it is applied in the next frame rather than inside this
      // callback (no ResizeObserver loop). It is set on the toolbox so only
      // that subtree restyles.
      let startFrame = 0;
      const startObserver = new ResizeObserver(() => {
        cancelAnimationFrame(startFrame);
        startFrame = requestAnimationFrame(() => {
          const box = tabbox.getBoundingClientRect();
          const start = tabbox.hasAttribute("sidebar-positionend")
            ? window.innerWidth - box.right
            : box.left;
          this.toolbox.style.setProperty("--aequera-content-start", `${start}px`);
        });
      });
      startObserver.observe(tabbox);

      window.addEventListener(
        "unload",
        () => {
          clearTimeout(this.timer);
          cancelAnimationFrame(startFrame);
          document.removeEventListener("popupshown", this);
          document.removeEventListener("popuphidden", this);
          heightObserver.disconnect();
          startObserver.disconnect();
          for (const pref of prefs) {
            Services.prefs.removeObserver(pref, this);
          }
        },
        { once: true }
      );
      this.refreshMode();
    },
  };

  window.addEventListener("load", () => drawer.init(), { once: true });
  return drawer;
})();
