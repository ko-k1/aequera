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

## Where macOS lives in the repo

| What | Path |
|---|---|
| Toolchain guide | `tools/bootstrap/macos.md` |
| Build hooks, mach tuning | `tools/build/macos/platform.sh`, `tools/build/macos/mozconfig` |
| Asset catalog | `tools/branding/build_assets_car.sh` (run on a Mac) |
| Firefox patches | `patches/gecko/macos-glass` (Liquid Glass titlebar, macOS 26+) |
| Branding assets | `aequera/design/branding/macos/` (`Assets.xcassets`), `*.icns`, `background.png` |
| Shell runtime | `aequera/shell/firefox/platform/macos/`: vibrancy behind the frame, Essentials inset, Tor over a Unix socket (`ps` for liveness) |
| Shell tests | `browser_aequera_material_macos.js`, `browser_aequera_tor.js` |
| PR CI | `tools/ci/smoke.sh` |

## Known gaps

- Not yet built or run on a Mac: the bundle layout in `platform.sh` and the
  `macos-glass` patch are unverified.
- No dmg polish beyond the committed `background.png`/`disk.icns`.
