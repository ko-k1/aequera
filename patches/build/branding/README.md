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
  `application.ini` with `-app`. A compiled build (not set up yet) takes
  everything above from configuration and also needs
  `--with-app-name=aequera` (binary and install names).
- Compiled-only identity (registry keys, taskbar AUMID, launcher, default
  browser agent) follows `MOZ_APP_VENDOR`/`MOZ_APP_BASENAME` but is only
  exercised by a compiled build and installer.
- macOS assets (`firefox.icns`, `Assets.car`, `dsstore`, disk image art)
  and `MOZ_MACBUNDLE_ID`'s `org.mozilla.` prefix; the Linux D-Bus name
  (`org.aequera.browser`). Neither platform is built yet.
