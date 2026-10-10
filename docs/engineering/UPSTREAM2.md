# Firefox Upstream Synchronization

## Goal

Maintain a reproducible relationship with Firefox upstream so security fixes and platform improvements remain practical to integrate.

## Source Model

```text
upstream/firefox
      │
      │ pinned revision
      ↓
clean upstream tree
      │
      │ patch series
      ↓
Aequera build tree
```

The upstream checkout is not a place for ordinary Aequera feature development.

## Pinning

Each project release should record:

- Firefox revision/commit;
- release/channel metadata;
- patchset identity/version;
- relevant build/config metadata.

`upstream/manifests/firefox.lock` is the intended machine-readable record.

## Update Procedure

```text
new Firefox revision
        ↓
fetch
        ↓
update pin
        ↓
clean baseline build
        ↓
patch applicability check
        ↓
rebase patch series
        ↓
resolve conflicts
        ↓
build + test
        ↓
performance regression
        ↓
compatibility regression
        ↓
update manifest
```

## Change Classification

### Configuration

Use supported Firefox preferences/policies/build configuration when sufficient.

### Browser Patch

Use `patches/browser/` when Firefox browser-level behavior or hooks must change.

### Toolkit Patch

Use `patches/toolkit/` when shared Firefox UI/toolkit behavior must change.

### Gecko Patch

Use `patches/gecko/` only for engine/platform behavior. Require stronger justification because upstream maintenance cost is higher.

### Build Patch

Use `patches/build/` for necessary source/build integration changes.

## Long-Term Rule

The project should always be able to answer:

> Which Firefox revision are we based on, what did Aequera change, why did it change, and what validates the divergence today?

## Track Policy (Phase 0)

Detailed upstream policy lives in `UPSTREAM1.md`. The
committed decisions for this phase:

```text
release          = production baseline (pinned in upstream/manifests/firefox.lock)
mozilla-central  = forward-compatibility preview (independent channels/central.lock, later)
ESR              = optional future LTS baseline (independent channels/esr.lock, later)
```

Phase 0 pins and builds the Release track only (`157.0.1`,
`FIREFOX_157_0_1_RELEASE`). Preview and LTS tracks exist as schema plus policy
until a later phase activates them. A failing central preview check must
produce a maintenance signal, never invalidate the Release baseline.
