/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Floating notification bars (aequera/shell/firefox/notifications): the bars
// in #notifications-toolbar float over the page as cards; the top bar and the
// page never move; the cards take clicks, their gutters pass them to the
// page; hovering or focusing them never opens the bookmarks drawer; the cards
// clear the widened rail and the open drawer.

const ROOT = document.documentElement;
const tabbox = () => document.getElementById("tabbrowser-tabbox");
const railBox = () => document.getElementById("sidebar-container").querySelector(":scope > sidebar-main");
const drawer = () => document.getElementById("PersonalToolbar");
const box = el => el.getBoundingClientRect();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Shows a notification (with a button) in `notificationBox`, the selected
 * tab's by default; resolves once it is laid out. Reduced motion (setup)
 * skips Firefox's slide. */
async function showNotification(notificationBox = gBrowser.getNotificationBox()) {
  const notification = await notificationBox.appendNotification(
    "aequera-test",
    { label: "Aequera test notification", priority: notificationBox.PRIORITY_INFO_MEDIUM },
    [{ label: "Do it", callback: () => false }]
  );
  await TestUtils.waitForCondition(() => box(notification).height > 0, "notification laid out");
  return notification;
}

/** Whether the element at (x, y) lies inside `el`. */
function hits(el, x, y) {
  return el.contains(document.elementFromPoint(x, y));
}

/** Rests the pointer low on the page, off the rail, top bar, and cards, so
 * hover holds neither the rail nor the drawer open. */
function restOnPage() {
  const page = box(tabbox());
  EventUtils.synthesizeMouse(tabbox(), page.width - 20, page.height - 20, { type: "mousemove" });
}

async function collapseChrome() {
  gBrowser.selectedBrowser.focus();
  restOnPage();
  await TestUtils.waitForCondition(
    () => !ROOT.hasAttribute("aequera-bookmarks-open") && !ROOT.hasAttribute("aequera-rail-expanded"),
    "drawer closed and rail collapsed"
  );
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["ui.prefersReducedMotion", 1],
      ["aequera.bookmarks.hoverPeek", true],
      ["browser.toolbars.bookmarks.visibility", "always"],
      ["aequera.rail.pinned", false],
      ["aequera.rail.expandOnAddressFocus", true],
      ["aequera.hover.openDelayMs", 40],
      ["aequera.hover.closeDelayMs", 150],
    ],
  });
  window.windowUtils.disableNonTestMouseEvents(true);
  registerCleanupFunction(() => window.windowUtils.disableNonTestMouseEvents(false));
  await collapseChrome();
});

add_task(async function test_floats_without_moving_chrome_or_page() {
  const toolboxBefore = box(gNavToolbox);
  const pageBefore = box(tabbox());
  const browserBefore = box(gBrowser.selectedBrowser);

  const notification = await showNotification();
  const card = box(notification);
  const toolbox = box(gNavToolbox);
  is(toolbox.height, toolboxBefore.height, "the top bar keeps its height");
  Assert.deepEqual(box(tabbox()).toJSON(), pageBefore.toJSON(), "the page card does not move");
  Assert.deepEqual(box(gBrowser.selectedBrowser).toJSON(), browserBefore.toJSON(), "the page does not reflow");
  Assert.greaterOrEqual(card.top, toolbox.bottom, "the card hangs below the top bar");
  Assert.greaterOrEqual(card.left, pageBefore.left, "the card starts on the page, not the rail");
  Assert.lessOrEqual(card.right, pageBefore.right, "the card ends on the page");

  // Over the page, the card takes the pointer; the gutter under it does not.
  const middle = (card.left + card.right) / 2;
  ok(hits(notification, middle, (card.top + card.bottom) / 2), "the card is hit-testable");
  ok(hits(gBrowser.selectedBrowser, middle, card.bottom + 4), "the gutter under the card passes the pointer to the page");

  // Its button works (Firefox's security delay enables it after a moment).
  const button = notification.buttonContainer.querySelector("button");
  await TestUtils.waitForCondition(() => !button.disabled, "button enabled");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(() => !notification.isConnected, "clicking the card's button closes it");
  is(box(gNavToolbox).height, toolboxBefore.height, "the top bar is unchanged after the card closes");
});

