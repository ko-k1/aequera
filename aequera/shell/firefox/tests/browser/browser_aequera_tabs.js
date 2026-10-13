/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera tab list (rail/aequera-tabs.js/.css): a prototype-style view of
// gBrowser's unpinned tabs replacing Firefox's own vertical rows.

const ROOT = document.documentElement;
const list = () => document.getElementById("aequera-tabs");
const rowFor = tab => window.AequeraTabs.rows.get(tab);
const listedTabs = () =>
  [...list().querySelectorAll(".aequera-tab:not(.aequera-newtab)")].map(r => r.tab);
// Not always in the list: overflowing rows put it right under the list.
const newTabRow = () => window.AequeraTabs.newTabRow;
const container = () => document.getElementById("sidebar-container");
const railBox = () => container().querySelector(":scope > sidebar-main");
const isFullyCollapsed = () =>
  !ROOT.hasAttribute("aequera-rail-expanded") && !gBrowser.tabContainer.hasAttribute("expanded");
const centerX = box => box.left + box.width / 2;
// Platform drag sessions (and real cross-window geometry) need a display:
// headless provides no drag service, so EventUtils.synthesizeDrop throws,
// and backgrounded windows report degenerate geometry. These paths stay
// covered on headed runs; headless skips them the way upstream marks
// OS-service tests skip-if headless.
const HEADLESS = Services.env.get("MOZ_HEADLESS") == "1";

function hoverRail() {
  EventUtils.synthesizeMouse(container(), 5, 200, { type: "mousemove" });
}

async function collapse() {
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabbox"), {
    type: "mousemove",
  });
  await TestUtils.waitForCondition(isFullyCollapsed, "collapsed");
}

let opened = [];

async function openTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    const tab = BrowserTestUtils.addTab(gBrowser, `data:text/html,<title>Row ${i}</title>row`);
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    tabs.push(tab);
  }
  opened.push(...tabs);
  return tabs;
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.hover.openDelayMs", 0],
      ["aequera.hover.closeDelayMs", 0],
      ["aequera.motion.durationMs", 100],
      ["aequera.rail.pinned", false],
    ],
  });
  window.windowUtils.disableNonTestMouseEvents(true);
  registerCleanupFunction(async () => {
    window.windowUtils.disableNonTestMouseEvents(false);
    for (const tab of opened) {
      if (tab.isConnected) {
        gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
      }
    }
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_rows_mirror_the_unpinned_tabs() {
  const tabs = await openTabs(3);
  const expected = gBrowser.tabs.filter(t => !t.pinned && !t.hidden);
  Assert.deepEqual(listedTabs(), expected, "one row per unpinned tab, in tab order");
  await TestUtils.waitForCondition(
    () => rowFor(tabs[1]).querySelector(".aequera-tab-title").textContent == "Row 1",
    "titles follow the tab"
  );
  ok(ROOT.hasAttribute("aequera-tabs"), "the list reports itself mounted");
  is(
    getComputedStyle(document.getElementById("tabbrowser-arrowscrollbox")).display,
    "none",
    "Firefox's own rows are hidden once it is"
  );
  is(Math.round(rowFor(tabs[0]).getBoundingClientRect().height), 30, "30px token rows");
  is(list().lastElementChild, newTabRow(), "New Tab closes the list");
});

add_task(async function test_prototype_geometry() {
  // prototype/shell styles.css: a 42px rail; 30px rows, 6px apart, whose
  // icons sit on the rail's center line; collapsed rows are 30px squares.
  await collapse();
  const rail = railBox().getBoundingClientRect();
  is(Math.round(rail.width), 42, "the collapsed rail is the 42px token");
  const [a, b] = opened;
  const first = rowFor(a).getBoundingClientRect();
  const second = rowFor(b).getBoundingClientRect();
  is(Math.round(second.top - first.bottom), 6, "rows are 6px apart");
  is(Math.round(first.width), 30, "collapsed: a row is a 30px square");
  const icon = rowFor(a).querySelector(".aequera-tab-icon").getBoundingClientRect();
  Assert.less(Math.abs(centerX(icon) - centerX(rail)), 0.5, "its icon sits on the rail's center line");
});

add_task(async function test_firefox_rows_come_back_if_the_list_is_not_mounted() {
  // Simulates a failed or stale list: without the mount marker, Firefox's
  // own rows must be visible, never "no tabs at all".
  ROOT.removeAttribute("aequera-tabs");
  isnot(
    getComputedStyle(document.getElementById("tabbrowser-arrowscrollbox")).display,
    "none",
    "Firefox's rows show without a mounted Aequera list"
  );
  ROOT.setAttribute("aequera-tabs", "true");
});

add_task(async function test_selection_follows_both_ways() {
  const [a, b] = opened;
  EventUtils.synthesizeMouseAtCenter(rowFor(b), { type: "mousedown" });
  EventUtils.synthesizeMouseAtCenter(rowFor(b), { type: "mouseup" });
  is(gBrowser.selectedTab, b, "pressing a row selects its tab");
  is(rowFor(b).getAttribute("aria-selected"), "true", "and marks the row");
  gBrowser.selectedTab = a;
  await TestUtils.waitForCondition(
    () => rowFor(a).getAttribute("aria-selected") == "true",
    "tab selection reaches the rows"
  );
  is(rowFor(b).getAttribute("aria-selected"), "false", "the old row is unmarked");
});

add_task(async function test_selected_row_scrolls_into_view() {
  // Enough rows to overflow the list, however tall the test window is.
  const rowsThatFit = Math.ceil(list().clientHeight / 36);
  const tabs = [];
  for (let i = 0; i < rowsThatFit + 10; i++) {
    tabs.push(BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true }));
  }
  opened.push(...tabs);
  await TestUtils.waitForCondition(() => list().scrollHeight > list().clientHeight, "the list overflows");
  const shown = tab => {
    const box = list().getBoundingClientRect();
    const row = rowFor(tab).getBoundingClientRect();
    return row.top >= box.top && row.bottom <= box.bottom;
  };

  const last = tabs.at(-1);
  ok(!shown(last), "the last row starts out of view");
  // Selected from outside the rail (keyboard, command surface).
  gBrowser.selectedTab = last;
  await TestUtils.waitForCondition(() => shown(last), "selecting a tab scrolls its row into view");
  Assert.greater(list().scrollTop, 0, "by scrolling the list");
  is(Math.round(railBox().getBoundingClientRect().top), Math.round(container().getBoundingClientRect().top), "the rail itself did not move");

  const first = gBrowser.tabs.find(t => !t.pinned && !t.hidden);
  gBrowser.selectedTab = first;
  await TestUtils.waitForCondition(() => shown(first), "and back up for a row above");

  for (const tab of tabs) {
    gBrowser.removeTab(tab, { animate: false });
  }
});

