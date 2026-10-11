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
// 2. Finds the elements the applied rules hide, reports how many, and
//    describes the ads among them (link, image, text) for the popup and the
//    vault. Ads are usually drawn inside iframes a script writes after the
//    slot exists, so a described ad looks inside same-origin frames, and a
//    slot that shows nothing yet is looked at again a few times.
// 3. In an ad server's own frame (cross-origin, so the page cannot look
//    in), describes that frame's ad itself once it has loaded.
// That work runs when the page is idle. If Ad Veil is off for the site, it
// stops at the first answer.

(() => {
  const CHUNK = 100;
  const MAX_TEXT = 400;
  // Smaller images are tracking pixels and spacers, not ads.
  const MIN_IMAGE_AREA = 32 * 32;
  const FRAME_DEPTH = 3;
  // When to look again at a slot whose ad has not been drawn yet (ms).
  const RETRIES = [1000, 3000, 8000, 15000];

  const sent = new Set();
  let classes = [];
  let ids = [];
  let nameTimer = 0;

  let active = true;
  // Scans wait for the first answer.
  let started = false;
  const selectors = [];
  const found = new WeakSet();
  let idle = 0;
  // Hidden slots with nothing to show yet, and how often they were tried.
  const waiting = new Map();
  const reported = new Set();

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

  const isWeb = url => /^https?:/i.test(url || "");

  // Visible words only: no script, style, or template text.
  function textOf(root) {
    const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node =>
        node.parentElement?.closest("script, style, noscript, template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text = "";
    while (walker.nextNode() && text.length < MAX_TEXT) {
      text += ` ${walker.currentNode.nodeValue}`;
    }
    return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  // Cross-origin frames found in hidden slots: their own content script
  // describes them, once the background knows they are ads.
  const adFrameUrls = new Set();

  // The documents of same-origin frames under `root` (an ad's friendly
  // iframe, often about:blank written by a script), a few levels deep.
  function frameDocuments(root, depth = 0) {
    if (depth >= FRAME_DEPTH) {
      return [];
    }
    const docs = [];
    for (const frame of root.querySelectorAll("iframe, frame")) {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch {
        // Cross-origin.
      }
      if (doc?.body) {
        docs.push(doc, ...frameDocuments(doc, depth + 1));
      } else if (!doc && isWeb(frame.src) && !adFrameUrls.has(frame.src)) {
        adFrameUrls.add(frame.src);
        browser.runtime.sendMessage({ type: "adframes", urls: [frame.src] }).catch(() => {});
      }
    }
    return docs;
  }

  // An ad's largest real image, its link, and its words; null when it shows
  // nothing yet. `loaded` says the page already fetched the image (only
  // those are saved to the vault).
  function describe(root) {
    const scopes = [root, ...frameDocuments(root)];
    let best = null;
    for (const scope of scopes) {
      for (const img of scope.querySelectorAll("img")) {
        const src = img.currentSrc || img.src;
        // The size it is shown at (its attributes in a hidden slot), else
        // its own: a 1×1 pixel stays a pixel whatever file it shows.
        const area = (img.width || img.naturalWidth) * (img.height || img.naturalHeight);
        if (isWeb(src) && area >= MIN_IMAGE_AREA && (!best || area > best.area)) {
          best = { img, src, area };
        }
      }
    }
    const anchor =
      best?.img.closest("a[href]") ||
      (root.closest ? root.closest("a[href]") : null) ||
      scopes.map(scope => [...scope.querySelectorAll("a[href]")].find(a => isWeb(a.href))).find(Boolean);
    const link = isWeb(anchor?.href) ? anchor.href : null;
    if (!best && !link) {
      return null;
    }
    const text = scopes
      .map(scope => textOf(scope.body || scope))
      .filter(Boolean)
      .join(" ")
      .slice(0, MAX_TEXT);
    return {
      link,
      creative: best?.src || null,
      loaded: !!best && best.img.complete && best.img.naturalWidth > 0,
      text,
      image: best?.img || null,
    };
  }

  // Sends new ads; an ad whose image is still loading is sent again, as
  // loaded, when it is (the vault saves only images the page loaded).
  function send(count, ads) {
    const fresh = [];
    for (const { image, ...ad } of ads) {
      const key = `${ad.link}|${ad.creative}|${ad.loaded}`;
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      fresh.push(ad);
      if (!ad.loaded && image && !image.complete) {
        image.addEventListener("load", () => send(0, [{ ...ad, loaded: image.naturalWidth > 0, image: null }]), { once: true });
      }
    }
    if (count || fresh.length) {
      browser.runtime.sendMessage({ type: "hidden", count, ads: fresh }).catch(() => {});
    }
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
        const ad = describe(element);
        if (ad) {
          ads.push(ad);
        } else {
          wait(element);
        }
      }
    }
    send(count, ads);
  }

  // A slot whose ad is not drawn yet: look again later, and when a frame in
  // it loads.
  function wait(element) {
    if (waiting.has(element)) {
      return;
    }
    waiting.set(element, 0);
    for (const frame of element.querySelectorAll("iframe")) {
      frame.addEventListener("load", () => retry(element), { once: true });
    }
    setTimeout(() => retry(element), RETRIES[0]);
  }

  function retry(element) {
    if (!active || !waiting.has(element)) {
      return;
    }
    const ad = element.isConnected ? describe(element) : null;
    if (ad) {
      waiting.delete(element);
      send(0, [ad]);
      return;
    }
    const tries = waiting.get(element) + 1;
    if (tries >= RETRIES.length || !element.isConnected) {
      waiting.delete(element);
      return;
    }
    waiting.set(element, tries);
    setTimeout(() => retry(element), RETRIES[tries] - RETRIES[tries - 1]);
  }

  // This frame is an ad server's: describe its own ad once drawn.
  function describeOwnFrame() {
    let tries = 0;
    const look = () => {
      const ad = active && document.body ? describe(document.body) : null;
      if (ad) {
        send(0, [ad]);
      } else if (++tries < RETRIES.length) {
        setTimeout(look, RETRIES[tries] - RETRIES[tries - 1]);
      }
    };
    const start = () => setTimeout(look, RETRIES[0]);
    if (document.readyState == "complete") {
      start();
    } else {
      window.addEventListener("load", start, { once: true });
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
      started = true;
      applied(reply.selectors);
      schedule();
      if (reply.adFrame) {
        describeOwnFrame();
      } else if (window != window.top) {
        // The page may report this frame as an ad once it finds the slot.
        askAdFrame();
      }
    })
    .catch(() => {});

  function askAdFrame() {
    let tries = 0;
    const ask = () =>
      browser.runtime
        .sendMessage({ type: "adframe?" })
        .then(reply => {
          if (reply?.adFrame) {
            describeOwnFrame();
          } else if (++tries < RETRIES.length) {
            setTimeout(ask, RETRIES[tries] - RETRIES[tries - 1]);
          }
        })
        .catch(() => {});
    const start = () => setTimeout(ask, RETRIES[0]);
    if (document.readyState == "complete") {
      start();
    } else {
      window.addEventListener("load", start, { once: true });
    }
  }
})();
