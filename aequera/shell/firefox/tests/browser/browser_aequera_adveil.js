/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Ad Veil (docs/design/ADS.md): the built-in add-on is installed, holds
// only its declared permissions, blocks a request EasyList matches, hides an
// element a generic EasyList rule matches, and aequera.adveil.enabled turns
// both off and on. Slice 2: the vault records hidden ads and blocked
// requests (never from private windows), and the address bar popup turns Ad
// Veil off and on for a site.

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { AppUiTestDelegate } = ChromeUtils.importESModule("resource://testing-common/AppUiTestDelegate.sys.mjs");

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

// Runs `task` and fails if Ad Veil opened any network channel meanwhile
// (every channel is checked for the add-on's principal).
async function withoutOwnRequests(task) {
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
    await task();
  } finally {
    Services.obs.removeObserver(observe, "http-on-opening-request");
  }
  Assert.greater(seen, 0, "the observer saw the fixture's requests");
  Assert.deepEqual(own, [], "Ad Veil made no network request of its own");
}

// The toolbar button (makeWidgetId("adveil@aequera") + "-browser-action"):
// title, badge, and icon (custom properties in its style) are attributes of
// its action button, as Firefox's own browserAction tests read them.
const WIDGET = "adveil_aequera-browser-action";

function actionButton(win = window) {
  return win.document.getElementById(WIDGET)?.querySelector(".unified-extensions-item-action-button");
}

function buttonTitle(win = window) {
  return actionButton(win)?.getAttribute("tooltiptext") || "";
}

function buttonBadge(win = window) {
  return actionButton(win)?.getAttribute("badge") || "";
}

function buttonIcon(win = window) {
  return actionButton(win)?.getAttribute("style") || "";
}

async function openFixture(win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE);
  await waitForHidden(tab.linkedBrowser);
  return tab;
}

function waitForHidden(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.getComputedStyle(content.document.getElementById("banner")).display == "none",
      "banner hidden"
    )
  );
}

function fixtureState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    adLoaded: !!content.wrappedJSObject.adLoaded,
    banner: content.getComputedStyle(content.document.getElementById("banner")).display,
  }));
}

// Opens the popup for the selected tab and runs `task` in it (a content
// task: it gets the popup's document as `content`).
async function inPopup(win, task, args = []) {
  const loaded = AppUiTestDelegate.awaitExtensionPanel(win, ID);
  await AppUiTestDelegate.clickBrowserAction(win, ID);
  const browser = await loaded;
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.getElementById("site")?.textContent, "popup rendered")
  );
  try {
    return await SpecialPowers.spawn(browser, args, task);
  } finally {
    const panel = browser.closest("panel");
    if (panel?.state == "open") {
      const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
      panel.hidePopup();
      await hidden;
    }
  }
}

// The popup's view of this page.
function readPopup() {
  return inPopup(window, () => {
    const doc = content.document;
    return {
      site: doc.getElementById("site").textContent,
      mode: doc.querySelector("input[name=mode]:checked").value,
      blocked: Number(doc.getElementById("blocked").textContent.replace(/\D/g, "")),
      hidden: Number(doc.getElementById("hidden").textContent.replace(/\D/g, "")),
      share: doc.getElementById("blocked-share").textContent,
      domains: doc.getElementById("domains").textContent,
      hosts: [...doc.querySelectorAll("#hosts li .name")].map(s => s.textContent),
      ads: [...doc.querySelectorAll("#ads li .text")].map(s => s.textContent),
      totals: doc.getElementById("totals").textContent,
    };
  });
}

// The dashboard, as rendered (every tab's content is in the document).
async function readVault(tab) {
  await BrowserTestUtils.reloadTab(tab);
  return SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(() => doc.body.dataset.ready, "dashboard rendered");
    return {
      blocked: Number(doc.getElementById("chart-total").textContent.replace(/\D/g, "")),
      hosts: [...doc.querySelectorAll("#top-hosts li .name")].map(s => s.textContent),
      ads: [...doc.querySelectorAll(".ad-card")].map(card => ({
        link: card.querySelector(".link")?.href || null,
        site: card.querySelector(".meta").textContent.split(" · ")[0],
        text: card.querySelector(".text").textContent,
        creative: card.dataset.creative,
        image: card.querySelector("img")?.getAttribute("src") || null,
      })),
      keep: doc.getElementById("set-vault").checked,
      sites: [...doc.querySelectorAll("#site-rows tr")].map(row => ({
        site: row.cells[0].textContent,
        mode: row.querySelector("select").value,
      })),
    };
  });
}