add_task(async function test_a_switch_touches_only_two_rows() {
  const [a, b] = opened.filter(t => t.isConnected && !t.hidden);
  gBrowser.selectedTab = a;
  await TestUtils.waitForCondition(() => rowFor(a).getAttribute("aria-selected") == "true", "a selected");
  const touched = new Set();
  const observer = new MutationObserver(records => {
    for (const record of records) {
      // The list's own scroll-fade attributes (the switch may scroll the
      // incoming row into view) restyle only the list, not its rows. Any
      // other change on the list itself (rows re-inserted) still counts.
      if (record.target === list() && record.attributeName?.startsWith("fade-")) {
        continue;
      }
      touched.add(record.target.closest(".aequera-tab"));
    }
  });
  observer.observe(list(), { attributes: true, childList: true, characterData: true, subtree: true });
  gBrowser.selectedTab = b;
  await TestUtils.waitForCondition(() => rowFor(b).getAttribute("aria-selected") == "true", "b selected");
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  observer.disconnect();
  ok(touched.has(rowFor(a)) && touched.has(rowFor(b)), "the outgoing and incoming rows change");
  is(touched.size, 2, "and no other row is touched");
});

add_task(async function test_closing_from_the_rows() {
  const [tab] = await openTabs(1);
  // A real middle-click: press + release of button 1 (Gecko derives auxclick).
  EventUtils.synthesizeMouseAtCenter(rowFor(tab), { button: 1 });
  await TestUtils.waitForCondition(() => !tab.isConnected, "middle-click closes the tab");
  ok(!listedTabs().includes(tab), "its row is gone");

  const [other] = await openTabs(1);
  // The middle-click left the pointer on the rail, which (correctly) widened
  // it; move to the page to check the collapsed state.
  await collapse();
  const close = rowFor(other).querySelector(".aequera-tab-close");
  is(close.textContent, "\u00d7", "the prototype's x glyph");
  is(getComputedStyle(close).display, "none", "collapsed: no close button");
  // Widened (pinned: the pointer stays on the page), selected, not hovered.
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.pinned", true]] });
  await TestUtils.waitForCondition(
    () => ROOT.hasAttribute("aequera-rail-content-expanded"),
    "widened"
  );
  gBrowser.selectedTab = other;
  is(getComputedStyle(close).display, "none", "widened: no close button until the row is hovered");
  EventUtils.synthesizeMouseAtCenter(rowFor(other), { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => getComputedStyle(close).display != "none",
    "hovering the row shows its close button"
  );
  close.click();
  await TestUtils.waitForCondition(() => !other.isConnected, "the close button closes the tab");
  await SpecialPowers.popPrefEnv();
  await collapse();
});

add_task(async function test_new_tab_row() {
  // prototype #newtab-rail: a "+" centered in both states, in a 30px square
  // while collapsed and a full-width row when widened.
  await collapse();
  const count = gBrowser.tabs.length;
  const row = newTabRow();
  const glyph = row.querySelector(".aequera-newtab-icon");
  is(glyph.textContent, "+", "the prototype's + glyph");
  const isCentered = () =>
    Math.abs(centerX(glyph.getBoundingClientRect()) - centerX(row.getBoundingClientRect())) < 1;
  const collapsed = row.getBoundingClientRect();
  is(Math.round(collapsed.width), 30, "collapsed: 30px wide");
  is(Math.round(collapsed.height), 30, "and 30px tall");
  ok(isCentered(), "collapsed: a centered +");

  hoverRail();
  const expandedWidth = Services.prefs.getIntPref("aequera.rail.expandedWidth", 220);
  await TestUtils.waitForCondition(
    () => Math.abs(railBox().getBoundingClientRect().width - expandedWidth) < 1,
    "widened"
  );
  is(
    Math.round(row.getBoundingClientRect().width),
    expandedWidth - 12,
    "widened: a full-width row (6px list inset)"
  );
  ok(isCentered(), "widened: still a centered +");
  row.click();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == count + 1, "it opens a new tab");
  const created = gBrowser.selectedTab;
  opened.push(created);
  ok(listedTabs().includes(created), "which gets a row");
});

