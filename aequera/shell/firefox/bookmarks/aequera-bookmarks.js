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
//   - stays open while the address bar is focused or keyboard focus
//     (:focus-visible) is in the top bar; a mouse-clicked button never holds
//     it open;
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
      return this.active && (this.hovered || this.focusIntent());
    },

    /** Re-decide after `delay` ms; a newer call supersedes a pending one. */
    settle(delay) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.update(), delay);
    },

    update() {
      clearTimeout(this.timer);
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
