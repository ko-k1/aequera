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
//   block dozens of requests; individual entries would drown the ads).
// Both are dropped after VeilModel.RETENTION_DAYS. If the database cannot be
// opened it is deleted and recreated once (known-good: an empty vault);
// blocking never depends on it.

var VeilVault = (() => {
  const NAME = "adveil-vault";
  const VERSION = 1;
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
    req.onupgradeneeded = () => {
      const db = req.result;
      const ads = db.createObjectStore("ads", { keyPath: "id", autoIncrement: true });
      ads.createIndex("time", "time");
      const blocked = db.createObjectStore("blocked", { keyPath: "key" });
      blocked.createIndex("day", "day");
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
  async function prune(now = Date.now()) {
    const oldest = VeilModel.cutoff(now);
    const oldestDay = VeilModel.dayOf(oldest);
    await transaction(["ads", "blocked"], "readwrite", ({ ads, blocked }) => {
      ads.index("time").openCursor(IDBKeyRange.upperBound(oldest, true)).onsuccess = event => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      blocked.index("day").openCursor(IDBKeyRange.upperBound(oldestDay, true)).onsuccess = event => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    });
    // Counted after the expired entries are gone.
    await transaction(["ads"], "readwrite", ({ ads }) => {
      ads.count().onsuccess = event => {
        let excess = event.target.result - VeilModel.MAX_ADS;
        if (excess <= 0) {
          return;
        }
        ads.index("time").openCursor().onsuccess = e => {
          const cursor = e.target.result;
          if (cursor && excess-- > 0) {
            cursor.delete();
            cursor.continue();
          }
        };
      };
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

  // What the vault page shows: the newest ads and blocked totals for the
  // last `days` days, by blocked host and by site.
  async function summary({ ads = 300, days = 7, now = Date.now() } = {}) {
    await flush();
    const start = new Date(now);
    const since = VeilModel.dayOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() - (days - 1)).getTime());
    const tx = (await db()).transaction(["ads", "blocked"], "readonly");
    const [recent, blocked, adCount] = await Promise.all([
      collect(tx.objectStore("ads").index("time"), null, "prev", ads),
      collect(tx.objectStore("blocked").index("day"), IDBKeyRange.lowerBound(since), "next", Infinity),
      request(tx.objectStore("ads").count()),
    ]);
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
    return { ads: recent, adCount, days, blocked: total, series, hosts: top("host"), sites: top("site") };
  }

  async function exportAll() {
    await flush();
    const tx = (await db()).transaction(["ads", "blocked"], "readonly");
    const [ads, blocked] = await Promise.all([
      collect(tx.objectStore("ads"), null, "next", Infinity),
      collect(tx.objectStore("blocked"), null, "next", Infinity),
    ]);
    return { format: "aequera-adveil-vault", version: 1, ads, blocked };
  }

  async function clear() {
    pending.clear();
    await transaction(["ads", "blocked"], "readwrite", ({ ads, blocked }) => {
      ads.clear();
      blocked.clear();
    });
  }

  return { addAds, countBlocked, flush, prune, summary, exportAll, clear };
})();
