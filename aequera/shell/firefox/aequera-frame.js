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
//   --aequera-page-top on #tabbrowser-tabbox, set by the bookmarks drawer;
//   the frame material (docs/design/MATERIAL.md): aequera.material.frame
//     resolved to :root[aequera-material="solid"|"glass"], and
//     aequera.material.opacity to --aequera-material-opacity (aequera-shell.css
//     paints it). "auto" is the platform's own frame: Mica on Windows 11,
//     vibrancy on macOS, and on Linux glass only where the desktop blurs what
//     shows through a translucent window (Hyprland always; any compositor
//     offering ext-background-effect-v1 blur, which Gecko then requests);
//     elsewhere a translucent frame would put chrome text on a sharp
//     wallpaper, so it stays solid. On Windows the OS draws the backdrop, so
//     the material also selects it: Mica for auto, Acrylic (a live blur of
//     what is behind the window) for glass, none for solid. Read from the
//     local environment; nothing leaves the machine.

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
  const MATERIAL_PREF = "aequera.material.frame";
  const OPACITY_PREF = "aequera.material.opacity";
  const MATERIALS = new Set(["auto", "solid", "glass"]);
  // Readability floor: below this a bright wallpaper can wash out chrome
  // text even through the blur (MATERIAL.md: material settings must not
  // silently break readability).
  const MIN_OPACITY = 60;
  const ROOT = document.documentElement;

  const frame = {
    tabbox: null,
    top: 0,
    blurQuery: null,
    onBlurChange: null,

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

    /** The desktop blurs what shows through a translucent window. */
    desktopBlurs() {
      switch (AppConstants.platform) {
        case "macosx":
          // The window server blurs the desktop behind vibrant regions.
          return true;
        case "linux":
          return (
            !!Services.env.get("HYPRLAND_INSTANCE_SIGNATURE") ||
            window.matchMedia("(-moz-gtk-background-blur-available)").matches
          );
        default:
          return false;
      }
    },

    /** Configured frame material: "auto", "glass" or "solid". */
    configured() {
      const material = Services.prefs.getCharPref(MATERIAL_PREF, "auto");
      if (!MATERIALS.has(material)) {
        console.error(`aequera: invalid ${MATERIAL_PREF} "${material}", using auto`);
        return "auto";
      }
      return material;
    },

    /** Configured frame material, resolved to "solid" or "glass". */
    material(material = this.configured()) {
      if (material != "auto") {
        return material;
      }
      // Windows 11's own backdrop (Mica) is translucent by design.
      return AppConstants.platform == "win" || this.desktopBlurs() ? "glass" : "solid";
    },

    /**
     * Windows: DWM draws the backdrop behind the window, selected by
     * Firefox's own prefs. Set on the default branch, so it is recomputed
     * every start and a user value in about:config still wins.
     *   auto:  Mica (widget.windows.mica.toplevel-backdrop 0: Firefox's
     *          default, the Mica Alt variant);
     *   glass: Acrylic (2), a live blur of what is behind the window;
     *   solid: no backdrop.
     */
    publishWindowsBackdrop(material) {
      if (AppConstants.platform != "win") {
        return;
      }
      const defaults = Services.prefs.getDefaultBranch("");
      defaults.setBoolPref("widget.windows.mica", material != "solid");
      defaults.setIntPref("widget.windows.mica.toplevel-backdrop", material == "glass" ? 2 : 0);
    },

    publishMaterial() {
      const configured = this.configured();
      this.publishWindowsBackdrop(configured);
      ROOT.setAttribute("aequera-material", this.material(configured));
      const opacity = Math.min(100, Math.max(MIN_OPACITY, Services.prefs.getIntPref(OPACITY_PREF, 80)));
      ROOT.style.setProperty("--aequera-material-opacity", `${opacity}%`);
    },

    /** Move the page card's top edge to `top` px (CSS transitions the way). */
    setTop(top) {
      if (!this.tabbox || top === this.top) {
        return;
      }
      this.top = top;
      this.tabbox.style.setProperty("--aequera-page-top", `${top}px`);
    },

    observe(_subject, _topic, pref) {
      if (pref == MATERIAL_PREF || pref == OPACITY_PREF) {
        this.publishMaterial();
      } else {
        this.publishMotion();
      }
    },

    init() {
      this.tabbox = document.getElementById("tabbrowser-tabbox");
      if (!this.tabbox) {
        console.error("aequera-frame: #tabbrowser-tabbox missing; page clip disabled");
      }
      this.publishMotion();
      this.publishMaterial();
      if (AppConstants.platform == "linux") {
        // The compositor can start or stop offering blur while we run.
        this.onBlurChange = () => this.publishMaterial();
        this.blurQuery = window.matchMedia("(-moz-gtk-background-blur-available)");
        this.blurQuery.addEventListener("change", this.onBlurChange);
      }
      const prefs = [DURATION_PREF, EASING_PREF, MATERIAL_PREF, OPACITY_PREF];
      for (const pref of prefs) {
        Services.prefs.addObserver(pref, this);
      }
      window.addEventListener(
        "unload",
        () => {
          for (const pref of prefs) {
            Services.prefs.removeObserver(pref, this);
          }
          this.blurQuery?.removeEventListener("change", this.onBlurChange);
        },
        { once: true }
      );
    },
  };

  window.addEventListener("load", () => frame.init(), { once: true });
  return frame;
})();
