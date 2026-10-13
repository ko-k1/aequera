/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera workspaces in a real browser window: controller + dock
// (aequera/shell/firefox/workspaces). Model logic has node unit tests.

const WINDOW_KEY = "aequera-workspaces";
const TAB_KEY = "aequera-workspace";
const SOURCE = "aequera-workspaces";

const ws = () => window.AequeraWorkspaces;
const memberOf = tab => SessionStore.getCustomTabValue(tab, TAB_KEY);
const dockButtons = () => [...document.querySelectorAll("#aequera-workspace-dock button[data-ws]")];

// Membership is assigned synchronously on TabOpen, so no load wait is needed
// (a new tab's initial about:blank never fires a load to wait for).
async function openTab(url = "about:blank") {
  return BrowserTestUtils.addTab(gBrowser, url);
}

/** Back to one workspace holding every tab, all visible. */
async function resetWorkspaces() {
  // Show everything and select the first tab before removing the rest, so
  // no removal is ever a "last visible tab" close. Removal is synchronous:
  // an un-awaited async close leaves tabs that leak into the next task.
  for (const tab of gBrowser.tabs) {
    gBrowser.showTab(tab);
  }
  gBrowser.selectedTab = gBrowser.tabs[0];
  for (const tab of gBrowser.tabs.slice(1)) {
    gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
  }
  const first = gBrowser.tabs[0];
  if (first.pinned) {
    gBrowser.unpinTab(first);
  }
  gBrowser.showTab(first);
  SessionStore.deleteCustomWindowValue(window, WINDOW_KEY);
  SessionStore.deleteCustomTabValue(first, TAB_KEY);
  ws().reload();
  ws().render();
}

add_setup(async () => {
  await ws().ready;
  ok(document.getElementById("aequera-workspace-dock"), "dock is mounted");
  await resetWorkspaces();
  registerCleanupFunction(resetWorkspaces);
});

