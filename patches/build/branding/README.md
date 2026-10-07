# Branding and Profile Separation

First deliberate Firefox divergence (Phase 0, Workstream 4). Classification
per `docs/SOURCE_LAYOUT.md`: application identity cannot be expressed through
supported runtime preferences — it is build-time product identity — so the
mechanism is build configuration and an Aequera branding directory, plus a
narrow `patches/build` series for the two values configuration cannot set
(see Implementation).
Runtime values live in `configs/defaults/branding.toml` (validated from W5).

## Product identity

| Value | Resolution |
|---|---|
| Display name | `Aequera` |
| `MOZ_APP_NAME` | `aequera` (lowercase; drives binary and profile paths) |
| `MOZ_APP_VENDOR` | `Aequera` |
| Branding directory | custom `aequera/` branding dir selected via `--with-branding` (no Mozilla artwork, strings, or partner references ship) |
| Remoting / single-instance name | `aequera` on all platforms (Linux remote bus: `org.aequera.aequera.<profile>`) |
| D-Bus / desktop identity (Linux) | `org.aequera.browser` for the desktop entry, portal registration, and GNOME search provider (never `org.mozilla.*` anywhere: main session bus is `org.aequera.aequera`, MPRIS suffix `.aequera`) |
| macOS bundle identity | `org.aequera.browser` (distribution `org.aequera` + `MOZ_MACBUNDLE_ID=browser`) |
| Update channel | `aequera-release` (reserved; no update infrastructure in Phase 0) |

## Profile separation (non-negotiable)

An Aequera-derived build must run side by side with stable Firefox without
sharing or migrating any user data unless the user explicitly opts in:

| OS | Aequera profile root |
|---|---|
| Windows | `%APPDATA%\Aequera\Profiles` (roaming), `%LOCALAPPDATA%\Aequera\Profiles` (local) |
| Linux | `~/.aequera/` |
| macOS | `~/Library/Application Support/Aequera/` |

Rules:

1. No Firefox profile is ever auto-migrated, copied, or linked. Import is an
   explicit, reviewable user action (later phase).
2. No `org.mozilla.*` service, registry key, or file path is claimed.
3. Telemetry client identity stays disabled with the product (see W5); branding
   must never re-enable attribution, studies, or normandy-style remote content.

## Implementation

Firefox exposes almost all of this as supported build configuration, so
most of the rebrand is configuration plus Aequera-owned source, and the
patch series is one small patch:

| Piece | Layer | Where |
|---|---|---|
| Branding directory: name strings (`brand.ftl`, `brand.properties`), logo and icons, about dialog, Windows tiles and installer art, branding prefs (no Mozilla landing or update pages) | Aequera source (overlay) | `aequera/design/branding` -> `browser/branding/aequera`; source `source/aequera-icon.svg`, rasters from `tools/branding/render_brand_assets.py` |
| macOS bundle icons (`firefox.icns`, `document.icns`) + asset-catalog source (`macos/Assets.xcassets`) | Aequera source (overlay) | same overlay; `firefox.icns`/`document.icns` are staged into the .app by `browser/app/moz.build`; `document.icns` reuses the mark, matching `document.ico`. Compile the .xcassets to `Assets.car` on a Mac (see Not yet covered) |
| Linux desktop entry, icons, search-provider files (`linux/org.aequera.browser.*`, `hicolor/`) | Aequera source | `aequera/design/branding/linux/` + `hicolor/`; installed to `~/.local/share/applications` (desktop entry) and the hicolor theme (icons) by the user or a future installer; the search-provider `.ini`/`.service` go to their GNOME paths per the upstream `search-provider-files/README` they mirror |
| Linux bus/service names (`org.aequera.*`, never `org.mozilla.*`) | patch | `patches/toolkit/linux-desktop/`: 0001 session-bus + single-instance remote names, 0002 GNOME search-provider identity (matches the shipped `.ini`/`.service`), 0003 portal app ID (`org.aequera.browser`, matches the desktop entry) + MPRIS suffix |
| `--with-branding`, `--with-app-basename=Aequera` (Name), `MOZ_APP_REMOTINGNAME=aequera`, `--with-distribution-id=org.aequera` | configuration | `tools/build/mozconfig.branding` (sourced by every Aequera mozconfig). The distribution ID prefixes every mac helper bundle ID and the app itself (`org.aequera.browser` via `MOZ_MACBUNDLE_ID=browser` in the branding `configure.sh`), and surfaces truthfully as Distribution ID in about:support |
| No Mozilla update or crash-report server | launcher (artifact) / configuration (compiled) | the artifact binary has both compiled in and will not start without their front end, so `aequera_app_ini.py` drops `[AppUpdate]` and `[Crash Reporter]` from the launch ini; a compiled build uses `--disable-updater --disable-crashreporter` |
| `MOZ_APP_VENDOR=Aequera`, `MOZ_APP_PROFILE=Aequera` | patch | `0001-product-identity.patch`: project flags only `browser/moz.configure` may set (a mozconfig is refused) |
| `MOZ_APP_ID` | unchanged | Firefox's ID keeps WebExtension compatibility |

Result, checked on the artifact build: `dist/bin/application.ini` carries
Vendor/Name `Aequera`, RemotingName `aequera`, Profile `Aequera`, and the
launcher copy has no crash-report or update server; started through
`tools/build/aequera.cmd` (Windows), `tools/build/aequera.sh`
(Linux/macOS), or `aequera-run.sh`, the window, brand strings, and about
dialog read Aequera and profiles live under the per-OS root above.

## Not yet covered

- The prebuilt binary of an artifact build keeps Mozilla's compiled-in
  identity, file name, and icon; the launchers pass the Aequera
  `application.ini` with `-app`. A compiled build (`mozconfig.compiled`,
  `obj-aequera`, up since 2026-10-03 on Windows) takes everything above from
  configuration: `MOZ_APP_NAME` defaults to `aequera`, so the binary is
  `aequera` (`aequera.exe` on Windows, `Aequera.app` on macOS) with the
  Aequera icon embedded (verified on Windows by icon extraction against the
  old binary).
- Compiled-only identity (Windows registry keys, taskbar AUMID, launcher,
  default browser agent) follows `MOZ_APP_VENDOR`/`MOZ_APP_BASENAME` but is
  only exercised by a compiled build and installer (no installer built yet
  on any platform).
- `Assets.car` (macOS): the asset-catalog source ships
  (`macos/Assets.xcassets`, AppIcon set rendered from the mark), but the
  compiled `.car` needs Xcode and is not yet built. On a Mac, from the
  checkout root:
  `xcrun actool --output-format human-readable-text --notices --warnings
  --platform macosx --minimum-deployment-target 10.15 --output-partial-info-plist /tmp/a.plist
  --app-icon AppIcon --include aequera/design/branding/macos/Assets.xcassets
  --compile aequera/design/branding`
  then verify `aequera/design/branding/Assets.car` exists for the next
  `patch apply` (the overlay syncs it into `browser/branding/aequera`, where
  `browser/app/moz.build` stages it into the .app). DMG art (`disk.icns`,
  `background.png`, `dsstore`) likewise waits for the installer pipeline.
- Runtime validation on real Linux/macOS builds: the D-Bus names, desktop
  entry, bundle ID, and icons above are verified textually (`patch check`)
  and by construction against the pinned source, but no Linux/macOS
  `mach build` + run has exercised them yet (first one is Slice 6 nightly
  work, not speculative packaging).
