/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Ad Veil (docs/design/ADS.md): the built-in add-on is installed, holds
// only its declared permissions, blocks a request EasyList matches, hides an
// element a generic EasyList rule matches, and aequera.adveil.enabled turns
// both off and on. Slice 2: the vault records hidden ads and blocked
// requests (never from private windows), and the address bar popup turns Ad
// Veil off and on for a site.

// Veil mode waits out a silent ad server (10 s) on top of the rest.
requestLongerTimeout(2);

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { AppUiTestDelegate } = ChromeUtils.importESModule("resource://testing-common/AppUiTestDelegate.sys.mjs");

const ID = "adveil@aequera";
const PREF = "aequera.adveil.enabled";
const PAGE = "https://example.com/browser/browser/aequera/tests/browser/adveil_page.html";
// The fixtures' ad image, and a page whose ad a script draws into an iframe
// without a src after the slot exists (how real ad slots work).
const AD_IMAGE = "https://example.com/browser/browser/aequera/tests/browser/adveil_ad.svg";
const FRAME_PAGE = "https://example.com/browser/browser/aequera/tests/browser/adveil_frame.html";

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
        // Its emptied slot follows when the page is next idle.
        await ContentTaskUtils.waitForCondition(() => display("slot") == "none", "slot folded");
      }
      const page = content.wrappedJSObject;
      return {
        adLoaded: !!page.adLoaded,
        appLoaded: !!page.appLoaded,
        banner: display("banner"),
        slot: display("slot"),
        story: display("story"),
        storyText: display("story-text"),
        article: display("article"),
      };
    })
  );
}

