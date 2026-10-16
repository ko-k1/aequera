# Linux

Everything Aequera development needs that is true of Linux only, NixOS
included. The flow every OS shares (patch apply, build, run, edit loop,
tests) is [`tools/build/README.md`](../README.md); this page is what changes
on top of it.

## Setup

1. Install the distribution's Firefox build dependencies plus clang; the
   official guide is authoritative:
   `https://firefox-source-docs.mozilla.org/setup/linux_build.html`
   (see also [`tools/bootstrap/linux.md`](../../bootstrap/linux.md)).
2. In `worktree/firefox`:

   ```sh
   export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"
   ./mach bootstrap --application-choice browser_artifact_mode
   ```

On NixOS, `mach bootstrap` refuses the distro: see [NixOS](#nixos).

## Run

The shared launchers work as they are: `aequera-run.sh` for the dev loop,
`tools/build/aequera.sh` for the real profile (`~/.aequera`).

## Compiled build

Parallelism stays on mach's default (`mozconfig` here); set
`MOZ_MAKE_FLAGS="-j<N>"` if the link OOMs. A compiled build is the `aequera`
binary with the hicolor icons and `.desktop` entry.

NixOS (2026-10-14, NixOS 26.11, 16 cores: first build 29 min). `mach
bootstrap` refuses the distro, so use Mozilla's own toolchains, run under
`steam-run` like everything else here (`nixos/env.sh`):

- add `ac_add_options --enable-bootstrap` to a local mozconfig that sources
  `mozconfig.compiled`: on the release channel configure does not bootstrap by
  default, and with it fetches clang, cbindgen, nasm, node, and the Debian
  sysroot (so no NixOS headers or libraries are involved);
- bootstrap does not fetch Rust: from `~/.mozbuild`, run
  `<worktree>/mach artifact toolchain --from-build linux64-rust-1.95` (the
  rustc this tree's CI uses) and put `~/.mozbuild/rustc/bin` first on `PATH`
  in the shell that runs mach;
- set `TMPDIR` to a short path under `/home` when the checkout path is long
  (Python's forkserver socket path overflows `AF_UNIX`).

## NixOS

Mozilla's prebuilt binaries need an FHS system, so on NixOS run the shared
scripts through the wrappers in `nixos/`. They take the same arguments, work
from any directory, and honor `AEQUERA_WORKTREE`:

```sh
bash tools/build/linux/nixos/test-shell.sh [aequera|upstream|all] [--repeat N]
bash tools/build/linux/nixos/aequera-run.sh [--persistent]
```

They run inside `steam-run` and keep temp files, the fontconfig cache, and
crash dumps under `.tmp/nixos/`, because the shared `~/.cache/fontconfig`
crashes the browser at startup (`nixos/env.sh` has the details). The local
benchmark has its own wrapper, `tools/benchmark/browser-bench-nixos.sh`.

## Where Linux lives in the repo

| What | Path |
|---|---|
| Toolchain guide | `tools/bootstrap/linux.md` |
| Build hooks, mach tuning | `tools/build/linux/platform.sh`, `tools/build/linux/mozconfig` |
| NixOS wrappers | `tools/build/linux/nixos/`, `tools/benchmark/browser-bench-nixos.sh` |
| Firefox patches | `patches/toolkit/linux/linux-desktop` (D-Bus, search provider, portal and MPRIS identity), `patches/gecko/linux/background-blur` (Wayland blur, compiled builds only) |
| Branding assets | `aequera/design/branding/linux/` (desktop entry, D-Bus service, search provider), `default*.png` |
| Shell runtime | `aequera/shell/firefox/platform/linux/`: frame material over the compositor's blur, drag panel (no mid-drag image swap), Tor over a Unix socket |
| Shell tests | `browser_aequera_material_linux.js`, `browser_aequera_tor.js` |
| PR CI | `tools/ci/smoke.sh` |