async function openVault() {
  const url = WebExtensionPolicy.getByID(ID).getURL("pages/dashboard.html#vault");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  return tab;
}

async function clearVault(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(() => doc.body.dataset.ready, "vault rendered");
    delete doc.body.dataset.ready;
    doc.getElementById("clear").click();
    doc.getElementById("clear").click();
    await ContentTaskUtils.waitForCondition(() => doc.body.dataset.ready, "vault cleared");
  });
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
  // One privileged API, parent-only: veil mode's classifier listener.
  const experiments = policy.extension.manifest.experiment_apis;
  Assert.deepEqual(Object.keys(experiments), ["aequeraVeil"], "one experiment API");
  const veil = experiments.aequeraVeil;
  Assert.deepEqual(
    {
      schema: veil.schema,
      child: veil.child ?? null,
      scopes: veil.parent.scopes,
      script: veil.parent.script,
      paths: veil.parent.paths,
    },
    {
      schema: "experiments/veil.json",
      child: null,
      scopes: ["addon_parent"],
      script: "experiments/veil.js",
      paths: [["aequeraVeil"]],
    },
    "aequeraVeil: parent process only, its own namespace"
  );
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

  // Startup (engine load, list compile) must not touch the network.
  await withoutOwnRequests(async () => {
    Services.prefs.setBoolPref(PREF, true);
    await waitForActive(true);
    const on = await loadFixture({ hidden: true });
    ok(!on.adLoaded, "on again: blocking is back");
    is(on.banner, "none", "on again: hiding is back");
  });
});

add_task(async function test_vault_records_hidden_ads_and_blocked_requests() {
  await waitForActive(true);
  const vault = await openVault();
  await clearVault(vault);
  const empty = await readVault(vault);
  is(empty.ads.length, 0, "cleared: no ads");
  is(empty.blocked, 0, "cleared: nothing blocked");
  ok(empty.keep, "the vault is kept by default");

  const page = await openFixture();
  await TestUtils.waitForCondition(() => /1 hidden/.test(buttonTitle()), "the hidden ad is counted");
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await readVault(vault);
    return state.ads.length > 0;
  }, "the hidden ad reaches the vault");
  Assert.deepEqual(
    state.ads.map(({ link, site, text, creative }) => ({ link, site, text, creative })),
    [
      {
        link: "https://example.org/landing?campaign=veil",
        site: "example.com",
        text: "Veil test ad",
        creative: "https://example.com/browser/browser/aequera/tests/browser/adveil_ad.svg",
      },
    ],
    "the ad's link, site, text, and image"
  );
  Assert.greaterOrEqual(state.blocked, 1, "the blocked request is counted");
  ok(state.hosts.includes("example.com"), "by blocked host");

  ok(!state.ads[0].image, "no ad image while Show ad images is off");

  // Using the page and reading the vault again stays local (images are off).
  await withoutOwnRequests(async () => {
    await BrowserTestUtils.reloadTab(page);
    await waitForHidden(page.linkedBrowser);
    await readVault(vault);
  });

  // Show ad images: the creative is fetched by the dashboard, and shown.
  await SpecialPowers.spawn(vault.linkedBrowser, [], () => content.document.getElementById("set-images").click());
  await TestUtils.waitForCondition(async () => {
    state = await readVault(vault);
    return state.ads[0]?.image?.startsWith("blob:");
  }, "the ad image is shown");
  ok(true, "Show ad images loads the ad's image");
  await SpecialPowers.spawn(vault.linkedBrowser, [], () => content.document.getElementById("set-images").click());
  BrowserTestUtils.removeTab(page);
  await clearVault(vault);
  BrowserTestUtils.removeTab(vault);
});

