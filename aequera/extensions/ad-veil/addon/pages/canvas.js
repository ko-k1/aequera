/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The vault's canvas (AdNauseam's stage): a world of ads, placed by
// VeilModel.packAds, seen through a view that pans and zooms. Drag anywhere
// to pan; the wheel zooms around the pointer; keys pan (arrows), zoom (+, -)
// and fit (0). The view is one CSS transform on the world, so moving it
// is compositor work; a change the user did not make (fit, going to an ad)
// eases unless reduced motion is asked for, and any input supersedes it.

var VeilCanvas = (() => {
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 4;
  // Wheel: zoom by e^(-delta × WHEEL_RATE) (pixels; lines are 16 px).
  const WHEEL_RATE = 0.0015;
  const KEY_ZOOM = 1.25;
  const KEY_PAN = 80;
  // Movement (px) before a press becomes a drag instead of a click.
  const DRAG_SLOP = 4;
  // The grid drawn on the stage, in world px.
  const GRID = 40;

  function create(stage, world, { onZoom = () => {}, onBackground = () => {} } = {}) {
    const view = { x: 0, y: 0, z: 1 };
    let bounds = null;
    let easeTimer = 0;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");

    function apply(ease = false) {
      clearTimeout(easeTimer);
      const moving = ease && !reduced.matches;
      stage.classList.toggle("easing", moving);
      if (moving) {
        easeTimer = setTimeout(() => stage.classList.remove("easing"), 300);
      }
      world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
      stage.style.backgroundSize = `${GRID * view.z}px ${GRID * view.z}px`;
      stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
      onZoom(view.z);
    }

    const clamp = z => Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);

    // Input on the stage's controls is theirs. By the path the event took,
    // not the target's ancestors now: a control may have replaced its target
    // (the timeline redraws on pointerdown) before the event reaches here.
    const path = event => event.composedPath();
    const ignored = event => path(event).some(node => node.dataset?.canvasIgnore != null);
    const onAd = event => path(event).some(node => node.classList?.contains("ad-tile"));

    // Zooms by `factor`, keeping the world point under (sx, sy) in place.
    function zoomAt(factor, sx, sy, ease = false) {
      const z = clamp(view.z * factor);
      view.x = sx - ((sx - view.x) * z) / view.z;
      view.y = sy - ((sy - view.y) * z) / view.z;
      view.z = z;
      apply(ease);
    }

    function zoomBy(factor) {
      zoomAt(factor, stage.clientWidth / 2, stage.clientHeight / 2, true);
    }

    // Shows `rect` (world px) in the stage's box less `inset` (px on each
    // side), at most at `max` zoom.
    function show(rect, inset = {}, max = 1, ease = true) {
      const { top = 24, right = 24, bottom = 24, left = 24 } = inset;
      const width = Math.max(stage.clientWidth - left - right, 40);
      const height = Math.max(stage.clientHeight - top - bottom, 40);
      const rw = Math.max(rect.right - rect.left, 1);
      const rh = Math.max(rect.bottom - rect.top, 1);
      view.z = clamp(Math.min(width / rw, height / rh, max));
      view.x = left + (width - rw * view.z) / 2 - rect.left * view.z;
      view.y = top + (height - rh * view.z) / 2 - rect.top * view.z;
      apply(ease);
    }

    function setBounds(next) {
      bounds = next;
    }

    function fit(inset, ease = true) {
      if (bounds) {
        show(bounds, inset, 1, ease);
      }
    }

    function snapshot() {
      return { ...view };
    }

    function restore(saved, ease = true) {
      Object.assign(view, saved);
      apply(ease);
    }

    // Pans so `rect` is in view, at the current zoom (keyboard focus).
    function reveal(rect, inset = {}) {
      const { top = 24, right = 24, bottom = 24, left = 24 } = inset;
      const sx = rect.left * view.z + view.x;
      const sy = rect.top * view.z + view.y;
      const sw = (rect.right - rect.left) * view.z;
      const sh = (rect.bottom - rect.top) * view.z;
      let dx = 0;
      let dy = 0;
      if (sx < left || sw > stage.clientWidth - left - right) {
        dx = left - sx;
      } else if (sx + sw > stage.clientWidth - right) {
        dx = stage.clientWidth - right - sx - sw;
      }
      if (sy < top || sh > stage.clientHeight - top - bottom) {
        dy = top - sy;
      } else if (sy + sh > stage.clientHeight - bottom) {
        dy = stage.clientHeight - bottom - sy - sh;
      }
      if (dx || dy) {
        view.x += dx;
        view.y += dy;
        apply(true);
      }
    }

    // Wheel: zoom around the pointer.
    stage.addEventListener(
      "wheel",
      event => {
        if (ignored(event)) {
          return;
        }
        event.preventDefault();
        const delta = event.deltaY * (event.deltaMode == WheelEvent.DOM_DELTA_LINE ? 16 : 1);
        const box = stage.getBoundingClientRect();
        zoomAt(Math.exp(-delta * WHEEL_RATE), event.clientX - box.left, event.clientY - box.top);
      },
      { passive: false }
    );

    // Drag: pan. A press that never moves is a click (on an ad: open it; on
    // the stage: onBackground). A drag that started on an ad does not open it.
    let press = null;
    let dragged = false;
    stage.addEventListener("pointerdown", event => {
      if (event.button != 0 || ignored(event)) {
        return;
      }
      press = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
      dragged = false;
    });
    stage.addEventListener("pointermove", event => {
      if (!press || event.pointerId != press.id) {
        return;
      }
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < DRAG_SLOP) {
        return;
      }
      if (!press.moved) {
        press.moved = true;
        stage.setPointerCapture(event.pointerId);
        stage.classList.add("panning");
      }
      view.x = press.vx + dx;
      view.y = press.vy + dy;
      apply();
    });
    const release = event => {
      if (!press || event.pointerId != press.id) {
        return;
      }
      dragged = press.moved;
      const background = !press.moved && event.type == "pointerup" && !onAd(event) && !ignored(event);
      press = null;
      stage.classList.remove("panning");
      if (background) {
        onBackground();
      }
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);
    // The click that ends a drag opens nothing.
    stage.addEventListener(
      "click",
      event => {
        if (dragged) {
          dragged = false;
          event.stopPropagation();
          event.preventDefault();
        }
      },
      true
    );

    // Keys, when the stage or an ad has focus.
    stage.addEventListener("keydown", event => {
      if (ignored(event) || event.target.closest("input, select, textarea") || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      const pan = { ArrowLeft: [KEY_PAN, 0], ArrowRight: [-KEY_PAN, 0], ArrowUp: [0, KEY_PAN], ArrowDown: [0, -KEY_PAN] }[event.key];
      if (pan) {
        view.x += pan[0];
        view.y += pan[1];
        apply();
      } else if (event.key == "+" || event.key == "=") {
        zoomBy(KEY_ZOOM);
      } else if (event.key == "-") {
        zoomBy(1 / KEY_ZOOM);
      } else if (event.key == "0") {
        fit();
      } else {
        return;
      }
      event.preventDefault();
    });

    return { zoomBy, fit, show, reveal, setBounds, snapshot, restore, get zoom() { return view.z; } };
  }

  return { create, MIN_ZOOM, MAX_ZOOM };
})();
