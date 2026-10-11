/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Window fullscreen (F11) keeps the top bar and the tab rail on screen
// (aequera-prefs.js: browser.fullscreen.autohide = false), and the page card
// is clipped only while the chrome is hidden (aequera-shell.css).

const AUTOHIDE = "browser.fullscreen.autohide";
const tabbox = () => document.getElementById("tabbrowser-tabbox");

async function setFullscreen(enter) {
  if (window.fullScreen == enter) {
    return;
  }
  const done = BrowserTestUtils.waitForEvent(window, "fullscreen");
  document.getElementById("View:FullScreen").doCommand();
  await done;
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("inFullscreen") == enter,
    `inFullscreen is ${enter}`
  );
}

/** Visible and laid out with a real size. */
function assertShown(element, label) {
  ok(BrowserTestUtils.isVisible(element), `${label} is visible`);
  const { width, height } = window.windowUtils.getBoundsWithoutFlushing(element);
  ok(width > 0 && height > 0, `${label} has a size (${width}x${height})`);
}

registerCleanupFunction(async () => {
  await setFullscreen(false);
});

add_task(async function test_autohide_is_off_by_default() {
  is(Services.prefs.getDefaultBranch("").getBoolPref(AUTOHIDE), false, "Aequera default keeps chrome up");
});

add_task(async function test_fullscreen_keeps_address_bar_and_rail() {
  await setFullscreen(true);
  // Firefox tries to hide the toolbox on entry and on mouse leave; neither
  // may hide it.
  FullScreen.hideNavToolbox(false);
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

  ok(!FullScreen.navToolboxHidden, "the toolbox is not hidden");
  ok(!document.documentElement.hasAttribute("fullscreenNavToolboxHidden"), "no hidden-toolbox state");
  assertShown(document.getElementById("nav-bar"), "the top bar");
  assertShown(document.getElementById("urlbar"), "the address bar");
  assertShown(document.getElementById("sidebar-container"), "the tab rail");
  // The rail lists tabs as Aequera rows (rail/aequera-tabs.js).
  assertShown(window.AequeraTabs.rows.get(gBrowser.selectedTab), "the selected tab's row in the rail");
  isnot(getComputedStyle(tabbox()).clipPath, "none", "the page stays a card");

  await setFullscreen(false);
  ok(!document.documentElement.hasAttribute("inFullscreen"), "left fullscreen");
});

add_task(async function test_autohide_on_still_hides_and_unclips() {
  await SpecialPowers.pushPrefEnv({ set: [[AUTOHIDE, true]] });
  const hidden = TestUtils.topicObserved("fullscreen-nav-toolbox", (_subject, data) => data == "hidden");
  await setFullscreen(true);
  await SimpleTest.promiseFocus(window);
  await hidden;

  ok(FullScreen.navToolboxHidden, "the user's choice still hides the toolbox");
  is(getComputedStyle(tabbox()).clipPath, "none", "the page is edge to edge while chrome is hidden");

  await setFullscreen(false);
  await SpecialPowers.popPrefEnv();
});