add_task(async function test_new_tab_stays_in_reach_when_rows_overflow() {
  // A rail full of tabs must not scroll New Tab away under the workspace
  // dock: it steps out of the list and sits right under it.
  await collapse();
  const row = newTabRow();
  const hittable = () => {
    const box = row.getBoundingClientRect();
    const hit = document.elementFromPoint(centerX(box), box.top + box.height / 2);
    return !!hit && row.contains(hit);
  };
  const extra = [];
  while (list().scrollHeight <= list().clientHeight && extra.length < 80) {
    extra.push(...(await openTabs(1)));
  }
  extra.push(...(await openTabs(2)));
  opened.push(...extra);
  await TestUtils.waitForCondition(() => row.parentNode !== list(), "overflowing: New Tab leaves the list");
  is(row.previousElementSibling, list(), "and sits right under it");
  const dock = document.getElementById("aequera-workspace-dock");
  if (dock) {
    Assert.lessOrEqual(row.getBoundingClientRect().bottom, dock.getBoundingClientRect().top, "above the workspace dock");
  }
  ok(hittable(), "collapsed: New Tab is under the pointer, not covered");

  // The wheel over it, out there, still scrolls the list.
  list().scrollTop = 0;
  EventUtils.synthesizeWheel(row, 10, 10, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });
  await TestUtils.waitForCondition(() => list().scrollTop > 50, "a wheel over New Tab scrolls the list");
  await TestUtils.waitForCondition(() => !window.AequeraTabs._glide, "and coasts to rest");

  // Scroll fades: an edge fades only while rows are cut off past it.
  ok(list().hasAttribute("overflowing"), "overflowing rows arm the fade mask");
  list().scrollTop = 0;
  await TestUtils.waitForCondition(
    () => list().hasAttribute("fade-end") && !list().hasAttribute("fade-start"),
    "at the top: only the end fades"
  );
  list().scrollTop = list().scrollHeight;
  await TestUtils.waitForCondition(
    () => list().hasAttribute("fade-start") && !list().hasAttribute("fade-end"),
    "at the bottom: only the start fades"
  );

  hoverRail();
  const expandedWidth = Services.prefs.getIntPref("aequera.rail.expandedWidth", 220);
  await TestUtils.waitForCondition(
    () => Math.abs(railBox().getBoundingClientRect().width - expandedWidth) < 1,
    "widened"
  );
  is(Math.round(row.getBoundingClientRect().width), expandedWidth - 12, "widened: still the full-width row");
  ok(hittable(), "widened: New Tab is under the pointer, not covered");
  const count = gBrowser.tabs.length;
  row.click();
  await TestUtils.waitForCondition(() => gBrowser.tabs.length == count + 1, "it opens a new tab");
  extra.push(gBrowser.selectedTab);
  opened.push(gBrowser.selectedTab);

  for (const tab of extra) {
    gBrowser.removeTab(tab, { animate: false });
  }
  await TestUtils.waitForCondition(() => row.parentNode === list(), "rows fit again: New Tab is back in the list");
  is(list().lastElementChild, row, "closing it");
  is(getComputedStyle(list()).maskImage, "none", "rows that fit wear no fade mask");
  await collapse();
});

