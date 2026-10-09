# Build — run Aequera on real Firefox

Stage 1 shell work is front-end only (CSS, window JS, prefs), so the default
is an **artifact build**: Mozilla's prebuilt compiled parts for the pinned
revision plus a local front-end build. Minutes, not hours; no host C++
toolchain beyond the bootstrap guides.

## One-time setup

Pick the toolchain guide for the host OS (`tools/bootstrap/`), then generate
the worktree (any shell):

| OS | Toolchain guide | Build shell |
|---|---|---|
| Windows 10/11, 64-bit | `tools/bootstrap/windows.md` (VS2022 + MozillaBuild) | `C:\mozilla-build\start-shell.bat` |
| macOS (Apple Silicon / Intel) | `tools/bootstrap/macos.md` (Xcode CLT + Homebrew) | any terminal |
| Linux (Debian/Ubuntu, Fedora, Arch) | `tools/bootstrap/linux.md` (clang + distro headers) | any terminal |

```sh
aequera patch apply
```

This checks out Firefox at the lock, applies `patches/` in order, and
syncs overlays (`aequera/shell/firefox` -> `worktree/firefox/browser/aequera`
and branding). Then follow the section for your OS
(`tools/bootstrap/*.md` has the prerequisite details).

### Windows

1. Install **MozillaBuild** (https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe)
   to the default `C:\mozilla-build`.
2. Open `C:\mozilla-build\start-shell.bat`, then:

   ```sh
   cd <repo>/worktree/firefox
   export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"
   ./mach bootstrap   # choose "Firefox for Desktop Artifact Mode"
   ```

### Linux

1. Install the distribution's Firefox build dependencies plus clang; the
   official guide is authoritative:
   `https://firefox-source-docs.mozilla.org/setup/linux_build.html`
   (see also `tools/bootstrap/linux.md`).
2. In `worktree/firefox`:

   ```sh
   export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"
   ./mach bootstrap --application-choice browser_artifact_mode
   ```

### macOS

1. Install the Xcode command line tools and Mozilla's listed Homebrew
   formulae (`tools/bootstrap/macos.md`, then the official macOS guide).
2. In `worktree/firefox`, bootstrap exactly like Linux (same mozconfig).
3. One-time per logo change, on the Mac: compile the asset catalog and
   commit the result — the bundle step requires it and `actool` exists
   only on Apple hosts:

   ```sh
   bash tools/branding/build_assets_car.sh
   ```

## Build and run

```sh
cd worktree/firefox
./mach build
bash ../../tools/build/aequera-run.sh               # throwaway dev profile
bash ../../tools/build/aequera-run.sh --persistent  # real Aequera profile
```

`aequera-run.sh` works in any POSIX shell on all three platforms (it finds
the repo from its own location, so any checkout directory works). When
`MOZCONFIG` is unset it picks the mozconfig matching the objdir
(`obj-aequera` -> compiled, anything else -> artifact); `AEQUERA_BUILD`
(`compiled`|`artifact`) overrides that guess for custom objdirs. On
Windows outside the MozillaBuild shell (Explorer, cmd, PowerShell), start
the real Aequera profile with `tools\build\aequera.cmd`: double-click it,
or run it with extra Firefox arguments; on Linux/macOS use
`tools/build/aequera.sh`. Either is `--persistent` without the shell.

Always start through one of these, never bare `./mach run` or the binary.
All launchers prefer the compiled build (`obj-aequera`: native `aequera`
binary with its own file name and embedded Aequera icon, `Aequera.app` on
macOS) and fall back to the artifact build. All also export
`MOZ_DEVELOPER_REPO_DIR` (and `MOZ_DEVELOPER_OBJ_DIR`), like `mach run`
does: local builds symlink front-end files into `dist`, and the Windows
content-process sandbox only resolves those links when the repo dir is
advertised (upstream bug 1916286). Without it DevTools cannot open
(`Ctrl+Shift+I`, `F12`, … fail with `builtin-modules.js is not found`).
The build is branded Aequera (`mozconfig.branding` +
`patches/build/branding`: name, logo, vendor, own profile root —
`%APPDATA%\Aequera` on Windows, `~/.aequera` on Linux,
`~/Library/Application Support/Aequera` on macOS — remoting `aequera`,
no updater or crash upload), and its `application.ini` says so; but an artifact
build's prebuilt binary is Mozilla's, which ignores that file and uses the
Firefox identity compiled into it, opening your Firefox profile and
colliding with a Firefox you have open. All launchers copy the ini to
`browser/aequera-application.ini` (`aequera_app_ini.py` refuses one without
the Aequera identity) and start with `-app`, `-no-remote`, and
`-purgecaches`.

