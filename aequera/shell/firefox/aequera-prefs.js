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
// Tab icon magnification under the pointer (macOS Dock-style, in place:
// rows never move; rail/magnify-model.js). Off by default; Settings > Tabs
// and browsing > Browser layout. magnifyPercent is the peak icon scale,
// clamped to 100..175 (a 16px icon at 175% still fits its 30px row).
pref("aequera.rail.magnify", false);
pref("aequera.rail.magnifyPercent", 150);

// Bookmarks toolbar: a hover drawer under the top bar (prototype "hover"
// mode). The toolbar stays built ("always") and aequera-bookmarks.js turns it
// into a drawer that opens on hover (or while the address bar is focused)
// and never shifts the page. Setting Firefox's own "Never" / "Only on new
// tab" still works as in Firefox; hoverPeek=false restores plain "Always".
pref("browser.toolbars.bookmarks.visibility", "always");
pref("aequera.bookmarks.hoverPeek", true);

// New tab page (newtab/, patches/browser/newtab): about:newtab and about:home
// serve the Aequera page, shortcuts only, still preloaded. Off restores
// Firefox's page. The address bar is the search, so the shortcut grid has no
// search-engine tiles. Stories and weather are not on the Aequera page; off
// here so their feeds do not fetch in the background for nothing (both stay
// a user choice in Firefox's new tab settings). The about:home startup
// cache holds a render of Firefox's page, so it is off too.
pref("aequera.newtab.enabled", true);
pref("browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
pref("browser.newtabpage.activity-stream.showWeather", false);
pref("browser.startup.homepage.abouthome_cache.enabled", false);

// Private browsing page (privatebrowsing/, patches/browser/privatebrowsing):
// Firefox's page in the new tab page's design. Its product promos (Mozilla
// VPN, Relay, pin to taskbar) are advertising (docs/RESTRICTIONS.md): off,
// here and on the other pages that show them. Off restores Firefox's design
// (the stylesheet is inside @media -moz-pref of this pref).
pref("aequera.privatebrowsing.enabled", true);
pref("browser.vpn_promo.enabled", false);
pref("browser.promo.relay.enabled", false);
pref("browser.promo.pin.enabled", false);

// In-content pages (incontent/, patches/toolkit/in-content): Settings,
// Add-ons, the error pages, about:config and the rest of Firefox's
// in-content pages in Aequera's palette (the logo's cyan, cool neutrals)
// and radius, through Firefox's own design tokens. Off restores Firefox's
// design (the stylesheet is inside @media -moz-pref of this pref); the
// mascot art swap in jar.mn is identity and stays. Settings' "More from
// Mozilla" pane promotes Mozilla products: advertising, as above, so off
// (the Nimbus feature's fallback pref, which the enterprise policy sets too).
pref("aequera.incontent.enabled", true);
pref("browser.preferences.moreFromMozilla", false);
// about:protections: the same rule for its mobile app and VPN promos.
pref("browser.contentblocking.report.show_mobile_app", false);
pref("browser.contentblocking.report.hide_vpn_banner", true);

// Window fullscreen (F11, View > Full Screen) keeps the top bar and the tab
// rail on screen instead of sliding them away (Firefox's default on macOS).
// Page-requested (DOM) fullscreen, e.g. video, still hides all chrome. The
// toolbar context menu's "Hide Toolbars" item flips this back.
pref("browser.fullscreen.autohide", false);

// Workspaces park inactive tab sets as hidden tabs; closing the last visible
// tab must not close the window and discard them (patch
// browser/workspace-hooks/0001: it is replaced by a new tab instead).
// Locked: clearing it would let closing a workspace's last tab close the
// window and discard the other workspaces.
pref("browser.tabs.parkedHiddenSources", "aequera-workspaces", locked);

// Middle-clicking a workspace in the dock closes it and its tabs; with more
// than one tab it asks first. Unchecking the prompt's box sets this false.
pref("aequera.workspaces.warnOnClose", true);

// Sort Tabs by Site (Ctrl+Alt+S, the tab context menu, the command surface;
// never automatic): a site with more than this many tabs in the workspace
// moves to a workspace named after it. 0 sorts without moving; a negative
// value recovers to 7 (workspaces/site-sort-model.js).
pref("aequera.tabs.sortBySite.over", 7);

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

// Privacy defaults (configs/defaults/privacy.toml schema v1, RESTRICTIONS.md).
// No telemetry, studies, sponsored UI, vendor service, or silent crash upload
// by default. Applied here as supported pref defaults (never a Firefox patch,
// never a web-platform change); an explicit user opt-in via Settings or
// about:config still wins, and resetting a pref returns here. Update behavior
// is intentionally untouched here: security updates stay independently visible
// (docs/engineering/RELEASE.md) and deserve a separate ADR, not a silent pref.
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.unified", false);
pref("toolkit.telemetry.archive.enabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("datareporting.healthreport.uploadEnabled", false);
pref("app.shield.optoutstudies.enabled", false);
pref("app.normandy.enabled", false);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
pref("browser.newtabpage.activity-stream.showSponsored", false);
pref("extensions.pocket.enabled", false);
pref("browser.crashReports.unsubmittedCheck.autoSubmit", false);
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false);

// Privacy protections: LibreWolf's direction (block tracking by default),
// softened where its hardening costs everyday use. All are Firefox features
// with a Settings control, so every one stays a user choice.
//   On: Enhanced Tracking Protection "Strict" (cross-site tracking content,
//   fingerprinters, cryptominers, social trackers, query-parameter stripping,
//   bounce tracking, fingerprinting protection in all windows), applied once
//   per profile by privacy/aequera-privacy.js because Firefox's category
//   model has no default (see there); with Firefox's "convenience"
//   exceptions on, so logins, embeds, and video keep working. Global
//   Privacy Control: sites are told not to sell or share the user's data.
//   Not taken from LibreWolf: resistFingerprinting (forces a light color
//   scheme, UTC time, and letterboxed windows; search engines answer it with
//   captchas), clearing cookies and history on exit (logs the user out and
//   defeats session restore), and disabling search suggestions. The user
//   agent stays Firefox's own (tools/build: UAName), so Aequera looks like
//   every other Firefox instead of a rare browser.
// "" leaves the profile's category to Firefox.
pref("aequera.privacy.trackingProtection", "strict");
pref("privacy.globalprivacycontrol.enabled", true);

// AI features: blocked by default, the state Firefox's own "Block AI
// enhancements" switch (Settings > AI Controls) and its AIControls policy
// leave behind: every AI control "blocked", and each feature's own prefs off
// (what each feature's block() sets: GenAI, LinkPreview, SmartTabGrouping,
// TranslationsFeature, PdfJsAIFeature, AIWindow; extensions.ml.enabled as
// the global switch sets it). Defaults only: choosing "Available" or
// "Enabled" for a feature in AI Controls, or turning the switch off, turns it
// back on. Includes Translations, which Firefox counts among its AI
// features (local models, no cloud). Smart Window (off in Firefox too) and
// speech recognition are gated by their control pref alone. The
// inference engine itself (browser.ml.enable) stays: nothing runs it while
// every feature is blocked, and an add-on or a re-enabled feature needs it.
pref("browser.ai.control.default", "blocked");
pref("browser.ai.control.translations", "blocked");
pref("browser.ai.control.pdfjsAltText", "blocked");
pref("browser.ai.control.smartTabGroups", "blocked");
pref("browser.ai.control.linkPreviewKeyPoints", "blocked");
pref("browser.ai.control.sidebarChatbot", "blocked");
pref("browser.ai.control.smartWindow", "blocked");
pref("browser.ai.control.speechRecognition", "blocked");
// Not browser.ml.chat.page (block() also sets it): the chatbot's "Available"
// clears it back to the default, which must stay Firefox's (true), or
// re-enabling the chatbot would leave its page prompts off.
pref("browser.ml.chat.enabled", false);
pref("browser.ml.linkPreview.enabled", false);
pref("browser.ml.linkPreview.optin", false);
pref("browser.tabs.groups.smart.enabled", false);
pref("browser.tabs.groups.smart.userEnabled", false);
pref("browser.tabs.groups.smart.optin", false);
pref("browser.translations.enable", false);
pref("pdfjs.enableGuessAltText", false);
pref("pdfjs.enableAltTextModelDownload", false);
pref("pdfjs.enableAltText", false);
pref("extensions.ml.enabled", false);

// Dark appearance by default: the system theme ("Auto" in Add-ons > Themes)
// reports dark, so Firefox's default theme draws dark chrome and pages
// follow it (prefers-color-scheme: dark; Settings > Website appearance).
// Picking the Light theme, or a Light website appearance, still wins.
// 0 = light, 1 = dark; resetting the pref in about:config follows the OS.
pref("ui.systemUsesDarkTheme", 1);

// Session restore: start with the previous session's windows and tabs
// (Settings > General > "Open previous windows and tabs").
pref("browser.startup.page", 3);

// Frame material: one OS backdrop behind all chrome, the native counterpart
// of the prototype's single #frame glass layer (docs/design/MATERIAL.md).
// aequera.material.frame (aequera-frame.js, aequera-shell.css):
//   "auto":  the platform's own frame: Acrylic on Windows 11, vibrancy on macOS
//            (Liquid Glass on macOS 26+), glass on Linux where the desktop
//            blurs translucent windows, solid elsewhere;
//   "glass": a live blur of what is behind the window: Acrylic on Windows
//            11, vibrancy or Liquid Glass on macOS, the compositor's blur on
//            Linux (only where the window can show transparency);
//   "solid": an opaque frame, no OS backdrop.
// Opacity is the frame tint over the blur in percent (Linux, macOS), clamped
// to 60-100 for readability. The rail paints nothing, like the toolbox
// (aequera-rail.css), so all chrome is the one frame; where no blur exists
// the frame is solid, never chrome text over a sharp wallpaper.
pref("aequera.material.frame", "auto");
pref("aequera.material.opacity", 80);
// Windows: DWM backdrop (Acrylic) for auto and glass; aequera-frame.js
// switches it per material (default branch, so a user value here still wins).
pref("widget.windows.mica", true);
// macOS: the titlebar vibrancy (upstream's, behind the toolbox, and the
// frame's) blurs the desktop behind the window instead of only the window's
// own background, and is Liquid Glass on macOS 26+ (patches/gecko/
// macos-glass; read at startup).
pref("widget.macos.titlebar-blend-mode.behind-window", true);
pref("widget.macos.titlebar-glass.enabled", true);
// Linux (Wayland): ask the compositor to blur what is behind the frame's
// translucent parts (ext-background-effect-v1, patches/gecko/
// background-blur). Off: only desktops that blur every translucent window
// (Hyprland) get glass under auto.
pref("widget.wayland.background-blur.enabled", true);

// Tor windows (docs/design/TOR.md, ADR 0004): "New Tor Window" (app and File
// menus, Ctrl+Shift+Alt+P; Command+Option+Shift+P on macOS) and "Open Link in Tor
// Window" start a second Aequera instance on a throwaway private profile
// whose every connection goes through tor (tor/). Off removes the entry
// points. tor: aequera.tor.executable (an absolute path) when set, else the
// tor bundled into the build (<app>/tor: the Tor Project's expert bundle,
// tools/tor), else `tor` on PATH. The browser never downloads it. Linux and
// macOS only.
// The prefs of the Tor instance itself are in tor/tor-model.js, not here:
// they are written to its own profile and locked there.
pref("aequera.tor.enabled", true);
pref("aequera.tor.executable", "");

// Ad Veil (docs/design/ADS.md): Aequera's built-in ad and tracker blocker
// (EasyList, EasyPrivacy). Requests the lists match are cancelled and ads
// that reach the page are hidden. Off disables the built-in add-on
// (adveil/aequera-adveil.js).
pref("aequera.adveil.enabled", true);
// Veil mode (per site, from Ad Veil's address bar popup) lets ad requests
// through tracking protection: those it blocks from these classifier tables
// (comma separated; Firefox's advertising list), and those of EasyList ad
// server hosts. Other tracking protection blocks stay.
pref("aequera.adveil.veil.adTables", "ads-track-digest256");
// Firefox's ad SmartBlock shims (webcompat) replace an ad script tracking
// protection blocked with a stub. In block mode Ad Veil cancels those
// scripts before the shim applies; in veil mode the stub would replace the
// very ads veil mode lets through. Off while Ad Veil is on
// (adveil/aequera-adveil.js turns them back on when it is off); analytics
// and measurement shims are untouched.
pref("extensions.webcompat.disabled_shims.Adform", true);
pref("extensions.webcompat.disabled_shims.AdNexusAST", true);
pref("extensions.webcompat.disabled_shims.AdNexusPrebid", true);
pref("extensions.webcompat.disabled_shims.AdsByGoogle", true);
pref("extensions.webcompat.disabled_shims.AdvertisingCom", true);
pref("extensions.webcompat.disabled_shims.AmazonTAM", true);
pref("extensions.webcompat.disabled_shims.AmazonAdSystem", true);
pref("extensions.webcompat.disabled_shims.Criteo", true);
pref("extensions.webcompat.disabled_shims.Doubleclick", true);
pref("extensions.webcompat.disabled_shims.GoogleIMA", true);
pref("extensions.webcompat.disabled_shims.GooglePageAd", true);
pref("extensions.webcompat.disabled_shims.GooglePublisherTags", true);
pref("extensions.webcompat.disabled_shims.StickyAdsTV", true);
