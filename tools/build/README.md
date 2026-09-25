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

Always run through `aequera-run.sh`, not bare `./mach run` or the exe: an
artifact build's `firefox.exe` otherwise identifies as Firefox (vendor,
name, remoting channel, profile registry) and collides with a Firefox you
have open. The script writes `aequera-application.ini` from the build's own
(`aequera_app_ini.py`: Vendor/Name Aequera, remoting `aequera`, profiles in
`%APPDATA%\Aequera`; the Firefox application ID stays for WebExtension
compatibility) and starts with `-app` + `-no-remote`. The exe keeps
Firefox's icon and file name until a full branding build.

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
