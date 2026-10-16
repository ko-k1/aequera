/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Rail side: Settings > Browser layout > Vertical tabs side
// (patches/browser/rail-position) writes sidebar.position_start (and
// "Magnify tab icons", patches/browser/rail-magnify, sits with it); Firefox
// orders the rail after the page, and the Aequera rail mirrors its own
// geometry (:root[aequera-rail-end]): it widens toward the page from the
// right edge, the page clip and its rounded corner follow, and icons stay
// on the collapsed rail's column at the outer edge.

const ROOT = document.documentElement;
const container = () => document.getElementById("sidebar-container");
const railBox = () => container().querySelector(":scope > sidebar-main");
const tabbox = () => document.getElementById("tabbrowser-tabbox");
const iconOf = tab =>
  window.AequeraTabs.rows.get(tab).querySelector(".aequera-tab-icon").getBoundingClientRect();
const isFullyCollapsed = () =>
  !ROOT.hasAttribute("aequera-rail-expanded") && !gBrowser.tabContainer.hasAttribute("expanded");

/**
 * Choose a moz-radio option the way Firefox's own preferences tests do: a
 * click on its input (coordinate clicks land off it), looked up afresh
 * because the group re-renders when its pref changes.
 */
function chooseRadio(group, id) {
  const radio = group.querySelector(`#${id}`);
  ok(radio?.inputEl, `${id} option exists`);
  radio.inputEl.click();
}

function pageClip() {
  const clip = getComputedStyle(tabbox()).clipPath;
  const match = /^inset\(\s*([-\d.]+)px(?:\s+([-\d.]+)px)?(?:\s+([-\d.]+)px)?(?:\s+([-\d.]+)px)?/.exec(clip);
  if (!match) {
    return { right: 0, left: 0 };
  }
  // inset(top [right [bottom [left]]]) with CSS shorthand defaults.
  const [top, right = top, , left = right] = match.slice(1).map(v => (v === undefined ? undefined : parseFloat(v)));
  return { right, left };
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
  // Turning vertical tabs off and on saves the horizontal tab strip layout.
  const tabstripPref = "browser.uiCustomization.horizontalTabstrip";
  const savedTabstrip = Services.prefs.prefHasUserValue(tabstripPref)
    ? Services.prefs.getStringPref(tabstripPref)
    : null;
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("sidebar.position_start");
    Services.prefs.clearUserPref("aequera.rail.magnify");
    if (savedTabstrip === null) {
      Services.prefs.clearUserPref(tabstripPref);
    } else {
      Services.prefs.setStringPref(tabstripPref, savedTabstrip);
    }
  });
});

