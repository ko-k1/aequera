/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// AequeraHover: whether the pointer is on a hover-held chrome surface (the
// tab rail, the bookmarks drawer). Loaded into each browser window by
// aequera-main.js, before the surfaces that use it.
//
// Hover starts on mouseover and ends on a mouseout whose destination is
// outside the element (not the slower mouseenter/leave, which Gecko flags in
// chrome). The owner decides open or closed; the tracker asks it to re-decide
// after aequera.hover.openDelayMs when hover starts and closeDelayMs when it
// ends.
//
// While the surface is exposed (open over the page, so it can come to lie
// under a resting pointer: opened by the address bar, a window retile) and
// not hovered, Gecko sends that resting pointer a mouseover (a synthesized
// move after layout). That is not hover, or it would hold the surface open
// after the address bar blurs. So in that state only the pointer acting is
// hover: moving (synthesized moves never reach the DOM as mousemove; a
// motion event without motion does not count), pressing, or scrolling. The
// listeners for those exist only in that state, so ordinary pointer moves
// run no handler.
var AequeraHover = (() => {
  const OPEN_DELAY_PREF = "aequera.hover.openDelayMs";
  const CLOSE_DELAY_PREF = "aequera.hover.closeDelayMs";
  /** What the pointer does, as opposed to what moves under it. */
  const POINTER_ACTS = ["mousemove", "mousedown", "wheel"];

  class HoverTracker {
    /**
     * @param {Element} element the surface (its subtree counts as on it)
     * @param {(delay: number) => void} settle re-decide after `delay` ms
     */
    constructor(element, settle) {
      this.element = element;
      this.settle = settle;
      this.hovered = false;
      this.exposed = false;
      this.awaitingPointer = false;
      element.addEventListener("mouseover", this);
      element.addEventListener("mouseout", this);
    }

    /** The pointer is on the surface (also from a drag, which sends no
     * mouseover): re-decide after the open delay if that is new. */
    enter() {
      if (!this.hovered) {
        this.hovered = true;
        this.sync();
        this.settle(Services.prefs.getIntPref(OPEN_DELAY_PREF, 40));
      }
    }

    /** The pointer left the surface: re-decide after the close delay. */
    leave() {
      this.hovered = false;
      this.sync();
      this.settle(Services.prefs.getIntPref(CLOSE_DELAY_PREF, 150));
    }

    /** Hover read from coordinates (drag events carry no mouseout). */
    set(inside) {
      if (inside) {
        this.hovered = false;
        this.enter();
      } else {
        this.leave();
      }
    }

    /** Forget hover without re-deciding (the surface was turned off). */
    reset() {
      this.hovered = false;
      this.sync();
    }

    /** Whether the open surface can come to lie under a resting pointer. */
    setExposed(exposed) {
      this.exposed = exposed;
      this.sync();
    }

    sync() {
      const on = this.exposed && !this.hovered;
      if (on === this.awaitingPointer) {
        return;
      }
      this.awaitingPointer = on;
      for (const type of POINTER_ACTS) {
        if (on) {
          this.element.addEventListener(type, this, { passive: true });
        } else {
          this.element.removeEventListener(type, this, { passive: true });
        }
      }
    }

    handleEvent(event) {
      switch (event.type) {
        case "mouseover":
          if (!this.awaitingPointer) {
            this.enter();
          }
          break;
        case "mouseout":
          if (!this.element.contains(event.relatedTarget)) {
            this.leave();
          }
          break;
        // Only while awaiting the pointer (sync).
        case "mousemove":
          if (event.movementX || event.movementY) {
            this.enter();
          }
          break;
        case "mousedown":
        case "wheel":
          this.enter();
          break;
      }
    }
  }

  return {
    /** Track hover on `element`; `settle(delay)` re-decides its surface. */
    track(element, settle) {
      return new HoverTracker(element, settle);
    },
  };
})();