## Compiled build (full C++/Rust; Aequera binary and icons end to end)

```sh
export MOZCONFIG="$PWD/../../tools/build/mozconfig.compiled"
./mach bootstrap --application-choice browser   # once: host toolchain (VS2022 + SDK on
                                                 # Windows, Xcode CLT + Homebrew on macOS,
                                                 # clang + headers on Linux)
./mach build
```

`mozconfig.compiled` is `mozconfig.artifact` minus artifact mode and the
`--with-app-name=firefox` pin, plus `--disable-updater
--disable-crashreporter`, in its own `obj-aequera` dir so both builds
coexist. Host tuning (parallelism, Rust notes) lives in
`mozconfig.platform`, sourced by both. First build is hours; later ones are
incremental. Notes from bringing it up on Windows (2026-10-03, 128 GB box
shared with ML training) — per-OS guidance, not global defaults:

- Parallelism is capped to `-j1` on Windows (`mozconfig.platform`;
  override with `AEQUERA_MAKE_FLAGS="-j<N>"` on an idle box): even
  `-j4` OOMs giant unified TUs and the `gkrust` LTO link against resident
  training jobs. The box idles through it if training is paused. Linux/macOS
  stay on mach's default; set `MOZ_MAKE_FLAGS="-j<N>"` if the link OOMs.
- Rust: the tree needs >= 1.90.0, but a newer rustc can crash on the
  `gkrust` LTO link (on Windows stable hit `0xc0000409`); 1.95.0 is
  known-good there. Point `RUSTC`/`CARGO` at it in the build shell
  (configure-time setting, so re-run `./mach configure` after changing it).

## Edit loop

1. Edit Aequera source in `aequera/shell/firefox/` (never in the worktree:
   the overlay copy is replaced on every apply).
2. `aequera patch apply` — re-syncs the overlay; patches stay verified.
3. `./mach build faster && bash ../../tools/build/aequera-run.sh`
   (run from `worktree/firefox`; `build faster` repackages front-end files
   only; seconds).

## Tests

```sh
bash ../../tools/build/test-shell.sh            # all (from worktree/firefox)
bash ../../tools/build/test-shell.sh aequera --repeat 4
```

- `aequera`: Aequera-owned mochitests (`aequera/shell/firefox/tests`),
  under Aequera defaults.
- `upstream`: Firefox's own sidebar tests with Firefox's defaults restored
  (`--setpref`), proving the `aequera-rail` patches change nothing by
  default. Firefox's tests assume Firefox's defaults: run without the
  resets, `browser_sidebar_expand_on_hover.js` fails its first assertion
  because Aequera ships expand-on-hover on.

On NixOS, use the `-nixos` wrappers, which take the same arguments and
work from any directory:
`bash tools/build/test-shell-nixos.sh` for the gate and
`bash tools/build/aequera-run-nixos.sh [--persistent]` to start the
browser. They run inside `steam-run` because Mozilla's prebuilt binaries
need an FHS system. They also keep temp files, the fontconfig cache and
crash dumps under `.tmp/nixos/`, because the shared `~/.cache/fontconfig`
crashes the browser at startup (`tools/build/nixos-env.sh`).

Headless servers are fine: the suite runs `--headless`, and the two
platform-drag tab tests skip themselves there (no drag service without a
display); they stay covered on headed runs.

## Stage 1 acceptance

- Tabs render in the vertical rail; hovering the rail widens it after
  ~40ms over 250ms.
- While widened, the rail is the same material as when collapsed (no
  second opaque panel, no divider), and the page's left edge clips back
  in step with the rail. The page itself does not reflow.
- Fullscreen shows the page unclipped.
- Browser Console (`Ctrl+Shift+J`) shows no `aequera-shell` errors.
- `about:config`: the prefs in `aequera-prefs.js` show as defaults.

## If artifact download fails

Artifacts exist only for revisions Mozilla's CI built. If `mach build`
cannot find artifacts for the pinned release revision, switch to a full
build: drop `--enable-artifact-builds` from a copy of the mozconfig and
install the host C++ toolchain (`tools/bootstrap/windows.md`,
`macos.md`, or `linux.md` for the OS).

## Known platform gaps

- No installer is built yet on any platform (Windows `msix/`, macOS dmg
  polish beyond the committed `background.png`/`disk.icns`).
