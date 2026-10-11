/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil (docs/design/ADS.md): requests the filter lists match are
// cancelled through blocking webRequest, and ads that still reach a page are
// hidden with user-origin stylesheets. Matching runs here, in the extension
// process; the parent only suspends and resumes each channel. What was
// blocked or hidden goes to the vault (vault.js); the address bar button
// (popup.html) shows this page's counts and turns Ad Veil off per site.

const LISTS = ["lists/easylist.txt", "lists/easyprivacy.txt"];
const OWN = browser.runtime.getURL("");

// Bounds on what a content script may send (it runs in a web content
// process, so its messages are untrusted input).
const MAX_NAMES = 2000;
const MAX_NAME_LENGTH = 256;
const MAX_ADS_PER_MESSAGE = 50;
const MAX_HIDDEN_PER_MESSAGE = 10000;

const PRUNE_MS = 60 * 60 * 1000;
const ACTION_UPDATE_MS = 250;

let engine = null;

// Settings live in this add-on's storage (an add-on cannot read prefs) and
// are validated on every load. Sites turned off from a private window are
// kept only in memory: a private visit never reaches the profile.
let settings = VeilModel.settingsFrom(null);
let offSites = new Set();
const privateOffSites = new Set();

function applySettings(stored) {
  settings = VeilModel.settingsFrom(stored);
  offSites = new Set(settings.offSites);
}

async function saveSettings(next) {
  applySettings(next);
  await browser.storage.local.set({ settings });
}

function siteOff(site, incognito) {
  return VeilModel.isSiteOff(offSites, site) || (incognito && VeilModel.isSiteOff(privateOffSites, site));
}

// Requests that arrive before the lists are compiled wait for them, as
// uBlock Origin does on Firefox, instead of slipping through. If the engine
// cannot load, nothing is blocked: a broken blocker must not break browsing.
const settingsReady = browser.storage.local
  .get("settings")
  .then(stored => applySettings(stored.settings))
  .catch(error => console.error("Ad Veil: settings unreadable, using defaults", error));

const ready = (async () => {
  const loaded = await VeilEngine.load();
  const texts = await Promise.all(
    LISTS.map(async path => (await fetch(browser.runtime.getURL(path))).text())
  );
  if (!loaded.compile(texts.join("\n"))) {
    throw new Error("filter lists did not compile");
  }
  await settingsReady;
  engine = loaded;
})();
ready.catch(error => console.error("Ad Veil: engine unavailable, nothing is blocked", error));

ready.then(() => {
  const prune = () => VeilVault.prune().catch(error => console.error("Ad Veil: vault prune failed", error));
  prune();
  setInterval(prune, PRUNE_MS);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local" && changes.settings) {
    applySettings(changes.settings.newValue);
  }
});

// Per tab: the page being shown and what Ad Veil did to it.
const tabs = new Map();

function startPage(tabId, url, incognito) {
  tabs.set(tabId, { url, incognito: !!incognito, blocked: 0, hidden: 0, ads: new Set(), timer: 0 });
  scheduleAction(tabId);
}

async function tabState(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) {
      return null;
    }
    startPage(tabId, tab.url, tab.incognito);
    state = tabs.get(tabId);
  }
  return state;
}

browser.tabs.onRemoved.addListener(tabId => {
  clearTimeout(tabs.get(tabId)?.timer);
  tabs.delete(tabId);
});

// The address bar button: its tooltip carries this page's counts, its icon
// whether Ad Veil is off here. Coalesced, since a page can block dozens of
// requests in a burst.
function scheduleAction(tabId) {
  const state = tabs.get(tabId);
  if (state && !state.timer) {
    state.timer = setTimeout(() => updateAction(tabId), ACTION_UPDATE_MS);
  }
}