add_task(async function test_wheel_coasts_with_momentum() {
  // scroll-model.js: a notch (3 lines, doubled to 6 by Firefox's system
  // scroll override) kicks the list, which coasts 108px to wherever friction
  // stops it (no row grid); quick notches accelerate; a reversal turns at
  // once; the edges stop it; pixel deltas stay native.
  await collapse();
  const extra = [];
  while (list().scrollHeight - list().clientHeight < 1200 && extra.length < 80) {
    extra.push(...(await openTabs(1)));
  }
  opened.push(...extra);
  const glideDone = () => TestUtils.waitForCondition(() => !window.AequeraTabs._glide, "the coast ends");
  list().scrollTop = 0;
  await new Promise(resolve => requestAnimationFrame(resolve));

  const positions = [];
  const onScroll = () => positions.push(list().scrollTop);
  list().addEventListener("scroll", onScroll);
  let prevented = null;
  const onWheel = event => (prevented = event.defaultPrevented);
  window.addEventListener("wheel", onWheel);
  const wheel = (deltaY, deltaMode = WheelEvent.DOM_DELTA_LINE) =>
    EventUtils.synthesizeWheel(list(), 10, 40, { deltaY, deltaMode });

  wheel(3);
  ok(prevented, "a line notch is the list's own scroll");
  await glideDone();
  const single = list().scrollTop;
  Assert.greater(single, 100, `one notch coasts its distance (${single})`);
  Assert.less(single, 112, "and no further");
  ok(positions.some(top => top > 1 && top < single - 1), "through intermediate positions");
  const steps = positions.slice(1).map((top, i) => top - positions[i]);
  ok(steps.every(step => step >= -0.5), "never backwards");

  list().scrollTop = 0;
  await new Promise(resolve => requestAnimationFrame(resolve));
  wheel(3);
  wheel(3);
  wheel(3);
  await glideDone();
  Assert.greater(list().scrollTop, 3 * single + 20, `quick notches accelerate (${list().scrollTop})`);

  const from = list().scrollTop;
  wheel(3);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const before = list().scrollTop;
  wheel(-3);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  Assert.less(list().scrollTop, before, "a notch the other way turns it at once");
  await glideDone();
  Assert.less(list().scrollTop, from + single, "and carries none of the old momentum");

  list().scrollTop = 0;
  await new Promise(resolve => requestAnimationFrame(resolve));
  wheel(-3);
  ok(prevented, "at the top, an upward notch is still the list's");
  await glideDone();
  is(list().scrollTop, 0, "and the edge holds it");

  wheel(20, WheelEvent.DOM_DELTA_PIXEL);
  ok(!prevented, "pixel deltas (touchpads) keep native scrolling");

  window.removeEventListener("wheel", onWheel);
  list().removeEventListener("scroll", onScroll);
  for (const tab of extra) {
    gBrowser.removeTab(tab, { animate: false });
  }
});

add_task(async function test_hidden_tabs_are_not_listed() {
  const [tab] = await openTabs(1);
  gBrowser.hideTab(tab, "test@example");
  await TestUtils.waitForCondition(() => !listedTabs().includes(tab), "a hidden tab has no row");
  gBrowser.showTab(tab);
  await TestUtils.waitForCondition(() => listedTabs().includes(tab), "showing it brings the row back");
});

add_task(async function test_drag_reorders_tabs() {
  const tabs = await openTabs(3);
  const [a, b, c] = tabs;
  const dataTransfer = new DataTransfer();
  const fire = (type, target, clientY) => {
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: box.left + box.width / 2,
        clientY: clientY ?? box.top + box.height / 2,
      })
    );
  };
  const reducedMotion =
    window.gReduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
  fire("dragstart", rowFor(a));
  const target = rowFor(c).getBoundingClientRect();
  // The visible gap chases at most one slot per frame, so a far jump
  // needs repeated frames to fully open; the drop commits the true gap.
  fire("dragover", rowFor(c), target.bottom - 2);
  fire("dragover", rowFor(c), target.bottom - 2);
  if (!reducedMotion) {
    is(
      list().getAttribute("movingtab"),
      "true",
      "dragging enables moving-tab mode for the live slide"
    );
    await TestUtils.waitForCondition(
      () => rowFor(b).style.transform != "",
      "siblings slide live during dragover, before any drop"
    );
    ok(
      gBrowser.tabs.indexOf(a) < gBrowser.tabs.indexOf(b),
      "the live slide previews without committing the order"
    );
    ok(rowFor(a).style.transform != "", "the dragged row follows the pointer");
    ok(
      rowFor(a).hasAttribute("dragging"),
      "the dragged row is marked for direct-manipulation tracking"
    );
  }
  fire("drop", rowFor(c), target.bottom - 2);
  if (!reducedMotion) {
    ok(
      rowFor(a).style.transform != "",
      "the drop stages rebased offsets onto the committed slots"
    );
    ok(
      list().hasAttribute("movingtab"),
      "the transition stays armed through the commit for the glide"
    );
  }
  fire("dragend", rowFor(a));
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(a) == gBrowser.tabs.indexOf(c) + 1,
    "dropping on the lower half of a row moves the tab after it"
  );
  const order = listedTabs();
  is(order.indexOf(a), order.indexOf(c) + 1, "the rows follow the new order");
  if (!reducedMotion) {
    await TestUtils.waitForCondition(
      () =>
        list().hasAttribute("movingtab") &&
        order.every(tab => rowFor(tab).style.transform == ""),
      "the release frame arms the glide"
    );
  }
  await TestUtils.waitForCondition(
    () =>
      order.every(tab => rowFor(tab).style.transform == "") &&
      !list().hasAttribute("movingtab"),
    "the settle glide finishes and moving-tab mode ends with the drag"
  );
});

