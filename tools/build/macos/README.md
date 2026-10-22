# macOS

Everything Aequera development needs that is true of macOS only. The flow
every OS shares (patch apply, build, run, edit loop, tests) is
[`tools/build/README.md`](../README.md); this page is what changes on top of
it.

## Setup

1. Install the Xcode command line tools and Mozilla's listed Homebrew
   formulae ([`tools/bootstrap/macos.md`](../../bootstrap/macos.md), then the
   official macOS guide).
2. In `worktree/firefox`, bootstrap exactly like Linux (same mozconfig):

   ```sh
   export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"
   ./mach bootstrap --application-choice browser_artifact_mode
   ```

   On Intel Macs, add `--no-system-changes` if Homebrew no longer has bottles
   for Mozilla's bootstrap packages; artifact mode does not need them.

3. One-time per logo change, on the Mac: compile the asset catalog and
   commit the result. The bundle step requires it, and `actool` exists only
   on Apple hosts:

   ```sh
   bash tools/branding/build_assets_car.sh
   ```

## Run

The shared launchers work as they are: `aequera-run.sh` for the dev loop,
`tools/build/aequera.sh` for the real profile
(`~/Library/Application Support/Aequera`). For a bundle binary
(`*.app/Contents/MacOS/*`), both write the launch ini into the bundle's
`Contents/Resources/browser/` and read the build's `application.ini` from
`dist/bin`, else from `Contents/Resources` (`platform.sh`).

## Compiled build

Parallelism stays on mach's default (`mozconfig` here); set
`MOZ_MAKE_FLAGS="-j<N>"` if the link OOMs. A compiled build is the
`Aequera.app` bundle (`org.aequera.browser`).

## Package (DMG)

```sh
bash tools/build/macos/package.sh
```

The packager finds the build's `dist/Aequera.app` under `obj/`, adds a small
launcher as `CFBundleExecutable`, writes Aequera's launch ini into the
bundle, ad-hoc signs it, smoke-tests `--version`, and writes:

```text
obj/macos/package/Aequera-<version>-macos-<arch>.dmg
obj/macos/package/Aequera-<version>-macos-<arch>.zip
obj/macos/package/SHA256SUMS
```

The artifact build re-signs each Mach-O while extracting it, which
invalidates the signatures of nested bundles. The packager re-signs nested
apps and frameworks (updater, crashreporter, plugin-container, ChannelPrefs,
UpdateSettings) from the inside out before sealing the outer bundle.

The DMG is a plain drag-to-Applications image. It is not Developer ID
signed or notarized: Gatekeeper asks for a right-click Open on another Mac.
Developer ID signing and notarization are release work, not part of the
build artifact.

Why the launcher: an artifact build's prebuilt Mozilla binary keeps
Firefox's compiled-in identity unless it is started with `-app`. The
launcher passes Aequera's ini and `-no-remote`, so double-clicking the
packaged app uses Aequera's own profile and never joins a running Firefox.
The same wrapper works for a compiled build, whose binary already has the
Aequera identity.

[`.github/workflows/macos.yml`](../../../.github/workflows/macos.yml) runs
this on both architectures (macos-15 arm64, macos-15-intel x86_64) after an
artifact build; `--no-check` skips only the launch smoke test.
`tools/ci/README.md` has the CI trigger and artifact details.

## Where macOS lives in the repo

| What | Path |
|---|---|
| Toolchain guide | `tools/bootstrap/macos.md` |
| Build hooks, mach tuning | `tools/build/macos/platform.sh`, `tools/build/macos/mozconfig` |
| Asset catalog | `tools/branding/build_assets_car.sh` (run on a Mac) |
| Firefox patches | `patches/gecko/macos/macos-glass` (Liquid Glass titlebar, macOS 26+) |
| Branding assets | `aequera/design/branding/macos/` (`Assets.xcassets`), `*.icns`, `background.png` |
| Shell runtime | `aequera/shell/firefox/platform/macos/`: vibrancy behind the frame, Essentials inset, Tor over a Unix socket (`ps` for liveness) |
| Shell tests | `browser_aequera_material_macos.js`, `browser_aequera_tor.js` |
| PR CI | `tools/ci/smoke.sh` |
| Packaging | `tools/build/macos/package.sh` (DMG + zip) |
| Build CI | `.github/workflows/macos.yml` (arm64 + Intel artifact builds) |

## Known gaps

- Not yet built or run on a Mac: the bundle layout in `platform.sh` and the
  `macos-glass` patch are unverified. The macOS packaging workflow is new
  and has not completed its first run yet.
- The DMG is unsigned and has no Finder background/window layout; Developer
  ID signing, notarization, and DMG polish beyond the committed
  `background.png`/`disk.icns` are release work.
- CI packages artifact builds only. A compiled `Aequera.app` is supported by
  the same packager, but a full Firefox build does not fit a hosted macOS
  runner comfortably; release builds need a larger or self-hosted Mac.
