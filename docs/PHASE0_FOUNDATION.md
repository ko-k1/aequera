# Phase 0 — Foundation

Goal: make the project reproducible before making it large.

This document is the executable breakdown of the Phase 0 roadmap stage
(see `docs/ROADMAP.md`). It does not replace `VISION.md`, `RESTRICTIONS.md`,
`ARCHITECTURE.md`, or `SOURCE_LAYOUT.md` — where this plan conflicts with
those documents, the authority order in `AGENTS.md` applies, and the conflict
must be resolved explicitly rather than by silent drift.

Current stage: architecture and foundation. No implementation exists yet
(single commit, documentation skeleton only). Phase 0 must therefore make the
vision's hardest constraint — a reproducible upstream boundary plus auditable
privacy plus measurable responsiveness — testable before any shell feature
exists.

## Locked Decisions

| Decision | Resolution |
|---|---|
| Product baseline channel | Firefox Release |
| Upstream preview track | mozilla-central (`preview-mc`) |
| Long-term LTS target | Firefox ESR (`lts-esr`, future) |
| CLI implementation language | Rust |
| Bootstrap platform scope | Windows + Linux + macOS from day one |
| Upstream source model | `docs/engineering/UPSTREAM.md`: clean `upstream/firefox` tree plus machine-readable `firefox.lock`; fetched and pinned by tooling, never vendored into git, never hand-edited |

Phase 0 fetches and builds the Release track only. The `preview-mc` and
`lts-esr` tracks exist in Phase 0 as schema fields and pin policy (preview
cadence, LTS promotion rule), not as active build trees. This keeps the
triple-track intent without tripling Phase 0 cost.

## Exit Criteria

Phase 0 exits when the Foundation Gate (`docs/QUALITY_GATES.md`) holds:

- pinned upstream revision is reproducible on all three supported OSes;
- build environment is documented and machine-checkable;
- patch application is deterministic;
- generated worktree is provably disposable;
- no hidden network behavior was introduced.

A phase is complete when its architectural property is stable and testable,
not when every listed item merely exists (`docs/ROADMAP.md`).

## Workstream 0 — Triple-Track Pin Policy and Lockfile Schema

Define the pin before fetching anything.

- Define `upstream/manifests/firefox.lock` schema. Minimum fields per track:
  `track`, `revision`, `channel/version`, `pin date`, `patchset id/version`,
  `build metadata`, `config schema version`.
- Record the triple-track policy: Release is the product baseline,
  mozilla-central is the upstream preview (rebase early-warning), ESR is the
  future LTS target with a documented promotion rule.
- Resolve the `.gitmodules` placeholder: no engine submodule; the lockfile is
  the pin and the fetch tool produces the clean tree. Reversing this later
  requires an ADR, not a silent change.

Acceptance: the lockfile parses; `aequera upstream status` prints the active
track and revision; switching tracks is an explicit, logged mutation.

## Workstream 1 — Rust CLI Skeleton

One `aequera` binary implementing the intent-oriented command groups from
`docs/engineering/CLI.md`:

```text
aequera doctor
aequera upstream {fetch,status,update,checkout}
aequera patch {status,check,apply,rebase,export}
aequera config {validate,migrate}
aequera build | test | bench
aequera release check
```

Expected properties:

- deterministic and scriptable;
- `--json` machine-readable output for agent consumption;
- read-only commands safe to re-run;
- mutating commands (pin updates, history rewrites, worktree deletion)
  explicit and guarded.

The CLI orchestrates the Firefox ecosystem (git, mozbuild's Python tooling,
build system) through thin subprocess boundaries. It must not reimplement
mozbuild. Suggested home: `tools/cli/` as a Rust crate.

Acceptance: the full Phase 0 loop (fetch, pin, patch, validate, build, test,
bench, release check) is drivable through the CLI alone, and `status` reports
upstream revision, patchset state, config schema version, and worktree state.

## Workstream 2 — Three-OS Bootstrap and Doctor

- `tools/bootstrap/`: one documented path per OS — Windows (Visual Studio,
  mozbuild, Rust), Linux (distribution dependencies), macOS (Xcode command
  line tools). No second build system is invented.
- `aequera doctor` verifies every prerequisite and emits actionable
  diagnostics on failure, including `--json` for agents.

Acceptance: a clean machine on each OS reaches a clean Release baseline build
by following exactly one documented path, and `doctor` passes there.

## Workstream 3 — Patch Infrastructure (Working, Initially Empty)

Implement the Git-native ordered patch series from `docs/engineering/PATCHING.md`
and ADR 0002:

```text
patches/
├── browser/     # browser UI / behavior hooks
├── toolkit/     # shared browser UI/toolkit changes
├── gecko/       # engine/platform behavior; exceptional, requires rationale
└── build/       # Firefox build/release integration
```

- Per-series manifest recording `id`, `series`, `version`, `base revision`,
  `depends_on`, `affects`, `validation`, `risk`.
- One logical concern per commit; Git order authoritative; no monolithic
  `Aequera.patch`.
- CLI application flow: read `firefox.lock` → prepare clean source → verify
  base compatibility → apply ordered series → apply configs → generate
  `worktree/firefox/` → validate source state.
