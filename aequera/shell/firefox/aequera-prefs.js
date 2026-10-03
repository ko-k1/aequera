/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera shell defaults. Unless marked `locked`, these are defaults only: a
// user's own choice in Settings or about:config wins, and resetting a pref
// returns here. Values mirror aequera/design/tokens.toml and the prototype
// (prototype/shell).

// Aequera-owned tab rail (rail/aequera-rail.js): Firefox's vertical tab strip
// hosted in Aequera chrome, with the legacy sidebar instead of the revamp
// launcher (patches/browser/aequera-rail lets the two run independently).
//
// LOCKED prefs are structural invariants, not preferences: about:config
// shows them as locked, writes are ignored (never an error), and remote or
// policy default changes are refused. Turning the revamp on would hand the
// rail back to Firefox's launcher; re-coupling it would let Firefox switch
// vertical tabs off behind the rail. Vertical tabs themselves stay a user
// choice (the rail steps aside for horizontal tabs). The only way to unlock
// is AEQUERA_UNLOCK_SHELL_PREFS=1 in the environment (aequera-frame.js), used
// by the test gate to run Firefox's own revamp tests.
pref("sidebar.revamp", false, locked);
pref("sidebar.verticalTabs", true);
pref("sidebar.verticalTabs.requireRevamp", false, locked);

// Motion: tokens.toml [motion] dur_ms = 250, easing = swift. Shared by the
// rail, the bookmarks drawer, and the page clip.
pref("aequera.motion.durationMs", 250);
pref("aequera.motion.easing", "cubic-bezier(0.3,0.7,0.3,1)");
// Hover hysteresis, the prototype's HOVER_OPEN_MS / HOVER_CLOSE_MS.
pref("aequera.hover.openDelayMs", 40);
pref("aequera.hover.closeDelayMs", 150);
// Expanded rail width: tokens.toml [chrome] panel. The collapsed width is
// Firefox's own --tab-collapsed-width, so UI density keeps tabs square.
pref("aequera.rail.expandedWidth", 220);
// Pinned: stay expanded and take layout space (prototype green light).
pref("aequera.rail.pinned", false);
// Prototype: focusing the address bar widens the rail (unified search).
pref("aequera.rail.expandOnAddressFocus", true);

// Bookmarks toolbar: a hover drawer under the top bar (prototype "hover"
// mode). The toolbar stays built ("always") and aequera-bookmarks.js turns it
// into a drawer that opens on hover (or while the address bar is focused)
// and never shifts the page. Setting Firefox's own "Never" / "Only on new
// tab" still works as in Firefox; hoverPeek=false restores plain "Always".
pref("browser.toolbars.bookmarks.visibility", "always");
pref("aequera.bookmarks.hoverPeek", true);

// Workspaces park inactive tab sets as hidden tabs; closing the last visible
// tab must not close the window and discard them (patch
// browser/workspace-hooks/0001: it is replaced by a new tab instead).
// Locked: clearing it would let closing a workspace's last tab close the
// window and discard the other workspaces.
pref("browser.tabs.parkedHiddenSources", "aequera-workspaces", locked);

// Default toolbar layout (patches/browser/customization-defaults): no "List
// all tabs" button next to the tab rail. It stays in the customize palette;
// applies to new profiles and Restore Defaults, never to a saved layout.
pref("browser.uiCustomization.defaultExclusions", "alltabs-button");

// Default topbar order (customization-defaults 0002): back,
// forward, reload, space, address, devtools, space, downloads; the fixed
// extensions button and app menu follow on their own. Omitted widgets
// (home, profile, sidebar, ...) stay in the customize palette. Applies to
// new profiles and Restore Defaults, never to a saved layout.
pref("browser.uiCustomization.defaultNavbarPlacements", "back-button,forward-button,stop-reload-button,spring,urlbar-container,developer-button,spring,downloads-button");

// Frame material: one OS backdrop behind all chrome (Windows 11 Mica), the
// native counterpart of the prototype's single #frame glass layer.
pref("widget.windows.mica", true);
