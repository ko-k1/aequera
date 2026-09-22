# AGENTS.md — Aequera Agent Instructions

## Mission

Build Aequera as a complete, responsive, human-centered, privacy-respecting, deeply customizable Firefox/Gecko browser without losing maintainability against upstream Firefox changes.

## Authority Order

When decisions conflict, use this order:

1. `docs/VISION.md`
2. `docs/RESTRICTIONS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/SOURCE_LAYOUT.md`
5. `docs/design/*`
6. `docs/engineering/*`
7. `docs/ROADMAP.md`
8. task-local requirements

A local task must not silently weaken a higher-level invariant.

## Non-Negotiable Invariants

- No telemetry, analytics, advertising, sponsored UI, or hidden network calls.
- No mandatory online account for normal browsing.
- Preserve Firefox security boundaries and extension privilege boundaries.
- Preserve Firefox WebExtension compatibility unless an explicit ADR changes the target.
- Prefer Aequera-owned source over modifying Firefox directly.
- Treat Firefox source as a pinned upstream input and patch it only through explicit, reviewable changes.
- Do not add a UI feature merely because another browser has it.
- Do not add a runtime/UI framework dependency without considering startup, memory, and input latency.
- Animation must not delay or block direct interaction.
- User input and async tasks must be interruptible or supersedable.
- Browser chrome must remain responsive under heavy web-content workloads.
- Configuration failures must recover to a known-good state.
- Security-sensitive defaults must not be weakenable through normal customization.

## Before Code Changes

1. Read the nearest relevant documentation.
2. Identify the owning layer.
3. Classify the change as one of: configuration, first-party extension, Aequera source, Firefox patch, or exceptional Gecko patch.
4. Check public API/configuration implications.
5. Define a measurable acceptance criterion.

## Implementation Rules

Prefer:

- semantic interfaces over direct internal access;
- small, reviewable units of change;
- explicit types and schemas;
- deterministic configuration resolution;
- compositor-friendly UI updates;
- cancellable asynchronous operations;
- local instrumentation over remote telemetry;
- upstream-friendly patches;
- reversible changes.

Avoid:

- scattered browser-internal calls from UI components;
- synchronous I/O on input-critical paths;
- giant feature patches;
- hard-coded styling that bypasses design tokens;
- undocumented configuration knobs;
- source changes that could have been implemented at a higher layer.

## Patch Rule

A patch should represent a logical change to the pinned Firefox source. Prefer a small ordered Git-native patch series over one monolithic patch.

A patch must answer:

- why Firefox source must change;
- what it changes;
- what it depends on;
- which tests validate it;
- whether upstream changes are likely to affect it.

## Completion Checklist

Before closing a task:

- run the smallest relevant tests;
- run lint/format/build checks where applicable;
- check UI performance for browser-shell changes;
- check reduced-motion/accessibility behavior;
- verify invalid configuration recovery;
- verify extension compatibility when browser-shell APIs are involved;
- update documentation if architecture, behavior, or public configuration changed.