- Ship with an empty series plus one trivial smoke patch that proves
  determinism end to end.
- `worktree/firefox/` remains git-ignored and disposable; the CLI warns on
  undocumented manual edits there. Useful changes found in the worktree must be
  promoted into source, config, or patch history.

Acceptance: applying the series twice yields an identical tree; the rebase flow
(old upstream → series → new upstream → incremental conflict resolution with
focused tests) is documented and dry-runnable; `gecko/` entries are rejected
without explicit justification.

## Workstream 4 — Branding and Profile Separation (Minimal)

The smallest viable divergence from Firefox:

- Distinct application identity and a dedicated profile directory so Aequera
  never collides with an installed Firefox's data.
- Classification per `docs/SOURCE_LAYOUT.md`: prefer `configs/` wherever a
  supported Firefox mechanism suffices; otherwise one narrow `patches/build`
  entry with full patch hygiene (rationale, minimal scope, tests, conflict
  surface).

Acceptance: an Aequera-derived build runs side by side with stable Firefox,
each using its own profile; no user data is shared or migrated silently.

## Workstream 5 — Baseline Privacy Configuration v1

- `configs/defaults/` plus versioned `configs/schemas/` (schema v1):
  telemetry off, advertising/sponsored surfaces off, no silent remote
  configuration, local-first settings and profiles.
- `aequera config validate` and `config migrate` enforce the failure model from
  `docs/design/CUSTOMIZATION.md`: reject the invalid value, keep the previous
  valid value, emit a local actionable diagnostic, allow reset and safe-mode
  recovery. A configuration problem must never produce a half-applied shell.
- Import/export round-trips deterministically.

Acceptance: a network audit shows no new calls versus the clean baseline;
invalid-configuration recovery is covered by test; schema v1 validates and
migrates explicitly.

## Workstream 6 — CI Smoke and Test Skeleton

Per `docs/engineering/TESTING.md`, lowest layers first:

- `tools/ci/` checks: lockfile validity, patch-apply determinism, config
  validation, Rust unit tests, `doctor --json` contract.
- First tests: lockfile parsing, patch ordering and dependencies, config
  validation and recovery, CLI status contract.
- Full Firefox builds are reserved for a nightly pipeline. PR CI must prove
  reproducibility without a multi-hour build on every change.

Acceptance: green PR pipeline on Windows, Linux, and macOS runners for
everything except the nightly full build.

## Workstream 7 — Local Performance Baseline Harness

Per `docs/engineering/PERFORMANCE.md`:

- `tools/benchmark/` covers startup phases, input-to-feedback scaffolding,
  and idle CPU/memory snapshots. All instrumentation is local; no remote
  telemetry is introduced for project measurement.
- Record the first clean-Release numbers with hardware notes as reference
  baselines. Targets (≤ 16 ms input-to-feedback, 60 FPS baseline, near-zero
  idle CPU) are measured engineering goals, not marketing claims.

Acceptance: `aequera bench` runs repeatably and stores a baseline artifact
that later changes can regress against.

## Workstream 8 — Documentation Closure

- Update the environment guide, pin policy, patch lifecycle, and manifest
  recording in `docs/engineering/*` to match what was actually built.
- Record an ADR only where a long-lived assumption changed (for example, any
  reversal of the no-submodule decision from Workstream 0).
- Update `agent/` context if the CLI surface changes the agent workflow.

Acceptance: a new contributor (human or agent) can reproduce the baseline,
apply the patchset, validate configuration, and cut a manifest-recorded
candidate using only the CLI and the docs.

## Execution Order

```text
0 (pin schema + policy)
  ↓
1 (CLI skeleton) + 2 (bootstrap) in parallel
  ↓
3 (patch pipeline on Release)
  ↓
4 (branding) + 5 (privacy configs) in parallel
  ↓
6 (CI) + 7 (perf baseline) in parallel
  ↓
8 (docs / manifest closure)
```

## Working Rules for Every Slice

From `agent/TASK_WORKFLOW.md`, applied to each workstream without exception:

1. Classify the change first: config → first-party extension → Aequera
   source → Firefox patch → Gecko patch (exceptional). Choose the
   highest-level mechanism that satisfies the requirement.
2. Land small, tested, reviewable units. No unrelated cleanup inside
   feature work.
3. Inspect the boundary before finalizing: did Aequera source stay separate
   from Firefox source? Any undocumented API or config value? Any new
   privilege or network behavior? Could a higher-level mechanism have
   avoided a patch?
4. A feature is not complete because it builds — behavior, performance,
   accessibility, compatibility, and recovery count as appropriate.

## Risks

- Full Firefox builds on three OSes are heavy. Mitigation: nightly-only full
  builds; fast determinism and validation checks on every PR.
- A Rust CLI orchestrating mozbuild's Python world can easily accrete
  reimplementations. Mitigation: subprocess boundaries, no mozbuild clones.
- Triple-track policy is cheap to write and expensive to build. Mitigation:
  Phase 0 builds Release only; preview and LTS tracks are schema plus policy
  until a later phase activates them.
- Rich materials and motion threaten the responsiveness invariant from day
  one. Mitigation: Phase 0 measures the clean baseline first, so later visual
  work has something concrete to regress against.
