/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global RPMAddMessageListener, RPMSendAsyncMessage */

"use strict";

// Aequera new tab page: Firefox's shortcuts (top sites) as a grid. The data
// and every change go through the port Firefox's own new tab page uses
// (ActivityStream:MainToContent / ContentToMain, granted to about:newtab and
// about:home only), so pin, unpin, and dismiss behave exactly as in Firefox
// and share its storage. This page reads only the TopSites slice and the two
// prefs that size it; it never sends telemetry actions.

(() => {
  const TO_CONTENT = "ActivityStream:MainToContent";
  const TO_MAIN = "ActivityStream:ContentToMain";
  // Firefox's row length (TOP_SITES_MAX_SITES_PER_ROW).
  const PER_ROW = 8;

  const list = document.getElementById("shortcuts");
  const menu = document.getElementById("shortcut-menu");
  const empty = document.getElementById("shortcuts-empty");
  const state = { rows: [], topSitesRows: 1, enabled: true, hydrated: false };
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
        if (state.hydrated) {
          render();
        }
        break;
      case "PREF_CHANGED":
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

  RPMAddMessageListener(TO_CONTENT, onMessage);
  send("NEW_TAB_STATE_REQUEST");
})();
