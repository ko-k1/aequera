/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera new tab page (aequera/shell/firefox/newtab, patches/browser/newtab):
// served at about:newtab and about:home, still preloaded, shortcuts from
// Firefox's top sites backend, pin / unpin / dismiss by keyboard, and the
// pref restores Firefox's page; New Tab goes to an untouched open page
// instead of loading another (aequera.newtab.single).

ChromeUtils.defineESModuleGetters(this, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  NewTabPagePreloading: "moz-src:///browser/components/tabbrowser/NewTabPagePreloading.sys.mjs",
  NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
});

const PINNED = [
  { url: "https://pinned-a.example.com/", label: "Alpha" },
  { url: "https://pinned-b.example.com/", label: "Beta" },
];
const FRECENT = "https://frecent.example.com/";

const feed = () => AboutNewTab.activityStream.store.feeds.get("feeds.system.topsites");

async function refreshShortcuts() {
  feed().pinnedCache.expire();
  feed().frecentCache.expire();
  await feed().refresh({ broadcast: true });
}

/** Wait until the page lists shortcuts matching `predicate`, then return them. */
async function shortcuts(browser, predicate = rows => rows.length > 0) {
  let rows = [];
  await TestUtils.waitForCondition(async () => {
    rows = await SpecialPowers.spawn(browser, [], () =>
      [...content.document.querySelectorAll("[data-aequera-tile]")].map(li => ({
        label: li.querySelector(".tile-label").textContent,
        href: li.querySelector(".tile-link").href,
        pinned: !!li.querySelector(".tile-pin"),
      }))
    ).catch(() => []);
    return predicate(rows);
  }, "shortcuts rendered as expected");
  return rows;
}

async function openNewTab(url = "about:newtab") {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url, true);
  await shortcuts(tab.linkedBrowser);
  return tab;
}

/** Open the options menu of the shortcut `url` with the keyboard. */
async function openMenuFor(browser, url) {
  await SpecialPowers.spawn(browser, [url], async href => {
    const tile = [...content.document.querySelectorAll("[data-aequera-tile]")].find(
      li => li.querySelector(".tile-link").href == href
    );
    tile.querySelector(".tile-options").focus();
  });
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  return SpecialPowers.spawn(browser, [], async () => {
    const menu = content.document.getElementById("shortcut-menu");
    await ContentTaskUtils.waitForCondition(
      () => menu.matches(":popover-open") && menu.contains(content.document.activeElement),
      "menu open with focus inside"
    );
    return {
      items: [...menu.querySelectorAll("button:not([hidden])")].map(b => b.dataset.action),
      focused: content.document.activeElement.dataset.action,
    };
  });
}

/** Move to menu item `action` with the arrow keys and press Enter. */
async function chooseMenuItem(browser, action) {
  for (let i = 0; i < 3; i++) {
    const focused = await SpecialPowers.spawn(browser, [], () => content.document.activeElement.dataset.action);
    if (focused == action) {
      break;
    }
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  }
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
}

add_setup(async () => {
  // Deterministic loads: each task opens its own page unless it tests
  // preloading itself.
  await SpecialPowers.pushPrefEnv({ set: [["browser.newtab.preload", false]] });
  NewTabPagePreloading.removePreloadedBrowser(window);
  PINNED.forEach((site, index) => NewTabUtils.pinnedLinks.pin(site, index));
  await refreshShortcuts();
  registerCleanupFunction(async () => {
    for (const { url } of [...PINNED, { url: FRECENT }]) {
      NewTabUtils.pinnedLinks.unpin({ url });
      NewTabUtils.blockedLinks.unblock({ url });
    }
    // unblock / unpin leave an empty user value behind: back to defaults.
    Services.prefs.clearUserPref("browser.newtabpage.blocked");
    Services.prefs.clearUserPref("browser.newtabpage.pinned");
    NewTabUtils.blockedLinks.resetCache();
    NewTabUtils.pinnedLinks.resetCache();
    await PlacesUtils.history.clear();
    await refreshShortcuts();
  });
});

