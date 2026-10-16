/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// AequeraPlatform for macOS: everything the window scripts do differently
// on this OS. Packaged as chrome://browser/content/aequera/platform/
// aequera-platform.js on macOS builds only (jar.mn); Windows and Linux
// builds package their own file at that URL. Every OS's file defines the
// same members (platform/platform-contract.test.mjs), so shared code reads
// them and never asks which OS it runs on. Loaded first by aequera-main.js.

var AequeraPlatform = Object.freeze({
  id: "macos",

  // Frame material (aequera-frame.js, docs/design/MATERIAL.md).

  /** Vibrancy comes from the desktop blur below, not a system backdrop. */
  systemBackdrop: false,

  /** The window server blurs the desktop behind vibrant regions. */
  desktopBlurs() {
    return true;
  },

  /** The vibrant region is chrome CSS (platform/macos/aequera-platform.css):
   *  no backdrop pref to select. */
  publishBackdrop(_material) {},

  /** Calls onChange whenever desktopBlurs() may have changed; returns the
   *  function that stops watching. Nothing changes it here. */
  watchBlur(_onChange) {
    return () => {};
  },

  // Tab drag (rail/aequera-tabs-drag.js).

  /** The drag image can be swapped mid-drag (DataTransfer.updateDragImage). */
  updatesDragImage: true,

  // Workspace shortcuts (workspaces/aequera-workspaces.js).

  /** Firefox's own tab shortcuts are Cmd+1..9 here, so Ctrl+1..9 is free. */
  workspaceDigitModifier: "control",
});