add_task(async function test_private_windows_are_not_recorded() {
  await waitForActive(true);
  const vault = await openVault();
  await clearVault(vault);

  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const page = await openFixture(win);
  const blocked = await fixtureState(page.linkedBrowser);
  ok(!blocked.adLoaded, "private windows are protected too");
  // Counted means the background has handled the content script's report.
  await TestUtils.waitForCondition(() => /1 hidden/.test(buttonTitle(win)), "the hidden ad is counted");
  await BrowserTestUtils.closeWindow(win);

  const state = await readVault(vault);
  is(state.ads.length, 0, "no ad from a private window");
  is(state.blocked, 0, "no blocked request from a private window");
  BrowserTestUtils.removeTab(vault);
});

// Picks a mode in the popup; resolves once the page has reloaded with it.
async function pickMode(tab, mode) {
  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await inPopup(window, id => content.document.getElementById(id).click(), [`mode-${mode}`]);
  await reloaded;
}

add_task(async function test_popup_turns_a_site_off_and_on() {
  await waitForActive(true);
  const tab = await openFixture();
  await TestUtils.waitForCondition(() => buttonBadge() == "1", "the toolbar badge counts the blocked request");
  let popup;
  await TestUtils.waitForCondition(async () => {
    popup = await readPopup();
    return popup.ads.length > 0;
  }, "the popup lists the hidden ad");
  Assert.deepEqual(
    { site: popup.site, mode: popup.mode, blocked: popup.blocked, hidden: popup.hidden, domains: popup.domains },
    { site: "example.com", mode: "block", blocked: 1, hidden: 1, domains: "1 / 1" },
    "the popup names this site and counts this page"
  );
  ok(/% of \d+ requests?$/.test(popup.share), `and the blocked share (${popup.share})`);
  Assert.deepEqual(popup.hosts, ["example.com"], "blocked on this page, by host");
  Assert.deepEqual(popup.ads, ["Veil test ad"], "the ads hidden here");
  ok(/^All time: /.test(popup.totals), "and all-time totals");

  // Off: the page reloads with nothing blocked or hidden.
  await pickMode(tab, "off");
  await TestUtils.waitForCondition(() => /off for example\.com/.test(buttonTitle()), "the button shows off");
  await TestUtils.waitForCondition(() => /icons\/veil-off\.svg/.test(buttonIcon()), "with the off icon");
  await TestUtils.waitForCondition(() => buttonBadge() == "", "and no badge");
  const off = await fixtureState(tab.linkedBrowser);
  ok(off.adLoaded, "off for this site: nothing is blocked");
  isnot(off.banner, "none", "off for this site: nothing is hidden");

  // Block again.
  await pickMode(tab, "block");
  await waitForHidden(tab.linkedBrowser);
  const on = await fixtureState(tab.linkedBrowser);
  ok(!on.adLoaded, "block again: blocking is back");
  await TestUtils.waitForCondition(() => /icons\/veil\.svg/.test(buttonIcon()), "with the block icon");
  BrowserTestUtils.removeTab(tab);
});

// Veil mode, on a page at example.net with Firefox's test trackers: the
// tracking-protection test table stands in for its advertising list.
const VEIL_PAGE = "https://example.net/browser/browser/aequera/tests/browser/adveil_veil.html";

function veilState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const page = content.wrappedJSObject;
    const banner = content.document.getElementById("banner");
    const style = content.getComputedStyle(banner);
    return {
      ad: !!page.adLoaded,
      network: !!page.networkAdLoaded,
      tracker: !!page.trackerLoaded,
      social: !!page.socialLoaded,
      display: style.display,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      height: banner.offsetHeight,
    };
  });
}

// "collapsed" (block mode) or "veiled" (veil mode).
function waitForBanner(browser, expected) {
  return SpecialPowers.spawn(browser, [expected], want =>
    ContentTaskUtils.waitForCondition(() => {
      const style = content.getComputedStyle(content.document.getElementById("banner"));
      return want == "collapsed" ? style.display == "none" : style.opacity == "0";
    }, `banner ${want}`)
  );
}