add_task(async function test_drag_cancelled_leaves_order_and_visuals() {
  const tabs = await openTabs(2);
  const [a, b] = tabs;
  const before = gBrowser.tabs.indexOf(a);
  const dataTransfer = new DataTransfer();
  const fire = (type, target) => {
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      })
    );
  };
  fire("dragstart", rowFor(a));
  fire("dragover", rowFor(b));
  // No drop: the drag ends outside the list (Escape / drop on the page).
  fire("dragend", rowFor(a));
  is(gBrowser.tabs.indexOf(a), before, "cancelling the drag keeps the tab order");
  for (const tab of listedTabs()) {
    is(rowFor(tab).style.transform, "", "no slide transform survives a cancelled drag");
  }
  ok(!list().hasAttribute("movingtab"), "moving-tab mode ends with the drag");
});

add_task(async function test_real_drag_reorders_with_slide_and_settle() {
  if (HEADLESS) {
    ok(true, "skipped headless: synthesizeDrop needs the platform drag service");
    return;
  }
  // Full platform drag (real dragstart populating a real dataTransfer,
  // real dropEffect, real dragend delivery), not synthetic events.
  const tabs = await openTabs(3);
  const [a, , c] = tabs;
  const dst = rowFor(c).getBoundingClientRect();
  EventUtils.synthesizeDrop(
    rowFor(a),
    rowFor(c),
    null,
    "move",
    window,
    window,
    { clientX: dst.left + dst.width / 2, clientY: dst.bottom - 2 }
  );
  EventUtils.synthesizeMouseAtCenter(rowFor(c), { type: "mouseup" }, window);
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(a) == gBrowser.tabs.indexOf(c) + 1,
    "a real drop reorders the tabs"
  );
  const order = listedTabs();
  is(order.indexOf(a), order.indexOf(c) + 1, "the rows follow the new order");
  await TestUtils.waitForCondition(
    () =>
      order.every(tab => rowFor(tab) && rowFor(tab).style.transform == "") &&
      !list().hasAttribute("movingtab"),
    "visuals and moving-tab mode settle after a real drag"
  );
});

// NOTE: no real-drag detach test: ending a platform drag session requires
// a physical release, which headless synthetic input cannot produce (no
// dragend fires, verified). Detach logic is covered by
// test_drag_outside_detaches_to_new_window in a real window, and the real
// platform dragstart/dragover/drop path by test_real_drag_reorders_*.

add_task(async function test_drop_from_another_window_adopts_tab() {
  if (HEADLESS) {
    ok(true, "skipped headless: cross-window drop needs real window geometry");
    return;
  }
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await TestUtils.waitForCondition(
    () => win.AequeraTabs && win.AequeraTabs.element,
    "the other window's rail is ready"
  );
  const [tab] = await openTabs(1);
  const url = tab.linkedBrowser.currentURI.spec;
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", tab, 0);
  const otherRows = () => [
    ...win.document
      .getElementById("aequera-tabs")
      .querySelectorAll(".aequera-tab:not(.aequera-newtab)"),
  ];
  const fire = (type, target, clientY) => {
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new win.DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: box.left + box.width / 2,
        clientY: clientY ?? box.top + box.height / 2,
      })
    );
  };
  const reducedMotion =
    win.gReduceMotion || win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const first = otherRows()[0];
  const firstBox = first.getBoundingClientRect();
  fire("dragover", first, firstBox.top + 2);
  if (!reducedMotion) {
    await TestUtils.waitForCondition(
      () => otherRows().some(r => r.style.transform != ""),
      "the other rail opens a gap for the foreign tab"
    );
  }
  fire("drop", first, firstBox.top + 2);
  await TestUtils.waitForCondition(
    () => !gBrowser.tabs.includes(tab),
    "the tab leaves the original window"
  );
  const adopted = win.gBrowser.tabs.filter(
    t => !t.pinned && !t.hidden && t.linkedBrowser.currentURI.spec == url
  );
  is(adopted.length, 1, "the other window adopted exactly one tab with its URL");
  const listed = otherRows().map(r => r.tab);
  is(listed[0], adopted[0], "the adopted tab lands at the drop position with a row");
  await BrowserTestUtils.closeWindow(win);
  ok(true, "the other window closes cleanly");
});

