/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Extensions may not recolour the browser (patches/toolkit/dynamic-themes,
// aequera.extensions.dynamicThemes off by default): an extension with the
// "theme" permission (Dark Reader's "Change browser theme") calling
// browser.theme.update() leaves the window unthemed, so the frame keeps its
// material instead of the extension's opaque colour. The call still
// succeeds and still reports the theme in use through theme.onUpdated, so
// onUpdated listeners and theme.getCurrent() agree.

const ROOT = document.documentElement;
const PREF = "aequera.extensions.dynamicThemes";
const FRAME_COLOR = "#000000";

function themingExtension() {
  return ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["theme"] },
    background() {
      const updates = [];
      let waiting = null;
      browser.theme.onUpdated.addListener(({ theme, windowId }) => {
        if (waiting) {
          waiting({ theme, windowId });
          waiting = null;
        } else {
          updates.push({ theme, windowId });
        }
      });
      function nextUpdate() {
        return updates.length ? Promise.resolve(updates.shift()) : new Promise(resolve => (waiting = resolve));
      }
      browser.test.onMessage.addListener(async (msg, color) => {
        if (msg == "update") {
          await browser.theme.update({ colors: { frame: color, tab_background_text: "#ffffff" } });
          const current = await browser.theme.getCurrent();
          browser.test.sendMessage("updated", { current, event: await nextUpdate() });
        } else if (msg == "reset") {
          await browser.theme.reset();
          browser.test.sendMessage("reset");
        }
      });
    },
  });
}

/** Two frames: a theme that applied would have restyled the window by then. */
function twoFrames() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

add_task(async function test_extensions_cannot_recolour_by_default() {
  is(Services.prefs.getBoolPref(PREF), false, "refused by default");
  await SpecialPowers.pushPrefEnv({ set: [["aequera.material.frame", "glass"]] });
  const extension = themingExtension();
  await extension.startup();
  extension.sendMessage("update", FRAME_COLOR);
  const { current, event } = await extension.awaitMessage("updated");
  await twoFrames();
  ok(!ROOT.hasAttribute("lwtheme"), "the window is not recoloured");
  is(ROOT.getAttribute("aequera-material"), "glass", "the frame keeps its glass material");
  isnot(current?.colors?.frame, FRAME_COLOR, "getCurrent reports the theme in use, not the refused one");
  is(event.theme?.colors?.frame, current?.colors?.frame, "onUpdated reports the theme in use");
  is(event.windowId, undefined, "as a global update would");
  await extension.unload();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_extensions_recolour_when_allowed() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  const extension = themingExtension();
  await extension.startup();
  extension.sendMessage("update", FRAME_COLOR);
  const { current, event } = await extension.awaitMessage("updated");
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("lwtheme"), "the extension's theme applies");
  is(current?.colors?.frame, FRAME_COLOR, "as Firefox does");
  is(event.theme?.colors?.frame, FRAME_COLOR, "onUpdated reports the applied theme");
  extension.sendMessage("reset");
  await extension.awaitMessage("reset");
  await TestUtils.waitForCondition(() => !ROOT.hasAttribute("lwtheme"), "and resets");
  await extension.unload();
  await SpecialPowers.popPrefEnv();
});
