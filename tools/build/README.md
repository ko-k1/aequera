# Build — run Aequera on real Firefox

Stage 1 shell work is front-end only (CSS, window JS, prefs), so the default
is an **artifact build**: Mozilla's prebuilt compiled parts for the pinned
revision plus a local front-end build. Minutes, not hours; no local C++/Rust
bulk build.

## One-time setup

Generate the worktree first, in any shell, from the repository root:

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
or run it with extra Firefox arguments. It is `--persistent` without the
shell.

Always start through one of these, never bare `./mach run` or the binary.
Both launchers prefer the compiled build (`obj-aequera/dist/bin/aequera`,
own file name and embedded Aequera icon) and fall back to the artifact
build (`firefox` binary, Mozilla's prebuilt). Both also export
`MOZ_DEVELOPER_REPO_DIR` (and `MOZ_DEVELOPER_OBJ_DIR`), like `mach run`
does: local builds symlink front-end files into `dist`, and the
content-process sandbox only resolves those links when the repo dir is
advertised (upstream bug 1916286). Without it DevTools cannot open
(`Ctrl+Shift+I`, `F12`, … fail with `builtin-modules.js is not found`).
The build is branded Aequera (`mozconfig.branding` +
`patches/build/branding`: name, logo, vendor, own profile root,
remoting `aequera`, no updater or crash upload), and its
`application.ini` says so; but an artifact build's `firefox` binary is
Mozilla's prebuilt, which ignores that file and uses the Firefox identity
compiled into it, opening your Firefox profile and colliding with a
Firefox you have open. Both launchers copy the ini to
`browser/aequera-application.ini` (`aequera_app_ini.py` refuses one without
the Aequera identity) and start with `-app`, `-no-remote`, and
`-purgecaches`.

## Compiled build (full C++/Rust; Aequera binary and icons end to end)

```sh
export MOZCONFIG="$PWD/../../tools/build/mozconfig.compiled"
./mach bootstrap --application-choice browser   # once: platform toolchain
./mach build
```

`mozconfig.compiled` is `mozconfig.artifact` minus artifact mode and the
`--with-app-name=firefox` pin, plus `--disable-updater
--disable-crashreporter`, in its own `obj-aequera` dir so both builds
coexist. First build is hours; later ones are incremental. Notes:

- Parallelism defaults to `-j1` (see the mozconfig): the project's first
  compiled build shared its box with resident ML training jobs, where even
  `-j4` OOMed giant unified TUs and the `gkrust` LTO link. Any other host
  should raise it: `export AEQUERA_MAKE_FLAGS="-j$(nproc)"`.
- Rust: the tree needs >= 1.90.0, but newer rustc can crash on the
  `gkrust` LTO link (stable hit `0xc0000409` on Windows); 1.95.0 is
  known-good. Point `RUSTC`/`CARGO` at it in the build shell
  (configure-time setting, so re-run `./mach configure` after changing it).

## Edit loop

1. Edit Aequera source in `aequera/shell/firefox/` (never in the worktree:
   the overlay copy is replaced on every apply).
2. `aequera patch apply` — re-syncs the overlay; patches stay verified.
3. `./mach build faster && bash ../../tools/build/aequera-run.sh`
   (`build faster` repackages front-end files only; seconds).

## Tests

```sh
bash ../../tools/build/test-shell.sh            # all
bash ../../tools/build/test-shell.sh aequera --repeat 4
```

- `aequera`: Aequera-owned mochitests (`aequera/shell/firefox/tests`),
  under Aequera defaults.
- `upstream`: Firefox's own sidebar tests with Firefox's defaults restored
  (`--setpref`), proving the `sidebar-motion` patches change nothing by
  default. Firefox's tests assume Firefox's defaults: run without the
  resets, `browser_sidebar_expand_on_hover.js` fails its first assertion
  because Aequera ships expand-on-hover on.

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
install the platform toolchain (`tools/bootstrap/<os>.md`).

## Known platform gaps

- Linux D-Bus identity still claims `org.mozilla.*`: the bus/object-path
  namespace is hardcoded upstream in `widget/gtk/DBusService.cpp`
  (`DBUS_BUS_NAME_TEMPLATE`, `DBUS_OBJECT_PATH_TEMPLATE`) and
  `toolkit/components/remote/nsDBusRemote{Client,Server}.cpp`, and the
  xdg-portal app id in `widget/gtk/WidgetUtilsGtk.cpp` (`DoRegisterHostApp`)
  is the literal `org.mozilla.firefox`. Renaming needs narrow Gecko-level
  patches plus session-bus testing — follow-up work, not part of the build.
- No installer is built yet (Windows `msix/`, macOS dmg polish beyond the
  committed `background.png`/`disk.icns`).
