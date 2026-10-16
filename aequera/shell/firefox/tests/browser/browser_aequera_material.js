/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Frame material (aequera-frame.js, aequera-shell.css): aequera.material.frame
// resolves to :root[aequera-material], "glass" tints the frame translucently
// where the window can show transparency, and the page card stays opaque.
// What each OS does with it: browser_aequera_material_<os>.js.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "material-helpers.js", this);

add_task(async function test_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  is(defaults.getCharPref(FRAME), "auto", "auto by default");
  is(defaults.getIntPref(OPACITY), 80, "80% tint by default");
  ok(["glass", "solid"].includes(material()), "auto resolves to a material");
});

add_task(async function test_a_blurring_desktop_gets_glass() {
  const frame = window.AequeraFrame;
  const original = frame.desktopBlurs;
  try {
    frame.desktopBlurs = () => true;
    frame.publishMaterial();
    is(material(), "glass", "a blurring desktop gets glass");
  } finally {
    frame.desktopBlurs = original;
    frame.publishMaterial();
  }
});

add_task(async function test_explicit_values_and_recovery() {
  await setFrame("auto");
  const auto = material();
  await setFrame("glass");
  is(material(), "glass", "glass applies on pref change");
  await setFrame("solid");
  is(material(), "solid", "solid applies on pref change");
  await setFrame("sparkly");
  is(material(), auto, "an invalid value recovers to auto");
  await popPrefs(4);
});

add_task(async function test_opacity_is_clamped() {
  await SpecialPowers.pushPrefEnv({ set: [[OPACITY, 10]] });
  is(opacity(), "60%", "never below the readability floor");
  await SpecialPowers.pushPrefEnv({ set: [[OPACITY, 150]] });
  is(opacity(), "100%", "never above opaque");
  await SpecialPowers.pushPrefEnv({ set: [[OPACITY, 70]] });
  is(opacity(), "70%", "values in range apply");
  await popPrefs(3);
});

add_task(async function test_the_page_card_stays_opaque() {
  await setFrame("solid");
  is(alpha(cardColor()), 1, "the page card is opaque");
  is(railColor(), topBarColor(), "solid: the rail wears the top bar's paint");
  await setFrame("glass");
  is(alpha(cardColor()), 1, "the page card stays opaque under glass");
  await popPrefs(2);
});
