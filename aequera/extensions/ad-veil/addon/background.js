/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil (docs/design/ADS.md): requests the filter lists match are
// cancelled through blocking webRequest, and ads that still reach a page are
// hidden with user-origin stylesheets. Matching runs here, in the extension
// process; the parent only suspends and resumes each channel. What was
// blocked or hidden goes to the vault (vault.js); the address bar button
// (popup.html) shows this page's counts and sets the site's mode:
// - block (default): EasyList and EasyPrivacy matches are cancelled, what
//   reaches the page is hidden (display: none);
// - veil: for sites that refuse ad blockers. EasyList's ads load (Firefox's
//   tracking protection lets them through too: experiments/veil.js) and are
//   hidden in place (their box kept); EasyPrivacy's trackers and EasyList's
//   beacons and pings stay blocked;
// - off: nothing is blocked, hidden, or recorded.

const LISTS = { ads: "lists/easylist.txt", privacy: "lists/easyprivacy.txt" };
const OWN = browser.runtime.getURL("");

// Request types veil mode still blocks: they never show an ad.
const NON_VISUAL = new Set(["beacon", "ping", "csp_report"]);

// Bounds on what a content script may send (it runs in a web content
// process, so its messages are untrusted input).
const MAX_NAMES = 2000;
const MAX_NAME_LENGTH = 256;
const MAX_ADS_PER_MESSAGE = 50;
const MAX_HIDDEN_PER_MESSAGE = 10000;

const PRUNE_MS = 60 * 60 * 1000;
const ACTION_UPDATE_MS = 250;

// { all, privacy }. `all` holds both lists and makes every decision, as one
// engine must: an exception rule in either list applies to both (uBlock
// Origin semantics). `privacy` (EasyPrivacy alone) is asked only when `all`
// blocks on a veiled site: a tracker stays blocked, anything else is an ad.
let engines = null;

// Settings live in this add-on's storage (an add-on cannot read prefs) and
// are validated on every load. Choices made in private windows are kept only
// in memory (privateModes): a private visit never reaches the profile.
let settings = VeilModel.settingsFrom(null);
const modes = { off: new Set(), veil: new Set(), privateModes: new Map() };

function applySettings(stored) {
  settings = VeilModel.settingsFrom(stored);
  modes.off = new Set(settings.offSites);
  modes.veil = new Set(settings.veilSites);
  pushModes();
}

async function saveSettings(next) {
  applySettings(next);
  await browser.storage.local.set({ settings });
}

function modeOf(site, incognito) {
  return VeilModel.resolveMode(modes, site, incognito);
}

// The parent-side half of veil mode (experiments/veil.js) resolves modes the
// same way.
function pushModes() {
  const privateModes = [...modes.privateModes].map(([site, mode]) => ({ site, mode }));
  browser.aequeraVeil
    .setSiteModes(settings.offSites, settings.veilSites, privateModes)
    .catch(error => console.error("Ad Veil: veil mode unavailable", error));
}

// Requests that arrive before the lists are compiled wait for them, as
// uBlock Origin does on Firefox, instead of slipping through. If the engines
// cannot load, nothing is blocked: a broken blocker must not break browsing.
const settingsReady = browser.storage.local
  .get("settings")
  .then(stored => applySettings(stored.settings))
  .catch(error => console.error("Ad Veil: settings unreadable, using defaults", error));

