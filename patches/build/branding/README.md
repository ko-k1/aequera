# Branding and Profile Separation

First deliberate Firefox divergence (Phase 0, Workstream 4). Classification
per `docs/SOURCE_LAYOUT.md`: application identity cannot be expressed through
supported runtime preferences — it is build-time product identity — so the
mechanism is a narrow `patches/build` series, applied after W3's pipeline.
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

## Future patch design (queued behind the first real fetch)

```text
patches/build/branding/
├── README.md                  # this file
├── 0001-product-identity.patch      # app name, vendor, remoting, D-Bus
├── 0002-profile-layout.patch        # per-OS profile roots above
└── 0003-branding-assets.patch       # icons, about dialog strings
```

Each patch gets the standard hygiene: rationale, minimal scope, linked test
(profile-dir assertion per OS in a future compatibility test), and a named
upstream conflict surface (usually `toolkit/mozapps` + `browser/branding`).
Nothing here is validated against the tree yet — `patch check` will prove
each file the moment the series exists, which is exactly what W3 built.
