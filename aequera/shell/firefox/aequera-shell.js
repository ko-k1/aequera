/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera bootstrap. Loaded as a window script from browser.xhtml
// (patches/browser/shell-hooks).
//
// NEVER CHANGE THIS FILE. Scripts named by browser.xhtml live in Firefox's
// startup cache, which a rebuild does not reliably invalidate: the
// .purgecaches sentinel belongs to the app directory, so the first profile to
// start consumes it and every other profile keeps serving the code it cached
// earlier. So this file may run stale, and it only loads aequera-main.js with
// the cache bypassed; the script list and every feature live there and below,
// where the code that runs is always the code that was built.
Services.scriptloader.loadSubScriptWithOptions("chrome://browser/content/aequera/aequera-main.js", {
  target: window,
  ignoreCache: true,
});
