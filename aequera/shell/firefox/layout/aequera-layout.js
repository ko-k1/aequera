/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera layout migrations. Loaded into each browser window by
// aequera-main.js; each step runs once per profile.
//
// New Aequera defaults (browser.uiCustomization.defaultExclusions,
// browser.uiCustomization.defaultNavbarPlacements) only shape new profiles
// and Restore Defaults; a profile that already saved a layout keeps it.
// Like Firefox's own layout migrations (e.g. dropping the Firefox
// View button), each step here brings such profiles to the new default once
// and records that it ran, so a widget the user adds back afterwards stays.
var AequeraLayout = (() => {
  const VERSION_PREF = "aequera.layout.migrationVersion";
  const EXCLUSIONS_PREF = "browser.uiCustomization.defaultExclusions";
  const ORDER_PREF = "browser.uiCustomization.defaultNavbarPlacements";

  /** Widgets the current default layout leaves out. A migration only ever
   * removes these: if the exclusion is dropped, the migration is a no-op. */
  const excluded = () =>
    new Set(
      Services.prefs
        .getStringPref(EXCLUSIONS_PREF, "")
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    );

  const removeIfExcluded = id => {
    if (excluded().has(id) && CustomizableUI.getPlacementOfWidget(id)) {
      CustomizableUI.removeWidgetFromArea(id);
    }
  };

  const isSpringInstance = id =>
    CustomizableUI.isSpecialWidget(id) && id.includes("spring");
  const baseId = id => (isSpringInstance(id) ? "spring" : id);

  /** The product topbar order for profiles that saved an older one. Missing
   * spec widgets are added; excluded ones are dropped; anything else the
   * user placed keeps its relative order at the end. Empty order pref
   * (Firefox order) skips the step. Springs are rebuilt, never duplicated. */
  const applyNavbarOrder = () => {
    const gone = excluded();
    const order = Services.prefs
      .getStringPref(ORDER_PREF, "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
      .filter(id => !gone.has(id));
    if (!order.length) {
      return;
    }
    const area = CustomizableUI.AREA_NAVBAR;
    const placed = CustomizableUI.getWidgetIdsInArea(area);
    const spec = new Set(order);
    const target = [...order];
    for (const id of placed) {
      if (gone.has(baseId(id)) || isSpringInstance(id)) {
        continue;
      }
      if (!spec.has(baseId(id)) && !target.includes(id)) {
        target.push(id);
      }
    }
    const wanted = new Set(target);
    for (const id of placed) {
      if (!wanted.has(id) || isSpringInstance(id)) {
        CustomizableUI.removeWidgetFromArea(id);
      }
    }
    target.forEach((id, position) =>
      CustomizableUI.addWidgetToArea(id, area, position)
    );
  };

  /** Ordered steps; the array index + 1 is the version they bring a profile to. */
  const STEPS = [
    // 1: no "List all tabs" button next to the Aequera tab rail.
    () => removeIfExcluded("alltabs-button"),
    // 2: the product topbar order for profiles that saved an older one.
    applyNavbarOrder,
  ];

  const layout = {
    /** Run pending steps. Idempotent: the version pref gates every step. */
    migrate() {
      const done = Services.prefs.getIntPref(VERSION_PREF, 0);
      for (let version = done + 1; version <= STEPS.length; version++) {
        try {
          STEPS[version - 1]();
        } catch (error) {
          // A failed step must not block startup or later steps; it is
          // recorded as done so a broken step cannot retry on every start.
          console.error(`aequera-layout: migration ${version} failed`, error);
        }
        Services.prefs.setIntPref(VERSION_PREF, version);
      }
    },
  };

  window.delayedStartupPromise.then(() => layout.migrate());
  return layout;
})();
