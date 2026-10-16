/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The Aequera window scripts, in load order (each defines one global the later
// ones may use). Loaded uncached by the aequera-shell.js bootstrap, and loads
// these uncached too: add new scripts here (and to jar.mn), never to the
// bootstrap.
for (const name of [
  // What differs per OS (platform/<os>/, one per build, jar.mn); defines
  // AequeraPlatform and nothing else, so it runs before every feature.
  "platform/aequera-platform.js",
  // First feature: in the Tor instance it locks the network prefs and starts
  // tor before any other feature runs.
  "tor/tor-model.js",
  "tor/aequera-tor.js",
  "aequera-frame.js",
  "aequera-hover.js",
  "workspaces/workspace-model.js",
  "workspaces/site-sort-model.js",
  "rail/aequera-rail.js",
  "rail/drag-model.js",
  "rail/scroll-model.js",
  "rail/magnify-model.js",
  "rail/aequera-tabs.js",
  "rail/aequera-tabs-drag.js",
  "workspaces/aequera-workspaces.js",
  "command/command-model.js",
  "command/aequera-command.js",
  "bookmarks/aequera-bookmarks.js",
  "layout/aequera-layout.js",
  "narrow/aequera-narrow.js",
  "fullscreen/aequera-fullscreen.js",
  "privacy/aequera-privacy.js",
  "adveil/aequera-adveil.js",
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