add_task(async function test_first_window_startup_can_reach_newtab_init() {
  // BrowserGlue's first-window startup reads app.update.checkInstallTime.days
  // unguarded when the old-build check is on; without it the new tab backend
  // never starts and every about:newtab load hangs. The test profile turns
  // the check off as a user value, so check the shipped defaults.
  const defaults = Services.prefs.getDefaultBranch("");
  is(defaults.getBoolPref("app.update.checkInstallTime"), false, "old-build update check off by default");
  Assert.greater(defaults.getIntPref("app.update.checkInstallTime.days", 0), 0, "its day count is defined");
});

add_task(async function test_aequera_page_served() {
  is(Services.prefs.getDefaultBranch("").getBoolPref("aequera.newtab.enabled"), true, "on by default");
  for (const url of ["about:newtab", "about:home"]) {
    const tab = await openNewTab(url);
    const page = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      await content.document.l10n.ready;
      return {
        uri: content.document.documentURI,
        title: content.document.title,
        scripts: [...content.document.scripts].map(s => s.src),
        builtin: !!content.document.getElementById("root"),
      };
    });
    is(page.uri, url, `${url} keeps its address`);
    is(page.title, "New Tab", "localized title from Firefox's strings");
    ok(!page.builtin, "no built-in page root");
    ok(!page.scripts.some(src => src.includes("activity-stream")), "no built-in bundle loaded");
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_shortcuts_render() {
  const tab = await openNewTab();
  const rows = await shortcuts(tab.linkedBrowser, r => r.length >= PINNED.length);
  for (const [index, site] of PINNED.entries()) {
    is(rows[index].label, site.label, `shortcut ${index} label`);
    is(rows[index].href, site.url, `shortcut ${index} link`);
    ok(rows[index].pinned, `shortcut ${index} shows its pin`);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_brand_and_grid_centered() {
  const tab = await openNewTab();
  const layout = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const { document } = content;
    await document.l10n.ready;
    const brand = document.querySelector(".brand");
    const rect = el => el.getBoundingClientRect();
    const style = el => content.getComputedStyle(el);
    const [mark, wordmark] = [".brand-mark", ".brand-wordmark"].map(sel => document.querySelector(sel));
    const grid = rect(document.getElementById("shortcuts"));
    const top = rect(brand).top;
    return {
      label: brand.getAttribute("aria-label"),
      role: brand.getAttribute("role"),
      images: [style(mark).backgroundImage, style(wordmark).backgroundImage],
      sizes: [rect(mark).width, rect(wordmark).width, rect(wordmark).height],
      brandCenter: rect(brand).left + rect(brand).width / 2,
      gridCenter: grid.left + grid.width / 2,
      viewport: [content.innerWidth, content.innerHeight],
      blockCenter: (top + grid.bottom) / 2,
    };
  });
  is(layout.role, "img", "the brand is one image to assistive technology");
  is(layout.label, "Aequera", "named by the branding's full name");
  ok(layout.images[0].includes("chrome://branding/content/about-logo.svg"), "the branding's mark");
  ok(layout.images[1].includes("chrome://branding/content/firefox-wordmark.svg"), "the branding's wordmark");
  Assert.deepEqual(layout.sizes, [48, 104, 32], "fixed boxes, no shift while decoding");
  const [width, height] = layout.viewport;
  Assert.less(Math.abs(layout.brandCenter - width / 2), 1, "brand centered horizontally");
  Assert.less(Math.abs(layout.gridCenter - width / 2), 1, "grid centered horizontally");
  // A little above the true center (the bottom padding is larger).
  Assert.greater(layout.blockCenter, height * 0.35, "block in the middle of the page, not under the bar");
  Assert.lessOrEqual(layout.blockCenter, height / 2, "never below the center");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_empty_profile_says_so() {
  PINNED.forEach(site => NewTabUtils.pinnedLinks.unpin(site));
  await refreshShortcuts();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const empty = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const message = content.document.getElementById("shortcuts-empty");
    await ContentTaskUtils.waitForCondition(() => !message.hidden, "empty state shown");
    return {
      text: message.textContent,
      tiles: content.document.querySelectorAll("[data-aequera-tile]").length,
    };
  });
  is(empty.tiles, 0, "no shortcuts");
  ok(empty.text.length > 0, "a fresh profile gets a message instead of a blank page");
  BrowserTestUtils.removeTab(tab);
  PINNED.forEach((site, index) => NewTabUtils.pinnedLinks.pin(site, index));
  await refreshShortcuts();
});

