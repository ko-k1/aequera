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

## Memory defaults

Aequera changes Firefox's memory-pressure response and the Tor BFCache cap;
it does not change steady-state content-process sizing:

- `browser.tabs.unloadOnLowMemory` is enabled. Firefox defaults it to true on
  macOS and Windows and false on Linux; on Linux this activates the PSI
  watcher's tab unloader, which may discard an inactive tab under memory
  pressure.
- On macOS, `browser.lowMemoryResponseMask = 3` keeps both responses Firefox
  uses on Nightly: tab unloading (`0x1`) and the internal `memory-pressure`
  notification (`0x2`). The release default (`0`) responds to neither; `1`
  would unload a tab but not notify Gecko. The tab unloader never discards
  private tabs, so a private-only profile (Tor) gets the memory-pressure
  response.
- The regular profile leaves `browser.sessionhistory.max_total_viewers` at
  Firefox's automatic value. That value is already capped at 8 viewers on
  hosts with at least 1 GiB of RAM, so pinning 8 would not save memory (and
  would raise it on smaller hosts). The Tor profile sets `4`, a real
  reduction that may make older back/forward entries reload.
- Firefox's content-process policy is left in place, including preallocated
  processes. Lowering `dom.ipc.processCount` does not cap Fission's isolated
  content processes; `dom.ipc.processCount.webIsolated` is only a per-origin
  maximum for those, so neither is a general memory lever.

These settings define memory-pressure behavior and a Tor BFCache cap; they do
not establish a universal memory saving. Compare representative tab
workloads with the local browser benchmark before making stronger
performance claims.

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
- compare memory by PSS: it divides shared pages among the processes that map
  them, so it is not counted once per process. Run one configuration at a
  time; an already-running instance of the same build sharing its `libxul.so`
  lowers PSS. RSS is a secondary check, not the headline: summing per-process
  RSS counts shared pages once per process and overstates a build with more
  processes;
- a profile shows where CPU goes, not what a change saves: profiler overhead
  inflates JavaScript, so a cost found with `profile_top.py` is confirmed by
  an interleaved A/B on wall-clock metrics before a patch is kept;
- a default changed for performance names the measured cost it removes; a
  default changed for another reason (privacy, product) must not claim one.

Firefox features created on first use (the AI features, for example) cost
little at startup or idle; turning them off is a product decision, not a
performance one.

## Measured decisions

Defaults and code paths kept or changed because of a measurement, so they
are not "optimized" back on intuition.

- **Window scripts load uncached** (`aequera/shell/firefox/aequera-main.js`
  passes `ignoreCache: true`, so the startup cache never serves stale
  shell code after a rebuild). Measured 2026-10-20 against the same build
  with the feature scripts cached (`browser_bench.py`, interleaved, 8 runs
  each, artifact build of Firefox 158.0, Linux aarch64 under Xvfb): first
  paint 748–882 ms uncached vs 716–808 ms cached, launch to ready
  1036–1219 vs 994–1136 ms (ranges overlap: no difference), shutdown
  154–234 vs 280–426 ms (cached is slower: Firefox writes the cache at
  exit). Caching would buy nothing measurable and cost shutdown, so the
  scripts stay uncached.

## Lightness Definition

Aequera's “lightweight” goal is not simply removing functionality. It means reducing unnecessary browser-shell overhead and protecting perceived responsiveness: startup, interaction latency, background activity, memory behavior, and visual smoothness matter more than superficial feature count.
