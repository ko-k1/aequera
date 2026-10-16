# Windows

Everything Aequera development needs that is true of Windows only. The flow
every OS shares (patch apply, build, run, edit loop, tests) is
[`tools/build/README.md`](../README.md); this page is what changes on top of
it.

## Setup

Toolchain prerequisites: [`tools/bootstrap/windows.md`](../../bootstrap/windows.md)
(VS2022 + MozillaBuild).

1. Install **MozillaBuild** (https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe)
   to the default `C:\mozilla-build`.
2. Open `C:\mozilla-build\start-shell.bat`, then:

   ```sh
   cd <repo>/worktree/firefox
   export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"
   ./mach bootstrap   # choose "Firefox for Desktop Artifact Mode"
   ```

Every POSIX script under `tools/build/` runs in the MozillaBuild shell and
in Git Bash.

## Run

In the build shell, use the shared launchers (`aequera-run.sh`). Outside it
(Explorer, cmd, PowerShell), start the real Aequera profile with
`tools\build\windows\aequera.cmd`: double-click it, or run it with extra
Firefox arguments. It is the batch counterpart of `aequera.sh` (same
identity, same dist copies), except that it purges the startup cache on
every launch.

## Dist copies

Local builds symlink front-end files into `dist`. `MOZ_DEVELOPER_REPO_DIR`,
which every launcher exports, is not enough on Windows hosts where Python
may create symlinks (Developer Mode, elevated shells): Gecko still refuses
symlinked built-in add-on files in content processes (Ad Veil's content
scripts, Firefox's new tab bundle), and the sandbox exception does not cover
the objdir, which sits outside the source tree here (`PromiseWorker.js` and
other generated files). So every launcher and `test-shell.sh` first turn the
links in `dist/bin` into copies (`dist_copies.py`, the layout Firefox's own
Windows builds use; the `aequera_platform_prepare_dist` hook). `mach build`
relinks, so this repeats each start and costs one scan of `dist/bin` when
nothing changed. Links to missing files are reported and left alone; a
launch stops only when the step itself fails (no Python, an unreadable
`dist/bin`). One consequence: an edit in the worktree no longer reaches
`dist` by itself; run `./mach build faster` (the edit loop) first.

## Compiled build

Notes from bringing it up on Windows (2026-10-03, 128 GB box shared with ML
training):

- Parallelism is capped to `-j1` (`mozconfig` here; override with
  `AEQUERA_MAKE_FLAGS="-j<N>"` on an idle box): even `-j4` OOMs giant
  unified TUs and the `gkrust` LTO link against resident training jobs. The
  box idles through it if training is paused.
- Rust: the tree needs >= 1.90.0, but a newer rustc can crash on the
  `gkrust` LTO link (stable hit `0xc0000409`); 1.95.0 is known-good. Point
  `RUSTC`/`CARGO` at it in the build shell (configure-time setting, so
  re-run `./mach configure` after changing it).

A compiled build is `aequera.exe` with the Aequera icons embedded, registry
keys, and taskbar AUMID.

## Tests

The shared gate (`test-shell.sh`) adds `widget.windows.mica=false` to the
Firefox defaults of upstream runs (`aequera_platform_test_prefs`): Aequera
turns Mica on, Firefox leaves it off.

## Where Windows lives in the repo

| What | Path |
|---|---|
| Toolchain guide | `tools/bootstrap/windows.md` |
| Build hooks, mach tuning | `tools/build/windows/platform.sh`, `tools/build/windows/mozconfig` |
| Launcher (no shell) | `tools/build/windows/aequera.cmd` |
| Dist copies | `tools/build/windows/dist_copies.py`, tested by `tests/unit/build/windows/` |
| Tor port-takeover check | `tests/security/tor/windows/port-takeover/` (elevated PowerShell) |
| Branding assets | `aequera/design/branding/*.ico`, `*.bmp`, `VisualElements_*`, `branding.nsi` (Firefox's branding layout keeps Windows files at the directory root) |
| Shell runtime | `aequera/shell/firefox/platform/windows/`: Acrylic backdrop and frame paint, Alt+digit workspaces, Tor over a loopback TCP port (`docs/design/TOR.md`) |
| Shell tests | `browser_aequera_material_windows.js`, `browser_aequera_tor_windows.js` |
| PR CI | `tools/ci/smoke.ps1` |

No Firefox patch is Windows-only.

## Known gaps

- No installer yet (`msix/`, NSIS).
