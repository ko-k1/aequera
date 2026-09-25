/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera UI must survive Firefox rebuilding its chrome: turning the sidebar
// and vertical tabs off and on, and customize mode (including removing a
// toolbar button). After every step the shell must be in a sane state.

const ROOT = document.documentElement;
const tabbox = () => document.getElementById("tabbrowser-tabbox");
const toolbar = () => document.getElementById("PersonalToolbar");
const dock = () => document.getElementById("aequera-workspace-dock");

/** Clip insets of the page card, in px: [top, right, bottom, left]. */
function pageClipInsets() {
  const clip = getComputedStyle(tabbox()).clipPath;
  const match = /^inset\(\s*([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px\s+([-\d.]+)px/.exec(clip);
  return match ? match.slice(1, 5).map(Number) : [0, 0, 0, 0];
}

async function assertShellSane(label) {
  // Let observers, rAF work, and any animations settle.
  await SidebarController.waitUntilStable?.();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!ROOT.hasAttribute("aequera-bookmarks-open")) {
    const [top] = pageClipInsets();
    is(top, 0, `${label}: page top is not clipped while the drawer is closed`);
  }
  if (!window.AequeraRail?.expanded) {
    const [, right, , left] = pageClipInsets();
    is(left + right, 0, `${label}: page side is not clipped while the rail is collapsed`);
  }
  const urlbar = document.getElementById("urlbar").getBoundingClientRect();
  Assert.greater(urlbar.width, 100, `${label}: address bar has a usable width`);
  Assert.greater(urlbar.height, 10, `${label}: address bar has a usable height`);
  ok(!gBrowser.selectedTab.hidden, `${label}: the selected tab is visible`);
  Assert.greaterOrEqual(gBrowser.visibleTabs.length, 1, `${label}: tabs are reachable`);
  // With the sidebar hidden ("hide-sidebar"), Firefox hides the vertical tab
  // list itself by design; tabs must be laid out whenever the rail is shown.
  if (!SidebarController.sidebarContainer.hidden) {
    const tab = gBrowser.selectedTab.getBoundingClientRect();
    Assert.greater(tab.width * tab.height, 0, `${label}: the selected tab is laid out`);
  }
  if (ROOT.hasAttribute("aequera-bookmarks-peek")) {
    is(getComputedStyle(toolbar()).position, "absolute", `${label}: drawer is out of the flow`);
  }
  if (SidebarController.sidebarVerticalTabsEnabled) {
    ok(dock()?.isConnected, `${label}: workspace dock is mounted`);
    ok(
      document.querySelector("sidebar-main")?.contains(dock()),
      `${label}: dock lives in the rail`
    );
  }
}

add_setup(async () => {
  await window.AequeraWorkspaces.ready;
  await assertShellSane("start");
});

add_task(async function test_vertical_tabs_off_and_on() {
  await SpecialPowers.pushPrefEnv({ set: [["sidebar.verticalTabs", false]] });
  await TestUtils.waitForCondition(() => !SidebarController.sidebarVerticalTabsEnabled, "horizontal");
  await assertShellSane("vertical tabs off");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => SidebarController.sidebarVerticalTabsEnabled, "vertical");
  await assertShellSane("vertical tabs on again");
});

add_task(async function test_sidebar_panel_open_and_close() {
  await SidebarController.show("viewBookmarksSidebar");
  await assertShellSane("sidebar panel open");
  SidebarController.hide();
  await TestUtils.waitForCondition(() => !SidebarController.isOpen, "sidebar panel closed");
  await assertShellSane("sidebar panel closed");
});

add_task(async function test_turning_the_revamp_on_is_refused() {
  // sidebar.revamp is locked off (aequera-prefs.js): an about:config flip is
  // ignored, so the launcher can never take the rail back.
  await SpecialPowers.pushPrefEnv({ set: [["sidebar.revamp", true]] });
  ok(!Services.prefs.getBoolPref("sidebar.revamp"), "the revamp stays off");
  await assertShellSane("after trying to turn the revamp on");
  ok(document.documentElement.hasAttribute("aequera-rail"), "the rail stays");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_customize_mode_and_removing_a_button() {
  const customizing = BrowserTestUtils.waitForEvent(gNavToolbox, "customizationready");
  gCustomizeMode.enter();
  await customizing;
  ok(!ROOT.hasAttribute("aequera-bookmarks-peek"), "drawer mode is off while customizing");
  is(pageClipInsets()[0], 0, "customizing: page top not clipped");

  const removable = CustomizableUI.getWidgetIdsInArea("nav-bar").find(
    id => id !== "urlbar-container" && CustomizableUI.isWidgetRemovable(id)
  );
  ok(removable, `removing ${removable}`);
  CustomizableUI.removeWidgetFromArea(removable);

  const done = BrowserTestUtils.waitForEvent(gNavToolbox, "aftercustomization");
  gCustomizeMode.exit();
  await done;
  await assertShellSane(`after removing ${removable} in customize mode`);

  CustomizableUI.reset();
  await assertShellSane("after resetting customization");
});

add_task(async function test_removing_the_sidebar_button_keeps_the_rail() {
  // Firefox forces horizontal tabs when the sidebar button is removed (bug
  // 1970015); with Aequera's rail (patches/browser/aequera-rail/0001) the
  // tab strip must stay.
  if (!CustomizableUI.getPlacementOfWidget("sidebar-button")) {
    CustomizableUI.addWidgetToArea("sidebar-button", CustomizableUI.AREA_NAVBAR, 0);
  }
  const customizing = BrowserTestUtils.waitForEvent(gNavToolbox, "customizationready");
  gCustomizeMode.enter();
  await customizing;
  CustomizableUI.removeWidgetFromArea("sidebar-button");
  const done = BrowserTestUtils.waitForEvent(gNavToolbox, "aftercustomization");
  gCustomizeMode.exit();
  await done;
  await new Promise(resolve => setTimeout(resolve, 100));
  ok(Services.prefs.getBoolPref("sidebar.verticalTabs"), "vertical tabs survive");
  ok(document.documentElement.hasAttribute("aequera-rail"), "the rail survives");
  await assertShellSane("after removing the sidebar button");
  CustomizableUI.reset();
});
