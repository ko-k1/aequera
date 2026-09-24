/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera shell glue, Stage 1. Loaded as a window script from browser.xhtml
// (patches/browser/shell-hooks); the block scope keeps every binding out of
// the shared browser-window global.
//
// Mirrors the sidebar launcher's live width into --aequera-launcher-width on
// #tabbrowser-tabbox, where aequera-shell.css turns it into the page card's
// clip. A ResizeObserver reports sizes after layout without forcing a
// synchronous flush, and fires on every frame of Firefox's own launcher
// animation, so the clip tracks the moving edge exactly. The property is set
// on the tabbox rather than :root so each update restyles only that subtree.
{
  const WIDTH_PROPERTY = "--aequera-launcher-width";

  window.addEventListener(
    "load",
    () => {
      const launcher = document.getElementById("sidebar-container");
      const tabbox = document.getElementById("tabbrowser-tabbox");
      if (!launcher || !tabbox) {
        console.error("aequera-shell: launcher or tabbox missing; frame clip disabled");
        return;
      }
      const observer = new ResizeObserver(entries => {
        const entry = entries[entries.length - 1];
        const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
        tabbox.style.setProperty(WIDTH_PROPERTY, `${width}px`);
      });
      observer.observe(launcher);
      window.addEventListener("unload", () => observer.disconnect(), { once: true });
    },
    { once: true }
  );
}
