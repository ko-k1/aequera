/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The toolbar popup. The background owns all state; this shows it for the
// active tab, refreshes it while open, and sends the mode.

(async () => {
  const { send, element, plural, number, date, hostOf, showImage } = VeilPage;
  const REFRESH_MS = 1000;
  const MAX_ADS = 4;
  const HELP = {
    block: "Ads and trackers are blocked.",
    veil: "For sites that refuse ad blockers: ads load but stay hidden. Trackers stay blocked, and ad servers' tracking cookies stay off.",
    off: "Nothing is blocked or hidden on this site.",
  };
  const ICONS = { block: "../icons/veil.svg", veil: "../icons/veil-veiled.svg", off: "../icons/veil-off.svg" };
  const $ = id => document.getElementById(id);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let busy = false;
  // Rendered lists are rebuilt only when they change (images stay put).
  let shownHosts = "";
  let shownAds = "";

  function renderHosts(state) {
    const key = JSON.stringify(state.hosts) + state.moreHosts;
    if (key == shownHosts) {
      return;
    }
    shownHosts = key;
    const most = state.hosts[0]?.count || 1;
    $("hosts").replaceChildren(
      ...state.hosts.map(({ host, count }) =>
        element(
          "li",
          {},
          element("span", { class: "name", text: host, title: host }),
          element("span", { class: "count", text: number(count) }),
          element(
            "span",
            { class: "bar", "aria-hidden": "true" },
            element("span", { style: `width: ${Math.max((count / most) * 100, 4)}%` })
          )
        )
      )
    );
    $("hosts-more").hidden = !state.moreHosts;
    $("hosts-more").textContent = `and ${plural(state.moreHosts, "more domain", "more domains")}`;
    $("hosts-empty").hidden = state.hosts.length > 0;
  }

  function renderAds(state) {
    const ads = state.ads.slice(0, MAX_ADS);
    const key = JSON.stringify(ads) + state.showImages;
    if (key == shownAds) {
      return;
    }
    shownAds = key;
    $("ads").replaceChildren(
      ...ads.map(ad => {
        const host = hostOf(ad.link || ad.creative);
        const img = element("img", { alt: "", hidden: true });
        const thumb = element(
          "span",
          { class: "ad-thumb", "aria-hidden": "true" },
          element("span", { class: "initial", text: (host[0] || "?").toUpperCase() }),
          img
        );
        if (state.showImages) {
          showImage(ad.creative, img, thumb);
        }
        const link = ad.link
          ? element("a", {
              class: "link small",
              href: ad.link,
              target: "_blank",
              rel: "noopener noreferrer",
              text: hostOf(ad.link),
              title: ad.link,
            })
          : element("span", { class: "dim small", text: host });
        return element(
          "li",
          {},
          thumb,
          element("div", { class: "meta" }, element("span", { class: "text", text: ad.text || "Image ad" }), link)
        );
      })
    );
    $("ads-empty").hidden = ads.length > 0;
  }

  function render(state) {
    $("site").textContent = state.site || "Not a web page";
    $("mark").src = ICONS[state.mode];
    $("modes").disabled = busy || !state.site || !state.ready;
    $(`mode-${state.mode}`).checked = true;
    $("mode-help").textContent = state.site ? HELP[state.mode] : "Ad Veil works on web pages.";
    $("blocked").textContent = number(state.blocked);
    $("blocked-share").textContent = state.requests
      ? `${Math.round((state.blocked / state.requests) * 100)}% of ${plural(state.requests, "request", "requests")}`
      : "";
    $("hidden").textContent = number(state.hidden);
    $("domains").textContent = `${number(state.blockedDomains)} / ${number(state.domains)}`;
    $("domains-label").textContent = "domains blocked";
    renderHosts(state);
    renderAds(state);
    const { totals } = state;
    $("totals").textContent = `All time: ${plural(totals.blocked, "blocked", "blocked")}, ${plural(totals.hidden, "ad hidden", "ads hidden")} since ${date(totals.since)}`;
    const note = !state.ready
      ? "Ad Veil could not start. Nothing is blocked."
      : state.incognito
        ? "Private window: nothing is kept in the vault, and this site's mode lasts until the browser closes."
        : "";
    $("note").textContent = note;
    $("note").hidden = !note;
  }

  async function refresh() {
    if (!busy) {
      render(await send({ type: "popup:state", tabId: tab.id }));
    }
  }

  $("modes").addEventListener("change", async event => {
    busy = true;
    $("modes").disabled = true;
    try {
      // The page reloads in the new mode.
      render(await send({ type: "popup:setMode", tabId: tab.id, mode: event.target.value }));
    } finally {
      busy = false;
      refresh();
    }
  });

  async function open(hash) {
    await browser.tabs.create({ url: browser.runtime.getURL(`pages/dashboard.html${hash}`) });
    window.close();
  }

  $("vault").addEventListener("click", () => open("#vault"));
  $("dashboard").addEventListener("click", () => open("#overview"));

  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
