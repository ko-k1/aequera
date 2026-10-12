/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Window fullscreen (F11) keeps the top bar and the tab rail on screen
// (aequera-prefs.js: browser.fullscreen.autohide = false), and the page card
// is clipped only while the chrome is hidden (aequera-shell.css). On Wayland
// popups opened from that top bar must open whole (aequera-fullscreen.js).

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

// Wayland: chrome popups slide instead of being trimmed while fullscreen
// (fullscreen/aequera-fullscreen.js). Headless reports no window protocol,
// so the tests set the module's cached answer.
function addPanel(flip) {
  const panel = document.createXULElement("panel");
  panel.setAttribute("type", "arrow");
  if (flip) {
    panel.setAttribute("flip", flip);
  }
  document.getElementById("mainPopupSet").appendChild(panel);
  return panel;
}

add_task(async function test_wayland_fullscreen_popups_slide() {
  const fs = window.AequeraFullscreen;
  fs._wayland = true;
  const before = addPanel(); // panel.js defaults an arrow panel to flip="both"
  const optOut = addPanel("none");
  is(before.getAttribute("flip"), "both", "arrow panels default to flip=both");

  await setFullscreen(true);
  is(before.getAttribute("flip"), "slide", "an existing popup slides while fullscreen");
  is(optOut.getAttribute("flip"), "none", "a popup that opts out of constraining is left alone");
  const later = addPanel();
  await TestUtils.waitForCondition(
    () => later.getAttribute("flip") == "slide",
    "a popup added while fullscreen slides too"
  );

  await setFullscreen(false);
  is(before.getAttribute("flip"), "both", "leaving fullscreen restores the original flip");
  is(later.getAttribute("flip"), "both", "also for popups added meanwhile");
  ok(!document.querySelector("[aequera-fullscreen-flip]"), "no marks are left behind");

  for (const panel of [before, optOut, later]) {
    panel.remove();
  }
  fs._wayland = null;
});

add_task(async function test_other_protocols_leave_popups_alone() {
  const fs = window.AequeraFullscreen;
  fs._wayland = false;
  const panel = addPanel();
  await setFullscreen(true);
  is(panel.getAttribute("flip"), "both", "layout-placed popups (X11, Windows, macOS) keep their flip");
  await setFullscreen(false);
  panel.remove();
  fs._wayland = null;
});
