/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global RPMAddMessageListener, RPMSendAsyncMessage */

"use strict";

// Aequera new tab page: Firefox's shortcuts (top sites) as a grid. The data
// and every change go through the port Firefox's own new tab page uses
// (ActivityStream:MainToContent / ContentToMain, granted to about:newtab and
// about:home only), so pin, unpin, and dismiss behave exactly as in Firefox
// and share its storage. This page reads only the TopSites slice, the two
// prefs that size it, and the custom wallpaper's prefs; it never sends
// telemetry actions. The wallpaper is saved and removed by Firefox's own
// wallpaper feed (WALLPAPER_UPLOAD / WALLPAPER_REMOVE_UPLOAD), so it is the
// same image Firefox's page would show.

(() => {
  const TO_CONTENT = "ActivityStream:MainToContent";
  const TO_MAIN = "ActivityStream:ContentToMain";
  // Firefox's row length (TOP_SITES_MAX_SITES_PER_ROW).
  const PER_ROW = 8;

  const list = document.getElementById("shortcuts");
  const menu = document.getElementById("shortcut-menu");
  const empty = document.getElementById("shortcuts-empty");
  const state = { rows: [], topSitesRows: 1, enabled: true, hydrated: false, wallpaper: {} };
  /** The options button whose menu is open, and its site. */
  let menuFor = null;

  function send(type, data) {
    RPMSendAsyncMessage(TO_MAIN, {
      type,
      data,
      meta: { from: "ActivityStream:Content", to: "ActivityStream:Main" },
    });
  }

  function visibleRows() {
    if (!state.enabled) {
      return [];
    }
    return state.rows.filter(row => row?.url).slice(0, state.topSitesRows * PER_ROW);
  }

  function labelOf(row) {
    return row.label || row.hostname || row.url;
  }

  function icon(row) {
    const box = document.createElement("span");
    box.className = "tile-icon";
    const letter = () => {
      box.className = "tile-icon";
      box.replaceChildren();
      const span = document.createElement("span");
      span.className = "tile-letter";
      span.textContent = labelOf(row).charAt(0);
      box.append(span);
    };
    const src = row.tippyTopIcon || row.favicon;
    if (!src) {
      letter();
      return box;
    }
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("error", letter, { once: true });
    img.src = src;
    if (row.tippyTopIcon) {
      box.classList.add("rich");
      if (row.backgroundColor) {
        box.style.setProperty("background-color", row.backgroundColor);
      }
    } else {
      box.classList.add("favicon");
    }
    box.append(img);
    return box;
  }

  function tile(row, index) {
    const li = document.createElement("li");
    li.className = "tile";
    li.dataset.aequeraTile = "";
    li.dataset.index = index;

    const link = document.createElement("a");
    link.className = "tile-link";
    link.href = row.url;
    const iconBox = icon(row);
    const label = document.createElement("span");
    label.className = "tile-label";
    label.dir = "auto";
    label.textContent = labelOf(row);
    link.append(iconBox, label);
    if (row.isPinned) {
      const pin = document.createElement("span");
      pin.className = "tile-pin";
      link.append(pin);
    }

    const options = document.createElement("button");
    options.type = "button";
    options.className = "tile-options";
    options.setAttribute("aria-haspopup", "menu");
    options.setAttribute("aria-expanded", "false");
    // Declarative invoker: the popover toggles on activation, so a second
    // click on an open menu's button closes it instead of reopening it.
    options.popoverTargetElement = menu;
    document.l10n.setAttributes(options, "newtab-menu-content-tooltip", { title: labelOf(row) });

    li.append(link, options);
    return li;
  }

  function render() {
    const rows = visibleRows();
    const focusedIndex = list.contains(document.activeElement)
      ? document.activeElement.closest("[data-index]")?.dataset.index
      : undefined;
    if (menu.matches(":popover-open")) {
      menu.hidePopover();
    }
    const fragment = document.createDocumentFragment();
    rows.forEach((row, index) => fragment.append(tile(row, index)));
    list.replaceChildren(fragment);
    // A fresh profile has no shortcuts yet: say so instead of a blank page.
    // Not when the user turned shortcuts off, and not before the state is in.
    empty.hidden = !(state.hydrated && state.enabled && !rows.length);
    if (focusedIndex !== undefined) {
      list.querySelector(`[data-index="${focusedIndex}"] .tile-link`)?.focus();
    }
  }

  function onMessage({ data: action }) {
    switch (action?.type) {
      case "NEW_TAB_INITIAL_STATE": {
        const { TopSites, Prefs } = action.data;
        state.rows = TopSites?.rows ?? [];
        state.topSitesRows = Prefs?.values?.topSitesRows ?? 1;
        state.enabled = Prefs?.values?.["feeds.topsites"] ?? true;
        state.hydrated = true;
        readWallpaperPrefs(Prefs?.values);
        render();
        break;
      }
      // The full shortcut list, so it hydrates on its own: the page never
      // depends on NEW_TAB_INITIAL_STATE alone (its feed, newtabinit, is not
      // loaded when automation sets activity-stream.testing.
      // shouldInitializeFeeds to false).
      case "TOP_SITES_UPDATED":
        if (action.data?.links) {
          state.rows = action.data.links;
          state.hydrated = true;
          render();
        }
        break;
      case "PREFS_INITIAL_VALUES":
        state.topSitesRows = action.data?.topSitesRows ?? state.topSitesRows;
        state.enabled = action.data?.["feeds.topsites"] ?? state.enabled;
        readWallpaperPrefs(action.data);
        if (state.hydrated) {
          render();
        }
        break;
      case "PREF_CHANGED":
        if (WALLPAPER_PREFS.has(action.data?.name)) {
          state.wallpaper[action.data.name] = action.data.value;
          renderWallpaper();
          break;
        }
        if (!state.hydrated) {
          break;
        }
        if (action.data?.name == "topSitesRows") {
          state.topSitesRows = action.data.value;
          render();
        } else if (action.data?.name == "feeds.topsites") {
          state.enabled = action.data.value;
          render();
        }
        break;
      case "INIT":
        // The new tab backend started after our request went out: ask again.
        if (!state.hydrated) {
          send("NEW_TAB_STATE_REQUEST");
        }
        break;
      case "WALLPAPER_UPLOAD_RESULT":
        onWallpaperSaved(action.data);
        break;
    }
  }

  // ---- options menu ------------------------------------------------------

  /** The options button the user just activated (set before it toggles). */
  let invoker = null;

  // Before the menu shows: bind it to its tile and place it below the button
  // with end edges aligned, so it opens over its own tile (mirrored for
  // RTL). Anchored by edge, so no measuring before it is shown.
  menu.addEventListener("beforetoggle", event => {
    if (event.newState != "open") {
      return;
    }
    const button = invoker;
    invoker = null;
    const index = Number(button?.closest("[data-index]")?.dataset.index);
    const row = visibleRows()[index];
    if (!row) {
      event.preventDefault();
      return;
    }
    menuFor = { button, row, index };
    menu.querySelector('[data-action="pin"]').hidden = !!row.isPinned;
    menu.querySelector('[data-action="unpin"]').hidden = !row.isPinned;
    button.setAttribute("aria-expanded", "true");
    const anchor = button.getBoundingClientRect();
    const rtl = document.dir == "rtl";
    const below = anchor.bottom + 4 + 96 <= innerHeight;
    const place = {
      left: rtl ? `${anchor.left}px` : "auto",
      right: rtl ? "auto" : `${innerWidth - anchor.right}px`,
      top: below ? `${anchor.bottom + 4}px` : "auto",
      bottom: below ? "auto" : `${innerHeight - anchor.top + 4}px`,
    };
    for (const [edge, value] of Object.entries(place)) {
      menu.style.setProperty(edge, value);
    }
  });

  function runMenu(action) {
    const { row, index } = menuFor;
    menu.hidePopover();
    switch (action) {
      case "pin":
        send("TOP_SITES_PIN", {
          site: { url: row.url, label: labelOf(row), searchTopSite: row.searchTopSite },
          index,
        });
        break;
      case "unpin":
        send("TOP_SITES_UNPIN", { site: { url: row.url } });
        break;
      case "dismiss":
        send("BLOCK_URL", [{ url: row.url }]);
        break;
    }
  }

  // Runs before the button's popover activation behavior.
  list.addEventListener("click", event => {
    invoker = event.target.closest(".tile-options");
  });

  menu.addEventListener("click", event => {
    const item = event.target.closest("button[data-action]");
    if (item && menuFor) {
      runMenu(item.dataset.action);
    }
  });

  menu.addEventListener("keydown", event => {
    const items = [...menu.querySelectorAll("button:not([hidden])")];
    const at = items.indexOf(document.activeElement);
    let next = -1;
    if (event.key == "ArrowDown") {
      next = (at + 1) % items.length;
    } else if (event.key == "ArrowUp") {
      next = (at - 1 + items.length) % items.length;
    } else if (event.key == "Home") {
      next = 0;
    } else if (event.key == "End") {
      next = items.length - 1;
    } else if (event.key == "Tab") {
      // Leave the menu the way it was entered: back on its button.
      event.preventDefault();
      menu.hidePopover();
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  });

  // Light dismiss and Escape come from the popover itself. Once shown: keep
  // it inside the viewport and focus its first item. Once hidden: focus
  // returns to the button that opened it.
  menu.addEventListener("toggle", event => {
    if (event.newState == "open" && menuFor) {
      const { left, right } = menu.getBoundingClientRect();
      if (left < 4 || right > innerWidth - 4) {
        menu.style.setProperty("right", "auto");
        menu.style.setProperty("left", `${Math.max(4, Math.min(left, innerWidth - (right - left) - 4))}px`);
      }
      menu.querySelector("button:not([hidden])").focus();
      return;
    }
    if (event.newState == "closed" && menuFor) {
      const { button } = menuFor;
      menuFor = null;
      button.setAttribute("aria-expanded", "false");
      if (!document.activeElement || document.activeElement == document.body || menu.contains(document.activeElement)) {
        button.focus({ focusVisible: true });
      }
    }
  });

  // ---- custom wallpaper ----------------------------------------------------

  const PREF_SELECTED = "newtabWallpapers.wallpaper";
  const PREF_FILE = "newtabWallpapers.customWallpaper.uuid";
  const PREF_THEME = "newtabWallpapers.customWallpaper.theme";
  const PREF_POSITION = "newtabWallpapers.customWallpaper.position";
  const PREF_SIZE_LIMITED = "newtabWallpapers.customWallpaper.fileSize.enabled";
  const PREF_SIZE_LIMIT = "newtabWallpapers.customWallpaper.fileSize";
  const WALLPAPER_PREFS = new Set([
    PREF_SELECTED,
    PREF_FILE,
    PREF_THEME,
    PREF_POSITION,
    PREF_SIZE_LIMITED,
    PREF_SIZE_LIMIT,
  ]);
  // Firefox's saved image names (lib/Wallpapers/WallpaperFileNames.mjs):
  // v1-<type>-<theme>-<position>-<number>-<uuid>, or a bare UUID from before
  // the library. Matching the whole name also keeps it safe inside url().
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const SAVED_NAME = new RegExp(`^v1-[a-z]+-(light|dark)-([a-z]+)-[1-9][0-9]*-${UUID}$`);
  const LEGACY_NAME = new RegExp(`^${UUID}$`);
  const POSITIONS = new Map([
    ["center", "center"],
    ["top", "top"],
    ["bottom", "bottom"],
    ["left", "left"],
    ["right", "right"],
    ["topleft", "top left"],
    ["topright", "top right"],
    ["bottomleft", "bottom left"],
    ["bottomright", "bottom right"],
  ]);
  // Perceived lightness (CIE L*, 0 to 100) where the text turns from white
  // to black. 50 is mid grey, and it is also where white and black text have
  // the same contrast against the image's mean luminance.
  const LIGHTNESS_THRESHOLD = 50;

  const layer = document.getElementById("wallpaper");
  const customize = document.getElementById("customize-button");
  const panel = document.getElementById("customize-panel");
  const addButton = document.getElementById("wallpaper-add");
  const removeButton = document.getElementById("wallpaper-remove");
  const errorText = document.getElementById("wallpaper-error");
  /** The newest save asked for; an older one finishing late is ignored. */
  let saveId = 0;

  function readWallpaperPrefs(values) {
    if (!values) {
      return;
    }
    for (const name of WALLPAPER_PREFS) {
      if (name in values) {
        state.wallpaper[name] = values[name];
      }
    }
    renderWallpaper();
  }

  /** The applied custom wallpaper: its file, light or dark, and position. */
  function appliedWallpaper() {
    const prefs = state.wallpaper;
    const file = prefs[PREF_FILE];
    if (prefs[PREF_SELECTED] != "custom" || typeof file != "string") {
      return null;
    }
    const saved = SAVED_NAME.exec(file);
    if (saved) {
      return { file, theme: saved[1], position: POSITIONS.get(saved[2]) ?? "center" };
    }
    if (LEGACY_NAME.test(file)) {
      return {
        file,
        theme: prefs[PREF_THEME] == "dark" ? "dark" : "light",
        position: [...POSITIONS.values()].includes(prefs[PREF_POSITION]) ? prefs[PREF_POSITION] : "center",
      };
    }
    return null;
  }

  // Text, wordmark, and icons follow the wallpaper: on a dark image (below
  // the threshold) text is white and the mark keeps its colors; on a light
  // one text is black and the mark is darkened (aequera-newtab.css).
  function renderWallpaper() {
    const wallpaper = appliedWallpaper();
    const root = document.documentElement;
    removeButton.hidden = !wallpaper;
    if (!wallpaper) {
      layer.hidden = true;
      layer.style.removeProperty("background-image");
      delete root.dataset.wallpaper;
      return;
    }
    layer.style.setProperty("background-image", `url("moz-newtab-wallpaper://${wallpaper.file}")`);
    layer.style.setProperty("background-position", wallpaper.position);
    layer.hidden = false;
    root.dataset.wallpaper = wallpaper.theme;
  }

  // sRGB byte to linear light, once.
  const LINEAR = Array.from({ length: 256 }, (_, byte) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  /**
   * The image's perceived lightness: CIE L* of its mean relative luminance
   * (WCAG), from a copy at most 256px on a side. Transparent pixels count by
   * their opacity.
   *
   * @param {Blob} image
   * @returns {Promise<number>} 0 (black) to 100 (white).
   */
  async function lightness(image) {
    const bitmap = await createImageBitmap(image);
    try {
      const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const context = new OffscreenCanvas(width, height).getContext("2d");
      context.drawImage(bitmap, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      let luminance = 0;
      let weight = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        luminance += alpha * (0.2126 * LINEAR[data[i]] + 0.7152 * LINEAR[data[i + 1]] + 0.0722 * LINEAR[data[i + 2]]);
        weight += alpha;
      }
      if (!weight) {
        return 100;
      }
      const y = luminance / weight;
      return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
    } finally {
      bitmap.close();
    }
  }

  function showError(id, args) {
    document.l10n.setAttributes(errorText, id, args);
    errorText.hidden = false;
  }

  async function saveWallpaper(file) {
    const id = String(++saveId);
    errorText.hidden = true;
    if (!file.type.startsWith("image/")) {
      showError("newtab-wallpaper-error-upload-file-type");
      return;
    }
    // Firefox's optional size limit, in MB (off by default).
    const limit = state.wallpaper[PREF_SIZE_LIMIT];
    if (state.wallpaper[PREF_SIZE_LIMITED] && limit > 0 && file.size > limit * 1024 * 1024) {
      showError("newtab-wallpaper-error-max-file-size", { file_size: limit });
      return;
    }
    let theme;
    try {
      theme = (await lightness(file)) < LIGHTNESS_THRESHOLD ? "dark" : "light";
    } catch (error) {
      console.error("Could not decode the wallpaper image", error);
      if (id == saveId) {
        showError("newtab-wallpaper-error-upload-file-type");
      }
      return;
    }
    if (id != saveId) {
      return;
    }
    send("WALLPAPER_UPLOAD", { file, theme, requestId: id });
  }

  // The feed answers the page that asked. Only once the image is on disk does
  // it become the selection, so a failed save leaves the old one showing.
  function onWallpaperSaved(data) {
    if (data?.requestId != String(saveId)) {
      return;
    }
    if (!data.filename) {
      showError("newtab-wallpaper-error-upload-file-type");
      return;
    }
    send("SET_PREF", { name: PREF_SELECTED, value: "custom" });
    // Shown now rather than when the prefs come back round.
    state.wallpaper[PREF_FILE] = data.filename;
    state.wallpaper[PREF_SELECTED] = "custom";
    renderWallpaper();
  }

  addButton.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const [file] = input.files;
      if (file) {
        saveWallpaper(file);
      }
    });
    input.click();
  });

  removeButton.addEventListener("click", () => {
    // Supersedes a save still in flight.
    saveId++;
    errorText.hidden = true;
    send("WALLPAPER_REMOVE_UPLOAD", {});
    // The feed clears the prefs; the page goes back to its canvas now, and
    // focus moves off the button that is about to hide.
    state.wallpaper[PREF_SELECTED] = "";
    addButton.focus();
    renderWallpaper();
  });

  // Open: focus its first control. Closed: focus back on the button when it
  // was inside (Escape, or a click on the button), not when the user clicked
  // somewhere else on the page.
  panel.addEventListener("toggle", event => {
    const open = event.newState == "open";
    customize.setAttribute("aria-expanded", String(open));
    if (open) {
      errorText.hidden = true;
      addButton.focus();
    } else if (!document.activeElement || document.activeElement == document.body || panel.contains(document.activeElement)) {
      customize.focus({ focusVisible: true });
    }
  });

  RPMAddMessageListener(TO_CONTENT, onMessage);
  send("NEW_TAB_STATE_REQUEST");
})();
