/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil content script, in every http(s) frame from document_start (the
// parser's insertions arrive as mutations).
//
// 1. Reports the class and id names the document uses, so the background
//    applies only the generic rules that match them instead of the whole
//    generic list. Each name is sent once, batched.
// 2. Finds the elements the applied rules hide and reports how many, and,
//    when the vault records, the ads among them (link, creative, text).
//    That work runs when the page is idle.
// If Ad Veil is off for the site, it stops at the first answer.

(() => {
  const CHUNK = 100;
  const MAX_TEXT = 400;

  const sent = new Set();
  let classes = [];
  let ids = [];
  let nameTimer = 0;

  let active = true;
  // Scans wait for the first answer, which says whether to record ads.
  let started = false;
  let collect = false;
  const selectors = [];
  const found = new WeakSet();
  let idle = 0;

  function note(element) {
    for (const name of element.classList) {
      if (!sent.has(`.${name}`)) {
        sent.add(`.${name}`);
        classes.push(name);
      }
    }
    const id = element.id;
    if (id && !sent.has(`#${id}`)) {
      sent.add(`#${id}`);
      ids.push(id);
    }
  }

  function applied(list) {
    if (active && Array.isArray(list) && list.length) {
      selectors.push(...list);
      schedule();
    }
  }

  function flushNames() {
    nameTimer = 0;
    if (!active || (!classes.length && !ids.length)) {
      return;
    }
    browser.runtime
      .sendMessage({ type: "seen", classes, ids })
      .then(reply => applied(reply?.selectors))
      .catch(() => {});
    classes = [];
    ids = [];
  }

  // A link, an image or frame source, and some text: what an ad shows.
  function describe(element) {
    const link = element.closest("a[href]") || element.querySelector("a[href]");
    const image = element.matches("img") ? element : element.querySelector("img[src], img[srcset]");
    const frame = element.matches("iframe[src]") ? element : element.querySelector("iframe[src]");
    return {
      link: link?.href,
      creative: image?.currentSrc || image?.src || frame?.src,
      text: (element.textContent || "").slice(0, MAX_TEXT),
    };
  }

  function matching(list) {
    try {
      return document.querySelectorAll(list.join(","));
    } catch {
      // One selector Gecko's querySelectorAll rejects (rules accept a few
      // it does not, such as pseudo-elements): the rest, one at a time.
      return list.flatMap(selector => {
        try {
          return [...document.querySelectorAll(selector)];
        } catch {
          return [];
        }
      });
    }
  }

  function scan() {
    idle = 0;
    if (!active) {
      return;
    }
    let count = 0;
    const ads = [];
    for (let i = 0; i < selectors.length; i += CHUNK) {
      for (const element of matching(selectors.slice(i, i + CHUNK))) {
        if (found.has(element)) {
          continue;
        }
        found.add(element);
        count++;
        if (collect) {
          ads.push(describe(element));
        }
      }
    }
    if (count) {
      browser.runtime.sendMessage({ type: "hidden", count, ads }).catch(() => {});
    }
  }

  function schedule() {
    if (active && started && selectors.length && !idle) {
      idle = requestIdleCallback(scan, { timeout: 1000 });
    }
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type == "attributes") {
        note(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType != Node.ELEMENT_NODE) {
          continue;
        }
        note(node);
        for (const element of node.querySelectorAll("[class], [id]")) {
          note(element);
        }
      }
    }
    // The first batch of names goes out at once; later ones are coalesced.
    nameTimer ||= setTimeout(flushNames, sent.size > classes.length + ids.length ? 100 : 0);
    schedule();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });

  browser.runtime
    .sendMessage({ type: "applied" })
    .then(reply => {
      if (!reply?.active) {
        active = false;
        observer.disconnect();
        return;
      }
      collect = !!reply.collect;
      started = true;
      applied(reply.selectors);
      schedule();
    })
    .catch(() => {});
})();
