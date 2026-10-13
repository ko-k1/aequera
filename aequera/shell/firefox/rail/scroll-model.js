/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera tab list scrolling: pure model (no Firefox APIs; unit-tested with
// node). A classic script like drag-model.js; defines AequeraScrollModel in
// the window and exports it under node.
//
// Wheel: momentum, not fixed steps. A notch is an impulse on a body that
// friction slows exponentially (the kinetic model niri and libadwaita use for
// touchpad flings, with a shorter 110ms time constant: their 0.997/ms takes
// 1.3s to settle a single notch, which floats under a wheel), so the list
// starts at once, coasts, and stops wherever the momentum runs out: no grid,
// no forced position. Notches that land while
// the list still moves the same way add to its velocity, and each one hits
// harder the faster it already goes (acceleration), so a quick spin covers a
// long list while a single notch stays a short, precise move. A notch the
// other way drops the momentum and turns at once.
//
// Reveal (bringing the selected row into view) is a positioning job with an
// exact target, so it rides a critically damped spring (niri's default
// view-movement spring; the solution follows niri's
// src/animation/spring.rs, itself from libadwaita).
//
// Positions are scrollTop values in CSS px; velocities are px/s.

var AequeraScrollModel = (() => {
  "use strict";

  /**
   * Friction time constant (s): velocity falls to 1/e in 110ms, so a single
   * notch covers 60% of its distance in 100ms and 95% in 330ms.
   */
  const TIME_CONSTANT = 0.11;
  /** Velocity decays as e^(FRICTION * t). */
  const FRICTION = -1 / TIME_CONSTANT;
  /**
   * One wheel line, in px. A notch reaches the page as 6 lines (3 system
   * lines doubled by mousewheel.system_scroll_override on Linux and
   * Windows), so a single notch coasts 108px: the distance Firefox's own
   * notch scrolls the list.
   */
  const LINE_PX = 18;
  /** A page delta moves this share of the visible list. */
  const PAGE_SHARE = 0.9;
  /**
   * Acceleration: a same-way notch's impulse is scaled by
   * 1 + speed / ACCEL_SPEED, capped at ACCEL_MAX. Up to ~4 notches/s stays
   * linear (precise moves); a steady 12/s travels 1.4x as far, 20/s 2.3x,
   * 30/s 2.75x.
   */
  const ACCEL_SPEED = 2500;
  const ACCEL_MAX = 3;
  /** Coasting ends below this speed (px/s): under 2px left to travel. */
  const REST_SPEED = 6;

  /** niri horizontal-view-movement defaults (mass 1). */
  const SPRING = { dampingRatio: 1, stiffness: 800 };
  const REST_DISTANCE = 0.5;
  const REST_VELOCITY = 10;

  /** The distance (px) a wheel event asks for; 0 for pixel deltas. */
  function wheelDistance(deltaY, deltaMode, pageHeight) {
    if (deltaMode == 1) {
      return deltaY * LINE_PX;
    }
    if (deltaMode == 2) {
      return deltaY * Math.max(pageHeight, 0) * PAGE_SHARE;
    }
    return 0;
  }

  /** The launch speed that coasts exactly `distance` px to rest. */
  function impulse(distance) {
    return -distance * FRICTION;
  }

  /** Total distance a body launched at `velocity` coasts. */
  function coastDistance(velocity) {
    return -velocity / FRICTION;
  }

  function accelGain(speed) {
    return Math.min(1 + Math.abs(speed) / ACCEL_SPEED, ACCEL_MAX);
  }

  /**
   * Velocity after a notch asking for `distance` hits a body moving at
   * `velocity`: same way (or at rest) adds an impulse scaled by the current
   * speed; the other way drops the old momentum and turns at once.
   */
  function kick(velocity, distance) {
    if (!distance) {
      return velocity;
    }
    if (velocity && Math.sign(velocity) != Math.sign(distance)) {
      return impulse(distance);
    }
    return velocity + impulse(distance) * accelGain(velocity);
  }

  /** A coasting body at `from` px moving at `velocity` px/s. */
  function momentum(from, velocity) {
    return { kind: "momentum", from, velocity };
  }

  /** A spring from `from` to `to` starting at `velocity` px/s. */
  function spring(from, to, velocity = 0, params = SPRING) {
    const stiffness = Math.max(params.stiffness, 0);
    const damping = Math.max(params.dampingRatio, 0) * 2 * Math.sqrt(stiffness);
    return { kind: "spring", from, to, velocity, stiffness, damping };
  }

  /** Spring displacement from its target at `t` s (niri oscillate()). */
  function springOffset(s, t) {
    const beta = s.damping / 2;
    const omega0 = Math.sqrt(s.stiffness);
    const x0 = s.from - s.to;
    const v0 = s.velocity;
    const envelope = Math.exp(-beta * t);
    if (Math.abs(beta - omega0) <= 1.1920929e-7) {
      // Critically damped.
      return envelope * (x0 + (beta * x0 + v0) * t);
    }
    if (beta < omega0) {
      const omega1 = Math.sqrt(omega0 * omega0 - beta * beta);
      return envelope * (x0 * Math.cos(omega1 * t) + ((beta * x0 + v0) / omega1) * Math.sin(omega1 * t));
    }
    const omega2 = Math.sqrt(beta * beta - omega0 * omega0);
    return envelope * (x0 * Math.cosh(omega2 * t) + ((beta * x0 + v0) / omega2) * Math.sinh(omega2 * t));
  }

  /** Position (px) and velocity (px/s) `t` seconds into a motion. */
  function stateAt(motion, t) {
    if (motion.kind == "momentum") {
      const decay = Math.exp(FRICTION * t);
      return {
        position: motion.from + (motion.velocity * (decay - 1)) / FRICTION,
        velocity: motion.velocity * decay,
      };
    }
    // Central difference: the closed form is smooth through t = 0.
    const dt = 1e-5;
    const velocity = (springOffset(motion, t + dt) - springOffset(motion, t - dt)) / (2 * dt);
    return { position: motion.to + springOffset(motion, t), velocity };
  }

  function atRest(motion, t) {
    const { position, velocity } = stateAt(motion, t);
    if (motion.kind == "momentum") {
      return Math.abs(velocity) < REST_SPEED;
    }
    return Math.abs(position - motion.to) < REST_DISTANCE && Math.abs(velocity) < REST_VELOCITY;
  }

  return {
    TIME_CONSTANT,
    LINE_PX,
    ACCEL_SPEED,
    ACCEL_MAX,
    SPRING,
    wheelDistance,
    impulse,
    coastDistance,
    accelGain,
    kick,
    momentum,
    spring,
    stateAt,
    atRest,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraScrollModel;
}
