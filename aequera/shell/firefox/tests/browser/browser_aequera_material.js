/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Frame material (aequera-frame.js, aequera-shell.css): aequera.material.frame
// resolves to :root[aequera-material], "glass" tints the frame translucently
// where the window can show transparency, and the page card stays opaque.

const ROOT = document.documentElement;
const FRAME = "aequera.material.frame";
const OPACITY = "aequera.material.opacity";
const material = () => ROOT.getAttribute("aequera-material");
const opacity = () => ROOT.style.getPropertyValue("--aequera-material-opacity");
const alpha = color => {
  const parts = color.match(/[\d.]+/g).map(Number);
  return parts.length > 3 ? parts[3] : 1;
};
const canShowGlass = () =>
  AppConstants.platform == "linux" && matchMedia("(-moz-gtk-csd-transparency-available)").matches;

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
  const expected = window.AequeraFrame.desktopBlurs() ? "glass" : "solid";
  is(material(), expected, "auto resolves by whether the desktop blurs");
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
    is(material(), "solid", "any other desktop stays solid");
  } finally {
    frame.desktopBlurs = original;
    frame.publishMaterial();
  }
});

add_task(async function test_explicit_values_and_recovery() {
  await setFrame("glass");
  is(material(), "glass", "glass applies on pref change");
  await setFrame("solid");
  is(material(), "solid", "solid applies on pref change");
  await setFrame("sparkly");
  const expected = window.AequeraFrame.desktopBlurs() ? "glass" : "solid";
  is(material(), expected, "an invalid value recovers to auto");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
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

  // body transitions its background (inactive-window fade): wait it out.
  await setFrame("solid");
  await TestUtils.waitForCondition(() => alpha(body()) == 1, "solid: the frame is opaque");
  is(alpha(card()), 1, "the page card is opaque");

  await setFrame("glass");
  if (canShowGlass() && !ROOT.hasAttribute("lwtheme")) {
    await TestUtils.waitForCondition(() => alpha(body()) == 0.8, "glass: the frame is an 80% tint");
    is(
      alpha(getComputedStyle(document.getElementById("sidebar-container")).backgroundColor),
      0,
      "the rail sits on the frame"
    );
  } else {
    await new Promise(resolve => setTimeout(resolve, 500));
    is(alpha(body()), 1, "glass falls back to an opaque frame where transparency cannot show");
  }
  is(alpha(card()), 1, "the page card stays opaque under glass");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});
