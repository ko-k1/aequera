#!/usr/bin/env python3
"""Where a Gecko profile spent main-thread CPU, by JS source and function.

  python3 profile_top.py <profile.json> <bench.json> [--window=startup|prepaint|idle]
                         [--parent-only] [--top=N]

<profile.json>: a raw Gecko profile (MOZ_PROFILER_SHUTDOWN) of a
browser_bench.py run with --runs 1; <bench.json>: that run's artifact, whose
timeline cuts the profile: startup = launch .. Marionette ready, prepaint =
launch .. first paint, idle = the idle window. Every process's GeckoMain
thread is counted, or the parent's alone with --parent-only. Samples are weighted
by threadCPUDelta (CPU actually used, the profiler's `cpu` feature), so
waiting is not counted. A source or function is counted once per sample
(inclusive): nested callers each get the sample. Output is Markdown.
"""

import json
import re
import sys
from collections import Counter

JS_URL = re.compile(r"((?:chrome|resource|moz-src|about|jar:file|file)://?[^ )]+?)(?::\d+(?::\d+)?)?\)?$")


def threads_of(profile, parent_only=False):
    """(process meta, thread) for every GeckoMain, parent and children."""
    for thread in profile["threads"]:
        if thread["name"] == "GeckoMain":
            yield profile["meta"], thread
    if not parent_only:
        for child in profile.get("processes", []):
            yield from threads_of(child)


def analyze(profile, window, parent_only=False):
    by_source, by_function, by_category = Counter(), Counter(), Counter()
    total = 0.0
    categories = [c["name"] for c in profile["meta"]["categories"]]
    for meta, thread in threads_of(profile, parent_only):
        start = meta["startTime"]
        lo, hi = window[0] - start, window[1] - start
        strings = thread["stringTable"]
        frames = thread["frameTable"]["data"]
        fschema = thread["frameTable"]["schema"]
        stacks = thread["stackTable"]["data"]
        sschema = thread["stackTable"]["schema"]
        samples = thread["samples"]
        col = samples["schema"]
        cpu_col = col.get("threadCPUDelta")
        for row in samples["data"]:
            t = row[col["time"]]
            if t is None or t < lo or t >= hi:
                continue
            weight = row[cpu_col] if cpu_col is not None and len(row) > cpu_col and row[cpu_col] is not None else 1
            if not weight:
                continue
            stack = row[col["stack"]]
            if stack is None:
                continue
            total += weight
            leaf = frames[stacks[stack][sschema["frame"]]]
            cat = leaf[fschema["category"]] if len(leaf) > fschema["category"] else None
            by_category[categories[cat] if cat is not None else "?"] += weight
            seen_src, seen_fn = set(), set()
            while stack is not None:
                frame = frames[stacks[stack][sschema["frame"]]]
                location = strings[frame[fschema["location"]]]
                m = JS_URL.search(location)
                if m:
                    source = m.group(1).split("?")[0]
                    if source not in seen_src:
                        seen_src.add(source)
                        by_source[source] += weight
                    fn = location if len(location) < 160 else location[:157] + "..."
                    if fn not in seen_fn:
                        seen_fn.add(fn)
                        by_function[fn] += weight
                stack = stacks[stack][sschema["prefix"]]
    return total, by_source, by_function, by_category


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "1") for a in argv if a.startswith("--"))
    profile = json.load(open(args[0]))
    bench = json.load(open(args[1]))
    timeline = bench["runs"][0]["timeline"]
    which = opts.get("window", "startup")
    if which == "idle":
        window = (timeline["idle_start"] * 1000, timeline["idle_end"] * 1000)
    elif which == "prepaint":
        # Launch to first paint: the critical path of a visible startup.
        paint = bench["runs"][0]["startup"]["process_to_firstPaint_ms"]
        window = (timeline["launched"] * 1000, timeline["launched"] * 1000 + paint)
    else:
        window = (timeline["launched"] * 1000, timeline["ready"] * 1000)
    top = int(opts.get("top", 25))
    total, by_source, by_function, by_category = analyze(profile, window, "parent-only" in opts)
    unit = profile["meta"].get("sampleUnits", {}).get("threadCPUDelta", "samples")
    print(f"## {bench['label']}: {which} window, {(window[1] - window[0]) / 1000:.1f} s, "
          f"main-thread CPU {total:g} {unit}\n")
    print("| category (leaf) | share |\n|---|---|")
    for name, w in by_category.most_common(8):
        print(f"| {name} | {100 * w / total:.1f}% |")
    print("\n| JS source (inclusive) | share |\n|---|---|")
    for name, w in by_source.most_common(top):
        print(f"| `{name}` | {100 * w / total:.1f}% |")
    print("\n| JS function (inclusive) | share |\n|---|---|")
    for name, w in by_function.most_common(top):
        print(f"| `{name}` | {100 * w / total:.1f}% |")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
