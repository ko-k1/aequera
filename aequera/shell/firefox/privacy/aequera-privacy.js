/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera's tracking protection default: Firefox's Enhanced Tracking
// Protection "Strict", with Firefox's own "convenience" exceptions on so
// strict blocking does not break logins, embeds, and video (aequera-prefs.js,
// privacy model).
//
// The category cannot be a pref default. Firefox defines "standard" as
// "every ETP pref at its default" and, at startup, writes the matching
// category into the profile (ContentBlockingPrefs.matchCBCategory), so a
// default of "strict" is rewritten to "standard" before any window opens.
// Firefox's supported switch is writing the category, as Settings does; its
// observer then sets every strict pref. This does that once per profile, on
// its first window, before the user could have picked a category. Only
// Firefox's automatic "standard" is replaced; "custom" (or "strict") is left
// alone. Settings remains the control: choosing Standard there sticks.

var AequeraPrivacy = (() => {
  const TARGET = "aequera.privacy.trackingProtection";
  const APPLIED = "aequera.privacy.trackingProtectionApplied";
  const CATEGORY = "browser.contentblocking.category";
  const CONVENIENCE = "privacy.trackingprotection.allow_list.convenience.enabled";
  // Firefox's one-time allow-list migration (UrlClassifierExceptionListService)
  // runs lazily, on the first classified load, and turns both exception lists
  // off for a profile it finds in Strict: it assumes Strict predates the
  // lists. On Standard it only marks itself done, so that is recorded here,
  // while the profile is still on Standard.
  const MIGRATED = "privacy.trackingprotection.allow_list.hasMigratedCategoryPrefs";

  return {
    applyTrackingProtection() {
      if (Services.prefs.getBoolPref(APPLIED, false)) {
        return;
      }
      // Marked first: one attempt per profile, whatever happens below.
      Services.prefs.setBoolPref(APPLIED, true);
      if (Services.prefs.getStringPref(TARGET, "") != "strict") {
        return;
      }
      if (Services.prefs.getStringPref(CATEGORY, "standard") != "standard") {
        return;
      }
      Services.prefs.setBoolPref(MIGRATED, true);
      Services.prefs.setStringPref(CATEGORY, "strict");
      // After the category: switching resets the exceptions to strict's
      // (convenience off), and they do not change the category.
      Services.prefs.setBoolPref(CONVENIENCE, true);
    },
  };
})();

AequeraPrivacy.applyTrackingProtection();
