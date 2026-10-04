/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Narrow windows: lets stop/reload and downloads join the overflow menu
// under 560px so the window can reach ~400px. Back, forward, extensions,
// and the app menu stay put; flipped widgets return when the window widens.
// The overflow engine reads `overflows` live, so flipping the attribute is
// enough; the next resize recalculation moves the widgets.

var AequeraNarrow = (() => {
  const QUERY = "(max-width: 560px)";
  const FLIPPABLE = ["stop-reload-button", "downloads-button"];

  const narrow = {
    media: null,
    rail: false,
    observer: null,

    applies() {
      return this.rail && this.media && this.media.matches;
    },

    sync() {
      const overflow = this.applies() ? "true" : "false";
      for (const id of FLIPPABLE) {
        const node = document.getElementById(id);
        if (node && node.getAttribute("overflows") !== overflow) {
          node.setAttribute("overflows", overflow);
        }
      }
    },

    onRail() {
      this.rail = document.documentElement.hasAttribute("aequera-rail");
      this.sync();
    },

    init() {
      this.onChange = () => this.sync();
      this.media = window.matchMedia(QUERY);
      this.media.addEventListener("change", this.onChange);
      this.observer = new MutationObserver(() => this.onRail());
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["aequera-rail"],
      });
      window.addEventListener(
        "unload",
        () => {
          this.media.removeEventListener("change", this.onChange);
          this.observer.disconnect();
        },
        { once: true }
      );
      this.onRail();
    },
  };

  window.addEventListener("load", () => narrow.init(), { once: true });
  return narrow;
})();
