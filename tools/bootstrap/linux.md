# Bootstrap — Linux

Target: 64-bit Debian/Ubuntu, Fedora, or Arch-family distributions.

## 1. System packages

Install the distribution's Firefox build dependencies plus clang. The exact
package list moves with Mozilla's requirements, so the official guide is
authoritative:

- `https://firefox-source-docs.mozilla.org/setup/linux_build.html`

In general this means: a C/C++ toolchain, clang, common X11/Wayland/GTK
development headers, and supporting utilities (exact names in the link above).

## 2. Rust

Install via `https://rustup.rs` (rustup, stable channel). Do not rely on the
distro's Rust package unless it meets Mozilla's stated minimum. Verify:

```bash
rustc --version
cargo --version
```

## 3. Git

Any recent distribution Git. Verify with `git --version`.

## 4. Verify with Aequera

```bash
aequera doctor
```

A `warn` on the compiler probe means no `cc` was found on `PATH` — revisit
step 1. Then:

```bash
aequera upstream fetch
```

## 5. Build and run (needs the generated worktree)

```bash
aequera patch apply
cd worktree/firefox
export MOZCONFIG="$PWD/../../tools/build/mozconfig.artifact"   # repo-relative; $PWD is worktree/firefox
./mach bootstrap   # choose "Firefox for Desktop Artifact Mode"
./mach build
bash tools/build/aequera-run.sh               # throwaway dev profile
bash tools/build/aequera-run.sh --persistent  # real profile in ~/.aequera
```

(`tools/build/...` is relative to the checkout root.) Outside a terminal,
start the real profile with `tools/build/aequera.sh`. Run the shell tests
with `bash tools/build/test-shell.sh` from `worktree/firefox`. Full flow and
per-OS notes: `tools/build/README.md`. For a compiled build (hours, full
Aequera binary identity), switch `MOZCONFIG` to `mozconfig.compiled` and run
`./mach bootstrap --application-choice browser` once.

## Notes

- Case-sensitive filesystem is assumed; do not place the checkout on a
  case-insensitive mount.
- Headless servers are fine for fetch/patch/CI work; a display (or virtual
  framebuffer) only matters when running the built browser.
