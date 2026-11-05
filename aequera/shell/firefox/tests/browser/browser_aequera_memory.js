/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera memory saver (memory/aequera-memory.js): inactive tabs are
// discarded so their content processes are released, while the tabs a user
// or page is using stay loaded. Site isolation is not involved.

const PREF = "aequera.memory.unloadInactiveAfterMs";

async function withWindow(task) {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await task(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
}

async function load(tab, url = "data:text/html,<p>page</p>") {
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, url);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () => !tab.linkedBrowser.webProgress?.isLoadingDocument,
    "the page finished loading"
  );
}

async function backgroundTab(win, url = "data:text/html,<p>background</p>") {
  const tab = await BrowserTestUtils.addTab(win.gBrowser, url);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () => !tab.linkedBrowser.webProgress?.isLoadingDocument,
    "the background page finished loading"
  );
  return tab;
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, 0]] });
  registerCleanupFunction(() => SpecialPowers.popPrefEnv());
});

add_task(async function test_inactive_tab_is_discarded_and_restored() {
  await withWindow(async win => {
    const active = win.gBrowser.selectedTab;
    await load(active, "data:text/html,<p>active</p>");
    const inactive = await backgroundTab(win);

    is(
      await win.AequeraMemory.unloadInactiveTabs({ due: false }),
      1,
      "the inactive tab is discarded"
    );
    ok(inactive.hasAttribute("pending"), "it is now a lazy tab");
    ok(!active.hasAttribute("pending"), "the selected tab stays loaded");

    await BrowserTestUtils.switchTab(win.gBrowser, inactive);
    await TestUtils.waitForCondition(
      () => !inactive.hasAttribute("pending"),
      "switching back reloads it"
    );
  });
});

add_task(async function test_protected_tabs_stay_loaded() {
  await withWindow(async win => {
    const active = win.gBrowser.selectedTab;
    await load(active, "data:text/html,<p>active</p>");
    const protectedTabs = [];
    for (const kind of ["undiscardable", "soundplaying", "pictureinpicture"]) {
      const tab = await backgroundTab(win);
      if (kind == "undiscardable") {
        tab.undiscardable = true;
      } else {
        tab.toggleAttribute(kind, true);
      }
      protectedTabs.push([tab, kind]);
    }
    const pinned = await backgroundTab(win);
    win.gBrowser.pinTab(pinned);
    protectedTabs.push([pinned, "pinned"]);
    const hidden = await backgroundTab(win);
    win.gBrowser.hideTab(hidden, "extension@example");
    protectedTabs.push([hidden, "hidden by an extension"]);
    const unprotected = await backgroundTab(win);

    is(
      await win.AequeraMemory.unloadInactiveTabs({
        due: false,
        limit: Infinity,
      }),
      1,
      "only the unprotected tab is discarded"
    );
    ok(unprotected.hasAttribute("pending"), "the unprotected tab is lazy");
    for (const [tab, why] of protectedTabs) {
      ok(!tab.hasAttribute("pending"), `${why} tab stays loaded`);
    }
  });
});

add_task(async function test_due_filter_and_timer() {
  await withWindow(async win => {
    const active = win.gBrowser.selectedTab;
    await load(active, "data:text/html,<p>active</p>");
    const inactive = await backgroundTab(win);

    await SpecialPowers.pushPrefEnv({ set: [[PREF, 60_000]] });
    is(
      await win.AequeraMemory.unloadInactiveTabs({ due: true }),
      0,
      "a tab younger than the delay is not due"
    );
    await SpecialPowers.popPrefEnv();

    // Age the tab past a short delay, then let the pref observer arm a check.
    await new Promise(resolve => setTimeout(resolve, 100));
    await SpecialPowers.pushPrefEnv({ set: [[PREF, 50]] });
    await TestUtils.waitForCondition(
      () => inactive.hasAttribute("pending"),
      "the timer discards the due tab"
    );
    await SpecialPowers.popPrefEnv();

    await BrowserTestUtils.switchTab(win.gBrowser, inactive);
    await TestUtils.waitForCondition(
      () => !inactive.hasAttribute("pending"),
      "and switching back reloads it"
    );
  });
});

add_task(async function test_invalid_delay_falls_back() {
  await withWindow(async win => {
    await SpecialPowers.pushPrefEnv({ set: [[PREF, -1]] });
    is(
      win.AequeraMemory.delay,
      600_000,
      "a negative delay falls back to the 10-minute default"
    );
    await SpecialPowers.popPrefEnv();

    await SpecialPowers.pushPrefEnv({ set: [[PREF, 0]] });
    is(win.AequeraMemory.delay, 0, "0 still disables the timer");
    await SpecialPowers.popPrefEnv();
  });
});
