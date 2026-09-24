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

// Motion: tokens.toml [motion] dur_ms = 250.
pref("sidebar.animation.expand-on-hover.duration-ms", 250);
// Hover intent: open after 40ms, the prototype's HOVER_OPEN_MS. Firefox has
// no collapse linger (prototype HOVER_CLOSE_MS = 150) and a fixed
// ease-in-out curve; both need a browser hook (Stage 2).
pref("sidebar.animation.expand-on-hover.delay-duration-ms", 40);

// Frame material: one OS backdrop behind all chrome (Windows 11 Mica), the
// native counterpart of the prototype's single #frame glass layer.
pref("widget.windows.mica", true);