add_task(async function test_drag_outside_detaches_to_new_window() {
  const [tab] = await openTabs(1);
  const newWindowPromise = BrowserTestUtils.waitForNewWindow();
  const dataTransfer = new DataTransfer();
  dataTransfer.dropEffect = "none";
  const row = rowFor(tab);
  const box = row.getBoundingClientRect();
  const fire = (type, clientX, clientY) => {
    row.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX,
        clientY,
        screenX: (window.screenX || 0) + (window.outerWidth || 800) + 200,
        screenY: (window.screenY || 0) + 200,
      })
    );
  };
  fire("dragstart", box.left + 10, box.top + 15);
  // Release far outside the strip: no drop lands on the list, so the
  // drag ends with effect none and the tab tears off like a native drag.
  fire("dragend", 5000, 5000);
  const win = await newWindowPromise;
  ok(!gBrowser.tabs.includes(tab), "the tab leaves the original window");
  await TestUtils.waitForCondition(
    () => !listedTabs().includes(tab),
    "its row is gone from the rail"
  );
  await BrowserTestUtils.closeWindow(win);
  ok(true, "the detached window closes cleanly");
});

// Synthetic drag events at explicit coordinates (headless-safe).
function dragAt(type, target, dataTransfer, clientX, clientY, extra = {}) {
  target.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX,
      clientY,
      ...extra,
    })
  );
}
const center = el => {
  const box = el.getBoundingClientRect();
  return [box.left + box.width / 2, box.top + box.height / 2];
};
const windowCount = () => [...Services.wm.getEnumerator("navigator:browser")].length;
// Tests that open tabs at the end of a long list: scroll them into view, as
// a person would before pointing at them.
async function showLastRows() {
  list().scrollTop = list().scrollHeight;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

add_task(async function test_drag_hands_firefox_a_tab_drag() {
  // Firefox's own drop code (essentials grid, other windows) only treats a
  // drag as a tab move when the tab type comes first and tab._dragData
  // describes it; the rows hand it the all-tabs-menu shape.
  const [tab] = await openTabs(1);
  const dataTransfer = new DataTransfer();
  dragAt("dragstart", rowFor(tab), dataTransfer, ...center(rowFor(tab)));
  is(dataTransfer.mozTypesAt(0)[0], "application/x-moz-tabbrowser-tab", "the tab type comes first");
  is(dataTransfer.mozGetDataAt("application/x-moz-tabbrowser-tab", 0), tab, "carrying the tab");
  is(
    dataTransfer.mozGetDataAt("text/x-moz-text-internal", 0),
    tab.linkedBrowser.currentURI.spec,
    "and its address for targets that take one"
  );
  ok(tab._dragData?.fromTabList, "Firefox's drag state describes a drag from outside its strip");
  Assert.deepEqual(tab._dragData.movingTabs, [tab], "moving just this tab");
  ok(window.AequeraTabs._drag, "the drag is live");
  dragAt("dragend", rowFor(tab), dataTransfer, ...center(rowFor(tab)));
  ok(!window.AequeraTabs._drag, "dragend reaches the list and ends the drag");
  ok(!("_dragData" in tab), "and Firefox's drag state is released");
});

add_task(async function test_releases_that_never_tear_off() {
  const [tab] = await openTabs(1);
  const before = windowCount();
  const end = (clientX, clientY, dataTransfer) => {
    dragAt("dragstart", rowFor(tab), new DataTransfer(), ...center(rowFor(tab)));
    window.AequeraTabs.onDragEnd({
      type: "dragend",
      dataTransfer: dataTransfer ?? { dropEffect: "none", mozUserCancelled: false },
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
    });
  };
  const rail = railBox().getBoundingClientRect();
  const dock = document.getElementById("aequera-workspace-dock");
  // Over the workspace dock, below the rows.
  end(...center(dock));
  // Just past the rail's edge (within half a rail width).
  end(rail.right + rail.width / 4, rail.top + 100);
  // Escape (the platform reports a user-cancelled session), far out.
  end(5000, 5000, { dropEffect: "none", mozUserCancelled: true });
  // Something else took the drop.
  end(5000, 5000, { dropEffect: "move", mozUserCancelled: false });
  await new Promise(resolve => setTimeout(resolve, 300));
  is(windowCount(), before, "no release by the rail, cancel, or accepted drop opens a window");
  ok(gBrowser.tabs.includes(tab), "the tab stays");
  ok(!window.AequeraTabs._drag, "and no drag is left behind");
});

add_task(async function test_dragging_out_restores_the_rows() {
  const [a, , c] = await openTabs(3);
  const dataTransfer = new DataTransfer();
  dragAt("dragstart", rowFor(a), dataTransfer, ...center(rowFor(a)));
  const target = rowFor(c).getBoundingClientRect();
  for (let i = 0; i < 3; i++) {
    dragAt("dragover", rowFor(c), dataTransfer, target.left + 20, target.bottom - 2);
  }
  if (!window.AequeraTabs._drag.rm) {
    ok(listedTabs().some(t => rowFor(t).style.transform), "inside, the rows slide");
  }
  // Leave the list sideways (over the page).
  dragAt("dragleave", list(), dataTransfer, list().getBoundingClientRect().right + 300, target.top);
  ok(rowFor(a).hasAttribute("dragout"), "outside, the dragged row dims in its slot");
  ok(
    listedTabs().every(t => !rowFor(t).style.transform),
    "and every row is back in place: a release out there does not reorder"
  );
  dragAt("dragover", rowFor(c), dataTransfer, target.left + 20, target.bottom - 2);
  ok(!rowFor(a).hasAttribute("dragout"), "coming back in resumes the drag");
  dragAt("dragend", rowFor(a), dataTransfer, ...center(rowFor(a)));
});

add_task(async function test_drop_lands_where_released() {
  // A quick drag can be released before a dragover reached the final
  // position; the drop's own coordinates decide.
  const [a, , c] = await openTabs(3);
  await showLastRows();
  const dataTransfer = new DataTransfer();
  dragAt("dragstart", rowFor(a), dataTransfer, ...center(rowFor(a)));
  dragAt("dragover", rowFor(a), dataTransfer, ...center(rowFor(a)));
  const target = rowFor(c).getBoundingClientRect();
  dragAt("drop", rowFor(c), dataTransfer, target.left + 20, target.bottom - 2);
  dragAt("dragend", rowFor(a), dataTransfer, target.left + 20, target.bottom - 2);
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(a) == gBrowser.tabs.indexOf(c) + 1,
    "dropped on c's lower half without a dragover there, the tab lands after c"
  );
});

