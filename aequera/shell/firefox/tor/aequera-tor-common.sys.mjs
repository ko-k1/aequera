/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor windows: what the launcher and the daemon share.

const MODEL_URL = "chrome://browser/content/aequera/tor/tor-model.js";

let model = null;

/** tor-model.js (a classic script), loaded once per process. */
export function torModel() {
  if (!model) {
    const scope = {};
    Services.scriptloader.loadSubScript(MODEL_URL, scope);
    model = scope.AequeraTorModel;
  }
  return model;
}

/** `length` random lowercase hex digits (at most 32). */
export function randomHex(length = 32) {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, length);
}
