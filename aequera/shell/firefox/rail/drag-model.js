/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera tab list drag and drop: pure model (no Firefox APIs; unit-tested
// with node).
//
// A classic script for the same reason as workspace-model.js; defines
// AequeraDragModel in the window and exports it under node.
//
// The controller (aequera-tabs.js) measures the list and writes transforms;
// every decision in between lives here and works on plain numbers and
// indexes: where the dragged row is drawn, which slot the drag aims at, how
// the visible gap chases it, where a release lands, how the settle glide
// starts, where a foreign tab or link drops, and when a release tears off.
//
// Indexes are positions in the list's own order (the unpinned, visible tabs,
// dragged tab included). A slot index runs 0..count: the dragged tab lands in
// front of the row at that index, or after the last row at count. Slots
// `from` and `from + 1` both leave the tab where it is.

var AequeraDragModel = (() => {
  "use strict";

  /** Autoscroll starts this close (px) to the list's top or bottom edge... */
  const EDGE_SCROLL_ZONE = 32;
  /** ...and scrolls this far (px) per frame. */
  const EDGE_SCROLL_STEP = 12;
  /** The dragged row stays this far (px) inside the list. */
  const EDGE_PAD = 4;
  /** Without a rail box, a release this close (px) to the list stays. */
  const DETACH_MARGIN = 15;
  /** Settle retire time when the motion duration is unknown. */
  const SETTLE_MS = 250;
  // Mirror of the CSS glide cap (aequera-tabs.css min(..., 150ms)): the
  // retire timer must cover the capped transition plus a frame buffer, never
  // the raw pref alone.
  const SETTLE_GLIDE_CAP_MS = 150;
  const SETTLE_BUFFER_MS = 100;

  const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

  /**
   * How much of the smaller of two spans [p1, p1 + s1) and [p2, p2 + s2)
   * the other covers, 0..1 (native tab strip's overlap rule).
   */
  function overlap(p1, s1, p2, s2) {
    const size = p1 < p2 ? p1 + s1 - p2 : p2 + s2 - p1;
    if (size <= 0) {
      return 0;
    }
    return clamp(Math.max(size / s1, size / s2), 0, 1);
  }

  /** The slide of row `i` while the gap is at slot `drop`. */
  function slideShift(i, from, drop, step) {
    if (i < from && i >= drop) {
      return step;
    }
    if (i > from && i < drop) {
      return -step;
    }
    return 0;
  }

  /**
   * One frame of a local drag's live slide.
   *
   * Geometry (viewport px): listTop/listBottom (the list's box), padTop (the
   * first slot's top in content coordinates), scrollTop, step (one slot),
   * rowH. Drag state: from, startY and scrollStart (at dragstart), lastY,
   * forward, drop (the visible gap), target (the true gap). shifts[i] is
   * row i's current slide (missing = 0). final: the drop's own frame, which
   * settles the target and never scrolls.
   *
   * Returns the new drag state: translate (the dragged row's offset),
   * forward, lastY, target, drop, and zone (-1/0/1: autoscroll direction).
   * The visible gap moves at most one slot per frame toward the target; the
   * drop commits the target, never the chase.
   */
  function slideFrame(input) {
    const {
      count,
      from,
      rowH,
      step,
      listTop,
      listBottom,
      padTop,
      scrollTop,
      startY,
      scrollStart,
      clientY,
      shifts = [],
      final = false,
      canScrollUp = false,
      canScrollDown = false,
    } = input;
    let { lastY, forward } = input;
    const old = input.drop;
    const layoutTop = i => listTop + padTop + i * step - scrollTop;
    const shiftAt = i => shifts[i] ?? 0;
    if (clientY != lastY) {
      forward = clientY > lastY;
      lastY = clientY;
    }
    const originTop = layoutTop(from);
    const startBound = listTop + EDGE_PAD - originTop;
    const endBound = listBottom - EDGE_PAD - rowH - originTop;
    // Pointer travel plus how far the list scrolled under it since the
    // start; without the scroll term an autoscrolling list carries the row
    // away from the pointer and the gap follows the stray row.
    let translate = clamp(clientY - startY + (scrollTop - scrollStart), startBound, endBound);
    let top = originTop + translate;
    // A row that lost the pointer (it was held at an edge) recenters on it.
    if (
      (clientY < top || clientY > top + rowH) &&
      top > listTop + EDGE_PAD &&
      top + rowH < listBottom - EDGE_PAD
    ) {
      translate = clamp(clientY - originTop - rowH / 2, startBound, endBound);
      top = originTop + translate;
    }
    let candidate = -1;
    const point = forward ? top + rowH : top;
    let firstBg = -1;
    let lastBottom = 0;
    for (let i = 0; i < count; i++) {
      if (i == from) {
        continue;
      }
      const vis = layoutTop(i) + shiftAt(i);
      if (firstBg < 0) {
        firstBg = i;
      }
      lastBottom = vis + rowH;
      // A row owns its whole step (the row and the gap below it), so a
      // point between two rows still finds one.
      if (point >= vis && point < vis + step) {
        candidate = i;
        break;
      }
    }
    let target = input.target;
    if (candidate < 0 && firstBg >= 0) {
      const firstTop = layoutTop(firstBg) + shiftAt(firstBg);
      if (point >= lastBottom) {
        target = count;
      } else if (point < firstTop) {
        target = 0;
      } else {
        // Inside the open landing slot: land in it. Keeping the previous
        // frame's target here landed quick drags a slot short.
        target = old;
      }
    } else if (candidate >= 0) {
      target = candidate;
      const candTop = layoutTop(candidate) + slideShift(candidate, from, old, step);
      const covered = overlap(top, rowH, candTop, rowH);
      if (forward && covered > 0.5) {
        target = candidate + 1;
      } else if (!forward && !(covered > 0.5)) {
        target = Math.min(candidate + 1, old);
      }
      target = clamp(target, 0, count);
    }
    let drop = old;
    if (target > old) {
      drop = old + 1;
    } else if (target < old) {
      drop = old - 1;
    }
    let zone = 0;
    if (!final) {
      if (clientY < listTop + EDGE_SCROLL_ZONE && canScrollUp) {
        zone = -1;
      } else if (clientY > listBottom - EDGE_SCROLL_ZONE && canScrollDown) {
        zone = 1;
      }
    }
    return { translate, forward, lastY, target, drop, zone };
  }

  /**
   * The drop reference for slot `to` of a drag from `from`: land in front of
   * row `index`, or after it. null when the slot leaves the tab in place.
   */
  function slotTarget(from, to) {
    if (from < 0 || to == from || to == from + 1) {
      return null;
    }
    return to < from ? { index: to, after: false } : { index: to - 1, after: true };
  }

  /**
   * The tabIndex for moving a tab to just before (or after) the tab at
   * `refIndex`, in one flat tab order. `movingIndex` is the moving tab's
   * current index, or -1 for a tab that is not in this order yet (it then
   * leaves no slot behind).
   */
  function moveIndex(movingIndex, refIndex, after) {
    let index = after ? refIndex + 1 : refIndex;
    if (movingIndex >= 0 && movingIndex < index) {
      index -= 1; // the moving tab leaves its old slot first
    }
    return index;
  }

  /** The px value of a `translateY(<n>px)` style, 0 for anything else. */
  function parseTranslateY(style) {
    const m = /translateY\((-?\d+)/.exec(style || "");
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * Rebase a drop's live slide onto the committed order, so the glide home
   * starts exactly where the rows were drawn.
   *
   * order: the list before the move; offsets[i]: row i's live translateY;
   * dragged lands before (or after) `target`; now: the list after the move.
   * Returns each row's start offset (by its old index), or null when the
   * move did not produce the expected order (a clamped no-op move, a race)
   * and there is nothing to settle.
   */
  function settleOffsets({ order, offsets, dragged, target, after, now, step }) {
    if (!order.includes(dragged)) {
      return null;
    }
    const rest = order.filter(key => key !== dragged);
    const ridx = rest.indexOf(target);
    if (ridx < 0) {
      return null;
    }
    rest.splice(after ? ridx + 1 : ridx, 0, dragged);
    if (now.length != rest.length || !rest.every((key, i) => now[i] === key)) {
      return null;
    }
    return order.map((key, i) => (offsets[i] ?? 0) - (rest.indexOf(key) - i) * step);
  }

  /** The gap (0..mids.length) a pointer at clientY opens: before the
   *  first row whose middle is below it. */
  function gapIndex(mids, clientY) {
    const k = mids.findIndex(mid => clientY < mid);
    return k < 0 ? mids.length : k;
  }

  /** Each row's slide while a foreign gap is open at k. */
  function gapShifts(count, k, step) {
    return Array.from({ length: count }, (_, i) => (i >= k ? step : 0));
  }

  /** The row a drop at gap k lands against: in front of row k, after the
   *  last row past the end, or null for an empty list. */
  function gapRef(count, k) {
    if (!count) {
      return null;
    }
    const at = clamp(k, 0, count);
    return at < count ? { index: at, after: false } : { index: count - 1, after: true };
  }

  /**
   * Firefox's tear-off rules (tabbrowser drag-and-drop on_dragend): never
   * on Escape, never when something took the drop, never when detaching is
   * off, and only for a release away from the rail.
   */
  function shouldTearOff({ dropped, connected, userCancelled, dropEffect, allowDetach, outside }) {
    return !dropped && connected && !userCancelled && dropEffect === "none" && allowDetach && outside;
  }

  /**
   * A release is away from the rail when it is outside the window, or more
   * than half a rail width past the rail on the page's side (Firefox: 1.5 x
   * the strip's width from the window edge): right of a rail on the left,
   * left of a rail on the right. Without a rail box, only a release near the
   * list (DETACH_MARGIN) stays. Unknown coordinates count as away.
   */
  function releasedOutside({ x, y, width, height, rail, list }) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return true;
    }
    if (x < 0 || y < 0 || x > width || y > height) {
      return true;
    }
    if (rail && rail.width > 0) {
      return x > rail.right + rail.width / 2 || x < rail.left - rail.width / 2;
    }
    if (!list) {
      return true;
    }
    return !(
      x >= list.left - DETACH_MARGIN &&
      x <= list.right + DETACH_MARGIN &&
      y >= list.top - DETACH_MARGIN &&
      y <= list.bottom + DETACH_MARGIN
    );
  }

  /** Settle retire time from the --aequera-motion-duration value. */
  function settleMs(duration) {
    const ms = parseInt(duration, 10);
    if (Number.isFinite(ms)) {
      return clamp(ms, 0, SETTLE_GLIDE_CAP_MS) + SETTLE_BUFFER_MS;
    }
    return SETTLE_MS;
  }

  return {
    EDGE_SCROLL_STEP,
    overlap,
    slideShift,
    slideFrame,
    slotTarget,
    moveIndex,
    parseTranslateY,
    settleOffsets,
    gapIndex,
    gapShifts,
    gapRef,
    shouldTearOff,
    releasedOutside,
    settleMs,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraDragModel;
}
