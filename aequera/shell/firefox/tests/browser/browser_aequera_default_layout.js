/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera's default toolbar layout (browser.uiCustomization.defaultExclusions,
// patches/browser/customization-defaults): excluded widgets are left out of
// the defaults but stay available in the customization palette.

const WIDGET = "alltabs-button";

add_task(async function test_list_all_tabs_is_not_in_the_default_layout() {
  CustomizableUI.reset();
  is(CustomizableUI.getPlacementOfWidget(WIDGET), null, "List all tabs is not placed by default");
  ok(CustomizableUI.getWidget(WIDGET)?.id, "it still exists as a widget");
});

add_task(async function test_existing_profiles_are_migrated_once() {
  // A profile saved before the new default (the button placed) at
  // migration version 0: the migration removes it once and records it.
  CustomizableUI.addWidgetToArea(WIDGET, CustomizableUI.AREA_NAVBAR);
  Services.prefs.setIntPref("aequera.layout.migrationVersion", 0);
  window.AequeraLayout.migrate();
  is(CustomizableUI.getPlacementOfWidget(WIDGET), null, "the saved button is removed once");
  Assert.greaterOrEqual(
    Services.prefs.getIntPref("aequera.layout.migrationVersion"),
    1,
    "the migration is recorded"
  );

  // The user adds it back afterwards: it stays.
  CustomizableUI.addWidgetToArea(WIDGET, CustomizableUI.AREA_NAVBAR);
  window.AequeraLayout.migrate();
  ok(CustomizableUI.getPlacementOfWidget(WIDGET), "a button added back later is left alone");
  CustomizableUI.reset();
});

add_task(async function test_migration_only_removes_excluded_widgets() {
  // With the exclusion dropped (e.g. Firefox's empty default), the migration
  // must leave the button alone.
  await SpecialPowers.pushPrefEnv({ set: [["browser.uiCustomization.defaultExclusions", ""]] });
  CustomizableUI.addWidgetToArea(WIDGET, CustomizableUI.AREA_NAVBAR);
  Services.prefs.setIntPref("aequera.layout.migrationVersion", 0);
  window.AequeraLayout.migrate();
  ok(CustomizableUI.getPlacementOfWidget(WIDGET), "not excluded: the button stays");
  await SpecialPowers.popPrefEnv();
  CustomizableUI.reset();
});

add_task(async function test_it_can_still_be_added_from_the_palette() {
  CustomizableUI.addWidgetToArea(WIDGET, CustomizableUI.AREA_NAVBAR);
  ok(CustomizableUI.getPlacementOfWidget(WIDGET), "a user can add it back");
  ok(document.getElementById(WIDGET), "and it is built in the window");
  CustomizableUI.reset();
  is(CustomizableUI.getPlacementOfWidget(WIDGET), null, "Restore Defaults removes it again");
});

// Aequera's default topbar order
// (browser.uiCustomization.defaultNavbarPlacements,
// patches/browser/customization-defaults 0002): back, forward, reload,
// space, address, devtools, space, downloads; the fixed extensions button
// and app menu follow on their own.

const NAVBAR_ORDER = [
  "back-button",
  "forward-button",
  "stop-reload-button",
  "spring",
  "urlbar-container",
  "developer-button",
  "spring",
  "downloads-button",
];

// Orientation snapshots (vertical/horizontal tabstrip backups) persist
// across resets in one profile; clear them so each order test starts from
// bare defaults rather than a previous test's merged layout. Called after
// the final reset too, so the run leaves no changed preferences behind.
function clearSnapshots() {
  for (let pref of [
    "browser.uiCustomization.navBarWhenVerticalTabs",
    "browser.uiCustomization.horizontalTabsBackup",
    "browser.uiCustomization.horizontalTabstrip",
  ]) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
}

function resetToDefaults() {
  clearSnapshots();
  CustomizableUI.reset();
}

// Orientation machinery persists snapshots on idle after a reset; settle,
// then leave the profile without changed preferences (the harness flags
// leftovers at file end).
async function settleClean() {
  resetToDefaults();
  await new Promise(resolve => setTimeout(resolve, 1000));
  clearSnapshots();
}

// getWidgetIdsInArea reports spring instances with unique suffixes
// (customizableui-special-springN); the product order just says "spring".
const SPRING_INSTANCE = /^customizableui-special-spring\d+$/;
function normalizedNavbarIds() {
  return CustomizableUI.getWidgetIdsInArea(CustomizableUI.AREA_NAVBAR).map(
    id => (SPRING_INSTANCE.test(id) ? "spring" : id)
  );
}

add_task(async function test_navbar_follows_the_default_order() {
  resetToDefaults();
  Assert.deepEqual(
    normalizedNavbarIds(),
    [
      ...NAVBAR_ORDER,
      // Fixed chrome after the placed widgets: the extensions button and
      // the titlebar spring live in the XUL, outside customization. The
      // spring is hidden by aequera-shell.css (dead 40px gap otherwise).
      "unified-extensions-button",
      "vertical-spacer",
    ],
    "navbar defaults follow the product order"
  );
});

add_task(async function test_omitted_widgets_stay_in_the_palette() {
  for (let id of ["home-button", "fxa-toolbar-menu-button"]) {
    is(
      CustomizableUI.getPlacementOfWidget(id),
      null,
      `${id} is not placed by default`
    );
    ok(CustomizableUI.getWidget(id)?.id, `${id} still exists as a widget`);
  }
  await settleClean();
});

// Empty means Firefox's order: area defaults are computed once at area
// registration (browser startup), so flipping the pref mid-session cannot
// change a reset. The empty-pref case is covered by the upstream gate
// instead: test-shell.sh runs Firefox's own toolbar suites with
// defaultNavbarPlacements empty.

add_task(async function test_migration_brings_saved_layouts_to_the_order() {
  // A profile that saved a jumbled bar: the product order afterwards, the
  // user's own button kept at the end, and the run recorded.
  resetToDefaults();
  CustomizableUI.addWidgetToArea("home-button", CustomizableUI.AREA_NAVBAR);
  CustomizableUI.removeWidgetFromArea("downloads-button");
  CustomizableUI.moveWidgetWithinArea("forward-button", 0);
  Services.prefs.setIntPref("aequera.layout.migrationVersion", 1);
  window.AequeraLayout.migrate();
  Assert.deepEqual(
    normalizedNavbarIds(),
    [
      ...NAVBAR_ORDER,
      // Unknowns keep their relative order at the end: the fixed chrome
      // first, then the user's own button where they put it.
      "unified-extensions-button",
      "vertical-spacer",
      "home-button",
    ],
    "saved layouts migrate to the product order once"
  );
  is(
    Services.prefs.getIntPref("aequera.layout.migrationVersion"),
    2,
    "the migration is recorded"
  );

  // Second run: the user's post-migration layout is left alone.
  CustomizableUI.removeWidgetFromArea("developer-button");
  window.AequeraLayout.migrate();
  is(
    CustomizableUI.getPlacementOfWidget("developer-button"),
    null,
    "a button removed after migrating stays removed"
  );
  await settleClean();
});
