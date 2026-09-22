# Project Workflow

## Development Flow

```text
issue / idea
   ↓
user problem + acceptance criterion
   ↓
architecture classification
   ↓
small implementation unit
   ↓
test
   ↓
performance / accessibility / security checks
   ↓
review + documentation
   ↓
merge
```

## Change Classification Flow

Before touching source, answer:

```text
Can a supported Firefox preference/policy/config do it?
        ├─ yes → configs/
        └─ no
             ↓
Can a first-party WebExtension express it cleanly?
        ├─ yes → aequera/extensions/
        └─ no
             ↓
Is this Aequera product logic/UI/design/service?
        ├─ yes → aequera/
        └─ no
             ↓
Must Firefox browser/toolkit/build source change?
        ├─ yes → patches/<domain>/
        └─ no → reassess the design
```

Gecko-level patches are exceptional and require explicit rationale.

## Build Flow

```text
pinned Firefox revision
        ↓
clean upstream source
        ↓
apply patchset
        ↓
apply Aequera configuration
        ↓
produce build tree
        ↓
build
        ↓
unit / integration / UI / compatibility tests
        ↓
performance checks
        ↓
artifact
```

## Upstream Update Flow

```text
new Firefox revision
        ↓
resolve + pin
        ↓
build clean upstream baseline
        ↓
check patch applicability
        ↓
rebase patch series
        ↓
resolve conflicts
        ↓
build patched Aequera
        ↓
regression tests
        ↓
performance regression
        ↓
update manifest / docs
        ↓
merge upstream update
```

## Patch Development Flow

A patch should be created from the pinned upstream tree, not from a long-lived manually edited fork.

```text
pinned upstream
    ↓
make one logical Firefox-side change
    ↓
commit
    ↓
continue with dependent logical changes
    ↓
ordered patch series
    ↓
patch validation
```

## Release Flow

```text
upstream pin
   +
patchset
   +
configs
   +
Aequera source
        ↓
reproducible build
        ↓
quality gates
        ↓
release candidate
        ↓
compatibility/security/performance validation
        ↓
release artifact + manifest
```

## Agent Workflow

Agents should operate through intent-oriented commands rather than manually reproducing complex Git/upstream mechanics. The Aequera CLI is therefore an orchestration layer, not just a thin alias collection.
