/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Procedural cosmetic filters (`:has-text()`, `:upward()`, `:xpath()`, ...),
// which CSS cannot express: adblock-rust's operator chains, validated by the
// background (VeilModel.proceduralFrom), run against a document. Loaded
// before content.js in every frame; it uses no extension API, so a test can
// run it in any document (browser_aequera_adveil.js).
//
// A chain: [{ type, arg }, ...], each operator taking the elements the one
// before kept:
// - css-selector: the first selects in the document; later ones select
//   from each element (descendants, or `+`/`~` siblings);
// - has-text, min-text-length: by text content (a /regex/flags or text);
// - upward: the nth ancestor, or the nearest ancestor matching a selector;
// - matches-attr: `"name"="value"` (each text, exact, or a /regex/);
// - matches-css(-before, -after): `property: value` of the computed style;
// - matches-path: the page's path and query (keeps all or none);
// - xpath: elements an XPath expression selects from each element.

var VeilProcedural = (() => {
  // Per operator, at most this many elements are carried to the next.
  const MAX_NODES = 5000;
  const REGEX = /^\/(.+)\/([imsu]*)$/;

  function matcher(arg) {
    const regex = REGEX.exec(arg);
    if (!regex) {
      return value => value.includes(arg);
    }
    try {
      const re = new RegExp(regex[1], regex[2]);
      return value => re.test(value);
    } catch {
      return null;
    }
  }

  // Exact text, or a /regex/.
  const exact = text => (REGEX.test(text) ? matcher(text) : value => value == text);

  function attributeMatcher(arg) {
    const parts = /^"?(.+?)"?(?:="?(.*?)"?)?$/.exec(arg.trim());
    if (!parts) {
      return null;
    }
    const name = exact(parts[1]);
    const value = parts[2] == null ? () => true : exact(parts[2]);
    return name && value ? element => [...element.attributes].some(a => name(a.name) && value(a.value)) : null;
  }

  function styleMatcher(win, arg, pseudo) {
    const colon = arg.indexOf(":");
    if (colon < 1) {
      return null;
    }
    const property = arg.slice(0, colon).trim();
    const value = exact(arg.slice(colon + 1).trim());
    return value ? element => value(win.getComputedStyle(element, pseudo).getPropertyValue(property)) : null;
  }

  function siblingsMatching(node, combinator, selector) {
    const out = [];
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.matches(selector)) {
        out.push(next);
      }
      if (combinator == "+") {
        break;
      }
    }
    return out;
  }

  const PSEUDO = { "matches-css-before": "::before", "matches-css-after": "::after" };

  function step(doc, nodes, { type, arg }) {
    switch (type) {
      case "css-selector": {
        if (!nodes) {
          return [...doc.querySelectorAll(arg)];
        }
        const sibling = /^\s*([+~])\s*(.+)$/.exec(arg);
        return nodes.flatMap(node =>
          sibling ? siblingsMatching(node, sibling[1], sibling[2]) : [...node.querySelectorAll(`:scope ${arg}`)]
        );
      }
      case "has-text": {
        const test = matcher(arg);
        return test ? nodes.filter(node => test(node.textContent || "")) : [];
      }
      case "min-text-length":
        return nodes.filter(node => (node.textContent || "").length >= Number(arg));
      case "upward": {
        const levels = /^\d+$/.test(arg) ? Number(arg) : 0;
        return nodes
          .map(node => {
            if (!levels) {
              return node.parentElement?.closest(arg) || null;
            }
            let up = node;
            for (let i = 0; i < levels && up; i++) {
              up = up.parentElement;
            }
            return up;
          })
          .filter(node => node && node != doc.documentElement && node != doc.body);
      }
      case "matches-attr": {
        const test = attributeMatcher(arg);
        return test ? nodes.filter(test) : [];
      }
      case "matches-css":
      case "matches-css-before":
      case "matches-css-after": {
        const test = styleMatcher(doc.defaultView, arg, PSEUDO[type] || null);
        return test ? nodes.filter(test) : [];
      }
      case "matches-path": {
        const test = matcher(arg);
        const where = doc.location ? doc.location.pathname + doc.location.search : "";
        return test && test(where) ? nodes : [];
      }
      case "xpath": {
        const out = [];
        for (const context of nodes || [doc]) {
          const result = doc.evaluate(arg, context, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
          for (let i = 0; i < result.snapshotLength; i++) {
            if (result.snapshotItem(i).nodeType == 1 /* ELEMENT_NODE */) {
              out.push(result.snapshotItem(i));
            }
          }
        }
        return out;
      }
    }
    return [];
  }

  // The elements `filter` selects in `doc`; none when an operator is
  // unknown or the browser rejects its selector or expression.
  function run(filter, doc) {
    let nodes = null;
    try {
      for (const op of filter.selector) {
        // A chain starts at its first selector (matches-path alone: the page).
        if (!nodes && op.type != "css-selector" && op.type != "xpath") {
          nodes = [doc.documentElement];
        }
        nodes = [...new Set(step(doc, nodes, op))].slice(0, MAX_NODES);
        if (!nodes.length) {
          return [];
        }
      }
    } catch {
      return [];
    }
    return nodes;
  }

  return { run };
})();
