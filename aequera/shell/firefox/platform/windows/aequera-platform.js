/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// AequeraPlatform for Windows: everything the window scripts do differently
// on this OS. Packaged as chrome://browser/content/aequera/platform/
// aequera-platform.js on Windows builds only (jar.mn); macOS and Linux
// builds package their own file at that URL. Every OS's file defines the
// same members (platform/platform-contract.test.mjs), so shared code reads
// them and never asks which OS it runs on. Loaded first by aequera-main.js.

var AequeraPlatform = Object.freeze({
  id: "windows",

  // Frame material (aequera-frame.js, docs/design/MATERIAL.md).

  /** The OS draws a translucent backdrop behind every window (Acrylic), so
   *  "auto" resolves to glass whatever the desktop does. */
  systemBackdrop: true,

  /** Whether the desktop blurs what shows through a translucent window.
   *  No compositor blur here: Acrylic is the backdrop instead. */
  desktopBlurs() {
    return false;
  },

  /**
   * DWM draws the backdrop behind the window, selected by Firefox's own
   * prefs. Set on the default branch, so it is recomputed every start and a
   * user value in about:config still wins.
   *   auto, glass: Acrylic (widget.windows.mica.toplevel-backdrop 2), a live
   *                blur of what is behind the window, like glass on Linux
   *                and macOS;
   *   solid:       no backdrop.
   *
   * @param {"auto"|"glass"|"solid"} material the configured material
   */
  publishBackdrop(material) {
    const defaults = Services.prefs.getDefaultBranch("");
    defaults.setBoolPref("widget.windows.mica", material != "solid");
    defaults.setIntPref("widget.windows.mica.toplevel-backdrop", 2);
  },

  /** Calls onChange whenever desktopBlurs() may have changed; returns the
   *  function that stops watching. Nothing changes it here. */
  watchBlur(_onChange) {
    return () => {};
  },

  // Tab drag (rail/aequera-tabs-drag.js).

  /** The drag image can be swapped mid-drag (DataTransfer.updateDragImage). */
  updatesDragImage: true,

  // Workspace shortcuts (workspaces/aequera-workspaces.js).

  /** Firefox's own tab shortcuts take Ctrl+1..9 here, so workspaces use
   *  Alt+1..9. */
  workspaceDigitModifier: "alt",
});
