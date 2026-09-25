/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera layout migrations. Loaded into each browser window by
// aequera-shell.js; each step runs once per profile.
//
// New Aequera defaults (browser.uiCustomization.defaultExclusions) only shape
// new profiles and Restore Defaults; a profile that already saved a layout
// keeps it. Like Firefox's own layout migrations (e.g. dropping the Firefox
// View button), each step here brings such profiles to the new default once
// and records that it ran, so a widget the user adds back afterwards stays.
var AequeraLayout = (() => {
  const VERSION_PREF = "aequera.layout.migrationVersion";

  /** Ordered steps; the array index + 1 is the version they bring a profile to. */
  const STEPS = [
    // 1: no "List all tabs" button next to the Aequera tab rail.
    () => {
      if (CustomizableUI.getPlacementOfWidget("alltabs-button")) {
        CustomizableUI.removeWidgetFromArea("alltabs-button");
      }
    },
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
