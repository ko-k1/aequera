# Bootstrap

This directory documents how to prepare a machine for Aequera development on
each supported OS. Follow the guide for your platform, then verify with the CLI.

```text
install OS prerequisites (this directory)
        ↓
aequera doctor          # must pass; warns where optional pieces are missing
        ↓
aequera upstream fetch  # acquire pinned Firefox objects; changes no baseline
        ↓
aequera upstream checkout  # materialize the locked baseline (next slice)
        ↓
patch application          # W3: generate worktree/firefox/
```

Per-platform guides:

- `windows.md` — Windows 10/11 (primary development host for this phase)
- `linux.md` — Debian/Ubuntu, Fedora, Arch families
- `macos.md` — Apple Silicon and Intel Macs

## Rules that apply on every OS

1. **Follow the official Firefox source setup as the underlying authority.**
   These guides wire Mozilla's prerequisites into the Aequera workflow; they do
   not replace them. Canonical reference:
   `https://firefox-source-docs.mozilla.org/setup/`
2. **Never build inside `upstream/firefox/`.** It is the clean managed
   checkout. Builds happen in the generated `worktree/firefox/` tree (W3).
3. **Expect weight.** A Firefox checkout plus build tree needs tens of GB of
   free disk and a multi-hour first build on typical hardware. If that is
   unacceptable, wait for artifact-build profiles (see `UPSTREAM.md`,
   "Development Builds") instead of starving a laptop.
4. **Network activity is limited to toolchain installs and the pinned fetch.**
   `aequera upstream fetch` downloads Git objects only; it never moves the
   baseline, never applies patches, never phones anywhere else.
5. **Rust is required regardless of OS.** The `aequera` CLI itself is Rust
   (install via `https://rustup.rs`), and Firefox's build needs a working
   Rust toolchain of a recent vintage — Mozilla's docs state the minimum.

## Verify

```bash
aequera doctor
```

`doctor` must report no `fail` entries. `warn` entries for the compiler or the
absent checkout are expected until the corresponding step is done; each names
the guide that resolves it.
