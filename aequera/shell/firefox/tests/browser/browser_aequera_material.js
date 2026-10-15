/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Frame material (aequera-frame.js, aequera-shell.css): aequera.material.frame
// resolves to :root[aequera-material], "glass" tints the frame translucently
// where the window can show transparency, and the page card stays opaque.

const ROOT = document.documentElement;
const FRAME = "aequera.material.frame";
const OPACITY = "aequera.material.opacity";
const BLUR_QUERY = "(-moz-gtk-background-blur-available)";
const material = () => ROOT.getAttribute("aequera-material");
const opacity = () => ROOT.style.getPropertyValue("--aequera-material-opacity");
const alpha = color => {
  const parts = color.match(/[\d.]+/g).map(Number);
  return parts.length > 3 ? parts[3] : 1;
};
const canShowGlass = () =>
  AppConstants.platform == "macosx" ||
  (AppConstants.platform == "linux" && matchMedia("(-moz-gtk-csd-transparency-available)").matches);
// Windows 11's Acrylic is the frame there; elsewhere auto follows the desktop.
const autoMaterial = () =>
  AppConstants.platform == "win" || window.AequeraFrame.desktopBlurs() ? "glass" : "solid";

async function setFrame(value) {
  await SpecialPowers.pushPrefEnv({ set: [[FRAME, value]] });
}

registerCleanupFunction(() => {
  window.AequeraFrame.publishMaterial();
});

add_task(async function test_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  is(defaults.getCharPref(FRAME), "auto", "auto by default");
  is(defaults.getIntPref(OPACITY), 80, "80% tint by default");
  is(material(), autoMaterial(), "auto resolves to the platform's frame");
  if (AppConstants.platform == "macosx") {
    is(material(), "glass", "macOS: vibrancy by default");
  }
});

add_task(async function test_auto_follows_the_desktop() {
  const frame = window.AequeraFrame;
  const original = frame.desktopBlurs;
  try {
    frame.desktopBlurs = () => true;
    frame.publishMaterial();
    is(material(), "glass", "a blurring desktop gets glass");
    frame.desktopBlurs = () => false;
    frame.publishMaterial();
    is(
      material(),
      AppConstants.platform == "win" ? "glass" : "solid",
      "any other desktop stays solid (Windows keeps Acrylic)"
    );
  } finally {
    frame.desktopBlurs = original;
    frame.publishMaterial();
  }
});

// Linux: a compositor that offers blur (ext-background-effect-v1) turns auto
// to glass while Aequera runs, and back. ui.GtkBackgroundBlurAvailable
// overrides what the compositor reports.
add_task(async function test_auto_follows_compositor_blur() {
  // An unknown media feature (a build without patches/gecko/background-blur)
  // matches neither itself nor its negation.
  const known = matchMedia(BLUR_QUERY).matches || matchMedia(`not ${BLUR_QUERY}`).matches;
  if (AppConstants.platform != "linux" || !known) {
    ok(true, "needs the Linux background-blur media query (compiled build)");
    return;
  }
  if (Services.env.get("HYPRLAND_INSTANCE_SIGNATURE")) {
    ok(true, "Hyprland always blurs: auto is glass regardless");
    return;
  }
  await SpecialPowers.pushPrefEnv({ set: [["ui.GtkBackgroundBlurAvailable", 1]] });
  await TestUtils.waitForCondition(() => material() == "glass", "blur offered");
  is(material(), "glass", "blur offered: auto is glass");
  await SpecialPowers.pushPrefEnv({ set: [["ui.GtkBackgroundBlurAvailable", 0]] });
  await TestUtils.waitForCondition(() => material() == "solid", "blur gone");
  is(material(), "solid", "blur gone: auto is solid");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => material() == autoMaterial(), "back to the real desktop");
  is(material(), autoMaterial(), "back to the real desktop");
});

