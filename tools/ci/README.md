# CI and Smoke Checks

## What PR CI proves

`./.github/workflows/ci.yml` runs `smoke.ps1` (Windows) or `smoke.sh`
(Linux/macOS) on every push and pull request:

1. `cargo fmt --check` — formatting gate.
2. `cargo clippy --all-targets -- -D warnings` — zero-warning lint gate.
3. `cargo test` — unit layer (`tools/cli` fixture suites: upstream
   acquisition, patch pipeline, config validation/recovery).
4. `node --test` — the pure JS models (tab-rail drag, workspaces, command
   surface, Ad Veil, palette): every tracked `aequera/**/*.test.{js,mjs}`,
   node's built-in runner, no npm packages. No test files found is a
   failure, not a pass. Node 24 (`actions/setup-node`). Then
   `python -m unittest discover -s tests/unit/build`: the build tooling
   (`tools/build/windows/dist_copies.py`, and every OS's `platform.sh`
   hooks through bash on every runner), stdlib only. Then
   `tests/security/tor/scripts.test.sh`: the tor bundle scripts' pin and
   signature checks, offline (smoke.sh: Linux and macOS, where Tor windows
   exist).
5. Built-binary surface checks, all offline-safe:
   - `aequera doctor` (no `fail` entries)
   - `aequera upstream status` (lock readable)
   - `aequera patch status` (manifest valid, base matches lock)
   - `aequera config validate` (defaults green, and every pref
     `privacy.toml` maps to ships false in `aequera-prefs.js`)

A second job, `engine`, rebuilds `aequera/extensions/ad-veil/addon/engine.wasm`
on x86_64 Linux with the toolchain that produced it (rustup's Rust 1.98.1 and
the `wasm32-unknown-unknown` target) and fails when the committed binary
differs from its source (`build-engine.sh --check`). The build is repeatable
per host architecture only, so x86_64 Linux is the reference: on a mismatch
the job uploads its build as the `engine-wasm-ci` artifact, which is the
file to commit after an engine change. Bump the pin together with a rebuilt
`engine.wasm`.

Deliberately excluded from PR CI: `fetch`, `checkout`, `bootstrap`, `apply`
against the real Firefox remote (gigabytes of objects, tens of minutes).
Those belong to the nightly pipeline below.

## Nightly

`./.github/workflows/nightly.yml` runs daily (03:17 UTC) and on demand
(`gh workflow run nightly.yml --ref <branch>`, any branch that has the
file), on Linux x86_64:

1. `aequera bootstrap`: the lock's Firefox tag from the pinned remote,
   checked against the locked commit;
2. `aequera patch check`, then `aequera patch apply`: every series against
   the real base, overlays synced;
3. `mach bootstrap` (artifact mode) and `./mach build`: the artifact build
   (`tools/build/mozconfig.artifact`);
4. `tools/tor/fetch-bundle.sh`: the pinned tor, for the Tor windows' tests;
5. `tools/build/test-shell.sh aequera`, then `upstream`: Aequera's browser
   tests, then Firefox's own tests of the patched areas with Firefox's
   defaults. A PulseAudio null sink gives the runner an audio device (tab
   audio tests wait for sound otherwise).

Measured on its first runs (2026-10-20): 20 to 23 minutes end to end.
Dispatch it on a branch to prove a patch or shell change against real
Firefox before merging; it is not a PR gate.

## macOS packaging

`./.github/workflows/macos.yml` builds and packages a runnable app on both
macOS architectures. It runs weekly (Mondays 04:43 UTC) and on demand
(`gh workflow run macos.yml --ref <branch>`). It is deliberately not a PR
gate: every run fetches the pinned Firefox and performs an artifact build.

Both matrix entries use macOS 15 so they share one SDK/Xcode:
`macos-15` (arm64) and `macos-15-intel` (x86_64). Each job:

1. removes simulator runtimes and unused Xcode copies so Firefox's history
   and worktree fit the runner;
2. builds the CLI, then compiles `Assets.car` with `actool` (the `.car` is
   generated on Apple hosts and is not committed);
3. bootstraps the locked Firefox, checks and applies the patch series;
4. runs `mach bootstrap` (artifact mode), `./mach build`, and
   `./mach package`;
5. runs `tools/build/macos/package.sh`, which requires the packaged
   `dist/firefox/Aequera.app` (omni.jars present, developer plist paths
   absent), wraps it with Aequera's `-app` launcher, materializes build-tree
   symlinks, re-signs nested apps/frameworks, ad-hoc signs the result,
   smoke-tests a headless content-process screenshot, and writes a DMG, a
   zip, and `SHA256SUMS`;
6. uploads `aequera-macos-aarch64` or `aequera-macos-x86_64` (90-day
   workflow artifact).

On Intel, bootstrap runs with `--no-system-changes`: Homebrew stopped
building Intel bottles (Tier 3), and artifact mode needs none of the
watchman/mercurial/terminal-notifier packages the full path installs.

The first dual-architecture run (39768190809, 2026-10-22) completed both
jobs. Each job built and packaged the artifact app, passed
`codesign --verify --deep --strict`, and reported `Aequera Aequera 158.0`
from a `--version` smoke test. That test was insufficient: it never started
a content process, so it did not catch that the distributed developer bundle
lacked `omni.ja` and retained the runner's developer paths. The app then
crashed on the first content-process launch with
`MOZ_CRASH("Failed to get path to repo dir")` in
`ContentParent::BeginSubprocessLaunch`. The workflow now runs `./mach package`
and the packager starts a headless content process; a green dual-architecture
run of that gate is still pending. No interactive browser or mochitest run is
part of this workflow yet.

The artifacts are not Developer ID signed or notarized: they are build/test
artifacts, not release installers. Developer ID signing, notarization, and
attaching files to a GitHub release remain release-pipeline work. A compiled
build can use the same packager but is expected to exceed a hosted macOS
runner budget; the workflow therefore builds artifact mode only.

## Test layers (docs/engineering/TESTING.md mapping)

| Layer | Current home |
|---|---|
| unit | `cargo test` (Rust workspace); `node --test` (JS models in `aequera/`); `unittest` (`tests/unit/build`) |
| integration | binary surface checks in `smoke.*` |
| UI / accessibility | browser tests in the nightly (`test-shell.sh`) |
| extension compatibility | future (needs a built browser) |
| security | config-policy tests + recovery tests (partial) |
| performance | `aequera bench` (W7) |
| upstream regression | patch-manifest + lock fixtures (partial) |

## Run locally

Needs `cargo` and `node` (any current LTS) on `PATH`.

Windows:

```powershell
tools/ci/smoke.ps1
```

Linux/macOS:

```bash
tools/ci/smoke.sh
```