add_task(async function test_preloaded_and_address_bar_focused() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.newtab.preload", true]] });
  NewTabPagePreloading.maybeCreatePreloadedBrowser(window);
  const preloaded = gBrowser.preloadedBrowser;
  ok(preloaded, "a new tab page is preloaded");
  await shortcuts(preloaded);
  BrowserCommands.openTab();
  is(gBrowser.selectedBrowser, preloaded, "the new tab uses the preloaded page");
  await TestUtils.waitForCondition(() => gURLBar.focused, "the address bar is focused");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
  NewTabPagePreloading.removePreloadedBrowser(window);
  await SpecialPowers.popPrefEnv();
});

/** New Tab (BrowserCommands.openTab) that must open, and load, a new page. */
async function openTabCommand(options) {
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:newtab", true);
  BrowserCommands.openTab(options);
  const tab = await opened;
  await shortcuts(tab.linkedBrowser);
  return tab;
}

add_task(async function test_new_tab_goes_to_the_open_page() {
  is(Services.prefs.getDefaultBranch("").getBoolPref("aequera.newtab.single"), true, "on by default");
  const first = await openTabCommand();
  // A mark on the rendered page: gone if the page loads again.
  await SpecialPowers.spawn(first.linkedBrowser, [], () => {
    content.wrappedJSObject.aequeraRendered = true;
  });
  const isSamePage = () =>
    SpecialPowers.spawn(first.linkedBrowser, [], () => content.wrappedJSObject.aequeraRendered === true);
  const count = gBrowser.tabs.length;

  // From another tab: back to the open page, rendered once.
  gBrowser.selectedTab = gBrowser.tabs[0];
  BrowserCommands.openTab();
  is(gBrowser.selectedTab, first, "New Tab goes to the untouched new tab page");
  is(gBrowser.tabs.length, count, "and opens no tab");
  ok(await isSamePage(), "the page is not loaded again");
  await TestUtils.waitForCondition(() => gURLBar.focused, "the address bar is focused, as for a new tab");

  // From the page itself (Ctrl+T on it): it stays.
  EventUtils.synthesizeKey("t", { accelKey: true });
  is(gBrowser.selectedTab, first, "Ctrl+T on the page stays on it");
  is(gBrowser.tabs.length, count, "no tab opened");

  // Anything else opens as in Firefox: an explicit address.
  const withURL = await openTabCommand({ url: "about:newtab" });
  isnot(withURL, first, "an explicit address opens a tab");
  BrowserTestUtils.removeTab(withURL);

  BrowserTestUtils.removeTab(first);
});

add_task(async function test_used_page_is_not_reused() {
  const typed = await openTabCommand();
  // Something typed in the address bar for it: it is in use.
  typed.linkedBrowser.userTypedValue = "exam";
  gBrowser.selectedTab = gBrowser.tabs[0];
  const second = await openTabCommand();
  isnot(second, typed, "a page with typed text is left alone");
  BrowserTestUtils.removeTab(typed);

  // Navigated away and back: it has history behind it.
  const loaded = BrowserTestUtils.browserLoaded(second.linkedBrowser);
  BrowserTestUtils.startLoadingURIString(second.linkedBrowser, "data:text/html,away");
  await loaded;
  const back = BrowserTestUtils.waitForLocationChange(gBrowser, "about:newtab");
  second.linkedBrowser.goBack();
  await back;
  const third = await openTabCommand();
  isnot(third, second, "a page with history is left alone");
  BrowserTestUtils.removeTab(second);
  BrowserTestUtils.removeTab(third);
});

