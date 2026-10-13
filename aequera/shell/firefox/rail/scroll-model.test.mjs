// Unit tests for the pure tab-list scroll model (the file the browser loads).
// Run: node --test aequera/shell/firefox/rail/scroll-model.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import model from "./scroll-model.js";

const { SPRING, wheelDistance, impulse, coastDistance, accelGain, kick, momentum, spring, stateAt, atRest } =
  model;

const NOTCH = wheelDistance(6, 1, 0); // one wheel notch: 6 lines

/** Seconds until the motion rests, sampled at 1ms. */
function restTime(motion) {
  for (let ms = 0; ms < 5000; ms++) {
    if (atRest(motion, ms / 1000)) {
      return ms / 1000;
    }
  }
  return Infinity;
}

/** Total travel of `count` same-way notches at `rate` per second. */
function spin(rate, count, distance = NOTCH) {
  let motion = momentum(0, 0);
  let start = 0;
  for (let i = 0; i < count; i++) {
    const t = i / rate;
    const now = stateAt(motion, t - start);
    motion = momentum(now.position, kick(now.velocity, distance));
    start = t;
  }
  return motion.from + coastDistance(motion.velocity);
}

test("wheel distance: a 6-line notch is 108px; pages are 90% of the view; pixels stay native", () => {
  assert.equal(NOTCH, 108);
  assert.equal(wheelDistance(-3, 1, 0), -54);
  assert.equal(wheelDistance(1, 2, 500), 450);
  assert.equal(wheelDistance(40, 0, 500), 0);
});

test("a notch from rest coasts exactly its distance, with no grid", () => {
  const motion = momentum(10, impulse(NOTCH));
  assert.ok(Math.abs(coastDistance(motion.velocity) - NOTCH) < 1e-9);
  const rest = restTime(motion);
  const end = stateAt(motion, rest).position;
  assert.ok(Math.abs(end - (10 + NOTCH)) < 2, `ends near 118: ${end}`);
});

test("it responds at once and decelerates: fast first frame, mostly done by 330ms", () => {
  const motion = momentum(0, impulse(NOTCH));
  const frame = stateAt(motion, 0.016).position;
  assert.ok(frame > 10, `first frame ${frame}px`);
  assert.ok(stateAt(motion, 0.1).position > NOTCH * 0.55);
  assert.ok(stateAt(motion, 0.33).position > NOTCH * 0.94);
  let last = 0;
  let lastStep = Infinity;
  for (let ms = 1; ms <= 600; ms++) {
    const { position } = stateAt(motion, ms / 1000);
    assert.ok(position <= NOTCH + 1e-9, "never past its coast distance");
    assert.ok(position - last <= lastStep + 1e-9, "every frame slower than the one before");
    lastStep = position - last;
    last = position;
  }
  assert.ok(restTime(motion) < 0.7);
});

test("velocity is the derivative of position (momentum)", () => {
  const motion = momentum(0, 900);
  const t = 0.07;
  const dt = 1e-6;
  const numeric = (stateAt(motion, t + dt).position - stateAt(motion, t - dt).position) / (2 * dt);
  assert.ok(Math.abs(numeric - stateAt(motion, t).velocity) < 1e-3);
});

test("slow notches stay linear: precise moves", () => {
  assert.ok(Math.abs(spin(2, 2) / (2 * NOTCH) - 1) < 0.02);
  assert.ok(Math.abs(spin(4, 4) / (4 * NOTCH) - 1) < 0.05);
});

test("fast spins accelerate, more the faster they go, up to the cap", () => {
  const ratio = rate => spin(rate, rate) / (rate * NOTCH);
  const r12 = ratio(12);
  const r20 = ratio(20);
  const r30 = ratio(30);
  assert.ok(r12 > 1.25 && r12 < 1.6, `12/s x${r12}`);
  assert.ok(r20 > r12 && r20 < 3, `20/s x${r20}`);
  assert.ok(r30 > r20 && r30 <= 3, `30/s x${r30}`);
  assert.equal(accelGain(0), 1);
  assert.equal(accelGain(1e9), 3);
});

test("a notch the other way drops the momentum and turns at once", () => {
  const fast = kick(kick(0, NOTCH), NOTCH);
  const turned = kick(fast, -NOTCH);
  assert.equal(turned, impulse(-NOTCH));
  assert.ok(turned < 0);
});

test("no distance, no change", () => {
  assert.equal(kick(500, 0), 500);
});

test("reveal spring: niri's view movement, critically damped, no overshoot", () => {
  assert.deepEqual(SPRING, { dampingRatio: 1, stiffness: 800 });
  const s = spring(0, 72);
  assert.equal(s.damping, 2 * Math.sqrt(800));
  for (let ms = 1; ms <= 1000; ms++) {
    assert.ok(stateAt(s, ms / 1000).position <= 72 + 1e-6, `overshoot at ${ms}ms`);
  }
  const rest = restTime(s);
  assert.ok(rest > 0.15 && rest < 0.45, `rest at ${rest}s`);
});

test("reveal spring matches niri's closed form and starts at its velocity", () => {
  const w = Math.sqrt(800);
  const s = spring(0, 100, 300);
  for (const t of [0.01, 0.05, 0.1, 0.2]) {
    const expected = 100 + Math.exp(-w * t) * (-100 + (w * -100 + 300) * t);
    assert.ok(Math.abs(stateAt(s, t).position - expected) < 1e-9, `t=${t}`);
  }
  assert.ok(Math.abs(stateAt(s, 0).velocity - 300) < 1e-3);
});

test("an underdamped spring still resolves (shared math with niri)", () => {
  const s = spring(0, 50, 0, { dampingRatio: 0.6, stiffness: 500 });
  assert.ok(Number.isFinite(restTime(s)));
});
