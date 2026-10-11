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
// - veil: for sites that refuse ad blockers (AdNauseam's model). Ads load
//   and are hidden in place (their box kept): Ad Veil lets its lists'
//   matches through except beacons, pings, and CSP reports; Firefox's
//   tracking protection lifts only its ad blocks (experiments/veil.js) and
//   keeps blocking analytics, social, fingerprinting, and cryptomining
//   trackers and their cookies; Firefox's ad SmartBlock shims are off while
//   Ad Veil is on (they would replace the ads with stubs);
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

// { all }: one engine holds both lists and makes every decision, so an
// exception rule in either list applies to both (uBlock Origin semantics).
let engines = null;
// The shipped lists' versions and rule counts, for the dashboard.
let listsInfo = null;
// EasyList's ad server hosts: frames from them describe their own ad.
let adHostSet = new Set();

// Saved ad images (settings.saveImages): one fetch per image URL when its
// ad is recorded, only for images the page had already loaded, without
// cookies or a referrer, kept as a thumbnail in the vault. Requests from
// the background have no tab, so Ad Veil's own blocking skips them, and
// tracking protection lets an add-on with host access load them.
const THUMB_SIZE = 320;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_RAW_THUMB_BYTES = 200 * 1024;
const IMAGE_FETCHES = 2;
const imageQueue = [];
const imagesWanted = new Set();
let imageFetches = 0;

async function thumbnail(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  } catch {
    // Not decodable here (an SVG, say): kept as is when small.
    return blob.size <= MAX_RAW_THUMB_BYTES ? blob : null;
  }
}

async function saveImage(url) {
  if (await VeilVault.hasImage(url)) {
    return;
  }
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "force-cache" });
  const blob = await response.blob();
  if (!response.ok || !blob.type.startsWith("image/") || blob.size > MAX_IMAGE_BYTES) {
    return;
  }
  const thumb = await thumbnail(blob);
  if (thumb) {
    await VeilVault.saveImage(url, thumb);
  }
}

function pumpImages() {
  while (imageFetches < IMAGE_FETCHES && imageQueue.length) {
    const url = imageQueue.shift();
    imageFetches++;
    saveImage(url)
      .catch(() => {})
      .finally(() => {
        imageFetches--;
        imagesWanted.delete(url);
        pumpImages();
      });
  }
}

function wantImage(url) {
  if (url && !imagesWanted.has(url)) {
    imagesWanted.add(url);
    imageQueue.push(url);
    pumpImages();
  }
}

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
  const [all, adsText, privacyText] = await Promise.all([
    VeilEngine.load(),
    fetch(browser.runtime.getURL(LISTS.ads)).then(response => response.text()),
    fetch(browser.runtime.getURL(LISTS.privacy)).then(response => response.text()),
  ]);
  if (!all.compile(`${adsText}\n${privacyText}`)) {
    throw new Error("filter lists did not compile");
  }
  const adHosts = VeilModel.adHostsFrom(adsText);
  adHostSet = new Set(adHosts);
  browser.aequeraVeil.setAdHosts(adHosts).catch(error => console.error("Ad Veil: veil mode unavailable", error));
  await settingsReady;
  listsInfo = [
    { name: "EasyList", ...VeilModel.listInfo(adsText) },
    { name: "EasyPrivacy", ...VeilModel.listInfo(privacyText) },
  ];
  engines = { all };
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

// All-time counts for the popup and dashboard, from normal windows only
// (numbers, no sites), saved every few seconds.
const TOTALS_SAVE_MS = 10000;
let totals = VeilModel.totalsFrom(null, Date.now());
let totalsTimer = 0;
browser.storage.local
  .get("totals")
  .then(stored => {
    const saved = VeilModel.totalsFrom(stored.totals, Date.now());
    // Counts made before the read finished are kept.
    totals = { blocked: saved.blocked + totals.blocked, hidden: saved.hidden + totals.hidden, since: saved.since };
  })
  .catch(error => console.error("Ad Veil: totals unreadable, starting from zero", error));

function addTotals(incognito, key, count) {
  if (incognito || !count) {
    return;
  }
  totals[key] += count;
  totalsTimer ||= setTimeout(() => {
    totalsTimer = 0;
    browser.storage.local.set({ totals }).catch(() => {});
  }, TOTALS_SAVE_MS);
}

// Per tab: the page being shown and what Ad Veil did to it. Kept in memory
// only, for the toolbar button and popup.
const MAX_RECENT_ADS = 12;
const tabs = new Map();

