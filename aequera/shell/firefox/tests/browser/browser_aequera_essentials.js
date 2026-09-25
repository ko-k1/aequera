/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Essentials (rail/aequera-essentials.css/.js): pinned tabs as pill tiles
// (Zen metrics: 46px tiles, 4px grid gap) in balanced rows for 1-9
// essentials; one column while collapsed.

const ROOT = document.documentElement;
const container = () => document.getElementById("sidebar-container");
const pinnedTabs = () => gBrowser.tabs.filter(t => t.pinned);
const rect = tab => tab.querySelector(".tab-background").getBoundingClientRect();
const round = n => Math.round(n);

let opened = [];

/** Pin exactly `count` of the test's tabs (in order), unpinning the rest. */
function setPinnedCount(count) {
  opened.forEach((tab, i) => {
    if (i < count && !tab.pinned) {
      gBrowser.pinTab(tab);
    } else if (i >= count && tab.pinned) {
      gBrowser.unpinTab(tab);
    }
  });
}

/** Tiles per row, top to bottom. */
function rowShape() {
  const rows = new Map();
  for (const tab of pinnedTabs()) {
    const top = round(rect(tab).top);
    rows.set(top, (rows.get(top) ?? 0) + 1);
  }
  return [...rows.keys()].sort((a, b) => a - b).map(top => rows.get(top));
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.rail.pinned", false],
      ["aequera.hover.openDelayMs", 0],
      ["aequera.hover.closeDelayMs", 0],
      ["aequera.motion.durationMs", 100],
    ],
  });
  window.windowUtils.disableNonTestMouseEvents(true);
  for (let i = 0; i < 10; i++) {
    opened.push(BrowserTestUtils.addTab(gBrowser, `data:text/html,essential ${i}`));
  }
  setPinnedCount(5);
  is(pinnedTabs().length, 5, "five essentials");
  registerCleanupFunction(async () => {
    window.windowUtils.disableNonTestMouseEvents(false);
    for (const tab of opened) {
      gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    }
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_collapsed_is_one_column() {
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-rail-expanded"), "collapsed");
  const lefts = new Set(pinnedTabs().map(t => round(rect(t).left)));
  is(lefts.size, 1, "collapsed essentials share one column");
  const tops = pinnedTabs().map(t => rect(t).top);
  ok(tops.every((top, i) => i == 0 || top > tops[i - 1]), "stacked top to bottom");
});

add_task(async function test_expanded_is_a_grid_of_uniform_pills() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.pinned", true]] });
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail-expanded"), "expanded");
  await TestUtils.waitForCondition(
    () => round(rect(pinnedTabs()[2]).top) == round(rect(pinnedTabs()[0]).top),
    "first row laid out"
  );
  const tiles = pinnedTabs().map(rect);
  const firstRow = tiles.filter(r => round(r.top) == round(tiles[0].top));
  is(firstRow.length, 3, "five essentials: a row of three first (3 2)");
  is(new Set(firstRow.map(r => round(r.left))).size, 3, "side by side");
  ok(firstRow.every(r => Math.abs(r.width - firstRow[0].width) < 1), "uniform tile width");
  // 4px grid gap plus Firefox's pinned-tab inline margin on each side.
  const margin = parseFloat(
    getComputedStyle(pinnedTabs()[0].querySelector(".tab-background")).marginInlineStart
  );
  is(round(firstRow[1].left - firstRow[0].right), round(4 + 2 * margin), "tile spacing");
  Assert.greater(round(tiles[3].top), round(tiles[0].top), "the fourth wraps to the next row");
  is(round(tiles[3].top - tiles[0].bottom), 4, "4px gap between rows");
  is(round(tiles[0].height), 46, "46px tiles");
  for (const tab of pinnedTabs()) {
    const tile = rect(tab);
    const icon = tab.querySelector(".tab-icon-stack").getBoundingClientRect();
    ok(
      Math.abs(icon.left + icon.width / 2 - (tile.left + tile.width / 2)) < 1 &&
        Math.abs(icon.top + icon.height / 2 - (tile.top + tile.height / 2)) < 1,
      "icon centered in its tile on both axes"
    );
  }
  for (const tab of pinnedTabs()) {
    is(
      getComputedStyle(tab.querySelector(".tab-label-container")).display,
      "none",
      "icon-only tile"
    );
  }
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-rail-expanded"), "collapsed");
});

