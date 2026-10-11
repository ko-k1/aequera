/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Ad Veil content script: reports the class and id names a document uses,
// so the background applies only the generic rules that match them instead
// of the whole generic list. Every http(s) frame, from document_start (the
// parser's insertions arrive as mutations); each name is sent once,
// batched.

(() => {
  const sent = new Set();
  let classes = [];
  let ids = [];
  let timer = 0;

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

  function flush() {
    timer = 0;
    if (!classes.length && !ids.length) {
      return;
    }
    browser.runtime.sendMessage({ type: "seen", classes, ids }).catch(() => {});
    classes = [];
    ids = [];
  }

  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") {
        note(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }
        note(node);
        for (const element of node.querySelectorAll("[class], [id]")) {
          note(element);
        }
      }
    }
    // The first batch goes out at once; later ones are coalesced.
    timer ||= setTimeout(flush, sent.size > classes.length + ids.length ? 100 : 0);
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });
})();
