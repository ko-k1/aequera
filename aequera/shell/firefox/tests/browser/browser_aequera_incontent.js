/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera in-content layer (incontent/aequera-in-content.css,
// patches/toolkit/in-content): Firefox's in-content pages take the Aequera
// palette and radius through Firefox's own design tokens, and the chrome
// registry serves Aequera illustrations in place of Firefox's mascot art.

const ACCENT = { light: "rgb(3, 105, 161)", dark: "rgb(78, 213, 255)" };
const CANVAS = { light: "rgb(246, 247, 249)", dark: "rgb(22, 24, 28)" };
const SURFACE = { light: "rgb(255, 255, 255)", dark: "rgb(31, 34, 40)" };

// Resolves a token on a page (custom properties compute to token streams,
// so read it back through a probe element's color).
function resolveIn(browser, token) {
  return SpecialPowers.spawn(browser, [token], async name => {
    const { document } = content;
    await ContentTaskUtils.waitForCondition(() => document.readyState == "complete", "page loaded");
    const probe = document.createElement("div");
    probe.style.color = `var(${name})`;
    document.documentElement.append(probe);
    const color = content.getComputedStyle(probe).color;
    probe.remove();
    return {
      color,
      scheme: content.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      forced: content.matchMedia("(forced-colors)").matches,
    };
  });
}

add_task(async function test_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  ok(defaults.getBoolPref("aequera.incontent.enabled"), "in-content layer on");
  ok(!defaults.getBoolPref("browser.preferences.moreFromMozilla"), "no More from Mozilla pane");
  ok(!defaults.getBoolPref("browser.contentblocking.report.show_mobile_app"), "no mobile app promo");
  ok(defaults.getBoolPref("browser.contentblocking.report.hide_vpn_banner"), "no VPN banner");
});

add_task(async function test_illustrations_are_overridden() {
  // [Firefox URL, intrinsic width, height]: Aequera's art keeps the size
  // pages that do not size the image rely on.
  for (const [url, width, height] of [
    ["chrome://global/skin/illustrations/kit-happy.svg", 50, 40],
    ["chrome://global/skin/illustrations/kit-concerned.svg", 50, 40],
    ["chrome://global/skin/illustrations/kit-confetti.svg", 80, 60],
    ["chrome://global/skin/illustrations/kit-holding-lock.svg", 80, 100],
    ["chrome://global/skin/illustrations/kit-in-circle.svg", 120, 120],
    ["chrome://browser/skin/preferences/fox-ai.svg", 62, 63],
    ["chrome://global/skin/illustrations/no-connection.svg", 220, 156],
    ["chrome://global/skin/illustrations/security-error.svg", 162, 159],
    ["chrome://global/skin/illustrations/shield-check.svg", 100, 106],
    ["chrome://global/skin/illustrations/shield-alert.svg", 100, 106],
  ]) {
    const text = await (await fetch(url)).text();
    ok(text.includes("<!-- Aequera:"), `${url} serves Aequera's illustration`);
    ok(text.includes(`width="${width}" height="${height}"`), `${url} keeps its ${width}x${height} size`);
  }
});

