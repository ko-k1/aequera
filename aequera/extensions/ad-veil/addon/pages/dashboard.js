/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The dashboard (vault, blocking, sites, settings). The background owns the
// vault and settings; this renders them and sends the user's changes.
//
// The vault follows AdNauseam's: every ad found, the same ad seen again
// shown once with a count, packed at its own size on a canvas that pans and
// zooms (canvas.js); a timeline of ads found per day whose days filter the
// canvas; and, on a click, the canvas goes to the ad, dims the others, and
// shows the ad and every time it was found beside it.

(() => {
  const { send, element, plural, number, date, time, adLink, hostOf } = VeilPage;
  const { groupAds, filterGroups, adsPerDay, vaultStats, adSize, packAds } = VeilModel;
  const TABS = ["vault", "blocking", "sites", "settings"];
  // Links from before the vault was the first tab.
  const TAB_ALIASES = { overview: "blocking" };
  const CONFIRM_MS = 4000;
  // The newest ads the canvas shows at once (AdNauseam shows 300); the
  // timeline reaches the others.
  const MAX_SHOWN = 400;
  // An image ad without a saved image: a box of the most common ad size.
  const PLACEHOLDER = { width: 300, height: 250 };
  // Text ads are as wide as their words need, within these (px).
  const TEXT_WIDTH = [180, 360];
  const GAP = 12;
  // Going to an ad: at most this zoom, with this much room around it (px).
  const FOCUS_ZOOM = 2;
  const FOCUS_ROOM = 32;
  const $ = id => document.getElementById(id);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fullDay = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

  let summary = null;
  // The vault: every ad as groups, saved images by creative, ads per day.
  let groups = [];
  let images = new Map();
  let series = [];
  // The canvas's filter, the groups it shows, and where each one is.
  const filter = { from: null, to: null };
  let shown = [];
  let rects = [];
  let needsFit = true;
  // Text ads are measured on the canvas: built while the vault is hidden,
  // it is built again when shown.
  let needsLayout = false;
  // Object URLs of the saved images the canvas shows, by creative. Each
  // build makes its own and revokes the previous build's once it replaces it.
  let urls = new Map();

  function urlIn(map, creative, blob) {
    if (!map.has(creative)) {
      map.set(creative, URL.createObjectURL(blob));
    }
    return map.get(creative);
  }

  function revoke(map) {
    for (const url of map.values()) {
      URL.revokeObjectURL(url);
    }
  }

  window.addEventListener("unload", () => revoke(urls));

  // Tabs: the hash names the panel, arrow keys move between tabs.
  function showTab(name, focus = false) {
    const wanted = TAB_ALIASES[name] || name;
    const current = TABS.includes(wanted) ? wanted : "vault";
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
    document.body.dataset.tab = current;
    if (location.hash != `#${current}`) {
      history.replaceState(null, "", `#${current}`);
    }
    // Charts and the canvas are sized by their container, which a hidden
    // panel does not have.
    drawCharts();
    if (current == "vault" && needsLayout) {
      renderCanvas();
    }
    fitIfNeeded();
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
    if (empty) {
      empty.hidden = items.length > 0;
    }
  }

  // Bar charts (one series each: no legend, the title names it), drawn in
  // pixels at the container's width so text never scales. Bars are at most
  // 24px wide with at least 2px between them, square at the baseline and
  // rounded at the data end; the peak is labeled, every value is in the
  // tooltip and the table.
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

  const CHART_TOP = 22;
  const CHART_BOTTOM = 24;
  // The narrowest room a day label needs (px).
  const LABEL_ROOM = 52;

  // `options`: height (px), label(entry) for the tooltip, dayLabel(entry)
  // for the axis, focusable (each bar a tab stop, for short series),
  // selected(i) to mark bars outside a selection.
  function drawBars(box, tip, data, options) {
    const width = box.clientWidth;
    if (!width) {
      return null;
    }
    const height = options.height;
    const plot = height - CHART_TOP - CHART_BOTTOM;
    const slot = width / data.length;
    const barWidth = Math.max(Math.min(24, slot * 0.7, slot - 2), 1);
    const peak = Math.max(...data.map(entry => entry.count), 1);
    const peakIndex = data.findIndex(entry => entry.count == peak);
    // Every n-th day labeled, so labels never touch.
    const every = Math.ceil(LABEL_ROOM / slot);
    const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, style: `height: ${height}px` });
    const baseline = CHART_TOP + plot;
    chart.append(svg("line", { class: "baseline", x1: 0, x2: width, y1: baseline + 0.5, y2: baseline + 0.5 }));
    data.forEach((entry, i) => {
      const center = slot * i + slot / 2;
      const x = center - barWidth / 2;
      const h = entry.count ? Math.max((entry.count / peak) * plot, 2) : 0;
      const y = baseline - h;
      const r = Math.min(4, h, barWidth / 2);
      const label = options.label(entry);
      const group = svg("g", options.selected && !options.selected(i) ? { class: "out" } : {});
      const hit = svg("rect", { class: "hit", x: slot * i, y: CHART_TOP, width: slot, height: plot, "data-index": i });
      if (options.focusable) {
        hit.setAttribute("tabindex", 0);
        hit.setAttribute("role", "img");
        hit.setAttribute("aria-label", label);
      }
      group.append(hit);
      if (h) {
        group.append(
          svg("path", {
            class: "bar",
            d: `M${x},${baseline} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${baseline} Z`,
          })
        );
      }
      if ((data.length - 1 - i) % every == 0) {
        const day = svg("text", { class: "day", x: center, y: height - 6 });
        day.textContent = options.dayLabel(entry);
        group.append(day);
      }
      if (i == peakIndex && entry.count) {
        const value = svg("text", { class: "peak", x: Math.min(Math.max(center, 12), width - 12), y: y - 6 });
        value.textContent = number(entry.count);
        group.append(value);
      }
      const show = () => {
        tip.textContent = label;
        tip.hidden = false;
        const left = Math.min(Math.max(center - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
        tip.style.left = `${box.offsetLeft + left}px`;
        tip.style.top = `${box.offsetTop + Math.max(y - 40, 0)}px`;
      };
      const hide = () => (tip.hidden = true);
      group.addEventListener("mouseenter", show);
      group.addEventListener("mouseleave", hide);
      hit.addEventListener("focus", show);
      hit.addEventListener("blur", hide);
      chart.append(group);
    });
    box.replaceChildren(chart);
    return { slot };
  }

  function drawCharts() {
    if (!summary) {
      return;
    }
    if (!$("blocking").hidden) {
      drawBars($("chart"), $("chart-tip"), summary.vault.series, {
        height: 180,
        focusable: true,
        label: entry => `${fullDay.format(dayDate(entry.day))}: ${plural(entry.count, "request blocked", "requests blocked")}`,
        dayLabel: entry => weekday.format(dayDate(entry.day)),
      });
    }
    if (!$("vault").hidden) {
      drawTimeline();
    }
  }

  // Blocking.
  function renderBlocking() {
    const { totals, vault } = summary;
    $("total-blocked").textContent = number(totals.blocked);
    $("total-hidden").textContent = number(totals.hidden);
    $("since").textContent = `Counting since ${date(totals.since)}. Private windows are not counted.`;
    $("chart-table").replaceChildren(
      ...vault.series.map(entry =>
        element("tr", {}, element("td", { text: fullDay.format(dayDate(entry.day)) }), element("td", { text: number(entry.count) }))
      )
    );
    $("chart-total").textContent = plural(vault.blocked, "request", "requests");
    $("chart-empty").hidden = summary.settings.vault;
    renderRows($("top-hosts"), $("top-hosts-empty"), vault.hosts);
    renderRows($("top-sites"), $("top-sites-empty"), vault.sites);
  }

  // Vault: numbers and statistics, over every ad kept.
  function renderVaultStats() {
    const stats = vaultStats(groups);
    $("v-found").textContent = number(stats.found);
    $("v-unique").textContent = number(stats.unique);
    $("v-advertisers").textContent = number(stats.advertisers);
    $("v-sites").textContent = number(stats.sites);
    $("v-since").textContent = stats.since ? `since ${date(stats.since)}` : "";
    renderRows($("top-advertisers"), null, stats.top.advertisers);
    renderRows($("top-networks"), null, stats.top.networks);
    renderRows($("top-found"), null, stats.top.sites);
    $("kinds").textContent = stats.found
      ? `${plural(stats.kinds.image, "image ad", "image ads")}, ${plural(stats.kinds.text, "text ad", "text ads")} found.`
      : "";
  }

  $("stats-toggle").addEventListener("click", () => {
    const open = $("stats-panel").hidden;
    $("stats-panel").hidden = !open;
    $("stats-toggle").setAttribute("aria-expanded", open);
  });

  // The timeline: ads found per day, the days in the filter marked. Dragging
  // across it picks days; the date fields do the same from the keyboard.
  function inRange(day) {
    return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
  }

  let timelineSlot = 0;
  function drawTimeline() {
    const ranged = filter.from || filter.to;
    const drawn = drawBars($("timeline"), $("timeline-tip"), series, {
      height: 96,
      label: entry => `${fullDay.format(dayDate(entry.day))}: ${plural(entry.count, "ad found", "ads found")}`,
      dayLabel: entry => shortDay.format(dayDate(entry.day)),
      selected: ranged ? i => inRange(series[i].day) : null,
    });
    timelineSlot = drawn?.slot || 0;
  }

  function renderTimeline() {
    const first = series[0]?.day || "";
    const last = series.at(-1)?.day || "";
    for (const input of [$("range-from"), $("range-to")]) {
      input.min = first;
      input.max = last;
    }
    $("range-from").value = filter.from || "";
    $("range-to").value = filter.to || "";
    $("range-all").disabled = !filter.from && !filter.to;
    const total = series.reduce((n, entry) => n + entry.count, 0);
    $("timeline-range").textContent =
      filter.from || filter.to
        ? `${shortDay.format(dayDate(filter.from || first))} – ${shortDay.format(dayDate(filter.to || last))}`
        : `${plural(total, "ad", "ads")}, last ${plural(series.length, "day", "days")}`;
    $("timeline-table").replaceChildren(
      ...series
        .filter(entry => entry.count)
        .reverse()
        .map(entry => element("tr", {}, element("td", { text: fullDay.format(dayDate(entry.day)) }), element("td", { text: number(entry.count) })))
    );
    if (!$("vault").hidden) {
      drawTimeline();
    }
  }

  function setRange(from, to) {
    [filter.from, filter.to] = from && to && from > to ? [to, from] : [from || null, to || null];
    renderTimeline();
    return renderCanvas();
  }

  // Drag (or click) across the timeline: the days under the pointer.
  let brushStart = -1;
  function dayAt(event) {
    const box = $("timeline").getBoundingClientRect();
    const i = Math.floor((event.clientX - box.left) / (timelineSlot || 1));
    return Math.min(Math.max(i, 0), series.length - 1);
  }

  $("timeline").addEventListener("pointerdown", event => {
    if (event.button != 0 || !series.length) {
      return;
    }
    event.preventDefault();
    $("timeline").setPointerCapture(event.pointerId);
    brushStart = dayAt(event);
    filter.from = filter.to = series[brushStart].day;
    drawTimeline();
  });

  $("timeline").addEventListener("pointermove", event => {
    if (brushStart < 0) {
      return;
    }
    const [a, b] = [brushStart, dayAt(event)].sort((x, y) => x - y);
    filter.from = series[a].day;
    filter.to = series[b].day;
    drawTimeline();
  });

  const endBrush = () => {
    if (brushStart < 0) {
      return;
    }
    brushStart = -1;
    setRange(filter.from, filter.to);
  };
  $("timeline").addEventListener("pointerup", endBrush);
  $("timeline").addEventListener("pointercancel", endBrush);

  $("range-from").addEventListener("change", event => setRange(event.target.value, filter.to));
  $("range-to").addEventListener("change", event => setRange(filter.from, event.target.value));
  $("range-all").addEventListener("click", () => setRange(null, null));

  // The canvas.
  const canvas = VeilCanvas.create($("stage"), $("world"), {
    onZoom: zoom => {
      $("zoom-ratio").textContent = `${Math.round(zoom * 100)}%`;
      $("zoom-out").disabled = zoom <= VeilCanvas.MIN_ZOOM + 1e-6;
      $("zoom-in").disabled = zoom >= VeilCanvas.MAX_ZOOM - 1e-6;
    },
    onBackground: () => closeInspector(),
  });

  // Panels under the top bar start below it, whatever it wraps to.
  new ResizeObserver(([entry]) => {
    $("stage").style.setProperty("--top-height", `${Math.ceil(entry.target.offsetHeight)}px`);
  }).observe(document.querySelector(".overlay-top"));

  // The stage's room not under its overlays (px on each side).
  function inset() {
    const stage = $("stage").getBoundingClientRect();
    const top = document.querySelector(".overlay-top").getBoundingClientRect().bottom - stage.top + 16;
    const bottom = stage.bottom - document.querySelector(".overlay.timeline").getBoundingClientRect().top + 16;
    const right = $("inspector").hidden ? 24 : stage.right - $("inspector").getBoundingClientRect().left + 16;
    return { top, bottom, right, left: 24 };
  }

  function fitIfNeeded() {
    if (needsFit && !$("vault").hidden && $("stage").clientWidth) {
      needsFit = false;
      canvas.fit(inset(), false);
    }
  }

  $("zoom-out").addEventListener("click", () => canvas.zoomBy(1 / 1.25));
  $("zoom-in").addEventListener("click", () => canvas.zoomBy(1.25));
  $("zoom-fit").addEventListener("click", () => canvas.fit(inset()));

  function advertiserOf(group) {
    return hostOf(group.destination || "") || hostOf(group.creative || "") || "";
  }

  // One ad on the canvas, and its size there once known. `buildUrls`: the
  // build's object URLs.
  function adTile(buildUrls, group, index) {
    const count = group.sightings.length;
    const advertiser = advertiserOf(group);
    const saved = group.creative ? images.get(group.creative) : null;
    let media;
    let size;
    if (group.kind == "text") {
      const width = Math.min(Math.max(160 + group.text.length * 1.5, TEXT_WIDTH[0]), TEXT_WIDTH[1]);
      media = element(
        "span",
        { class: "text-ad", style: `width: ${Math.round(width)}px` },
        element("span", { class: "text-ad-words", text: group.text || "Text ad" }),
        advertiser ? element("span", { class: "text-ad-cite", text: advertiser }) : null
      );
      // Measured once on the canvas.
      size = Promise.resolve(null);
    } else if (saved) {
      const img = element("img", { src: urlIn(buildUrls, group.creative, saved.blob), alt: "", draggable: false, decoding: "async" });
      media = img;
      const known = adSize(saved.width, saved.height);
      size = known
        ? Promise.resolve(known)
        : img.decode().then(
            () => adSize(img.naturalWidth, img.naturalHeight) || PLACEHOLDER,
            () => PLACEHOLDER
          );
    } else {
      media = element(
        "span",
        { class: "ad-placeholder" },
        element("span", { class: "initial", text: (advertiser[0] || "?").toUpperCase() }),
        element("span", { class: "small", text: advertiser || "No image saved" })
      );
      size = Promise.resolve(PLACEHOLDER);
    }
    const label = [
      group.kind == "text" ? `Text ad: ${group.text || "no words"}` : `Image ad${group.text ? `: ${group.text}` : ""}`,
      advertiser && `from ${advertiser}`,
      count > 1 && `found ${plural(count, "time", "times")}`,
    ]
      .filter(Boolean)
      .join(", ");
    const node = element(
      "div",
      { class: "ad-tile", "data-kind": group.kind, "data-creative": group.creative || "", "data-index": index },
      element("button", { type: "button", class: "ad-open", "aria-label": label, "aria-controls": "inspector", "data-index": index }, media),
      count > 1 ? element("span", { class: "count-badge", "aria-hidden": "true", text: number(count) }) : null
    );
    return { node, size };
  }

  // Builds the canvas for the filter: the newest MAX_SHOWN matching ads,
  // packed by their sizes, fitted to the stage. A newer build supersedes an
  // older one still waiting for image sizes.
  let build = 0;
  async function renderCanvas() {
    const token = ++build;
    closeInspector(false);
    const matched = filterGroups(groups, {
      from: filter.from,
      to: filter.to,
      site: $("vault-site").value || null,
      kind: $("vault-kind").value || null,
      query: $("vault-search").value,
    });
    const next = matched.slice(0, MAX_SHOWN);
    const buildUrls = new Map();
    const tiles = next.map((group, i) => adTile(buildUrls, group, i));
    const sizes = await Promise.all(tiles.map(tile => tile.size));
    if (token != build) {
      revoke(buildUrls);
      return;
    }
    // The previous build's images go with its elements.
    $("world").replaceChildren();
    revoke(urls);
    urls = buildUrls;
    shown = next;
    needsLayout = $("vault").hidden;
    const world = $("world");
    world.append(...tiles.map(tile => tile.node));
    // Text ads: as tall as their words, measured at their width.
    tiles.forEach((tile, i) => {
      if (!sizes[i]) {
        sizes[i] = { width: tile.node.offsetWidth, height: tile.node.offsetHeight };
      }
    });
    const { positions, bounds } = packAds(sizes, { gap: GAP });
    rects = positions.map(({ x, y }, i) => ({ left: x, top: y, right: x + sizes[i].width, bottom: y + sizes[i].height }));
    tiles.forEach(({ node }, i) => {
      Object.assign(node.style, {
        left: `${positions[i].x}px`,
        top: `${positions[i].y}px`,
        width: `${sizes[i].width}px`,
        height: `${sizes[i].height}px`,
      });
    });
    canvas.setBounds(bounds);
    needsFit = true;
    fitIfNeeded();

    const found = matched.reduce((n, group) => n + group.sightings.length, 0);
    const all = groups.reduce((n, group) => n + group.sightings.length, 0);
    $("vault-count").textContent =
      found == all ? plural(matched.length, "ad", "ads") : `${plural(matched.length, "ad", "ads")} · ${number(found)} of ${number(all)} found`;
    $("vault-empty").hidden = groups.length > 0;
    $("vault-none").hidden = !groups.length || matched.length > 0;
    $("vault-capped").hidden = matched.length <= MAX_SHOWN;
    $("vault-capped").textContent = `Showing the newest ${number(MAX_SHOWN)} of ${number(matched.length)} ads. Pick days on the timeline to see older ones.`;
  }

  function renderSiteFilter() {
    const select = $("vault-site");
    const current = select.value;
    const sites = [...new Set(groups.flatMap(group => group.sightings.map(s => s.site)).filter(Boolean))].sort();
    select.replaceChildren(element("option", { value: "", text: "All sites" }), ...sites.map(site => element("option", { value: site, text: site })));
    select.value = sites.includes(current) ? current : "";
  }

  // Typing supersedes the build before it (renderCanvas's token).
  $("vault-search").addEventListener("input", renderCanvas);
  $("vault-site").addEventListener("change", renderCanvas);
  $("vault-kind").addEventListener("change", renderCanvas);
  $("vault-reset").addEventListener("click", () => {
    $("vault-search").value = "";
    $("vault-site").value = "";
    $("vault-kind").value = "";
    setRange(null, null);
  });

  $("world").addEventListener("click", event => {
    const index = event.target.closest(".ad-open")?.dataset.index;
    if (index != null) {
      inspect(Number(index));
    }
  });

  // Tabbing to an ad brings it into view.
  $("world").addEventListener("focusin", event => {
    const index = event.target.closest(".ad-tile")?.dataset.index;
    if (index != null && rects[index]) {
      canvas.reveal(rects[index], inset());
    }
  });

  // The inspector: the canvas goes to the ad and dims the others; beside it,
  // the ad and each time it was found (newest first). Closing it returns the
  // view to where it was.
  const inspector = { group: null, tile: -1, index: 0, view: null };

  function inspect(tile) {
    if (!inspector.group) {
      inspector.view = canvas.snapshot();
    }
    for (const node of $("world").querySelectorAll(".inspected")) {
      node.classList.remove("inspected");
    }
    inspector.group = shown[tile];
    inspector.tile = tile;
    inspector.index = 0;
    $("world").querySelector(`.ad-tile[data-index="${tile}"]`).classList.add("inspected");
    $("stage").classList.add("inspecting");
    resetRemove();
    $("inspector").hidden = false;
    renderInspector();
    const rect = rects[tile];
    canvas.show(
      { left: rect.left - FOCUS_ROOM, top: rect.top - FOCUS_ROOM, right: rect.right + FOCUS_ROOM, bottom: rect.bottom + FOCUS_ROOM },
      inset(),
      FOCUS_ZOOM
    );
  }

  function closeInspector(restore = true) {
    if (!inspector.group) {
      return;
    }
    const tile = inspector.tile;
    inspector.group = null;
    inspector.tile = -1;
    $("inspector").hidden = true;
    $("stage").classList.remove("inspecting");
    for (const node of $("world").querySelectorAll(".inspected")) {
      node.classList.remove("inspected");
    }
    if (restore) {
      canvas.restore(inspector.view);
      $("world").querySelector(`.ad-tile[data-index="${tile}"] .ad-open`)?.focus({ preventScroll: true });
    }
  }

  function renderInspector() {
    const { group, index } = inspector;
    const sighting = group.sightings[index];
    const count = group.sightings.length;
    const saved = group.creative ? images.get(group.creative) : null;
    $("ins-title").textContent = group.kind == "text" ? "Text ad" : "Image ad";
    $("ins-media").replaceChildren(
      group.kind == "text"
        ? element(
            "div",
            { class: "text-ad large" },
            element("span", { class: "text-ad-words", text: group.text || "Text ad" }),
            element("span", { class: "text-ad-cite", text: advertiserOf(group) })
          )
        : saved
          ? element("img", { src: urlIn(urls, group.creative, saved.blob), alt: group.text || `Ad from ${advertiserOf(group) || "an unknown advertiser"}` })
          : element("p", { class: "empty small", text: "No image saved for this ad." })
    );
    $("ins-text").textContent = group.kind == "text" ? "" : group.text;
    $("ins-text").hidden = !$("ins-text").textContent;
    $("ins-target").replaceChildren(group.destination ? adLink(group.destination) : element("span", { class: "dim", text: "Unknown" }));
    $("ins-network").textContent = (group.creative && hostOf(group.creative)) || "Unknown";
    $("ins-size").textContent = group.kind == "text" ? "Text" : saved?.width ? `${saved.width} × ${saved.height}` : "Unknown";
    $("ins-page").replaceChildren(
      element("span", { class: "site", text: sighting.site || "Unknown site" }),
      sighting.page
        ? element("a", {
            class: "link small",
            href: sighting.page,
            target: "_blank",
            rel: "noopener noreferrer",
            text: sighting.page,
            title: sighting.page,
          })
        : null
    );
    $("ins-time").textContent = time(sighting.time);
    const sites = new Set(group.sightings.map(s => s.site).filter(Boolean)).size;
    const when = date(group.first) == date(group.last) ? `on ${date(group.first)}` : `first ${date(group.first)}, last ${date(group.last)}`;
    $("ins-seen").textContent = count == 1 ? "Once" : `${plural(count, "time", "times")} on ${plural(sites, "site", "sites")}, ${when}`;
    $("ins-nav").hidden = count < 2;
    $("ins-index").textContent = `${index + 1} / ${count}`;
    $("ins-prev").disabled = index == 0;
    $("ins-next").disabled = index == count - 1;
  }

  function step(by) {
    const next = inspector.index + by;
    if (inspector.group && next >= 0 && next < inspector.group.sightings.length) {
      inspector.index = next;
      renderInspector();
    }
  }

  $("ins-prev").addEventListener("click", () => step(-1));
  $("ins-next").addEventListener("click", () => step(1));
  $("ins-close").addEventListener("click", () => closeInspector());
  $("inspector").addEventListener("keydown", event => {
    const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (by && !event.target.closest("input, select")) {
      event.preventDefault();
      step(by);
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key == "Escape" && inspector.group) {
      event.preventDefault();
      closeInspector();
    }
  });

  // Removing an ad (every time it was found) takes two clicks, like Clear.
  let removeTimer = 0;
  function resetRemove() {
    clearTimeout(removeTimer);
    removeTimer = 0;
    $("ins-remove").textContent = "Remove from vault";
  }

  $("ins-remove").addEventListener("click", async () => {
    if (!removeTimer) {
      $("ins-remove").textContent = "Click again to remove";
      removeTimer = setTimeout(resetRemove, CONFIRM_MS);
      return;
    }
    resetRemove();
    // The whole ad, not only the times the filter shows.
    const whole = groups.find(group => group.key == inspector.group.key) || inspector.group;
    await send({ type: "vault:remove", ids: whole.sightings.map(s => s.id), creative: whole.creative });
    closeInspector(false);
    await loadVault();
  });

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
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(confirmTimer);
    confirmTimer = 0;
    button.textContent = "Clear vault";
    await send({ type: "vault:clear" });
    await load();
  });

  async function loadVault() {
    const data = await send({ type: "vault:ads" });
    groups = groupAds(data.ads);
    images = new Map(data.images);
    series = adsPerDay(groups, Date.now());
    // A filter day that has left the timeline (retention) no longer applies.
    const days = new Set(series.map(entry => entry.day));
    filter.from = days.has(filter.from) ? filter.from : null;
    filter.to = days.has(filter.to) ? filter.to : null;
    renderVaultStats();
    renderSiteFilter();
    renderTimeline();
    await renderCanvas();
  }

  async function load() {
    delete document.body.dataset.ready;
    summary = await send({ type: "dash:summary" });
    renderBlocking();
    renderSites();
    renderSettings();
    await loadVault();
    drawCharts();
    document.body.dataset.ready = "true";
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 100);
  });

  showTab(location.hash.slice(1));
  load();
})();
