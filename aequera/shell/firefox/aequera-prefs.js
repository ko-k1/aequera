/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera shell defaults, Stage 1. Defaults only: a user's own choice in
// Settings or about:config always wins, and resetting a pref returns here.
// Values mirror aequera/design/tokens.toml and the prototype
// (prototype/shell) interaction model.

// Vertical tab rail that widens on hover over the content (prototype rail).
pref("sidebar.revamp", true);
pref("sidebar.verticalTabs", true);
pref("sidebar.visibility", "expand-on-hover");

// Motion: tokens.toml [motion] dur_ms = 250, easing = swift.
pref("sidebar.animation.expand-on-hover.duration-ms", 250);
// Pref added by patches/browser/sidebar-motion/0001 (invalid -> ease-in-out).
pref("sidebar.animation.expand-on-hover.easing", "cubic-bezier(0.3,0.7,0.3,1)");
// Hover hysteresis, the prototype's HOVER_OPEN_MS / HOVER_CLOSE_MS: open
// after 40ms, linger 150ms before collapsing (collapse delay pref added by
// patches/browser/sidebar-motion/0002). Input during the animation reverses
// it from where it is (0003).
pref("sidebar.animation.expand-on-hover.delay-duration-ms", 40);
pref("sidebar.animation.expand-on-hover.collapse-delay-ms", 150);

// Workspaces park inactive tab sets as hidden tabs; closing the last visible
// tab must not close the window and discard them (patch
// browser/workspace-hooks/0001: it is replaced by a new tab instead).
pref("browser.tabs.parkedHiddenSources", "aequera-workspaces");

// Frame material: one OS backdrop behind all chrome (Windows 11 Mica), the
// native counterpart of the prototype's single #frame glass layer.
pref("widget.windows.mica", true);
