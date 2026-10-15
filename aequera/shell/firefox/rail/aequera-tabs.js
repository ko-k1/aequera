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
// Drag and drop lives in aequera-tabs-drag.js, which adds its methods to this
// list; its decisions (slide, landing slot, settle, foreign gap, tear-off) are
// the pure AequeraDragModel (drag-model.js, node-tested). This file measures,
// writes transforms, and calls gBrowser. Wheel momentum and the reveal
// spring are the pure AequeraScrollModel (scroll-model.js); icon
// magnification under the pointer is AequeraMagnifyModel (magnify-model.js).
var AequeraTabs = (() => {
  const { wheelDistance, kick, momentum, spring, stateAt, atRest } = AequeraScrollModel;
  const { RADIUS_ROWS, falloff, peakScale, rowScales } = AequeraMagnifyModel;
  const MAGNIFY_PREF = "aequera.rail.magnify";
  const MAGNIFY_PERCENT_PREF = "aequera.rail.magnifyPercent";
  const { clamp } = AequeraDragModel;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  /** Close motion: the rows slide at most this long (ms); the closing row
   * fades in 60% of it. */
  const CLOSE_MOTION_CAP_MS = 200;
  const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";
  // Favicons come from web content (tab `image` attribute). An <img> does not
  // execute script, but a crafted attribute could still load privileged image
  // bytes into chrome UI (spoofing). Allowlist keeps http(s) + data:image for
  // web favicons, moz-remote-image:// which tabbrowser substitutes for SVG
  // favicons (browser.tabs.remoteSVGIconDecoding: decoded in the content
  // process), plus chrome:// + resource:// which Firefox itself uses for
  // internal pages and the default icon below; everything else falls back to
  // the default icon.
  const REMOTE_IMAGE = "moz-remote-image://?";
  // moz-remote-image loads whatever its `url` parameter names, so only the
  // form tabbrowser builds passes: exactly one url (Gecko takes the last of
  // several), and that one a data:image.
  function isRemoteDataImage(lower) {
    const urls = new URLSearchParams(lower.slice(REMOTE_IMAGE.length)).getAll("url");
    return urls.length == 1 && urls[0].startsWith("data:image/");
  }
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
      (lower.startsWith(REMOTE_IMAGE) && isRemoteDataImage(lower)) ||
      lower.startsWith("chrome://") ||
      lower.startsWith("resource://")
    ) {
      return trimmed;
    }
    return DEFAULT_ICON;
  }
  const STRUCTURE_EVENTS = ["TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned", "TabShow", "TabHide"];
  const ROW_EVENTS = ["TabSelect", "TabAttrModified"];

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
    /** Depth of batch() calls; structure renders wait while above 0. */
    _batch: 0,
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
      this.updateIcon(row, tab);
    },

    updateIcon(row, tab) {
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
          if (!this._batch) {
            this.render(event.type == "TabClose" ? event.target : null);
          }
      }
    },

    /**
     * Structure changes made inside `fn` render the list once, after it: a
     * bulk change (Sort Tabs by Site) moves and hides many tabs, and each
     * would otherwise re-render every row.
     */
    batch(fn) {
      this._batch++;
      try {
        return fn();
      } finally {
        if (!--this._batch) {
          this.render();
        }
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
      // tabbrowser also writes `image` without TabAttrModified (it re-renders
      // SVG favicons when the color scheme changes), so icons follow the
      // attribute itself. Only <tab> carries `image` here: its own icon
      // inherits it as `src`.
      const icons = new MutationObserver(records => {
        for (const { target } of records) {
          const row = this.rows.get(target);
          if (row) {
            this.updateIcon(row, target);
          }
        }
      });
      icons.observe(container, { subtree: true, attributeFilter: ["image"] });
      window.addEventListener(
        "unload",
        () => {
          for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
            container.removeEventListener(type, this);
          }
          icons.disconnect();
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
