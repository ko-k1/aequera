# Build — run Aequera on real Firefox

Stage 1 shell work is front-end only (CSS, window JS, prefs), so the default
is an **artifact build**: Mozilla's prebuilt compiled parts for the pinned
revision plus a local front-end build. Minutes, not hours; no host C++
toolchain beyond the bootstrap guides.

This README is the shared flow. Everything that differs per OS has its own
directory and README: [`windows/`](windows/README.md),
[`linux/`](linux/README.md), [`macos/`](macos/README.md).

## Layout

```text
tools/build/
├── README.md              # this file: the flow every OS shares
├── aequera-run.sh         # entry: dev loop launcher (any POSIX shell, every OS)
├── aequera.sh             # entry: real-profile launcher (Linux, macOS)
├── test-shell.sh          # entry: shell test gate (every OS)
├── mozconfig.artifact     # entry: MOZCONFIG for artifact builds
├── mozconfig.compiled     # entry: MOZCONFIG for compiled builds
├── mozconfig.branding     # shared fragment: product identity
├── mozconfig.platform     # shared fragment: sources <os>/mozconfig for the host
├── common/                # shared internals, no OS branches
│   ├── host.sh            #   host detection; loads <os>/platform.sh
│   ├── launch-common.sh   #   tree, objdir, binary, identity
│   ├── startup-cache.sh   #   when to pass -purgecaches
│   └── aequera_app_ini.py #   launch ini with the Aequera identity
├── windows/               # platform.sh, mozconfig, aequera.cmd, dist_copies.py
├── linux/                 # platform.sh, mozconfig, nixos/ (steam-run wrappers)
└── macos/                 # platform.sh, mozconfig
```

