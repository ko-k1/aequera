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

  // Ad images are a request to the ad server: only when the user turned
  // "Show ad images" on, without cookies or a referrer, and only responses
  // that are images. Object URLs are revoked with the page.
  const IMAGE_FETCHES = 4;
  const urls = [];
  const queue = [];
  let running = 0;

  async function fetchImage(url) {
    try {
      const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "force-cache" });
      const blob = await response.blob();
      if (!response.ok || !blob.type.startsWith("image/")) {
        return null;
      }
      const objectUrl = URL.createObjectURL(blob);
      urls.push(objectUrl);
      return objectUrl;
    } catch {
      return null;
    }
  }

  function pump() {
    while (running < IMAGE_FETCHES && queue.length) {
      const { url, img, box } = queue.shift();
      running++;
      fetchImage(url).then(objectUrl => {
        running--;
        if (objectUrl && img.isConnected) {
          img.src = objectUrl;
          img.hidden = false;
          box.dataset.hasImage = "true";
        }
        pump();
      });
    }
  }

  // Fills `img` (hidden until loaded) with the ad's creative and marks its
  // `box` (data-has-image), which then stops showing the host's initial.
  function showImage(url, img, box) {
    if (url) {
      queue.push({ url, img, box });
      pump();
    }
  }

  function dropImages() {
    queue.length = 0;
    for (const url of urls.splice(0)) {
      URL.revokeObjectURL(url);
    }
  }

  window.addEventListener("unload", dropImages);

  return {
    send,
    hostOf,
    plural,
    element,
    showImage,
    dropImages,
    number: n => numbers.format(n),
    date: t => dates.format(t),
    time: t => times.format(t),
  };
})();
