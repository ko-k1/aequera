// Unit tests for the pure tab-list drag model (the same file the browser loads).
// Run: node --test aequera/shell/firefox/rail/drag-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./drag-model.js";

const {
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
} = model;

// Five 30px rows on a 36px step (6px gap), the list at 100..400, the first
// slot 6px down: slot i's top is 106 + 36 * i while unscrolled.
const ROW_H = 30;
const STEP = 36;
const slotTop = i => 106 + STEP * i;
const geometry = {
  count: 5,
  rowH: ROW_H,
  step: STEP,
  listTop: 100,
  listBottom: 400,
  padTop: 6,
  scrollTop: 0,
  scrollStart: 0,
};

/** A drag grabbed 15px into row `from`. */
function startDrag(from, extra = {}) {
  const startY = slotTop(from) + 15;
  return { ...geometry, from, startY, lastY: startY, forward: true, drop: from, target: from, shifts: [], ...extra };
}

/** Feed frames at clientY until the visible gap stops moving, applying the
 *  controller's state write-back and row shifts between frames. */
function settle(drag, clientY, maxFrames = 10) {
  const drops = [];
  let state = drag;
  for (let n = 0; n < maxFrames; n++) {
    const frame = slideFrame({ ...state, clientY });
    const shifts = Array.from({ length: state.count }, (_, i) =>
      i == state.from ? 0 : slideShift(i, state.from, frame.drop, STEP)
    );
    const moved = frame.drop != state.drop;
    state = { ...state, ...frame, shifts };
    drops.push(frame.drop);
    if (!moved) {
      break;
    }
  }
  return { state, drops };
}

test("overlap: disjoint, partial, and full coverage", () => {
  assert.equal(overlap(0, 30, 40, 30), 0);
  assert.equal(overlap(0, 30, 30, 30), 0, "touching edges do not overlap");
  assert.equal(overlap(0, 30, 15, 30), 0.5);
  assert.equal(overlap(10, 30, 10, 30), 1);
  assert.equal(overlap(0, 30, 5, 10), 1, "a span inside another is fully covered");
});

test("slideShift moves only the rows between the source and the gap", () => {
  // Dragging row 1 down to slot 4: rows 2 and 3 slide up.
  assert.deepEqual([0, 1, 2, 3, 4].map(i => slideShift(i, 1, 4, STEP)), [0, 0, -STEP, -STEP, 0]);
  // Dragging row 3 up to slot 1: rows 1 and 2 slide down.
  assert.deepEqual([0, 1, 2, 3, 4].map(i => slideShift(i, 3, 1, STEP)), [0, STEP, STEP, 0, 0]);
  // Slots from and from + 1 are the tab's own place: nothing slides.
  assert.deepEqual([0, 1, 2, 3, 4].map(i => slideShift(i, 2, 3, STEP)), [0, 0, 0, 0, 0]);
});

test("slideFrame: an unmoved pointer leaves everything in place", () => {
  const drag = startDrag(2);
  const frame = slideFrame({ ...drag, clientY: drag.startY });
  assert.equal(frame.translate, 0);
  assert.equal(frame.target, 2);
  assert.equal(frame.drop, 2);
  assert.equal(frame.zone, 0);
});

test("slideFrame: the dragged row tracks the pointer 1:1", () => {
  const drag = startDrag(1);
  const frame = slideFrame({ ...drag, clientY: drag.startY + 20 });
  assert.equal(frame.translate, 20);
  assert.equal(frame.forward, true);
  assert.equal(frame.lastY, drag.startY + 20);
});

test("slideFrame: the visible gap chases the target one slot per frame", () => {
  // Row 0 pulled two slots down at once: the target is slot 3 (after row 2)
  // immediately, the gap opens 1, 2, 3 over three frames and then holds.
  const drag = startDrag(0);
  const { state, drops } = settle(drag, drag.startY + 2 * STEP);
  assert.deepEqual(drops, [1, 2, 3, 3]);
  assert.equal(state.target, 3);
  assert.deepEqual(state.shifts, [0, -STEP, -STEP, 0, 0]);
  assert.deepEqual(slotTarget(0, state.target), { index: 2, after: true });
});

test("slideFrame: dragging up lands in front of the covered row", () => {
  const drag = startDrag(3);
  const { state, drops } = settle(drag, drag.startY - 2 * STEP);
  assert.equal(state.forward, false);
  assert.deepEqual(drops, [2, 1, 1]);
  assert.equal(state.target, 1);
  assert.deepEqual(state.shifts, [0, STEP, STEP, 0, 0]);
  assert.deepEqual(slotTarget(3, state.target), { index: 1, after: false });
});

test("slideFrame: a pointer inside the open landing slot keeps that slot", () => {
  // Row 0 dragged with the gap already at slot 2 (row 1 slid up into slot
  // 0): the row now sits in the open gap and no background row is under the
  // leading edge. It must land there, not fall back a slot (the quick-drag
  // regression).
  const drag = startDrag(0, { drop: 2, target: 2, shifts: [0, -STEP, 0, 0, 0] });
  const clientY = drag.startY + STEP;
  const frame = slideFrame({ ...drag, lastY: clientY, clientY });
  assert.equal(frame.target, 2);
  assert.equal(frame.drop, 2);
});

