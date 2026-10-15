/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// AI features are blocked by default (aequera-prefs.js): the state Firefox's
// own "Block AI enhancements" switch leaves behind, read back through each
// feature's own AIFeature.isBlocked, and still a user choice in AI Controls.

const { AIWindow } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs"
);
const { GenAI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/genai/GenAI.sys.mjs"
);
const { LinkPreview } = ChromeUtils.importESModule(
  "moz-src:///browser/components/genai/LinkPreview.sys.mjs"
);
const { PdfJsGuessAltTextFeature } = ChromeUtils.importESModule(
  "resource://pdf.js/PdfJsAIFeature.sys.mjs"
);
const { SmartTabGroupingManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/tabbrowser/SmartTabGrouping.sys.mjs"
);
const { TranslationsFeature } = ChromeUtils.importESModule(
  "chrome://global/content/translations/TranslationsFeature.sys.mjs"
);

const CONTROLS = [
  "translations",
  "pdfjsAltText",
  "smartTabGroups",
  "linkPreviewKeyPoints",
  "sidebarChatbot",
  "smartWindow",
  "speechRecognition",
];

add_task(async function test_blocked_by_default() {
  const defaults = Services.prefs.getDefaultBranch("");
  is(
    defaults.getStringPref("browser.ai.control.default"),
    "blocked",
    "the Block AI enhancements switch is on"
  );
  for (const control of CONTROLS) {
    is(
      defaults.getStringPref(`browser.ai.control.${control}`),
      "blocked",
      `${control} blocked in AI Controls`
    );
  }
  ok(!defaults.getBoolPref("extensions.ml.enabled"), "no ML API for add-ons");
  ok(
    defaults.getBoolPref("browser.ml.chat.page"),
    "chatbot page prompts keep Firefox's default for a re-enabled chatbot"
  );

  ok(GenAI.isBlocked, "sidebar chatbot blocked");
  ok(LinkPreview.isBlocked, "link preview key points blocked");
  ok(SmartTabGroupingManager.isBlocked, "smart tab groups blocked");
  ok(TranslationsFeature.isBlocked, "translations blocked");
  ok(PdfJsGuessAltTextFeature.isBlocked, "PDF alt text blocked");
  ok(AIWindow.isBlocked, "Smart Window blocked");
});

add_task(async function test_chatbot_can_be_made_available() {
  registerCleanupFunction(() => {
    for (const pref of [
      "browser.ai.control.sidebarChatbot",
      "browser.ml.chat.enabled",
      "browser.ml.chat.page",
      "browser.ml.chat.provider",
    ]) {
      Services.prefs.clearUserPref(pref);
    }
  });
  // What choosing "Available" for the chatbot in AI Controls runs.
  await GenAI.makeAvailable();
  ok(!GenAI.isBlocked, "the chatbot is available again");
  ok(
    Services.prefs.getBoolPref("browser.ml.chat.page"),
    "with its page prompts"
  );
  is(
    Services.prefs.getStringPref("browser.ai.control.sidebarChatbot"),
    "available",
    "AI Controls shows it available"
  );
});
