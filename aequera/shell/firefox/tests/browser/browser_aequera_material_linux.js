/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Frame material on Linux (platform/linux/): glass where the desktop blurs
// what shows through, a translucent tint where the window can show
// transparency, opaque elsewhere. Shared behavior: browser_aequera_material.js.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "material-helpers.js", this);

const BLUR_QUERY = "(-moz-gtk-background-blur-available)";
const autoMaterial = () => (window.AequeraFrame.desktopBlurs() ? "glass" : "solid");

add_task(async function test_auto_follows_the_desktop() {
  is(material(), autoMaterial(), "auto resolves to what the desktop does");
  const frame = window.AequeraFrame;
  const original = frame.desktopBlurs;
  try {
    frame.desktopBlurs = () => false;
    frame.publishMaterial();
    is(material(), "solid", "a desktop that does not blur stays solid");
  } finally {
    frame.desktopBlurs = original;
    frame.publishMaterial();
  }
});

// A compositor that offers blur (ext-background-effect-v1) turns auto to
// glass while Aequera runs, and back. ui.GtkBackgroundBlurAvailable
// overrides what the compositor reports.
add_task(async function test_auto_follows_compositor_blur() {
  // An unknown media feature (a build without
  // patches/gecko/linux/background-blur) matches neither itself nor its
  // negation.
  const known = matchMedia(BLUR_QUERY).matches || matchMedia(`not ${BLUR_QUERY}`).matches;
  if (!known) {
    ok(true, "needs the background-blur media query (compiled build)");
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
  await popPrefs(2);
  await TestUtils.waitForCondition(() => material() == autoMaterial(), "back to the real desktop");
  is(material(), autoMaterial(), "back to the real desktop");
});

add_task(async function test_paint() {
  // body transitions its background (inactive-window fade): wait it out.
  await setFrame("solid");
  await TestUtils.waitForCondition(() => alpha(bodyColor()) == 1, "solid: the frame is opaque");

  await setFrame("glass");
  if (
    matchMedia("(-moz-gtk-csd-transparency-available)").matches &&
    !document.documentElement.hasAttribute("lwtheme")
  ) {
    await TestUtils.waitForCondition(() => alpha(bodyColor()) == 0.8, "glass: the frame is an 80% tint");
    is(railColor(), topBarColor(), "glass: the rail wears the top bar's paint");
    is(alpha(railColor()), 0, "the rail sits on the frame");
  } else {
    await new Promise(resolve => setTimeout(resolve, 500));
    is(alpha(bodyColor()), 1, "glass falls back to an opaque frame where transparency cannot show");
  }
  await popPrefs(2);
});
