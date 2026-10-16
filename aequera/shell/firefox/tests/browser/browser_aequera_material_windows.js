/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Frame material on Windows (platform/windows/): DWM draws Acrylic behind
// the window, selected through Firefox's default prefs, and the frame lets
// it through. Shared behavior: browser_aequera_material.js.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "material-helpers.js", this);

add_task(async function test_auto_is_acrylic_on_any_desktop() {
  is(material(), "glass", "auto: Acrylic by default");
  const frame = window.AequeraFrame;
  const original = frame.desktopBlurs;
  try {
    frame.desktopBlurs = () => false;
    frame.publishMaterial();
    is(material(), "glass", "a desktop that does not blur keeps Acrylic");
  } finally {
    frame.desktopBlurs = original;
    frame.publishMaterial();
  }
});

add_task(async function test_backdrop_prefs() {
  const defaults = Services.prefs.getDefaultBranch("");
  const mica = () => defaults.getBoolPref("widget.windows.mica");
  const backdrop = () => defaults.getIntPref("widget.windows.mica.toplevel-backdrop");
  await setFrame("glass");
  ok(mica() && backdrop() == 2, "glass: Acrylic");
  await setFrame("solid");
  ok(!mica(), "solid: no backdrop");
  await setFrame("auto");
  ok(mica() && backdrop() == 2, "auto: Acrylic, the live blur glass is elsewhere");
  await popPrefs(3);
});

add_task(async function test_paint() {
  // body transitions its background (inactive-window fade): wait it out.
  await setFrame("solid");
  await TestUtils.waitForCondition(() => alpha(bodyColor()) == 1, "solid: the frame is opaque");

  // The frame must let the backdrop through even when Windows puts the
  // accent color on title bars, which upstream paints over the whole frame.
  // Backdrops render only in real windows: skipped headless, where
  // (-moz-windows-mica) is false.
  await setFrame("glass");
  if (matchMedia("(-moz-windows-mica)").matches && !document.documentElement.hasAttribute("lwtheme")) {
    await TestUtils.waitForCondition(() => alpha(bodyColor()) == 0, "glass: the frame shows the backdrop");
    const scheme = document.createElement("div");
    scheme.style.color = "-moz-headerbartext";
    document.body.append(scheme);
    is(
      getComputedStyle(document.body).color,
      getComputedStyle(scheme).color,
      "and the scheme's text color, not the accent's"
    );
    scheme.remove();
  } else {
    ok(true, "no backdrop here (headless, or a theme): nothing to see through");
  }
  await popPrefs(2);
});
