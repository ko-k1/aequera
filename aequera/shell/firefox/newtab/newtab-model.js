/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera new tab: pure model (no Firefox APIs; unit-tested with node).
//
// One new tab page per window: asking for a new tab while the window already
// shows an untouched new tab page goes to that page instead of loading
// another. The page is rendered once and stays rendered; the preloaded page
// Firefox keeps behind it is used only once that one is spent. A classic
// script for the same reason as workspace-model.js; defines
// AequeraNewTabModel in the window and exports it under node.

var AequeraNewTabModel = (() => {
  "use strict";

  /**
   * Whether a tab still shows the new tab page as it opened: the new tab
   * address, nothing behind or ahead of it in its history, nothing typed for
   * it in the address bar, not loading (a navigation away from it may be
   * under way), and on screen (not pinned, not in another workspace, not
   * waiting to be restored).
   *
   * @param {object} tab plain description of a tab:
   *   { url, newTabURL, pinned, hidden, pending, busy, canGoBack,
   *     canGoForward, typed }
   */
  function isUntouched(tab) {
    return (
      !!tab &&
      typeof tab.url == "string" &&
      tab.url === tab.newTabURL &&
      !tab.pinned &&
      !tab.hidden &&
      !tab.pending &&
      !tab.busy &&
      !tab.canGoBack &&
      !tab.canGoForward &&
      !tab.typed
    );
  }

  /**
   * The tab a new tab request should go to instead of opening one: the
   * selected tab if it is an untouched new tab page, else the last such tab
   * (nearest where a new tab would open), else -1 (open a new tab).
   *
   * @param {object[]} tabs descriptions for isUntouched, plus `selected`
   * @returns {number} index into tabs, or -1
   */
  function reusable(tabs) {
    let found = -1;
    for (let i = 0; i < (tabs?.length ?? 0); i++) {
      if (!isUntouched(tabs[i])) {
        continue;
      }
      if (tabs[i].selected) {
        return i;
      }
      found = i;
    }
    return found;
  }

  return { isUntouched, reusable };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraNewTabModel;
}
