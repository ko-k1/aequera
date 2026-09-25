/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Aequera shell glue. Loaded as a window script from browser.xhtml
// (patches/browser/shell-hooks); the block scope keeps every binding out of
// the shared browser-window global.
//
// Feature controllers load from here as window subscripts, so adding one
// needs no further browser.xhtml hook.
Services.scriptloader.loadSubScript(
  "chrome://browser/content/aequera/workspaces/aequera-workspaces.js",
  window
);
//
// Frame model: the page card (#tabbrowser-tabbox) clips back by exactly the
// launcher's extra width over its collapsed width (aequera-shell.css).
//
// At rest, --aequera-launcher-width carries the launcher's layout width,
// mirrored by a ResizeObserver (reports after layout, never forces a flush).
//
// While Firefox animates the launcher, its layout width is already final (or
// pinned) and the visible edge moves by an animated `translate` instead, so
// the rest-state width is wrong for the duration. For that window the clip
// runs a mirror animation built from Firefox's own: same keyframe endpoints
// (converted to edge positions), duration, easing, and start time, so the
// page edge and the rail edge move as one. A newer launcher animation
// (e.g. an interrupting reversal) replaces the mirror.
{
  const WIDTH_PROPERTY = "--aequera-launcher-width";
  const COLLAPSED_PROPERTY = "--sidebar-launcher-collapsed-width";
  const ANIMATING_ATTRIBUTE = "sidebar-ongoing-animations";

  const px = value => parseFloat(value) || 0;

  // Keyframe translate ("12px 0px 0px") -> horizontal offset in px.
  const translateX = keyframe => px(String(keyframe.translate ?? "0").split(" ")[0]);

  function clipFor(tabbox, extra) {
    const radius = getComputedStyle(tabbox).getPropertyValue("--border-radius-medium") || "0px";
    return tabbox.hasAttribute("sidebar-positionend")
      ? `inset(0 ${extra}px 0 0 round 0 ${radius} 0 0)`
      : `inset(0 0 0 ${extra}px round ${radius} 0 0 0)`;
  }

  window.addEventListener(
    "load",
    () => {
      const launcher = document.getElementById("sidebar-container");
      const tabbox = document.getElementById("tabbrowser-tabbox");
      const browserEl = document.getElementById("browser");
      if (!launcher || !tabbox || !browserEl) {
        console.error("aequera-shell: launcher/tabbox missing; frame clip disabled");
        return;
      }
      let mirror = null;

      const collapsedWidth = () =>
        px(getComputedStyle(browserEl).getPropertyValue(COLLAPSED_PROPERTY));

      const dropMirror = () => {
        mirror?.cancel();
        mirror = null;
      };

      const resizeObserver = new ResizeObserver(entries => {
        const entry = entries[entries.length - 1];
        const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
        tabbox.style.setProperty(WIDTH_PROPERTY, `${width}px`);
        // The rest-state clip is now current; a finished mirror can go.
        if (mirror?.playState === "finished") {
          dropMirror();
        }
      });
      resizeObserver.observe(launcher);

      const mirrorLauncherAnimation = () => {
        if (!document.documentElement.hasAttribute("sidebar-expand-on-hover")) {
          return;
        }
        const source = launcher
          .getAnimations()
          .find(a => a.effect?.getKeyframes().some(k => "translate" in k));
        if (!source) {
          return;
        }
        const frames = source.effect.getKeyframes();
        const timing = source.effect.getTiming();
        // Layout width is constant for the animation's duration (Firefox pins
        // it); only translate moves the visible edge.
        const width = launcher.getBoundingClientRect().width;
        const atEnd = launcher.hasAttribute("sidebar-positionend");
        const extra = keyframe =>
          Math.max(0, width + (atEnd ? -1 : 1) * translateX(keyframe) - collapsedWidth());

        dropMirror();
        mirror = tabbox.animate(
          [
            { clipPath: clipFor(tabbox, extra(frames[0])) },
            { clipPath: clipFor(tabbox, extra(frames[frames.length - 1])) },
          ],
          { duration: timing.duration, easing: timing.easing, fill: "forwards" }
        );
        const own = mirror;
        source.ready.then(
          () => {
            if (mirror === own && source.startTime !== null) {
              own.startTime = source.startTime;
            }
          },
          () => {
            // Firefox cancelled its animation before it started (superseded
            // by a newer one, e.g. an interrupting reversal). That newer
            // animation brings its own mirror; this one is simply dropped.
            if (mirror === own) {
              dropMirror();
            }
          }
        );
      };

      const attributeObserver = new MutationObserver(() => {
        if (launcher.hasAttribute(ANIMATING_ATTRIBUTE)) {
          mirrorLauncherAnimation();
        }
      });
      attributeObserver.observe(launcher, { attributeFilter: [ANIMATING_ATTRIBUTE] });

      window.addEventListener(
        "unload",
        () => {
          resizeObserver.disconnect();
          attributeObserver.disconnect();
          dropMirror();
        },
        { once: true }
      );
    },
    { once: true }
  );
}
