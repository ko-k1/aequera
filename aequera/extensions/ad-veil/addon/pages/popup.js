/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The address bar popup. The background owns all state; this shows it for
// the active tab, refreshes the counts while open, and sends the mode.

(async () => {
  const REFRESH_MS = 1000;
  const HELP = {
    block: "Ads and trackers are blocked.",
    veil: "For sites that refuse ad blockers: ads load but stay hidden. Trackers stay blocked, and ad servers' tracking cookies stay off.",
    off: "Nothing is blocked or hidden on this site.",
  };
  const $ = id => document.getElementById(id);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let busy = false;

  function render(state) {
    $("site").textContent = state.site || "This page";
    $("modes").disabled = busy || !state.site || !state.ready;
    $(`mode-${state.mode}`).checked = true;
    $("mode-help").textContent = HELP[state.mode];
    $("blocked").textContent = state.blocked;
    $("hidden").textContent = state.hidden;
    const note = !state.ready
      ? "Ad Veil could not start. Nothing is blocked."
      : state.incognito
        ? "Private window: nothing is kept in the vault, and this choice lasts until the browser closes."
        : "";
    $("note").textContent = note;
    $("note").hidden = !note;
  }

  async function refresh() {
    if (!busy) {
      render(await browser.runtime.sendMessage({ type: "popup:state", tabId: tab.id }));
    }
  }

  $("modes").addEventListener("change", async event => {
    busy = true;
    $("modes").disabled = true;
    try {
      // The page reloads in the new mode.
      render(await browser.runtime.sendMessage({ type: "popup:setMode", tabId: tab.id, mode: event.target.value }));
    } finally {
      busy = false;
      refresh();
    }
  });

  $("vault").addEventListener("click", async () => {
    await browser.tabs.create({ url: browser.runtime.getURL("pages/vault.html") });
    window.close();
  });

  await refresh();
  setInterval(refresh, REFRESH_MS);
})();
