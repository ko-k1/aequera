/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The vault (docs/design/ADS.md, Vault): what Ad Veil blocked and hid, kept
// only in this add-on's IndexedDB. The background page is its only writer.
//
// - ads: one entry per hidden ad (time, site, page, link, creative, text),
//   newest kept, capped at VeilModel.MAX_ADS;
// - blocked: per day, site, and blocked host, a request count (a page can
//   block dozens of requests; individual entries would drown the ads);
// - images: a small copy of an ad's image (by its URL, so ads sharing one
//   image share the copy), saved when the ad was recorded.
// All are dropped after VeilModel.RETENTION_DAYS. If the database cannot be
// opened it is deleted and recreated once (known-good: an empty vault);
// blocking never depends on it.

var VeilVault = (() => {
  const NAME = "adveil-vault";
  // 2: images.
  const VERSION = 2;
  const MAX_IMAGES = 2000;
  // Blocked counts are summed in memory and written in one transaction.
  const FLUSH_MS = 5000;

  let opening = null;
  const pending = new Map();
  let flushTimer = 0;

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function openOnce() {
    const req = indexedDB.open(NAME, VERSION);
    // From any earlier version: create what is missing, keep what exists.
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = name => db.objectStoreNames.contains(name);
      if (!has("ads")) {
        db.createObjectStore("ads", { keyPath: "id", autoIncrement: true }).createIndex("time", "time");
      }
      if (!has("blocked")) {
        db.createObjectStore("blocked", { keyPath: "key" }).createIndex("day", "day");
      }
      if (!has("images")) {
        db.createObjectStore("images", { keyPath: "creative" }).createIndex("time", "time");
      }
    };
    return request(req);
  }

  function db() {
    opening ||= openOnce().catch(async error => {
      console.error("Ad Veil: vault unreadable, starting an empty one", error);
      await request(indexedDB.deleteDatabase(NAME));
      return openOnce();
    });
    return opening;
  }

  // Runs `work(stores)` in one transaction; resolves with its result once
  // the transaction has committed.
  async function transaction(names, mode, work) {
    const tx = (await db()).transaction(names, mode);
    const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
    const result = work(stores);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  }

  function addAds(entries) {
    if (!entries.length) {
      return Promise.resolve();
    }
    return transaction(["ads"], "readwrite", ({ ads }) => {
      for (const entry of entries) {
        ads.add(entry);
      }
    });
  }

  async function hasImage(creative) {
    const tx = (await db()).transaction(["images"], "readonly");
    return (await request(tx.objectStore("images").count(creative))) > 0;
  }

  // `width` and `height`: the image's own size (0 when unknown; entries from
  // before they were kept have none).
  function saveImage(creative, { blob, width = 0, height = 0 }) {
    return transaction(["images"], "readwrite", ({ images }) => {
      images.put({ creative, blob, width, height, time: Date.now() });
    });
  }

  // The saved images for these creatives (a Map), in one transaction.
  async function imagesFor(creatives) {
    const wanted = [...new Set(creatives.filter(Boolean))];
    if (!wanted.length) {
      return new Map();
    }
    const store = (await db()).transaction(["images"], "readonly").objectStore("images");
    const found = await Promise.all(wanted.map(creative => request(store.get(creative))));
    return new Map(found.filter(Boolean).map(entry => [entry.creative, entry.blob]));
  }

  function countBlocked(site, host, time) {
    const day = VeilModel.dayOf(time);
    const key = `${day}|${site}|${host}`;
    const entry = pending.get(key) || { key, day, site, host, count: 0 };
    entry.count++;
    pending.set(key, entry);
    flushTimer ||= setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    flushTimer = 0;
    const entries = [...pending.values()];
    pending.clear();
    if (!entries.length) {
      return;
    }
    await transaction(["blocked"], "readwrite", ({ blocked }) => {
      for (const entry of entries) {
        const get = blocked.get(entry.key);
        get.onsuccess = () => {
          const count = (get.result?.count || 0) + entry.count;
          blocked.put({ ...entry, count });
        };
      }
    });
  }

  // Drops entries past retention, then the oldest ads past the cap.
  // Deletes the entries of `index` in `range` (oldest first), at most `limit`.
  function deleteFrom(index, range, limit = Infinity) {
    let left = limit;
    index.openCursor(range).onsuccess = event => {
      const cursor = event.target.result;
      if (cursor && left-- > 0) {
        cursor.delete();
        cursor.continue();
      }
    };
  }

  // Keeps the newest `max` entries of `store` (by its time index).
  function cap(store, max) {
    store.count().onsuccess = event => {
      const excess = event.target.result - max;
      if (excess > 0) {
        deleteFrom(store.index("time"), null, excess);
      }
    };
  }

  // Drops entries past retention, then the oldest past each cap.
  async function prune(now = Date.now()) {
    const oldest = VeilModel.cutoff(now);
    await transaction(["ads", "blocked", "images"], "readwrite", ({ ads, blocked, images }) => {
      deleteFrom(ads.index("time"), IDBKeyRange.upperBound(oldest, true));
      deleteFrom(blocked.index("day"), IDBKeyRange.upperBound(VeilModel.dayOf(oldest), true));
      deleteFrom(images.index("time"), IDBKeyRange.upperBound(oldest, true));
    });
    // Counted after the expired entries are gone.
    await transaction(["ads", "images"], "readwrite", ({ ads, images }) => {
      cap(ads, VeilModel.MAX_ADS);
      cap(images, MAX_IMAGES);
    });
  }

  function collect(source, query, direction, limit) {
    return new Promise((resolve, reject) => {
      const out = [];
      const req = source.openCursor(query, direction);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // The dashboard's blocking view: blocked totals for the last `days` days,
  // by day, blocked host, and site.
  async function summary({ days = 7, now = Date.now() } = {}) {
    await flush();
    const start = new Date(now);
    const since = VeilModel.dayOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() - (days - 1)).getTime());
    const tx = (await db()).transaction(["blocked"], "readonly");
    const blocked = await collect(tx.objectStore("blocked").index("day"), IDBKeyRange.lowerBound(since), "next", Infinity);
    const total = blocked.reduce((n, e) => n + e.count, 0);
    const top = key => {
      const sums = new Map();
      for (const entry of blocked) {
        sums.set(entry[key], (sums.get(entry[key]) || 0) + entry.count);
      }
      return [...sums].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    };
    // Blocked per day, oldest first, every day present (0 when quiet).
    const perDay = new Map();
    for (const entry of blocked) {
      perDay.set(entry.day, (perDay.get(entry.day) || 0) + entry.count);
    }
    // Calendar days, not 24-hour steps (a DST day is 23 or 25 hours).
    const today = new Date(now);
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = VeilModel.dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime());
      series.push({ day, count: perDay.get(day) || 0 });
    }
    return { days, blocked: total, series, hosts: top("host"), sites: top("site") };
  }

  // The vault view: every ad entry (at most VeilModel.MAX_ADS) and the saved
  // image of each creative that has one ([creative, { blob, width, height }]
  // pairs; pages make the URLs, so viewing makes no request).
  async function everything() {
    const tx = (await db()).transaction(["ads", "images"], "readonly");
    const [ads, images] = await Promise.all([
      collect(tx.objectStore("ads"), null, "next", Infinity),
      collect(tx.objectStore("images"), null, "next", Infinity),
    ]);
    return {
      ads,
      images: images.map(entry => [entry.creative, { blob: entry.blob, width: entry.width || 0, height: entry.height || 0 }]),
    };
  }

  // Removes ad entries by id (one ad and every sighting of it, from the
  // vault view), and the saved image of `creative`, if no entry left uses it.
  async function remove(ids, creative = null) {
    await transaction(["ads", "images"], "readwrite", ({ ads, images }) => {
      for (const id of ids) {
        ads.delete(id);
      }
      if (creative) {
        // After the deletes (requests run in order): any entry still showing it?
        const left = ads.openCursor();
        left.onsuccess = () => {
          const cursor = left.result;
          if (!cursor) {
            images.delete(creative);
          } else if (cursor.value.creative != creative) {
            cursor.continue();
          }
        };
      }
    });
  }

  async function exportAll() {
    await flush();
    const tx = (await db()).transaction(["ads", "blocked"], "readonly");
    const [ads, blocked] = await Promise.all([
      collect(tx.objectStore("ads"), null, "next", Infinity),
      collect(tx.objectStore("blocked"), null, "next", Infinity),
    ]);
    // Saved images stay out of the JSON (the creative URLs are in it).
    return { format: "aequera-adveil-vault", version: 1, ads, blocked };
  }

  async function clear() {
    pending.clear();
    await transaction(["ads", "blocked", "images"], "readwrite", ({ ads, blocked, images }) => {
      ads.clear();
      blocked.clear();
      images.clear();
    });
  }

  return { addAds, hasImage, saveImage, imagesFor, countBlocked, flush, prune, summary, everything, remove, exportAll, clear };
})();