add_task(async function test_new_tabs_join_the_active_workspace() {
  const tab = await openTab();
  is(memberOf(tab), ws().state.active, "new tab belongs to the active workspace");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_switch_hides_other_tabs_and_restores_selection() {
  const home = ws().state.active;
  const homeTab = gBrowser.selectedTab;

  ws().newWorkspace();
  const work = ws().state.active;
  isnot(work, home, "new workspace is active");
  const workTab = gBrowser.selectedTab;
  is(memberOf(workTab), work, "switching to an empty workspace opened a tab in it");
  ok(homeTab.hidden, "the previous workspace's tab is hidden");
  is(SessionStore.getCustomTabValue(homeTab, "hiddenBy"), SOURCE, "hidden by workspaces");

  ws().switchTo(home);
  is(gBrowser.selectedTab, homeTab, "switching back selects the home tab");
  ok(!homeTab.hidden, "home tab visible again");
  ok(workTab.hidden, "work tab hidden");

  ws().switchTo(work);
  is(gBrowser.selectedTab, workTab, "last selected tab of the workspace is restored");
  await resetWorkspaces();
});

add_task(async function test_extension_hidden_and_pinned_tabs_are_untouched() {
  const home = ws().state.active;
  const pinned = await openTab();
  gBrowser.pinTab(pinned);
  const extHidden = await openTab();
  gBrowser.hideTab(extHidden, "extension@example");

  ws().newWorkspace();
  ok(!pinned.hidden, "pinned tabs are global: visible in every workspace");
  ws().switchTo(home);
  ok(extHidden.hidden, "a tab hidden by an extension stays hidden after switching back");
  is(SessionStore.getCustomTabValue(extHidden, "hiddenBy"), "extension@example", "its owner is unchanged");
  await resetWorkspaces();
});

add_task(async function test_selecting_another_workspaces_tab_switches_workspace() {
  const home = ws().state.active;
  const homeTab = gBrowser.selectedTab;
  ws().newWorkspace();
  const work = ws().state.active;

  // Firefox's own paths to a hidden tab (switch-to-tab, all-tabs menu) show
  // it first and then select it; selecting a hidden tab directly is refused.
  gBrowser.showTab(homeTab);
  gBrowser.selectedTab = homeTab;
  is(ws().state.active, home, "reaching a home tab switched back to home");
  ok(!homeTab.hidden, "and it is visible");
  ok(gBrowser.tabs.filter(t => memberOf(t) === work).every(t => t.hidden), "work tabs hidden");
  await resetWorkspaces();
});

add_task(async function test_dock_renders_and_clicking_switches() {
  ws().newWorkspace();
  const [homeButton, workButton] = dockButtons();
  is(dockButtons().length, 2, "one dock button per workspace");
  is(workButton.getAttribute("aria-selected"), "true", "active workspace is marked selected");
  homeButton.click();
  is(ws().state.active, homeButton.dataset.ws, "clicking a dot switches workspace");
  is(dockButtons()[0], homeButton, "the dock updates its buttons in place");
  is(homeButton.getAttribute("aria-selected"), "true", "dock follows the switch");
  document.querySelector('#aequera-workspace-dock [data-action="new-workspace"]').click();
  is(dockButtons().length, 3, "the + button adds a workspace");
  await resetWorkspaces();
});

add_task(async function test_dock_updates_keep_keyboard_focus() {
  ws().newWorkspace();
  const [homeButton, workButton] = dockButtons();
  homeButton.focus();
  // A background tab joins the active workspace, which updates the dock.
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  is(workButton.querySelector(".aequera-ws-count").textContent, "2", "the dock updated its counts");
  is(document.activeElement, homeButton, "a dock update keeps keyboard focus on the focused button");
  BrowserTestUtils.removeTab(tab);
  gBrowser.selectedBrowser.focus();
  await resetWorkspaces();
});

add_task(async function test_state_persists_in_session_store() {
  ws().newWorkspace();
  const saved = JSON.parse(SessionStore.getCustomWindowValue(window, WINDOW_KEY));
  is(saved.workspaces.length, 2, "workspaces saved as a window value");
  is(saved.active, ws().state.active, "active workspace saved");
  is(memberOf(gBrowser.selectedTab), saved.active, "membership saved as a tab value");
  await resetWorkspaces();
});

add_task(async function test_corrupt_state_recovers() {
  SessionStore.setCustomWindowValue(window, WINDOW_KEY, "{not json");
  ws().reload();
  is(ws().state.workspaces.length, 1, "corrupt state recovers to one workspace");
  ok(gBrowser.tabs.every(t => !t.hidden), "every tab reachable after recovery");
  await resetWorkspaces();
});

add_task(async function test_closing_a_workspaces_last_tab_keeps_the_window() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.closeWindowWithLastTab", true]] });
  const homeTab = gBrowser.selectedTab;
  ws().newWorkspace();
  const work = ws().state.active;
  const workTab = gBrowser.selectedTab;
  ok(homeTab.hidden, "home tab is parked");

  gBrowser.removeTab(workTab, { animate: false, skipPermitUnload: true });
  ok(!window.closed, "the window stays open");
  ok(gBrowser.tabs.includes(homeTab), "the other workspace's tab survives");
  is(ws().state.active, work, "still in the same workspace");
  is(memberOf(gBrowser.selectedTab), work, "a fresh tab replaced the closed one in this workspace");
  ok(!gBrowser.selectedTab.hidden, "and it is visible");

  await SpecialPowers.popPrefEnv();
  await resetWorkspaces();
});

add_task(async function test_dock_names_show_when_widened_and_dots_never_move() {
  ws().newWorkspace();
  const ROOT = document.documentElement;
  const container = document.getElementById("sidebar-container");
  const firstButton = () => dockButtons()[0];
  const dotLeft = () => firstButton().querySelector(".aequera-ws-dot").getBoundingClientRect().left;
  const nameOpacity = () => Number(getComputedStyle(firstButton().querySelector(".aequera-ws-name")).opacity);

  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.hover.openDelayMs", 0],
      ["aequera.hover.closeDelayMs", 0],
    ],
  });
  window.windowUtils.disableNonTestMouseEvents(true);
  // The new workspace's new tab focuses the address bar, which widens the
  // rail (prototype unified search); start from the page instead.
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabbox"), { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => !ROOT.hasAttribute("aequera-rail-content-expanded"),
    "starts collapsed"
  );
  // Names fade out after the collapse; wait for the fade to finish.
  await TestUtils.waitForCondition(() => nameOpacity() == 0, "collapsed: names are not shown");
  const collapsedDot = dotLeft();

  // Widen by hovering, as a user does (not the pinned pref).
  EventUtils.synthesizeMouse(container, 5, 60, { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => ROOT.hasAttribute("aequera-rail-content-expanded"),
    "hover widens the rail"
  );
  Assert.less(nameOpacity(), 1, "names fade in rather than appear at once");
  await TestUtils.waitForCondition(() => nameOpacity() == 1, "names fully shown when widened");
  const name = firstButton().querySelector(".aequera-ws-name");
  is(name.textContent, ws().state.workspaces[0].name, "the row shows the workspace name");
  Assert.greater(name.getBoundingClientRect().width, 40, "with room to read it");
  Assert.less(Math.abs(dotLeft() - collapsedDot), 0.5, "the dot did not move");

  EventUtils.synthesizeMouseAtCenter(document.getElementById("tabbrowser-tabbox"), { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => !ROOT.hasAttribute("aequera-rail-content-expanded"),
    "collapses"
  );
  window.windowUtils.disableNonTestMouseEvents(false);
  await SpecialPowers.popPrefEnv();
  await resetWorkspaces();
});

