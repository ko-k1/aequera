/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera command surface in the real urlbar (aequera/shell/firefox/command):
// workspace, closed-tab, and command rows, picked with the keyboard. Model
// logic has node unit tests.

ChromeUtils.defineESModuleGetters(this, {
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  TabStateFlusher: "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
});
UrlbarTestUtils.init(this);

const DYNAMIC_TYPE = "aequeraCommand";
const WINDOW_KEY = "aequera-workspaces";
const TAB_KEY = "aequera-workspace";

const ws = (win = window) => win.AequeraWorkspaces;

/** The Aequera rows shown for `value`, with their result indexes. */
async function aequeraRows(value, win = window) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value });
  const rows = [];
  for (let index = 0; index < UrlbarTestUtils.getResultCount(win); index++) {
    const details = await UrlbarTestUtils.getDetailsOfResultAt(win, index);
    if (details.dynamicType == DYNAMIC_TYPE) {
      // The payload must not look like a Firefox secondary action (a
      // `payload.action` collision once rendered a broken button here).
      ok(
        !details.element.row.querySelector(".urlbarView-action-btn"),
        `row ${index} has no secondary-action button`
      );
      rows.push({ index, title: details.displayed.title, action: details.displayed.action });
    }
  }
  return rows;
}

/** Select row `index` with the keyboard path and press Enter. */
async function pickRow(index, win = window) {
  await UrlbarTestUtils.promisePopupClose(win, () => {
    UrlbarTestUtils.setSelectedRowIndex(win, index);
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
  });
}

async function closeView(win = window) {
  await UrlbarTestUtils.promisePopupClose(win, () => win.gURLBar.blur());
}

/** Back to one workspace holding every tab, all visible (as the workspaces test). */
async function resetWorkspaces() {
  for (const tab of gBrowser.tabs) {
    gBrowser.showTab(tab);
  }
  gBrowser.selectedTab = gBrowser.tabs[0];
  for (const tab of gBrowser.tabs.slice(1)) {
    gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
  }
  const first = gBrowser.tabs[0];
  gBrowser.showTab(first);
  SessionStore.deleteCustomWindowValue(window, WINDOW_KEY);
  SessionStore.deleteCustomTabValue(first, TAB_KEY);
  ws().reload();
  ws().render();
}

function forgetClosedTabs() {
  while (SessionStore.getClosedTabCountForWindow(window)) {
    SessionStore.forgetClosedTab(window, 0);
  }
}

add_setup(async () => {
  await ws().ready;
  await resetWorkspaces();
  forgetClosedTabs();
  registerCleanupFunction(async () => {
    await resetWorkspaces();
    forgetClosedTabs();
  });
});

add_task(async function test_provider_registered_once_per_process() {
  const count = () =>
    ProvidersManager.getInstanceForSap("urlbar").providers.filter(p => p.name == "AequeraCommands").length;
  is(count(), 1, "one provider after the first window");
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await win.AequeraWorkspaces.ready;
    is(count(), 1, "a second window reuses it");

    // Rows come from the querying window: a workspace made in the new window
    // is offered there and not here.
    win.AequeraWorkspaces.newWorkspace();
    const name = win.AequeraWorkspaces.state.workspaces.at(-1).name;
    win.AequeraWorkspaces.switchTo(win.AequeraWorkspaces.state.workspaces[0].id);
    const there = await aequeraRows(name, win);
    ok(
      there.some(r => r.title == name),
      "the new window offers its own workspace"
    );
    await closeView(win);
    const here = await aequeraRows(name);
    ok(!here.some(r => r.title == name), "the first window does not offer it");
    await closeView();
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_inactive_for_empty_input_and_other_bars() {
  // The zero-prefix view (top sites) cannot be opened reliably in a test
  // profile, so check the provider's gate directly.
  const provider = ProvidersManager.getInstanceForSap("urlbar").getProvider("AequeraCommands");
  const context = (search, extra = {}) => ({
    sapName: "urlbar",
    trimmedSearchString: search,
    restrictInSearchMode: () => false,
    ...extra,
  });
  const controller = { browserWindow: window };
  ok(await provider.isActive(context("wor"), controller), "active for typed input");
  ok(!(await provider.isActive(context(""), controller)), "inactive for empty input");
  ok(
    !(await provider.isActive(context("wor", { restrictInSearchMode: () => true }), controller)),
    "inactive in a restricting search mode"
  );
  ok(!(await provider.isActive(context("wor", { sapName: "searchbar" }), controller)), "urlbar only");
});

add_task(async function test_workspace_row_switches_workspace() {
  const home = ws().state.active;
  ws().newWorkspace();
  const research = ws().state.active;
  ws().state.workspaces.find(w => w.id === research).name = "Research";
  ws().save();
  ws().switchTo(home);

  ok(!(await aequeraRows("Personal")).some(r => r.title == "Personal"), "the active workspace is not offered");
  await closeView();

  const rows = await aequeraRows("resea");
  const row = rows.find(r => r.title == "Research");
  ok(row, "the other workspace is offered");
  is(row.action, "Switch to workspace · 1 tab", "action label names the action and size");
  await pickRow(row.index);
  is(ws().state.active, research, "picking the row switches workspace");
  await resetWorkspaces();
});

add_task(async function test_closed_tab_row_restores_the_tab() {
  const url = "data:text/html,<title>Aequera closed probe</title>";
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await TabStateFlusher.flush(tab.linkedBrowser);
  const before = SessionStore.getClosedTabCountForWindow(window);
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > before,
    "tab reaches the closed list"
  );

  const rows = await aequeraRows("closed probe");
  const row = rows.find(r => r.title == "Aequera closed probe");
  ok(row, "the closed tab is offered");
  is(row.action, "Reopen closed tab · Personal", "action label names its workspace");
  const restored = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "SSTabRestored");
  await pickRow(row.index);
  const { target } = await restored;
  is(target.linkedBrowser.currentURI.spec, url, "the closed tab is back");
  is(SessionStore.getClosedTabCountForWindow(window), before, "and left the closed list");
  await resetWorkspaces();
});

add_task(async function test_command_row_runs_the_command() {
  const count = ws().state.workspaces.length;
  const rows = await aequeraRows("new workspace");
  const row = rows.find(r => r.title == "New workspace");
  ok(row, "the command is offered");
  await pickRow(row.index);
  is(ws().state.workspaces.length, count + 1, "a workspace was created");
  is(ws().state.active, ws().state.workspaces.at(-1).id, "and is active");
  await resetWorkspaces();
});

add_task(async function test_commands_need_three_characters() {
  const rows = await aequeraRows("ne");
  ok(!rows.some(r => r.title == "New tab"), "two characters offer no commands");
  await closeView();
});
