/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera "Sort tabs by site": pure model (no Firefox APIs; unit-tested with
// node). A classic script for the same reason as workspace-model.js: it
// defines AequeraSiteSortModel in the window and, under node, exports the
// same object as CommonJS.
//
// Sorting runs only when the user asks (Ctrl+Alt+S, the tab context menu,
// the command surface) and only on the active workspace's visible tabs.
// Tabs are ordered by site (registrable domain), then by address; web pages
// come first, other pages (about:, file:, extension pages) after them. A site
// with more than `over` tabs moves to a workspace named after it (an
// existing one of that name is reused), so one busy site no longer buries
// the rest. The window controller (aequera-workspaces.js) applies the plan.

var AequeraSiteSortModel = (() => {
  "use strict";

  /** A site with more tabs than this moves to its own workspace. */
  const DEFAULT_OVER = 7;

  /**
   * The move threshold from a pref value: a non-negative integer, 0 = never
   * move. Anything else recovers to the default.
   */
  function normalizeOver(value) {
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_OVER;
  }

  /** The address as compared: scheme and a leading "www." do not count, so
   *  http and https pages of one site sort by path together. */
  function addressKey(url) {
    return String(url ?? "")
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .toLowerCase();
  }

  // Plain code-unit comparison: the same order in every locale.
  const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function compareTabs(a, b) {
    if (!a.site !== !b.site) {
      return a.site ? -1 : 1;
    }
    return (
      compareStrings(a.site ?? "", b.site ?? "") ||
      compareStrings(addressKey(a.url), addressKey(b.url))
    );
  }

  /**
   * @typedef {object} SortTab
   * @property {*} key             opaque identity handed back in the plan
   * @property {string} url
   * @property {string|null} site  registrable domain of a web page, else null
   * @property {boolean} sortable  false for tabs in a tab group or split view:
   *                               they keep their place and never move
   * @property {boolean} selected
   * @property {boolean} sharing   camera/mic/screen sharing: cannot be hidden
   * @property {number} lastAccessed
   */

  /**
   * What sorting the active workspace does. The controller applies it in
   * order: create the workspaces with a null id, reorder `order`, select
   * `select` (Firefox refuses to hide the selected tab), then move each
   * `moves` entry's tabs.
   *
   * @param {{ id: string, name: string }[]} workspaces
   * @param {string} active  the active workspace id
   * @param {SortTab[]} tabs the active workspace's visible tabs, in tab order
   * @param {{ over?: number }} [options]
   * @returns {{
   *   order: *[],
   *   moves: { workspace: string|null, name: string, keys: *[] }[],
   *   select: *|null,
   * }}
   *   order: the tabs staying, sorted (sortable ones only);
   *   moves: per site, the workspace (null = create one named `name`) and
   *   its tabs, sorted; select: the tab to select first, when the selected
   *   tab moves away.
   */
  function planSort(workspaces, active, tabs, { over = DEFAULT_OVER } = {}) {
    const threshold = normalizeOver(over);
    const sorted = tabs.filter(t => t.sortable).sort(compareTabs);
    const bySite = new Map();
    for (const tab of sorted) {
      if (tab.site && !tab.sharing) {
        bySite.set(tab.site, [...(bySite.get(tab.site) ?? []), tab]);
      }
    }
    const activeName = workspaces.find(w => w.id === active)?.name.toLowerCase();
    const moving = new Set();
    const moves = [];
    // The workspace never empties: a site that would take its last tabs
    // stays (it already has the workspace to itself).
    let remaining = tabs.length;
    if (threshold > 0) {
      for (const [site, siteTabs] of bySite) {
        if (siteTabs.length <= threshold || site === activeName || siteTabs.length >= remaining) {
          continue;
        }
        remaining -= siteTabs.length;
        const existing = workspaces.find(w => w.id !== active && w.name.toLowerCase() === site);
        moves.push({ workspace: existing?.id ?? null, name: site, keys: siteTabs.map(t => t.key) });
        for (const tab of siteTabs) {
          moving.add(tab);
        }
      }
    }
    const selected = tabs.find(t => t.selected);
    let select = null;
    if (selected && moving.has(selected)) {
      // The most recently used tab that stays.
      const staying = tabs.filter(t => !moving.has(t));
      select = staying.reduce((best, t) => (!best || t.lastAccessed > best.lastAccessed ? t : best), null);
      select = select?.key ?? null;
    }
    return {
      order: sorted.filter(t => !moving.has(t)).map(t => t.key),
      moves,
      select,
    };
  }

  return { DEFAULT_OVER, normalizeOver, addressKey, compareTabs, planSort };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraSiteSortModel;
}