add_task(async function test_settings_offers_the_side() {
  // Settings > Tabs and browsing (the redesigned settings; the General pane
  // keeps a hidden copy of the group).
  const tab = BrowserTestUtils.addTab(gBrowser, "about:preferences#tabsBrowsing");
  registerCleanupFunction(() => {
    if (tab.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const initialized = BrowserTestUtils.waitForEvent(tab.linkedBrowser, "Initialized", true);
  gBrowser.selectedTab = tab;
  await initialized;
  {
    const doc = tab.linkedBrowser.contentDocument;
    const group = await TestUtils.waitForCondition(
      () =>
        [...doc.querySelectorAll('setting-group[groupid="browserLayout"]')].find(
          g => g.getBoundingClientRect().height > 0
        ),
      "the visible Browser layout group"
    );
    const side = await TestUtils.waitForCondition(
      () => group.querySelector("#browserLayoutTabsSide"),
      "the vertical tabs side control"
    );
    // The setting's wrapper (as Firefox's own preferences tests find it).
    const control = side.closest("setting-control");
    await control.updateComplete;
    ok(!control.hidden, "offered while vertical tabs are on (Aequera rail)");
    is(side.value, "left", "left by default");

    chooseRadio(group, "browserLayoutTabsSideRight");
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("sidebar.position_start", true),
      "choosing Right writes sidebar.position_start = false"
    );
    await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail-end"), "the rail mirrors");

    chooseRadio(group, "browserLayoutTabsSideLeft");
    await TestUtils.waitForCondition(
      () => Services.prefs.getBoolPref("sidebar.position_start", false),
      "choosing Left restores it"
    );
    ok(!ROOT.hasAttribute("aequera-rail-end"), "and the rail goes back");

    // patches/browser/rail-magnify: the icon magnification switch sits with it.
    const magnifyControl = group.querySelector("#setting-control-browserLayoutTabsMagnify");
    ok(magnifyControl && !magnifyControl.hidden, "Magnify tab icons is offered too");
    const checkbox = magnifyControl.controlEl;
    ok(checkbox?.inputEl, "as a checkbox");
    is(checkbox.checked, false, "off by default");
    checkbox.inputEl.click();
    await TestUtils.waitForCondition(
      () => Services.prefs.getBoolPref("aequera.rail.magnify", false),
      "checking it writes aequera.rail.magnify"
    );
    await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail-magnify"), "and arms the rail");
    magnifyControl.controlEl.inputEl.click();
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("aequera.rail.magnify", true),
      "unchecking turns it off"
    );

    await SpecialPowers.pushPrefEnv({ set: [["sidebar.verticalTabs", false]] });
    await TestUtils.waitForCondition(() => control.hidden, "hidden with horizontal tabs");
    ok(magnifyControl.hidden, "both of them");
    await SpecialPowers.popPrefEnv();
    await TestUtils.waitForCondition(() => !control.hidden, "back with vertical tabs");
  }
  BrowserTestUtils.removeTab(tab);
});

// patches/browser/static-layout: one switch for the static layout, the rail
// pinned open (aequera.rail.pinned) and the bookmarks toolbar shown
// (aequera.bookmarks.hoverPeek off), with either tab orientation.
add_task(async function test_settings_offers_static_layout() {
  registerCleanupFunction(() => Services.prefs.clearUserPref("aequera.bookmarks.hoverPeek"));
  // The drawer works on top of Firefox's "Always" visibility (Aequera's
  // default; the test profile's differs), as browser_aequera_bookmarks_drawer.js.
  await SpecialPowers.pushPrefEnv({ set: [["browser.toolbars.bookmarks.visibility", "always"]] });
  const pinned = () => Services.prefs.getBoolPref("aequera.rail.pinned", false);
  const peek = () => Services.prefs.getBoolPref("aequera.bookmarks.hoverPeek", false);
  const tab = BrowserTestUtils.addTab(gBrowser, "about:preferences#tabsBrowsing");
  const initialized = BrowserTestUtils.waitForEvent(tab.linkedBrowser, "Initialized", true);
  gBrowser.selectedTab = tab;
  await initialized;
  const doc = tab.linkedBrowser.contentDocument;
  const group = await TestUtils.waitForCondition(
    () =>
      [...doc.querySelectorAll('setting-group[groupid="browserLayout"]')].find(
        g => g.getBoundingClientRect().height > 0
      ),
    "the visible Browser layout group"
  );
  const control = await TestUtils.waitForCondition(
    () => group.querySelector("#setting-control-browserLayoutStatic"),
    "the static layout control"
  );
  await control.updateComplete;
  ok(!control.hidden, "offered with the Aequera shell");
  const checkbox = () => control.controlEl;
  ok(checkbox()?.inputEl, "as a checkbox");
  is(checkbox().checked, false, "dynamic by default");
  ok(ROOT.hasAttribute("aequera-bookmarks-peek"), "the bookmarks toolbar is a hover drawer by default");

  checkbox().inputEl.click();
  await TestUtils.waitForCondition(() => pinned() && !peek(), "checking it pins the rail and ends the drawer");
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail-pinned"), "the rail stays open");
  await TestUtils.waitForCondition(
    () => !ROOT.hasAttribute("aequera-bookmarks-peek"),
    "the bookmarks toolbar stays shown"
  );

  // Either pref changed elsewhere (about:config) shows here.
  Services.prefs.setBoolPref("aequera.bookmarks.hoverPeek", true);
  await TestUtils.waitForCondition(() => !checkbox().checked, "a hover drawer again: not static");
  Services.prefs.setBoolPref("aequera.bookmarks.hoverPeek", false);
  await TestUtils.waitForCondition(() => checkbox().checked, "both static again: checked");

  checkbox().inputEl.click();
  await TestUtils.waitForCondition(() => !pinned() && peek(), "unchecking restores the dynamic layout");
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-rail-pinned"), "the rail widens on hover again");

  await SpecialPowers.pushPrefEnv({ set: [["sidebar.verticalTabs", false]] });
  await control.updateComplete;
  ok(!control.hidden, "still offered with horizontal tabs (the bookmarks half applies)");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_rail_on_the_right() {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  registerCleanupFunction(() => {
    if (tab.isConnected) {
      gBrowser.removeTab(tab);
    }
  });
  Services.prefs.setBoolPref("sidebar.position_start", false);
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail-end"), "rail at the end");
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeMouseAtCenter(tabbox(), { type: "mousemove" });
  await TestUtils.waitForCondition(isFullyCollapsed, "collapsed");

  const rail = railBox().getBoundingClientRect();
  const page = tabbox().getBoundingClientRect();
  Assert.lessOrEqual(Math.abs(rail.right - window.innerWidth), 1, "the rail sits on the right edge");
  Assert.lessOrEqual(page.right, rail.left + 1, "the page on its left");
  const collapsedIcon = iconOf(tab);
  Assert.less(
    Math.abs(collapsedIcon.left + collapsedIcon.width / 2 - (rail.left + rail.width / 2)),
    1,
    "icons on the collapsed rail's center line"
  );

  // Hover-widened: it overlays the page from the right.
  EventUtils.synthesizeMouse(container(), 5, 120, { type: "mousemove" });
  const expandedWidth = Services.prefs.getIntPref("aequera.rail.expandedWidth", 220);
  await TestUtils.waitForCondition(
    () => Math.abs(railBox().getBoundingClientRect().width - expandedWidth) < 1,
    "widened"
  );
  const wide = railBox().getBoundingClientRect();
  Assert.lessOrEqual(Math.abs(wide.right - window.innerWidth), 1, "it widens from the right edge");
  Assert.less(Math.abs(wide.left - (window.innerWidth - expandedWidth)), 1, "toward the page");
  const clip = pageClip();
  Assert.less(Math.abs(clip.right - (expandedWidth - rail.width)), 1, "the page clips back on its right");
  is(clip.left, 0, "and not on its left");
  const wideIcon = iconOf(tab);
  Assert.less(Math.abs(wideIcon.left - collapsedIcon.left), 1, "icons never move");
  const title = window.AequeraTabs.rows.get(tab).querySelector(".aequera-tab-title").getBoundingClientRect();
  Assert.lessOrEqual(title.right, wideIcon.left, "titles read out from the icon toward the page");

  EventUtils.synthesizeMouseAtCenter(tabbox(), { type: "mousemove" });
  await TestUtils.waitForCondition(isFullyCollapsed, "collapsed again");

  Services.prefs.setBoolPref("sidebar.position_start", true);
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-rail-end"), "back to the left");
  Assert.lessOrEqual(Math.abs(railBox().getBoundingClientRect().left), 1, "the rail is on the left edge again");
  await TestUtils.waitForCondition(() => pageClip().right == 0, "no right clip on the left side");
});
