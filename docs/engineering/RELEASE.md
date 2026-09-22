# Release and Versioning

## Release Identity

A release should be identifiable by the combination of:

```text
Aequera version
Firefox upstream revision
patchset version/identity
configuration schema version
build metadata
```

## Reproducibility

A release build should be reconstructible from recorded source and configuration inputs.

## Release Preparation

```text
freeze candidate
   ↓
lock upstream revision
   ↓
validate patchset
   ↓
validate config/schema
   ↓
run full quality gates
   ↓
build release artifacts
   ↓
record manifest
   ↓
publish
```

## Rollback

The release system should make it possible to reconstruct the previous known-good combination of Firefox revision, patchset, configuration, and Aequera source.

## Update Discipline

Security updates should remain independently visible from UX feature changes. Upstream update work must be traceable through the manifest and patch history.