test("slideFrame: past the last row targets the end", () => {
  const drag = startDrag(0);
  const { state } = settle(drag, drag.startY + 4 * STEP + 10);
  assert.equal(state.target, 5);
  assert.deepEqual(slotTarget(0, state.target), { index: 4, after: true });
});

test("slideFrame: the dragged row is held inside the list", () => {
  const drag = startDrag(0);
  const up = slideFrame({ ...drag, clientY: 0 });
  // The row's top may rise to listTop + 4 (EDGE_PAD), i.e. 2px above slot 0.
  assert.equal(slotTop(0) + up.translate, 104);
  const down = slideFrame({ ...drag, clientY: 1000 });
  assert.equal(slotTop(0) + down.translate + ROW_H, 396);
});

test("slideFrame: an autoscrolled list carries the row with the pointer", () => {
  // The list scrolled one slot under a still pointer: the row must stay
  // under the pointer (translate makes up the scroll), not ride the content.
  const drag = startDrag(1, { scrollTop: STEP });
  const frame = slideFrame({ ...drag, clientY: drag.startY });
  const drawnTop = geometry.listTop + geometry.padTop + 1 * STEP - STEP + frame.translate;
  assert.equal(frame.translate, STEP);
  assert.equal(drawnTop, slotTop(1));
});

test("slideFrame: autoscroll zones only where the list can scroll", () => {
  const drag = startDrag(2);
  assert.equal(slideFrame({ ...drag, clientY: 110, canScrollUp: true }).zone, -1);
  assert.equal(slideFrame({ ...drag, clientY: 110, canScrollUp: false }).zone, 0);
  assert.equal(slideFrame({ ...drag, clientY: 390, canScrollDown: true }).zone, 1);
  assert.equal(slideFrame({ ...drag, clientY: 390, canScrollDown: false }).zone, 0);
  assert.equal(slideFrame({ ...drag, clientY: 250, canScrollUp: true, canScrollDown: true }).zone, 0);
});

test("slideFrame: the drop's own frame never scrolls", () => {
  const drag = startDrag(2);
  const frame = slideFrame({ ...drag, clientY: 390, canScrollDown: true, final: true });
  assert.equal(frame.zone, 0);
});

test("slideFrame does not mutate its input", () => {
  const drag = startDrag(0, { shifts: [0, 0, 0, 0, 0] });
  const copy = structuredClone(drag);
  slideFrame({ ...drag, clientY: drag.startY + 50 });
  assert.deepEqual(drag, copy);
});

test("slotTarget: the tab's own slots are no move", () => {
  assert.equal(slotTarget(2, 2), null);
  assert.equal(slotTarget(2, 3), null);
  assert.equal(slotTarget(-1, 0), null, "a tab no longer listed");
  assert.deepEqual(slotTarget(2, 0), { index: 0, after: false });
  assert.deepEqual(slotTarget(2, 4), { index: 3, after: true });
});

test("moveIndex accounts for the slot the moving tab leaves", () => {
  // Tabs [a b c d e]; moving b (1) after d (3) ends at index 3.
  assert.equal(moveIndex(1, 3, true), 3);
  // Moving d (3) in front of b (1) ends at index 1.
  assert.equal(moveIndex(3, 1, false), 1);
  // Moving b in front of d: index 2.
  assert.equal(moveIndex(1, 3, false), 2);
  // A tab from elsewhere (-1) leaves no slot behind.
  assert.equal(moveIndex(-1, 3, true), 4);
  assert.equal(moveIndex(-1, 0, false), 0);
});

test("parseTranslateY reads only translateY px values", () => {
  assert.equal(parseTranslateY("translateY(-36px)"), -36);
  assert.equal(parseTranslateY("translateY(72px)"), 72);
  assert.equal(parseTranslateY(""), 0);
  assert.equal(parseTranslateY(undefined), 0);
  assert.equal(parseTranslateY("scale(2)"), 0);
});

test("settleOffsets: a fully settled slide needs no glide", () => {
  // a dragged after c: the live slide already drew the final order.
  const offsets = settleOffsets({
    order: ["a", "b", "c", "d"],
    offsets: [72, -36, -36, 0],
    dragged: "a",
    target: "c",
    after: true,
    now: ["b", "c", "a", "d"],
    step: STEP,
  });
  assert.deepEqual(offsets, [0, 0, 0, 0]);
});

test("settleOffsets: rows start the glide where they were drawn", () => {
  // Released mid-chase: a drawn 12px short, c not slid yet.
  const offsets = settleOffsets({
    order: ["a", "b", "c", "d"],
    offsets: [60, -36, 0, 0],
    dragged: "a",
    target: "c",
    after: true,
    now: ["b", "c", "a", "d"],
    step: STEP,
  });
  assert.deepEqual(offsets, [-12, 0, STEP, 0]);
});

