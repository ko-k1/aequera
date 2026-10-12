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
  // When to look again at a slot whose ad has not been drawn yet (ms); it is
  // also looked at whenever the page changes, until the last of these.
  const RETRIES = [1000, 3000, 8000, 15000, 30000, 60000];

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

  // The documents an ad element shows: its own (a frame's, same-origin) and
  // its frames'. A cross-origin frame is reported (it describes itself).
  function adDocuments(root) {
    if (!root.matches?.("iframe, frame")) {
      return frameDocuments(root);
    }
    let doc = null;
    try {
      doc = root.contentDocument;
    } catch {
      // Cross-origin.
    }
    if (doc?.body) {
      return [doc, ...frameDocuments(doc, 1)];
    }
    if (!doc && isWeb(root.src) && !adFrameUrls.has(root.src)) {
      adFrameUrls.add(root.src);
      browser.runtime.sendMessage({ type: "adframes", urls: [root.src] }).catch(() => {});
    }
    return [];
  }

  // The images in `scope`, the scope itself when it is one.
  const imagesIn = scope => [...(scope.matches?.("img") ? [scope] : []), ...scope.querySelectorAll("img")];

  // An ad's largest real image, its link, and its words; null when it shows
  // nothing yet. `loaded` says the page already fetched the image (only
  // those are saved to the vault).
  function describe(root) {
    const scopes = [root, ...adDocuments(root)];
    let best = null;
    for (const scope of scopes) {
      for (const img of imagesIn(scope)) {
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

  // Procedural filters (`:has-text()`, `:upward()`, `:remove()`, ...), run
  // by procedural.js. What they hide is marked with the frame's mark
  // attribute, which a user-origin rule hides the mode's way.
  let mark = null;
  let procedural = [];
  // Marked elements and their mark's value: "" hidden the mode's way, "o"
  // hidden by what it loads (out of the flow in veil mode).
  const marked = new WeakMap();

  function markHidden(element, value = "") {
    marked.set(element, value);
    if (element.getAttribute(mark) !== value) {
      element.setAttribute(mark, value);
    }
  }

  // Wrappers an ad leaves empty: once their ad is hidden, a box holding only
  // an "Advertisement" label, nothing, or other hidden ads would stay as an
  // empty frame. Such a wrapper is hidden too (marked), up to FOLD_LEVELS up,
  // and shown again if it gains content.
  const FOLD_LEVELS = 3;
  const FOLD_MAX_CHILDREN = 6;
  const FOLD_NEVER = /^(HTML|BODY|MAIN|ARTICLE|HEADER|FOOTER|NAV|FORM|UL|OL|TABLE|TBODY|TR)$/;
  const LABEL =
    /^(advertisement|advertisements|advertising|ad|ads|sponsored|sponsored content|paid content|story continues below advertisement|anzeige|werbung|publicité|publicidad|pubblicità|reklame|広告|スポンサー|广告|광고)$/i;
  const MEDIA = "img, iframe, video, canvas, svg, picture, object, embed";
  const folded = new Set();

  const hiddenByUs = element => found.has(element) || marked.has(element);

  function onlyDebris(wrapper) {
    if (FOLD_NEVER.test(wrapper.tagName) || wrapper.childElementCount > FOLD_MAX_CHILDREN) {
      return false;
    }
    for (const node of wrapper.childNodes) {
      if (node.nodeType == Node.TEXT_NODE) {
        const text = node.nodeValue.trim();
        if (text && !LABEL.test(text)) {
          return false;
        }
      } else if (node.nodeType == Node.ELEMENT_NODE && !hiddenByUs(node) && node.getClientRects().length) {
        const text = (node.textContent || "").trim();
        if ((text && !LABEL.test(text)) || node.matches(MEDIA) || node.querySelector(MEDIA)) {
          return false;
        }
      }
    }
    return true;
  }

  function fold(element) {
    let wrapper = element.parentElement;
    for (let level = 0; level < FOLD_LEVELS && wrapper && onlyDebris(wrapper); level++) {
      markHidden(wrapper);
      folded.add(wrapper);
      wrapper = wrapper.parentElement;
    }
  }

  function unfoldFilled() {
    for (const wrapper of folded) {
      if (!wrapper.isConnected) {
        folded.delete(wrapper);
      } else if (!onlyDebris(wrapper)) {
        folded.delete(wrapper);
        marked.delete(wrapper);
        wrapper.removeAttribute(mark);
      }
    }
  }

  // A newly hidden element: counted, described for the vault, its wrapper
  // folded.
  function hidden(element, ads) {
    found.add(element);
    const ad = describe(element);
    if (ad) {
      ads.push(ad);
    } else {
      wait(element);
    }
    if (mark) {
      fold(element);
    }
  }

  // Elements hidden by what they load: the background sends the URLs block
  // mode cancels (or, in veil mode, would have) that this frame, or a
  // same-origin frame in it, loads into an image, frame, object, or media
  // element. Their element is hidden (mark "o"): in block mode it would stay
  // an empty box, in veil mode it shows an ad no cosmetic rule names. In
  // veil mode it is described for the vault like any hidden ad.
  const URL_ELEMENTS = "img, iframe, frame, embed, object, video, audio, source";
  const PENDING_MS = 15000;
  const pendingUrls = new Map();
  let mode = null;

  function elementUrl(element) {
    switch (element.localName) {
      case "img":
      case "video":
      case "audio":
        return element.currentSrc || element.src;
      case "object":
        return element.data;
      default:
        return element.src;
    }
  }

  // Same-origin frame documents, without reporting cross-origin frames.
  function sameOriginDocuments(root, depth = 0) {
    const docs = [];
    if (depth >= FRAME_DEPTH) {
      return docs;
    }
    for (const frame of root.querySelectorAll("iframe, frame")) {
      let doc = null;
      try {
        doc = frame.contentDocument;
      } catch {
        // Cross-origin.
      }
      if (doc?.body) {
        docs.push(doc, ...sameOriginDocuments(doc, depth + 1));
      }
    }
    return docs;
  }

  // The element of this document that shows `element`: itself, or the frame
  // its document is in.
  function inThisDocument(element) {
    let node = element;
    while (node && node.ownerDocument != document) {
      node = node.ownerDocument.defaultView?.frameElement || null;
    }
    return node;
  }

  function hideLoaders(ads) {
    let count = 0;
    const now = Date.now();
    for (const scope of [document, ...sameOriginDocuments(document)]) {
      for (const element of scope.querySelectorAll(URL_ELEMENTS)) {
        if (!pendingUrls.has(elementUrl(element))) {
          continue;
        }
        const target = inThisDocument(element.localName == "source" ? element.parentElement : element);
        if (!target || found.has(target) || marked.has(target) || target == document.body || target == document.documentElement) {
          continue;
        }
        // Its size before it is hidden: tracking pixels are hidden quietly.
        const box = target.getBoundingClientRect();
        const area = Math.max(box.width, target.width || 0) * Math.max(box.height, target.height || 0);
        markHidden(target, "o");
        found.add(target);
        if (area < MIN_IMAGE_AREA) {
          continue;
        }
        count++;
        if (mode == "veil") {
          hidden(target, ads);
        } else if (mark) {
          fold(target);
        }
      }
    }
    for (const [url, until] of pendingUrls) {
      if (until < now) {
        pendingUrls.delete(url);
      }
    }
    return count;
  }

  function scan() {
    idle = 0;
    if (!active) {
      return;
    }
    let count = 0;
    const ads = [];
    if (pendingUrls.size && mark) {
      count += hideLoaders(ads);
    }
    // Slots still waiting for their ad: the page changed, so look again.
    for (const element of waiting.keys()) {
      const ad = element.isConnected ? describe(element) : null;
      if (ad) {
        waiting.delete(element);
        ads.push(ad);
      }
    }
    for (let i = 0; i < selectors.length; i += CHUNK) {
      for (const element of matching(selectors.slice(i, i + CHUNK))) {
        if (!found.has(element)) {
          count++;
          hidden(element, ads);
        }
      }
    }
    for (const filter of procedural) {
      for (const element of VeilProcedural.run(filter, document)) {
        if (found.has(element) || folded.has(element)) {
          continue;
        }
        const action = filter.action;
        if (!action) {
          count++;
          markHidden(element);
          hidden(element, ads);
        } else if (action.type == "remove") {
          // Described before it goes, for the vault.
          count++;
          found.add(element);
          const ad = describe(element);
          if (ad) {
            ads.push(ad);
          }
          element.remove();
        } else if (action.type == "remove-attr") {
          element.removeAttribute(action.arg);
        } else if (action.type == "remove-class") {
          element.classList.remove(action.arg);
        }
      }
    }
    if (mark) {
      unfoldFilled();
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
  let describingOwn = false;
  function describeOwnFrame() {
    if (describingOwn) {
      return;
    }
    describingOwn = true;
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
    if (active && started && (selectors.length || procedural.length || pendingUrls.size || waiting.size) && !idle) {
      idle = requestIdleCallback(scan, { timeout: 1000 });
    }
  }

  const observer = new MutationObserver(records => {
    // Only marks changed (ours, or a page removing one): no new scan.
    let changed = false;
    for (const record of records) {
      if (record.type == "attributes") {
        if (record.attributeName == mark) {
          // A page removing the mark from what it hides: put back.
          if (marked.has(record.target) && record.target.getAttribute(mark) !== marked.get(record.target)) {
            record.target.setAttribute(mark, marked.get(record.target));
          }
          continue;
        }
        changed = true;
        note(record.target);
        continue;
      }
      changed = true;
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
    if (!changed) {
      return;
    }
    // The first batch of names goes out at once; later ones are coalesced.
    nameTimer ||= setTimeout(flushNames, sent.size > classes.length + ids.length ? 100 : 0);
    schedule();
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });

  // Popups and redirects (docs/design/ADS.md): the last click in this frame
  // and what it was on, which the background asks for when the page opens a
  // window (VeilModel.popupVerdict), and which, in the top frame, stops a
  // script taking the page to another site on a click on plain content.
  const CLICK_WINDOW_MS = 1000;
  const CONTROLS =
    "button, input, select, textarea, label, summary, option, video, audio, [contenteditable=''], [contenteditable='true'], [role='button'], [role='link'], [role='menuitem'], [role='tab'], [role='checkbox'], [role='switch'], [role='option']";
  // An element covering at least this share of the viewport with nothing to
  // see is an overlay laid over the page to catch clicks.
  const OVERLAY_SHARE = 0.5;
  let lastClick = null;

  function isOverlay(element) {
    const box = element.getBoundingClientRect();
    if (box.width * box.height < OVERLAY_SHARE * innerWidth * innerHeight) {
      return false;
    }
    return !(element.textContent || "").trim() && !element.querySelector("img, svg, video, canvas, picture, iframe");
  }

  function noteClick(event) {
    if (!event.isTrusted) {
      return;
    }
    const target = event.composedPath()[0];
    const element = target?.nodeType == Node.ELEMENT_NODE ? target : target?.parentElement;
    if (!element) {
      return;
    }
    const link = element.closest("a[href], area[href]");
    let kind = "plain";
    if (isOverlay(link || element)) {
      kind = "plain";
    } else if (link) {
      kind = "link";
    } else if (element.closest(CONTROLS) || getComputedStyle(element).cursor == "pointer") {
      kind = "control";
    }
    lastClick = { time: Date.now(), kind, href: kind == "link" ? link.href : null };
  }

  addEventListener("pointerdown", noteClick, { capture: true, passive: true });
  addEventListener("click", noteClick, { capture: true, passive: true });

  // As VeilModel.siteKey (the background's), for the redirect guard.
  function siteKey(url) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    if (!host || /^[\d.]+$/.test(host) || host.includes(":")) {
      return host || null;
    }
    const labels = host.split(".");
    const n = labels.length >= 3 && labels.at(-1).length == 2 && labels.at(-2).length <= 3 ? 3 : 2;
    return labels.slice(-n).join(".");
  }

  const withoutHash = url => url?.split("#")[0];

  // A script navigation (not the user's own, as following a link is) during
  // a click on plain content, or on a link it does not follow, to another
  // site: a "click anywhere" redirect. Cancelled; the page stays.
  if (window == window.top && window.navigation) {
    window.navigation.addEventListener("navigate", event => {
      if (!active || event.userInitiated || !event.cancelable || event.hashChange || event.downloadRequest != null) {
        return;
      }
      if (event.navigationType != "push" && event.navigationType != "replace") {
        return;
      }
      const click = lastClick && Date.now() - lastClick.time <= CLICK_WINDOW_MS ? lastClick : null;
      const to = event.destination.url;
      if (!click || click.kind == "control" || !siteKey(to) || siteKey(to) == siteKey(location.href)) {
        return;
      }
      if (click.kind == "link" && (withoutHash(to) == withoutHash(click.href) || siteKey(to) == siteKey(click.href))) {
        return;
      }
      event.preventDefault();
      browser.runtime.sendMessage({ type: "redirect", url: to }).catch(() => {});
    });
  }

  // From the background: URLs whose elements to hide (hideLoaders), and,
  // for a frame the page found in a hidden slot, that it is an ad.
  const MAX_URLS_PER_MESSAGE = 200;
  browser.runtime.onMessage.addListener(message => {
    if (!active) {
      return;
    }
    if (message?.type == "lastClick") {
      return Promise.resolve(lastClick ? { age: Date.now() - lastClick.time, kind: lastClick.kind, href: lastClick.href } : null);
    }
    if (message?.type == "elements" && Array.isArray(message.urls)) {
      const until = Date.now() + PENDING_MS;
      for (const url of message.urls.slice(0, MAX_URLS_PER_MESSAGE)) {
        if (typeof url == "string" && url.length <= 4096) {
          pendingUrls.set(url, until);
        }
      }
      schedule();
    } else if (message?.type == "adframe" && window != window.top) {
      describeOwnFrame();
    }
  });

  browser.runtime
    .sendMessage({ type: "applied" })
    .then(reply => {
      if (!reply?.active) {
        active = false;
        observer.disconnect();
        return;
      }
      started = true;
      mode = reply.mode == "veil" ? "veil" : "block";
      if (typeof reply.mark == "string" && /^v[0-9a-f]{12}$/.test(reply.mark)) {
        mark = reply.mark;
        procedural = Array.isArray(reply.procedural) ? reply.procedural : [];
        observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id", mark] });
      }
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