add_task(async function test_card_is_not_the_top_bar() {
  // The cards sit in the top bar's subtree, but hovering or focusing them
  // must not open the bookmarks drawer: the open drawer pushes them down,
  // away from the pointer reaching for a button.
  const notification = await showNotification();
  const rest = box(notification);
  const button = notification.buttonContainer.querySelector("button");
  const holdsStill = async what => {
    // Longer than the open delay, so a drawer that would open has opened.
    await wait(200);
    ok(!ROOT.hasAttribute("aequera-bookmarks-open"), `${what} does not open the drawer`);
    Assert.deepEqual(box(notification).toJSON(), rest.toJSON(), `${what} leaves the card in place`);
  };

  EventUtils.synthesizeMouseAtCenter(notification, { type: "mousemove" });
  await holdsStill("the pointer on the card");
  EventUtils.synthesizeMouseAtCenter(button, { type: "mousemove" });
  await holdsStill("the pointer on its button");

  // From the top bar onto the card: the drawer opened by the top bar closes.
  EventUtils.synthesizeMouse(gNavToolbox, 300, 5, { type: "mousemove" });
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-bookmarks-open"), "the top bar opens the drawer");
  EventUtils.synthesizeMouseAtCenter(notification, { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => !ROOT.hasAttribute("aequera-bookmarks-open"),
    "moving onto the card leaves the top bar"
  );
  restOnPage();

  // Keyboard focus on the card's button (as from Tab) is not focus in the
  // top bar either.
  button.focus({ focusVisible: true });
  ok(button.matches(":focus-visible"), "the button has keyboard focus");
  await holdsStill("keyboard focus on its button");
  gBrowser.selectedBrowser.focus();
  gBrowser.getNotificationBox().removeNotification(notification, true);
});

add_task(async function test_raises_top_bar_only_with_a_card() {
  // The top bar stacks above the browser area only while it holds a card
  // (with none, the browser area keeps Firefox's stacking).
  const resting = getComputedStyle(gNavToolbox).zIndex;
  const notification = await showNotification();
  isnot(getComputedStyle(gNavToolbox).zIndex, resting, "a card raises the top bar");
  gBrowser.getNotificationBox().removeNotification(notification, true);
  is(getComputedStyle(gNavToolbox).zIndex, resting, "no card, no raise");
});

add_task(async function test_window_notification_floats() {
  const toolboxBefore = box(gNavToolbox);
  const pageBefore = box(tabbox());
  const notification = await showNotification(gNotificationBox);
  is(box(gNavToolbox).height, toolboxBefore.height, "a window-wide bar leaves the top bar alone");
  Assert.deepEqual(box(tabbox()).toJSON(), pageBefore.toJSON(), "and the page card");
  Assert.greaterOrEqual(box(notification).top, box(gNavToolbox).bottom, "it floats below the top bar");
  gNotificationBox.removeNotification(notification, true);
});

add_task(async function test_clears_widened_rail_and_open_drawer() {
  const notification = await showNotification();
  const rest = box(notification);
  // The address bar opens the drawer and widens the rail at once.
  gURLBar.focus();
  await TestUtils.waitForCondition(
    () => ROOT.hasAttribute("aequera-bookmarks-open") && ROOT.hasAttribute("aequera-rail-expanded"),
    "drawer open and rail widened"
  );
  await TestUtils.waitForCondition(() => {
    const card = box(notification);
    return card.left >= box(railBox()).right && card.top >= box(drawer()).bottom;
  }, "the card clears the widened rail and the open drawer");

  await collapseChrome();
  await TestUtils.waitForCondition(() => {
    const card = box(notification);
    return card.top == rest.top && card.left == rest.left;
  }, "the card returns to where it rested");
  gBrowser.getNotificationBox().removeNotification(notification, true);
});