add_task(async function test_autoscroll_keeps_the_row_under_the_pointer() {
  const fit = Math.ceil(list().clientHeight / 36);
  const tabs = [];
  for (let i = 0; i < fit + 8; i++) {
    tabs.push(BrowserTestUtils.addTab(gBrowser, "about:blank", { skipAnimation: true }));
  }
  opened.push(...tabs);
  await TestUtils.waitForCondition(() => list().scrollHeight > list().clientHeight, "the list overflows");
  list().scrollTop = 0;
  const first = listedTabs()[0];
  const dataTransfer = new DataTransfer();
  const [x, y] = center(rowFor(first));
  dragAt("dragstart", rowFor(first), dataTransfer, x, y);
  if (window.AequeraTabs._drag.rm) {
    dragAt("dragend", rowFor(first), dataTransfer, x, y);
    ok(true, "reduced motion has no live slide to check");
    return;
  }
  const pointerY = list().getBoundingClientRect().top + 200;
  dragAt("dragover", list(), dataTransfer, x, pointerY);
  list().scrollTop = 150; // what the edge autoscroll does under a still pointer
  dragAt("dragover", list(), dataTransfer, x, pointerY);
  const box = rowFor(first).getBoundingClientRect();
  Assert.less(
    Math.abs(box.top + box.height / 2 - pointerY),
    box.height,
    "the dragged row stays under the pointer while the list scrolls"
  );
  dragAt("dragend", rowFor(first), dataTransfer, x, y);
  for (const tab of tabs) {
    gBrowser.removeTab(tab, { animate: false });
  }
});

add_task(async function test_an_essential_dropped_on_the_rows_is_unpinned() {
  const [a, b] = await openTabs(2);
  gBrowser.pinTab(a);
  ok(a.pinned, "an essential");
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", a, 0);
  const [x, y] = center(rowFor(b));
  dragAt("dragover", rowFor(b), dataTransfer, x, y - 10);
  dragAt("drop", rowFor(b), dataTransfer, x, y - 10);
  await TestUtils.waitForCondition(() => !a.pinned, "dropped among the rows, it is unpinned");
  is(gBrowser.tabs.indexOf(a) + 1, gBrowser.tabs.indexOf(b), "and lands where it was dropped");
});

