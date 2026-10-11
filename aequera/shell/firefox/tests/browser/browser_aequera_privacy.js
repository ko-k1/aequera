/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera privacy model and appearance defaults (aequera-prefs.js,
// privacy/aequera-privacy.js): Enhanced Tracking Protection Strict with
// Firefox's convenience exceptions, applied once per profile; Global
// Privacy Control; dark appearance; session restore.

const CATEGORY = "browser.contentblocking.category";
const APPLIED = "aequera.privacy.trackingProtectionApplied";
const CONVENIENCE = "privacy.trackingprotection.allow_list.convenience.enabled";
const BASELINE = "privacy.trackingprotection.allow_list.baseline.enabled";
const MIGRATED = "privacy.trackingprotection.allow_list.hasMigratedCategoryPrefs";

function apply() {
  window.AequeraPrivacy.applyTrackingProtection();
}

// A new profile: neither Aequera's switch nor Firefox's allow-list migration
// has run yet.
function rerun(category) {
  Services.prefs.setStringPref(CATEGORY, category);
  Services.prefs.clearUserPref(APPLIED);
  Services.prefs.clearUserPref(MIGRATED);
  apply();
}

function migrateAllowLists() {
  Cc["@mozilla.org/url-classifier/exception-list-service;1"]
    .getService(Ci.nsIUrlClassifierExceptionListService)
    .maybeMigrateCategoryPrefs();
}

registerCleanupFunction(() => {
  // The profile's state after startup: Strict with the exceptions on.
  Services.prefs.setStringPref(CATEGORY, "strict");
  Services.prefs.setBoolPref(CONVENIENCE, true);
  Services.prefs.setBoolPref(APPLIED, true);
  Services.prefs.setBoolPref(MIGRATED, true);
});

add_task(async function test_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  is(defaults.getStringPref("aequera.privacy.trackingProtection"), "strict", "Strict is the target");
  is(defaults.getBoolPref("privacy.globalprivacycontrol.enabled"), true, "GPC on");
  is(defaults.getIntPref("ui.systemUsesDarkTheme"), 1, "dark by default");
  is(defaults.getIntPref("browser.startup.page"), 3, "previous session restored");
  ok(!Services.prefs.getBoolPref("privacy.resistFingerprinting"), "resistFingerprinting stays off");
});

add_task(async function test_strict_applied_at_startup() {
  ok(Services.prefs.getBoolPref(APPLIED, false), "applied once, on the first window");
  is(Services.prefs.getStringPref(CATEGORY), "strict", "the profile is in Strict");
  ok(Services.prefs.getBoolPref(CONVENIENCE), "convenience exceptions on");
  ok(Services.prefs.getBoolPref("privacy.trackingprotection.enabled"), "tracking content blocked in all windows");
  ok(Services.prefs.getBoolPref("privacy.fingerprintingProtection"), "fingerprinting protection in all windows");
});

add_task(async function test_once_and_only_over_standard() {
  rerun("standard");
  is(Services.prefs.getStringPref(CATEGORY), "strict", "Firefox's automatic Standard becomes Strict");
  ok(Services.prefs.getBoolPref(CONVENIENCE), "with the convenience exceptions");
  ok(Services.prefs.getBoolPref(APPLIED), "marked");

  // Firefox's lazy allow-list migration (first classified load) must not
  // take the new Strict profile for a pre-allow-list one and turn both
  // exception lists off.
  migrateAllowLists();
  ok(Services.prefs.getBoolPref(BASELINE), "baseline exceptions survive the migration");
  ok(Services.prefs.getBoolPref(CONVENIENCE), "convenience exceptions survive the migration");

  // A later Standard (the user's choice in Settings) sticks.
  Services.prefs.setStringPref(CATEGORY, "standard");
  apply();
  is(Services.prefs.getStringPref(CATEGORY), "standard", "never applied twice");

  rerun("custom");
  is(Services.prefs.getStringPref(CATEGORY), "custom", "a Custom profile is left alone");
  ok(Services.prefs.getBoolPref(APPLIED), "and still marked, so it is never retried");

  Services.prefs.setStringPref("aequera.privacy.trackingProtection", "");
  try {
    rerun("standard");
    is(Services.prefs.getStringPref(CATEGORY), "standard", "an empty target leaves the category to Firefox");
  } finally {
    Services.prefs.clearUserPref("aequera.privacy.trackingProtection");
  }
});

add_task(async function test_dark_chrome_and_pages() {
  ok(window.matchMedia("(prefers-color-scheme: dark)").matches, "browser chrome is dark");
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const page = await SpecialPowers.spawn(browser, [], () => ({
      dark: content.matchMedia("(prefers-color-scheme: dark)").matches,
      gpc: content.navigator.globalPrivacyControl,
    }));
    ok(page.dark, "pages get prefers-color-scheme: dark");
    is(page.gpc, true, "pages see Global Privacy Control");
  });
});
