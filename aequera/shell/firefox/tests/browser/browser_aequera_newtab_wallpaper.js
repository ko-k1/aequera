/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera new tab page, custom wallpaper (aequera/shell/firefox/newtab):
// added from the Customize panel, saved by Firefox's wallpaper feed in the
// profile, shown from moz-newtab-wallpaper:, text and icons following the
// image's lightness (white below L* 50, black from 50 with the mark
// darkened), and removed again.

ChromeUtils.defineESModuleGetters(this, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  NewTabPagePreloading: "moz-src:///browser/components/tabbrowser/NewTabPagePreloading.sys.mjs",
  WallpaperFeed: "resource://newtab/lib/Wallpapers/WallpaperFeed.sys.mjs",
});

const { MockFilePicker } = SpecialPowers;

const WALLPAPER_PREFS = [
  "wallpaper",
  "initialWallpaper",
  "customWallpaper.uuid",
  "customWallpaper.theme",
  "customWallpaper.position",
  "customWallpaper.nextNumber",
].map(name => `browser.newtabpage.activity-stream.newtabWallpapers.${name}`);

const WHITE_TEXT = "rgb(251, 251, 254)";
const BLACK_TEXT = "rgb(21, 20, 26)";
// The mark's deepened colors (aequera-newtab.css), the same on every background.
const MARK_DEEP = "brightness(0.7) saturate(1.6)";

/** A PNG of one gray level, written to a temporary file. */
async function grayImage(level, name) {
  const canvas = new OffscreenCanvas(64, 40);
  const context = canvas.getContext("2d");
  context.fillStyle = `rgb(${level} ${level} ${level})`;
  context.fillRect(0, 0, 64, 40);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const path = PathUtils.join(PathUtils.tempDir, `aequera-wallpaper-${name}.png`);
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  return IOUtils.getFile(path);
}

/** "white", "black", or the raw value: the shadow color in a computed
 *  text-shadow or drop-shadow(). */
function shadowColor(value) {
  if (value.includes("rgba(255, 255, 255")) {
    return "white";
  }
  return value.includes("rgba(0, 0, 0") ? "black" : value;
}

/** Text and icons carry the shadow opposite to the text color. */
function checkShadow(page, expected, what) {
  is(shadowColor(page.textShadow), expected, `${expected} shadow under the text ${what}`);
  is(shadowColor(page.wordmarkFilter), expected, `and under the wordmark ${what}`);
  is(shadowColor(page.markFilter), expected, `and under the mark ${what}`);
}

/** The page's wallpaper and the colors it puts on text and icons. */
function readPage(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const { document } = content;
    const style = sel => content.getComputedStyle(document.querySelector(sel));
    const layer = document.getElementById("wallpaper");
    return {
      shown: !layer.hidden && style("#wallpaper").display != "none",
      image: style("#wallpaper").backgroundImage,
      theme: document.documentElement.dataset.wallpaper ?? null,
      text: style("main").color,
      wordmarkFill: style(".brand-wordmark").fill,
      markFilter: style(".brand-mark").filter,
      // A probe tile: the page may have no shortcuts to read one from.
      tileBackdrop: (() => {
        const probe = document.createElement("div");
        probe.className = "tile-icon";
        document.getElementById("shortcuts").append(probe);
        const value = content.getComputedStyle(probe).backdropFilter;
        probe.remove();
        return value;
      })(),
      wordmarkFilter: style(".brand-wordmark").filter,
      textShadow: style("#shortcuts-empty").textShadow,
      removable: !document.getElementById("wallpaper-remove").hidden,
    };
  });
}

async function openPanel(browser) {
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("customize-button").focus());
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.getElementById("customize-panel").matches(":popover-open"),
      "Customize panel open"
    )
  );
}

/** Add `file` as the wallpaper with the keyboard, through the file picker. */
async function addWallpaper(browser, file) {
  const picked = new Promise(resolve => {
    MockFilePicker.showCallback = () => {
      MockFilePicker.setFiles([file]);
      resolve();
    };
  });
  await openPanel(browser);
  const focused = await SpecialPowers.spawn(browser, [], () => content.document.activeElement.id);
  is(focused, "wallpaper-add", "the panel opens on Add an image");
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await picked;
}

