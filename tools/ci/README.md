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
   - `aequera config validate` (defaults green)

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
Those belong to the nightly full-build pipeline, which does not exist yet —
defining it is W6-follow-up work once a first real baseline has been fetched
and timed, not speculative YAML written blind.

## Test layers (docs/engineering/TESTING.md mapping)

| Layer | Current home |
|---|---|
| unit | `cargo test` (Rust workspace); `node --test` (JS models in `aequera/`); `unittest` (`tests/unit/build`) |
| integration | binary surface checks in `smoke.*` |
| UI / accessibility | future (needs a built browser) |
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
