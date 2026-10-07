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
syncs overlays (`aequera/shell/firefox` -> `worktree/firefox/browser/aequera`).
Then, inside `worktree/firefox` from the build shell:

```sh
export MOZCONFIG="$HOME/aequera/tools/build/mozconfig.artifact"   # actual checkout path
./mach bootstrap   # choose "Firefox for Desktop Artifact Mode"
```

(On Windows the shell shows MozillaBuild paths such as
`/c/src/aequera/...`; on Linux/macOS the same lines use `$HOME/...`.
`aequera` itself runs in any shell.)

## Build and run

```sh
./mach build
bash tools/build/aequera-run.sh               # throwaway dev profile
bash tools/build/aequera-run.sh --persistent  # real Aequera profile
```

(run from `worktree/firefox`; `tools/build/...` is relative to the checkout
root, e.g. `bash /c/src/aequera/tools/build/aequera-run.sh` on Windows).

Outside the build shell, start the real Aequera profile without mach:
`tools\build\aequera.cmd` on Windows (double-click it, or run it with extra
Firefox arguments) or `tools/build/aequera.sh` on Linux/macOS. Either is
`--persistent` without the shell.

Always start through one of these, never bare `./mach run` or the binary.
All launchers prefer the compiled build (`obj-aequera`: native `aequera`
binary with its own file name and embedded Aequera icon, `Aequera.app` on
macOS) and fall back to the artifact build. All also export
`MOZ_DEVELOPER_REPO_DIR` (and `MOZ_DEVELOPER_OBJ_DIR`), like `mach run`
does: local builds symlink front-end files into `dist`, and the Windows
content-process sandbox only resolves those links when the repo dir is
advertised (upstream bug 1916286).
Without it DevTools cannot open (`Ctrl+Shift+I`, `F12`, … fail with
`builtin-modules.js is not found`). The build is branded Aequera
(`mozconfig.branding` + `patches/build/branding`: name, logo, vendor,
profiles in `%APPDATA%\Aequera` on Windows, `~/.aequera` on Linux,
`~/Library/Application Support/Aequera` on macOS, remoting `aequera`, no
updater or crash upload), and its `application.ini` says so; but an artifact
build's prebuilt binary is Mozilla's, which ignores that file and uses the
Firefox identity compiled into it, opening your Firefox profile and
colliding with a Firefox you have open. All launchers copy the ini to
`browser/aequera-application.ini` (`aequera_app_ini.py` refuses one without
the Aequera identity) and start with `-app`, `-no-remote`, and
`-purgecaches`.

## Compiled build (full C++/Rust; the app icon lives here)

```sh
export MOZCONFIG="$HOME/aequera/tools/build/mozconfig.compiled"   # actual checkout path
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

- Parallelism is capped to `-j1` on Windows (`mozconfig.platform`): even
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
3. In the build shell: `./mach build faster && bash tools/build/aequera-run.sh`
   (run from `worktree/firefox`; `build faster` repackages front-end files
   only; seconds).

## Tests

```sh
bash tools/build/test-shell.sh            # all (from worktree/firefox)
bash tools/build/test-shell.sh aequera --repeat 4
```

- `aequera`: Aequera-owned mochitests (`aequera/shell/firefox/tests`),
  under Aequera defaults.
- `upstream`: Firefox's own sidebar tests with Firefox's defaults restored
  (`--setpref`), proving the `sidebar-motion` patches change nothing by
  default. Firefox's tests assume Firefox's defaults: run without the
  resets, `browser_sidebar_expand_on_hover.js` fails its first assertion
  because Aequera ships expand-on-hover on.

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
