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
3. **Browser metric registry** — names, units, and targets, fixed so numbers
   stay comparable. `aequera bench` lists them as `pending`; the browser
   itself is measured by `browser_bench.py` (below):

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

## Browser measurements (`browser_bench.py`)

The browser half of the registry is measured by `browser_bench.py` (Python
stdlib, Linux), which drives a real launch over Marionette
(`marionette.py`, a minimal client) and reads the rest from procfs:

| Registry metric | Recorded as |
|---|---|
| startup to first usable paint | `startup.process_to_firstPaint_ms`, `..._sessionRestored_ms` (nsIAppStartup.getStartupInfo), `launch_to_ready_ms` |
| idle CPU | `idle.cpu_percent_of_one_core`, per process type (procfs ticks over the idle window) |
| memory (idle / representative load) | `memory_idle`, `memory_tabs` (PSS and RSS per process type, smaps_rollup) |
| tab/workspace switch feedback | `tab_switch.*_presented_ms` (select to content shown, as Talos tabswitch), `*_chrome_ms` (select to the next chrome paint) |
| hidden network calls | `network.*`: every host the browser connected to, at startup and while idle, through a local proxy that tunnels and logs host names only; `first_launch.network`: the same for the new profile's first (unmeasured) launch, over `--warmup-seconds` |

Each run starts from a copy of a warm profile (one unmeasured first launch),
so first-run work is not counted, and closes any first-run modal it finds
(recorded as `startup.modal_closed`). The same harness runs any Firefox
build, so Aequera can be compared with the Firefox release whose compiled
code the artifact build downloads (the artifact `libxul.so` is
byte-identical to the release's): differences are then Aequera's front end,
prefs, and patches alone.

On NixOS, `browser-bench-nixos.sh` runs it in a private headless sway (tab
switches need a compositor; headless Firefox never finishes one) under
steam-run:

```bash
nix shell nixpkgs#sway -c bash tools/benchmark/browser-bench-nixos.sh \
  --aequera --label aequera --runs 5 --out .tmp/bench/aequera.json
nix shell nixpkgs#sway -c bash tools/benchmark/browser-bench-nixos.sh \
  --exe <firefox-158.0>/firefox --label firefox --runs 5 --out .tmp/bench/firefox.json
nix shell nixpkgs#sway -c bash tools/benchmark/browser-bench-nixos.sh \
  --aequera --label candidate --pref name=value ... --out .tmp/bench/candidate.json
steam-run python3 tools/benchmark/compare.py .tmp/bench/firefox.json .tmp/bench/aequera.json
```

`--pref` writes user prefs for one configuration, so a candidate default is
measured before it is made. Never run two benchmarks, a build, or a test
gate at the same time: they measure each other. Compare memory between
different builds by RSS: PSS splits shared pages with any other process
mapping the same files (a running Aequera session maps the main build's
`libxul.so`).

Where startup or idle CPU goes: a profiled run (`--runs 1 --env
MOZ_PROFILER_STARTUP=1 --env MOZ_PROFILER_STARTUP_FEATURES=js,stackwalk,cpu
--env MOZ_PROFILER_SHUTDOWN=<profile.json>`) and

```bash
steam-run python3 tools/benchmark/profile_top.py <profile.json> <bench.json> \
  --window=prepaint --parent-only   # or --window=startup / --window=idle
```

which ranks JS sources and functions by the main-thread CPU they used
inside the window. Profiling inflates JavaScript; confirm any saving with an
interleaved A/B before keeping a change.

## Artifacts

`--out` writes a pretty JSON artifact and creates parent directories.
Baselines are machine-specific and live **outside the repo** (or under the
gitignored `.tmp/`); never commit raw numbers as project claims. A release
may cite a baseline only with host notes and the exact artifact hash.

## Rules

- Measure before/after significant changes; never tune from memory.
- A visual effect that costs frame stability or input latency without a
  measured UX benefit is rejected (`docs/design/MOTION.md`).
- Browser numbers come from `browser_bench.py` on a built browser, never from memory.
  This harness existing first is the point: later work regresses against
  something instead of against vibes.
