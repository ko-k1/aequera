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

  // saveImages: keep a small copy of each hidden ad's image in the vault,
  // fetched once when the ad is recorded, and only for images the page had
  // already loaded; the popup and vault then show it without a request.
  const DEFAULT_SETTINGS = Object.freeze({ offSites: [], veilSites: [], vault: true, saveImages: true });

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
    const flag = name => (typeof value[name] == "boolean" ? value[name] : DEFAULT_SETTINGS[name]);
    return {
      offSites: sitesFrom(value.offSites),
      veilSites: sitesFrom(value.veilSites),
      vault: flag("vault"),
      saveImages: flag("saveImages"),
    };
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
    return { link, creative, text, loaded: raw.loaded === true && !!creative };
  }

  // Where an ad leads: ad click URLs (googleads.g.doubleclick.net/pcs/click
  // and the like) carry the advertiser's address in a parameter; else the
  // link itself. Null for anything that is not an http(s) URL.
  const DESTINATION_PARAMS = ["adurl", "url", "dest", "redirect", "u"];
  function destinationOf(link) {
    const url = parse(link);
    if (!url) {
      return null;
    }
    for (const name of DESTINATION_PARAMS) {
      const target = parse(url.searchParams.get(name));
      if (target) {
        return target.href;
      }
    }
    return url.href;
  }

  // Vault entries (in any order) as AdNauseam-style groups: the same ad seen
  // again, on this site or another, is one group with every sighting. An
  // image ad is its image; a text ad, its words and the site it leads to.
  // Newest group first, each group's sightings newest first.
  function groupAds(ads) {
    const groups = new Map();
    for (const ad of ads) {
      const text = ad.text || "";
      const destination = ad.link ? destinationOf(ad.link) : null;
      const key = ad.creative ? `image|${ad.creative}` : `text|${siteOf(destination) || ""}|${text.toLowerCase()}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          kind: ad.creative ? "image" : "text",
          creative: ad.creative || null,
          destination,
          text,
          first: ad.time,
          last: ad.time,
          sightings: [],
        };
        groups.set(key, group);
      }
      group.sightings.push({ id: ad.id, time: ad.time, site: ad.site || null, page: ad.page || null });
      if (ad.time < group.first) {
        group.first = ad.time;
      }
      // The newest sighting's link and words name the group; earlier ones
      // fill in what it lacks.
      if (ad.time >= group.last) {
        group.last = ad.time;
        group.destination = destination || group.destination;
        group.text = text || group.text;
      } else {
        group.destination ||= destination;
        group.text ||= text;
      }
    }
    const list = [...groups.values()];
    for (const group of list) {
      group.sightings.sort((a, b) => b.time - a.time);
    }
    return list.sort((a, b) => b.last - a.last);
  }

  // The groups with only the sightings a filter keeps; empty groups are
  // dropped. `from` and `to` are days (dayOf), inclusive; `kind` is "image"
  // or "text"; `query` matches words, destination, image URL, and site.
  function filterGroups(groups, { from = null, to = null, site = null, kind = null, query = "" } = {}) {
    const words = query.trim().toLowerCase();
    const out = [];
    for (const group of groups) {
      if (kind && group.kind != kind) {
        continue;
      }
      const sightings = group.sightings.filter(sighting => {
        const day = dayOf(sighting.time);
        return (!from || day >= from) && (!to || day <= to) && (!site || sighting.site == site);
      });
      if (!sightings.length) {
        continue;
      }
      const fields = [group.text, group.destination, group.creative, ...sightings.map(s => s.site)];
      if (words && !fields.some(value => (value || "").toLowerCase().includes(words))) {
        continue;
      }
      out.push(
        sightings.length == group.sightings.length ? group : { ...group, sightings, first: sightings.at(-1).time, last: sightings[0].time }
      );
    }
    return out;
  }

  // Ads found per day (sightings), oldest first, every calendar day present:
  // from the first sighting (at least MIN_TIMELINE_DAYS back) to today, at
  // most the retention period.
  const MIN_TIMELINE_DAYS = 14;
  function adsPerDay(groups, now) {
    const counts = new Map();
    let first = now;
    for (const group of groups) {
      for (const { time } of group.sightings) {
        const day = dayOf(time);
        counts.set(day, (counts.get(day) || 0) + 1);
        first = Math.min(first, time);
      }
    }
    const today = new Date(now);
    const midnight = time => {
      const date = new Date(time);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    };
    const span = Math.round((midnight(now) - midnight(first)) / 86400000) + 1;
    const days = Math.min(Math.max(span, MIN_TIMELINE_DAYS), RETENTION_DAYS);
    const series = [];
    // Calendar days, not 24-hour steps (a DST day is 23 or 25 hours).
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime());
      series.push({ day, count: counts.get(day) || 0 });
    }
    return series;
  }

  // The vault's numbers: ads found (sightings), different ads, advertisers
  // (the sites ads lead to), sites they were found on, by kind, and the top
  // advertisers, ad networks (the sites serving the images), and sites.
  const TOP = 8;
  function vaultStats(groups) {
    const add = (map, name, n) => name && map.set(name, (map.get(name) || 0) + n);
    const top = map =>
      [...map]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP)
        .map(([name, count]) => ({ name, count }));
    const advertisers = new Map();
    const networks = new Map();
    const sites = new Map();
    const kinds = { image: 0, text: 0 };
    let found = 0;
    let since = null;
    for (const group of groups) {
      const n = group.sightings.length;
      found += n;
      kinds[group.kind] += n;
      since = since == null ? group.first : Math.min(since, group.first);
      add(advertisers, siteOf(group.destination), n);
      add(networks, siteOf(group.creative), n);
      for (const sighting of group.sightings) {
        add(sites, sighting.site, 1);
      }
    }
    return {
      found,
      unique: groups.length,
      advertisers: advertisers.size,
      sites: sites.size,
      since,
      kinds,
      top: { advertisers: top(advertisers), networks: top(networks), sites: top(sites) },
    };
  }

  // The size an ad is shown at on the vault's canvas: its own size, at most
  // MAX_AD_WIDTH wide (AdNauseam's limit), and no smaller than MIN_AD_SIDE
  // on its short side. Null when its size is unknown.
  const MAX_AD_WIDTH = 800;
  const MIN_AD_SIDE = 24;
  function adSize(width, height) {
    if (!(width > 0 && height > 0)) {
      return null;
    }
    const scale = Math.max(Math.min(1, MAX_AD_WIDTH / width), MIN_AD_SIDE / Math.min(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  // Packs ads ({ width, height }, in order) around the origin, as
  // AdNauseam's vault does: each goes where its middle is closest to the
  // origin (horizontal distance counting less, so the collage is wider than
  // tall), on top of or under what is already placed, never overlapping and
  // `gap` apart. Columns of PACK_UNIT px track the lowest and highest edge
  // placed in them. Returns each ad's top-left corner and the bounds.
  const PACK_UNIT = 16;
  const PACK_COLUMNS = 1024;
  const PACK_WIDE = 0.6;

  // The largest of each `span` consecutive values of `values` starting at
  // `from`, `from + 1`, … up to `last` (sliding window, linear time).
  function windowMax(values, span, from, last, out) {
    const queue = new Int32Array(last + span - from + 1);
    let head = 0;
    let tail = 0;
    for (let k = from; k < last + span; k++) {
      while (tail > head && values[queue[tail - 1]] <= values[k]) {
        tail--;
      }
      queue[tail++] = k;
      const start = k - span + 1;
      if (start >= from) {
        if (queue[head] < start) {
          head++;
        }
        out[start] = values[queue[head]];
      }
    }
  }

  function packAds(sizes, { gap = 12 } = {}) {
    const mid = PACK_COLUMNS / 2;
    // Per column: the bottom edge below the origin, the top edge above it
    // (as a distance up), each with the gap after it.
    const below = new Float64Array(PACK_COLUMNS);
    const above = new Float64Array(PACK_COLUMNS).fill(gap);
    const downs = new Float64Array(PACK_COLUMNS);
    const ups = new Float64Array(PACK_COLUMNS);
    // Columns used so far: nothing beyond them is closer to the middle than
    // the first free columns next to them.
    let used = [mid, mid];
    const positions = [];
    const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    for (const { width, height } of sizes) {
      const span = Math.min(Math.max(Math.ceil((width + gap) / PACK_UNIT), 1), PACK_COLUMNS);
      const from = Math.max(0, Math.min(used[0] - span, mid - Math.ceil(span / 2)));
      const last = Math.min(PACK_COLUMNS - span, Math.max(used[1], mid - Math.floor(span / 2)));
      windowMax(below, span, from, last, downs);
      windowMax(above, span, from, last, ups);
      let best = null;
      for (let c = from; c <= last; c++) {
        const down = downs[c];
        const up = ups[c];
        const dx = (c + span / 2 - mid) * PACK_UNIT * PACK_WIDE;
        const downCost = Math.hypot(dx, down + height / 2);
        const upCost = Math.hypot(dx, up + height / 2);
        const cost = Math.min(downCost, upCost);
        if (!best || cost < best.cost) {
          best = downCost <= upCost ? { cost, c, y: down, under: true } : { cost, c, y: -(up + height), under: false };
        }
      }
      for (let k = best.c; k < best.c + span; k++) {
        if (best.under) {
          below[k] = best.y + height + gap;
        } else {
          above[k] = -best.y + gap;
        }
      }
      used = [Math.min(used[0], best.c), Math.max(used[1], best.c + span)];
      const x = (best.c - mid) * PACK_UNIT + (span * PACK_UNIT - width) / 2;
      positions.push({ x, y: best.y });
      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x + width);
      bounds.top = Math.min(bounds.top, best.y);
      bounds.bottom = Math.max(bounds.bottom, best.y + height);
    }
    return { positions, bounds };
  }

  // All-time counts (normal windows only), whatever was stored: counts are
  // whole non-negative numbers, `since` a past time (else `now`).
  function totalsFrom(stored, now) {
    const value = stored && typeof stored == "object" ? stored : {};
    const count = n => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
    const since = Number.isFinite(value.since) && value.since > 0 && value.since <= now ? value.since : now;
    return { blocked: count(value.blocked), hidden: count(value.hidden), since };
  }

  // The toolbar badge: nothing for 0, then 1–999, 1.2k, 12k, 1.2M.
  function badgeText(count) {
    if (!Number.isFinite(count) || count < 1) {
      return "";
    }
    const short = (n, unit) => `${n < 10 ? Math.floor(n * 10) / 10 : Math.floor(n)}${unit}`;
    if (count < 1000) {
      return String(Math.floor(count));
    }
    if (count < 1e6) {
      return short(count / 1000, "k");
    }
    return short(count / 1e6, "M");
  }

  // A filter list's "! Version:" header and its rule count (lines that are
  // not blank, comments, or the "[Adblock Plus …]" header).
  function listInfo(text) {
    const version = /^! Version:\s*(\S+)/m.exec(text)?.[1] || null;
    let rules = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("!") && !trimmed.startsWith("[")) {
        rules++;
      }
    }
    return { version, rules };
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
    destinationOf,
    groupAds,
    filterGroups,
    adsPerDay,
    vaultStats,
    adSize,
    packAds,
    totalsFrom,
    badgeText,
    listInfo,
    dayOf,
    cutoff,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = VeilModel;
}