// Runs `task` and fails if Ad Veil opened any network channel meanwhile
// (every channel is checked for the add-on's principal), except to the
// `allowed` URLs (a saved ad image: docs/design/ADS.md, Network).
async function withoutOwnRequests(task, allowed = []) {
  const own = [];
  let seen = 0;
  const observe = subject => {
    const { loadInfo, URI } = subject.QueryInterface(Ci.nsIChannel);
    seen++;
    const principals = [loadInfo.loadingPrincipal, loadInfo.triggeringPrincipal];
    if (principals.some(p => p?.addonId == ID) && !allowed.includes(URI.spec)) {
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

// The dashboard, as rendered (every tab's content is in the document). Each
// ad on the vault's wall is read through its inspector, as a person would.
async function readVault(tab) {
  await BrowserTestUtils.reloadTab(tab);
  return SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(() => doc.body.dataset.ready, "dashboard rendered");
    const $ = id => doc.getElementById(id);
    const ads = [];
    for (const tile of doc.querySelectorAll(".ad-tile")) {
      tile.querySelector(".ad-open").click();
      await ContentTaskUtils.waitForCondition(() => !$("inspector").hidden, "inspector open");
      ads.push({
        link: $("ins-target").querySelector("a")?.href || null,
        site: $("ins-page").querySelector(".site").textContent,
        page: $("ins-page").querySelector("a")?.href || null,
        text: $("ins-text").textContent || tile.querySelector(".text-ad-words")?.textContent || "",
        creative: tile.dataset.creative,
        image: tile.querySelector("img")?.getAttribute("src") || null,
        inspectedImage: $("ins-media").querySelector("img")?.getAttribute("src") || null,
        count: Number(tile.querySelector(".count-badge")?.textContent || 1),
        seen: $("ins-seen").textContent,
        index: $("ins-nav").hidden ? null : $("ins-index").textContent,
      });
      $("ins-close").click();
    }
    return {
      blocked: Number($("chart-total").textContent.replace(/\D/g, "")),
      hosts: [...doc.querySelectorAll("#top-hosts li .name")].map(s => s.textContent),
      found: Number($("v-found").textContent.replace(/\D/g, "")),
      unique: Number($("v-unique").textContent.replace(/\D/g, "")),
      timeline: [...doc.querySelectorAll("#timeline-table tr")].map(row => Number(row.cells[1].textContent.replace(/\D/g, ""))),
      ads,
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
  is(result.slot, "none", "its slot, left with only an 'Advertisement' label, is hidden too");
  isnot(result.story, "none", "the box around it, with content of its own, stays");
  isnot(result.storyText, "none", "with its content");
  isnot(result.article, "none", "other elements are untouched");
});

// Procedural filters (procedural.js, the add-on's own file, run in a real
// page): each operator adblock-rust produces, and a filter the browser
// rejects matching nothing.
add_task(async function test_procedural_filters() {
  const url = "https://example.com/browser/browser/aequera/tests/browser/adveil_procedural.html?section=deals";
  await BrowserTestUtils.withNewTab(url, browser =>
    SpecialPowers.spawn(browser, [], () => {
      const scope = {};
      Services.scriptloader.loadSubScript("resource://builtin-addons/adveil/procedural.js", scope);
      const run = (...ops) =>
        scope.VeilProcedural.run({ selector: ops.map(([type, arg]) => ({ type, arg })) }, content.document).map(e => e.id);
      Assert.deepEqual(run(["css-selector", ".card"], ["has-text", "Sponsored"]), ["card-sponsored"], "has-text");
      Assert.deepEqual(run(["css-selector", ".card"], ["has-text", "/promot(ed|ion)/i"]), ["card-promo"], "has-text, a regex");
      Assert.deepEqual(run(["css-selector", ".label"], ["has-text", "Ad"], ["upward", "2"]), ["outer"], "upward, levels");
      Assert.deepEqual(run(["css-selector", ".label"], ["upward", ".wrap"]), ["wrap"], "upward, a selector");
      Assert.deepEqual(run(["css-selector", ".note"], ["min-text-length", "20"]), ["long"], "min-text-length");
      Assert.deepEqual(run(["css-selector", "div"], ["matches-attr", '"data-slot-name"="/leaderboard/"']), ["attr"], "matches-attr");
      Assert.deepEqual(run(["css-selector", ".bar"], ["matches-css", "position: fixed"]), ["fixed"], "matches-css");
      Assert.deepEqual(run(["css-selector", ".card"], ["matches-path", "/section=deals/"]), ["card-sponsored", "card-story", "card-promo"], "matches-path");
      Assert.deepEqual(run(["css-selector", ".card"], ["matches-path", "/section=news/"]), [], "matches-path, elsewhere");
      Assert.deepEqual(run(["xpath", "//div[contains(@class, 'card')][contains(., 'birds')]"]), ["card-story"], "xpath");
      Assert.deepEqual(run(["css-selector", "#first"], ["css-selector", "+ .row"]), ["second"], "a sibling selector");
      Assert.deepEqual(run(["css-selector", "#first"], ["css-selector", "~ .row"]), ["second", "third"], "following siblings");
      Assert.deepEqual(run(["css-selector", "#outer"], ["css-selector", "> .wrap .label"]), ["label"], "a descendant selector");
      Assert.deepEqual(run(["css-selector", "div:::bad"]), [], "a selector the browser rejects matches nothing");
      Assert.deepEqual(run(["css-selector", ".card"], ["has-text", "/(/"]), [], "an invalid regex matches nothing");
      Assert.deepEqual(run(["css-selector", ".card"], ["eval", "x"]), [], "an unknown operator matches nothing");
    })
  );
});

add_task(async function test_pref_turns_it_off_and_on() {
  Services.prefs.setBoolPref(PREF, false);
  await waitForActive(false);
  const off = await loadFixture({ hidden: false });
  ok(off.adLoaded, "off: nothing is blocked");
  isnot(off.banner, "none", "off: nothing is hidden");

  // Startup (engine load, list compile) must not touch the network; saving
  // the fixture ad's image is the one request it may make.
  await withoutOwnRequests(async () => {
    Services.prefs.setBoolPref(PREF, true);
    await waitForActive(true);
    const on = await loadFixture({ hidden: true });
    ok(!on.adLoaded, "on again: blocking is back");
    is(on.banner, "none", "on again: hiding is back");
  }, [AD_IMAGE]);
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

  // Save ad images (on by default): the image the page loaded is saved once
  // and shown from the vault.
  await TestUtils.waitForCondition(async () => {
    state = await readVault(vault);
    return state.ads[0]?.image?.startsWith("blob:");
  }, "the saved ad image is shown");
  ok(true, "the vault shows the ad's saved image");

  // Using the page and reading the vault again makes no request: the image
  // is saved already, and viewing never fetches.
  await withoutOwnRequests(async () => {
    await BrowserTestUtils.reloadTab(page);
    await waitForHidden(page.linkedBrowser);
    await readVault(vault);
  });

  // Save ad images off: a new ad is recorded without its image, and nothing
  // is fetched.
  await SpecialPowers.spawn(vault.linkedBrowser, [], () => content.document.getElementById("set-images").click());
  await clearVault(vault);
  await withoutOwnRequests(async () => {
    await BrowserTestUtils.reloadTab(page);
    await waitForHidden(page.linkedBrowser);
    await TestUtils.waitForCondition(async () => {
      state = await readVault(vault);
      return state.ads.length > 0;
    }, "the ad is recorded again");
  });
  ok(!state.ads[0].image, "without its image");
  await SpecialPowers.spawn(vault.linkedBrowser, [], () => content.document.getElementById("set-images").click());
  BrowserTestUtils.removeTab(page);
  await clearVault(vault);
  BrowserTestUtils.removeTab(vault);
});

add_task(async function test_vault_reads_ads_drawn_in_frames() {
  await waitForActive(true);
  const vault = await openVault();
  await clearVault(vault);
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, FRAME_PAGE);
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await readVault(vault);
    return state.ads.length > 0 && state.ads[0].image;
  }, "the framed ad reaches the vault, with its image");
  Assert.deepEqual(
    state.ads.map(({ link, text, creative }) => ({ link, text, creative })),
    // The vault links to where the ad leads (the click URL's adurl), so
    // following it is not an ad click.
    [{ link: "https://example.net/advertiser?ref=veil", text: "Framed test ad", creative: AD_IMAGE }],
    "link, words, and image from inside the frame the script drew"
  );
  BrowserTestUtils.removeTab(page);
  await clearVault(vault);
  BrowserTestUtils.removeTab(vault);
});

