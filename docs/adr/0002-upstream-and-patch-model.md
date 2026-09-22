# ADR 0002: Upstream and Patch Model

## Status

Accepted

## Decision

Use a pinned Firefox upstream revision plus a Git-native, ordered patch series. Keep Aequera-owned implementation in its own source tree and use patches only when a Firefox source boundary must be crossed.

## Rationale

A large monolithic fork makes upstream synchronization opaque. A patch stack makes intentional divergence visible, reviewable, rebased in pieces, and automatable.

The architecture therefore distinguishes:

```text
Aequera source
    ≠
Firefox patches
    ≠
Firefox upstream
    ≠
configuration
```

## Consequences

- `upstream/firefox` remains clean and pinned;
- `worktree/firefox` is generated;
- `patches/` is part of the project's architectural history;
- patch rebase becomes a normal workflow rather than emergency fork maintenance;
- Aequera CLI can automate the full lifecycle.

## Rejected Alternatives

### One giant patch

Rejected because it obscures dependencies and conflict surfaces.

### All Aequera code as patches

Rejected because product logic should remain source-owned and independently understandable.

### Manually edited Firefox fork

Rejected because source ownership and upstream divergence become difficult to reason about.
