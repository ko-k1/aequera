/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera tab rail (aequera/shell/firefox/rail): Firefox's vertical tab strip
// hosted in Aequera chrome with the sidebar revamp off
// (patches/browser/aequera-rail), Aequera-owned width, hover, and motion.

const ROOT = document.documentElement;
const container = () => document.getElementById("sidebar-container");
const railBox = () => container().querySelector(":scope > sidebar-main");
const tabbox = () => document.getElementById("tabbrowser-tabbox");
const isExpanded = () => ROOT.hasAttribute("aequera-rail-expanded");
// Content (tab rows, essentials, dock) collapses after the width transition.
const isFullyCollapsed = () =>
  !ROOT.hasAttribute("aequera-rail-expanded") && !gBrowser.tabContainer.hasAttribute("expanded");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const railWidth = () => railBox().getBoundingClientRect().width;
// Unpinned tabs render as Aequera rows (rail/aequera-tabs.js).
const rowFor = tab => window.AequeraTabs.rows.get(tab);

function pageClipLeft() {
  const clip = getComputedStyle(tabbox()).clipPath;
  const match = /^inset\(\s*[-\d.]+px\s+[-\d.]+px\s+[-\d.]+px\s+([-\d.]+)px/.exec(clip);
  return match ? parseFloat(match[1]) : 0;
}

function hoverRail() {
  EventUtils.synthesizeMouse(container(), 5, 120, { type: "mousemove" });
}

function leaveRail() {
  EventUtils.synthesizeMouseAtCenter(tabbox(), { type: "mousemove" });
}

/** On the page, inside where the widened rail will reach. */
function restPoint() {
  const box = tabbox().getBoundingClientRect();
  return { x: box.left + 100, y: box.top + 200 };
}

function restOnPageUnderWidenedRail() {
  const { x, y } = restPoint();
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" });
}

/** Waits until the rail covers (x, y), then two frames for Gecko's
 * synthesized move to reach the resting pointer. */
async function railReaches({ x, y }) {
  await TestUtils.waitForCondition(() => {
    const rail = railBox().getBoundingClientRect();
    return x >= rail.left && x < rail.right && y >= rail.top && y < rail.bottom;
  }, "the widened rail is under the resting pointer");
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function collapse() {
  if (gURLBar.focused) {
    gBrowser.selectedBrowser.focus();
  }
  leaveRail();
  await TestUtils.waitForCondition(isFullyCollapsed, "rail collapses");
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.revamp", false],
      ["sidebar.verticalTabs", true],
      ["sidebar.verticalTabs.requireRevamp", false],
      ["aequera.hover.openDelayMs", 40],
      ["aequera.hover.closeDelayMs", 150],
      ["aequera.motion.durationMs", 100],
      ["aequera.rail.pinned", false],
    ],
  });
  window.windowUtils.disableNonTestMouseEvents(true);
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail"), "rail active");
  await collapse();
  registerCleanupFunction(async () => {
    window.windowUtils.disableNonTestMouseEvents(false);
    await collapse();
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_rail_hosts_firefox_vertical_tabs_without_revamp() {
  ok(!Services.prefs.getBoolPref("sidebar.revamp"), "revamp is off");
  isnot(getComputedStyle(container()).display, "none", "the rail is shown");
  ok(container().contains(gBrowser.tabContainer), "Firefox's tab strip lives in the rail");
  is(gBrowser.tabContainer.getAttribute("orient"), "vertical", "tab strip is vertical");
  const row = rowFor(gBrowser.selectedTab).getBoundingClientRect();
  Assert.greater(row.width * row.height, 0, "tab rows are laid out in the rail");
});

add_task(async function test_hover_widens_over_the_page_without_reflow() {
  const collapsedWidth = railWidth();
  const pageBefore = tabbox().getBoundingClientRect();
  hoverRail();
  await TestUtils.waitForCondition(isExpanded, "hovering widens the rail");
  ok(gBrowser.tabContainer.hasAttribute("expanded"), "tab strip shows full rows");
  await TestUtils.waitForCondition(() => Math.abs(railWidth() - 220) < 1, "rail reaches its width");
  // Measured width is not enough: the widened part must really be painted
  // and hit-testable (a clipping ancestor would hide it).
  const box = railBox().getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + 200, box.top + box.height / 2);
  ok(container().contains(hit), `the widened rail is hit-testable at 200px (hit ${hit?.id || hit?.localName})`);
  const pageAfter = tabbox().getBoundingClientRect();
  is(pageAfter.left, pageBefore.left, "the page did not move");
  is(pageAfter.width, pageBefore.width, "the page did not reflow");
  await TestUtils.waitForCondition(
    () => Math.abs(pageClipLeft() - (220 - collapsedWidth)) < 1,
    "the page card yields exactly the rail's extra width"
  );
  await collapse();
  await TestUtils.waitForCondition(() => pageClipLeft() < 1, "clip released when collapsed");
});

