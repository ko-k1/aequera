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
  const [a, , c] = tabs;
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
  fire("dragstart", rowFor(a));
  const target = rowFor(c).getBoundingClientRect();
  fire("dragover", rowFor(c), target.bottom - 2);
  fire("drop", rowFor(c), target.bottom - 2);
  fire("dragend", rowFor(a));
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(a) == gBrowser.tabs.indexOf(c) + 1,
    "dropping on the lower half of a row moves the tab after it"
  );
  const order = listedTabs();
  is(order.indexOf(a), order.indexOf(c) + 1, "the rows follow the new order");
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
