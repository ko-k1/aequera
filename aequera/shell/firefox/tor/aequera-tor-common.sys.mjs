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

/**
 * A pref's current value by its type, undefined when it does not exist.
 *
 * @param {string} name
 * @param {nsIPrefBranch} [branch]
 */
export function readPref(name, branch = Services.prefs) {
  switch (branch.getPrefType(name)) {
    case branch.PREF_BOOL:
      return branch.getBoolPref(name);
    case branch.PREF_INT:
      return branch.getIntPref(name);
    case branch.PREF_STRING:
      return branch.getStringPref(name);
  }
  return undefined;
}

/**
 * Set a pref by the type of its value (booleans, integers, strings).
 *
 * @param {string} name
 * @param {boolean|number|string} value
 * @param {nsIPrefBranch} [branch]
 */
export function writePref(name, value, branch = Services.prefs) {
  if (typeof value == "boolean") {
    branch.setBoolPref(name, value);
  } else if (typeof value == "number") {
    branch.setIntPref(name, value);
  } else if (typeof value == "string") {
    branch.setStringPref(name, value);
  } else {
    throw new Error(`unsupported pref value for ${name}`);
  }
}

/**
 * Remove the directory of a Tor socket, only when the path is one the
 * launcher names (tor-model.js socketPathProblem): nothing else is ever
 * removed. Resolves to whether a removal was attempted.
 *
 * @param {object} torModelApi  tor-model.js
 * @param {string} socksPath
 */
export async function removeSocketDir(torModelApi, socksPath) {
  if (torModelApi.socketPathProblem(socksPath)) {
    return false;
  }
  await IOUtils.remove(torModelApi.socketDir(socksPath), { recursive: true, ignoreAbsent: true });
  return true;
}
