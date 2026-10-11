/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The vault page. The background owns the vault (vault.js); this renders its
// summary and sends the user's actions. Images are a request to the ad
// server, so they load only after "Show images", without cookies or a
// referrer, and only image responses are shown.

(() => {
  const IMAGE_FETCHES = 4;
  const CLEAR_CONFIRM_MS = 4000;
  const $ = id => document.getElementById(id);
  const send = message => browser.runtime.sendMessage(message);
  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  let ads = [];
  let showImages = false;
  const objectUrls = [];

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  function renderTop(list, items) {
    list.replaceChildren(
      ...items.map(({ name, count }) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = name;
        label.title = name;
        const value = document.createElement("span");
        value.className = "dim";
        value.textContent = count.toLocaleString();
        li.append(label, value);
        return li;
      })
    );
  }

  function card(ad) {
    const li = $("ad-card").content.firstElementChild.cloneNode(true);
    li.querySelector(".text").textContent = ad.text;
    li.querySelector(".where").textContent = ad.site || "";
    const time = li.querySelector("time");
    time.dateTime = new Date(ad.time).toISOString();
    time.textContent = timeFormat.format(ad.time);
    const link = li.querySelector(".link");
    if (ad.link) {
      link.href = ad.link;
      link.textContent = hostOf(ad.link);
      link.title = ad.link;
    } else {
      link.remove();
    }
    li.dataset.creative = ad.creative || "";
    return li;
  }

  function renderAds() {
    $("ad-count").textContent = ads.length ? `(${ads.length.toLocaleString()})` : "";
    $("empty").hidden = ads.length > 0;
    $("ads").replaceChildren(...ads.map(card));
    if (showImages) {
      loadImages();
    }
  }

  async function render() {
    const summary = await send({ type: "vault:summary" });
    $("keep").checked = summary.enabled;
    $("blocked-total").textContent = summary.blocked.toLocaleString();
    $("blocked-label").textContent = summary.blocked == 1 ? "request blocked" : "requests blocked";
    renderTop($("hosts"), summary.hosts);
    renderTop($("sites"), summary.sites);
    ads = summary.ads;
    renderAds();
    document.body.dataset.ready = "true";
  }

  async function loadImage(li) {
    const url = li.dataset.creative;
    if (!url) {
      return;
    }
    try {
      const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "force-cache" });
      const blob = await response.blob();
      if (!response.ok || !blob.type.startsWith("image/")) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.push(objectUrl);
      li.querySelector(".creative img").src = objectUrl;
      li.querySelector(".creative").hidden = false;
    } catch {
      // Gone, or not reachable: the card stays text only.
    }
  }

  async function loadImages() {
    const queue = [...$("ads").children].filter(li => li.dataset.creative);
    const worker = async () => {
      while (showImages && queue.length) {
        await loadImage(queue.shift());
      }
    };
    await Promise.all(Array.from({ length: IMAGE_FETCHES }, worker));
  }

  function hideImages() {
    for (const url of objectUrls.splice(0)) {
      URL.revokeObjectURL(url);
    }
    for (const box of document.querySelectorAll(".creative")) {
      box.hidden = true;
      box.querySelector("img").removeAttribute("src");
    }
  }

  $("keep").addEventListener("change", async event => {
    await send({ type: "vault:setEnabled", on: event.target.checked });
    render();
  });

  $("images").addEventListener("click", event => {
    showImages = !showImages;
    event.target.setAttribute("aria-pressed", showImages);
    event.target.textContent = showImages ? "Hide images" : "Show images";
    $("images-note").hidden = !showImages;
    if (showImages) {
      loadImages();
    } else {
      hideImages();
    }
  });

  $("export").addEventListener("click", async () => {
    const data = await send({ type: "vault:export" });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `adveil-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Two steps: the first click asks, the second (within a few seconds)
  // clears.
  let confirmTimer = 0;
  $("clear").addEventListener("click", async event => {
    const button = event.target;
    if (!confirmTimer) {
      button.textContent = "Click again to clear";
      confirmTimer = setTimeout(() => {
        confirmTimer = 0;
        button.textContent = "Clear vault";
      }, CLEAR_CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimer);
    confirmTimer = 0;
    button.textContent = "Clear vault";
    hideImages();
    await send({ type: "vault:clear" });
    render();
  });

  render();
})();
