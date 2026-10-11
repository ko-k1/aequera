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

  const DEFAULT_SETTINGS = Object.freeze({ offSites: [], vault: true });

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

  // A site turned off also covers its subdomains (news.example.com when
  // example.com is off), as a person expects of "this site".
  function isSiteOff(offSites, site) {
    if (!site) {
      return false;
    }
    for (let host = site; ; ) {
      if (offSites.has(host)) {
        return true;
      }
      const dot = host.indexOf(".");
      if (dot < 0) {
        return false;
      }
      host = host.slice(dot + 1);
    }
  }

  function isSite(value) {
    return typeof value == "string" && value.length > 0 && value.length <= 253 && siteOf(`https://${value}/`) == value;
  }

  // Stored settings, whatever their state, to valid settings: unknown or
  // malformed values fall back to the defaults (AGENTS.md: configuration
  // failures recover to a known-good state).
  function settingsFrom(stored) {
    const value = stored && typeof stored == "object" ? stored : {};
    const offSites = Array.isArray(value.offSites)
      ? [...new Set(value.offSites.filter(isSite))].slice(0, MAX_SITES)
      : [...DEFAULT_SETTINGS.offSites];
    const vault = typeof value.vault == "boolean" ? value.vault : DEFAULT_SETTINGS.vault;
    return { offSites, vault };
  }

  function withSite(offSites, site, on) {
    const next = new Set(offSites);
    if (on) {
      next.delete(site);
    } else {
      next.add(site);
    }
    return [...next].sort();
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
    siteOf,
    hostOf,
    isSiteOff,
    settingsFrom,
    withSite,
    adFrom,
    dayOf,
    cutoff,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = VeilModel;
}
