/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// AequeraFrame (loaded first by aequera-main.js) publishes the shared
// motion tokens and owns the page card's top inset (aequera-shell.css turns
// both into plain CSS transitions):
//   --aequera-motion-duration / --aequera-motion-easing on :root, from
//     aequera.motion.durationMs / aequera.motion.easing (an easing that does
//     not parse falls back instead of breaking every transition);
//   --aequera-page-top on #tabbrowser-tabbox, set by the bookmarks drawer.

// Locked shell prefs (aequera-prefs.js) unlock only for the test gate, which
// must be able to turn the revamp on to run Firefox's own tests. An
// environment variable, not a pref, so about:config can never unlock them.
// Test-only: tools/build/test-shell.sh sets it for `upstream` runs. Production
// launchers (tools/build/aequera*.sh, tools/build/aequera.cmd) must never set
// it; a set value in a shipped environment is a test-harness leak, not a
// supported configuration.
if (Services.env.get("AEQUERA_UNLOCK_SHELL_PREFS") === "1") {
  for (const pref of [
    "sidebar.revamp",
    "sidebar.verticalTabs.requireRevamp",
    "browser.tabs.parkedHiddenSources",
  ]) {
    Services.prefs.unlockPref(pref);
  }
  // Test-harness leak, not a supported configuration: surface it so a shipped
  // environment with the variable set cannot silently break the rail and
  // discard parked workspaces (SECURITY.md: review privilege-adjacent env).
  console.warn(
    "aequera: AEQUERA_UNLOCK_SHELL_PREFS=1 — structural shell prefs unlocked for tests only"
  );
}

var AequeraFrame = (() => {
  const DURATION_PREF = "aequera.motion.durationMs";
  const EASING_PREF = "aequera.motion.easing";
  const FALLBACK_EASING = "ease-in-out";
  const ROOT = document.documentElement;

  const frame = {
    tabbox: null,
    top: 0,

    /** Configured easing, or the fallback when it is not a CSS easing. */
    easing() {
      const easing = Services.prefs.getCharPref(EASING_PREF, FALLBACK_EASING);
      try {
        new KeyframeEffect(null, null, { easing });
        return easing;
      } catch {
        console.error(`aequera: invalid ${EASING_PREF} "${easing}", using ${FALLBACK_EASING}`);
        return FALLBACK_EASING;
      }
    },

    publishMotion() {
      // Reduced motion is a hard accessibility requirement (RESTRICTIONS.md:
      // no motion that blocks direct manipulation): clamp to 0 so CSS
      // transitions become instant when the OS requests it.
      let duration = Math.max(0, Services.prefs.getIntPref(DURATION_PREF, 250));
      try {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          duration = 0;
        }
      } catch {
        // matchMedia unavailable (tests): keep the configured duration.
      }
      ROOT.style.setProperty("--aequera-motion-duration", `${duration}ms`);
      ROOT.style.setProperty("--aequera-motion-easing", this.easing());
    },

    /** Move the page card's top edge to `top` px (CSS transitions the way). */
    setTop(top) {
      if (!this.tabbox || top === this.top) {
        return;
      }
      this.top = top;
      this.tabbox.style.setProperty("--aequera-page-top", `${top}px`);
    },

    observe() {
      this.publishMotion();
    },

    init() {
      this.tabbox = document.getElementById("tabbrowser-tabbox");
      if (!this.tabbox) {
        console.error("aequera-frame: #tabbrowser-tabbox missing; page clip disabled");
      }
      this.publishMotion();
      Services.prefs.addObserver(DURATION_PREF, this);
      Services.prefs.addObserver(EASING_PREF, this);
      window.addEventListener(
        "unload",
        () => {
          Services.prefs.removeObserver(DURATION_PREF, this);
          Services.prefs.removeObserver(EASING_PREF, this);
        },
        { once: true }
      );
    },
  };

  window.addEventListener("load", () => frame.init(), { once: true });
  return frame;
})();