add_task(async function test_settings() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const accent = await resolveIn(browser, "--color-accent-primary");
    is(accent.color, ACCENT[accent.scheme], `Aequera accent (${accent.scheme})`);
    const page = await SpecialPowers.spawn(browser, [], async () => {
      const { document } = content;
      const nav = document.getElementById("categories");
      // `selected` is a property, not a reflected attribute.
      const selectedButton = () =>
        [...nav.querySelectorAll("moz-page-nav-button")]
          .find(b => b.selected)
          ?.shadowRoot?.querySelector("button[selected]");
      await ContentTaskUtils.waitForCondition(selectedButton, "a category is selected");
      const selected = selectedButton();
      const bar = content.getComputedStyle(selected, "::before");
      const navStyle = content.getComputedStyle(nav);
      const viewport = content.innerHeight;
      const navRect = nav.getBoundingClientRect();
      const more = document.getElementById("category-more-from-mozilla");
      // A row after the first one in a box group: its separator is inset.
      const row = [...document.querySelectorAll("moz-box-group > :not(:first-child)")]
        .map(c => c.querySelector("moz-box-item, moz-box-link, moz-box-button"))
        .find(r => r && r.getBoundingClientRect().height);
      const sep = row && content.getComputedStyle(row, "::before");
      const search = document.getElementById("searchInput");
      return {
        canvas: content.getComputedStyle(document.documentElement).backgroundColor,
        selectedBackground: content.getComputedStyle(selected).backgroundColor,
        bar: [bar.width, bar.backgroundColor],
        navCard: [navStyle.backgroundColor, navStyle.borderTopLeftRadius],
        navFloats: navRect.top > 0 && navRect.bottom < viewport,
        rowBorder: row && content.getComputedStyle(row).borderTopColor,
        separator: sep && [sep.content, parseFloat(sep.left), parseFloat(sep.right), sep.borderTopWidth],
        searchBorder: content.getComputedStyle(search.shadowRoot.querySelector("#input")).borderTopStyle,
        searchLine: content.getComputedStyle(search).boxShadow,
        moreShown: !!more && !more.hidden && more.getBoundingClientRect().height > 0,
      };
    });
    is(page.canvas, CANVAS[accent.scheme], "Settings sits on the Aequera canvas");
    is(page.selectedBackground, "rgba(0, 0, 0, 0)", "selected category has no fill");
    Assert.deepEqual(page.bar, ["3px", accent.color], "selected category: accent bar on its left edge");
    Assert.deepEqual(page.navCard, [SURFACE[accent.scheme], "12px"], "the navigation is a card");
    ok(page.navFloats, "the navigation card floats inside the viewport");
    ok(page.separator, "a box group with more than one row is shown");
    is(page.rowBorder, "rgba(0, 0, 0, 0)", "rows in a group draw no full-width rule");
    is(page.separator[0], '""', "rows after the first get a separator");
    Assert.greater(page.separator[1], 0, "separator inset from the left edge");
    Assert.greater(page.separator[2], 0, "separator inset from the right edge");
    is(page.separator[3], "1px", "separator is a hairline");
    is(page.searchBorder, "none", "search field has no box");
    // 1px, or 2px (accent) when Settings has focused the field.
    ok(/0px -[12]px 0px 0px inset/.test(page.searchLine), `search field is one bottom line: ${page.searchLine}`);
    ok(!page.moreShown, "no More from Mozilla category");
  });
});

add_task(async function test_cert_error_card() {
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    const loaded = BrowserTestUtils.waitForErrorPage(browser);
    BrowserTestUtils.startLoadingURIString(browser, "https://expired.example.com/");
    await loaded;
    const page = await SpecialPowers.spawn(browser, [], async () => {
      const { document } = content;
      const card = await ContentTaskUtils.waitForCondition(
        () => document.querySelector("net-error-card")?.shadowRoot?.querySelector(".felt-privacy-container"),
        "error card rendered"
      );
      const img = card.querySelector(".img-container > img");
      await ContentTaskUtils.waitForCondition(() => img.complete && img.naturalWidth > 0, "illustration loaded");
      const style = content.getComputedStyle(card);
      return {
        background: style.backgroundColor,
        radius: style.borderTopLeftRadius,
        src: img.getAttribute("src"),
        scheme: content.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      };
    });
    is(page.background, SURFACE[page.scheme], "the message sits on an Aequera surface card");
    is(page.radius, "12px", "card radius from the shell's radius family");
    is(page.src, "chrome://global/skin/illustrations/security-error.svg", "Firefox's URL, Aequera's art");
  });
});

add_task(async function test_pref_off_restores_firefox_tokens() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.incontent.enabled", false]] });
  try {
    await BrowserTestUtils.withNewTab("about:preferences", async browser => {
      const accent = await resolveIn(browser, "--color-accent-primary");
      isnot(accent.color, ACCENT[accent.scheme], `Firefox's accent with the pref off: ${accent.color}`);
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_forced_colors_keep_firefox_tokens() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.display.document_color_use", 2]] });
  try {
    await BrowserTestUtils.withNewTab("about:preferences", async browser => {
      const accent = await resolveIn(browser, "--color-accent-primary");
      if (!accent.forced) {
        todo(false, "forced colors did not apply to about:preferences in this configuration");
        return;
      }
      isnot(accent.color, ACCENT[accent.scheme], `system colors under forced colors: ${accent.color}`);
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_private_page_keeps_its_design() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const browser = win.gBrowser.selectedBrowser;
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec == "about:privatebrowsing" && !browser.webProgress.isLoadingDocument,
      "private page loaded"
    );
    const canvas = await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(() => content.document.readyState == "complete", "loaded");
      return content.getComputedStyle(content.document.documentElement).backgroundColor;
    });
    ok(
      ["rgb(244, 242, 248)", "rgb(28, 26, 35)"].includes(canvas),
      `the private page's own violet-tinted canvas: ${canvas}`
    );
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
