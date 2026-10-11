/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Ad Veil (docs/design/ADS.md): the built-in add-on is installed, holds
// only its declared permissions, blocks a request EasyList matches, hides an
// element a generic EasyList rule matches, and aequera.adveil.enabled turns
// both off and on.

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

const ID = "adveil@aequera";
const PREF = "aequera.adveil.enabled";
const PAGE = "https://example.com/browser/browser/aequera/tests/browser/adveil_page.html";

const ALLOWED_PERMISSIONS = [
  "storage",
  "tabs",
  "unlimitedStorage",
  "webNavigation",
  "webRequest",
  "webRequestBlocking",
];

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(PREF);
  // The fixture visits are history; later tests (the new tab page's empty
  // state) expect a profile without any.
  await PlacesUtils.history.clear();
});

// Active means started, which comes before the background page has run and
// registered its blocking listener. At browser startup Firefox holds
// requests for primed blocking listeners; after a mid-session enable it does
// not, so "on" here also waits for the background to be running.
async function waitForActive(active) {
  await TestUtils.waitForCondition(async () => {
    const addon = await AddonManager.getAddonByID(ID);
    if (addon.isActive != active) {
      return false;
    }
    return !active || WebExtensionPolicy.getByID(ID)?.extension?.backgroundState == "running";
  }, `Ad Veil ${active ? "running" : "inactive"}`);
}

// Loads the fixture and reports what its scripts and styles did. With
// `hidden`, waits for the generic rule's stylesheet (it follows the content
// script's report) up to a timeout.
async function loadFixture({ hidden }) {
  return BrowserTestUtils.withNewTab(PAGE, browser =>
    SpecialPowers.spawn(browser, [hidden], async expectHidden => {
      const display = id => content.getComputedStyle(content.document.getElementById(id)).display;
      if (expectHidden) {
        await ContentTaskUtils.waitForCondition(() => display("banner") == "none", "banner hidden");
      }
      const page = content.wrappedJSObject;
      return {
        adLoaded: !!page.adLoaded,
        appLoaded: !!page.appLoaded,
        banner: display("banner"),
        article: display("article"),
      };
    })
  );
}

add_task(async function test_installed_as_builtin() {
  const addon = await AddonManager.getAddonByID(ID);
  ok(addon, "Ad Veil is installed");
  ok(addon.isActive, "and active by default");
  ok(addon.isBuiltin, "from the built-in location");
  ok(addon.hidden, "hidden from about:addons (aequera.adveil.enabled is its control)");
});

// What Firefox grants every built-in add-on on its own.
const BUILTIN_GRANTS = ["internal:privateBrowsingAllowed", "internal:svgContextPropertiesAllowed"];

add_task(async function test_least_privilege() {
  const policy = WebExtensionPolicy.getByID(ID);
  const granted = [...policy.permissions];
  Assert.deepEqual(
    granted.filter(p => !p.startsWith("internal:") && p != "<all_urls>").sort(),
    ALLOWED_PERMISSIONS,
    "exactly the declared API permissions"
  );
  Assert.deepEqual(
    granted.filter(p => p.startsWith("internal:")).sort(),
    BUILTIN_GRANTS,
    "no internal permission beyond Firefox's built-in grants"
  );
  // Every extension can reach its own moz-extension: origin.
  const own = policy.getURL("*");
  Assert.deepEqual(
    policy.allowedOrigins.patterns.map(p => p.pattern).filter(p => p != own),
    ["<all_urls>"],
    "host access: all sites, nothing else"
  );
  const manifest = policy.extension.manifest;
  ok(!manifest.experiment_apis, "no experiment APIs");
  ok(!policy.permissions.includes("mozillaAddons"), "no mozillaAddons");
});

add_task(async function test_blocks_and_hides() {
  await waitForActive(true);
  const result = await loadFixture({ hidden: true });
  ok(!result.adLoaded, "the request EasyList matches is blocked");
  ok(result.appLoaded, "the page's own script loads");
  is(result.banner, "none", "the element a generic rule matches is hidden");
  isnot(result.article, "none", "other elements are untouched");
});

add_task(async function test_pref_turns_it_off_and_on() {
  Services.prefs.setBoolPref(PREF, false);
  await waitForActive(false);
  const off = await loadFixture({ hidden: false });
  ok(off.adLoaded, "off: nothing is blocked");
  isnot(off.banner, "none", "off: nothing is hidden");

  // Startup (engine load, list compile) must not touch the network: every
  // channel opened until blocking works again is checked for the add-on.
  const own = [];
  let seen = 0;
  const observe = subject => {
    const { loadInfo, URI } = subject.QueryInterface(Ci.nsIChannel);
    seen++;
    const principals = [loadInfo.loadingPrincipal, loadInfo.triggeringPrincipal];
    if (principals.some(p => p?.addonId == ID)) {
      own.push(URI.spec);
    }
  };
  Services.obs.addObserver(observe, "http-on-opening-request");
  try {
    Services.prefs.setBoolPref(PREF, true);
    await waitForActive(true);
    const on = await loadFixture({ hidden: true });
    ok(!on.adLoaded, "on again: blocking is back");
    is(on.banner, "none", "on again: hiding is back");
  } finally {
    Services.obs.removeObserver(observe, "http-on-opening-request");
  }
  Assert.greater(seen, 0, "the observer saw the fixture's requests");
  Assert.deepEqual(own, [], "Ad Veil made no network request of its own");
});