add_task(async function test_linger_and_reentry() {
  hoverRail();
  await TestUtils.waitForCondition(isExpanded, "expanded");
  const leftAt = performance.now();
  leaveRail();
  await wait(60);
  ok(isExpanded(), "still expanded during the linger");
  await TestUtils.waitForCondition(isFullyCollapsed, "collapses after the linger");
  Assert.greaterOrEqual(performance.now() - leftAt, 130, "waited for the close delay");

  hoverRail();
  await TestUtils.waitForCondition(isExpanded, "expanded again");
  leaveRail();
  await wait(50);
  hoverRail();
  await wait(400);
  ok(isExpanded(), "re-entering during the linger cancels the collapse");
  await collapse();
});

add_task(async function test_interrupting_mid_transition_does_not_jump() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.motion.durationMs", 1000],
      ["aequera.motion.easing", "linear"],
      ["aequera.hover.closeDelayMs", 0],
    ],
  });
  const collapsedWidth = railWidth();
  hoverRail();
  await TestUtils.waitForCondition(
    () => railWidth() > collapsedWidth + 40,
    "the rail is mid-way through widening"
  );
  const widthBefore = railWidth();
  leaveRail();
  await TestUtils.waitForCondition(() => !isExpanded(), "leaving is honored mid-transition");
  const widthAfter = railWidth();
  Assert.less(
    Math.abs(widthAfter - widthBefore),
    40,
    `reversal continues from the current width (${widthBefore} -> ${widthAfter})`
  );
  await TestUtils.waitForCondition(() => railWidth() < collapsedWidth + 1, "ends collapsed");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_address_bar_focus_expands_and_holds() {
  leaveRail();
  gURLBar.focus();
  ok(isExpanded(), "focusing the address bar widens the rail at once");
  await wait(300);
  ok(isExpanded(), "and holds while it is focused");
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(isFullyCollapsed, "collapses after blur");
});

add_task(async function test_context_menu_from_the_rail_holds_it_open() {
  hoverRail();
  await TestUtils.waitForCondition(isExpanded, "expanded");
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(rowFor(gBrowser.selectedTab), { type: "contextmenu", button: 2 });
  await shown;
  leaveRail();
  await wait(300);
  ok(isExpanded(), "stays expanded while its context menu is open");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  // While the menu was open it received the pointer; after it closes, the
  // next move away from the rail is what lets it collapse.
  leaveRail();
  await TestUtils.waitForCondition(isFullyCollapsed, "collapses once the menu closes");
});

add_task(async function test_pinned_takes_layout_space() {
  const pageLeft = tabbox().getBoundingClientRect().left;
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.pinned", true]] });
  await TestUtils.waitForCondition(isExpanded, "pinned is expanded");
  await TestUtils.waitForCondition(
    () => tabbox().getBoundingClientRect().left > pageLeft + 100,
    "the page moves aside for a pinned rail"
  );
  await TestUtils.waitForCondition(() => pageClipLeft() < 1, "no clip: nothing overlays the page");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(isFullyCollapsed, "unpinned collapses");
});

add_task(async function test_structural_prefs_are_locked() {
  for (const pref of [
    "sidebar.revamp",
    "sidebar.verticalTabs.requireRevamp",
    "browser.tabs.parkedHiddenSources",
  ]) {
    ok(Services.prefs.prefIsLocked(pref), `${pref} is locked`);
  }
  // What about:config (or any code) would do: the write is accepted without
  // error and ignored.
  Services.prefs.setBoolPref("sidebar.revamp", true);
  ok(!Services.prefs.getBoolPref("sidebar.revamp"), "the revamp stays off");
  Services.prefs.setCharPref("browser.tabs.parkedHiddenSources", "");
  is(
    Services.prefs.getCharPref("browser.tabs.parkedHiddenSources"),
    "aequera-workspaces",
    "workspace parking stays protected"
  );
  await new Promise(resolve => setTimeout(resolve, 200));
  ok(ROOT.hasAttribute("aequera-rail"), "the rail is untouched");
  Services.prefs.clearUserPref("sidebar.revamp");
  Services.prefs.clearUserPref("browser.tabs.parkedHiddenSources");
});

