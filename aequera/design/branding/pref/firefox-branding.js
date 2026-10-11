/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Aequera branding prefs. The file name is fixed by Firefox's branding
// template (branding-common.mozbuild).
//
// No Mozilla landing pages: first run and upgrades open nothing remote.
pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");
// Aequera builds have no update service (--disable-updater); nothing here
// may point at Mozilla's update pages.
pref("app.update.url.manual", "");
pref("app.update.url.details", "");
// The old-build check runs when the first window opens and asks Mozilla's
// update service for a newer build: off. Artifact builds still carry the
// updater, so this is not a no-op there. The day count is Firefox's own
// contract with every branding (official: 63): BrowserGlue reads it
// unguarded, and without it first-window startup throws before
// browser-first-window-ready, so the new tab backend never starts (every
// about:newtab and about:home load hangs) if the check is ever turned on.
pref("app.update.checkInstallTime", false);
pref("app.update.checkInstallTime.days", 63);

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
pref("devtools.selfxss.count", 5);
