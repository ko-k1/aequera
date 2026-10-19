# Contributing to Aequera

Aequera is a Firefox/Gecko-based browser whose distinguishing layer is the
browser shell: workflow, responsiveness, design system, privacy, and deep
customization. Contributions are welcome — code, tests, design, docs,
performance measurements, and bug reports alike.

This file is the entry point. It summarizes the rules that apply to every
change; the linked documents are authoritative, in the order given by
`AGENTS.md`.

## Read before you write

1. `docs/README.md` — documentation index. Start with `docs/VISION.md`,
   `docs/PRODUCT.md`, `docs/FEATURES.md`, `docs/RESTRICTIONS.md`.
2. `docs/WORKFLOW.md` — development, build, upstream, patch, and release
   flows.
3. `docs/ARCHITECTURE.md` and `docs/SOURCE_LAYOUT.md` — the layer model and
   where a change belongs.
4. The engineering document for the area you touch: `DEVELOPMENT.md`,
   `CLI.md`, `UPSTREAM1.md`/`UPSTREAM2.md`, `PATCHING.md`, `TESTING.md`,
   `PERFORMANCE.md`, `SECURITY.md`, `COMPATIBILITY.md`.
5. `docs/QUALITY_GATES.md` and the completion checklist in `AGENTS.md`.

When documents conflict, the authority order in `AGENTS.md` decides. A local
task must not silently weaken a higher-level invariant.

## Non-negotiable invariants

From `AGENTS.md` and `docs/RESTRICTIONS.md`:

- no telemetry, analytics, advertising, sponsored UI, or hidden network
  calls;
- no mandatory online account for normal browsing;
- Firefox security and extension privilege boundaries are preserved;
- Firefox WebExtension compatibility is preserved unless an ADR explicitly
  changes the target;
- prefer Aequera-owned source; Firefox source is a pinned upstream input
  that changes only through explicit, reviewable patches;
- browser chrome stays responsive under heavy web-content workloads;
- configuration failures recover to a known-good state.

## Report a bug or propose a feature

For a non-trivial change, capture (`agent/IMPLEMENTATION_RULES.md`):

- the user problem and the target workflow;
- the current pain point;
- the proposed default behavior and customization surface;
- performance, accessibility, and security/privacy impact;
- upstream maintenance impact;
- a measurable acceptance criterion.

A feature does not belong in the product merely because another browser has
it (`docs/RESTRICTIONS.md`; `docs/PRODUCT.md`, Feature Quality Rule).

## Classify the change first

Before touching any source, walk the ladder and stop at the highest viable
level (`docs/WORKFLOW.md`, `docs/FEATURES.md`):

```text
config → first-party extension → Aequera source → Firefox patch → Gecko patch
```

| Mechanism | Use when |
|---|---|
| `configs/` | Firefox already supports the behavior through preferences/policies/default configuration |
| `aequera/extensions/` | the behavior fits a first-party WebExtension/built-in extension |
| `aequera/` | it is Aequera product logic, shell workflow, UI, state, or customization |
| `patches/browser` | Firefox browser-level hooks/behavior must change |
| `patches/toolkit` | shared UI/platform toolkit behavior must change |
| `patches/gecko` | Gecko engine behavior itself must change; exceptional, needs explicit rationale |
| `patches/build` | build/release integration requires upstream source changes |

## Development setup

- One documented path per OS: `tools/bootstrap/windows.md`,
  `tools/bootstrap/linux.md`, `tools/bootstrap/macos.md`.
- `aequera doctor` verifies prerequisites and reports actionable
  diagnostics; fix what it reports before building.
- The CLI is intent-oriented (`docs/engineering/CLI.md`). Use it instead of
  reproducing Git/patch mechanics by hand: `aequera upstream …`,
  `aequera patch …`, `aequera config …`, `aequera build | test | bench`,
  `aequera release check`. Machine-readable output (`--json`) is the agent
  and CI contract.

## Branches and commits

- Prefer short-lived branches and small commits
  (`docs/engineering/DEVELOPMENT.md`).
- Commit messages follow the repository's `type(scope): summary` style
  (`feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`).
- For upstream-facing work, the commit sequence is the patch series: one
  logical concern per commit, because Git order is authoritative
  (`docs/engineering/PATCHING.md`).

## Firefox patches

- A patch exists only because a Firefox source boundary must change; it is
  never a transport for ordinary Aequera code (`docs/SOURCE_LAYOUT.md`).
- `upstream/firefox/` is clean and pinned; `worktree/firefox/` is generated
  and disposable. Never make undocumented fixes in either — promote useful
  changes into Aequera source, `configs/`, or patch history.
- Follow `patches/manifest.yaml` and `docs/engineering/PATCHING.md`:
  descriptive ordered series, per-series manifest metadata (`id`, `series`,
  `version`, `base`, `depends_on`, `affects`, `validation`, `risk`), a
  `platform:` when every hunk serves one OS (series then live under
  `patches/<layer>/<os>/`).
- Rebase through the CLI (`aequera patch check --candidate`,
  `aequera patch rebase`, `aequera upstream adopt`), not by hand-editing
  history.

## Tests and checks before you submit

Run the smallest relevant tests first, then the checks for the change type
(`docs/engineering/DEVELOPMENT.md`, `docs/engineering/TESTING.md`):

- repository smoke, mirroring PR CI: `tools/ci/smoke.sh` (Linux/macOS) or
  `tools/ci/smoke.ps1` (Windows) — `cargo fmt`/`clippy`/`test`,
  `node --test` JS models, Python build-tooling tests, tor script checks,
  and the built binary's `doctor` / `upstream status` / `patch status` /
  `config validate` surfaces;
- UI changes: keyboard and pointer paths, focus visibility, reduced motion,
  density variants, scaling, startup/interaction sanity;
- configuration changes: schema validation, migrations, invalid-value
  recovery, safe defaults, import/export round-trip;
- shell/input performance: `aequera bench` against the recorded baseline
  (`docs/engineering/PERFORMANCE.md`);
- extension compatibility when browser-shell APIs are involved
  (`docs/engineering/COMPATIBILITY.md`);
- upstream updates: clean baseline build, patch application, browser-shell
  smoke tests, extension compatibility, security-sensitive behavior,
  performance, and patch conflict assumptions.

A change is not complete because it builds. Behavior, performance,
accessibility, compatibility, and recovery count (`AGENTS.md`).

## Documentation

Update documentation when architecture, behavior, or public configuration
changes. New public configuration values must be typed, documented, and
versioned with deterministic precedence, validation, migration, and recovery
(`docs/design/CUSTOMIZATION.md`). Long-lived architectural decisions are
recorded as ADRs in `docs/adr/`.

## Licensing

Aequera is licensed under the MIT License (`LICENSE`); contributions are
accepted under the same license. Only submit work you have the right to
license this way. Third-party code and data are pinned, attributed, and
updated deliberately (for example adblock-rust, EasyList/EasyPrivacy, and
the Tor expert bundle; `docs/adr/0003-aequera-owned-ad-veil.md`,
`docs/adr/0004-tor-windows.md`).

## Security

Do not report vulnerabilities in public issues. See `SECURITY.md`.
