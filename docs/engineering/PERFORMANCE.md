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

## Lightness Definition

Aequera's “lightweight” goal is not simply removing functionality. It means reducing unnecessary browser-shell overhead and protecting perceived responsiveness: startup, interaction latency, background activity, memory behavior, and visual smoothness matter more than superficial feature count.
