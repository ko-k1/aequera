# Build — run Aequera on real Firefox

Stage 1 shell work is front-end only (CSS, window JS, prefs), so the default
is an **artifact build**: Mozilla's prebuilt compiled parts for the pinned
revision plus a local front-end build. Minutes, not hours; no Visual Studio.

## One-time setup (Windows)

1. Install **MozillaBuild** (https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe)
   to the default `C:\mozilla-build`.
2. Generate the worktree (any shell):

   ```powershell
   aequera patch apply
   ```

   This checks out Firefox at the lock, applies `patches/` in order, and
   syncs overlays (`aequera/shell/firefox` -> `worktree/firefox/browser/aequera`).
3. Open `C:\mozilla-build\start-shell.bat`, then:

   ```sh
   cd /c/src/aequera/worktree/firefox
   export MOZCONFIG=/c/src/aequera/tools/build/mozconfig.artifact
   ./mach bootstrap   # choose "Firefox for Desktop Artifact Mode"
   ```

## Build and run

```sh
./mach build
bash /c/src/aequera/tools/build/aequera-run.sh               # throwaway dev profile
bash /c/src/aequera/tools/build/aequera-run.sh --persistent  # real Aequera profile
```

Outside the MozillaBuild shell (Explorer, cmd, PowerShell), start the real
Aequera profile with `tools\build\aequera.cmd`: double-click it, or run it
with extra Firefox arguments. It is `--persistent` without the shell.

Always start through one of these, never bare `./mach run` or the exe. Both
launchers prefer the compiled build (`obj-aequera/dist/bin/aequera.exe`,
own file name and embedded Aequera icon) and fall back to the artifact
build. Both also export `MOZ_DEVELOPER_REPO_DIR` (and
`MOZ_DEVELOPER_OBJ_DIR`), like `mach run` does: local builds symlink
front-end files into `dist`, and the Windows content-process sandbox only
resolves those links when the repo dir is advertised (upstream bug 1916286).
Without it DevTools cannot open (`Ctrl+Shift+I`, `F12`, … fail with
`builtin-modules.js is not found`). The build is branded Aequera (`mozconfig.branding` +
`patches/build/branding`: name, logo, vendor, profiles in
`%APPDATA%\Aequera`, remoting `aequera`, no updater or crash upload), and
its `application.ini` says so; but an artifact build's `firefox.exe` is
Mozilla's prebuilt binary, which ignores that file and uses the Firefox
identity compiled into it, opening your Firefox profile and colliding with
a Firefox you have open. Both launchers copy the ini to
`browser/aequera-application.ini` (`aequera_app_ini.py` refuses one without
the Aequera identity) and start with `-app`, `-no-remote`, and
`-purgecaches`.

## Compiled build (full C++/Rust; the exe icon lives here)

```sh
export MOZCONFIG=/c/src/aequera/tools/build/mozconfig.compiled
./mach bootstrap --application-choice browser   # once: VS2022 + SDK + toolchains
./mach build
```

`mozconfig.compiled` is `mozconfig.artifact` minus artifact mode and the
`--with-app-name=firefox` pin, plus `--disable-updater
--disable-crashreporter`, in its own `obj-aequera` dir so both builds
coexist. First build is hours; later ones are incremental. Machine notes
from bringing it up (2026-10-03, 128 GB box shared with ML training):

- Cap parallelism in the mozconfig (`MOZ_MAKE_FLAGS="-j1"` here): even
  `-j4` OOMs giant unified TUs and the `gkrust` LTO link against resident
  training jobs. The box idles through it if training is paused.
- Rust: the tree needs >= 1.90.0, but newer rustc can crash on the
  `gkrust` LTO link (stable hit `0xc0000409` here); 1.95.0 is known-good.
  Point `RUSTC`/`CARGO` at it in the build shell (configure-time setting,
  so re-run `./mach configure` after changing it).

## Edit loop

1. Edit Aequera source in `aequera/shell/firefox/` (never in the worktree:
   the overlay copy is replaced on every apply).
2. `aequera patch apply` — re-syncs the overlay; patches stay verified.
3. In the MozillaBuild shell: `./mach build faster && bash /c/src/aequera/tools/build/aequera-run.sh`
   (`build faster` repackages front-end files only; seconds).

## Tests

```sh
bash /c/src/aequera/tools/build/test-shell.sh            # all
bash /c/src/aequera/tools/build/test-shell.sh aequera --repeat 4
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
install Visual Studio 2022 with C++ (see `tools/bootstrap/windows.md`).