function startPage(tabId, url, incognito) {
  tabs.set(tabId, {
    url,
    incognito: !!incognito,
    requests: 0,
    blocked: 0,
    hidden: 0,
    // Hosts contacted, and the blocked ones with their counts.
    domains: new Set(),
    blockedHosts: new Map(),
    ads: new Set(),
    adFrames: new Set(),
    recentAds: [],
    timer: 0,
  });
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

// The toolbar button: its badge is this page's blocked count, its tooltip
// the counts and mode, its icon the mode. Coalesced, since a page can block
// dozens of requests in a burst.
const ICONS = { block: "icons/veil.svg", veil: "icons/veil-veiled.svg", off: "icons/veil-off.svg" };
// A neutral badge, readable on light and dark toolbars.
browser.browserAction.setBadgeBackgroundColor({ color: "#5b5b66" });
browser.browserAction.setBadgeTextColor({ color: "#ffffff" });

// browserAction setters return a promise or nothing depending on the
// method; either way a closed tab is not an error worth reporting.
function quietly(call) {
  try {
    Promise.resolve(call()).catch(() => {});
  } catch {
    // The tab closed first.
  }
}

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
    // Not a web page (new tab, settings): nothing to count.
    quietly(() => browser.browserAction.setTitle({ tabId, title: "Ad Veil" }));
    quietly(() => browser.browserAction.setIcon({ tabId, path: ICONS.block }));
    quietly(() => browser.browserAction.setBadgeText({ tabId, text: "" }));
    return;
  }
  const mode = modeOf(site, state.incognito);
  const counts = `${state.blocked} blocked, ${state.hidden} hidden on this page`;
  const title = {
    block: `Ad Veil: ${counts}`,
    veil: `Ad Veil, veil mode: ${counts}`,
    off: `Ad Veil is off for ${site}`,
  }[mode];
  quietly(() => browser.browserAction.setTitle({ tabId, title }));
  quietly(() => browser.browserAction.setIcon({ tabId, path: ICONS[mode] }));
  quietly(() => browser.browserAction.setBadgeText({ tabId, text: mode == "off" ? "" : VeilModel.badgeText(state.blocked) }));
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
  const host = VeilModel.hostOf(details.url);
  const state = tabs.get(details.tabId);
  if (state) {
    state.blocked++;
    if (host) {
      state.blockedHosts.set(host, (state.blockedHosts.get(host) || 0) + 1);
    }
    scheduleAction(details.tabId);
  }
  addTotals(details.incognito, "blocked", 1);
  if (settings.vault && !details.incognito && site && host) {
    VeilVault.countBlocked(site, host, Date.now());
  }
  return { cancel: true };
}