add_task(async function test_a_private_tab_never_crosses_into_a_normal_window() {
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privateTab = privateWin.gBrowser.selectedTab;
  const dataTransfer = new DataTransfer();
  dataTransfer.mozSetDataAt("application/x-moz-tabbrowser-tab", privateTab, 0);
  const [b] = await openTabs(1);
  const count = gBrowser.tabs.length;
  const [x, y] = center(rowFor(b));
  is(window.AequeraTabs.foreignTab({ dataTransfer }), null, "the rail does not accept it");
  dragAt("dragover", rowFor(b), dataTransfer, x, y);
  dragAt("drop", rowFor(b), dataTransfer, x, y);
  await new Promise(resolve => setTimeout(resolve, 300));
  ok(privateWin.gBrowser.tabs.includes(privateTab), "the private tab stays in its window");
  is(gBrowser.tabs.length, count, "and nothing was adopted into the normal window");
  await BrowserTestUtils.closeWindow(privateWin);
  await SimpleTest.promiseFocus(window);
});

add_task(async function test_a_link_dropped_on_the_rows_opens_there() {
  const [a, b] = await openTabs(2);
  const url = "https://example.com/aequera-dropped-link";
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/uri-list", url);
  const [x, y] = center(rowFor(b));
  const opened_ = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  dragAt("dragover", rowFor(b), dataTransfer, x, y - 10);
  dragAt("drop", rowFor(b), dataTransfer, x, y - 10);
  const tab = await opened_;
  opened.push(tab);
  is(gBrowser.tabs.indexOf(tab), gBrowser.tabs.indexOf(a) + 1, "the link opens in the gap it was dropped in");
  ok(!list().hasAttribute("movingtab"), "and the preview is gone");
});

add_task(async function test_reduced_motion_marks_the_landing_gap() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  const [a, , c] = await openTabs(3);
  const dataTransfer = new DataTransfer();
  dragAt("dragstart", rowFor(a), dataTransfer, ...center(rowFor(a)));
  ok(window.AequeraTabs._drag.rm, "reduced motion drag");
  const target = rowFor(c).getBoundingClientRect();
  dragAt("dragover", rowFor(c), dataTransfer, target.left + 20, target.bottom - 2);
  const line = list().querySelector(".aequera-tab-dropline");
  ok(line, "a still line marks where the tab will land");
  ok(listedTabs().every(t => !rowFor(t).style.transform), "and nothing slides");
  dragAt("drop", rowFor(c), dataTransfer, target.left + 20, target.bottom - 2);
  dragAt("dragend", rowFor(a), dataTransfer, target.left + 20, target.bottom - 2);
  ok(!list().querySelector(".aequera-tab-dropline"), "the line goes with the drag");
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(a) == gBrowser.tabs.indexOf(c) + 1,
    "the tab lands on the marked side"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_a_drag_over_the_rail_is_hover() {
  await collapse();
  const rail = container();
  const dataTransfer = new DataTransfer();
  const [x, y] = center(railBox());
  dragAt("dragenter", rail, dataTransfer, x, y);
  await TestUtils.waitForCondition(
    () => ROOT.hasAttribute("aequera-rail-expanded"),
    "dragging over the collapsed rail widens it, like hovering"
  );
  dragAt("dragleave", rail, dataTransfer, 900, y);
  await TestUtils.waitForCondition(isFullyCollapsed, "leaving it collapses it again");
});

add_task(async function test_context_menu_is_firefox_tab_menu_for_that_row() {
  const [tab] = await openTabs(1);
  await showLastRows();
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(rowFor(tab), { type: "contextmenu", button: 2 });
  await shown;
  is(TabContextMenu.contextTab, tab, "Firefox's tab menu targets the row's tab");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
});

add_task(async function test_icon_never_moves_and_titles_fade_in() {
  await collapse();
  const row = rowFor(opened.find(t => t.isConnected && !t.hidden));
  const title = row.querySelector(".aequera-tab-title");
  await TestUtils.waitForCondition(
    () => Number(getComputedStyle(title).opacity) == 0,
    "collapsed: title not shown"
  );
  const iconLeft = () => row.querySelector(".aequera-tab-icon").getBoundingClientRect().left;
  const collapsedIcon = iconLeft();

  hoverRail();
  await TestUtils.waitForCondition(
    () => ROOT.hasAttribute("aequera-rail-content-expanded"),
    "hover widens"
  );
  Assert.less(Number(getComputedStyle(title).opacity), 1, "the title fades in rather than appearing at once");
  await TestUtils.waitForCondition(() => Number(getComputedStyle(title).opacity) == 1, "title shown");
  Assert.less(Math.abs(iconLeft() - collapsedIcon), 0.5, "the icon did not move");
  const rail = railBox().getBoundingClientRect();
  Assert.greater(row.getBoundingClientRect().width, rail.width - 20, "the row grew with the rail");

  await collapse();
});
