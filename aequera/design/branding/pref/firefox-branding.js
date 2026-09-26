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

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
pref("devtools.selfxss.count", 5);
