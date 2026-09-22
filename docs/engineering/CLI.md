# Aequera CLI

## Purpose

The Aequera CLI is an intent-oriented interface over the repository workflow. It hides fragile combinations of Git, patch tooling, Firefox source preparation, configuration generation, testing, and benchmarking behind stable project-level commands.

This is particularly useful for coding agents, because an agent should be able to request an operation such as “rebase the patchset onto Firefox revision X” without reconstructing the entire internal procedure.

## Command Groups

```text
aequera doctor

aequera upstream fetch

aequera upstream status
aequera upstream update <revision>
aequera upstream checkout <revision>

aequera patch status
aequera patch check
aequera patch apply
aequera patch rebase <revision>
aequera patch export

aequera config validate
aequera config migrate

aequera build
aequera test
aequera bench

aequera release check
aequera release prepare
```

Exact command names are implementation details; intent-oriented grouping is the design requirement.

## Expected Properties

The CLI should be:

- deterministic;
- scriptable;
- safe by default;
- clear about destructive actions;
- able to emit machine-readable output (for example `--json`);
- able to report the active upstream revision, patchset, config version, and worktree state.

## Example Status

```text
Aequera status

Upstream: Firefox <pinned revision>
Patchset: 18 patches / clean
Config: schema v3 / valid
Worktree: generated / clean
Build: available
Tests: last run passed
Benchmark: baseline recorded
```

The exact revision/build values are runtime data, not documentation constants.

## Agent Safety

Commands that mutate upstream pins, rewrite patch history, or delete generated artifacts must be explicit. Read-only commands should be safe to run repeatedly.
