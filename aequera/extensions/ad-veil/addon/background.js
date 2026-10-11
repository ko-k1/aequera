/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil (docs/design/ADS.md): requests the filter lists match are
// cancelled through blocking webRequest, and ads that still reach a page are
// hidden with user-origin stylesheets. Matching runs here, in the extension
// process; the parent only suspends and resumes each channel.

const LISTS = ["lists/easylist.txt", "lists/easyprivacy.txt"];

// Bounds on what a content script may send (it runs in a web content
// process, so its messages are untrusted input).
const MAX_NAMES = 2000;
const MAX_NAME_LENGTH = 256;

let engine = null;

// Requests that arrive before the lists are compiled wait for them, as
// uBlock Origin does on Firefox, instead of slipping through. If the engine
// cannot load, nothing is blocked: a broken blocker must not break browsing.
const ready = (async () => {
  const loaded = await VeilEngine.load();
  const texts = await Promise.all(
    LISTS.map(async path => (await fetch(browser.runtime.getURL(path))).text())
  );
  if (!loaded.compile(texts.join("\n"))) {
    throw new Error("filter lists did not compile");
  }
  engine = loaded;
})();
ready.catch(error => console.error("Ad Veil: engine unavailable, nothing is blocked", error));

function decide(details) {
  const source = details.documentUrl || details.originUrl || details.url;
  return engine.check(details.url, source, details.type) === 1 ? { cancel: true } : {};
}

browser.webRequest.onBeforeRequest.addListener(
  details => {
    // Page requests only (tab -1 is the browser itself and service
    // workers), and never a navigation the user asked for.
    if (details.tabId < 0 || details.type === "main_frame") {
      return {};
    }
    if (engine) {
      return decide(details);
    }
    return ready.then(
      () => decide(details),
      () => ({})
    );
  },
  { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
  ["blocking"]
);

// Selectors are list data, and lists will be updated over the network
// (slice 3). Each one becomes a single rule parsed by Gecko and is kept only
// if it is one style rule whose only declaration is ours: a crafted
// "selector" cannot add declarations (a url() that leaks page state), extra
// rules, or nested rules. Results are cached per selector.
const sheet = new CSSStyleSheet();
const ruleCache = new Map();

function hideRule(selector) {
  let rule = ruleCache.get(selector);
  if (rule !== undefined) {
    return rule;
  }
  rule = null;
  try {
    sheet.insertRule(`${selector}{display:none!important}`, 0);
    const parsed = sheet.cssRules[0];
    sheet.deleteRule(0);
    if (
      parsed instanceof CSSStyleRule &&
      parsed.cssRules.length === 0 &&
      parsed.style.length === 1 &&
      parsed.style.getPropertyValue("display") === "none" &&
      parsed.style.getPropertyPriority("display") === "important"
    ) {
      rule = parsed.cssText;
    }
  } catch {
    // Not a selector Gecko accepts: skipped.
  }
  ruleCache.set(selector, rule);
  return rule;
}

async function hide(tabId, frameId, selectors) {
  const code = selectors.map(hideRule).filter(Boolean).join("\n");
  if (!code) {
    return;
  }
  try {
    await browser.tabs.insertCSS(tabId, { code, frameId, cssOrigin: "user", runAt: "document_start" });
  } catch {
    // The frame navigated away or closed first.
  }
}

// Host-specific rules, as early as the navigation commits.
browser.webNavigation.onCommitted.addListener(
  async ({ tabId, frameId, url }) => {
    if (tabId < 0) {
      return;
    }
    await ready.catch(() => {});
    const cosmetic = engine?.cosmetic(url);
    if (cosmetic) {
      hide(tabId, frameId, cosmetic.hide);
    }
  },
  { url: [{ schemes: ["http", "https"] }] }
);

function names(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .slice(0, MAX_NAMES)
    .filter(name => typeof name === "string" && name.length && name.length <= MAX_NAME_LENGTH);
}

// Generic rules, for the class and id names content.js reports.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "seen" || !sender.tab || !engine) {
    return;
  }
  const cosmetic = engine.cosmetic(sender.url);
  if (!cosmetic || cosmetic.generichide) {
    return;
  }
  const selectors = engine.generic(names(message.classes), names(message.ids), cosmetic.exceptions);
  if (selectors.length) {
    hide(sender.tab.id, sender.frameId, selectors);
  }
});
