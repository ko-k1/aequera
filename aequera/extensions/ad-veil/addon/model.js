/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil's pure model (docs/design/ADS.md): sites, settings, and vault
// records. No browser APIs, so the same file runs in the background page and
// under node:test (model.test.mjs).

var VeilModel = (() => {
  // Vault retention (ADS.md, Vault).
  const RETENTION_DAYS = 90;
  const MAX_ADS = 5000;
  // Bounds on stored and received strings.
  const MAX_URL = 2048;
  const MAX_TEXT = 200;
  const MAX_SITES = 10000;

  const DEFAULT_SETTINGS = Object.freeze({ offSites: [], veilSites: [], vault: true });

  // Per site (ADS.md, Model): block (default), veil (ads load and are
  // hidden, trackers stay blocked), or off.
  const MODES = Object.freeze(["block", "veil", "off"]);

  function parse(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol == "http:" || parsed.protocol == "https:" ? parsed : null;
    } catch {
      return null;
    }
  }

  // The site a page belongs to, as the user names it: its host without a
  // leading "www.". Null for anything that is not an http(s) page.
  function siteOf(url) {
    const parsed = parse(url);
    if (!parsed || !parsed.hostname) {
      return null;
    }
    return parsed.hostname.replace(/^www\./, "");
  }

  function hostOf(url) {
    return parse(url)?.hostname || null;
  }

  // A site in a set also covers its subdomains (news.example.com when
  // example.com is in it), as a person expects of "this site".
  function covers(sites, site) {
    if (!site) {
      return false;
    }
    for (let host = site; ; ) {
      if (sites.has(host)) {
        return true;
      }
      const dot = host.indexOf(".");
      if (dot < 0) {
        return false;
      }
      host = host.slice(dot + 1);
    }
  }

  // `lists` holds Sets: { off, veil }. Off wins over veil.
  function siteMode(lists, site) {
    if (covers(lists.off, site)) {
      return "off";
    }
    return covers(lists.veil, site) ? "veil" : "block";
  }

  // The value of the nearest entry covering `site` (itself, then each parent
  // domain), or undefined.
  function nearest(map, site) {
    if (!site) {
      return undefined;
    }
    for (let host = site; ; ) {
      if (map.has(host)) {
        return map.get(host);
      }
      const dot = host.indexOf(".");
      if (dot < 0) {
        return undefined;
      }
      host = host.slice(dot + 1);
    }
  }

  // A page's mode. `state`: { off: Set, veil: Set, privateModes: Map }, the
  // last being choices made in private windows (memory only), which win
  // there over the profile's lists.
  function resolveMode(state, site, incognito) {
    if (incognito) {
      const mode = nearest(state.privateModes, site);
      if (mode) {
        return mode;
      }
    }
    return siteMode(state, site);
  }

  function isSite(value) {
    return typeof value == "string" && value.length > 0 && value.length <= 253 && siteOf(`https://${value}/`) == value;
  }

  function sitesFrom(value) {
    return Array.isArray(value) ? [...new Set(value.filter(isSite))].sort().slice(0, MAX_SITES) : [];
  }

  // Stored settings, whatever their state, to valid settings: unknown or
  // malformed values fall back to the defaults (AGENTS.md: configuration
  // failures recover to a known-good state).
  function settingsFrom(stored) {
    const value = stored && typeof stored == "object" ? stored : {};
    const vault = typeof value.vault == "boolean" ? value.vault : DEFAULT_SETTINGS.vault;
    return { offSites: sitesFrom(value.offSites), veilSites: sitesFrom(value.veilSites), vault };
  }

  // The site lists with `site` set to `mode` (an exact site; covered
  // subdomains keep their own entries).
  function withMode(settings, site, mode) {
    const off = new Set(settings.offSites);
    const veil = new Set(settings.veilSites);
    off.delete(site);
    veil.delete(site);
    if (mode == "off") {
      off.add(site);
    } else if (mode == "veil") {
      veil.add(site);
    }
    return { offSites: [...off].sort(), veilSites: [...veil].sort() };
  }

  // Ad server hosts: EasyList's whole-host rules (`||host^`, any type or
  // party option, never one limited to some sites). Veil mode lets these
  // through Firefox's fingerprinting protection, which lists the largest ad
  // networks too.
  function adHostsFrom(text) {
    const hosts = new Set();
    for (const match of text.matchAll(/^\|\|([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\^(?:\$([^\n]*))?$/gm)) {
      const options = match[2] || "";
      if (!/(?:^|,)(?:domain|from|to|denyallow|badfilter)\b/.test(options)) {
        hosts.add(match[1]);
      }
    }
    return [...hosts].sort();
  }

  function cleanUrl(value) {
    if (typeof value != "string" || value.length > MAX_URL) {
      return null;
    }
    return parse(value)?.href ?? null;
  }

  // One hidden ad as reported by a content script (untrusted input), or
  // null when it carries nothing worth keeping.
  function adFrom(raw) {
    if (!raw || typeof raw != "object") {
      return null;
    }
    const link = cleanUrl(raw.link);
    const creative = cleanUrl(raw.creative);
    const text = typeof raw.text == "string" ? raw.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
    if (!link && !creative) {
      return null;
    }
    return { link, creative, text };
  }

  // Local calendar day, for the blocked-request totals.
  function dayOf(time) {
    const date = new Date(time);
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function cutoff(now) {
    return now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  }

  return {
    RETENTION_DAYS,
    MAX_ADS,
    DEFAULT_SETTINGS,
    MODES,
    siteOf,
    hostOf,
    covers,
    siteMode,
    nearest,
    resolveMode,
    settingsFrom,
    withMode,
    adHostsFrom,
    adFrom,
    dayOf,
    cutoff,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = VeilModel;
}
