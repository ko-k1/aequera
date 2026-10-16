/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// AequeraPlatform for Linux: everything the window scripts do differently
// on this OS. Packaged as chrome://browser/content/aequera/platform/
// aequera-platform.js on every build that is neither Windows nor macOS
// (jar.mn); the other OSes package their own file at that URL. Every OS's
// file defines the same members (platform/platform-contract.test.mjs), so
// shared code reads them and never asks which OS it runs on. Loaded first
// by aequera-main.js.

var AequeraPlatform = (() => {
  // How a compositor's blur offer surfaces (ext-background-effect-v1,
  // patches/gecko/background-blur; compiled builds only).
  const BLUR_QUERY = "(-moz-gtk-background-blur-available)";

  return Object.freeze({
    id: "linux",

    // Frame material (aequera-frame.js, docs/design/MATERIAL.md).

    /** No system backdrop: "auto" is glass only where the desktop blurs. */
    systemBackdrop: false,

    /**
     * Whether the desktop blurs what shows through a translucent window:
     * Hyprland always does; other compositors when they offer
     * ext-background-effect-v1 blur, which Gecko then requests. Elsewhere a
     * translucent frame would put chrome text on a sharp wallpaper.
     */
    desktopBlurs() {
      return !!Services.env.get("HYPRLAND_INSTANCE_SIGNATURE") || window.matchMedia(BLUR_QUERY).matches;
    },

    /** The compositor draws no backdrop of its own to select. */
    publishBackdrop(_material) {},

    /** Calls onChange whenever desktopBlurs() may have changed (the
     *  compositor can start or stop offering blur while Aequera runs);
     *  returns the function that stops watching. */
    watchBlur(onChange) {
      const query = window.matchMedia(BLUR_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },

    // Tab drag (rail/aequera-tabs-drag.js).

    /** The drag image cannot be swapped mid-drag here (Firefox's own tab
     *  drag notes the same): a drag panel follows the pointer instead. */
    updatesDragImage: false,

    // Workspace shortcuts (workspaces/aequera-workspaces.js).

    /** Firefox's own tab shortcuts are Alt+1..9 here, so Ctrl+1..9 is free. */
    workspaceDigitModifier: "control",
  });
})();