function updateAction(tabId) {
  const state = tabs.get(tabId);
  if (!state) {
    return;
  }
  state.timer = 0;
  const site = VeilModel.siteOf(state.url);
  if (!site) {
    return;
  }
  const off = siteOff(site, state.incognito);
  const title = off
    ? `Ad Veil is off for ${site}`
    : `Ad Veil: ${state.blocked} blocked, ${state.hidden} hidden on this page`;
  browser.pageAction.setTitle({ tabId, title }).catch(() => {});
  browser.pageAction.setIcon({ tabId, path: off ? "icons/veil-off.svg" : "icons/veil.svg" }).catch(() => {});
}

function fromOwnPage(details) {
  return (details.originUrl || "").startsWith(OWN) || (details.documentUrl || "").startsWith(OWN);
}

// The top-level page a request belongs to: frameAncestors when Firefox
// provides it (a request from a frame), else the requesting document (top
// frame), else the tab's page.
function topUrl(details) {
  const ancestors = details.frameAncestors;
  if (ancestors?.length) {
    return ancestors[ancestors.length - 1].url;
  }
  if (details.frameId == 0 && details.documentUrl) {
    return details.documentUrl;
  }
  return tabs.get(details.tabId)?.url || details.documentUrl;
}

function decide(details) {
  const site = VeilModel.siteOf(topUrl(details));
  if (siteOff(site, details.incognito)) {
    return {};
  }
  const source = details.documentUrl || details.originUrl || details.url;
  if (engine.check(details.url, source, details.type) != 1) {
    return {};
  }
  const state = tabs.get(details.tabId);
  if (state) {
    state.blocked++;
    scheduleAction(details.tabId);
  }
  const host = VeilModel.hostOf(details.url);
  if (settings.vault && !details.incognito && site && host) {
    VeilVault.countBlocked(site, host, Date.now());
  }
  return { cancel: true };
}

browser.webRequest.onBeforeRequest.addListener(
  details => {
    // Page requests only (tab -1 is the browser itself and service
    // workers); never a navigation the user asked for, never Ad Veil's own
    // pages (vault previews).
    if (details.tabId < 0) {
      return {};
    }
    if (details.type == "main_frame") {
      startPage(details.tabId, details.url, details.incognito);
      return {};
    }
    if (fromOwnPage(details)) {
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
// rules, or nested rules. Results are cached per selector; the normalized
// selector text is what content scripts query for the vault.
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
      rule = { css: parsed.cssText, selector: parsed.selectorText };
    }
  } catch {
    // Not a selector Gecko accepts: skipped.
  }
  ruleCache.set(selector, rule);
  return rule;
}

function validRules(selectors) {
  return selectors.map(hideRule).filter(Boolean);
}