add_task(async function test_content_collapses_after_the_width_transition() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.motion.durationMs", 600],
      ["aequera.hover.closeDelayMs", 0],
    ],
  });
  const tab = gBrowser.selectedTab;
  hoverRail();
  await TestUtils.waitForCondition(isExpanded, "expanded");
  await TestUtils.waitForCondition(() => Math.abs(railWidth() - 220) < 1, "fully widened");
  leaveRail();
  await TestUtils.waitForCondition(() => !isExpanded(), "collapse started");
  ok(gBrowser.tabContainer.hasAttribute("expanded"), "tab rows stay wide while the rail narrows");
  is(
    Number(getComputedStyle(rowFor(tab).querySelector(".aequera-tab-title")).opacity),
    1,
    "titles are clipped away by the narrowing rail, not snapped off"
  );
  await TestUtils.waitForCondition(isFullyCollapsed, "content collapses once the width is done");
  Assert.less(railWidth(), 60, "and by then the rail is narrow");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_rail_is_the_same_material_as_the_top_bar() {
  const toolbox = getComputedStyle(gNavToolbox).backgroundColor;
  for (const [label, pinned] of [["collapsed", false], ["expanded", true]]) {
    await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.pinned", pinned]] });
    await TestUtils.waitForCondition(() => isExpanded() == pinned, label);
    for (const el of [container(), railBox(), document.getElementById("vertical-tabs")]) {
      is(getComputedStyle(el).backgroundColor, toolbox, `${label}: ${el.id || el.localName} paints like the top bar`);
    }
    await SpecialPowers.popPrefEnv();
  }
  await TestUtils.waitForCondition(isFullyCollapsed, "collapsed");
});

add_task(async function test_widening_under_a_still_pointer_is_not_hover() {
  // The pointer rests on the page where the widened rail will reach (Ctrl+L
  // or a new tab with the mouse left there): the rail widening under it is
  // not the pointer moving onto it.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.rail.expandOnAddressFocus", true],
      ["aequera.rail.expandedWidth", 220],
      ["sidebar.position_start", true],
    ],
  });
  await collapse();
  restOnPageUnderWidenedRail();
  gURLBar.focus();
  ok(isExpanded(), "the address bar widens the rail");
  await railReaches(restPoint());
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(
    isFullyCollapsed,
    "collapses once the address bar blurs, although the rail is under the resting pointer"
  );

  // A real move onto the rail widened that way is hover and holds it.
  gURLBar.focus();
  await railReaches(restPoint());
  EventUtils.synthesizeMouse(container(), 100, 210, { type: "mousemove" });
  gBrowser.selectedBrowser.focus();
  await wait(450);
  ok(isExpanded(), "a move onto the rail holds it after the address bar blurs");
  await collapse();

  // So is a press without any move (a touchpad tap). On a tab row the press
  // selects that tab; put the selection back afterwards.
  const selected = gBrowser.selectedTab;
  restOnPageUnderWidenedRail();
  gURLBar.focus();
  await railReaches(restPoint());
  const { x, y } = restPoint();
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousedown" });
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mouseup" });
  gBrowser.selectedBrowser.focus();
  await wait(450);
  ok(isExpanded(), "a press on the rail holds it after the address bar blurs");
  gBrowser.selectedTab = selected;
  await collapse();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_rail_reaching_a_pointer_that_left_it_is_not_hover() {
  // Widened by hover, held by the address bar, the pointer leaves for the
  // page; then the rail grows under that resting pointer (here a wider
  // setting; a window retile does the same). That is not hover either.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.rail.expandOnAddressFocus", true],
      ["aequera.rail.expandedWidth", 220],
      ["sidebar.position_start", true],
    ],
  });
  await collapse();
  hoverRail();
  await TestUtils.waitForCondition(isExpanded, "hover widens the rail");
  gURLBar.focus();
  const beyond = { x: railBox().getBoundingClientRect().left + 260, y: restPoint().y };
  EventUtils.synthesizeMouseAtPoint(beyond.x, beyond.y, { type: "mousemove" });
  await wait(300); // the pointer is off the rail; the address bar holds it
  ok(isExpanded(), "held by the address bar");
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.expandedWidth", 320]] });
  await railReaches(beyond);
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(
    isFullyCollapsed,
    "collapses once the address bar blurs, although the rail grew under the resting pointer"
  );
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_background_window_releases_the_address_bar_hold() {
  // The address bar keeps its focus in a window sent to the background, but
  // shows no caret or focus ring there: it must not hold the rail open.
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.expandOnAddressFocus", true]] });
  leaveRail();
  gURLBar.focus();
  ok(isExpanded(), "widened while the address bar is focused");
  const other = await BrowserTestUtils.openNewBrowserWindow();
  await TestUtils.waitForCondition(isFullyCollapsed, "collapses when the window goes to the background");
  ok(gURLBar.focused, "the address bar is still this window's focused element");
  await BrowserTestUtils.closeWindow(other);
  await SimpleTest.promiseFocus(window);
  await TestUtils.waitForCondition(isExpanded, "widens again when the window comes back to the front");
  await collapse();
  await SpecialPowers.popPrefEnv();
});
