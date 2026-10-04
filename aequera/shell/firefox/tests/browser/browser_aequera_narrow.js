/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera narrow windows: the rail plus the top bar must fit ~400px
// widths. Upstream floors #urlbar-container at 275px under vertical tabs
// and every window at 661px; the shell answers with a staged responsive
// address bar (140/100/80px floors, buttons stepping aside, stop/reload
// and downloads overflowing under 560px), all scoped to the rail.

const ROOT = document.documentElement;
const container = () => document.getElementById("urlbar-container");

// Resizing is asynchronous: wait until the window has settled, plus two
// frames for layout, so no transient geometry leaks into later tests.
async function setWindowSize(w, h) {
  window.resizeTo(w, h);
  await TestUtils.waitForCondition(
    () => Math.abs(window.outerWidth - w) <= 1 && Math.abs(window.outerHeight - h) <= 1,
    `window settles at ${w}x${h}`
  );
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.revamp", false],
      ["sidebar.verticalTabs", true],
      ["sidebar.verticalTabs.requireRevamp", false],
      ["aequera.rail.pinned", false],
    ],
  });
  await TestUtils.waitForCondition(() => ROOT.hasAttribute("aequera-rail"), "rail active");
  registerCleanupFunction(async () => {
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function test_urlbar_floor_uses_the_small_step() {
  const min = getComputedStyle(ROOT).getPropertyValue("--urlbar-container-min-width").trim();
  const px = parseFloat(min);
  ok(Number.isFinite(px), `urlbar floor parses (${min})`);
  Assert.lessOrEqual(px, 140, "urlbar floor is at most the 140px small step");
});

add_task(async function test_window_floor_fits_narrow_widths() {
  const base = getComputedStyle(ROOT).getPropertyValue("--window-min-width").trim();
  ok(Number.isFinite(parseFloat(base)), `window base parses (${base})`);
  Assert.lessOrEqual(parseFloat(base), 240, "window base is at most 240px");
  // Resolved :root min-width keeps upstream's per-platform caption
  // allowance; on every platform it must sit far below the old 661px floor.
  const floor = parseFloat(getComputedStyle(ROOT).minWidth);
  ok(Number.isFinite(floor), `:root min-width parses (${getComputedStyle(ROOT).minWidth})`);
  Assert.lessOrEqual(floor, 410, "window floor fits ~390px chrome");
});

add_task(async function test_chrome_may_shrink_below_its_content() {
  for (const id of ["navigator-toolbox", "nav-bar", "nav-bar-customization-target"]) {
    is(
      getComputedStyle(document.getElementById(id)).minWidth,
      "0px",
      `${id} may shrink`
    );
  }
  const style = getComputedStyle(container());
  is(style.minWidth, "0px", "urlbar-container may shrink");
  is(style.flexShrink, "1", "urlbar-container yields instead of flooring the window");
});

add_task(async function test_address_bar_stays_usable() {
  const urlbar = document.getElementById("urlbar").getBoundingClientRect();
  Assert.greater(urlbar.width, 50, "address bar keeps a usable width");
  Assert.greater(urlbar.height, 10, "address bar keeps a usable height");
});

add_task(async function test_chrome_collapses_in_stages() {
  const dev = document.getElementById("developer-button");
  const width = window.outerWidth;
  const height = window.outerHeight;
  try {
    await setWindowSize(590, height);
    if (dev) {
      is(getComputedStyle(dev).display, "none", "developer button steps aside under 700px");
    }
    const min = getComputedStyle(ROOT)
      .getPropertyValue("--urlbar-container-min-width")
      .trim();
    Assert.lessOrEqual(parseFloat(min), 100, `urlbar floor drops to the 100px stage (${min})`);
    is(
      getComputedStyle(document.getElementById("urlbar-zoom-button")).display,
      "none",
      "zoom button steps aside under 600px"
    );
    const urlbar = document.getElementById("urlbar").getBoundingClientRect();
    Assert.greater(urlbar.width, 50, "address bar is still usable at 590px");
  } finally {
    await setWindowSize(width, height);
  }
});

add_task(async function test_overflowable_widgets_step_aside_at_560px() {
  const stop = document.getElementById("stop-reload-button");
  const downloads = document.getElementById("downloads-button");
  ok(stop, "stop/reload is placed");
  ok(downloads, "downloads is placed");
  const width = window.outerWidth;
  const height = window.outerHeight;
  try {
    await setWindowSize(540, height);
    await TestUtils.waitForCondition(
      () => stop.getAttribute("overflows") == "true",
      "stop/reload becomes overflowable"
    );
    is(downloads.getAttribute("overflows"), "true", "downloads becomes overflowable");
    await setWindowSize(Math.max(width, 1024), height);
    await TestUtils.waitForCondition(
      () => stop.getAttribute("overflows") == "false",
      "stop/reload is pinned again when wide"
    );
    is(downloads.getAttribute("overflows"), "false", "downloads is pinned again when wide");
  } finally {
    await setWindowSize(width, height);
  }
});
