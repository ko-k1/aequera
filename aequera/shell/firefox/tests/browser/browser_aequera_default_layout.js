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

add_task(async function test_it_can_still_be_added_from_the_palette() {
  CustomizableUI.addWidgetToArea(WIDGET, CustomizableUI.AREA_NAVBAR);
  ok(CustomizableUI.getPlacementOfWidget(WIDGET), "a user can add it back");
  ok(document.getElementById(WIDGET), "and it is built in the window");
  CustomizableUI.reset();
  is(CustomizableUI.getPlacementOfWidget(WIDGET), null, "Restore Defaults removes it again");
});
