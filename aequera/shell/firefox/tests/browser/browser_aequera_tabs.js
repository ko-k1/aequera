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
const newTabRow = () => list().querySelector(".aequera-newtab");
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

add_task(async function test_context_menu_is_firefox_tab_menu_for_that_row() {
  const [tab] = await openTabs(1);
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
