# Patch System

## Design Goal

Firefox changes should be explicit, reviewable, reproducible, and easy to rebase.

The preferred mechanism is a **Git-native ordered patch series**. Quilt-like patch stacks can be conceptually similar, but the project should keep Git history as the primary representation because Firefox itself is Git-based and logical commits map naturally to logical patches.

## Patch Layout

```text
patches/
├── browser/
│   ├── <feature-a>/
│   └── <feature-b>/
├── toolkit/
├── gecko/
└── build/
```

A feature may contain an ordered series:

```text
patches/browser/workspace/
├── 0001-workspace-hooks.patch
├── 0002-workspace-shell-integration.patch
├── 0003-workspace-navigation.patch
└── 0004-workspace-persistence.patch
```

The names are descriptive. Git commit order is authoritative.

## Patch Granularity

Prefer:

- one logical concern per commit;
- small reviewable changes;
- dependencies visible in order;
- tests linked to each meaningful series.

Avoid one giant “Aequera.patch”.

## Patch Manifest

A machine-readable manifest may record metadata such as:

```yaml
id: workspace
series: browser/workspace
version: 1
base: <firefox revision>
depends_on:
  - browser-shell-hooks
affects:
  - browser/chrome
validation:
  - workspace-unit
  - workspace-ui
  - workspace-navigation
risk: medium
```

Exact schema is not final; the important properties are explicit identity, base revision, dependency information, affected areas, and validation requirements.

## Application Flow

```text
read firefox.lock
      ↓
prepare clean source
      ↓
resolve patchset version
      ↓
verify base compatibility
      ↓
apply ordered series
      ↓
apply configs
      ↓
generate worktree
      ↓
validate source state
```

## Rebase Flow

```text
old upstream
   ↓
current patch series
   ↓
new upstream
   ↓
rebase first logical patch
   ↓
resolve conflict
   ↓
run focused test
   ↓
continue series
   ↓
full build/test/bench
```

Conflict resolution should be incremental rather than deferring every conflict to the end.

## Overlays: Aequera Source in the Build

Aequera-owned code that Firefox's build must compile or package (window
stylesheets, chrome scripts, default prefs) is not transported as patches.
It lives in Aequera source and is declared as an **overlay** in
`patches/manifest.yaml`:

```yaml
overlays:
  - id: shell-chrome
    source: aequera/shell/firefox   # Aequera source of truth
    dest: browser/aequera           # generated copy in worktree/firefox
```

`aequera patch apply` replaces each `dest` with a fresh copy of `source` on
every run (edits and deletions propagate). An overlay may only add new
directories: `dest` is refused if it contains any upstream-tracked file, and
paths must be plain relative paths. The patch series then carries only the
hooks that make Firefox build and load the overlay (for Stage 1:
`patches/browser/shell-hooks`, 4 lines).

## Patch vs Aequera Source

Use a patch only when the Firefox source boundary must be crossed.

For example, a workspace product should primarily live in Aequera-owned `core/shell/ui/design` code. If Firefox lacks a hook needed to expose or control that workflow, add the smallest Firefox patch that creates the hook or necessary browser behavior.

## Patch Hygiene

Each patch should ideally have:

- a clear subject;
- a rationale;
- minimal scope;
- associated tests;
- no unrelated formatting churn;
- a clear upstream conflict surface.

## Generated Worktree

`worktree/firefox/` is disposable. Never make undocumented fixes there. Any useful change must be promoted into source, config, or patch history.
