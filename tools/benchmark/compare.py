#!/usr/bin/env python3
"""Compares browser_bench.py artifacts: medians side by side (Markdown).

  python3 compare.py <a.json> <b.json> ... [--all]

The first artifact is the reference; other columns show the difference from
it; artifacts sharing a label are pooled, so configurations measured in
alternating rounds (which spreads host load drift over all of them) compare
as one each. --all lists every recorded metric, not only the headline ones. Each
cell is the median over runs, with the min-max range: a difference smaller
than the ranges overlap is noise, not a result.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_bench import summarize  # noqa: E402  # pyright: ignore[reportMissingImports]

HEADLINE = [
    ("startup.process_to_firstPaint_ms", "startup: first paint (ms)"),
    ("startup.process_to_sessionRestored_ms", "startup: session restored (ms)"),
    ("startup.launch_to_ready_ms", "startup: launch to ready (ms)"),
    ("idle.cpu_percent_of_one_core", "idle CPU (% of one core)"),
    ("idle.by_type.main", "idle CPU: main process (%)"),
    ("memory_idle.pss_mib", "memory idle: PSS (MiB)"),
    ("memory_idle.by_type.main.pss_mib", "memory idle: main PSS (MiB)"),
    ("memory_idle.processes", "processes at idle"),
    ("memory_tabs.pss_mib", "memory, 8 tabs: PSS (MiB)"),
    ("tab_switch.first_presented_ms.median", "tab switch, first visit: content (ms)"),
    ("tab_switch.warm_presented_ms.median", "tab switch, warm: content (ms)"),
    ("tab_switch.first_chrome_ms.median", "tab switch, first visit: chrome paint (ms)"),
    ("tab_switch.warm_chrome_ms.median", "tab switch, warm: chrome paint (ms)"),
    ("network.startup_and_settle.connections", "connections: startup + settle"),
    ("network.idle_window.connections", "connections: idle window"),
    ("shutdown_ms", "shutdown (ms)"),
]


def cell(summary, key, ref=None):
    m = summary["metrics"].get(key)
    if not m:
        return "-"
    text = f"{m['median']:g} ({m['min']:g}-{m['max']:g})"
    if ref is not None:
        r = ref["metrics"].get(key)
        if r and r["median"]:
            text += f" {100 * (m['median'] - r['median']) / abs(r['median']):+.0f}%"
    return text


def main(argv):
    show_all = "--all" in argv
    paths = [a for a in argv if a != "--all"]
    # Artifacts with the same label are one configuration measured in several
    # invocations (interleaved rounds): their runs are pooled.
    reports = []
    for p in paths:
        report = json.load(open(p))
        same = next((r for r in reports if r["label"] == report["label"]), None)
        if same:
            same["runs"] += report["runs"]
        else:
            reports.append(report)
    for r in reports:
        good = [x for x in r["runs"] if "error" not in x]
        r["summary"] = summarize(good) if good else None
    labels = [r["label"] for r in reports]
    summaries = [r["summary"] for r in reports]
    keys = HEADLINE
    if show_all:
        known = {k for k, _ in HEADLINE}
        extra = sorted({k for s in summaries for k in s["metrics"]} - known)
        keys = HEADLINE + [(k, k) for k in extra]
    runs = [len([x for x in r["runs"] if "error" not in x]) for r in reports]
    print("| metric | " + " | ".join(f"{l} (n={n})" for l, n in zip(labels, runs)) + " |")
    print("|---|" + "---|" * len(reports))
    for key, name in keys:
        cells = [cell(summaries[0], key)] + [cell(s, key, summaries[0]) for s in summaries[1:]]
        if all(c == "-" for c in cells):
            continue
        print(f"| {name} | " + " | ".join(cells) + " |")
    for title, field in (("startup + settle", "startup_hosts_runs"), ("idle window", "idle_hosts_runs")):
        print(f"\nHosts contacted, {title} (runs that contacted each):\n")
        hosts = sorted({h for s in summaries for h in s[field]})
        if not hosts:
            print("none")
            continue
        print("| host | " + " | ".join(labels) + " |")
        print("|---|" + "---|" * len(reports))
        for h in hosts:
            print(f"| {h} | " + " | ".join(str(s[field].get(h, 0)) for s in summaries) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
