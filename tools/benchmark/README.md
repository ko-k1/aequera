# Benchmarks

Local-only performance baselines. No remote telemetry exists in this
directory, and none will be introduced for project measurement
(`docs/engineering/PERFORMANCE.md`).

## What `aequera bench` records today

```bash
aequera bench [--out <artifact.json>] [--json]
```

1. **Host snapshot** — OS/arch, logical CPUs, total RAM, free disk on the
   repository volume. This is the "representative hardware" note every later
   number is read against.
2. **CLI operation timings** — lock load, manifest load, defaults
   validation, in microseconds. Tooling responsiveness matters because agents
   drive the whole workflow through the CLI.
3. **Browser metric registry** — recorded as `pending` until a browser build
   exists. The registry (names, units, targets) is fixed now so later numbers
   are comparable:

| Metric | Unit | Initial target |
|---|---|---|
| input → visible feedback | ms | ≤ 16 (≤ 8.3 high-refresh) |
| UI animation | fps | 60 baseline |
| tab/workspace switch feedback | ms | ≤ 16 |
| command surface feedback | ms | ≤ 16 |
| startup to first usable paint | ms | recorded, then budgeted |
| idle CPU | % | as close to zero as practical |
| memory (idle / representative load) | MiB | recorded, then budgeted |
| chrome resilience under heavy content | qualitative + frame stats | no input starvation |

## Artifacts

`--out` writes a pretty JSON artifact and creates parent directories.
Baselines are machine-specific and live **outside the repo** (or under the
gitignored `.tmp/`); never commit raw numbers as project claims. A release
may cite a baseline only with host notes and the exact artifact hash.

## Rules

- Measure before/after significant changes; never tune from memory.
- A visual effect that costs frame stability or input latency without a
  measured UX benefit is rejected (`docs/design/MOTION.md`).
- Browser numbers arrive with the first built browser (Phase 1+), not before.
  This harness existing first is the point: later work regresses against
  something instead of against vibes.
