/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Shared by Ad Veil's pages (popup, dashboard). The background owns all
// state; pages ask it and render.

var VeilPage = (() => {
  const numbers = new Intl.NumberFormat();
  const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const times = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  function send(message) {
    return browser.runtime.sendMessage(message);
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // Where an ad leads: ad click URLs (googleads.g.doubleclick.net/pcs/click
  // and the like) carry the advertiser's address in a parameter; else the
  // link itself.
  const DESTINATION_PARAMS = ["adurl", "url", "dest", "redirect", "u"];
  function destinationOf(link) {
    try {
      const url = new URL(link);
      for (const name of DESTINATION_PARAMS) {
        const value = url.searchParams.get(name);
        if (value && /^https?:\/\//i.test(value)) {
          return new URL(value).href;
        }
      }
      return url.href;
    } catch {
      return link;
    }
  }

  // A link to where the ad leads, opened directly: following it from Ad
  // Veil's pages is not an ad click.
  function adLink(link) {
    const destination = destinationOf(link);
    return element("a", {
      class: "link small",
      href: destination,
      target: "_blank",
      rel: "noopener noreferrer",
      text: hostOf(destination),
      title: destination,
    });
  }

  function plural(count, one, many) {
    return `${numbers.format(count)} ${count == 1 ? one : many}`;
  }

  function element(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key == "class") {
        node.className = value;
      } else if (key == "text") {
        node.textContent = value;
      } else if (key.startsWith("data-") || key.startsWith("aria-") || key == "role") {
        node.setAttribute(key, value);
      } else {
        node[key] = value;
      }
    }
    node.append(...children.filter(child => child != null));
    return node;
  }

  // An ad's thumbnail: its saved image (a Blob from the vault; viewing makes
  // no request), else the initial of its host. Object URLs are revoked when
  // the view is rebuilt and with the page.
  const urls = [];

  function thumb(ad, tag = "span") {
    const host = hostOf(ad.link ? destinationOf(ad.link) : ad.creative);
    const box = element(tag, { class: "ad-thumb", "aria-hidden": "true" }, element("span", { class: "initial", text: (host[0] || "?").toUpperCase() }));
    if (ad.thumb instanceof Blob) {
      const url = URL.createObjectURL(ad.thumb);
      urls.push(url);
      box.append(element("img", { alt: "", src: url }));
      box.dataset.hasImage = "true";
    }
    return box;
  }

  function dropImages() {
    for (const url of urls.splice(0)) {
      URL.revokeObjectURL(url);
    }
  }

  window.addEventListener("unload", dropImages);

  return {
    send,
    hostOf,
    destinationOf,
    adLink,
    plural,
    element,
    thumb,
    dropImages,
    number: n => numbers.format(n),
    date: t => dates.format(t),
    time: t => times.format(t),
  };
})();
