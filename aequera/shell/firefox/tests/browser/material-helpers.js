/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Shared by the frame material tests (browser_aequera_material*.js), which
// load it with loadMaterialHelpers(). var and functions only: lexical
// declarations would stay inside this script.

/* exported FRAME, OPACITY, material, opacity, alpha, setFrame, popPrefs,
   bodyColor, cardColor, railColor, topBarColor */

var FRAME = "aequera.material.frame";
var OPACITY = "aequera.material.opacity";

function material() {
  return document.documentElement.getAttribute("aequera-material");
}

function opacity() {
  return document.documentElement.style.getPropertyValue("--aequera-material-opacity");
}

/** The alpha channel of a computed rgb()/rgba() color. */
function alpha(color) {
  const parts = color.match(/[\d.]+/g).map(Number);
  return parts.length > 3 ? parts[3] : 1;
}

async function setFrame(value) {
  await SpecialPowers.pushPrefEnv({ set: [[FRAME, value]] });
}

async function popPrefs(count) {
  for (let i = 0; i < count; i++) {
    await SpecialPowers.popPrefEnv();
  }
}

function bodyColor() {
  return getComputedStyle(document.body).backgroundColor;
}

function cardColor() {
  return getComputedStyle(gBrowser.selectedBrowser.closest(".browserContainer")).backgroundColor;
}

function railColor() {
  return getComputedStyle(document.getElementById("sidebar-container")).backgroundColor;
}

/** The top bar's own paint (browser_aequera_rail.js: the toolbox). */
function topBarColor() {
  return getComputedStyle(gNavToolbox).backgroundColor;
}

registerCleanupFunction(() => {
  window.AequeraFrame.publishMaterial();
});
