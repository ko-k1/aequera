/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera tab list magnification: pure model (no Firefox APIs; unit-tested
// with node). A classic script like drag-model.js; defines
// AequeraMagnifyModel in the window and exports it under node.
//
// macOS Dock-style magnification, shaped for targeting rather than show:
// the icons near the pointer grow on a smooth bell (largest under the
// pointer, fading to normal over a couple of rows), so the icon you are
// about to click is the easiest to recognize in a dense rail. Unlike the
// Dock, rows never spread apart: a target that slides away under the
// pointer as you approach it is the Dock's usability cost, so only the
// icons scale, in place, inside rows that keep their size and position.
//
// Positions are viewport px along the list's block axis.

var AequeraMagnifyModel = (() => {
  "use strict";

  /** The bell reaches this many rows from the pointer. */
  const RADIUS_ROWS = 2.5;
  /** Largest scale accepted from the pref (a 16px icon in a 30px row). */
  const MAX_SCALE = 1.75;

  /** Raised cosine: 1 at the pointer, 0 at the radius and beyond. */
  function falloff(x) {
    const d = Math.abs(x);
    return d >= 1 ? 0 : (1 + Math.cos(Math.PI * d)) / 2;
  }

  /** The configured peak (percent pref), clamped to 1..MAX_SCALE. */
  function peakScale(percent) {
    const scale = Number(percent) / 100;
    return Number.isFinite(scale) ? Math.min(Math.max(scale, 1), MAX_SCALE) : 1;
  }

  /**
   * Scales for the rows near the pointer.
   *   pointer: pointer position; firstCenter: row 0's center (same axis,
   *   scroll applied); step: one slot (row + gap); count: rows; peak: scale
   *   right under the pointer.
   * Returns [index, scale] pairs for the rows within the bell (scale > 1);
   * every other row is at 1.
   */
  function rowScales({ pointer, firstCenter, step, count, peak }) {
    if (!(step > 0) || !(count > 0) || !(peak > 1) || !Number.isFinite(pointer)) {
      return [];
    }
    const radius = RADIUS_ROWS * step;
    const from = Math.max(0, Math.ceil((pointer - radius - firstCenter) / step));
    const to = Math.min(count - 1, Math.floor((pointer + radius - firstCenter) / step));
    const out = [];
    for (let i = from; i <= to; i++) {
      const scale = 1 + (peak - 1) * falloff((firstCenter + i * step - pointer) / radius);
      if (scale > 1.001) {
        out.push([i, scale]);
      }
    }
    return out;
  }

  return { RADIUS_ROWS, MAX_SCALE, falloff, peakScale, rowScales };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraMagnifyModel;
}
