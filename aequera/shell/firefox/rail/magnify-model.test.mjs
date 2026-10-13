// Unit tests for the pure tab-list magnification model (the file the browser loads).
// Run: node --test aequera/shell/firefox/rail/magnify-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./magnify-model.js";

const { RADIUS_ROWS, MAX_SCALE, falloff, peakScale, rowScales } = model;

const STEP = 36;
// Row i's center sits at 100 + 36 * i.
const view = { firstCenter: 100, step: STEP, count: 20, peak: 1.5 };
const asMap = pairs => new Map(pairs);

test("falloff: a raised cosine bell, 1 at the pointer, 0 at the radius", () => {
  assert.equal(falloff(0), 1);
  assert.ok(Math.abs(falloff(0.5) - 0.5) < 1e-12);
  assert.equal(falloff(1), 0);
  assert.equal(falloff(-1.5), 0);
  assert.equal(falloff(-0.3), falloff(0.3), "symmetric");
  for (let x = 0; x < 1; x += 0.05) {
    assert.ok(falloff(x + 0.05) <= falloff(x) + 1e-12, "never grows with distance");
  }
});

test("peak scale: percent pref, clamped so the icon stays inside its row", () => {
  assert.equal(peakScale(150), 1.5);
  assert.equal(peakScale(100), 1);
  assert.equal(peakScale(40), 1);
  assert.equal(peakScale(400), MAX_SCALE);
  assert.equal(peakScale("nope"), 1);
  assert.ok(16 * MAX_SCALE <= 30, "a 16px icon at the cap fits a 30px row");
});

test("the row under the pointer gets the peak, its neighbours less, symmetric", () => {
  const scales = asMap(rowScales({ ...view, pointer: 100 + 36 * 5 }));
  assert.equal(scales.get(5), 1.5);
  assert.ok(scales.get(4) < 1.5 && scales.get(4) > 1);
  assert.ok(Math.abs(scales.get(4) - scales.get(6)) < 1e-12);
  assert.ok(scales.get(3) < scales.get(4));
});

test("only rows within the bell are listed (the rest stay at 1)", () => {
  const scales = rowScales({ ...view, pointer: 100 + 36 * 10 });
  const reach = Math.floor(RADIUS_ROWS);
  for (const [i] of scales) {
    assert.ok(Math.abs(i - 10) <= reach, `row ${i} is within ${reach} rows`);
  }
  assert.equal(scales.length, 2 * reach + 1);
});

test("between two rows both grow equally", () => {
  const scales = asMap(rowScales({ ...view, pointer: 100 + 36 * 5 + 18 }));
  assert.ok(Math.abs(scales.get(5) - scales.get(6)) < 1e-12);
  assert.ok(scales.get(5) < 1.5);
});

test("edges: pointer past either end, no rows, no magnification", () => {
  assert.deepEqual(rowScales({ ...view, pointer: -500 }), []);
  assert.deepEqual(rowScales({ ...view, pointer: 5000 }), []);
  assert.deepEqual(rowScales({ ...view, count: 0, pointer: 100 }), []);
  assert.deepEqual(rowScales({ ...view, peak: 1, pointer: 100 }), []);
  assert.deepEqual(rowScales({ ...view, pointer: NaN }), []);
  const first = asMap(rowScales({ ...view, pointer: 100 }));
  assert.equal(first.get(0), 1.5, "the first row still peaks");
  assert.ok(!first.has(-1));
});
