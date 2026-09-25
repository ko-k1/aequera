/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The Aequera window scripts, in load order (each defines one global the later
// ones may use). Loaded uncached by the aequera-shell.js bootstrap, and loads
// these uncached too: add new scripts here (and to jar.mn), never to the
// bootstrap.
for (const name of [
  "aequera-frame.js",
  "workspaces/workspace-model.js",
  "rail/aequera-rail.js",
  "rail/aequera-tabs.js",
  "workspaces/aequera-workspaces.js",
  "bookmarks/aequera-bookmarks.js",
  "layout/aequera-layout.js",
]) {
  try {
    Services.scriptloader.loadSubScriptWithOptions(`chrome://browser/content/aequera/${name}`, {
      target: window,
      ignoreCache: true,
    });
  } catch (error) {
    // One broken feature must not take the others down with it.
    console.error(`aequera: ${name} failed to load`, error);
  }
}