function decide(details) {
  const site = VeilModel.siteOf(topUrl(details));
  const mode = modeOf(site, details.incognito);
  // Every request the page makes counts toward "N% of requests" and the
  // domains it contacted, whatever happens to it.
  const state = tabs.get(details.tabId);
  if (state) {
    state.requests++;
    const host = VeilModel.hostOf(details.url);
    if (host) {
      state.domains.add(host);
    }
  }
  if (mode == "off") {
    return {};
  }
  const source = details.documentUrl || details.originUrl || details.url;
  if (engines.all.check(details.url, source, details.type) != 1) {
    return {};
  }
  if (mode == "veil" && !NON_VISUAL.has(details.type)) {
    // Loads; ads are hidden in place by the cosmetic rules. EasyPrivacy is
    // not kept here: it lists whole ad networks and bidders as trackers,
    // and with it no real ad slot fills (measured, docs/design/ADS.md).
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

// An ad frame describes its own ad (the page cannot look into it): a frame
// from an EasyList ad server host, or one the page found in a hidden slot.
const MAX_AD_FRAMES = 200;
const MAX_AD_FRAMES_PER_MESSAGE = 50;

function frameKey(url) {
  if (!VeilModel.hostOf(url)) {
    return null;
  }
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

function isAdFrame(sender) {
  if (!sender.frameId) {
    return false;
  }
  if (VeilModel.covers(adHostSet, VeilModel.hostOf(sender.url))) {
    return true;
  }
  return !!tabs.get(sender.tab?.id)?.adFrames.has(frameKey(sender.url));
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
      return Promise.resolve({ active: true, selectors, adFrame: isAdFrame(sender) });
    }
    // Cross-origin frames the page found in hidden ad slots.
    case "adframes": {
      const state = tabs.get(sender.tab?.id);
      if (status && state && Array.isArray(message.urls)) {
        for (const url of message.urls.slice(0, MAX_AD_FRAMES_PER_MESSAGE)) {
          const key = typeof url == "string" && url.length <= 2048 ? frameKey(url) : null;
          if (key && state.adFrames.size < MAX_AD_FRAMES) {
            state.adFrames.add(key);
          }
        }
      }
      return undefined;
    }
    // A frame asking, after it loaded, whether the page found it in a slot.
    case "adframe?": {
      return Promise.resolve({ adFrame: !!status && isAdFrame(sender) });
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
      addTotals(sender.tab.incognito, "hidden", count);
      scheduleAction(sender.tab.id);
      if (!Array.isArray(message.ads)) {
        return undefined;
      }
      const now = Date.now();
      const site = VeilModel.siteOf(sender.tab.url);
      const entries = [];
      for (const raw of message.ads.slice(0, MAX_ADS_PER_MESSAGE)) {
        const ad = VeilModel.adFrom(raw);
        const key = ad && `${ad.link}|${ad.creative}`;
        if (!ad) {
          continue;
        }
        if (state.ads.has(key)) {
          // Seen already; its image may have finished loading since.
          if (ad.loaded && status.collect && settings.saveImages) {
            wantImage(ad.creative);
          }
          continue;
        }
        state.ads.add(key);
        const entry = { time: now, site, page: sender.tab.url, ...ad };
        if (state.recentAds.length < MAX_RECENT_ADS) {
          state.recentAds.push(entry);
        }
        entries.push(entry);
      }
      if (status.collect) {
        VeilVault.addAds(entries).catch(error => console.error("Ad Veil: vault write failed", error));
        if (settings.saveImages) {
          for (const entry of entries) {
            if (entry.loaded) {
              wantImage(entry.creative);
            }
          }
        }
      }
      return undefined;
    }
  }
  return undefined;
}

const MAX_POPUP_HOSTS = 8;

async function tabSummary(tabId) {
  const state = await tabState(tabId);
  const site = state && VeilModel.siteOf(state.url);
  const hosts = [...(state?.blockedHosts || [])]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([host, count]) => ({ host, count }));
  return {
    ready: !!engines,
    site,
    incognito: !!state?.incognito,
    mode: site ? modeOf(site, state.incognito) : "block",
    requests: state?.requests || 0,
    blocked: state?.blocked || 0,
    hidden: state?.hidden || 0,
    domains: state?.domains.size || 0,
    blockedDomains: hosts.length,
    hosts: hosts.slice(0, MAX_POPUP_HOSTS),
    moreHosts: Math.max(hosts.length - MAX_POPUP_HOSTS, 0),
    ads: await withThumbs(state?.recentAds || []),
    totals,
  };
}

// Ads with their saved image (a Blob), when there is one.
async function withThumbs(ads) {
  if (!ads.length) {
    return ads;
  }
  const thumbs = await VeilVault.imagesFor(ads.map(ad => ad.creative)).catch(() => new Map());
  return ads.map(ad => ({ ...ad, thumb: thumbs.get(ad.creative) || null }));
}

// The sites with a mode of their own (normal windows; private choices are
// not listed anywhere).
function siteList() {
  return [
    ...settings.veilSites.map(site => ({ site, mode: "veil" })),
    ...settings.offSites.map(site => ({ site, mode: "off" })),
  ].sort((a, b) => a.site.localeCompare(b.site));
}

const SETTINGS_KEYS = ["vault", "saveImages"];

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

// Messages from Ad Veil's own pages (popup.html, dashboard.html).
function ownMessage(message) {
  switch (message.type) {
    case "popup:state":
      return tabSummary(message.tabId);
    case "popup:setMode":
      return setMode(message.tabId, message.mode);
    case "dash:summary":
      return VeilVault.summary().then(vault => ({
        ready: !!engines,
        vault,
        totals,
        settings: { vault: settings.vault, saveImages: settings.saveImages },
        sites: siteList(),
        lists: listsInfo,
      }));
    // A site's mode from the dashboard (no tab: nothing to reload).
    case "dash:setSiteMode": {
      const site = typeof message.site == "string" ? VeilModel.siteOf(`https://${message.site.trim()}/`) : null;
      if (!site || !VeilModel.MODES.includes(message.mode)) {
        return Promise.resolve(siteList());
      }
      return saveSettings({ ...settings, ...VeilModel.withMode(settings, site, message.mode) }).then(siteList);
    }
    case "dash:setSetting":
      if (!SETTINGS_KEYS.includes(message.key) || typeof message.value != "boolean") {
        return Promise.resolve(settings);
      }
      return saveSettings({ ...settings, [message.key]: message.value }).then(() => settings);
    case "vault:ads":
      return VeilVault.everything();
    // One ad (every sighting of it) from the vault view.
    case "vault:remove": {
      const ids = Array.isArray(message.ids) ? message.ids.filter(Number.isSafeInteger).slice(0, VeilModel.MAX_ADS) : [];
      const creative = VeilModel.adFrom({ creative: message.creative })?.creative || null;
      return VeilVault.remove(ids, creative);
    }
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