// The vault as AdNauseam shows it: the same ad found again is one ad with a
// count, the inspector steps through each time it was found, the timeline's
// days filter the wall, and an ad can be removed.
add_task(async function test_vault_groups_filters_and_removes_ads() {
  await waitForActive(true);
  const vault = await openVault();
  await clearVault(vault);
  const page = await openFixture();
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await readVault(vault);
    return state.ads.length == 1;
  }, "the ad is found");
  is(state.ads[0].count, 1, "found once: no count");
  is(state.ads[0].index, null, "found once: nothing to step through");

  // A reload is a new page view: the ad is found again.
  await BrowserTestUtils.reloadTab(page);
  await waitForHidden(page.linkedBrowser);
  await TestUtils.waitForCondition(async () => {
    state = await readVault(vault);
    return state.found == 2;
  }, "the ad is found again");
  is(state.ads.length, 1, "the same ad is one ad on the wall");
  is(state.unique, 1, "one different ad");
  is(state.ads[0].count, 2, "with its count");
  is(state.ads[0].index, "1 / 2", "the inspector steps through both times");
  ok(state.ads[0].seen.startsWith("2 times on 1 site"), `seen: ${state.ads[0].seen}`);
  is(state.ads[0].page, PAGE, "found on the fixture page");
  ok(state.ads[0].inspectedImage?.startsWith("blob:"), "the inspector shows the saved image");
  Assert.deepEqual(state.timeline, [2], "two ads found today");

  await SpecialPowers.spawn(vault.linkedBrowser, [], async () => {
    const doc = content.document;
    const $ = id => doc.getElementById(id);
    const tiles = () => doc.querySelectorAll(".ad-tile").length;
    // A day before today, without ads: the canvas empties.
    const from = $("range-from");
    from.value = from.min;
    $("range-to").value = from.min;
    $("range-to").dispatchEvent(new content.Event("change"));
    from.dispatchEvent(new content.Event("change"));
    await ContentTaskUtils.waitForCondition(() => tiles() == 0, "a day without ads shows none");
    ok(!$("vault-none").hidden, "and says so");
    ok(doc.querySelector("#timeline g.out"), "the timeline marks the days left out");
    $("range-all").click();
    await ContentTaskUtils.waitForCondition(() => tiles() == 1, "all days show the ad again");

    // Kind filter: the fixture's ad has an image.
    $("vault-kind").value = "text";
    $("vault-kind").dispatchEvent(new content.Event("change"));
    await ContentTaskUtils.waitForCondition(() => tiles() == 0, "no text ad");
    $("vault-kind").value = "";
    $("vault-kind").dispatchEvent(new content.Event("change"));
    await ContentTaskUtils.waitForCondition(() => tiles() == 1, "every kind again");

    // The canvas: the wheel zooms around the pointer.
    const stage = $("stage");
    const world = $("world");
    const ratio = () => parseInt($("zoom-ratio").textContent, 10);
    const before = ratio();
    const box = stage.getBoundingClientRect();
    stage.dispatchEvent(
      new content.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })
    );
    Assert.greater(ratio(), before, `the wheel zooms in (${before}% to ${ratio()}%)`);
    const zoomed = world.style.transform;

    // A click goes to the ad: the others dim, the panel shows it beside the
    // canvas; Escape returns the view.
    doc.querySelector(".ad-open").click();
    ok(stage.classList.contains("inspecting"), "the canvas dims the other ads");
    ok(doc.querySelector(".ad-tile").classList.contains("inspected"), "and marks this one");
    ok(!$("inspector").hidden, "the details panel is open");
    isnot(world.style.transform, zoomed, "the view goes to the ad");
    doc.dispatchEvent(new content.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok($("inspector").hidden, "Escape closes it");
    ok(!stage.classList.contains("inspecting"), "and the others are shown again");
    is(world.style.transform, zoomed, "the view is back where it was");

    // The inspector's next step shows the earlier time.
    doc.querySelector(".ad-open").click();
    $("ins-next").click();
    is($("ins-index").textContent, "2 / 2", "stepped to the first time found");
    ok($("ins-next").disabled, "the last step");

    // Remove: two clicks.
    $("ins-remove").click();
    ok(!$("inspector").hidden, "the first click only asks");
    $("ins-remove").click();
    await ContentTaskUtils.waitForCondition(() => $("inspector").hidden && !doc.querySelector(".ad-tile"), "the ad is removed");
  });
  state = await readVault(vault);
  is(state.ads.length, 0, "removed from the vault");
  is(state.found, 0, "every time it was found");
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
    const bait = content.document.getElementById("bait");
    const promo = content.document.getElementById("promo");
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
      baitHeight: bait.offsetHeight,
      baitLaidOut: !!bait.offsetParent,
      baitOpacity: content.getComputedStyle(bait).opacity,
      // The ad only its request names (#promo).
      promoDisplay: content.getComputedStyle(promo).display,
      promoPosition: content.getComputedStyle(promo).position,
      promoOpacity: content.getComputedStyle(promo).opacity,
      promoLoaded: promo.complete && promo.naturalWidth > 0,
      promoBoxHeight: content.document.getElementById("promo-box").offsetHeight,
    };
  });
}