const ready = (async () => {
  const [all, privacy, adsText, privacyText] = await Promise.all([
    VeilEngine.load(),
    VeilEngine.load(),
    fetch(browser.runtime.getURL(LISTS.ads)).then(response => response.text()),
    fetch(browser.runtime.getURL(LISTS.privacy)).then(response => response.text()),
  ]);
  if (!all.compile(`${adsText}\n${privacyText}`) || !privacy.compile(privacyText)) {
    throw new Error("filter lists did not compile");
  }
  browser.aequeraVeil
    .setAdHosts(VeilModel.adHostsFrom(adsText))
    .catch(error => console.error("Ad Veil: veil mode unavailable", error));
  await settingsReady;
  engines = { all, privacy };
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

// The address bar button: its tooltip carries this page's counts and mode,
// its icon the mode. Coalesced, since a page can block dozens of requests in
// a burst.
const ICONS = { block: "icons/veil.svg", veil: "icons/veil-veiled.svg", off: "icons/veil-off.svg" };

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
  const mode = modeOf(site, state.incognito);
  const counts = `${state.blocked} blocked, ${state.hidden} hidden on this page`;
  const title = {
    block: `Ad Veil: ${counts}`,
    veil: `Ad Veil, veil mode: ${counts}`,
    off: `Ad Veil is off for ${site}`,
  }[mode];
  try {
    // Synchronous in Firefox (no promise); throws for a closed tab.
    browser.pageAction.setTitle({ tabId, title });
  } catch {
    return;
  }
  browser.pageAction.setIcon({ tabId, path: ICONS[mode] }).catch(() => {});
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

function cancel(details, site) {
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

function decide(details) {
  const site = VeilModel.siteOf(topUrl(details));
  const mode = modeOf(site, details.incognito);
  if (mode == "off") {
    return {};
  }
  const source = details.documentUrl || details.originUrl || details.url;
  if (engines.all.check(details.url, source, details.type) != 1) {
    return {};
  }
  if (
    mode == "veil" &&
    !NON_VISUAL.has(details.type) &&
    engines.privacy.check(details.url, source, details.type) != 1
  ) {
    // An ad: loads, hidden in place by the cosmetic rules.
    return {};
  }
  return cancel(details, site);
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
    if (engines) {
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

// Cosmetic rules, from both lists.
function cosmeticFor(url) {
  const rules = engines.all.cosmetic(url);
  return {
    hide: rules?.hide || [],
    generic(classes, ids) {
      return rules && !rules.generichide ? engines.all.generic(classes, ids, rules.exceptions) : [];
    },
  };
}

// How a mode hides: block collapses the element; veil keeps its box (so a
// script measuring a bait element sees it laid out) and makes it invisible
// and unclickable.
const STYLES = {
  block: { display: "none" },
  veil: { opacity: "0", "pointer-events": "none" },
};

// Selectors are list data, and lists will be updated over the network
// (slice 3). Each one becomes a single rule parsed by Gecko and is kept only
// if it is one style rule whose only declarations are ours: a crafted
// "selector" cannot add declarations (a url() that leaks page state), extra
// rules, or nested rules. Results are cached per selector and style; the
// normalized selector text is what content scripts query for the vault.
const sheet = new CSSStyleSheet();
const ruleCache = new Map();

function hideRule(selector, mode) {
  const key = `${mode}\n${selector}`;
  let rule = ruleCache.get(key);
  if (rule !== undefined) {
    return rule;
  }
  rule = null;
  const style = STYLES[mode];
  const declarations = Object.entries(style)
    .map(([property, value]) => `${property}:${value}!important`)
    .join(";");
  try {
    sheet.insertRule(`${selector}{${declarations}}`, 0);
    const parsed = sheet.cssRules[0];
    sheet.deleteRule(0);
    if (
      parsed instanceof CSSStyleRule &&
      parsed.cssRules.length === 0 &&
      parsed.style.length === Object.keys(style).length &&
      Object.entries(style).every(
        ([property, value]) =>
          parsed.style.getPropertyValue(property) === value && parsed.style.getPropertyPriority(property) === "important"
      )
    ) {
      rule = { css: parsed.cssText, selector: parsed.selectorText };
    }
  } catch {
    // Not a selector Gecko accepts: skipped.
  }
  ruleCache.set(key, rule);
  return rule;
}

function validRules(selectors, mode) {
  return selectors.map(selector => hideRule(selector, mode)).filter(Boolean);
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
    if (!engines || !state) {
      return;
    }
    const mode = modeOf(VeilModel.siteOf(frameId == 0 ? url : state.url), state.incognito);
    if (mode != "off") {
      hide(tabId, frameId, validRules(cosmeticFor(url).hide, mode));
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

// The sender frame's mode, and whether it may record; null when Ad Veil
// does nothing there.
function frameStatus(sender) {
  const tab = sender.tab;
  if (!engines || !tab) {
    return null;
  }
  const mode = modeOf(VeilModel.siteOf(tab.url), tab.incognito);
  return mode == "off" ? null : { mode, collect: settings.vault && !tab.incognito };
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
      const selectors = validRules(cosmeticFor(sender.url).hide, status.mode).map(rule => rule.selector);
      return Promise.resolve({ active: true, collect: status.collect, selectors });
    }
    // Generic rules, for the class and id names content.js saw.
    case "seen": {
      if (!status) {
        return Promise.resolve({ selectors: [] });
      }
      const generic = cosmeticFor(sender.url).generic(names(message.classes), names(message.ids));
      const rules = validRules(generic, status.mode);
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
    ready: !!engines,
    site,
    incognito: !!state?.incognito,
    mode: site ? modeOf(site, state.incognito) : "block",
    blocked: state?.blocked || 0,
    hidden: state?.hidden || 0,
  };
}

async function setMode(tabId, mode) {
  const state = await tabState(tabId);
  const site = state && VeilModel.siteOf(state.url);
  if (!site || !VeilModel.MODES.includes(mode)) {
    return tabSummary(tabId);
  }
  if (state.incognito) {
    // Kept for private windows only, until the browser closes.
    modes.privateModes.set(site, mode);
    pushModes();
  } else {
    await saveSettings({ ...settings, ...VeilModel.withMode(settings, site, mode) });
  }
  // Blocking and hiding apply from the start of a page: reload it.
  await browser.tabs.reload(tabId).catch(() => {});
  return tabSummary(tabId);
}

// Messages from Ad Veil's own pages (popup.html, vault.html).
function ownMessage(message) {
  switch (message.type) {
    case "popup:state":
      return tabSummary(message.tabId);
    case "popup:setMode":
      return setMode(message.tabId, message.mode);
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
  if (!engines) {
    return ready.then(
      () => contentMessage(message, sender),
      () => undefined
    );
  }
  return contentMessage(message, sender);
});
