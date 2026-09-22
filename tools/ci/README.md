# CI and Smoke Checks

## What PR CI proves

`./.github/workflows/ci.yml` runs `smoke.ps1` (Windows) or `smoke.sh`
(Linux/macOS) on every push and pull request:

1. `cargo fmt --check` — formatting gate.
2. `cargo clippy --all-targets -- -D warnings` — zero-warning lint gate.
3. `cargo test` — unit layer (`tools/cli` fixture suites: upstream
   acquisition, patch pipeline, config validation/recovery).
4. Built-binary surface checks, all offline-safe:
   - `aequera doctor` (no `fail` entries)
   - `aequera upstream status` (lock readable)
   - `aequera patch status` (manifest valid, base matches lock)
   - `aequera config validate` (defaults green)

Deliberately excluded from PR CI: `fetch`, `checkout`, `bootstrap`, `apply`
against the real Firefox remote (gigabytes of objects, tens of minutes).
Those belong to the nightly full-build pipeline, which does not exist yet —
defining it is W6-follow-up work once a first real baseline has been fetched
and timed, not speculative YAML written blind.

## Test layers (docs/engineering/TESTING.md mapping)

| Layer | Current home |
|---|---|
| unit | `cargo test` in `tools/cli` |
| integration | binary surface checks in `smoke.*` |
| UI / accessibility | future (needs a built browser) |
| extension compatibility | future (needs a built browser) |
| security | config-policy tests + recovery tests (partial) |
| performance | `aequera bench` (W7) |
| upstream regression | patch-manifest + lock fixtures (partial) |

## Run locally

Windows:

```powershell
tools/ci/smoke.ps1
```

Linux/macOS:

```bash
tools/ci/smoke.sh
```
