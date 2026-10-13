/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera tab list (prototype/shell #tab-list). Loaded into each browser
// window by aequera-main.js.
//
// Firefox's own vertical tab rows switch between two layouts (display
// toggles, re-sized backgrounds) and cannot animate like the prototype, so the
// rail renders its own list of the unpinned tabs, in the prototype's row
// language: the icon never moves, the row grows with the rail, the title is
// revealed by the widening and fades in (aequera-tabs.css). Firefox's tab
// elements stay the source of truth (gBrowser); the rows are a view of them:
//   - click selects; middle-click and the close button close;
//   - the selected row is scrolled into view, however the tab was selected
//     (keyboard, command surface, a new tab, a restored session);
//   - right-click opens Firefox's own tab context menu for that tab (rows
//     carry `.tab`, which TabContextMenu resolves its target from);
//   - drag reorders with a live slide and a settle glide (native tab-strip
//     parity, transform-only); dropping outside tears off a new window;
//     tabs from other windows preview a gap and are adopted at the drop
//     position (the drag carries the native tab-drop type, so vanilla
//     Firefox windows interoperate both ways);
//   - hidden tabs (other workspaces, extensions) are not listed.
// Pinned tabs stay in Firefox's pinned container (the essentials grid).
//
// Geometry note: rows are uniform, so every position derives arithmetically
// from one measured anchor. getBoundingClientRect on a transformed row would
// report its mid-transition position and corrupt the gap math, so transformed
// rows are never measured.
//
// Drag decisions (slide, landing slot, settle, foreign gap, tear-off) are the
// pure AequeraDragModel (drag-model.js, node-tested); this file measures,
// writes transforms, and calls gBrowser. Wheel momentum and the reveal
// spring are the pure AequeraScrollModel (scroll-model.js); icon
// magnification under the pointer is AequeraMagnifyModel (magnify-model.js).
var AequeraTabs = (() => {
  const { wheelDistance, kick, momentum, spring, stateAt, atRest } = AequeraScrollModel;
  const { RADIUS_ROWS, falloff, peakScale, rowScales } = AequeraMagnifyModel;
  const MAGNIFY_PREF = "aequera.rail.magnify";
  const MAGNIFY_PERCENT_PREF = "aequera.rail.magnifyPercent";
  const {
    EDGE_SCROLL_STEP,
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
    clamp,
  } = AequeraDragModel;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  /** Close motion: the rows slide at most this long (ms); the closing row
   * fades in 60% of it. */
  const CLOSE_MOTION_CAP_MS = 200;
  const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";
  // Favicons come from web content (tab `image` attribute). An <img> does not
  // execute script, but a crafted attribute could still load privileged image
  // bytes into chrome UI (spoofing). Allowlist keeps http(s) + data:image for
  // web favicons plus chrome:// + resource:// which Firefox itself uses for
  // internal pages and the default icon below; everything else falls back to
  // the default icon.
  function sanitizeIcon(raw) {
    if (typeof raw !== "string") {
      return DEFAULT_ICON;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return DEFAULT_ICON;
    }
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith("http://") ||
      lower.startsWith("https://") ||
      lower.startsWith("data:image/") ||
      lower.startsWith("chrome://") ||
      lower.startsWith("resource://")
    ) {
      return trimmed;
    }
    return DEFAULT_ICON;
  }
  const STRUCTURE_EVENTS = ["TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned", "TabShow", "TabHide"];
  const ROW_EVENTS = ["TabSelect", "TabAttrModified"];
  const DRAG_TYPE = "text/x-moz-aequera-tab";
  const NATIVE_TAB_TYPE = "application/x-moz-tabbrowser-tab";

  const list = {
    element: null,
    rows: new WeakMap(),
    newTabRow: null,
    /** The list scrolls (its last overflow/underflow event). */
    _overflowing: false,
    /** An overflow change arrived mid-drag; re-place New Tab once idle. */
    _newTabStale: false,
    /** Scroll-fade observer and the first/last children it watches. */
    _edges: null,
    _edgeFirst: null,
    _edgeLast: null,
    /** Running scroll motion: { motion, max, start, frame }; null at rest. */
    _glide: null,
    /** Running close slides (closeMotionPlay). */
    _closeSlides: new Set(),
    /**
     * Icon magnification (aequera.rail.magnify): the peak scale (1 = off),
     * the pointer's clientY over the rows (null when away), the pending
     * frame, and the rows currently scaled.
     */
    _magnify: { peak: 1, pointer: null, frame: 0, scaled: new Set() },
    _drag: null,
    _foreign: null,
    _ghost: null,
    _settleTimer: 0,
    _revealPending: false,
    /** Drag sessions whose drop this list took (see onDragOver). */
    _droppedSessions: new WeakSet(),

    /** Tabs shown as rows, in tab order. */
    tabs() {
      return gBrowser.tabs.filter(tab => !tab.pinned && !tab.hidden && !tab.closing);
    },

    createRow(tab) {
      const row = document.createElementNS(HTML_NS, "div");
      row.className = "aequera-tab";
      row.setAttribute("role", "tab");
      row.draggable = true;
      const icon = document.createElementNS(HTML_NS, "img");
      icon.className = "aequera-tab-icon";
      icon.alt = "";
      const title = document.createElementNS(HTML_NS, "span");
      title.className = "aequera-tab-title";
      const close = document.createElementNS(HTML_NS, "span");
      close.className = "aequera-tab-close";
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "Close tab");
      close.textContent = "×";
      row.append(icon, title, close);
      // TabContextMenu resolves its target from triggerNode.tab.
      for (const node of [row, icon, title, close]) {
        node.tab = tab;
      }
      this.rows.set(tab, row);
      this.updateRow(tab);
      return row;
    },

    updateRow(tab) {
      const row = this.rows.get(tab);
      if (!row) {
        return;
      }
      // TabAttrModified fires often (busy, icon, label): write only what
      // changed, so an unchanged row costs no restyle or relayout.
      const label = tab.label || "";
      row.setAttribute("aria-selected", String(tab.selected));
      if (row.title != label) {
        row.setAttribute("aria-label", label);
        row.title = label;
        row.querySelector(".aequera-tab-title").textContent = label;
      }
      row.toggleAttribute("busy", tab.hasAttribute("busy"));
      row.toggleAttribute("soundplaying", tab.hasAttribute("soundplaying"));
      row.toggleAttribute("muted", tab.hasAttribute("muted"));
      const image = sanitizeIcon(tab.getAttribute("image"));
      const icon = row.querySelector(".aequera-tab-icon");
      if (icon.getAttribute("src") != image) {
        icon.setAttribute("src", image);
      }
    },

    /**
     * Scroll the list so the selected row is fully shown (native tab-strip
     * parity: ensureElementIsVisible). Measures after the next natural flush
     * instead of forcing a reflow on the switch, then scrolls only the list
     * (never the rail, which must not move). Several switches in one frame
     * collapse into one scroll to the last selection.
     */
    revealSelected() {
      if (!this.element || this._revealPending) {
        return;
      }
      this._revealPending = true;
      window
        .promiseDocumentFlushed(() => {
          const row = this.rows.get(gBrowser.selectedTab);
          if (!row?.isConnected || this._drag) {
            return null;
          }
          const list = this.element.getBoundingClientRect();
          const box = row.getBoundingClientRect();
          // Keep the list's own inset clear above and below the row.
          const inset = parseFloat(getComputedStyle(this.element).paddingTop) || 0;
          // An absolute target, so a reveal during a running smooth scroll
          // lands on the row instead of offsetting a moving position.
          const scrollTop = this.element.scrollTop;
          if (box.top < list.top + inset) {
            return scrollTop + box.top - list.top - inset;
          }
          if (box.bottom > list.bottom - inset) {
            return scrollTop + box.bottom - list.bottom + inset;
          }
          return null;
        })
        .then(top => {
          this._revealPending = false;
          if (top !== null) {
            this.glideTo(top);
          }
        })
        .catch(() => {
          // The window closed before the flush.
          this._revealPending = false;
        });
    },

    /**
     * Mouse wheel (line and page deltas): momentum (scroll-model.js). A notch
     * kicks the list, which coasts to a stop wherever friction leaves it;
     * notches while it still moves add up and hit harder the faster it goes
     * (acceleration); a notch the other way turns it at once. Pixel deltas
     * (touchpads, precise wheels) keep Firefox's own kinetic scrolling, as do
     * zoom/horizontal modifiers and a running drag (edge autoscroll).
     */
    onWheel(event) {
      // New Tab forwards its wheel only while it sits outside the list;
      // inside, the list's own listener sees the event as it bubbles.
      if (event.currentTarget === this.newTabRow && this.newTabRow.parentNode === this.element) {
        return;
      }
      if (
        this._drag ||
        !event.deltaY ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) {
        return;
      }
      if (event.deltaMode == WheelEvent.DOM_DELTA_PIXEL) {
        this.stopGlide();
        return;
      }
      const element = this.element;
      const max = element.scrollHeight - element.clientHeight;
      if (max <= 0) {
        return;
      }
      event.preventDefault();
      const distance = wheelDistance(event.deltaY, event.deltaMode, element.clientHeight);
      if (this.instantScroll()) {
        this.stopGlide();
        element.scrollTop = clamp(element.scrollTop + distance, 0, max);
        return;
      }
      const { position, velocity } = this.glideState();
      // Pressed against the edge it is already at: nothing to coast.
      if ((distance < 0 && position <= 0) || (distance > 0 && position >= max)) {
        this.stopGlide();
        return;
      }
      this.startGlide(momentum(position, kick(velocity, distance)), max);
    },

    /**
     * Glide the list to `top` (revealing a row) on the reveal spring,
     * starting from where a running glide is and at its speed.
     */
    glideTo(top) {
      if (this.instantScroll()) {
        this.stopGlide();
        this.element.scrollTop = top;
        return;
      }
      const { position, velocity } = this.glideState();
      // Momentum the other way is dropped: the reveal turns at once instead
      // of swinging past and back.
      const carried = Math.sign(velocity) == Math.sign(top - position) ? velocity : 0;
      this.startGlide(spring(position, top, carried), Infinity);
    },

    /** Reduced motion, or smooth scrolling off (general.smoothScroll). */
    instantScroll() {
      return this.reduceMotion() || !Services.prefs.getBoolPref("general.smoothScroll", true);
    },

    /** Where the list is and how fast it moves (px, px/s). */
    glideState() {
      const glide = this._glide;
      if (!glide) {
        return { position: this.element.scrollTop, velocity: 0 };
      }
      return stateAt(glide.motion, (performance.now() - glide.start) / 1000);
    },

    startGlide(motion, max) {
      this._glide = {
        motion,
        max,
        start: performance.now(),
        frame: this._glide?.frame || requestAnimationFrame(() => this.glideFrame()),
      };
    },

    glideFrame() {
      const glide = this._glide;
      if (!glide || !this.element) {
        return;
      }
      const t = (performance.now() - glide.start) / 1000;
      const { position } = stateAt(glide.motion, t);
      const clamped = clamp(position, 0, glide.max);
      // A coast ends where friction leaves it, or at an edge it runs into;
      // a reveal ends exactly on its row. A non-finite position (numerical
      // trouble) ends it too, rather than spinning frames forever.
      if (!Number.isFinite(position) || atRest(glide.motion, t) || clamped != position) {
        this.element.scrollTop =
          glide.motion.kind == "spring" ? glide.motion.to : Number.isFinite(clamped) ? clamped : this.element.scrollTop;
        this._glide = null;
        return;
      }
      this.element.scrollTop = position;
      glide.frame = requestAnimationFrame(() => this.glideFrame());
    },

    /** Drop a running glide where it is (a drag, native scrolling). */
    stopGlide() {
      if (this._glide) {
        cancelAnimationFrame(this._glide.frame);
        this._glide = null;
      }
    },

    /** Read the magnification prefs; :root[aequera-rail-magnify] arms the CSS. */
    readMagnifyPrefs() {
      const on = Services.prefs.getBoolPref(MAGNIFY_PREF, false);
      this._magnify.peak = on ? peakScale(Services.prefs.getIntPref(MAGNIFY_PERCENT_PREF, 150)) : 1;
      document.documentElement.toggleAttribute("aequera-rail-magnify", this._magnify.peak > 1);
      this.queueMagnify();
    },

    /** Pointer over the rows (or New Tab) moved, left, or the rows moved. */
    onMagnifyPointer(event) {
      const m = this._magnify;
      if (event.type == "mouseout") {
        const to = event.relatedTarget;
        if (to && (this.element.contains(to) || this.newTabRow.contains(to))) {
          return;
        }
        m.pointer = null;
      } else {
        m.pointer = event.clientY;
      }
      this.queueMagnify();
    },

    /** One magnification update per frame, however fast the pointer reports. */
    queueMagnify() {
      const m = this._magnify;
      if (!m.frame && (m.pointer !== null || m.scaled.size)) {
        m.frame = requestAnimationFrame(() => this.magnifyFrame());
      }
    },

    /**
     * Scale the icons near the pointer (magnify-model.js): rows keep their
     * size and place, only the icon inside grows (--aequera-magnify, a CSS
     * scale), so nothing moves under the pointer. Geometry from layout
     * offsets (never transformed rects): rows are uniform, so one row and
     * the gap give every center. Off under reduced motion and while a tab
     * is dragged.
     */
    magnifyFrame() {
      const m = this._magnify;
      m.frame = 0;
      const next = new Map();
      if (m.peak > 1 && m.pointer !== null && !this._drag && !this.reduceMotion() && this.element) {
        const element = this.element;
        const children = element.children;
        let count = children.length;
        while (count && !this.isFlowRow(children[count - 1])) {
          count--;
        }
        const first = children[0];
        if (count && this.isFlowRow(first)) {
          const listTop = element.getBoundingClientRect().top;
          const step = first.offsetHeight + (parseFloat(getComputedStyle(element).rowGap) || 0);
          const firstCenter = listTop + first.offsetTop + first.offsetHeight / 2 - element.scrollTop;
          for (const [i, scale] of rowScales({ pointer: m.pointer, firstCenter, step, count, peak: m.peak })) {
            next.set(children[i], scale);
          }
          // New Tab under the list (overflowing rows) is on the same bell.
          if (this.newTabRow.isConnected && this.newTabRow.parentNode !== element) {
            const box = this.newTabRow.getBoundingClientRect();
            const scale =
              1 + (m.peak - 1) * falloff((box.top + box.height / 2 - m.pointer) / (RADIUS_ROWS * step));
            if (scale > 1.001) {
              next.set(this.newTabRow, scale);
            }
          }
        }
      }
      for (const row of m.scaled) {
        if (!next.has(row)) {
          row.style.removeProperty("--aequera-magnify");
        }
      }
      for (const [row, scale] of next) {
        row.style.setProperty("--aequera-magnify", scale.toFixed(3));
      }
      m.scaled = new Set(next.keys());
    },

    /** A row in the list's flow (not a closing ghost, not the drop line). */
    isFlowRow(node) {
      return node.classList.contains("aequera-tab") && !node.classList.contains("aequera-tab-closing");
    },

    /**
     * Put exactly the listed tabs' rows in tab order (nodes are reused).
     * `closing`: the tab a TabClose is removing, whose row leaves with the
     * close motion (closeMotionStart) instead of vanishing.
     */
    render(closing = null) {
      if (!this.element) {
        return;
      }
      if (this._drag) {
        return;
      }
      // A structure change supersedes a running drop settle or a foreign
      // gap preview. (The render inside the drop's own moveTabTo runs before
      // its settle timer is armed, so only an already-running settle dies.)
      if (this._settleTimer) {
        this.endSettle();
      } else {
        this.clearDragVisuals();
      }
      this._foreign = null;
      // Nothing is moving any more unless a settle still glides: a stale
      // movingtab (a dragover that arrived after its drop) would keep the
      // slide transitions armed for unrelated changes.
      if (!this._settleTimer && !this._committing) {
        this.setMoving(false);
      }
      const motion = closing ? this.closeMotionStart(closing) : null;
      // Rows of earlier closes still fading out ride along.
      const ghosts = this.element.querySelectorAll(":scope > .aequera-tab-closing");
      const rows = this.tabs().map(tab => this.rows.get(tab) ?? this.createRow(tab));
      // New Tab closes the list unless overflow already moved it out.
      const newTabInside = !this.newTabRow.isConnected || this.newTabRow.parentNode === this.element;
      if (newTabInside) {
        this.element.replaceChildren(...rows, this.newTabRow, ...ghosts);
      } else {
        this.element.replaceChildren(...rows, ...ghosts);
      }
      if (motion) {
        this.closeMotionPlay(motion, newTabInside ? [...rows, this.newTabRow] : rows);
      }
      this.observeEdges();
      // Rows moved under a pointer that may be still.
      this.queueMagnify();
    },

    /**
     * Close motion, measured before the closing row leaves the flow: where
     * it sits, one slot (row + gap), and where the scroll position will be
     * once the list is one slot shorter (it clamps at the bottom). Plain
     * arithmetic on a clean layout; nothing is measured after the change.
     * Null when there is nothing to animate (reduced motion, a drag, the
     * row not listed).
     */
    closeMotionStart(tab) {
      const element = this.element;
      const row = this.rows.get(tab);
      const duration = Math.min(this.motionMs(), CLOSE_MOTION_CAP_MS);
      if (!row || row.parentNode !== element || this._drag || this.reduceMotion() || !(duration > 0)) {
        return null;
      }
      const index = Array.prototype.indexOf.call(element.children, row);
      const style = getComputedStyle(element);
      const step = row.offsetHeight + (parseFloat(style.rowGap) || 0);
      if (index < 0 || !(step > 0)) {
        return null;
      }
      const scrollTop = element.scrollTop;
      const clientHeight = element.clientHeight;
      return {
        row,
        index,
        step,
        padTop: parseFloat(style.paddingTop) || 0,
        scrollTop,
        // One slot shorter: a list scrolled to the bottom clamps up by it.
        scrollAfter: Math.min(scrollTop, Math.max(0, element.scrollHeight - step - clientHeight)),
        clientHeight,
        duration,
        easing: getComputedStyle(document.documentElement).getPropertyValue("--aequera-motion-easing").trim() || "ease-out",
      };
    },

    /**
     * Play the close motion once the rows are in their new order (`flow`:
     * the rows, then New Tab when it closes the list). The closing row
     * stays where it was, out of the flow, and fades out (faster than the
     * slide: exits lead); the rows that moved slide from where they were
     * into place. Additive transform animations: compositor-run, and quick
     * successive closes stack instead of cutting each other off. Only the
     * rows on screen animate, so a close costs the same with 5 or 500 tabs.
     */
    closeMotionPlay(motion, flow) {
      const { row, index, step, padTop, scrollTop, scrollAfter, clientHeight, duration, easing } = motion;
      const element = this.element;
      // The rows above it move only if the scroll position clamps.
      const shift = scrollAfter - scrollTop;
      row.classList.add("aequera-tab-closing");
      row.setAttribute("aria-hidden", "true");
      row.removeAttribute("role");
      row.style.top = `${padTop + index * step + shift}px`;
      element.append(row);
      const fade = row.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.96)" }], {
        duration: duration * 0.6,
        easing: "ease-in",
      });
      const drop = () => {
        if (row.parentNode === element && row.classList.contains("aequera-tab-closing")) {
          row.remove();
        }
      };
      fade.finished.then(drop, drop);

      const first = Math.max(0, Math.floor((scrollAfter - padTop) / step) - 1);
      const last = Math.min(flow.length - 1, Math.ceil((scrollAfter + clientHeight) / step) + 1);
      for (let j = first; j <= last; j++) {
        // Where it was on screen minus where it is now. At the bottom the
        // clamp moves everything down by -shift: the rows below land where
        // they were (no slide, so no transform stretching the scroll range
        // and slowing the clamp), and the rows above glide down instead.
        const was = j < index ? j : j + 1;
        const delta = (was - j) * step + shift;
        if (!delta) {
          continue;
        }
        const slide = flow[j].animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
          { duration, easing, composite: "add" }
        );
        this._closeSlides.add(slide);
        const done = () => this._closeSlides.delete(slide);
        slide.finished.then(done, done);
      }
    },

    /** Land every close slide at once (a drag measures rows next). */
    finishCloseMotion() {
      for (const slide of this._closeSlides) {
        slide.finish();
      }
      this._closeSlides.clear();
    },

    /** The shared motion duration in ms (0 under reduced motion). */
    motionMs() {
      try {
        return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--aequera-motion-duration")) || 0;
      } catch (e) {
        return 0;
      }
    },

    /**
     * Scroll fades (aequera-tabs.css [fade-start]/[fade-end]): an edge fades
     * while a row is cut off or scrolled away past it. An IntersectionObserver
     * on the first and last child against the list itself tracks that
     * through scrolling, resizing, and new rows, without layout reads here.
     */
    observeEdges() {
      // Rows fading out of a close are not the list's edges.
      let first = this.element.firstElementChild;
      while (first?.classList.contains("aequera-tab-closing")) {
        first = first.nextElementSibling;
      }
      let last = this.element.lastElementChild;
      while (last?.classList.contains("aequera-tab-closing")) {
        last = last.previousElementSibling;
      }
      if (first === this._edgeFirst && last === this._edgeLast) {
        return;
      }
      this._edges ??= new IntersectionObserver(entries => this.onEdges(entries), {
        root: this.element,
        threshold: 0.99,
      });
      this._edges.disconnect();
      this._edgeFirst = first;
      this._edgeLast = last;
      for (const node of new Set([first, last])) {
        if (node) {
          this._edges.observe(node);
        }
      }
      if (!first) {
        this.element.removeAttribute("fade-start");
        this.element.removeAttribute("fade-end");
      }
    },

    onEdges(entries) {
      for (const entry of entries) {
        const cut = entry.intersectionRatio < 0.99;
        if (entry.target === this._edgeFirst) {
          this.element.toggleAttribute("fade-start", cut);
        }
        if (entry.target === this._edgeLast) {
          this.element.toggleAttribute("fade-end", cut);
        }
      }
    },

    /**
     * New Tab closes the list while the rows fit. Once they overflow, it
     * would scroll away under the workspace dock, so it steps out of the
     * scroller and sits right under it, always in reach; it steps back in
     * when they fit again. Both places take the same 36px (6px gap + 30px
     * row inside; 2px + 30px + 4px outside, see aequera-tabs.css), so the
     * move never flips the overflow state back. Driven by Gecko's
     * overflow/underflow events: no layout reads on the tab-open path.
     */
    onOverflowChange(event) {
      // detail 1 is horizontal-only; titles never scroll sideways.
      if (event.target !== this.element || event.detail == 1) {
        return;
      }
      this._overflowing = event.type == "overflow";
      // Drag transforms count as overflow: never move New Tab mid-drag.
      if (this._drag || this._settleTimer || this.element.hasAttribute("movingtab")) {
        this._newTabStale = true;
        return;
      }
      this.placeNewTab();
    },

    placeNewTab() {
      const inside = this.newTabRow.parentNode === this.element;
      if (this._overflowing == !inside) {
        return;
      }
      this.newTabRow.style.transform = "";
      if (this._overflowing) {
        this.element.after(this.newTabRow);
      } else {
        this.element.append(this.newTabRow);
      }
      this.element.toggleAttribute("overflowing", this._overflowing);
      this.observeEdges();
    },

    /** After a drag: the events seen during it may have been transforms. */
    syncNewTab() {
      if (!this._newTabStale) {
        return;
      }
      this._newTabStale = false;
      const element = this.element;
      window
        .promiseDocumentFlushed(() => element.scrollHeight > element.clientHeight)
        .then(overflowing => {
          if (this._drag || element.hasAttribute("movingtab")) {
            this._newTabStale = true;
            return;
          }
          // New Tab takes the same 36px in or out of the list, so this
          // measure holds wherever it currently is.
          this._overflowing = overflowing;
          this.placeNewTab();
        })
        .catch(() => {});
    },

    handleEvent(event) {
      const tab = event.target.tab ?? event.target;
      switch (event.type) {
        case "TabSelect":
          // Only the outgoing and incoming rows change: a switch must not
          // touch every row (O(tabs) restyles on an input path).
          this.clearForeign();
          if (event.detail?.previousTab) {
            this.updateRow(event.detail.previousTab);
          }
          this.updateRow(tab);
          this.revealSelected();
          break;
        case "TabAttrModified":
          this.updateRow(tab);
          break;
        case "mousedown":
          this.onMouseDown(event);
          break;
        case "click":
          this.onClick(event);
          break;
        case "auxclick":
          if (event.button == 1 && event.target.tab) {
            gBrowser.removeTab(event.target.tab, { animate: true });
          }
          break;
        case "contextmenu":
          this.onContextMenu(event);
          break;
        case "dragstart":
          this.onDragStart(event);
          break;
        case "dragover":
          this.onDragOver(event);
          break;
        case "drop":
          this.onDrop(event);
          break;
        case "dragleave":
          this.onDragLeave(event);
          break;
        case "dragend":
          this.onDragEnd(event);
          break;
        case "wheel":
          this.onWheel(event);
          break;
        case "mousemove":
        case "mouseout":
          this.onMagnifyPointer(event);
          break;
        case "scroll":
          this.queueMagnify();
          break;
        case "overflow":
        case "underflow":
          this.onOverflowChange(event);
          break;
        default:
          // Structure changed (open/close/move/pin/show/hide). TabClose fires
          // while the tab is still in gBrowser.tabs (filtered as closing).
          this.render(event.type == "TabClose" ? event.target : null);
      }
    },

    onMouseDown(event) {
      const target = event.target;
      if (event.button != 0 || !target.tab || target.classList.contains("aequera-tab-close")) {
        return;
      }
      gBrowser.selectedTab = target.tab;
    },

    onClick(event) {
      const target = event.target;
      if (event.button != 0) {
        return;
      }
      if (target.classList.contains("aequera-tab-close") && target.tab) {
        gBrowser.removeTab(target.tab, { animate: true });
      }
    },

    onContextMenu(event) {
      if (!event.target.tab) {
        return;
      }
      event.preventDefault();
      document
        .getElementById("tabContextMenu")
        .openPopupAtScreen(event.screenX, event.screenY, true, event);
    },

    reduceMotion() {
      return window.gReduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
    },

    /** Row owning the event target, excluding the New Tab row. */
    dragRowOf(target) {
      return target.closest?.(".aequera-tab:not(.aequera-newtab)") ?? null;
    },

    /** Moving-tab mode arms the slide/settle row transitions (see CSS). */
    setMoving(on) {
      if (!this.element) {
        return;
      }
      if (on) {
        this.element.setAttribute("movingtab", "true");
      } else {
        this.element.removeAttribute("movingtab");
        this.syncNewTab();
      }
    },

    onDragStart(event) {
      // A new local drag supersedes any foreign preview in progress, and
      // owns the scroll position (edge autoscroll) from here on.
      this.clearForeign();
      this.stopGlide();
      // Drag geometry is measured from row rects: no slide may be running.
      this.finishCloseMotion();
      // Nothing magnified while a row is carried.
      this.queueMagnify();
      const row = this.dragRowOf(event.target);
      if (!row?.tab || !row.tab.isConnected) {
        return;
      }
      if (this._drag) {
        this.cancelDrag();
      }
      // A previous drop's settle must not fire mid-drag and wipe the new
      // drag's transforms, nor leave rebased transforms behind (they would
      // make measureLayout bail and kill the new drag's live slide): retire
      // it fully; the new drag re-arms movingtab itself below.
      if (this._settleTimer) {
        this.endSettle();
      }
      const box = row.getBoundingClientRect();
      const rm = this.reduceMotion();
      const from = this.tabs().indexOf(row.tab);
      this._drag = {
        tab: row.tab,
        row,
        from,
        drop: from,
        target: from,
        startY: event.clientY,
        // The list's scroll at the start: the dragged row lives in the
        // scrolled content, so autoscroll must be added back to keep it
        // under the pointer (dragFrame).
        scrollStart: this.element.scrollTop,
        lastY: event.clientY,
        forward: true,
        translate: 0,
        shifts: new Map(),
        pending: null,
        frame: 0,
        zone: 0,
        layout: null,
        pristine: null,
        ghostOutside: false,
        offsetX: event.clientX - box.left,
        offsetY: event.clientY - box.top,
        dropped: false,
        rm,
      };
      const dt = event.dataTransfer;
      try {
        dt.effectAllowed = "move";
        // The tab type must come first: Firefox takes a drag for a tab move
        // only when it is the first type (getDropEffectForTabDrag);
        // otherwise its strip reads the drag as a link and loads the tab's
        // URL there.
        dt.mozSetDataAt(NATIVE_TAB_TYPE, row.tab, 0);
        dt.setData(DRAG_TYPE, row.tab.label || "#");
        // The URL, for targets that take a dropped tab's address. Never
        // text/x-moz-url or text/plain: a drop on the desktop would then
        // make an internet shortcut instead of tearing the tab off
        // (Firefox's own tab drag sets the same).
        const url = row.tab.linkedBrowser?.currentURI?.spec;
        if (url) {
          dt.mozSetDataAt("text/x-moz-text-internal", url, 0);
        }
        dt.mozCursor = "default";
        // The row, not Firefox's hidden tab, is the drag source, so dragend
        // comes back to this list. With the tab as source it went to
        // Firefox's tab strip, which ran its own tear-off (and threw on the
        // missing _dragData), and this drag never ended.
        dt.addElement(row);
      } catch (error) {
        console.error("aequera-tabs: setting up the drag data failed", error);
      }
      // Firefox's own drop code (the essentials grid, another window's tab
      // strip) reads tab._dragData. A drag from outside its strip is the
      // shape its all-tabs menu uses (fromTabList), which those handlers
      // already support: dropping on the essentials pins, dropping on a
      // Firefox window adopts the tab there.
      row.tab._dragData = {
        offsetX: event.screenX - window.screenX,
        offsetY: event.screenY - window.screenY,
        scrollPos: 0,
        screenX: event.screenX,
        screenY: event.screenY,
        movingTabs: [row.tab],
        movingTabsSet: new Set([row.tab]),
        fromTabList: true,
        expandGroupOnDrop: false,
        get tabGroupCreationColor() {
          return gBrowser.tabGroupMenu.nextUnusedColor;
        },
      };
      try {
        this.setDragImage(dt, row, event.clientX - box.left, event.clientY - box.top, rm);
      } catch {
        // Platform drag-image quirks must not break the drag itself.
      }
      // Direct manipulation tracks the pointer 1:1 (see the dragging rule
      // in aequera-tabs.css); siblings keep gliding on the transition.
      row.setAttribute("dragging", "true");
      if (!rm) {
        this.setMoving(true);
      }
    },

    /**
     * The drag image. Inside the list the sliding row itself is the visual,
     * so the image is hidden there and shows only once the pointer leaves
     * (tear-off, another window). Windows and macOS swap the image mid-drag
     * with updateDragImage; Linux cannot (Firefox's own tab drag notes the
     * same), so there a drag panel follows the pointer: live DOM whose
     * content shows or hides with [outside] (setGhostOutside). Reduced
     * motion has no slide, so the image shows throughout.
     */
    setDragImage(dt, row, offsetX, offsetY, rm) {
      const x = Math.round(offsetX);
      const y = Math.round(offsetY);
      if (AppConstants.platform == "linux") {
        // The pill is narrower than the row: hold it by its icon, not by
        // the grab point within the full-width row.
        const panel = this.dragPanel(row);
        panel.toggleAttribute("outside", rm);
        dt.setDragImage(panel, Math.min(x, 15), Math.min(y, 15));
      } else if (rm) {
        dt.setDragImage(row, x, y);
      } else {
        dt.setDragImage(this.ghostImage(), 0, 0);
      }
    },

    /** Show the drag image once the pointer is outside the list. */
    setGhostOutside(drag, outside, dt) {
      if (drag.ghostOutside == outside) {
        return;
      }
      drag.ghostOutside = outside;
      // Outside the list nothing will be reordered: the rows go back to
      // the current order and the source row dims, so the list does not
      // show a landing slot a release out there will never use. Coming
      // back in rebuilds the slide from the pointer.
      drag.row.toggleAttribute("dragout", outside);
      if (outside) {
        this.resetSlide(drag);
        this.showDropIndicator(null);
      }
      if (drag.rm) {
        return;
      }
      if (AppConstants.platform == "linux") {
        this._dragPanel?.toggleAttribute("outside", outside);
        return;
      }
      try {
        if (outside) {
          dt.updateDragImage(drag.row, Math.round(drag.offsetX), Math.round(drag.offsetY));
        } else {
          dt.updateDragImage(this.ghostImage(), 0, 0);
        }
      } catch {}
    },

    /** Reduced motion: a still line in the gap the drop lands in. */
    showDropIndicator(row, after) {
      let line = this._dropLine;
      if (!row) {
        line?.remove();
        return;
      }
      if (!line) {
        line = this._dropLine = document.createElementNS(HTML_NS, "div");
        line.className = "aequera-tab-dropline";
      }
      if (line.parentNode != this.element) {
        this.element.append(line);
      }
      // Centered in the 6px gap above or below the row (list coordinates:
      // the list is the line's containing block and scrolls with it).
      const gap = parseFloat(getComputedStyle(this.element).rowGap) || 0;
      const y = row.offsetTop + (after ? row.offsetHeight + gap / 2 : -gap / 2) - 1;
      line.style.transform = `translateY(${Math.round(y)}px)`;
    },

    /** Undo the live slide: every row back in its slot, no landing gap. */
    resetSlide(drag) {
      if (drag.frame) {
        cancelAnimationFrame(drag.frame);
        drag.frame = 0;
      }
      drag.zone = 0;
      for (const row of drag.shifts.keys()) {
        row.style.transform = "";
        drag.pristine?.add(row);
      }
      drag.shifts.clear();
      drag.row.style.transform = "";
      drag.translate = 0;
      const from = this.tabs().indexOf(drag.tab);
      drag.drop = from;
      drag.target = from;
    },

    /** The Linux drag panel: the dragged row's icon and title as a pill. */
    dragPanel(row) {
      let panel = this._dragPanel;
      if (!panel) {
        panel = document.createXULElement("panel");
        panel.id = "aequera-tab-drag-panel";
        panel.setAttribute("type", "drag");
        const item = document.createElementNS(HTML_NS, "div");
        item.className = "aequera-tab-drag-item";
        const icon = document.createElementNS(HTML_NS, "img");
        icon.className = "aequera-tab-icon";
        icon.alt = "";
        const title = document.createElementNS(HTML_NS, "span");
        title.className = "aequera-tab-drag-title";
        item.append(icon, title);
        panel.append(item);
        document.documentElement.append(panel);
        this._dragPanel = panel;
      }
      panel.querySelector(".aequera-tab-icon").src = row.querySelector(".aequera-tab-icon").src;
      panel.querySelector(".aequera-tab-drag-title").textContent = row.tab.label || "";
      return panel;
    },

    /** Forget Firefox's per-drag state on the tab (see onDragStart). */
    releaseDragData(tab) {
      if (tab) {
        delete tab._dragData;
      }
    },

    // Shared transparent 1x1 drag image (Windows, macOS): hides the OS
    // ghost while the sliding row itself is the visual.
    ghostImage() {
      if (!this._ghost) {
        const canvas = document.createElementNS(HTML_NS, "canvas");
        canvas.width = 1;
        canvas.height = 1;
        this._ghost = canvas;
      }
      return this._ghost;
    },

    onDragOver(event) {
      const drag = this._drag;
      if (drag && drag.tab.isConnected) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        this.setGhostOutside(drag, false, event.dataTransfer);
        if (drag.rm) {
          // No slide in reduced motion; a still line marks the landing spot
          // instead (the same rule the drop uses), so there is feedback
          // without motion.
          const { target, after } = this.dropTargetFromEvent(event, drag.tab);
          this.showDropIndicator(target && this.rows.get(target), after);
          return;
        }
        drag.pending = event.clientY;
        if (Number.isFinite(event.clientY)) {
          this.dragFrame(event.clientY);
        }
        this.kickScroll(drag);
        return;
      }
      if (drag) {
        return;
      }
      // A dragover can still arrive after this list took the drop (the
      // compositor's last motion); it must not open a new preview that no
      // drop or dragleave will ever close.
      if (this.droppedSession()) {
        return;
      }
      const ftab = this.foreignTab(event);
      // Links (from a page, the address bar, a bookmark) open as a new tab
      // at the gap, as on Firefox's tab strip.
      const link = !ftab && this.canDropLink(event);
      if (!ftab && !link) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = ftab ? "move" : "link";
      if (this.reduceMotion()) {
        // No sliding preview: the still line marks the gap instead.
        if (!this._foreign || this._foreign.tab !== ftab) {
          this.clearForeign();
          this._foreign = { tab: ftab, drop: null, shifts: new Map(), rows: new Set() };
        }
        const still = this.foreignGap(event.clientY);
        const pairs = still?.pairs ?? [];
        const ref = gapRef(pairs.length, still?.k ?? pairs.length);
        if (ref) {
          this.showDropIndicator(pairs[ref.index][1], ref.after);
        }
        return;
      }
      const gap = this.foreignGap(event.clientY);
      if (!gap) {
        this.clearForeign();
        this._foreign = { tab: ftab, drop: null, shifts: new Map(), rows: new Set() };
        return;
      }
      let f = this._foreign;
      if (!f || f.tab !== ftab) {
        f = this._foreign = { tab: ftab, drop: -1, shifts: new Map(), rows: new Set() };
      }
      if (gap.k === f.drop) {
        return;
      }
      f.drop = gap.k;
      f.rows.clear();
      const shifts = gapShifts(gap.pairs.length, gap.k, gap.step);
      for (let i = 0; i < gap.pairs.length; i++) {
        const row = gap.pairs[i][1];
        const s = shifts[i];
        if (s) {
          f.shifts.set(row, s);
          f.rows.add(row);
        } else {
          f.shifts.delete(row);
        }
        row.style.transform = s ? `translateY(${s}px)` : "";
      }
      // The New Tab row closes the list: it makes room like any row below
      // the gap, so the last row never slides over it. Out of the list
      // (overflowing rows) it stays put above the dock.
      if (this.newTabRow?.parentNode === this.element) {
        f.shifts.set(this.newTabRow, gap.step);
        f.rows.add(this.newTabRow);
        this.newTabRow.style.transform = `translateY(${gap.step}px)`;
      }
      this.setMoving(true);
    },

    kickScroll(drag) {
      if (drag.zone && !drag.frame) {
        drag.frame = requestAnimationFrame(() => this.scrollTick());
      }
    },

    scrollTick() {
      const drag = this._drag;
      if (!drag || !this.element) {
        return;
      }
      drag.frame = 0;
      if (!drag.zone) {
        return;
      }
      // Single scroll per tick lives in dragFrame (which recomputes the zone
      // and scrolls once); scrolling here as well would double-step.
      this.dragFrame(Number.isFinite(drag.pending) ? drag.pending : drag.lastY);
      this.kickScroll(drag);
    },

    // Row geometry in content coordinates, measured once while nothing
    // is transformed. See the file header for why nothing transformed
    // may ever be measured.
    measureLayout(order, rows, listTop) {
      const first = rows.get(order[0]);
      const second = order.length > 1 ? rows.get(order[1]) : null;
      if (!first || first.style.transform || second?.style.transform) {
        return null;
      }
      const top0 = first.getBoundingClientRect();
      const rowH = top0.height;
      if (!(rowH > 0)) {
        return null;
      }
      let step = rowH;
      if (second) {
        step = Math.max(rowH, second.getBoundingClientRect().top - top0.top);
      }
      return { rowH, step: Math.round(step), padTop: top0.top - listTop + this.element.scrollTop };
    },

    dragFrame(clientY, { final = false } = {}) {
      const drag = this._drag;
      if (!drag || !this.element) {
        return;
      }
      const order = this.tabs();
      const from = order.indexOf(drag.tab);
      if (from < 0) {
        return;
      }
      const rows = new Map();
      for (const tab of order) {
        const row = this.rows.get(tab);
        if (row?.isConnected) {
          rows.set(tab, row);
        }
      }
      if (!rows.get(drag.tab)) {
        return;
      }
      const rowEls = order.map(tab => rows.get(tab));
      const listRect = this.element.getBoundingClientRect();
      const scrollTop = this.element.scrollTop;
      if (!drag.layout) {
        drag.layout = this.measureLayout(order, rows, listRect.top);
        if (drag.layout) {
          drag.pristine = new Set([...rows.values()]);
        }
      }
      if (!drag.layout) {
        return;
      }
      const { rowH, step } = drag.layout;
      // Re-anchor from a never-touched background row; the cached anchor
      // otherwise stays valid across scrolls (content coordinates). The
      // dragged row always carries its translate and never qualifies.
      for (let i = 0; i < order.length; i++) {
        if (i == from) {
          continue;
        }
        const row = rowEls[i];
        if (row && drag.pristine.has(row)) {
          drag.layout.padTop = row.getBoundingClientRect().top - listRect.top + scrollTop - i * step;
          break;
        }
      }
      const old = drag.drop;
      const frame = slideFrame({
        count: order.length,
        from,
        rowH,
        step,
        listTop: listRect.top,
        listBottom: listRect.bottom,
        padTop: drag.layout.padTop,
        scrollTop,
        startY: drag.startY,
        scrollStart: drag.scrollStart,
        clientY,
        lastY: drag.lastY,
        forward: drag.forward,
        drop: old,
        target: drag.target,
        shifts: rowEls.map(row => drag.shifts.get(row) ?? 0),
        final,
        canScrollUp: scrollTop > 0,
        canScrollDown: scrollTop + this.element.clientHeight < this.element.scrollHeight,
      });
      drag.forward = frame.forward;
      drag.lastY = frame.lastY;
      drag.translate = frame.translate;
      drag.target = frame.target;
      drag.drop = frame.drop;
      drag.zone = frame.zone;
      rows.get(drag.tab).style.transform = frame.translate
        ? `translateY(${Math.round(frame.translate)}px)`
        : "";
      if (frame.drop != old) {
        for (let i = 0; i < order.length; i++) {
          const row = rowEls[i];
          if (i == from || !row) {
            continue;
          }
          const s = slideShift(i, from, frame.drop, step);
          if (s) {
            drag.shifts.set(row, s);
            drag.pristine.delete(row);
          } else {
            drag.shifts.delete(row);
          }
          row.style.transform = s ? `translateY(${s}px)` : "";
        }
      }
      if (drag.zone) {
        this.element.scrollBy(0, drag.zone * EDGE_SCROLL_STEP);
      }
    },

    /** True when the pointer left the list (relatedTarget is unreliable
     * mid-drag, bug 458613, so coordinates decide row-crossing vs exit). */
    leftList(event) {
      if (!this.element || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
        return false;
      }
      const rect = this.element.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    },

    onDragLeave(event) {
      const drag = this._drag;
      if (drag && this.element && this.leftList(event)) {
        this.setGhostOutside(drag, true, event.dataTransfer);
        return;
      }
      if (!drag && this._foreign && this.leftList(event)) {
        this.clearForeign();
      }
    },

    /** The current drag session, or null. */
    dragSession() {
      try {
        return Cc["@mozilla.org/widget/dragservice;1"]
          .getService(Ci.nsIDragService)
          .getCurrentSession(window);
      } catch {
        return null;
      }
    },

    /** This list already took the current drag session's drop. */
    droppedSession() {
      const session = this.dragSession();
      return !!session && this._droppedSessions.has(session);
    },

    onDrop(event) {
      const session = this.dragSession();
      if (session) {
        this._droppedSessions.add(session);
      }
      const drag = this._drag;
      if (drag && drag.tab.isConnected) {
        this.dropLocal(event, drag);
        return;
      }
      if (drag) {
        return;
      }
      this.dropForeign(event);
    },

    dropLocal(event, drag) {
      drag.dropped = true;
      event.preventDefault();
      if (drag.frame) {
        cancelAnimationFrame(drag.frame);
        drag.frame = 0;
      }
      // The release point decides, not the last dragover: a quick drag can
      // drop before a dragover reached the final position, which landed
      // the tab a slot or more short of where it was let go.
      if (!drag.rm && !drag.ghostOutside && Number.isFinite(event.clientY)) {
        this.dragFrame(event.clientY, { final: true });
      }
      let target = null;
      let after = false;
      if (!drag.rm) {
        const order = this.tabs();
        const slot = slotTarget(order.indexOf(drag.tab), drag.target);
        if (slot) {
          target = order[slot.index];
          after = slot.after;
        }
      }
      if (!target || target == drag.tab) {
        ({ target, after } = this.dropTargetFromEvent(event, drag.tab));
      }
      this._drag = null;
      this.releaseDragData(drag.tab);
      if (!target || target == drag.tab) {
        this.setMoving(false);
        this.render();
        return;
      }
      const targetIndex = gBrowser.tabs.indexOf(target);
      const gFrom = gBrowser.tabs.indexOf(drag.tab);
      if (targetIndex < 0 || gFrom < 0) {
        this.setMoving(false);
        this.render();
        return;
      }
      const tabIndex = moveIndex(gFrom, targetIndex, after);
      // Snapshot live offsets first: the render inside moveTabTo sweeps
      // row styles, so the settle below must work from this snapshot, and
      // must write after the move (anything written before is swept too).
      // The transition stays armed throughout: retargeting live transitions
      // across the commit keeps a single forward glide, while tearing the
      // transition property down and back up orphans them (they keep
      // timelining without painting).
      const live = !drag.rm ? this.liveTransforms(this.tabs()) : null;
      // The render inside the move must keep movingtab armed for the glide.
      this._committing = true;
      try {
        gBrowser.moveTabTo(drag.tab, { tabIndex });
      } finally {
        this._committing = false;
      }
      // TabMove rendered the final order above. Rebase the snapshot onto
      // the committed slots (exact visuals), lock them in, then release
      // next frame to glide home (native tabdrop-samewindow parity).
      // Retire movingtab on landing.
      const gliding = live && this.settleRebase(drag, target, after, live);
      if (gliding) {
        if (this.element) {
          void this.element.offsetHeight;
        }
        this._settleTimer = setTimeout(() => this.endSettle(), this.settleDelay());
        requestAnimationFrame(() => {
          if (this._settleTimer) {
            this.clearDragVisuals();
          }
        });
      } else {
        this.clearDragVisuals();
        this.setMoving(false);
      }
    },

    liveTransforms(order) {
      const live = new Map();
      for (const tab of order) {
        const row = this.rows.get(tab);
        if (row) {
          live.set(tab, row.style.transform || "");
        }
      }
      return live;
    },

    settleRebase(drag, target, after, live) {
      if (!drag.layout) {
        return false;
      }
      const order = [...live.keys()];
      // Commit only onto the order the move actually produced; a clamped
      // no-op move leaves the DOM untouched and has nothing to settle.
      const offsets = settleOffsets({
        order,
        offsets: order.map(tab => parseTranslateY(live.get(tab))),
        dragged: drag.tab,
        target,
        after,
        now: this.tabs(),
        step: drag.layout.step,
      });
      if (!offsets) {
        return false;
      }
      let moved = false;
      for (let i = 0; i < order.length; i++) {
        const row = this.rows.get(order[i]);
        if (!row) {
          continue;
        }
        row.removeAttribute("dragging");
        const v = offsets[i];
        if (v) {
          moved = true;
        }
        row.style.transform = v ? `translateY(${v}px)` : "";
      }
      return moved;
    },

    endSettle() {
      if (this._settleTimer) {
        clearTimeout(this._settleTimer);
        this._settleTimer = 0;
      }
      this.clearDragVisuals();
      this.setMoving(false);
    },

    /** Retire timer matching the CSS glide (min(pref, cap) + buffer). */
    settleDelay() {
      let duration = "";
      try {
        duration = getComputedStyle(document.documentElement).getPropertyValue(
          "--aequera-motion-duration"
        );
      } catch (e) {}
      return settleMs(duration);
    },

    /** Event-free drag teardown (supersede path); returns the drag. */
    cancelDrag() {
      const drag = this._drag;
      if (!drag) {
        return null;
      }
      if (drag.frame) {
        cancelAnimationFrame(drag.frame);
        drag.frame = 0;
      }
      this.clearDragVisuals();
      this._drag = null;
      this.releaseDragData(drag.tab);
      this.setMoving(false);
      this.render();
      return drag;
    },

    dropTargetFromEvent(event, dragged) {
      // Halves are measured against layout, never a row's (possibly
      // sliding) rect: see layoutMid.
      const unshiftedTop = row => this.layoutMid(row);
      const row = this.dragRowOf(event.target);
      if (row?.tab == dragged) {
        return { target: null, after: false };
      }
      if (row?.tab && row.tab.isConnected) {
        return { target: row.tab, after: event.clientY > unshiftedTop(row) };
      }
      const rest = this.tabs().filter(tab => tab != dragged);
      if (!rest.length) {
        return { target: null, after: false };
      }
      const first = this.rows.get(rest[0]);
      const last = this.rows.get(rest[rest.length - 1]);
      if (!first?.isConnected || !last?.isConnected) {
        return { target: null, after: false };
      }
      if (event.clientY < unshiftedTop(first)) {
        return { target: rest[0], after: false };
      }
      return { target: rest[rest.length - 1], after: true };
    },

    /** A tab dragged from another window (native tab-drop identity), or a
     * same-window native drag from outside the rail (e.g. the all-tabs
     * menu). Own rail drags are handled via _drag, never here. */
    foreignTab(event) {
      const dt = event.dataTransfer;
      if (!dt || typeof dt.mozGetDataAt != "function") {
        return null;
      }
      let tab = null;
      try {
        tab = dt.mozGetDataAt(NATIVE_TAB_TYPE, 0);
      } catch (e) {
        return null;
      }
      if (!tab || tab.localName != "tab" || !tab.isConnected) {
        return null;
      }
      if (tab.ownerDocument == document) {
        // Same-document native drag: only a genuine tab of this window
        // qualifies (content cannot fabricate a tab in gBrowser.tabs).
        return gBrowser.tabs.includes(tab) ? tab : null;
      }
      // Another window: only what Firefox's own tab strip accepts
      // (getDropEffectForTabDrag). adoptTab does not check these itself,
      // and a private tab must never move into a normal window or back.
      const other = tab.ownerGlobal;
      if (
        other?.document?.documentElement.getAttribute("windowtype") != "navigator:browser" ||
        !other.gBrowser?.tabs.includes(tab) ||
        PrivateBrowsingUtils.isWindowPrivate(window) != PrivateBrowsingUtils.isWindowPrivate(other) ||
        window.gMultiProcessBrowser != other.gMultiProcessBrowser ||
        window.gFissionBrowser != other.gFissionBrowser
      ) {
        return null;
      }
      return tab;
    },

    /** Insertion gap for a foreign tab: row pairs, step, gap index 0..N. */
    foreignGap(clientY) {
      const order = this.tabs();
      const pairs = [];
      for (const tab of order) {
        const row = this.rows.get(tab);
        if (row?.isConnected) {
          pairs.push([tab, row]);
        }
      }
      if (!pairs.length) {
        return { pairs, step: 0, k: 0 };
      }
      const rowH = pairs[0][1].offsetHeight;
      if (!(rowH > 0)) {
        return null;
      }
      // One slot is a row plus the list's gap, measured from the CSS so a
      // single-row list (nothing to measure the spacing against) opens a
      // full slot too.
      const gap = parseFloat(getComputedStyle(this.element).rowGap) || 0;
      const step = Math.round(rowH + gap);
      const k = gapIndex(pairs.map(([, row]) => this.layoutMid(row)), clientY);
      return { pairs, step, k };
    },

    /**
     * A row's vertical middle in viewport coordinates, from layout alone.
     * A row sliding into a preview gap is mid-transition, and its rect
     * reports wherever the slide is: measuring that put a quick drop one
     * slot off. offsetTop ignores transforms (the list is the rows'
     * offsetParent, aequera-tabs.css).
     */
    layoutMid(row) {
      const list = this.element;
      return (
        list.getBoundingClientRect().top +
        list.clientTop -
        list.scrollTop +
        row.offsetTop +
        row.offsetHeight / 2
      );
    },

    clearForeign() {
      const f = this._foreign;
      if (!f) {
        return;
      }
      this._foreign = null;
      this.showDropIndicator(null);
      for (const row of f.rows) {
        if (row.style.transform) {
          row.style.transform = "";
        }
      }
      if (!this._drag) {
        this.setMoving(false);
      }
    },

    /** Adopt a tab dropped from another window at the previewed position
     * (native cross-window drop parity). Same-window native drags (e.g. the
     * all-tabs menu) resolve as plain moves instead. */
    dropForeign(event) {
      const prev = this._foreign;
      const ftab = prev?.tab?.isConnected ? prev.tab : this.foreignTab(event);
      if (!ftab) {
        if (this.canDropLink(event)) {
          this.dropLinks(event);
        }
        this.clearForeign();
        return;
      }
      const gap = this.foreignGap(event.clientY);
      event.preventDefault();
      this.clearForeign();
      const pairs = gap?.pairs ?? [];
      const slot = gapRef(pairs.length, gap?.k ?? pairs.length);
      const ref = slot ? pairs[slot.index][0] : null;
      const after = !!slot?.after;
      // The tab index for the gap, computed after any unpinning (which moves
      // the tab and shifts the indexes).
      const tabIndexAt = moving => {
        if (!ref || !ref.isConnected) {
          return gBrowser.tabs.length - (moving ? 1 : 0);
        }
        return moveIndex(moving ? gBrowser.tabs.indexOf(moving) : -1, gBrowser.tabs.indexOf(ref), after);
      };
      // The rows are the unpinned tabs: a pinned tab (an essential, or a
      // pinned tab from another window) dropped among them is unpinned, as
      // on Firefox's own tab strip.
      if (gBrowser.tabs.includes(ftab)) {
        if (ftab.pinned) {
          gBrowser.unpinTab(ftab);
        }
        const tabIndex = tabIndexAt(ftab);
        if (tabIndex != gBrowser.tabs.indexOf(ftab)) {
          gBrowser.moveTabTo(ftab, { tabIndex });
        }
        this.render();
        return;
      }
      try {
        const adopted = gBrowser.adoptTab(ftab, {
          tabIndex: Math.max(tabIndexAt(null), gBrowser.pinnedTabCount),
          selectTab: true,
        });
        if (adopted?.pinned) {
          gBrowser.unpinTab(adopted);
          gBrowser.moveTabTo(adopted, { tabIndex: tabIndexAt(adopted) });
        }
      } catch (e) {
        console.error("aequera-tabs: adopting a dropped tab failed", e);
      }
    },

    /** A droppable link: never javascript: or data: (disallowInherit). */
    canDropLink(event) {
      try {
        return Services.droppedLinkHandler.canDropLink(event, true);
      } catch {
        return false;
      }
    },

    /** Open dropped links as new tabs at the previewed gap (Firefox's tab
     * strip link drop: same principal, policy container, container
     * identity, background preference, and many-tabs confirmation). */
    dropLinks(event) {
      let links;
      try {
        links = Services.droppedLinkHandler.dropLinks(event, true);
      } catch {}
      if (!links?.length) {
        return;
      }
      event.preventDefault();
      const gap = this.foreignGap(event.clientY);
      const pairs = gap?.pairs ?? [];
      const slot = gapRef(pairs.length, gap?.k ?? pairs.length);
      const elements = gBrowser.tabContainer.dragAndDropElements;
      const elementIndex = slot
        ? elements.indexOf(pairs[slot.index][0]) + (slot.after ? 1 : 0)
        : elements.length;
      let inBackground = Services.prefs.getBoolPref("browser.tabs.loadInBackground");
      if (event.shiftKey) {
        inBackground = !inBackground;
      }
      const urls = links.map(link => link.url);
      const options = {
        inBackground,
        replace: false,
        allowThirdPartyFixup: true,
        elementIndex: elementIndex >= 0 ? elementIndex : undefined,
        userContextId: gBrowser.selectedTab.getAttribute("usercontextid"),
        triggeringPrincipal: Services.droppedLinkHandler.getTriggeringPrincipal(event),
        policyContainer: Services.droppedLinkHandler.getPolicyContainer(event),
      };
      (async () => {
        if (urls.length >= Services.prefs.getIntPref("browser.tabs.maxOpenBeforeWarn")) {
          const { OpenInTabsUtils } = ChromeUtils.importESModule(
            "moz-src:///browser/components/tabbrowser/OpenInTabsUtils.sys.mjs"
          );
          // A sync dialog cannot run inside the drop handler.
          if (!(await OpenInTabsUtils.promiseConfirmOpenInTabs(urls.length, window))) {
            return;
          }
        }
        gBrowser.loadTabs(urls, options);
      })().catch(error => console.error("aequera-tabs: opening dropped links failed", error));
    },

    onDragEnd(event) {
      const drag = this.cancelDrag();
      if (!drag) {
        return;
      }
      // Without an event there are no coordinates to judge a tear-off by;
      // teardown only (supersede path calls with no event).
      if (!event) {
        return;
      }
      // Tear-off rules: drag-model.js shouldTearOff.
      const dt = event.dataTransfer;
      const tearOff = shouldTearOff({
        dropped: drag.dropped,
        connected: drag.tab.isConnected,
        userCancelled: !!dt?.mozUserCancelled,
        dropEffect: dt?.dropEffect,
        allowDetach: this.allowDetach(),
        outside: this.isOutside(event),
      });
      if (tearOff) {
        this.detachTab(drag.tab, event, drag);
      }
    },

    /**
     * A release tears the tab off unless it lands by the rail
     * (drag-model.js releasedOutside). So letting go over the workspace
     * dock, the essentials, the New Tab row, or just past the rail's edge is
     * a cancelled drag, not a new window.
     */
    isOutside(event) {
      const rail = document.querySelector("#sidebar-container > sidebar-main") ?? this.element;
      return releasedOutside({
        x: event?.clientX,
        y: event?.clientY,
        width: window.innerWidth,
        height: window.innerHeight,
        rail: rail?.getBoundingClientRect() ?? null,
        list: this.element?.getBoundingClientRect() ?? null,
      });
    },

    allowDetach() {
      try {
        return typeof Services == "undefined" || Services.prefs.getBoolPref("browser.tabs.allowTabDetach");
      } catch (e) {
        return true;
      }
    },

    detachTab(tab, event, drag) {
      const offsetX = Number.isFinite(drag?.offsetX) ? drag.offsetX : 16;
      const offsetY = Number.isFinite(drag?.offsetY) ? drag.offsetY : 16;
      const screenX = Number.isFinite(event?.screenX)
        ? event.screenX
        : (window.screenX ?? 0) + 100;
      const screenY = Number.isFinite(event?.screenY)
        ? event.screenY
        : (window.screenY ?? 0) + 100;
      if (gBrowser.tabs.length <= 1) {
        try {
          window.moveTo(
            Math.max(window.screen?.availLeft ?? 0, screenX - offsetX),
            Math.max(window.screen?.availTop ?? 0, screenY - offsetY)
          );
          window.focus();
        } catch (e) {}
        return;
      }
      try {
        gBrowser.replaceTabsWithWindow(tab, {
          screenX: Math.round(screenX - offsetX),
          screenY: Math.round(screenY - offsetY),
        });
      } catch (e) {}
    },

    clearDragVisuals() {
      if (!this.element) {
        return;
      }
      for (const row of this.element.querySelectorAll(".aequera-tab")) {
        if (row.style.transform) {
          row.style.transform = "";
        }
        row.removeAttribute("dragging");
        row.removeAttribute("dragout");
      }
      this._dropLine?.remove();
    },

    init() {
      const main = document.querySelector("#sidebar-container > sidebar-main");
      const verticalTabs = document.getElementById("vertical-tabs");
      if (!main || !verticalTabs) {
        console.error("aequera-tabs: rail not found; tab list disabled");
        return;
      }
      const element = document.createElementNS(HTML_NS, "div");
      element.id = "aequera-tabs";
      element.setAttribute("role", "tablist");
      element.setAttribute("aria-label", "Tabs");
      element.setAttribute("aria-orientation", "vertical");
      const newTab = document.createElementNS(HTML_NS, "div");
      newTab.className = "aequera-tab aequera-newtab";
      newTab.setAttribute("role", "button");
      newTab.setAttribute("aria-label", "New tab");
      newTab.title = "New tab";
      const plus = document.createElementNS(HTML_NS, "span");
      plus.className = "aequera-tab-icon aequera-newtab-icon";
      plus.setAttribute("aria-hidden", "true");
      plus.textContent = "+";
      newTab.append(plus);
      // Its own listeners: the row also lives outside the list (overflow),
      // where a wheel over it still scrolls the list.
      newTab.addEventListener("click", event => {
        if (event.button == 0) {
          BrowserCommands.openTab();
        }
      });
      newTab.addEventListener("wheel", this, { passive: false });
      newTab.addEventListener("mousemove", this);
      newTab.addEventListener("mouseout", this);
      this.newTabRow = newTab;
      verticalTabs.after(element);
      this.element = element;

      for (const type of ["mousedown", "click", "auxclick", "contextmenu", "dragstart", "dragover", "drop", "dragleave", "dragend", "overflow", "underflow"]) {
        element.addEventListener(type, this);
      }
      // Not passive: a handled notch replaces the native wheel scroll.
      element.addEventListener("wheel", this, { passive: false });
      for (const type of ["mousemove", "mouseout", "scroll"]) {
        element.addEventListener(type, this, { passive: true });
      }
      const container = gBrowser.tabContainer;
      for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
        container.addEventListener(type, this);
      }
      const magnifyPrefs = () => this.readMagnifyPrefs();
      Services.prefs.addObserver(MAGNIFY_PREF, magnifyPrefs);
      Services.prefs.addObserver(MAGNIFY_PERCENT_PREF, magnifyPrefs);
      window.addEventListener(
        "unload",
        () => {
          for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
            container.removeEventListener(type, this);
          }
          Services.prefs.removeObserver(MAGNIFY_PREF, magnifyPrefs);
          Services.prefs.removeObserver(MAGNIFY_PERCENT_PREF, magnifyPrefs);
          cancelAnimationFrame(this._magnify.frame);
        },
        { once: true }
      );
      this.readMagnifyPrefs();
      this.render();
      // Last: Firefox's own rows are hidden only once this list is live
      // (aequera-tabs.css), so a failed init never leaves the window tabless.
      document.documentElement.setAttribute("aequera-tabs", "true");
      // A restored session can select a tab far down the list.
      this.revealSelected();
    },
  };

  window.delayedStartupPromise.then(() => list.init());
  return list;
})();