// Sort Tabs by Site (workspaces/site-sort-model.js has the node tests). Lazy
// tabs: their address comes from session data, so no network is needed.
const SORT_OVER_PREF = "aequera.tabs.sortBySite.over";
// The address each test tab was opened with: a selected lazy tab starts
// loading and reports about:blank until the load commits.
const urlOf = new WeakMap();
/** The visible tabs of the last lazyTabs() call, in order. */
const visibleUrls = () => gBrowser.tabs.filter(t => !t.hidden && urlOf.has(t)).map(t => urlOf.get(t));
const workspaceNamed = name => ws().state.workspaces.find(w => w.name === name);
/** Opens a test's tabs; tabs left from earlier tests (the window's first
 *  tab after resetWorkspaces) are no longer listed by visibleUrls. */
const lazyTabs = urls => {
  for (const tab of gBrowser.tabs) {
    urlOf.delete(tab);
  }
  return urls.map(url => {
    const tab = gBrowser.addTab(url, {
      createLazyBrowser: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    urlOf.set(tab, url);
    return tab;
  });
};
const exampleCom = count => Array.from({ length: count }, (_, i) => `https://test1.example.com/p${i}`);

add_task(async function test_shortcut_sorts_by_site_and_moves_busy_sites() {
  const home = ws().state.active;
  const first = gBrowser.tabs[0];
  lazyTabs([
    "about:robots",
    "https://example.org/b",
    ...exampleCom(4),
    "https://example.net/a",
    "https://www.example.com/x",
    ...exampleCom(8).slice(4),
    "https://example.org/a",
  ]);

  EventUtils.synthesizeKey("s", { accelKey: true, altKey: true });

  is(ws().state.active, home, "the workspace stays active");
  Assert.deepEqual(
    visibleUrls(),
    ["https://example.net/a", "https://example.org/a", "https://example.org/b", "about:robots"],
    "sorted by site, then address; the non-web page last"
  );
  const site = workspaceNamed("example.com");
  ok(site, "9 example.com tabs (more than 7) got a workspace named after the site");
  const moved = gBrowser.tabs.filter(t => memberOf(t) == site.id);
  is(moved.length, 9, "all of them, subdomains included");
  ok(
    moved.every(t => t.hidden && SessionStore.getCustomTabValue(t, "hiddenBy") == SOURCE),
    "parked like any other workspace's tabs"
  );
  is(gBrowser.selectedTab, first, "the selected tab did not move");
  const button = document.querySelector(`#aequera-workspace-dock button[data-ws="${site.id}"]`);
  is(button?.querySelector(".aequera-ws-count").textContent, "9", "the dock shows where they went");

  ws().switchTo(site.id);
  Assert.deepEqual(
    visibleUrls(),
    ["https://www.example.com/x", ...exampleCom(8)],
    "the site's workspace holds them, sorted"
  );
  ws().switchTo(home);

  const before = [...gBrowser.tabs];
  const count = ws().state.workspaces.length;
  ws().sortBySite();
  Assert.deepEqual([...gBrowser.tabs], before, "sorting a sorted workspace moves nothing");
  is(ws().state.workspaces.length, count, "and creates no workspace");
  await resetWorkspaces();
});

add_task(async function test_context_menu_sort_reuses_a_workspace_and_moves_the_selected_tab() {
  const home = ws().state.active;
  const { state, workspace } = AequeraWorkspaceModel.createWorkspace(ws().state, "example.org");
  ws().state = state;
  ws().save();
  ws().render();
  const [net, ...org] = lazyTabs([
    "https://example.net/",
    ...Array.from({ length: 8 }, (_, i) => `https://example.org/${i}`),
  ]);
  gBrowser.selectedTab = net;
  gBrowser.selectedTab = org[5];

  const menu = document.getElementById("tabContextMenu");
  const item = document.getElementById("aequera-context-sort-tabs");
  is(item.parentNode, menu, "the item is in Firefox's tab context menu");
  is(item.getAttribute("key"), "aequera-key-sort-tabs", "and shows its shortcut");
  // MenuSectionLayout throws on an item it does not place, except in a
  // menu's open (trailing) section.
  for (const layout of Object.values(TabContextMenu.MENU_SECTIONS)) {
    new TabContextMenu.MenuSectionLayout(layout, {
      dynamicItemSelectors: TabContextMenu.DYNAMIC_MENU_ITEM_SELECTORS,
    }).arrange(menu);
  }
  is(menu.lastElementChild, item, "both of Firefox's menu structures accept it and keep it last");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(window.AequeraTabs.rows.get(net), { type: "contextmenu", button: 2 });
  await shown;
  ok(BrowserTestUtils.isVisible(item), "the item is shown");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await hidden;

  is(ws().state.workspaces.length, 2, "the existing example.org workspace was reused");
  ok(
    org.every(t => memberOf(t) == workspace.id && t.hidden),
    "the 8 example.org tabs moved there"
  );
  is(ws().state.active, home, "the workspace stays active");
  is(gBrowser.selectedTab, net, "the most recently used staying tab is selected");
  ws().switchTo(workspace.id);
  is(gBrowser.selectedTab, org[5], "the site's workspace opens on the tab that was in use");
  await resetWorkspaces();
});

add_task(async function test_sort_threshold_pref() {
  await SpecialPowers.pushPrefEnv({ set: [[SORT_OVER_PREF, 0]] });
  lazyTabs([...exampleCom(12), "https://example.org/"]);
  ws().sortBySite();
  is(ws().state.workspaces.length, 1, "0 sorts without moving");
  is(visibleUrls()[0], "https://test1.example.com/p0", "but still sorts");

  await SpecialPowers.pushPrefEnv({ set: [[SORT_OVER_PREF, 12]] });
  ws().sortBySite();
  is(ws().state.workspaces.length, 1, "12 tabs are not more than 12");
  await SpecialPowers.pushPrefEnv({ set: [[SORT_OVER_PREF, 11]] });
  ws().sortBySite();
  ok(workspaceNamed("example.com"), "but more than 11");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await resetWorkspaces();
});

add_task(async function test_grouped_tabs_keep_their_place() {
  const [grouped] = lazyTabs(["https://example.org/z", "https://example.net/", "https://example.org/a"]);
  const group = gBrowser.addTabGroup([grouped], { insertBefore: grouped });
  ws().sortBySite();
  is(grouped.group, group, "a grouped tab stays in its group");
  Assert.deepEqual(
    visibleUrls(),
    ["https://example.net/", "https://example.org/a", "https://example.org/z"],
    "the ungrouped tabs are sorted; the group follows them"
  );
  group.ungroupTabs();
  await resetWorkspaces();
});

add_task(async function test_sort_cost_with_many_tabs() {
  // 150 tabs on 30 sites (5 each, so none moves), interleaved.
  const urls = Array.from({ length: 150 }, (_, i) => `https://site${i % 30}.example/page${i}`);
  lazyTabs(urls.reverse());
  const start = ChromeUtils.now();
  ws().sortBySite();
  info(`sortBySite: 150 tabs in ${(ChromeUtils.now() - start).toFixed(1)} ms`);
  const sites = visibleUrls().map(url => ws().siteOf(Services.io.newURI(url)));
  is(new Set(sites).size, 30, "30 sites");
  ok(
    sites.every((site, i) => i == 0 || sites[i - 1] <= site),
    "150 tabs end up in site order"
  );
  await resetWorkspaces();
});