add_task(async function test_rows_are_balanced_for_every_count() {
  const expected = {
    1: [1],
    2: [2],
    3: [3],
    4: [2, 2],
    5: [3, 2],
    6: [3, 3],
    7: [3, 2, 2],
    8: [3, 3, 2],
    9: [3, 3, 3],
    10: [3, 3, 3, 1],
  };
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.pinned", true]] });
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail-expanded"), "expanded");
  const container = document.getElementById("pinned-tabs-container");
  for (const [count, shape] of Object.entries(expected)) {
    setPinnedCount(Number(count));
    await TestUtils.waitForCondition(
      () => JSON.stringify(rowShape()) == JSON.stringify(shape),
      `${count} essentials lay out as ${shape.join(" ")}`
    );
    is(
      container.getAttribute("aequera-essentials"),
      Number(count) > 9 ? "many" : count,
      `count attribute for ${count}`
    );
    if (Number(count) <= 9) {
      // Balanced: every row spans the grid edge to edge.
      const tiles = pinnedTabs().map(rect);
      const left = Math.min(...tiles.map(r => r.left));
      const right = Math.max(...tiles.map(r => r.right));
      for (const top of new Set(tiles.map(r => round(r.top)))) {
        const row = tiles.filter(r => round(r.top) == top);
        ok(
          Math.abs(Math.min(...row.map(r => r.left)) - left) < 1 &&
            Math.abs(Math.max(...row.map(r => r.right)) - right) < 1,
          `${count}: row at ${top} fills the width`
        );
      }
    }
  }
  setPinnedCount(5);
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-rail-expanded"), "collapsed");
});

add_task(async function test_grid_does_not_reflow_while_the_rail_widens() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.motion.durationMs", 1000],
      ["aequera.motion.easing", "linear"],
    ],
  });
  const railBox = container().querySelector(":scope > sidebar-main");
  // Wait for the previous task's collapse to finish physically, not just its
  // attribute: a rail still mid-collapse would reverse to full width at once.
  await TestUtils.waitForCondition(
    () => railBox.getBoundingClientRect().width < 60,
    "rail physically collapsed"
  );
  const collapsedWidth = railBox.getBoundingClientRect().width;
  EventUtils.synthesizeMouse(container(), 5, 30, { type: "mousemove" });
  await TestUtils.waitForCondition(() => {
    const width = railBox.getBoundingClientRect().width;
    return width > collapsedWidth + 40 && width < 200;
  }, "rail mid-widen");
  const origin = railBox.getBoundingClientRect().left;
  const midFlight = pinnedTabs().map(t => round(rect(t).left - origin));
  await TestUtils.waitForCondition(
    () => Math.abs(railBox.getBoundingClientRect().width - 220) < 1,
    "rail fully widened"
  );
  const settled = pinnedTabs().map(t => round(rect(t).left - origin));
  Assert.deepEqual(midFlight, settled, "tiles were already in their final grid positions mid-widen");
  EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabbox"), {
    type: "mousemove",
  });
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-rail-expanded"), "collapsed");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_selected_essential_keeps_firefox_selection() {
  const [other, tab] = pinnedTabs();
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => tab.querySelector(".tab-background").hasAttribute("selected"),
    "Firefox marks the selected tile"
  );
  const background = t => getComputedStyle(t.querySelector(".tab-background")).backgroundColor;
  isnot(background(tab), background(other), "the selected tile is painted differently");
  gBrowser.selectedTab = gBrowser.tabs.find(t => !t.pinned);
});
