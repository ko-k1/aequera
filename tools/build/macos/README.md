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

Build the app, then create the packaging stage from the same worktree:

```sh
cd worktree/firefox
export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"
./mach build
./mach package
cd -
bash tools/build/macos/package.sh
```

`tools/build/macos/mozconfig` sets `MOZ_PKG_FORMAT=ZIP`, so mach's package
step stages the app and a zip; Aequera's packager owns the DMG layout. This
also keeps mach out of its DMG path, which expects Mozilla's branding
`dsstore` and fails before `package.sh` can run.

The packager uses the packaged app under `obj/firefox/*/dist/<package-dir>/`
(`firefox` for the artifact build, `aequera` for a compiled build), adds a
small launcher as `CFBundleExecutable`, writes Aequera's launch ini into the
bundle, ad-hoc signs it, runs a headless screenshot that must start a content
process, and writes:

```text
obj/macos/package/Aequera-<version>-macos-<arch>.dmg
obj/macos/package/Aequera-<version>-macos-<arch>.zip
obj/macos/package/SHA256SUMS
```

**Do not distribute `obj/firefox/*/dist/Aequera.app`.** That is mach's
developer bundle, not a package. It has no `omni.ja` files and retains
`MozillaDeveloperRepoPath`/`MozillaDeveloperObjPath` entries pointing at the
build machine. Firefox then treats it as an unpackaged build; on the first
content-process launch it cannot find the repo/obj directories and crashes in
`ContentParent::BeginSubprocessLaunch` (`MOZ_CRASH("Failed to get path to repo
dir")`). `./mach package` writes the GRE and browser omni.jars and strips
those plist keys; `package.sh` rejects a bundle that is missing either.

The artifact build re-signs each Mach-O while extracting it, which
invalidates the signatures of nested bundles. The packager re-signs nested
apps and frameworks (updater, crashreporter, plugin-container, ChannelPrefs,
UpdateSettings) from the inside out before sealing the outer bundle.

It also materializes symlinks that point back into the objdir (mach's
default `NSDISTMODE=absolute_symlink`), leaving internal framework links
alone. A distributed app must not depend on build-tree paths, and codesign
rejects a framework whose main executable is a symlink.

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
artifact build and `./mach package`; `--no-check` skips only the headless
content-process smoke test. `tools/ci/README.md` has the CI trigger and
artifact details.

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

- CI builds and packages an artifact app on both architectures. The
  2026-10-22 run (39768190809) only proved the old `--version` path; the new
  headless content-process smoke needs a green dual-architecture run. The
  shared dev-launcher bundle path in `platform.sh`, the `macos-glass` patch,
  an interactive browser run, and a mochitest gate remain unverified on a
  Mac.
- The launcher is a signed shell script. It starts the browser and runs the
  headless smoke test, but a release should use a native Mach-O launcher so
  Launch Services and TCC see a native main executable.
- The DMG is unsigned and has no Finder background/window layout; Developer
  ID signing, notarization, and DMG polish beyond the committed
  `background.png`/`disk.icns` are release work.
- CI packages artifact builds only. A compiled `Aequera.app` is supported by
  the same packager, but a full Firefox build does not fit a hosted macOS
  runner comfortably; release builds need a larger or self-hosted Mac.
