/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera bookmarks drawer (aequera/shell/firefox/bookmarks): hover-intent
// open/close on the rail's timing, address-bar hold, keyboard-only focus
// hold, overlay without page reflow, page yields its top edge.

const ROOT = document.documentElement;
const toolbar = () => document.getElementById("PersonalToolbar");
const tabbox = () => document.getElementById("tabbrowser-tabbox");
const isOpen = () => ROOT.hasAttribute("aequera-bookmarks-open");
const pageTop = () => parseFloat(tabbox().style.getPropertyValue("--aequera-page-top")) || 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function hoverTopBar() {
  EventUtils.synthesizeMouse(gNavToolbox, 300, 5, { type: "mousemove" });
}

function leaveTopBar() {
  EventUtils.synthesizeMouseAtCenter(tabbox(), { type: "mousemove" });
}

/** Move to where the open drawer is (whether or not its wipe has revealed
 * that part yet): `fraction` of the way down, centered across it. */
function moveOntoDrawer(fraction) {
  const bar = gNavToolbox.getBoundingClientRect();
  const drawer = toolbar().getBoundingClientRect();
  EventUtils.synthesizeMouse(
    gNavToolbox,
    (drawer.left + drawer.right) / 2 - bar.left,
    bar.height + drawer.height * fraction,
    { type: "mousemove" }
  );
}

async function closeDrawer() {
  if (gURLBar.focused) {
    gBrowser.selectedBrowser.focus();
  }
  leaveTopBar();
  await TestUtils.waitForCondition(() => !isOpen(), "drawer closes");
  // The attribute clears synchronously, but the close wipe keeps the drawer
  // painted briefly: visibility flips to hidden only after the motion
  // duration (aequera-bookmarks.css). Tasks assert the painted state, so wait
  // for it wherever hiding applies (peek mode, toolbar built).
  if (ROOT.hasAttribute("aequera-bookmarks-peek") && !toolbar().hasAttribute("collapsed")) {
    await TestUtils.waitForCondition(
      () => getComputedStyle(toolbar()).visibility == "hidden",
      "drawer hides after the close wipe"
    );
  }
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.bookmarks.hoverPeek", true],
      ["browser.toolbars.bookmarks.visibility", "always"],
      ["aequera.hover.openDelayMs", 40],
      ["aequera.hover.closeDelayMs", 150],
      ["aequera.motion.durationMs", 100],
    ],
  });
  window.windowUtils.disableNonTestMouseEvents(true);
  await TestUtils.waitForCondition(
    () => ROOT.hasAttribute("aequera-bookmarks-peek") && !toolbar().hasAttribute("collapsed"),
    "peek mode active with the toolbar built"
  );
  await closeDrawer();
  registerCleanupFunction(async () => {
    window.windowUtils.disableNonTestMouseEvents(false);
    await closeDrawer();
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_hover_opens_drawer_without_shifting_the_page() {
  is(getComputedStyle(toolbar()).position, "absolute", "the drawer is out of the page flow");
  is(getComputedStyle(toolbar()).visibility, "hidden", "closed: not visible or focusable");
  const topBefore = tabbox().getBoundingClientRect().top;

  hoverTopBar();
  await TestUtils.waitForCondition(isOpen, "hovering the top bar opens the drawer");
  is(getComputedStyle(toolbar()).visibility, "visible", "open: visible");
  is(tabbox().getBoundingClientRect().top, topBefore, "the page did not move or reflow");
  const height = toolbar().getBoundingClientRect().height;
  Assert.greater(height, 0, "drawer has height");
  is(pageTop(), height, "the page card yields exactly the drawer height");

  await closeDrawer();
  is(pageTop(), 0, "closed: the page card is whole again");
});

add_task(async function test_leaving_lingers_then_closes() {
  hoverTopBar();
  await TestUtils.waitForCondition(isOpen, "open");
  const leftAt = performance.now();
  leaveTopBar();
  await wait(60);
  ok(isOpen(), "still open during the linger");
  await TestUtils.waitForCondition(() => !isOpen(), "closes after the linger");
  Assert.greaterOrEqual(performance.now() - leftAt, 130, "waited for the close delay");
});

add_task(async function test_pointer_on_the_open_drawer_keeps_it_open() {
  hoverTopBar();
  await TestUtils.waitForCondition(isOpen, "open");
  await wait(200); // past the 100ms wipe
  moveOntoDrawer(0.5);
  await wait(450); // three close delays
  ok(isOpen(), "the pointer resting on the drawer keeps it open");
  await closeDrawer();
});

add_task(async function test_pointer_on_the_drawer_while_it_opens_keeps_it_open() {
  // Straight down onto a bookmark while the drawer is still wiping in: the
  // part not revealed yet is already the drawer, not the page (animation
  // must not block interaction).
  hoverTopBar();
  await TestUtils.waitForCondition(isOpen, "opening");
  moveOntoDrawer(0.8);
  await wait(450);
  ok(isOpen(), "the pointer on the drawer's area during the wipe keeps it open");
  leaveTopBar();
  await TestUtils.waitForCondition(() => !isOpen(), "leaving the drawer for the page closes it");
});

add_task(async function test_menu_opened_from_the_drawer_holds_it_open() {
  const bookmark = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
    url: "https://example.com/aequera-drawer",
    title: "Aequera drawer test",
  });
  registerCleanupFunction(() => PlacesUtils.bookmarks.remove(bookmark));
  hoverTopBar();
  await TestUtils.waitForCondition(isOpen, "open");
  const item = await TestUtils.waitForCondition(
    () => [...toolbar().querySelectorAll(".bookmark-item")].find(b => b.label == bookmark.title),
    "the bookmark is on the drawer"
  );
  await wait(200);
  const menu = document.getElementById("placesContext");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(item, { type: "contextmenu", button: 2 });
  await shown;
  leaveTopBar(); // e.g. on the way to the menu, or past it
  await wait(450);
  ok(isOpen(), "the drawer stays while its bookmark's context menu is open");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  await TestUtils.waitForCondition(() => !isOpen(), "closing the menu lets it close");
});

