/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The dashboard (vault, blocking, sites, settings). The background owns the
// vault and settings; this renders them and sends the user's changes.
//
// The vault follows AdNauseam's: the ads found, the same ad seen again shown
// once with a count, on a wall that zooms; a timeline of ads found per day
// whose days filter the wall; and an inspector for each ad and every time it
// was found.

(() => {
  const { send, element, plural, number, date, time, thumb, imageUrl, dropImages, adLink, hostOf } = VeilPage;
  const { groupAds, filterGroups, adsPerDay, vaultStats } = VeilModel;
  const TABS = ["vault", "blocking", "sites", "settings"];
  // Links from before the vault was the first tab.
  const TAB_ALIASES = { overview: "blocking" };
  const CONFIRM_MS = 4000;
  // Ad widths on the wall (px); the ratio shown is against the default.
  const ZOOM = [96, 128, 176, 240, 320, 440];
  const ZOOM_DEFAULT = 2;
  const ZOOM_KEY = "adveil.vault.zoom";
  // Ads added to the wall at a time, more as it scrolls into view.
  const WALL_PAGE = 120;
  // The wall's row unit (px): each ad spans as many rows as it is tall.
  const WALL_ROW = 2;
  const WALL_GAP = 12;
  const $ = id => document.getElementById(id);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fullDay = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });

  let summary = null;
  // The vault: every ad as groups, saved images by creative, ads per day.
  let groups = [];
  let images = new Map();
  let series = [];
  // The wall's filter and what it shows.
  const filter = { from: null, to: null };
  let shown = [];
  let rendered = 0;

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
    // Charts are drawn at their container's width, which a hidden panel does
    // not have.
    drawCharts();
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

  const CHART_HEIGHT = 180;
  const CHART_TOP = 22;
  const CHART_BOTTOM = 24;
  // The narrowest room a day label needs (px).
  const LABEL_ROOM = 52;

  // `options`: label(entry) for the tooltip, dayLabel(entry) for the axis,
  // focusable (each bar a tab stop, for short series), selected(i) to mark
  // bars outside a selection.
  function drawBars(box, tip, data, options) {
    const width = box.clientWidth;
    if (!width) {
      return null;
    }
    const plot = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
    const slot = width / data.length;
    const barWidth = Math.max(Math.min(24, slot * 0.7, slot - 2), 1);
    const peak = Math.max(...data.map(entry => entry.count), 1);
    const peakIndex = data.findIndex(entry => entry.count == peak);
    // Every n-th day labeled, so labels never touch.
    const every = Math.ceil(LABEL_ROOM / slot);
    const chart = svg("svg", { viewBox: `0 0 ${width} ${CHART_HEIGHT}` });
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
        const day = svg("text", { class: "day", x: center, y: CHART_HEIGHT - 6 });
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

  // Vault: header numbers and statistics, over every ad kept.
  function renderVaultStats() {
    const stats = vaultStats(groups);
    $("v-found").textContent = number(stats.found);
    $("v-unique").textContent = number(stats.unique);
    $("v-advertisers").textContent = number(stats.advertisers);
    $("v-sites").textContent = number(stats.sites);
    $("v-since").textContent = stats.since ? `Found since ${date(stats.since)}.` : "";
    renderRows($("top-advertisers"), null, stats.top.advertisers);
    renderRows($("top-networks"), null, stats.top.networks);
    renderRows($("top-found"), null, stats.top.sites);
    $("kinds").textContent = stats.found
      ? `${plural(stats.kinds.image, "image ad", "image ads")}, ${plural(stats.kinds.text, "text ad", "text ads")} found.`
      : "";
  }

  // The timeline: ads found per day, the days in the filter marked. Dragging
  // across it picks days; the date fields do the same from the keyboard.
  function inRange(day) {
    return (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to);
  }

  let timelineSlot = 0;
  function drawTimeline() {
    const ranged = filter.from || filter.to;
    const drawn = drawBars($("timeline"), $("timeline-tip"), series, {
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
    renderWall();
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

  // The wall: each ad once, newest first, its count when found more than
  // once. Ads span grid rows by height, so images of any shape pack.
  let zoom = ZOOM_DEFAULT;
  try {
    // Nothing saved is null, not 0 (the smallest size).
    const saved = Number(localStorage.getItem(ZOOM_KEY) ?? ZOOM_DEFAULT);
    if (Number.isInteger(saved) && saved >= 0 && saved < ZOOM.length) {
      zoom = saved;
    }
  } catch {
    // No storage (private browsing, blocked): the default size.
  }

  function applyZoom() {
    const wall = $("wall");
    wall.style.setProperty("--ad-width", `${ZOOM[zoom]}px`);
    wall.dataset.compact = ZOOM[zoom] < ZOOM[ZOOM_DEFAULT];
    $("zoom-ratio").textContent = `${Math.round((ZOOM[zoom] / ZOOM[ZOOM_DEFAULT]) * 100)}%`;
    $("zoom-out").disabled = zoom == 0;
    $("zoom-in").disabled = zoom == ZOOM.length - 1;
    try {
      localStorage.setItem(ZOOM_KEY, zoom);
    } catch {
      // As above.
    }
  }

  function setZoom(step) {
    const next = Math.min(Math.max(zoom + step, 0), ZOOM.length - 1);
    if (next != zoom) {
      zoom = next;
      applyZoom();
    }
  }

  $("zoom-out").addEventListener("click", () => setZoom(-1));
  $("zoom-in").addEventListener("click", () => setZoom(1));
  // Ctrl+wheel over the wall zooms it, not the page.
  $("wall").addEventListener(
    "wheel",
    event => {
      if (event.ctrlKey && event.deltaY) {
        event.preventDefault();
        setZoom(event.deltaY < 0 ? 1 : -1);
      }
    },
    { passive: false }
  );

  const fits = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const height = target.firstElementChild.getBoundingClientRect().height;
      target.style.gridRowEnd = `span ${Math.ceil((height + WALL_GAP) / WALL_ROW)}`;
    }
  });

  function advertiserOf(group) {
    return hostOf(group.destination || "") || hostOf(group.creative || "") || "";
  }

  function adTile(group, index) {
    const count = group.sightings.length;
    const advertiser = advertiserOf(group);
    const sites = new Set(group.sightings.map(s => s.site).filter(Boolean));
    const media =
      group.kind == "text"
        ? element(
            "span",
            { class: "text-ad" },
            element("span", { class: "text-ad-words", text: group.text || "Text ad" }),
            advertiser ? element("span", { class: "text-ad-cite", text: advertiser }) : null
          )
        : thumb({ creative: group.creative, link: group.destination, thumb: images.get(group.creative) || null });
    const label = [
      group.kind == "text" ? `Text ad: ${group.text || "no words"}` : `Image ad${group.text ? `: ${group.text}` : ""}`,
      advertiser && `from ${advertiser}`,
      count > 1 && `found ${plural(count, "time", "times")}`,
    ]
      .filter(Boolean)
      .join(", ");
    return element(
      "li",
      { class: "ad-tile", "data-kind": group.kind, "data-creative": group.creative || "" },
      element(
        "div",
        { class: "ad-tile-inner" },
        element(
          "button",
          { type: "button", class: "ad-open", "aria-haspopup": "dialog", "aria-label": label, "data-index": index },
          media
        ),
        // On the corner, outside the ad, so it never covers its words.
        count > 1 ? element("span", { class: "count-badge", "aria-hidden": "true", text: number(count) }) : null,
        element(
          "p",
          { class: "caption small" },
          element("span", { class: "caption-advertiser", text: advertiser || "Unknown advertiser" }),
          element("span", { class: "dim", text: [...sites][0] ? ` · ${[...sites][0]}${sites.size > 1 ? ` +${sites.size - 1}` : ""}` : "" })
        )
      )
    );
  }

  function appendWall() {
    const next = shown.slice(rendered, rendered + WALL_PAGE);
    const tiles = next.map((group, i) => adTile(group, rendered + i));
    $("wall").append(...tiles);
    for (const tile of tiles) {
      fits.observe(tile);
    }
    rendered += next.length;
    $("wall-more").hidden = rendered >= shown.length;
  }

  const more = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && rendered < shown.length) {
      appendWall();
    }
  });
  more.observe($("wall-more"));

  function renderWall() {
    dropImages();
    fits.disconnect();
    shown = filterGroups(groups, {
      from: filter.from,
      to: filter.to,
      site: $("vault-site").value || null,
      kind: $("vault-kind").value || null,
      query: $("vault-search").value,
    });
    rendered = 0;
    $("wall").replaceChildren();
    appendWall();
    const found = shown.reduce((n, group) => n + group.sightings.length, 0);
    const all = groups.reduce((n, group) => n + group.sightings.length, 0);
    $("vault-count").textContent =
      found == all ? plural(shown.length, "ad", "ads") : `${plural(shown.length, "ad", "ads")} · ${number(found)} of ${number(all)} found`;
    $("vault-empty").hidden = groups.length > 0;
    $("vault-none").hidden = !groups.length || shown.length > 0;
  }

  function renderSiteFilter() {
    const select = $("vault-site");
    const current = select.value;
    const sites = [...new Set(groups.flatMap(group => group.sightings.map(s => s.site)).filter(Boolean))].sort();
    select.replaceChildren(element("option", { value: "", text: "All sites" }), ...sites.map(site => element("option", { value: site, text: site })));
    select.value = sites.includes(current) ? current : "";
  }

  $("vault-search").addEventListener("input", renderWall);
  $("vault-site").addEventListener("change", renderWall);
  $("vault-kind").addEventListener("change", renderWall);
  $("vault-reset").addEventListener("click", () => {
    $("vault-search").value = "";
    $("vault-site").value = "";
    $("vault-kind").value = "";
    setRange(null, null);
  });

  $("wall").addEventListener("click", event => {
    const index = event.target.closest(".ad-open")?.dataset.index;
    if (index != null) {
      inspect(shown[Number(index)]);
    }
  });

  // The inspector: one ad, one time it was found at a time (newest first).
  const inspector = { group: null, index: 0 };

  function inspect(group) {
    inspector.group = group;
    inspector.index = 0;
    resetRemove();
    renderInspector();
    if (!$("inspector").open) {
      $("inspector").showModal();
    }
  }

  function renderInspector() {
    const { group, index } = inspector;
    const sighting = group.sightings[index];
    const count = group.sightings.length;
    const blob = images.get(group.creative);
    $("ins-title").textContent = group.kind == "text" ? "Text ad" : "Image ad";
    $("ins-media").replaceChildren(
      group.kind == "text"
        ? element(
            "div",
            { class: "text-ad large" },
            element("span", { class: "text-ad-words", text: group.text || "Text ad" }),
            element("span", { class: "text-ad-cite", text: advertiserOf(group) })
          )
        : blob
          ? element("img", { src: imageUrl(blob), alt: group.text || `Ad from ${advertiserOf(group) || "an unknown advertiser"}` })
          : element("p", { class: "empty small", text: "No image saved for this ad." })
    );
    $("ins-text").textContent = group.kind == "text" ? "" : group.text;
    $("ins-text").hidden = !$("ins-text").textContent;
    $("ins-target").replaceChildren(group.destination ? adLink(group.destination) : element("span", { class: "dim", text: "Unknown" }));
    $("ins-network").textContent = (group.creative && hostOf(group.creative)) || "Unknown";
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
  $("ins-close").addEventListener("click", () => $("inspector").close());
  $("inspector").addEventListener("keydown", event => {
    const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (by && !event.target.closest("input, select")) {
      event.preventDefault();
      step(by);
    }
  });
  // A click on the backdrop (outside the dialog's box) closes it.
  $("inspector").addEventListener("click", event => {
    if (event.target == $("inspector")) {
      const box = $("inspector").getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) {
        $("inspector").close();
      }
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
    $("inspector").close();
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
    renderWall();
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

  applyZoom();
  showTab(location.hash.slice(1));
  load();
})();