async function hide(tabId, frameId, rules) {
  const code = rules.map(rule => rule.css).join("\n");
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
    let state = await tabState(tabId);
    if (frameId == 0 && state && state.url != url) {
      // A navigation without a network request (history, cache).
      startPage(tabId, url, state.incognito);
      state = tabs.get(tabId);
    }
    if (!engine || !state || siteOff(VeilModel.siteOf(frameId == 0 ? url : state.url), state.incognito)) {
      return;
    }
    const cosmetic = engine.cosmetic(url);
    if (cosmetic) {
      hide(tabId, frameId, validRules(cosmetic.hide));
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
    .filter(name => typeof name == "string" && name.length && name.length <= MAX_NAME_LENGTH);
}

// Whether Ad Veil works in the sender's frame, and whether it may record.
function frameStatus(sender) {
  const tab = sender.tab;
  if (!engine || !tab || siteOff(VeilModel.siteOf(tab.url), tab.incognito)) {
    return null;
  }
  return { collect: settings.vault && !tab.incognito };
}

function contentMessage(message, sender) {
  const status = frameStatus(sender);
  switch (message.type) {
    // content.js starts: the host-specific selectors applied to its frame,
    // to find the hidden ads it reports.
    case "applied": {
      if (!status) {
        return Promise.resolve({ active: false });
      }
      const cosmetic = engine.cosmetic(sender.url);
      const selectors = cosmetic ? validRules(cosmetic.hide).map(rule => rule.selector) : [];
      return Promise.resolve({ active: true, collect: status.collect, selectors });
    }
    // Generic rules, for the class and id names content.js saw.
    case "seen": {
      const cosmetic = status && engine.cosmetic(sender.url);
      if (!cosmetic || cosmetic.generichide) {
        return Promise.resolve({ selectors: [] });
      }
      const rules = validRules(engine.generic(names(message.classes), names(message.ids), cosmetic.exceptions));
      hide(sender.tab.id, sender.frameId, rules);
      return Promise.resolve({ selectors: rules.map(rule => rule.selector) });
    }
    // Elements content.js found hidden, and the ads among them.
    case "hidden": {
      const state = tabs.get(sender.tab?.id);
      if (!status || !state) {
        return undefined;
      }
      const count = Number.isInteger(message.count) ? Math.min(Math.max(message.count, 0), MAX_HIDDEN_PER_MESSAGE) : 0;
      state.hidden += count;
      scheduleAction(sender.tab.id);
      if (!status.collect || !Array.isArray(message.ads)) {
        return undefined;
      }
      const now = Date.now();
      const site = VeilModel.siteOf(sender.tab.url);
      const entries = [];
      for (const raw of message.ads.slice(0, MAX_ADS_PER_MESSAGE)) {
        const ad = VeilModel.adFrom(raw);
        const key = ad && `${ad.link}|${ad.creative}`;
        if (!ad || state.ads.has(key)) {
          continue;
        }
        state.ads.add(key);
        entries.push({ time: now, site, page: sender.tab.url, ...ad });
      }
      VeilVault.addAds(entries).catch(error => console.error("Ad Veil: vault write failed", error));
      return undefined;
    }
  }
  return undefined;
}

async function tabSummary(tabId) {
  const state = await tabState(tabId);
  const site = state && VeilModel.siteOf(state.url);
  return {
    ready: !!engine,
    site,
    incognito: !!state?.incognito,
    on: !!site && !siteOff(site, state.incognito),
    blocked: state?.blocked || 0,
    hidden: state?.hidden || 0,
  };
}

async function setSite(tabId, on) {
  const state = await tabState(tabId);
  const site = state && VeilModel.siteOf(state.url);
  if (!site) {
    return tabSummary(tabId);
  }
  if (state.incognito) {
    if (on) {
      privateOffSites.delete(site);
    } else {
      privateOffSites.add(site);
    }
  }
  if (!state.incognito || on) {
    // Turning a site back on from a private window may clear a choice made
    // in a normal one; it never adds a private site to the profile.
    await saveSettings({ ...settings, offSites: VeilModel.withSite(settings.offSites, site, on) });
  }
  // Hiding and blocking apply from the start of a page: reload it.
  await browser.tabs.reload(tabId).catch(() => {});
  return tabSummary(tabId);
}

// Messages from Ad Veil's own pages (popup.html, vault.html).
function ownMessage(message) {
  switch (message.type) {
    case "popup:state":
      return tabSummary(message.tabId);
    case "popup:setSite":
      return setSite(message.tabId, !!message.on);
    case "vault:summary":
      return VeilVault.summary().then(summary => ({ ...summary, enabled: settings.vault }));
    case "vault:setEnabled":
      return saveSettings({ ...settings, vault: !!message.on }).then(() => ({ enabled: settings.vault }));
    case "vault:clear":
      return VeilVault.clear();
    case "vault:export":
      return VeilVault.exportAll();
  }
  return undefined;
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type != "string") {
    return undefined;
  }
  if ((sender.url || "").startsWith(OWN)) {
    return ownMessage(message);
  }
  // A page restored at startup can ask before the lists are compiled.
  if (!engine) {
    return ready.then(
      () => contentMessage(message, sender),
      () => undefined
    );
  }
  return contentMessage(message, sender);
});