add_task(async function test_single_off_opens_every_time() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.newtab.single", false]] });
  const first = await openTabCommand();
  gBrowser.selectedTab = gBrowser.tabs[0];
  const second = await openTabCommand();
  isnot(second, first, "off: New Tab opens a tab, as in Firefox");
  BrowserTestUtils.removeTab(first);
  BrowserTestUtils.removeTab(second);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_unpin_and_pin_by_keyboard() {
  for (let i = 0; i < 5; i++) {
    await PlacesTestUtils.addVisits({ uri: FRECENT, transition: PlacesUtils.history.TRANSITIONS.TYPED });
  }
  await PlacesTestUtils.promiseAsyncUpdates();
  await refreshShortcuts();
  const tab = await openNewTab();
  const browser = tab.linkedBrowser;
  await shortcuts(browser, r => r.some(s => s.href == FRECENT));

  const menu = await openMenuFor(browser, FRECENT);
  Assert.deepEqual(menu.items, ["pin", "dismiss"], "an unpinned shortcut offers Pin and Dismiss");
  is(menu.focused, "pin", "the first item takes focus");
  await chooseMenuItem(browser, "pin");
  await shortcuts(browser, r => r.find(s => s.href == FRECENT)?.pinned);
  ok(
    NewTabUtils.pinnedLinks.links.some(l => l?.url == FRECENT),
    "pinned in Firefox's storage"
  );

  const again = await openMenuFor(browser, FRECENT);
  Assert.deepEqual(again.items, ["unpin", "dismiss"], "a pinned shortcut offers Unpin");
  await chooseMenuItem(browser, "unpin");
  await shortcuts(browser, r => r.some(s => s.href == FRECENT && !s.pinned));
  ok(!NewTabUtils.pinnedLinks.links.some(l => l?.url == FRECENT), "unpinned in storage");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_escape_returns_focus() {
  const tab = await openNewTab();
  const browser = tab.linkedBrowser;
  await openMenuFor(browser, PINNED[0].url);
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  const after = await SpecialPowers.spawn(browser, [], async () => {
    const { document } = content;
    await ContentTaskUtils.waitForCondition(
      () => !document.getElementById("shortcut-menu").matches(":popover-open"),
      "menu closed"
    );
    const button = document.activeElement;
    return {
      onOptions: button.classList.contains("tile-options"),
      expanded: button.getAttribute("aria-expanded"),
      label: button.getAttribute("aria-label"),
    };
  });
  ok(after.onOptions, "focus is back on the options button");
  is(after.expanded, "false", "and it is collapsed");
  is(after.label, `Open context menu for ${PINNED[0].label}`, "options button is labeled");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_options_button_toggles_and_tab_leaves() {
  const tab = await openNewTab();
  const browser = tab.linkedBrowser;
  const button = '[data-index="0"] .tile-options';
  const isOpen = () =>
    SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("shortcut-menu").matches(":popover-open")
    );

  await BrowserTestUtils.synthesizeMouseAtCenter(button, {}, browser);
  await TestUtils.waitForCondition(isOpen, "a click opens the menu");
  const edges = await SpecialPowers.spawn(browser, [button], sel => {
    const b = content.document.querySelector(sel).getBoundingClientRect();
    const m = content.document.getElementById("shortcut-menu").getBoundingClientRect();
    return { buttonRight: b.right, buttonBottom: b.bottom, menuRight: m.right, menuTop: m.top };
  });
  Assert.less(Math.abs(edges.menuRight - edges.buttonRight), 1.5, "menu end edge meets its button's");
  Assert.greater(edges.menuTop, edges.buttonBottom, "menu opens below its button");
  await BrowserTestUtils.synthesizeMouseAtCenter(button, {}, browser);
  await TestUtils.waitForCondition(async () => !(await isOpen()), "a second click closes it");
  await new Promise(r => setTimeout(r, 100));
  ok(!(await isOpen()), "and it stays closed");

  await openMenuFor(browser, PINNED[0].url);
  await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
  await TestUtils.waitForCondition(async () => !(await isOpen()), "Tab closes the menu");
  const focus = await SpecialPowers.spawn(browser, [], () => content.document.activeElement.className);
  is(focus, "tile-options", "Tab leaves the menu onto its button");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_dismiss_removes_the_shortcut() {
  const target = PINNED[1];
  const tab = await openNewTab();
  const browser = tab.linkedBrowser;
  await openMenuFor(browser, target.url);
  await chooseMenuItem(browser, "dismiss");
  await shortcuts(browser, r => !r.some(s => s.href == target.url));
  ok(NewTabUtils.blockedLinks.isBlocked({ url: target.url }), "dismissed in Firefox's storage");
  BrowserTestUtils.removeTab(tab);
  NewTabUtils.blockedLinks.unblock({ url: target.url });
  NewTabUtils.pinnedLinks.pin(target, 1);
  await refreshShortcuts();
});

add_task(async function test_pref_off_restores_firefox_page() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.newtab.enabled", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const builtin = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.getElementById("root"), "built-in page").then(
      () => !content.document.getElementById("shortcuts")
    )
  );
  ok(builtin, "Firefox's page is back with the pref off");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