// Waits for the promo image to be hidden (block: not rendered; veil: out of
// the flow and invisible).
function waitForPromo(browser, want) {
  return SpecialPowers.spawn(browser, [want], expected =>
    ContentTaskUtils.waitForCondition(() => {
      const style = content.getComputedStyle(content.document.getElementById("promo"));
      return expected == "collapsed" ? style.display == "none" : style.position == "absolute" && style.opacity == "0";
    }, `promo ${expected}`)
  );
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
  // An ad only its request names: cancelled, and its image hidden instead
  // of left as a broken box, its emptied wrapper with it.
  await waitForPromo(tab.linkedBrowser, "collapsed");
  const blockedPromo = await veilState(tab.linkedBrowser);
  ok(!blockedPromo.promoLoaded, "block mode: the ad image a network rule names is not loaded");
  is(blockedPromo.promoDisplay, "none", "and its element is hidden, not left as a broken box");
  is(blockedPromo.promoBoxHeight, 0, "its emptied wrapper with it");

  await pickMode(tab, "veil");
  await waitForBanner(tab.linkedBrowser, "veiled");
  await waitForPromo(tab.linkedBrowser, "veiled");
  const veiled = await veilState(tab.linkedBrowser);
  // Veil mode hides what block mode would cancel, at its element.
  ok(veiled.promoLoaded, "veil: the ad image a network rule names loads");
  is(veiled.promoPosition, "absolute", "its element is taken out of the flow, at its own size");
  is(veiled.promoOpacity, "0", "invisible");
  is(veiled.promoBoxHeight, 0, "the page closes up around it");
  ok(veiled.ad, "veil: the ad EasyList matches loads");
  ok(veiled.network, "veil: the ad network tracking protection blocks loads");
  // EasyPrivacy lists whole ad networks and bidders, so veil mode lets its
  // matches through (AdNauseam's model); tracking protection's own tracker
  // blocks (here the social tracker) stay.
  ok(veiled.tracker, "veil: what EasyPrivacy matches loads too");
  ok(!veiled.social, "veil: the social tracker stays blocked by tracking protection");
  isnot(veiled.display, "none", "veil: the ad element stays rendered (its ad loads and is recorded)");
  is(veiled.height, 0, "collapsed: the page closes up around it");
  is(veiled.opacity, "0", "invisible");
  is(veiled.pointerEvents, "none", "and unclickable");
  is(veiled.baitHeight, 1, "an empty element (a bait) keeps 1px, as a bait check expects");
  ok(veiled.baitLaidOut, "and stays laid out");
  is(veiled.baitOpacity, "0", "invisible too");
  // An ad server veil mode let through that never answers is cancelled, so
  // the page still finishes loading.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.wrappedJSObject.pageLoaded && content.wrappedJSObject.stallFailed,
      "the silent ad server is cancelled and the page loads",
      500,
      40
    )
  );
  ok(true, "veil: a silent ad server does not hold the page's load");
  ok(!ContentBlockingAllowList.includes(tab.linkedBrowser), "tracking protection stays on for the site");
  await TestUtils.waitForCondition(() => /veil mode/.test(buttonTitle()), "the button shows veil mode");
  await TestUtils.waitForCondition(() => /icons\/veil-veiled\.svg/.test(buttonIcon()), "with the veil icon");

  // The vault has it, as any hidden ad: its image and where it leads.
  const PROMO = "https://example.net/browser/browser/aequera/tests/browser/adbanners/veil_promo.svg";
  const vault = await openVault();
  let promo;
  await TestUtils.waitForCondition(async () => {
    promo = (await readVault(vault)).ads.find(ad => ad.creative == PROMO);
    return promo;
  }, "the ad only its request names reaches the vault");
  is(promo.link, "https://example.org/promo?ref=veil", "with where it leads");
  BrowserTestUtils.removeTab(vault);
  await BrowserTestUtils.switchTab(gBrowser, tab);

  await pickMode(tab, "block");
  await waitForBanner(tab.linkedBrowser, "collapsed");
  const back = await veilState(tab.linkedBrowser);
  ok(!back.ad && !back.network, "block again: the ad and the ad network are blocked again");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_ad_shims_follow_ad_veil() {
  // Firefox's ad SmartBlock shims would replace the ads veil mode lets
  // through with stubs: off while Ad Veil is on, Firefox's again without it.
  const shim = "extensions.webcompat.disabled_shims.GooglePublisherTags";
  const analytics = "extensions.webcompat.disabled_shims.GoogleAnalyticsAndTagManager";
  ok(Services.prefs.getBoolPref(shim), "ad shims off while Ad Veil is on");
  ok(!Services.prefs.getBoolPref(analytics, false), "analytics shims untouched");
  Services.prefs.setBoolPref(PREF, false);
  await waitForActive(false);
  ok(!Services.prefs.getBoolPref(shim), "Ad Veil off: Firefox's ad shims are back");
  Services.prefs.setBoolPref(PREF, true);
  await waitForActive(true);
  ok(Services.prefs.getBoolPref(shim), "Ad Veil on again: off again");
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
