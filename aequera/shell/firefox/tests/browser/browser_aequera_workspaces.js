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
  // The dock re-renders its buttons: query again rather than reuse old nodes.
  is(dockButtons()[0].getAttribute("aria-selected"), "true", "dock follows the switch");
  document.querySelector('#aequera-workspace-dock [data-action="new-workspace"]').click();
  is(dockButtons().length, 3, "the + button adds a workspace");
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