Rule: top-level files are what you run or export; `common/` is shared and
never asks which OS it runs on; each `<os>/` directory holds everything
that is true of one OS only. Shared scripts reach OS behavior only through
the hooks `common/host.sh` documents (binary names, bundle layout, launch
ini location, path conversion, dist fixes, test defaults). Every
`<os>/platform.sh` defines all of them, which
`tests/unit/build/test_platform_hooks.py` checks for all three OSes on every
CI runner. A new OS difference becomes a hook (or a line in an existing
one), never a `uname` branch in shared code. Mozconfig fragments are the
one exception: mach sources them with plain `sh`, so `mozconfig.platform`
picks `<os>/mozconfig` itself.

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
and branding). Then bootstrap mach as your OS's README says
([Windows](windows/README.md#setup), [Linux](linux/README.md#setup),
[macOS](macos/README.md#setup)).

## Build and run

```sh
cd worktree/firefox
./mach build
bash ../../tools/tor/fetch-bundle.sh                 # once per objdir: the tor for Tor windows
bash ../../tools/build/aequera-run.sh               # throwaway dev profile
bash ../../tools/build/aequera-run.sh --persistent  # real Aequera profile
```

`fetch-bundle.sh` puts the Tor Project's tor expert bundle (pinned,
signature-checked; `tools/tor/README.md`) into the build as `dist/bin/tor`.
`mach build` keeps it, and a clobber removes it. The launchers say when it
is missing.

Build output goes to `obj/<worktree>/artifact` (or `compiled`) at the repo
root, not inside `worktree/firefox`: recreating the worktree on a new
Firefox base keeps the objdir. Objdirs from before this layout
(`worktree/firefox/obj-aequera*`) are no longer used; delete them and
rebuild once.

To gate a Firefox update before adopting it, build and test the rebased
candidate (`aequera patch rebase`, docs/engineering/UPSTREAM1.md) the same
way from `worktree/candidate`; its objdir is `obj/candidate/…`. The
launchers and the NixOS wrappers take `AEQUERA_WORKTREE=candidate`
(default `firefox`); the test gate runs in the worktree it is started from:

```sh
cd worktree/candidate && ./mach build
bash ../../tools/build/test-shell.sh
AEQUERA_WORKTREE=candidate bash ../../tools/build/aequera-run.sh
```

`aequera-run.sh` works in any POSIX shell on all three platforms (it finds
the repo from its own location, so any checkout directory works). When
`MOZCONFIG` is unset it picks the mozconfig matching the objdir
(`obj/firefox/compiled` -> compiled, anything else -> artifact); `AEQUERA_BUILD`
(`compiled`|`artifact`) overrides that guess for custom objdirs. To start
the real Aequera profile without a build shell, use
`tools/build/aequera.sh` on Linux/macOS and `tools\build\windows\aequera.cmd`
on Windows (double-click, or run it with extra Firefox arguments). Either is
`--persistent` without the shell.

Always start through one of these, never bare `./mach run` or the binary.
All launchers prefer the compiled build (`obj/firefox/compiled`: native `aequera`
binary with its own file name and embedded Aequera icon, `Aequera.app` on
macOS) and fall back to the artifact build; which file names count is the
host's `platform.sh`. All also export `MOZ_DEVELOPER_REPO_DIR` (and
`MOZ_DEVELOPER_OBJ_DIR`), like `mach run` does: local builds symlink
front-end files into `dist`, and the Windows content-process sandbox only
resolves those links when the repo dir is advertised (upstream bug
1916286). Without it DevTools cannot open (`Ctrl+Shift+I`, `F12`, … fail
with `builtin-modules.js is not found`). Windows needs one more step before
every start, turning those links into copies:
[windows/README.md](windows/README.md#dist-copies).
The build is branded Aequera (`mozconfig.branding` +
`patches/build/branding`: name, logo, vendor, own profile root —
`%APPDATA%\Aequera` on Windows, `~/.aequera` on Linux,
`~/Library/Application Support/Aequera` on macOS — remoting `aequera`,
no updater or crash upload), and its `application.ini` says so; but an artifact
build's prebuilt binary is Mozilla's, which ignores that file and uses the
Firefox identity compiled into it, opening your Firefox profile and
colliding with a Firefox you have open. All launchers copy the ini to
`browser/aequera-application.ini` (`common/aequera_app_ini.py` refuses one without
the Aequera identity, and adds `UAName=Firefox` so the user agent is
Firefox's, not "Aequera/<version>") and start with `-app` and `-no-remote`.
The POSIX launchers add `-purgecaches` only when a file under the build's
`dist/bin` (following its links into the source tree) changed since the last
launch of the same profile (`common/startup-cache.sh`; stamps
`<objdir>/.aequera-launch-{dev,persistent}`): purging on every launch cost
about half a second of startup. `aequera.cmd` still purges every launch.

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
--disable-crashreporter`, in its own `obj/firefox/compiled` dir so both
builds coexist. Host tuning (parallelism, Rust notes) lives in
`<os>/mozconfig`, which `mozconfig.platform` sources for both. First build
is hours; later ones are incremental. Bring-up notes per OS:
[Windows](windows/README.md#compiled-build) (parallelism, Rust),
[Linux and NixOS](linux/README.md#compiled-build).


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

On NixOS, run the gate through its wrapper:
[linux/README.md](linux/README.md#nixos).

Headless servers are fine: the suite runs `--headless`, and the two
platform-drag tab tests skip themselves there (no drag service without a
display); they stay covered on headed runs.

## Stage 1 acceptance

- Tabs render in the vertical rail; hovering the rail widens it after
  ~40ms over 250ms.
- While widened, the rail is the same material as when collapsed (no
  second opaque panel, no divider), and the page's left edge clips back
  in step with the rail. The page itself does not reflow.
- Window fullscreen (F11) keeps the top bar and the rail; video
  (DOM) fullscreen hides them and shows the page unclipped.
- Browser Console (`Ctrl+Shift+J`) shows no `aequera-shell` errors.
- `about:config`: the prefs in `aequera-prefs.js` show as defaults.

## If artifact download fails

Artifacts exist only for revisions Mozilla's CI built. If `mach build`
cannot find artifacts for the pinned release revision, switch to a full
build: drop `--enable-artifact-builds` from a copy of the mozconfig and
install the host C++ toolchain (`tools/bootstrap/windows.md`,
`macos.md`, or `linux.md` for the OS).

## Known platform gaps

- No installer is built yet on any platform. Per-OS gaps are listed in each
  platform README.
