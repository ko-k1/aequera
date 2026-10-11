/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The dashboard (overview, vault, sites, settings). The background owns the
// vault and settings; this renders them and sends the user's changes.

(() => {
  const { send, element, plural, number, date, time, thumb, dropImages, adLink } = VeilPage;
  const TABS = ["overview", "vault", "sites", "settings"];
  const CLEAR_CONFIRM_MS = 4000;
  const $ = id => document.getElementById(id);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const fullDay = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

  let summary = null;

  // Tabs: the hash names the panel, arrow keys move between tabs.
  function showTab(name, focus = false) {
    const current = TABS.includes(name) ? name : "overview";
    for (const tab of TABS) {
      const selected = tab == current;
      const button = $(`tab-${tab}`);
      button.setAttribute("aria-selected", selected);
      button.tabIndex = selected ? 0 : -1;
      $(tab).hidden = !selected;
      if (selected && focus) {
        button.focus();
      }
    }
    if (location.hash != `#${current}`) {
      history.replaceState(null, "", `#${current}`);
    }
    // Drawn at its container's width, which a hidden panel does not have.
    if (current == "overview" && summary) {
      renderChart();
    }
  }

  document.querySelector(".tabs").addEventListener("click", event => {
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab) {
      showTab(tab);
    }
  });

  document.querySelector(".tabs").addEventListener("keydown", event => {
    const index = TABS.indexOf(event.target.dataset.tab);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (index >= 0 && step) {
      event.preventDefault();
      showTab(TABS[(index + step + TABS.length) % TABS.length], true);
    }
  });

  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

  // Rows: name, count, share bar.
  function renderRows(list, empty, items) {
    const most = items[0]?.count || 1;
    list.replaceChildren(
      ...items.map(({ name, count }) =>
        element(
          "li",
          {},
          element("span", { class: "name", text: name, title: name }),
          element("span", { class: "count", text: number(count) }),
          element("span", { class: "bar", "aria-hidden": "true" }, element("span", { style: `width: ${Math.max((count / most) * 100, 4)}%` }))
        )
      )
    );
    empty.hidden = items.length > 0;
  }

  // The 7-day chart (one series, bars). Drawn in pixels at the container's
  // width, so text never scales.
  const SVG = "http://www.w3.org/2000/svg";
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    return node;
  }

  function dayDate(day) {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function renderChart() {
    const series = summary.vault.series;
    const box = $("chart");
    const width = box.clientWidth || 600;
    const height = 180;
    const top = 22;
    const bottom = 24;
    const plot = height - top - bottom;
    const slot = width / series.length;
    const barWidth = Math.min(24, slot * 0.6);
    const peak = Math.max(...series.map(entry => entry.count), 1);
    const peakIndex = series.findIndex(entry => entry.count == peak);
    const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "false" });
    chart.append(svg("line", { class: "baseline", x1: 0, x2: width, y1: top + plot + 0.5, y2: top + plot + 0.5 }));
    series.forEach((entry, i) => {
      const center = slot * i + slot / 2;
      const x = center - barWidth / 2;
      const h = entry.count ? Math.max((entry.count / peak) * plot, 2) : 0;
      const y = top + plot - h;
      const r = Math.min(4, h, barWidth / 2);
      const label = `${fullDay.format(dayDate(entry.day))}: ${plural(entry.count, "request blocked", "requests blocked")}`;
      const group = svg("g");
      const hit = svg("rect", { class: "hit", x: slot * i + 1, y: top, width: slot - 2, height: plot, rx: 4, tabindex: 0, role: "img", "aria-label": label });
      group.append(hit);
      if (h) {
        // Square at the baseline, rounded at the data end.
        group.append(
          svg("path", {
            class: "bar",
            d: `M${x},${top + plot} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${top + plot} Z`,
          })
        );
      }
      const day = svg("text", { class: "day", x: center, y: height - 6 });
      day.textContent = weekday.format(dayDate(entry.day));
      group.append(day);
      if (i == peakIndex && entry.count) {
        const value = svg("text", { class: "peak", x: center, y: y - 6 });
        value.textContent = number(entry.count);
        group.append(value);
      }
      const show = () => {
        const tip = $("chart-tip");
        tip.textContent = label;
        tip.hidden = false;
        const left = Math.min(Math.max(center - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
        tip.style.left = `${box.offsetLeft + left}px`;
        tip.style.top = `${box.offsetTop + Math.max(y - 40, 0)}px`;
      };
      const hide = () => ($("chart-tip").hidden = true);
      group.addEventListener("mouseenter", show);
      group.addEventListener("mouseleave", hide);
      hit.addEventListener("focus", show);
      hit.addEventListener("blur", hide);
      chart.append(group);
    });
    box.replaceChildren(chart);
    $("chart-table").replaceChildren(
      ...series.map(entry =>
        element("tr", {}, element("td", { text: fullDay.format(dayDate(entry.day)) }), element("td", { text: number(entry.count) }))
      )
    );
    const total = series.reduce((n, entry) => n + entry.count, 0);
    $("chart-total").textContent = plural(total, "request", "requests");
    $("chart-empty").hidden = summary.settings.vault;
  }

  function renderOverview() {
    const { totals, vault } = summary;
    $("total-blocked").textContent = number(totals.blocked);
    $("total-hidden").textContent = number(totals.hidden);
    $("ad-count").textContent = number(vault.adCount);
    $("since").textContent = `Counting since ${date(totals.since)}. Private windows are not counted.`;
    renderChart();
    renderRows($("top-hosts"), $("top-hosts-empty"), vault.hosts);
    renderRows($("top-sites"), $("top-sites-empty"), vault.sites);
  }

  // Vault: the newest ads, by day, filtered by text and site.
  function adCard(ad) {
    return element(
      "li",
      { class: "ad-card", "data-creative": ad.creative || "" },
      thumb(ad, "div"),
      element("p", { class: "text", text: ad.text || "Image ad" }),
      element("p", { class: "meta dim small", text: `${ad.site || ""} · ${time(ad.time)}` }),
      ad.link
        ? adLink(ad.link)
        : null
    );
  }

  function renderVault() {
    dropImages();
    const ads = summary.vault.ads;
    const query = $("vault-search").value.trim().toLowerCase();
    const site = $("vault-site").value;
    const shown = ads.filter(
      ad =>
        (!site || ad.site == site) &&
        (!query || [ad.text, ad.link, ad.site].some(value => (value || "").toLowerCase().includes(query)))
    );
    const groups = new Map();
    for (const ad of shown) {
      const day = date(ad.time);
      if (!groups.has(day)) {
        groups.set(day, []);
      }
      groups.get(day).push(ad);
    }
    $("vault-days").replaceChildren(
      ...[...groups].map(([day, list]) =>
        element(
          "section",
          { class: "day-group" },
          element("h3", { class: "dim", text: `${day} · ${plural(list.length, "ad", "ads")}` }),
          element("ul", { class: "ad-grid" }, ...list.map(adCard))
        )
      )
    );
    $("vault-count").textContent =
      shown.length == ads.length ? plural(ads.length, "ad", "ads") : `${number(shown.length)} of ${plural(ads.length, "ad", "ads")}`;
    $("vault-empty").hidden = ads.length > 0;
  }

  function renderSiteFilter() {
    const select = $("vault-site");
    const current = select.value;
    const sites = [...new Set(summary.vault.ads.map(ad => ad.site).filter(Boolean))].sort();
    select.replaceChildren(element("option", { value: "", text: "All sites" }), ...sites.map(site => element("option", { value: site, text: site })));
    select.value = sites.includes(current) ? current : "";
  }

  // Sites with a mode of their own.
  function renderSites() {
    const rows = summary.sites.map(({ site, mode }) => {
      const select = element(
        "select",
        { "aria-label": `Mode for ${site}` },
        element("option", { value: "veil", text: "Veil" }),
        element("option", { value: "off", text: "Off" }),
        element("option", { value: "block", text: "Block (default)" })
      );
      select.value = mode;
      select.addEventListener("change", () => setSite(site, select.value));
      const remove = element("button", { type: "button", text: "Remove", "aria-label": `Remove ${site}` });
      remove.addEventListener("click", () => setSite(site, "block"));
      return element("tr", {}, element("td", { text: site }), element("td", {}, select), element("td", {}, remove));
    });
    $("site-rows").replaceChildren(...rows);
    $("sites-empty").hidden = rows.length > 0;
  }

  async function setSite(site, mode) {
    summary.sites = await send({ type: "dash:setSiteMode", site, mode });
    renderSites();
  }

  $("site-add").addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("site-name").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const valid = /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(name);
    $("site-error").hidden = valid;
    if (!valid) {
      return;
    }
    await setSite(name.toLowerCase(), $("site-mode").value);
    $("site-name").value = "";
  });

  function renderSettings() {
    $("set-vault").checked = summary.settings.vault;
    $("set-images").checked = summary.settings.saveImages;
    $("list-rows").replaceChildren(
      ...(summary.lists || []).map(list =>
        element(
          "tr",
          {},
          element("td", { text: list.name }),
          element("td", { text: list.version || "unknown" }),
          element("td", { text: number(list.rules) })
        )
      )
    );
  }

  async function setSetting(key, value) {
    await send({ type: "dash:setSetting", key, value });
    await load();
  }

  $("set-vault").addEventListener("change", event => setSetting("vault", event.target.checked));
  $("set-images").addEventListener("change", event => setSetting("saveImages", event.target.checked));
  $("vault-search").addEventListener("input", renderVault);
  $("vault-site").addEventListener("change", renderVault);

  $("export").addEventListener("click", async () => {
    const data = await send({ type: "vault:export" });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = element("a", { href: url, download: `adveil-vault-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Two steps: the first click asks, a second within a few seconds clears.
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
    await send({ type: "vault:clear" });
    await load();
  });

  async function load() {
    delete document.body.dataset.ready;
    summary = await send({ type: "dash:summary" });
    renderOverview();
    renderSiteFilter();
    renderVault();
    renderSites();
    renderSettings();
    document.body.dataset.ready = "true";
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => summary && renderChart(), 100);
  });

  showTab(location.hash.slice(1));
  load();
})();
