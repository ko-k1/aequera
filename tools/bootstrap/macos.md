# Bootstrap — macOS

Target: Apple Silicon (preferred) and Intel Macs, on a macOS release
supported by Mozilla's current build documentation.

## 1. Xcode command line tools

```bash
xcode-select --install
```

The official guide is authoritative for the rest:

- `https://firefox-source-docs.mozilla.org/setup/macos_build.html`

## 2. Homebrew packages

Mozilla's macOS guide lists the required Homebrew formulae (additional
tooling the build shells out to). Install exactly what the guide names for
the Firefox version pinned in `upstream/manifests/firefox.lock`.

## 3. Rust

Install via `https://rustup.rs` (rustup, stable channel). Verify:

```bash
rustc --version
cargo --version
```

## 4. Verify with Aequera

```bash
aequera doctor
```

A `warn` on the compiler probe means no `cc` was found on `PATH` — revisit
steps 1–2. Then:

```bash
aequera upstream fetch
```

## Notes

- On Apple Silicon, ensure no x86_64-only Homebrew prefix leaks into the
  build environment; keep to the native `/opt/homebrew` prefix.
- macOS SDK drift is the usual cause of mysterious build failures after an
  OS upgrade — re-read the official guide before blaming the lock.