add_task(async function test_a_top_bar_panel_never_opens_a_closed_drawer() {
  await closeDrawer();
  // As a keyboard shortcut would: the app menu, anchored in the top bar.
  const shown = BrowserTestUtils.waitForEvent(PanelUI.panel, "popupshown");
  PanelUI.show();
  await shown;
  await wait(200);
  ok(!isOpen(), "the drawer stays closed");
  const hidden = BrowserTestUtils.waitForEvent(PanelUI.panel, "popuphidden");
  PanelUI.hide();
  await hidden;
});

add_task(async function test_address_bar_focus_opens_now_and_holds() {
  leaveTopBar();
  gURLBar.focus();
  ok(isOpen(), "focusing the address bar opens the drawer immediately");
  await wait(400);
  ok(isOpen(), "stays open while the address bar is focused, pointer elsewhere");
  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(() => !isOpen(), "closes once the address bar blurs");
});

add_task(async function test_mouse_clicked_button_does_not_hold_it_open() {
  // A focusable control in the top bar, clicked with the mouse: it keeps
  // focus, but pointer focus is not :focus-visible and must not hold.
  const button = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
  button.textContent = "test";
  document.getElementById("nav-bar").append(button);
  hoverTopBar();
  await TestUtils.waitForCondition(isOpen, "open");
  EventUtils.synthesizeMouseAtCenter(button, {});
  is(document.activeElement, button, "the clicked button has focus");
  leaveTopBar();
  await TestUtils.waitForCondition(() => !isOpen(), "closes although the button kept focus");
  button.remove();
});

add_task(async function test_hover_peek_off_is_plain_always() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.bookmarks.hoverPeek", false]] });
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-bookmarks-peek"), "peek off");
  isnot(getComputedStyle(toolbar()).position, "absolute", "toolbar back in the flow");
  is(getComputedStyle(toolbar()).visibility, "visible", "always visible");
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-bookmarks-peek"), "peek back on");
});

add_task(async function test_never_stays_hidden_on_hover() {
  // The toolbar context menu's "Never" path (persists the pref too).
  setToolbarVisibility(toolbar(), "never");
  ok(toolbar().hasAttribute("collapsed"), "toolbar collapsed");
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("aequera-bookmarks-peek"), "peek off");
  hoverTopBar();
  await wait(200);
  ok(!isOpen(), "Firefox's own Never is respected: hover does not open it");
  leaveTopBar();
  setToolbarVisibility(toolbar(), "always");
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-bookmarks-peek"), "peek back on");
});

add_task(async function test_widened_rail_and_open_drawer_do_not_overlap() {
  // Focusing the address bar opens both at once: the rail widens (unified
  // search) and the drawer opens. They must meet edge to edge, never paint
  // over each other.
  await SpecialPowers.pushPrefEnv({ set: [["aequera.rail.expandOnAddressFocus", true]] });
  leaveTopBar();
  gURLBar.focus();
  await TestUtils.waitForCondition(
    () => isOpen() && ROOT.hasAttribute("aequera-rail-expanded"),
    "rail widened and drawer open"
  );
  const railBox = document.querySelector("#sidebar-container > sidebar-main");
  await TestUtils.waitForCondition(() => {
    const rail = railBox.getBoundingClientRect();
    const drawer = toolbar().getBoundingClientRect();
    return Math.abs(drawer.left - rail.right) < 1;
  }, "the drawer starts exactly where the widened rail ends");
  const rail = railBox.getBoundingClientRect();
  const drawer = toolbar().getBoundingClientRect();
  const overlapWidth = Math.min(rail.right, drawer.right) - Math.max(rail.left, drawer.left);
  const overlapHeight = Math.min(rail.bottom, drawer.bottom) - Math.max(rail.top, drawer.top);
  ok(
    overlapWidth <= 0.5 || overlapHeight <= 0.5,
    `no crossing region (overlap ${overlapWidth.toFixed(1)} x ${overlapHeight.toFixed(1)})`
  );

  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(
    () => !isOpen() && !ROOT.hasAttribute("aequera-rail-expanded"),
    "both close after blur"
  );
  await SpecialPowers.popPrefEnv();
});
