/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera private browsing page (privatebrowsing/aequera-private.css,
// patches/browser/privatebrowsing): Firefox's about:privatebrowsing with its
// text intact, without the Firefox artwork, in-page search box, or promos,
// under the Aequera brand row with the branding's private mark, centered
// like the new tab page.

add_task(async function test_promos_off_by_default() {
  const defaults = Services.prefs.getDefaultBranch("");
  for (const pref of ["browser.vpn_promo.enabled", "browser.promo.relay.enabled", "browser.promo.pin.enabled"]) {
    is(defaults.getBoolPref(pref), false, `${pref} off`);
  }
});

add_task(async function test_private_window_page() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const browser = win.gBrowser.selectedBrowser;
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec == "about:privatebrowsing" && !browser.webProgress.isLoadingDocument,
      "private page loaded"
    );
    is(browser.currentURI.spec, "about:privatebrowsing", "private window opens the private page");
    const page = await SpecialPowers.spawn(browser, [], async () => {
      const { document } = content;
      await ContentTaskUtils.waitForCondition(() => document.readyState == "complete", "page initialized");
      await document.l10n.ready;
      const shown = selector => {
        const el = document.querySelector(selector);
        return !!el && content.getComputedStyle(el).display != "none" && el.getBoundingClientRect().height > 0;
      };
      const logoEl = document.querySelector(".logo");
      const logo = content.getComputedStyle(logoEl);
      const wordmark = document.querySelector(".logo-and-wordmark .wordmark");
      const rect = el => el.getBoundingClientRect();
      const row = rect(document.querySelector(".logo-and-wordmark"));
      const link = document.getElementById("private-browsing-myths");
      return {
        sheet: [...document.styleSheets].some(s => s.href?.endsWith("/aequera/privatebrowsing/aequera-private.css")),
        search: shown(".search-inner-wrapper"),
        wordmark: shown(".logo-and-wordmark .wordmark") && content.getComputedStyle(wordmark).backgroundImage,
        wordmarkSize: [rect(wordmark).width, rect(wordmark).height],
        rowCenter: row.left + row.width / 2,
        blockCenter: (row.top + rect(link).bottom) / 2,
        viewport: [content.innerWidth, content.innerHeight],
        banner: shown("#search-banner"),
        promo: shown(".promo") || shown(".nova-promo-wrapper"),
        artwork: content.getComputedStyle(document.body, "::before").display,
        logoIcon: logo.backgroundImage,
        logoSize: [logo.width, logo.height],
        heading: [...document.querySelectorAll(".nova-tagline, #info-title")]
          .filter(el => content.getComputedStyle(el).display != "none" && !el.hidden)
          .map(el => el.textContent.trim())
          .join(" "),
        link: shown("#private-browsing-myths") && document.getElementById("private-browsing-myths").href,
      };
    });
    ok(page.sheet, "Aequera stylesheet loaded");
    ok(!page.search, "no in-page search box: the address bar is the search");
    ok(page.wordmark.includes("chrome://branding/content/firefox-wordmark.svg"), "the branding's wordmark");
    Assert.deepEqual(page.wordmarkSize, [104, 32], "in the new tab page's size");
    ok(!page.banner, "no search-engine banner");
    ok(!page.promo, "no promo");
    is(page.artwork, "none", "no Firefox artwork");
    ok(page.logoIcon.includes("chrome://branding/content/about-logo-private.svg"), "the branding's private mark");
    Assert.deepEqual(page.logoSize, ["48px", "48px"], "in the new tab page's size");
    const [width, height] = page.viewport;
    Assert.less(Math.abs(page.rowCenter - width / 2), 1, "brand row centered horizontally");
    Assert.greater(page.blockCenter, height * 0.35, "block in the middle of the page");
    Assert.lessOrEqual(page.blockCenter, height / 2 + 1, "never below the center");
    ok(page.heading.length > 0, `Firefox's localized heading is shown: ${page.heading}`);
    ok(page.link, "the explanation link stays");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function test_pref_off_restores_firefox_design() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.privatebrowsing.enabled", false]] });
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const browser = win.gBrowser.selectedBrowser;
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec == "about:privatebrowsing" && !browser.webProgress.isLoadingDocument,
      "private page loaded"
    );
    const search = await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "loaded");
      const el = content.document.querySelector(".search-inner-wrapper");
      return content.getComputedStyle(el).display != "none";
    });
    ok(search, "Firefox's design (with its search box) is back with the pref off");
  } finally {
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_normal_window_page() {
  // In a normal window the page offers to open a private one, unchanged.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:privatebrowsing", true);
  const button = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const el = content.document.getElementById("startPrivateBrowsing");
    return content.getComputedStyle(el).display != "none";
  });
  ok(button, "Open a private window is offered");
  BrowserTestUtils.removeTab(tab);
});