add_task(async function test_veil_mode() {
  await waitForActive(true);
  const { UrlClassifierTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/UrlClassifierTestUtils.sys.mjs"
  );
  const { ContentBlockingAllowList } = ChromeUtils.importESModule(
    "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.trackingprotection.enabled", true],
      ["privacy.trackingprotection.socialtracking.enabled", true],
      ["aequera.adveil.veil.adTables", "mochitest2-track-simple"],
    ],
  });
  await UrlClassifierTestUtils.addTestTrackers();
  registerCleanupFunction(() => UrlClassifierTestUtils.cleanupTestTrackers());

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, VEIL_PAGE);
  await waitForBanner(tab.linkedBrowser, "collapsed");
  const blocked = await veilState(tab.linkedBrowser);
  Assert.deepEqual(
    { ad: blocked.ad, network: blocked.network, tracker: blocked.tracker, social: blocked.social, display: blocked.display },
    { ad: false, network: false, tracker: false, social: false, display: "none" },
    "block mode: ads, the ad network, and trackers are blocked; the ad element collapses"
  );

  await pickMode(tab, "veil");
  await waitForBanner(tab.linkedBrowser, "veiled");
  const veiled = await veilState(tab.linkedBrowser);
  ok(veiled.ad, "veil: the ad EasyList matches loads");
  ok(veiled.network, "veil: the ad network tracking protection blocks loads");
  ok(!veiled.tracker, "veil: the tracker EasyPrivacy matches stays blocked");
  ok(!veiled.social, "veil: the social tracker stays blocked");
  isnot(veiled.display, "none", "veil: the ad element keeps its box");
  Assert.greater(veiled.height, 0, "laid out, as a bait-element check expects");
  is(veiled.opacity, "0", "invisible");
  is(veiled.pointerEvents, "none", "and unclickable");
  ok(!ContentBlockingAllowList.includes(tab.linkedBrowser), "tracking protection stays on for the site");
  await TestUtils.waitForCondition(() => /veil mode/.test(buttonTitle()), "the button shows veil mode");
  await TestUtils.waitForCondition(() => /icons\/veil-veiled\.svg/.test(buttonIcon()), "with the veil icon");

  await pickMode(tab, "block");
  await waitForBanner(tab.linkedBrowser, "collapsed");
  const back = await veilState(tab.linkedBrowser);
  ok(!back.ad && !back.network, "block again: the ad and the ad network are blocked again");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_dashboard_sites() {
  await waitForActive(true);
  const dashboard = await openVault();
  const ready = () =>
    SpecialPowers.spawn(dashboard.linkedBrowser, [], () =>
      ContentTaskUtils.waitForCondition(() => content.document.body.dataset.ready, "dashboard rendered")
    );

  // Add a site from the form, typed as a URL: its site is the host without
  // "www.".
  await ready();
  await SpecialPowers.spawn(dashboard.linkedBrowser, [], () => {
    const doc = content.document;
    doc.getElementById("site-name").value = "https://www.example.com/some/page";
    doc.getElementById("site-mode").value = "veil";
    doc.getElementById("site-add").requestSubmit();
  });
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await readVault(dashboard);
    return state.sites.length == 1;
  }, "the site is listed");
  Assert.deepEqual(state.sites, [{ site: "example.com", mode: "veil" }], "listed as its site, veiled");

  // Change its mode: pages on the site follow.
  await ready();
  await SpecialPowers.spawn(dashboard.linkedBrowser, [], () => {
    const select = content.document.querySelector("#site-rows select");
    select.value = "off";
    select.dispatchEvent(new content.Event("change"));
  });
  await TestUtils.waitForCondition(async () => (await readVault(dashboard)).sites[0]?.mode == "off", "mode changed");
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  ok((await fixtureState(page.linkedBrowser)).adLoaded, "a site turned off in the dashboard is off on its pages");
  BrowserTestUtils.removeTab(page);

  // Remove it: back to the default (block).
  await ready();
  await SpecialPowers.spawn(dashboard.linkedBrowser, [], () => content.document.querySelector("#site-rows button").click());
  await TestUtils.waitForCondition(async () => (await readVault(dashboard)).sites.length == 0, "the site is removed");
  const after = await openFixture();
  ok(!(await fixtureState(after.linkedBrowser)).adLoaded, "removed: blocking is back");
  BrowserTestUtils.removeTab(after);
  BrowserTestUtils.removeTab(dashboard);
});
