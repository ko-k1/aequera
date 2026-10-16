/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Frame material on macOS (platform/macos/): vibrancy behind the whole frame
// by default, none when solid. Shared behavior: browser_aequera_material.js.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "material-helpers.js", this);

const vibrancy = () => getComputedStyle(document.body, "::before");

add_task(async function test_auto_is_vibrancy() {
  is(material(), "glass", "macOS: vibrancy by default");
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

add_task(async function test_paint() {
  await setFrame("solid");
  is(vibrancy().appearance, "none", "solid: no vibrant layer behind the frame");

  await setFrame("glass");
  if (!document.documentElement.hasAttribute("lwtheme")) {
    // body transitions its background (inactive-window fade): wait it out.
    await TestUtils.waitForCondition(() => alpha(bodyColor()) < 1, "glass: the frame is translucent");
    is(vibrancy().appearance, "auto", "glass: a vibrant layer behind the whole frame");
    is(railColor(), topBarColor(), "glass: the rail wears the top bar's paint");
    is(alpha(railColor()), 0, "the rail sits on the frame");
  } else {
    await new Promise(resolve => setTimeout(resolve, 500));
    is(alpha(bodyColor()), 1, "a theme keeps the solid frame under glass");
  }
  await popPrefs(2);
});
