# Background Network Activity

`docs/RESTRICTIONS.md`: network activity must have a user-visible or
platform-required reason. This is the list of connections the browser opens
on its own (not for a page the user loads), the reason each one stays, and
the ones Aequera turns off. A change that adds a background connection adds
a row here.

## How it is measured

`tools/benchmark/browser_bench.py` runs the browser through a local proxy
that logs host names only: `first_launch.network` is a new profile's first
launch, `network.startup_and_settle` and `network.idle_window` a later
launch and the idle minutes after it (`tools/benchmark/README.md`). Timers
longer than the measured windows (daily update checks, the Remote Settings
poll) are listed from Firefox's defaults and marked as such.

Measured 2026-10-20, artifact build of Firefox 158.0 on Linux aarch64,
5-minute first launch, warm launch plus 60 s idle:

| Window | Before | After (this list's prefs) |
|---|---|---|
| first launch | 9 hosts, 20 connections | 7 hosts, 19 connections |
| later launch and idle | portal check, push | unchanged |

## Connections that stay

| Host | What | Reason |
|---|---|---|
| `firefox.settings.services.mozilla.com`, `firefox-settings-attachments.cdn.mozilla.net`, `content-signature-2.cdn.mozilla.net` | Remote Settings: signed data the platform consumes (certificate revocation, add-on and plugin blocklists, security state, search configuration). First launch, then a periodic poll. | Platform-required: security data. Experiments that also ride on it stay off (`app.shield.optoutstudies.enabled`, `app.normandy.enabled`, privacy.toml). |
| `firefox-portal-detection.com` (HTTP) | Captive-portal and connectivity check, at startup and on network changes. | User-visible: the "log in to the network" bar on hotel and airport networks. |
| `push.services.mozilla.com` | Web Push connection. | User-visible: notifications from sites the user allowed; also delivers Remote Settings change broadcasts. |
| `aus5.mozilla.org` (media plugin manifest), `ciscobinary.openh264.org` | The OpenH264 codec: its manifest, then the download (first launch, then periodic checks). | User-visible: H.264 video calls (WebRTC). |
| Safe Browsing (`safebrowsing.googleapis.com`), add-on updates (`versioncheck.addons.mozilla.org`) | List updates and update checks on daily timers; not seen in the measured windows. | Platform-required: malware and phishing protection, security fixes for installed add-ons. |
| Ad Veil vault images | The image of an ad the page already loaded, fetched once without cookies or referrer, normal windows only (`docs/design/ADS.md`, Vault). | User-visible: the vault shows saved ads; "Save ad images" turns it off. |

Application updates are left as Firefox has them pending their own ADR
(`docs/engineering/RELEASE.md`).

## Connections Aequera turns off

Set in `aequera/shell/firefox/aequera-prefs.js` as defaults (a user may turn
each back on); `aequera config validate` fails if one ships otherwise.

| Pref | Firefox default | Aequera | Host it stops |
|---|---|---|---|
| `browser.region.update.enabled` | `true` | `false` | `location.services.mozilla.com` (region from the user's IP) |
| `browser.region.network.url` | Mozilla's region URL | `""` | the same |
| `extensions.getAddons.cache.enabled` | `true` | `false` | `services.addons.mozilla.org` (metadata of installed add-ons, sent by ID) |
| `extensions.getAddons.showPane` | `true` | `false` | recommendations in the Add-ons Manager |
| `extensions.htmlaboutaddons.recommendations.enabled` | `true` | `false` | the same |
| `browser.discovery.enabled` | `true` | `false` | personalized add-on recommendations |
| `browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons` | `true` | `false` | "recommended extension" suggestions |
| `browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features` | `true` | `false` | "recommended feature" suggestions |

Without the region lookup, region defaults (search engines offered first,
for one) follow the locale. The recommendation prefs remove promotional
UI (`docs/RESTRICTIONS.md`: no advertising or sponsored UI) as much as they
remove connections.

The privacy defaults (telemetry, studies, sponsored content, Pocket, crash
upload) are in `configs/defaults/privacy.toml`; the Tor instance turns off
much more (`docs/design/TOR.md`).
