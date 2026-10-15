# Performance Engineering

## Principle

Performance is part of UX. Optimize for responsiveness, stability, and predictable interaction, not merely benchmark throughput.

## Primary Metrics

- input-to-first-feedback latency;
- command-surface open latency;
- tab/workspace switch feedback latency;
- frame time and dropped-frame rate;
- startup time to first usable paint;
- idle CPU;
- memory at idle and under representative tab loads;
- browser-shell resilience while web content is CPU/memory heavy.

## Initial Targets

These are engineering targets and should be validated on representative hardware:

| Metric | Initial target |
|---|---:|
| input → visible feedback | ≤ 16 ms; target ≤ 8.3 ms on high-refresh systems |
| UI animation | 60 FPS baseline; higher refresh where practical |
| tab/workspace switch feedback | ≤ 16 ms |
| command surface feedback | ≤ 16 ms |
| unnecessary idle CPU | as close to zero as practical |

Targets should be measured rather than treated as marketing claims.

## Architectural Rules

- keep input-critical paths small;
- prefer asynchronous/cancellable work;
- avoid forced synchronous layout;
- prefer compositor-friendly transitions;
- avoid recreating unaffected surfaces;
- avoid unnecessary browser-shell JavaScript on hot paths;
- measure before/after significant changes.

## Perceived Performance

Immediate acknowledgement is preferable to silent waiting. When completion takes time, show a meaningful intermediate state without blocking further direct interaction when safe.

## Instrumentation

Diagnostics should be local and privacy-safe. Suggested tooling:

- input event timestamps;
- frame markers;
- task duration traces;
- layout/style invalidation counts;
- startup phase timing;
- memory snapshots;
- background task pressure.

No remote telemetry should be introduced solely for project measurement.

## Measuring Against Firefox

`tools/benchmark/browser_bench.py` (README there) measures startup, idle CPU,
memory, tab switch latency, and every connection a real launch opens. The
artifact build downloads exactly the compiled code of the Firefox release it
is pinned to (its `libxul.so` is byte-identical), so running the same harness
on that release isolates what Aequera's front end, prefs, and patches cost or
save. Rules for a comparison:

- one configuration per invocation, never two at once, and nothing else heavy
  on the machine (builds, test gates);
- alternate configurations run by run (`compare.py` pools artifacts sharing a
  label): a long sequential series drifts with host load and can show a
  difference larger than any change under test;
- a difference counts only where the min-max ranges over the runs do not
  overlap; otherwise it is noise and is reported as such;
- compare memory by RSS between different builds: PSS divides shared pages
  among every process mapping a file, so a build that another running
  browser also maps reads lower;
- a profile shows where CPU goes, not what a change saves: profiler overhead
  inflates JavaScript, so a cost found with `profile_top.py` is confirmed by
  an interleaved A/B on wall-clock metrics before a patch is kept;
- a default changed for performance names the measured cost it removes; a
  default changed for another reason (privacy, product) must not claim one.

Firefox features created on first use (the AI features, for example) cost
little at startup or idle; turning them off is a product decision, not a
performance one.

## Lightness Definition

Aequera's “lightweight” goal is not simply removing functionality. It means reducing unnecessary browser-shell overhead and protecting perceived responsiveness: startup, interaction latency, background activity, memory behavior, and visual smoothness matter more than superficial feature count.
