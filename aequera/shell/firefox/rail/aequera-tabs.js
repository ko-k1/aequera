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
var AequeraTabs = (() => {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DEFAULT_ICON = "chrome://global/skin/icons/defaultFavicon.svg";
  const STRUCTURE_EVENTS = ["TabOpen", "TabClose", "TabMove", "TabPinned", "TabUnpinned", "TabShow", "TabHide"];
  const ROW_EVENTS = ["TabSelect", "TabAttrModified"];
  const DRAG_TYPE = "text/x-moz-aequera-tab";
  const NATIVE_TAB_TYPE = "application/x-moz-tabbrowser-tab";
  const EDGE_SCROLL_ZONE = 32;
  const EDGE_SCROLL_STEP = 12;
  const EDGE_PAD = 4;
  const DETACH_MARGIN = 15;
  const SETTLE_MS = 250;
  // Mirror of the CSS glide cap (aequera-tabs.css min(..., 150ms)): the JS
  // retire timer must cover the capped transition plus a frame buffer, never
  // the raw pref alone.
  const SETTLE_GLIDE_CAP_MS = 150;
  const SETTLE_BUFFER_MS = 100;

  const list = {
    element: null,
    rows: new WeakMap(),
    newTabRow: null,
    _drag: null,
    _foreign: null,
    _ghost: null,
    _settleTimer: 0,

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
      const label = tab.label || "";
      row.setAttribute("aria-selected", String(tab.selected));
      row.setAttribute("aria-label", label);
      row.title = label;
      row.toggleAttribute("busy", tab.hasAttribute("busy"));
      row.toggleAttribute("soundplaying", tab.hasAttribute("soundplaying"));
      row.toggleAttribute("muted", tab.hasAttribute("muted"));
      row.querySelector(".aequera-tab-title").textContent = label;
      const image = tab.getAttribute("image") || DEFAULT_ICON;
      const icon = row.querySelector(".aequera-tab-icon");
      if (icon.getAttribute("src") != image) {
        icon.setAttribute("src", image);
      }
    },

    /** Put exactly the listed tabs' rows in tab order (nodes are reused). */
    render() {
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
      const rows = this.tabs().map(tab => this.rows.get(tab) ?? this.createRow(tab));
      this.element.replaceChildren(...rows, this.newTabRow);
    },

    handleEvent(event) {
      const tab = event.target.tab ?? event.target;
      switch (event.type) {
        case "TabSelect":
          this.clearForeign();
          for (const t of this.tabs()) {
            this.updateRow(t);
          }
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
        default:
          // Structure changed (open/close/move/pin/show/hide). TabClose fires
          // while the tab is still in gBrowser.tabs (filtered as closing).
          this.render();
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
      } else if (target.closest(".aequera-newtab")) {
        BrowserCommands.openTab();
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
      }
    },

    onDragStart(event) {
      // A new local drag supersedes any foreign preview in progress.
      this.clearForeign();
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
      try {
        const dt = event.dataTransfer;
        dt.effectAllowed = "move";
        dt.setData(DRAG_TYPE, row.tab.label || "#");
        dt.mozSetDataAt(NATIVE_TAB_TYPE, row.tab, 0);
        dt.addElement(row.tab);
        if (rm) {
          // No slide visuals in reduced motion: classic ghost follows.
          dt.setDragImage(row, Math.round(event.clientX - box.left), Math.round(event.clientY - box.top));
        } else {
          // The sliding row itself is the visual inside the rail, so the
          // ghost starts hidden; leaving the rail restores it for tear-off.
          dt.setDragImage(this.ghostImage(), 0, 0);
        }
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

    // Shared transparent 1x1 drag image: hides the OS ghost while the
    // sliding row itself is the visual. updateDragImage swaps it back
    // for the tear-off once the pointer leaves the rail.
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
        if (drag.rm) {
          return;
        }
        drag.pending = event.clientY;
        if (drag.ghostOutside) {
          drag.ghostOutside = false;
          try {
            event.dataTransfer.updateDragImage(this.ghostImage(), 0, 0);
          } catch (e) {}
        }
        if (Number.isFinite(event.clientY)) {
          this.dragFrame(event.clientY);
        }
        this.kickScroll(drag);
        return;
      }
      if (drag) {
        return;
      }
      const ftab = this.foreignTab(event);
      if (!ftab) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const gap = this.reduceMotion() ? null : this.foreignGap(event.clientY);
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
      for (let i = 0; i < gap.pairs.length; i++) {
        const row = gap.pairs[i][1];
        const s = i >= gap.k ? gap.step : 0;
        if (s) {
          f.shifts.set(row, s);
          f.rows.add(row);
        } else {
          f.shifts.delete(row);
        }
        row.style.transform = s ? `translateY(${s}px)` : "";
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

    dragFrame(clientY) {
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
      const layoutTop = i => listRect.top + drag.layout.padTop + i * step - scrollTop;
      if (clientY != drag.lastY) {
        drag.forward = clientY > drag.lastY;
        drag.lastY = clientY;
      }
      const origin = rows.get(drag.tab);
      const originTop = layoutTop(from);
      const startBound = listRect.top + EDGE_PAD - originTop;
      const endBound = listRect.bottom - EDGE_PAD - rowH - originTop;
      let translate = Math.min(Math.max(clientY - drag.startY, startBound), endBound);
      let top = originTop + translate;
      if (
        (clientY < top || clientY > top + rowH) &&
        top > listRect.top + EDGE_PAD &&
        top + rowH < listRect.bottom - EDGE_PAD
      ) {
        translate = clientY - originTop - rowH / 2;
        translate = Math.min(Math.max(translate, startBound), endBound);
        top = originTop + translate;
      }
      drag.translate = translate;
      origin.style.transform = translate ? `translateY(${Math.round(translate)}px)` : "";
      const old = drag.drop;
      const shiftOf = (i, drop) => {
        if (i < from && i >= drop) {
          return step;
        }
        if (i > from && i < drop) {
          return -step;
        }
        return 0;
      };
      let candidate = -1;
      const point = drag.forward ? top + rowH : top;
      let firstBg = -1;
      let lastBottom = 0;
      for (let i = 0; i < order.length; i++) {
        if (i == from) {
          continue;
        }
        const vis = layoutTop(i) + (drag.shifts.get(rowEls[i]) ?? 0);
        if (firstBg < 0) {
          firstBg = i;
        }
        lastBottom = vis + rowH;
        if (point >= vis && point < vis + rowH) {
          candidate = i;
          break;
        }
      }
      // True gap from this frame's geometry; the visible gap chases it one
      // slot per frame, and the drop commits the true gap, never the chase.
      let target = drag.target;
      if (candidate < 0 && firstBg >= 0) {
        const firstTop = layoutTop(firstBg) + (drag.shifts.get(rowEls[firstBg]) ?? 0);
        if (point >= lastBottom) {
          target = order.length;
        } else if (point < firstTop) {
          target = 0;
        }
      } else if (candidate >= 0) {
        target = candidate;
        const candTop = layoutTop(candidate) + shiftOf(candidate, old);
        const overlap = this.overlap(top, rowH, candTop, rowH);
        if (drag.forward && overlap > 0.5) {
          target = candidate + 1;
        } else if (!drag.forward && !(overlap > 0.5)) {
          target = candidate + 1;
          if (target > old) {
            target = old;
          }
        }
        target = Math.min(Math.max(target, 0), order.length);
      }
      drag.target = target;
      let next = old;
      if (target > old) {
        next = old + 1;
      } else if (target < old) {
        next = old - 1;
      }
      if (next != old) {
        drag.drop = next;
        for (let i = 0; i < order.length; i++) {
          const row = rowEls[i];
          if (i == from || !row) {
            continue;
          }
          const s = shiftOf(i, next);
          if (s) {
            drag.shifts.set(row, s);
            drag.pristine.delete(row);
          } else {
            drag.shifts.delete(row);
          }
          row.style.transform = s ? `translateY(${s}px)` : "";
        }
      }
      drag.zone = 0;
      if (clientY < listRect.top + EDGE_SCROLL_ZONE && this.element.scrollTop > 0) {
        drag.zone = -1;
      } else if (
        clientY > listRect.bottom - EDGE_SCROLL_ZONE &&
        this.element.scrollTop + this.element.clientHeight < this.element.scrollHeight
      ) {
        drag.zone = 1;
      }
      if (drag.zone) {
        this.element.scrollBy(0, drag.zone * EDGE_SCROLL_STEP);
      }
    },

    overlap(p1, s1, p2, s2) {
      const size = p1 < p2 ? p1 + s1 - p2 : p2 + s2 - p1;
      if (size <= 0) {
        return 0;
      }
      return Math.min(Math.max(size / s1, size / s2), 1);
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
      if (drag && !drag.rm && !drag.ghostOutside && this.element && this.leftList(event)) {
        drag.ghostOutside = true;
        try {
          event.dataTransfer.updateDragImage(
            drag.row,
            Math.round(drag.offsetX),
            Math.round(drag.offsetY)
          );
        } catch (e) {}
        return;
      }
      if (!drag && this._foreign && this.leftList(event)) {
        this.clearForeign();
      }
    },

    onDrop(event) {
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
      let target = null;
      let after = false;
      if (!drag.rm) {
        const order = this.tabs();
        const from = order.indexOf(drag.tab);
        const to = drag.target;
        if (from >= 0 && to != from) {
          if (to <= from) {
            target = order[to];
          } else {
            target = order[to - 1];
            after = true;
          }
        }
      }
      if (!target || target == drag.tab) {
        ({ target, after } = this.dropTargetFromEvent(event, drag.tab, drag));
      }
      this._drag = null;
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
      let tabIndex = after ? targetIndex + 1 : targetIndex;
      if (gFrom < tabIndex) {
        tabIndex -= 1; // the dragged tab leaves its old slot first
      }
      // Snapshot live offsets first: the render inside moveTabTo sweeps
      // row styles, so the settle below must work from this snapshot, and
      // must write after the move (anything written before is swept too).
      // The transition stays armed throughout: retargeting live transitions
      // across the commit keeps a single forward glide, while tearing the
      // transition property down and back up orphans them (they keep
      // timelining without painting).
      const live = !drag.rm ? this.liveTransforms(this.tabs()) : null;
      gBrowser.moveTabTo(drag.tab, { tabIndex });
      // TabMove rendered the final order above. Rebase the snapshot onto
      // the committed slots (exact visuals), lock them in, then release
      // next frame to glide home (native tabdrop-samewindow parity).
      // Retire movingtab on landing.
      const gliding = live && this.settleRebase(drag, target, after, live);
      if (gliding) {
        if (this.element) {
          void this.element.offsetHeight;
        }
        this._settleTimer = setTimeout(() => this.endSettle(), this.settleMs());
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

    parseTranslateY(style) {
      const m = /translateY\((-?\d+)/.exec(style || "");
      return m ? parseInt(m[1], 10) : 0;
    },

    settleRebase(drag, target, after, live) {
      const layout = drag.layout;
      const order = [...live.keys()];
      if (!layout || order.indexOf(drag.tab) < 0) {
        return false;
      }
      const rest = order.filter(t => t !== drag.tab);
      const ridx = rest.indexOf(target);
      if (ridx < 0) {
        return false;
      }
      rest.splice(after ? ridx + 1 : ridx, 0, drag.tab);
      // Commit only onto the order the move actually produced; a clamped
      // no-op move leaves the DOM untouched and has nothing to settle.
      const now = this.tabs();
      if (now.length != rest.length || !rest.every((t, i) => now[i] === t)) {
        return false;
      }
      const step = layout.step;
      let moved = false;
      for (let i = 0; i < order.length; i++) {
        const row = this.rows.get(order[i]);
        if (!row) {
          continue;
        }
        row.removeAttribute("dragging");
        const nidx = rest.indexOf(order[i]);
        if (nidx < 0) {
          continue;
        }
        const v = this.parseTranslateY(live.get(order[i])) - (nidx - i) * step;
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
    settleMs() {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue(
          "--aequera-motion-duration"
        );
        const pref = parseInt(raw, 10);
        if (Number.isFinite(pref)) {
          return Math.min(Math.max(pref, 0), SETTLE_GLIDE_CAP_MS) + SETTLE_BUFFER_MS;
        }
      } catch (e) {}
      return SETTLE_MS;
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
      this.setMoving(false);
      this.render();
      return drag;
    },

    dropTargetFromEvent(event, dragged, drag) {
      // Halves are measured against layout tops: a row caught mid-slide
      // reports its visual (shifted) rect, so subtract its applied shift.
      const unshiftedTop = row => {
        const box = row.getBoundingClientRect();
        return box.top - (drag?.shifts.get(row) ?? 0) + box.height / 2;
      };
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
      const r0 = pairs[0][1].getBoundingClientRect();
      if (!(r0.height > 0)) {
        return null;
      }
      const r1 = pairs.length > 1 ? pairs[1][1].getBoundingClientRect() : null;
      const step = Math.round(Math.max(r0.height, r1 ? r1.top - r0.top : 0));
      const f = this._foreign;
      let k = pairs.length;
      for (let i = 0; i < pairs.length; i++) {
        const mid =
          pairs[i][1].getBoundingClientRect().top -
          (f?.shifts.get(pairs[i][1]) ?? 0) +
          r0.height / 2;
        if (clientY < mid) {
          k = i;
          break;
        }
      }
      return { pairs, step, k };
    },

    clearForeign() {
      const f = this._foreign;
      if (!f) {
        return;
      }
      this._foreign = null;
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
        this.clearForeign();
        return;
      }
      const gap = this.foreignGap(event.clientY);
      event.preventDefault();
      this.clearForeign();
      const pairs = gap?.pairs ?? [];
      const k = gap ? Math.min(Math.max(gap.k, 0), pairs.length) : pairs.length;
      let ref = null;
      let after = false;
      if (k < pairs.length) {
        ref = pairs[k][0];
      } else if (pairs.length) {
        ref = pairs[pairs.length - 1][0];
        after = true;
      }
      let tabIndex;
      if (!ref) {
        tabIndex = gBrowser.tabs.length;
      } else {
        const gi = gBrowser.tabs.indexOf(ref);
        if (gi < 0) {
          this.render();
          return;
        }
        tabIndex = after ? gi + 1 : gi;
      }
      if (gBrowser.tabs.includes(ftab)) {
        const gFrom = gBrowser.tabs.indexOf(ftab);
        if (gFrom < tabIndex) {
          tabIndex -= 1;
        }
        if (tabIndex != gFrom) {
          gBrowser.moveTabTo(ftab, { tabIndex });
        }
        this.render();
        return;
      }
      if (ftab.pinned) {
        tabIndex = Math.min(tabIndex, gBrowser.pinnedTabCount);
      }
      try {
        gBrowser.adoptTab(ftab, { tabIndex, selectTab: true });
      } catch (e) {}
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
      const effect = event?.dataTransfer?.dropEffect;
      if (
        !drag.dropped &&
        drag.tab.isConnected &&
        effect === "none" &&
        this.allowDetach() &&
        this.isOutside(event, drag)
      ) {
        this.detachTab(drag.tab, event, drag);
      }
    },

    /** Outside judgment: dragend coordinates can be clamped to the window
     * or report the last inside position on OS drops, so a drag that left
     * the rail (ghostOutside, armed by dragleave) counts as outside even
     * when the end coordinates read inside. */
    isOutside(event, drag) {
      if (drag?.ghostOutside) {
        return true;
      }
      return !this.nearList(event);
    },

    allowDetach() {
      try {
        return typeof Services == "undefined" || Services.prefs.getBoolPref("browser.tabs.allowTabDetach");
      } catch (e) {
        return true;
      }
    },

    nearList(event) {
      if (!this.element || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) {
        return false;
      }
      const rect = this.element.getBoundingClientRect();
      return (
        event.clientX >= rect.left - DETACH_MARGIN &&
        event.clientX <= rect.right + DETACH_MARGIN &&
        event.clientY >= rect.top - DETACH_MARGIN &&
        event.clientY <= rect.bottom + DETACH_MARGIN
      );
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
      }
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
      this.newTabRow = newTab;
      verticalTabs.after(element);
      this.element = element;

      for (const type of ["mousedown", "click", "auxclick", "contextmenu", "dragstart", "dragover", "drop", "dragleave", "dragend"]) {
        element.addEventListener(type, this);
      }
      const container = gBrowser.tabContainer;
      for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
        container.addEventListener(type, this);
      }
      window.addEventListener(
        "unload",
        () => {
          for (const type of [...STRUCTURE_EVENTS, ...ROW_EVENTS]) {
            container.removeEventListener(type, this);
          }
        },
        { once: true }
      );
      this.render();
      // Last: Firefox's own rows are hidden only once this list is live
      // (aequera-tabs.css), so a failed init never leaves the window tabless.
      document.documentElement.setAttribute("aequera-tabs", "true");
    },
  };

  window.delayedStartupPromise.then(() => list.init());
  return list;
})();