add_task(async function test_explicit_values_and_recovery() {
  await setFrame("glass");
  is(material(), "glass", "glass applies on pref change");
  await setFrame("solid");
  is(material(), "solid", "solid applies on pref change");
  await setFrame("sparkly");
  is(material(), autoMaterial(), "an invalid value recovers to auto");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

// Windows: DWM draws the backdrop, selected through Firefox's default prefs.
add_task(async function test_windows_backdrop() {
  if (AppConstants.platform != "win") {
    ok(true, "Windows only");
    return;
  }
  const defaults = Services.prefs.getDefaultBranch("");
  const mica = () => defaults.getBoolPref("widget.windows.mica");
  const backdrop = () => defaults.getIntPref("widget.windows.mica.toplevel-backdrop");
  await setFrame("glass");
  ok(mica() && backdrop() == 2, "glass: Acrylic");
  await setFrame("solid");
  ok(!mica(), "solid: no backdrop");
  await setFrame("auto");
  ok(mica() && backdrop() == 2, "auto: Acrylic, the live blur glass is elsewhere");
  for (let i = 0; i < 3; i++) {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_opacity_is_clamped() {
  await SpecialPowers.pushPrefEnv({ set: [[OPACITY, 10]] });
  is(opacity(), "60%", "never below the readability floor");
  await SpecialPowers.pushPrefEnv({ set: [[OPACITY, 150]] });
  is(opacity(), "100%", "never above opaque");
  await SpecialPowers.pushPrefEnv({ set: [[OPACITY, 70]] });
  is(opacity(), "70%", "values in range apply");
  for (let i = 0; i < 3; i++) {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_paint() {
  const body = () => getComputedStyle(document.body).backgroundColor;
  const card = () => getComputedStyle(gBrowser.selectedBrowser.closest(".browserContainer")).backgroundColor;

  const rail = () => getComputedStyle(document.getElementById("sidebar-container")).backgroundColor;
  // The top bar's own paint (browser_aequera_rail.js: the toolbox).
  const topBar = () => getComputedStyle(gNavToolbox).backgroundColor;
  const vibrancy = () => getComputedStyle(document.body, "::before");

  // body transitions its background (inactive-window fade): wait it out.
  await setFrame("solid");
  if (AppConstants.platform != "macosx") {
    await TestUtils.waitForCondition(() => alpha(body()) == 1, "solid: the frame is opaque");
  }
  is(alpha(card()), 1, "the page card is opaque");
  is(rail(), topBar(), "solid: the rail wears the top bar's paint");
  if (AppConstants.platform == "macosx") {
    is(vibrancy().appearance, "none", "solid: no vibrant layer behind the frame");
  }

  await setFrame("glass");
  if (canShowGlass() && !ROOT.hasAttribute("lwtheme")) {
    if (AppConstants.platform == "linux") {
      await TestUtils.waitForCondition(() => alpha(body()) == 0.8, "glass: the frame is an 80% tint");
    } else {
      await TestUtils.waitForCondition(() => alpha(body()) < 1, "glass: the frame is translucent");
      is(vibrancy().appearance, "auto", "glass: a vibrant layer behind the whole frame");
    }
    is(rail(), topBar(), "glass: the rail wears the top bar's paint");
    is(alpha(rail()), 0, "the rail sits on the frame");
  } else if (AppConstants.platform == "win") {
    // DWM draws Acrylic behind the window (test_windows_backdrop); the frame
    // must let it through even when Windows puts the accent color on title
    // bars, which upstream paints over the whole frame. Backdrops render only
    // in real windows: skipped headless, where (-moz-windows-mica) is false.
    if (matchMedia("(-moz-windows-mica)").matches && !ROOT.hasAttribute("lwtheme")) {
      await TestUtils.waitForCondition(() => alpha(body()) == 0, "glass: the frame shows the backdrop");
      const scheme = document.createElement("div");
      scheme.style.color = "-moz-headerbartext";
      document.body.append(scheme);
      is(
        getComputedStyle(document.body).color,
        getComputedStyle(scheme).color,
        "and the scheme's text color, not the accent's"
      );
      scheme.remove();
    }
  } else {
    await new Promise(resolve => setTimeout(resolve, 500));
    is(alpha(body()), 1, "glass falls back to an opaque frame where transparency cannot show");
  }
  is(alpha(card()), 1, "the page card stays opaque under glass");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});
