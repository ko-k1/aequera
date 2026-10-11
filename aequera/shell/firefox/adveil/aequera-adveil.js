/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil switch (docs/design/ADS.md, Configuration). Ad Veil is a built-in
// add-on (aequera/extensions/ad-veil): hidden from about:addons, so
// aequera.adveil.enabled is its control. The add-on manager refuses to
// disable system add-ons unless asked with allowSystemAddons, as Firefox's
// own pref-driven one does (BrowserGlue, webcompat reporter), and keeps the
// state in the profile; this keeps it equal to the pref, from every window
// (idempotent).

var AequeraAdVeil = (() => {
  const PREF = "aequera.adveil.enabled";
  const ID = "adveil@aequera";
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

  function wanted() {
    try {
      return Services.prefs.getBoolPref(PREF, true);
    } catch {
      // Not a boolean (set by hand): the default.
      return true;
    }
  }

  async function sync() {
    const addon = await AddonManager.getAddonByID(ID);
    if (!addon) {
      return;
    }
    if (wanted()) {
      if (addon.userDisabled) {
        await addon.enable({ allowSystemAddons: true });
      }
    } else if (!addon.userDisabled) {
      await addon.disable({ allowSystemAddons: true });
    }
  }

  function run() {
    sync().catch(error => console.error("aequera: Ad Veil switch failed", error));
  }

  Services.prefs.addObserver(PREF, run);
  window.addEventListener("unload", () => Services.prefs.removeObserver(PREF, run), { once: true });
  run();

  return { sync };
})();
