/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The address bar popup. The background owns all state; this shows it for
// the active tab, refreshes the counts while open, and sends the switch.

(async () => {
  const REFRESH_MS = 1000;
  const $ = id => document.getElementById(id);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let busy = false;

  function render(state) {
    $("site").textContent = state.site || "This page";
    const toggle = $("site-on");
    toggle.checked = state.on;
    toggle.disabled = busy || !state.site || !state.ready;
    $("switch-label").textContent = state.on ? "On for this site" : "Off for this site";
    $("blocked").textContent = state.blocked;
    $("hidden").textContent = state.hidden;
    const note = !state.ready
      ? "Ad Veil could not start. Nothing is blocked."
      : state.incognito
        ? "Private window: nothing is kept in the vault, and turning this site off lasts until the browser closes."
        : "";
    $("note").textContent = note;
    $("note").hidden = !note;
  }

  async function refresh() {
    if (!busy) {
      render(await browser.runtime.sendMessage({ type: "popup:state", tabId: tab.id }));
    }
  }

  $("site-on").addEventListener("change", async event => {
    busy = true;
    event.target.disabled = true;
    try {
      // The page reloads with the new state.
      render(await browser.runtime.sendMessage({ type: "popup:setSite", tabId: tab.id, on: event.target.checked }));
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
