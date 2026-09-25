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
