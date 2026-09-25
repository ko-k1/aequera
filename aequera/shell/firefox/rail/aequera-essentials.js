/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Essentials count (aequera-essentials.css). Loaded into each browser window
// by aequera-shell.js.
//
// The essentials grid balances every row for 1 to 9 pinned tabs (3 x 3 is the
// designed maximum); CSS cannot count the pinned tabs reliably, so this sets
// #pinned-tabs-container[aequera-essentials] to the count, or "many" past 9
// (tiles then continue 3 per row and Firefox's pinned area scrolls; pinning
// is never refused).
var AequeraEssentials = (() => {
  const MAX = 9;
  const essentials = {
    container: null,

    update() {
      if (!this.container) {
        return;
      }
      const count = gBrowser.tabs.filter(tab => tab.pinned && !tab.closing).length;
      this.container.setAttribute("aequera-essentials", count > MAX ? "many" : String(count));
    },

    handleEvent() {
      // TabClose fires before the tab leaves gBrowser.tabs (it is filtered as
      // closing); the rest change the count directly.
      this.update();
    },

    init() {
      this.container = document.getElementById("pinned-tabs-container");
      if (!this.container) {
        console.error("aequera-essentials: #pinned-tabs-container missing");
        return;
      }
      const events = ["TabPinned", "TabUnpinned", "TabOpen", "TabClose"];
      for (const type of events) {
        gBrowser.tabContainer.addEventListener(type, this);
      }
      window.addEventListener(
        "unload",
        () => {
          for (const type of events) {
            gBrowser.tabContainer.removeEventListener(type, this);
          }
        },
        { once: true }
      );
      this.update();
    },
  };

  window.delayedStartupPromise.then(() => essentials.init());
  return essentials;
})();
