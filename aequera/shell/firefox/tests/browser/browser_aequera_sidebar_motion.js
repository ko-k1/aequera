/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Aequera Stage 2 sidebar motion: patches/browser/sidebar-motion (easing
// pref, collapse delay, interruptible hover) and the frame-model page clip
// from aequera-shell.js.

const EASING_PREF = "sidebar.animation.expand-on-hover.easing";
const COLLAPSE_DELAY_PREF = "sidebar.animation.expand-on-hover.collapse-delay-ms";
const DURATION_PREF = "sidebar.animation.expand-on-hover.duration-ms";
const DELAY_PREF = "sidebar.animation.expand-on-hover.delay-duration-ms";
const ANIMATION_PREF = "sidebar.animation.enabled";
const SWIFT = "cubic-bezier(0.3, 0.7, 0.3, 1)";

const launcher = () => SidebarController.sidebarContainer;
const isExpanded = () => SidebarController._state.launcherExpanded;
const launcherAnimation = () =>
  launcher()
    .getAnimations()
    .find(a => a.effect.getKeyframes().some(k => "translate" in k));

function collapsedWidth() {
  const browserEl = document.getElementById("browser");
  return parseFloat(getComputedStyle(browserEl).getPropertyValue("--sidebar-launcher-collapsed-width"));
}

function pageClipLeft() {
  const clip = getComputedStyle(document.getElementById("tabbrowser-tabbox")).clipPath;
  // "inset(0px 0px 0px 123.4px round ...)" -> 123.4
  const match = /^inset\(\s*[-\d.]+px\s+[-\d.]+px\s+[-\d.]+px\s+([-\d.]+)px/.exec(clip);
  return match ? parseFloat(match[1]) : 0;
}

function hoverLauncher() {
  EventUtils.synthesizeMouse(launcher(), 1, 150, { type: "mousemove" });
}

function leaveLauncher() {
  EventUtils.synthesizeMouseAtCenter(SidebarController.contentArea, { type: "mousemove" });
}

async function settle() {
  await SidebarController.waitUntilStable();
}

async function resetToCollapsed() {
  leaveLauncher();
  await TestUtils.waitForCondition(() => !isExpanded(), "launcher collapses");
  await settle();
}

add_setup(async () => {
  window.windowUtils.disableNonTestMouseEvents(true);
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("sidebar-expand-on-hover"),
    "expand-on-hover is active"
  );
  await settle();
  registerCleanupFunction(async () => {
    window.windowUtils.disableNonTestMouseEvents(false);
    await resetToCollapsed();
  });
});

add_task(async function test_easing_pref_drives_animation() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [ANIMATION_PREF, true],
      [DURATION_PREF, 300],
      [DELAY_PREF, 0],
      [COLLAPSE_DELAY_PREF, 0],
      [EASING_PREF, "cubic-bezier(0.3,0.7,0.3,1)"],
    ],
  });
  hoverLauncher();
  await TestUtils.waitForCondition(launcherAnimation, "launcher animates");
  is(launcherAnimation().effect.getTiming().easing, SWIFT, "expand uses the easing pref");
  await settle();
  await resetToCollapsed();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_invalid_easing_falls_back() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [ANIMATION_PREF, true],
      [DURATION_PREF, 300],
      [DELAY_PREF, 0],
      [COLLAPSE_DELAY_PREF, 0],
      [EASING_PREF, "not-an-easing"],
    ],
  });
  hoverLauncher();
  await TestUtils.waitForCondition(launcherAnimation, "launcher still animates");
  is(
    launcherAnimation().effect.getTiming().easing,
    "ease-in-out",
    "an invalid easing falls back instead of breaking the animation"
  );
  await settle();
  ok(isExpanded(), "launcher expanded despite the bad pref");
  await resetToCollapsed();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_collapse_delay_lingers_and_reentry_cancels() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [ANIMATION_PREF, false],
      [DELAY_PREF, 0],
      [COLLAPSE_DELAY_PREF, 400],
    ],
  });
  hoverLauncher();
  await TestUtils.waitForCondition(isExpanded, "launcher expands");

  const leftAt = performance.now();
  leaveLauncher();
  await new Promise(resolve => setTimeout(resolve, 150));
  ok(isExpanded(), "still expanded 150ms after leaving (linger)");
  await TestUtils.waitForCondition(() => !isExpanded(), "collapses after the delay");
  Assert.greaterOrEqual(performance.now() - leftAt, 380, "collapse waited for the delay");

  hoverLauncher();
  await TestUtils.waitForCondition(isExpanded, "launcher expands again");
  leaveLauncher();
  await new Promise(resolve => setTimeout(resolve, 100));
  hoverLauncher();
  await new Promise(resolve => setTimeout(resolve, 600));
  ok(isExpanded(), "re-entering during the linger cancels the collapse");

  await SpecialPowers.pushPrefEnv({ set: [[COLLAPSE_DELAY_PREF, 0]] });
  await resetToCollapsed();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_input_interrupts_animation_without_jump() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [ANIMATION_PREF, true],
      [DURATION_PREF, 1000],
      [DELAY_PREF, 0],
      [COLLAPSE_DELAY_PREF, 0],
      [EASING_PREF, "linear"],
    ],
  });
  hoverLauncher();
  await TestUtils.waitForCondition(
    () => launcherAnimation()?.currentTime > 300,
    "expand animation is mid-flight"
  );
  const expanding = launcherAnimation();
  const rightBefore = launcher().getBoundingClientRect().right;

  leaveLauncher();
  await TestUtils.waitForCondition(
    () => launcherAnimation() && launcherAnimation() !== expanding,
    "a reversing animation replaces the expand mid-flight"
  );
  ok(!isExpanded(), "leaving during the expand was honored, not ignored");
  const rightAfter = launcher().getBoundingClientRect().right;
  Assert.less(
    Math.abs(rightAfter - rightBefore),
    40,
    `reversal starts where the rail was (${rightBefore} -> ${rightAfter})`
  );

  await settle();
  ok(!isExpanded(), "ends collapsed");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_page_clip_tracks_rail() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [ANIMATION_PREF, true],
      [DURATION_PREF, 1000],
      [DELAY_PREF, 0],
      [COLLAPSE_DELAY_PREF, 0],
      [EASING_PREF, "linear"],
    ],
  });
  is(pageClipLeft(), 0, "collapsed: page is not clipped");

  hoverLauncher();
  await TestUtils.waitForCondition(
    () => launcherAnimation()?.currentTime > 400,
    "expand animation is mid-flight"
  );
  const railExtra = launcher().getBoundingClientRect().right - collapsedWidth();
  Assert.greater(railExtra, 20, "rail is partly widened");
  Assert.less(
    Math.abs(pageClipLeft() - railExtra),
    24,
    `mid-flight page edge follows the rail (clip ${pageClipLeft()} vs rail ${railExtra})`
  );

  await settle();
  const restExtra = launcher().getBoundingClientRect().width - collapsedWidth();
  await TestUtils.waitForCondition(
    () => Math.abs(pageClipLeft() - restExtra) < 2,
    "expanded at rest: clip equals the rail's extra width"
  );

  await resetToCollapsed();
  await TestUtils.waitForCondition(() => pageClipLeft() < 1, "collapsed again: clip released");
  await SpecialPowers.popPrefEnv();
});