test("settleOffsets refuses an order the move did not produce", () => {
  const base = { order: ["a", "b", "c"], offsets: [0, 0, 0], dragged: "a", target: "c", after: true, step: STEP };
  assert.equal(settleOffsets({ ...base, now: ["a", "b", "c"] }), null, "clamped no-op move");
  assert.equal(settleOffsets({ ...base, now: ["b", "c"] }), null, "a tab closed meanwhile");
  assert.equal(settleOffsets({ ...base, target: "z", now: ["b", "c", "a"] }), null, "unknown target");
  assert.equal(settleOffsets({ ...base, dragged: "z", now: ["b", "c", "a"] }), null, "unknown dragged tab");
});

test("gapIndex opens before the first row whose middle is below the pointer", () => {
  const mids = [121, 157, 193];
  assert.equal(gapIndex(mids, 100), 0);
  assert.equal(gapIndex(mids, 121), 1, "exactly on a middle goes below it");
  assert.equal(gapIndex(mids, 160), 2);
  assert.equal(gapIndex(mids, 500), 3);
  assert.equal(gapIndex([], 100), 0);
});

test("gapShifts slides the rows at and below the gap", () => {
  assert.deepEqual(gapShifts(4, 1, STEP), [0, STEP, STEP, STEP]);
  assert.deepEqual(gapShifts(3, 3, STEP), [0, 0, 0]);
  assert.deepEqual(gapShifts(0, 0, STEP), []);
});

test("gapRef lands in front of the gap's row, or after the last", () => {
  assert.equal(gapRef(0, 0), null);
  assert.deepEqual(gapRef(3, 0), { index: 0, after: false });
  assert.deepEqual(gapRef(3, 2), { index: 2, after: false });
  assert.deepEqual(gapRef(3, 3), { index: 2, after: true });
  assert.deepEqual(gapRef(3, 9), { index: 2, after: true });
  assert.deepEqual(gapRef(3, -1), { index: 0, after: false });
});

test("shouldTearOff: only an unclaimed release away from the rail", () => {
  const release = {
    dropped: false,
    connected: true,
    userCancelled: false,
    dropEffect: "none",
    allowDetach: true,
    outside: true,
  };
  assert.equal(shouldTearOff(release), true);
  assert.equal(shouldTearOff({ ...release, dropped: true }), false, "the list took the drop");
  assert.equal(shouldTearOff({ ...release, connected: false }), false, "the tab closed");
  assert.equal(shouldTearOff({ ...release, userCancelled: true }), false, "Escape");
  assert.equal(shouldTearOff({ ...release, dropEffect: "move" }), false, "another target took it");
  assert.equal(shouldTearOff({ ...release, allowDetach: false }), false, "detaching is off");
  assert.equal(shouldTearOff({ ...release, outside: false }), false, "released by the rail");
});

test("releasedOutside: by the rail stays, past half a rail width tears off", () => {
  const view = { width: 1200, height: 800, rail: { left: 0, right: 220, width: 220 }, list: null };
  assert.equal(releasedOutside({ ...view, x: 100, y: 300 }), false, "on the rail");
  assert.equal(releasedOutside({ ...view, x: 330, y: 300 }), false, "just past its edge");
  assert.equal(releasedOutside({ ...view, x: 331, y: 300 }), true, "over the page");
  assert.equal(releasedOutside({ ...view, x: -5, y: 300 }), true, "left of the window");
  assert.equal(releasedOutside({ ...view, x: 100, y: 801 }), true, "below the window");
  assert.equal(releasedOutside({ ...view, x: NaN, y: 300 }), true, "no coordinates");
});

test("releasedOutside: a rail on the right tears off over the page to its left", () => {
  const view = { width: 1200, height: 800, rail: { left: 980, right: 1200, width: 220 }, list: null };
  assert.equal(releasedOutside({ ...view, x: 1100, y: 300 }), false, "on the rail");
  assert.equal(releasedOutside({ ...view, x: 870, y: 300 }), false, "just past its edge");
  assert.equal(releasedOutside({ ...view, x: 869, y: 300 }), true, "over the page");
  assert.equal(releasedOutside({ ...view, x: 1205, y: 300 }), true, "right of the window");
});

test("releasedOutside: without a rail box, only near the list stays", () => {
  const view = {
    width: 1200,
    height: 800,
    rail: { left: 0, right: 0, width: 0 },
    list: { left: 0, right: 220, top: 100, bottom: 400 },
  };
  assert.equal(releasedOutside({ ...view, x: 230, y: 405 }), false, "within the margin");
  assert.equal(releasedOutside({ ...view, x: 236, y: 300 }), true, "beyond the margin");
  assert.equal(releasedOutside({ ...view, list: null, x: 100, y: 300 }), true, "no list at all");
});

test("settleMs covers the capped glide plus a frame buffer", () => {
  assert.equal(settleMs("250"), 250, "capped at 150 + 100");
  assert.equal(settleMs("80ms"), 180);
  assert.equal(settleMs(" 0"), 100, "no glide still waits a frame");
  assert.equal(settleMs("-5"), 100);
  assert.equal(settleMs(""), 250, "unknown duration");
});