async function waitForTheme(browser, theme) {
  let page;
  await TestUtils.waitForCondition(async () => {
    page = await readPage(browser);
    return page.theme == theme && page.shown;
  }, `wallpaper shown as ${theme}`);
  return page;
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [["browser.newtab.preload", false]] });
  NewTabPagePreloading.removePreloadedBrowser(window);
  // Automation may leave the new tab backend without its other feeds; the
  // wallpaper feed is the one that saves the file, so make sure it runs.
  const { store } = AboutNewTab.activityStream;
  if (![...store.feeds.values()].some(feed => feed instanceof WallpaperFeed)) {
    const feed = new WallpaperFeed();
    feed.store = store;
    store.feeds.set("feeds.wallpaperfeed", feed);
    registerCleanupFunction(() => store.feeds.delete("feeds.wallpaperfeed"));
  }
  MockFilePicker.init(window.browsingContext);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  registerCleanupFunction(async () => {
    MockFilePicker.cleanup();
    WALLPAPER_PREFS.forEach(pref => Services.prefs.clearUserPref(pref));
    await IOUtils.remove(PathUtils.join(PathUtils.profileDir, "wallpaper"), { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function test_plain_page_shadow_in_both_themes() {
  for (const [dark, text, shadow] of [
    [0, BLACK_TEXT, "white"],
    [1, WHITE_TEXT, "black"],
  ]) {
    await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", dark]] });
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
    const page = await readPage(tab.linkedBrowser);
    const theme = dark ? "dark theme" : "light theme";
    is(page.text, text, `${theme} text`);
    checkShadow(page, shadow, `on the ${theme}`);
    // The white glow cannot show on the light theme's near-white page: a
    // faint dark shadow gives text and icons their edge there, and only there.
    const edge = "rgba(0, 0, 0, 0.2)";
    is(page.textShadow.includes(edge), !dark, `faint dark edge under the text: ${!dark}`);
    is(page.wordmarkFilter.includes(edge), !dark, `and under the wordmark: ${!dark}`);
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_no_wallpaper_by_default() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const page = await readPage(tab.linkedBrowser);
  ok(!page.shown, "no wallpaper on a fresh profile");
  is(page.theme, null, "text follows the browser theme");
  ok(page.markFilter.startsWith(MARK_DEEP), "the mark is deepened");
  is(page.tileBackdrop, "none", "tiles do not blur the plain page");
  checkShadow(page, page.text == WHITE_TEXT ? "black" : "white", "of the theme");
  ok(!page.removable, "nothing to remove");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_dark_wallpaper_white_text() {
  // L* 47: just below the threshold.
  const file = await grayImage(112, "dark");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const browser = tab.linkedBrowser;
  await addWallpaper(browser, file);
  const page = await waitForTheme(browser, "dark");

  const saved = Services.prefs.getStringPref(
    "browser.newtabpage.activity-stream.newtabWallpapers.customWallpaper.uuid"
  );
  ok(/^v1-custom-dark-center-\d+-/.test(saved), `saved by Firefox's feed as a dark image (${saved})`);
  is(
    Services.prefs.getStringPref("browser.newtabpage.activity-stream.newtabWallpapers.wallpaper"),
    "custom",
    "and selected"
  );
  ok(
    await IOUtils.exists(PathUtils.join(PathUtils.profileDir, "wallpaper", saved)),
    "the image is a file in the profile"
  );
  // Computed style normalizes the host-only URL with a trailing slash.
  is(page.image, `url("moz-newtab-wallpaper://${saved}/")`, "the page shows that file");
  is(page.text, WHITE_TEXT, "white text");
  is(page.wordmarkFill, WHITE_TEXT, "white wordmark");
  ok(page.markFilter.startsWith(MARK_DEEP), "the mark is deepened");
  is(page.tileBackdrop, "blur(8px)", "tiles frost the image");
  checkShadow(page, "black", "on a dark image");
  ok(page.removable, "Remove is offered");

  // The page's CSP and the protocol let the image load.
  const decoded = await SpecialPowers.spawn(browser, [saved], async name => {
    const img = new content.Image();
    img.src = `moz-newtab-wallpaper://${name}`;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  });
  Assert.deepEqual(decoded, [64, 40], "the saved image decodes in the page");

  // Another page, opened later, reads it from the prefs.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:home", true);
  const second = await waitForTheme(other.linkedBrowser, "dark");
  is(second.image, page.image, "about:home shows the same wallpaper");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_light_wallpaper_black_text() {
  // L* 53: just above the threshold.
  const file = await grayImage(126, "light");
  const replaced = Services.prefs.getStringPref(
    "browser.newtabpage.activity-stream.newtabWallpapers.customWallpaper.uuid"
  );
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const browser = tab.linkedBrowser;
  await addWallpaper(browser, file);
  const page = await waitForTheme(browser, "light");
  is(page.text, BLACK_TEXT, "black text");
  is(page.wordmarkFill, BLACK_TEXT, "black wordmark");
  ok(page.markFilter.startsWith(MARK_DEEP), "the mark is deepened the same way");
  is(page.tileBackdrop, "blur(8px)", "tiles frost the image");
  checkShadow(page, "white", "on a light image");
  const saved = Services.prefs.getStringPref(
    "browser.newtabpage.activity-stream.newtabWallpapers.customWallpaper.uuid"
  );
  ok(saved.startsWith("v1-custom-light-"), "saved as a light image");

  // The page keeps one image: Firefox's library is off by default, so the
  // feed deletes the one replaced.
  is(
    Services.prefs
      .getDefaultBranch("")
      .getBoolPref("browser.newtabpage.activity-stream.newtabWallpapers.customWallpaper.library.enabled"),
    false,
    "wallpaper library off by default"
  );
  const library = PathUtils.join(PathUtils.profileDir, "wallpaper", "library");
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.exists(PathUtils.join(library, replaced))),
    "the replaced image is deleted"
  );
  const images = (await IOUtils.getChildren(library)).map(path => PathUtils.filename(path));
  Assert.deepEqual(images, [saved], "only the applied image is kept");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_remove_and_escape() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const browser = tab.linkedBrowser;
  await waitForTheme(browser, "light");
  await openPanel(browser);
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("wallpaper-remove").focus());
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await TestUtils.waitForCondition(async () => !(await readPage(browser)).shown, "wallpaper gone");
  const page = await readPage(browser);
  is(page.theme, null, "text follows the browser theme again");
  ok(page.markFilter.startsWith(MARK_DEEP), "the mark stays deepened");
  is(page.tileBackdrop, "none", "tiles stop blurring");
  ok(!page.removable, "Remove hidden");
  await TestUtils.waitForCondition(
    () => !Services.prefs.getStringPref("browser.newtabpage.activity-stream.newtabWallpapers.wallpaper", ""),
    "selection cleared in Firefox's prefs"
  );
  const folder = PathUtils.join(PathUtils.profileDir, "wallpaper");
  const left = (await IOUtils.getChildren(folder)).filter(path => !path.endsWith("library"));
  Assert.deepEqual(left, [], "the applied copy is deleted");

  const focus = await SpecialPowers.spawn(browser, [], () => content.document.activeElement.id);
  is(focus, "wallpaper-add", "focus moves to Add an image, not lost with the hidden button");
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  const after = await SpecialPowers.spawn(browser, [], async () => {
    const { document } = content;
    await ContentTaskUtils.waitForCondition(
      () => !document.getElementById("customize-panel").matches(":popover-open"),
      "panel closed"
    );
    return { focus: document.activeElement.id, expanded: document.activeElement.getAttribute("aria-expanded") };
  });
  Assert.deepEqual(after, { focus: "customize-button", expanded: "false" }, "Escape returns to Customize");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_not_an_image() {
  const path = PathUtils.join(PathUtils.tempDir, "aequera-wallpaper-broken.png");
  await IOUtils.writeUTF8(path, "not an image");
  registerCleanupFunction(() => IOUtils.remove(path, { ignoreAbsent: true }));
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", true);
  const browser = tab.linkedBrowser;
  await addWallpaper(browser, await IOUtils.getFile(path));
  const error = await SpecialPowers.spawn(browser, [], async () => {
    const message = content.document.getElementById("wallpaper-error");
    await ContentTaskUtils.waitForCondition(() => !message.hidden && message.textContent, "error shown");
    return message.textContent;
  });
  ok(error.includes("image file"), `explains the failure: ${error}`);
  ok(!(await readPage(browser)).shown, "nothing applied");
  BrowserTestUtils.removeTab(tab);
});
