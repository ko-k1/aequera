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
| Remoting / single-instance name | `aequera` on all platforms |
| D-Bus service (Linux) | `org.aequera.browser` (never `org.mozilla.*`) |
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
| `--with-branding`, `--with-app-basename=Aequera` (Name), `MOZ_APP_REMOTINGNAME=aequera` | configuration | `tools/build/mozconfig.branding` (sourced by every Aequera mozconfig) |
| No Mozilla update or crash-report server | launcher (artifact) / configuration (compiled) | the artifact binary has both compiled in and will not start without their front end, so `aequera_app_ini.py` drops `[AppUpdate]` and `[Crash Reporter]` from the launch ini; a compiled build uses `--disable-updater --disable-crashreporter` |
| `MOZ_APP_VENDOR=Aequera`, `MOZ_APP_PROFILE=Aequera` | patch | `0001-product-identity.patch`: project flags only `browser/moz.configure` may set (a mozconfig is refused) |
| `MOZ_APP_ID` | unchanged | Firefox's ID keeps WebExtension compatibility |

Result, checked on the artifact build: `dist/bin/application.ini` carries
Vendor/Name `Aequera`, RemotingName `aequera`, Profile `Aequera`, and the
launcher copy has no crash-report or update server; started through `tools/build/aequera.cmd` or
`aequera-run.sh`, the window, brand strings, and about dialog read Aequera
and profiles live in `%APPDATA%\Aequera\Profiles`.

## Not yet covered

- The prebuilt `firefox.exe` of an artifact build keeps Mozilla's
  compiled-in identity, file name, and icon; the launchers pass the Aequera
  `application.ini` with `-app`. A compiled build (`mozconfig.compiled`,
  `obj-aequera`, up since 2026-10-03) takes everything above from
  configuration: `MOZ_APP_NAME` defaults to `aequera`, so the binary is
  `aequera.exe` with the Aequera `firefox.ico` embedded (verified by icon
  extraction against the old binary).
- Compiled-only identity (registry keys, taskbar AUMID, launcher, default
  browser agent) follows `MOZ_APP_VENDOR`/`MOZ_APP_BASENAME` but is only
  exercised by a compiled build and installer (no installer built yet).
- macOS bundle art: `firefox.icns`, `document.icns`, `disk.icns`, and
  `background.png` are committed (rendered from `source/aequera-icon.svg`
  by `tools/branding/render_brand_assets.py`). v1 placeholder: all three
  `.icns` reuse the same 1024px app mark (byte-identical); differentiated
  document/disk art is future work. Still open: `Assets.car`,
  which only Xcode's `actool` can compile — run
  `tools/branding/build_assets_car.sh` once on a Mac and commit the result;
  until then no macOS build can link the bundle. The `AppIcon.appiconset`
  currently caps at 256x256 (mirrors committed `default*.png`, like
  upstream branding dirs) and the `actool` flags plus the macOS
  `application.ini` lookup in `aequera-run.sh` are unverified — needs a
  real Mac bundle-layout check. `MOZ_MACBUNDLE_ID=aequera`
  follows upstream nightly's bare-name convention.
- The Linux D-Bus name (`org.aequera.browser`): the `org.mozilla.*`
  namespace is hardcoded upstream (`widget/gtk/DBusService.cpp`,
  `toolkit/components/remote/nsDBusRemote{Client,Server}.cpp`, portal id in
  `widget/gtk/WidgetUtilsGtk.cpp`) and needs narrow Gecko-level patches
  plus session-bus testing. Neither that rename nor a macOS build has
  happened yet.
