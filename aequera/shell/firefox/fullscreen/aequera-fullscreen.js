/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Window fullscreen on Wayland: popups that drop down from the top bar must
// open whole. Loaded into each browser window by aequera-main.js.
//
// Aequera keeps the top bar up in fullscreen (aequera-prefs.js:
// browser.fullscreen.autohide), so panels open from anchors in the top ~40px
// of the screen. On Wayland the compositor places popups, and some confine
// them to the output minus the layer-shell exclusive zones (bars, docks)
// even while a fullscreen window covers those zones: Hyprland does
// (CPopup::reposition, logicalBoxMinusReserved). An anchor inside that strip
// puts the popup's top edge out of bounds, and for a popup anchored below
// its button (position after_*) Firefox lets the compositor flip or resize
// it but not slide it vertically (nsWindowWayland
// WaylandPopupGetPositionFromLayout). So the compositor trims the overlap
// from the top: the popup opens shorter than its content and the bottom of
// an extension popup or a small panel is cut off. Firefox then keeps that
// smaller size for the popup (mMoveToRectPopupSize).
//
// Firefox does allow the vertical slide for popups with flip="slide". While
// the window is fullscreen on Wayland, every chrome popup that does not opt
// out of constraining (flip="none") gets flip="slide", so the compositor
// moves it below the strip instead of trimming it. The original value is
// kept in FLIP_MARK and restored on leaving fullscreen. Gecko reads `flip`
// when a popup opens (nsMenuPopupFrame::InitializePopup), so popups created
// later (the per-open extension widget panel, lazily inserted templates)
// are marked as they are added, before they open.
var AequeraFullscreen = (() => {
  const FLIP_MARK = "aequera-fullscreen-flip";
  const POPUPS = "panel, menupopup";
  const ROOT = document.documentElement;

  const fullscreen = {
    active: false,
    observer: null,
    _wayland: null,

    /** Popups are placed by a Wayland compositor (cached; never changes). */
    isWayland() {
      if (this._wayland === null) {
        try {
          this._wayland =
            Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).windowProtocol === "wayland";
        } catch {
          // Not Linux, or no protocol reported: layout places popups itself.
          this._wayland = false;
        }
      }
      return this._wayland;
    },

    wanted() {
      return ROOT.hasAttribute("inFullscreen") && this.isWayland();
    },

    mark(popup) {
      if (popup.hasAttribute(FLIP_MARK)) {
        return;
      }
      const flip = popup.getAttribute("flip");
      if (flip == "none" || flip == "slide") {
        return;
      }
      popup.setAttribute(FLIP_MARK, flip ?? "");
      popup.setAttribute("flip", "slide");
    },

    unmark(popup) {
      const flip = popup.getAttribute(FLIP_MARK);
      popup.removeAttribute(FLIP_MARK);
      if (flip) {
        popup.setAttribute("flip", flip);
      } else {
        popup.removeAttribute("flip");
      }
    },

    markTree(node) {
      if (node.nodeType != Node.ELEMENT_NODE) {
        return;
      }
      if (node.matches(POPUPS)) {
        this.mark(node);
      }
      for (const popup of node.querySelectorAll(POPUPS)) {
        this.mark(popup);
      }
    },

    update() {
      const wanted = this.wanted();
      if (wanted == this.active) {
        return;
      }
      this.active = wanted;
      if (wanted) {
        this.markTree(ROOT);
        this.observer.observe(ROOT, { childList: true, subtree: true });
      } else {
        this.observer.disconnect();
        for (const popup of document.querySelectorAll(`[${FLIP_MARK}]`)) {
          this.unmark(popup);
        }
      }
    },

    init() {
      this.observer = new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            this.markTree(node);
          }
        }
      });
      // FullScreen (browser-fullScreenAndPointerLock.js) sets inFullscreen on
      // the root for window and DOM fullscreen alike.
      new MutationObserver(() => this.update()).observe(ROOT, {
        attributes: true,
        attributeFilter: ["inFullscreen"],
      });
      window.addEventListener("unload", () => this.observer.disconnect(), { once: true });
      this.update();
    },
  };

  window.addEventListener("load", () => fullscreen.init(), { once: true });
  return fullscreen;
})();
