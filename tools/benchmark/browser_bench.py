#!/usr/bin/env python3
"""Local browser benchmark (Linux; Python stdlib only).

Launches one browser build several times on a warm profile and records the
browser metrics of the registry in tools/benchmark/README.md that can be
measured from outside the browser:

  startup   process creation -> main / first paint / session restored
            (nsIAppStartup.getStartupInfo), launch -> Marionette ready;
  idle      CPU of the whole process tree over an idle window (procfs),
            per process type, and every connection the browser opened
            (a local logging proxy that tunnels, never blocks);
  memory    PSS / RSS of the process tree at idle and with tabs open;
  tabs      tab switch latency (select -> TabSwitchDone, the event Firefox
            fires once the new tab's layers are shown);
  shutdown  quit request -> process exit.

Nothing leaves the machine except what the browser itself requests (the
proxy forwards it unchanged and logs host names only). Results are a JSON
artifact; baselines are machine-specific and are never committed.

  python3 browser_bench.py --exe <dist/bin/firefox> [--app-ini <ini>] \\
      --label aequera --runs 5 --out <artifact.json> [--pref name=value]...

Run under steam-run on NixOS (tools/benchmark/browser-bench-nixos.sh).
"""

import argparse
import http.server
import json
import os
import platform
import select
import shutil
import signal
import socket
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marionette import Marionette, MarionetteError  # noqa: E402

CLK_TCK = os.sysconf("SC_CLK_TCK")


# --- network log -----------------------------------------------------------

class ProxyLog:
    def __init__(self):
        self.lock = threading.Lock()
        self.entries = []  # (epoch seconds, method, host:port)

    def add(self, method, target):
        with self.lock:
            self.entries.append((time.time(), method, target))

    def between(self, start, end):
        with self.lock:
            return [e for e in self.entries if start <= e[0] < end]


def _relay(a, b):
    socks = [a, b]
    try:
        while True:
            readable, _, _ = select.select(socks, [], [], 60)
            if not readable:
                return
            for s in readable:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        return


class _ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = client.recv(65536)
            if not chunk:
                return
            head += chunk
            if len(head) > 1 << 20:
                return
        line, _, rest = head.partition(b"\r\n")
        try:
            method, target, version = line.decode("latin-1").split(" ", 2)
        except ValueError:
            return
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            getattr(self.server, "log").add("CONNECT", target)
            try:
                upstream = socket.create_connection((host.strip("[]"), int(port)), timeout=15)
            except OSError:
                client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                return
            client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            _relay(client, upstream)
            upstream.close()
            return
        # Plain HTTP through a proxy: absolute-form request line.
        if not target.startswith("http://"):
            client.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        hostport, _, path = target[len("http://"):].partition("/")
        host, _, port = hostport.partition(":")
        getattr(self.server, "log").add(method, f"{host}:{port or 80}")
        try:
            upstream = socket.create_connection((host, int(port or 80)), timeout=15)
        except OSError:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        upstream.sendall(f"{method} /{path} {version}\r\n".encode("latin-1") + rest)
        _relay(client, upstream)
        upstream.close()


class LoggingProxy(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _ProxyHandler)
        self.log = ProxyLog()
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def port(self):
        return self.server_address[1]


# --- fixture pages ---------------------------------------------------------

# A page with enough DOM and paint to make a tab switch draw something real:
# a styled article plus a grid of gradient cards. Self-contained, no network.
FIXTURE = """<!doctype html><meta charset=utf-8><title>bench {n}</title>
<style>
body {{ font: 15px/1.5 sans-serif; margin: 0; padding: 24px; background: #f4f1ea; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }}
.card {{ height: 110px; border-radius: 12px; box-shadow: 0 2px 8px #0003;
        background: linear-gradient(135deg, hsl({h} 70% 60%), hsl({h2} 70% 40%)); }}
p {{ max-width: 70ch; }}
</style>
<h1>Benchmark page {n}</h1>
{paras}
<div class=grid>{cards}</div>
"""


def fixture_page(n):
    paras = "".join(
        f"<p>Paragraph {i} of page {n}. " + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 6 + "</p>"
        for i in range(12)
    )
    cards = "<div class=card></div>" * 120
    return FIXTURE.format(n=n, h=(n * 47) % 360, h2=(n * 47 + 60) % 360, paras=paras, cards=cards).encode()


class _FixtureHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            n = int(self.path.strip("/").split("/")[-1])
        except ValueError:
            n = 0
        body = fixture_page(n)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


class FixtureServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), _FixtureHandler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def port(self):
        return self.server_address[1]


# --- procfs ----------------------------------------------------------------

def _stat(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            data = f.read().decode("latin-1")
    except OSError:
        return None
    # comm may contain spaces: fields after the closing paren.
    rest = data[data.rindex(")") + 2:].split()
    return {"ppid": int(rest[1]), "ticks": int(rest[11]) + int(rest[12])}


def process_tree(root):
    children = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        st = _stat(int(name))
        if st:
            children.setdefault(st["ppid"], []).append(int(name))
    tree, todo = [], [root]
    while todo:
        pid = todo.pop()
        tree.append(pid)
        todo.extend(children.get(pid, []))
    return tree


def process_type(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            args = f.read().decode("utf-8", "replace").split("\0")
    except OSError:
        return "gone"
    # A child rewrites its title into one string ("<path>/firefox
    # -contentproc ... 9 tab"), so split on whitespace, not NULs. The type is
    # the last word: tab, socket, rdd, utility, gpu, gmplugin, ...
    tokens = " ".join(args).split()
    if "-contentproc" in tokens:
        return tokens[-1]
    exe = os.path.basename(tokens[0]) if tokens else ""
    return "main" if exe in ("firefox", "aequera", "firefox-bin") else exe or "?"


def memory_of(pid):
    out = {}
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for line in f:
                key, _, value = line.partition(":")
                if key in ("Rss", "Pss"):
                    out[key.lower()] = int(value.split()[0])  # kB
    except OSError:
        return None
    return out


def tree_memory(root):
    total = {"pss_mib": 0.0, "rss_mib": 0.0, "processes": 0, "by_type": {}}
    for pid in process_tree(root):
        mem = memory_of(pid)
        if not mem:
            continue
        kind = process_type(pid)
        pss = mem.get("pss", 0) / 1024
        total["pss_mib"] += pss
        total["rss_mib"] += mem.get("rss", 0) / 1024
        total["processes"] += 1
        slot = total["by_type"].setdefault(kind, {"count": 0, "pss_mib": 0.0})
        slot["count"] += 1
        slot["pss_mib"] += pss
    return _round(total)


class CpuSampler:
    """Accumulates CPU ticks of a process tree, per process type."""

    def __init__(self, root, interval=0.5):
        self.root, self.interval = root, interval
        self.last = {}
        self.kind = {}
        self.ticks = {}
        self._stop = threading.Event()
        self._sample(initial=True)

    def _sample(self, initial=False):
        for pid in process_tree(self.root):
            st = _stat(pid)
            if not st:
                continue
            if pid not in self.kind:
                self.kind[pid] = process_type(pid)
            prev = self.last.get(pid)
            if prev is None:
                # A process born inside the window spent all its ticks in it.
                delta = 0 if initial else st["ticks"]
            else:
                delta = max(0, st["ticks"] - prev)
            self.last[pid] = st["ticks"]
            self.ticks[self.kind[pid]] = self.ticks.get(self.kind[pid], 0) + delta

    def run_for(self, seconds):
        start = time.monotonic()
        while time.monotonic() - start < seconds:
            time.sleep(self.interval)
            self._sample()
        self._sample()
        elapsed = time.monotonic() - start
        by_type = {k: 100.0 * v / CLK_TCK / elapsed for k, v in self.ticks.items()}
        return _round({
            "seconds": elapsed,
            "cpu_percent_of_one_core": sum(by_type.values()),
            "by_type": by_type,
        })


def _round(value):
    if isinstance(value, float):
        return round(value, 3)
    if isinstance(value, dict):
        return {k: _round(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_round(v) for v in value]
    return value


# --- browser ---------------------------------------------------------------

READY_SCRIPT = r"""
const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
let win;
for (let i = 0; i < 6000; i++) {
  win = Services.wm.getMostRecentWindow("navigator:browser");
  if (win && win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) break;
  await new Promise(r => setTimeout(r, 10));
}
await SessionStore.promiseAllWindowsRestored;
const readyAt = Date.now();
// A window-modal dialog (first-run onboarding) blocks tab selection; an
// established profile has dismissed it. Close it and record which it was.
let modal = null;
if (win.document.documentElement.hasAttribute("window-modal-open")) {
  modal = [...win.document.querySelectorAll("#window-modal-dialog browser")].map(b => b.currentURI?.spec).join() || "?";
  win.gDialogBox?._dialog?.close();
  for (let i = 0; i < 200 && win.document.documentElement.hasAttribute("window-modal-open"); i++) {
    await new Promise(r => setTimeout(r, 10));
  }
}
const info = Services.startup.getStartupInfo();
const out = {};
for (const [k, v] of Object.entries(info)) {
  out[k] = v instanceof Date ? v.getTime() : v;
}
resolve({ info: out, readyAt, modal, appName: Services.appinfo.name, version: Services.appinfo.version });
"""

TABS_SCRIPT = r"""
const [urls, rounds] = [args[0], args[1]];
const win = Services.wm.getMostRecentWindow("navigator:browser");
const gBrowser = win.gBrowser;
const principal = Services.scriptSecurityManager.getSystemPrincipal();
const origin = gBrowser.selectedTab;
const tabs = urls.map(url => gBrowser.addTab(url, { triggeringPrincipal: principal }));
// Wait for every page to finish loading.
const loaded = b => b.currentURI.spec.startsWith("http://127.0.0.1") && !b.webProgress?.isLoadingDocument;
for (let i = 0; i < 3000 && !tabs.every(t => loaded(t.linkedBrowser)); i++) {
  await new Promise(r => setTimeout(r, 20));
}
// As Talos tabswitch: select -> the new tab's content presented
// (MozLayerTreeReady, or at once when its layers are cached), then wait for
// TabSwitchDone so the switcher has shut down (it fires only after the old
// tab's layers are unloaded, browser.tabs.remote.unloadDelayMs later, so it
// is not itself a latency). Also select -> the next chrome paint, where the
// tab strip shows the selection.
const timeout = (ms, value) => new Promise(r => win.setTimeout(() => r(value), ms));
const switchTo = async tab => {
  const browser = tab.linkedBrowser;
  const done = new Promise(r => gBrowser.addEventListener("TabSwitchDone", r, { once: true }));
  const t0 = ChromeUtils.now();
  const presented = browser.hasLayers ? Promise.resolve(t0) : new Promise(r =>
    browser.addEventListener("MozLayerTreeReady", () => r(ChromeUtils.now()), { once: true }));
  const painted = new Promise(r => win.addEventListener("MozAfterPaint", () => r(ChromeUtils.now()), { once: true }));
  gBrowser.selectedTab = tab;
  const [p, c] = await Promise.all([Promise.race([presented, timeout(5000, null)]), Promise.race([painted, timeout(5000, null)])]);
  await Promise.race([done, timeout(5000)]);
  return { presented: p === null ? null : p - t0, chrome: c === null ? null : c - t0 };
};
const first = [];   // first visit: the tab was never shown
const warm = [];    // later visits
for (let r = 0; r < rounds; r++) {
  for (const tab of [...tabs, origin]) {
    // Settle: a frame plus a tick, as Talos does after moving tabs.
    await new Promise(res => win.requestAnimationFrame(res));
    await new Promise(res => win.setTimeout(res, 150));
    const ms = await switchTo(tab);
    (r == 0 && tab !== origin ? first : warm).push(ms);
  }
}
resolve({ first, warm, tabs: tabs.length });
"""


def write_user_js(profile, marionette_port, proxy_port, prefs):
    base = {
        "marionette.port": marionette_port,
        # The remote agent's "recommended" prefs disable new tab feeds and
        # more; they would measure automation, not the browser.
        "remote.prefs.recommended": False,
        "browser.shell.checkDefaultBrowser": False,
        # An established profile: official Firefox builds show the Terms of
        # Use modal until accepted (local builds bypass it).
        "termsofuse.bypassNotification": True,
        # Every connection goes through the logging proxy (it tunnels).
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": proxy_port,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": proxy_port,
        "network.proxy.no_proxies_on": "",
        "network.proxy.allow_hijacking_localhost": False,
    }
    base.update(prefs)
    with open(profile / "user.js", "w") as f:
        for key, value in base.items():
            f.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def kill_tree(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


class Browser:
    def __init__(self, args, profile, proxy, env):
        self.args, self.profile, self.proxy = args, profile, proxy
        self.port = free_port()
        write_user_js(profile, self.port, proxy.port, args.prefs)
        cmd = [args.exe]
        if args.app_ini:
            cmd += ["-app", args.app_ini]
        cmd += ["-no-remote", "-profile", str(profile), "-marionette", "-remote-allow-system-access"]
        if args.purgecaches:
            cmd.append("-purgecaches")
        if args.headless:
            cmd.append("--headless")
        self.log = open(profile.parent / f"{profile.name}.log", "wb")
        self.launched = time.time()
        self.proc = subprocess.Popen(cmd, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        self.m = Marionette(self.port, connect_timeout=120)
        self.m.start_session()
        ready = self.m.execute(READY_SCRIPT)
        self.ready = ready
        self.ready_at = time.time()

    def startup(self):
        info = self.ready["info"]
        process = info.get("process")
        out = {"launch_to_ready_ms": (self.ready_at - self.launched) * 1000, "modal_closed": self.ready.get("modal")}
        for key in ("main", "firstPaint", "firstPaint2", "sessionRestored", "createTopLevelWindow"):
            if process and isinstance(info.get(key), (int, float)):
                out[f"process_to_{key}_ms"] = info[key] - process
        return _round(out)

    def quit(self):
        t0 = time.monotonic()
        self.m.quit()
        try:
            self.proc.wait(timeout=60)
            shutdown = (time.monotonic() - t0) * 1000
        except subprocess.TimeoutExpired:
            shutdown = None
        kill_tree(self.proc)
        self.log.close()
        return shutdown


def summarize_network(entries, origin):
    hosts = {}
    for t, _method, target in entries:
        slot = hosts.setdefault(target, {"count": 0, "first_s": round(t - origin, 1)})
        slot["count"] += 1
    return {"connections": len(entries), "hosts": dict(sorted(hosts.items()))}


def one_run(args, template, workdir, proxy, fixtures, env, index):
    profile = workdir / f"run-{index}"
    shutil.copytree(template, profile)
    browser = Browser(args, profile, proxy, env)
    try:
        result: dict = {"startup": browser.startup()}
        time.sleep(args.settle)
        idle_start = time.time()
        result["idle"] = CpuSampler(browser.proc.pid).run_for(args.idle)
        idle_end = time.time()
        # Epoch seconds, to cut a Gecko profile of the run into its phases.
        result["timeline"] = {"launched": browser.launched, "ready": browser.ready_at,
                              "idle_start": idle_start, "idle_end": idle_end}
        result["memory_idle"] = tree_memory(browser.proc.pid)
        result["network"] = {
            "startup_and_settle": summarize_network(proxy.log.between(browser.launched, idle_start), browser.launched),
            "idle_window": summarize_network(proxy.log.between(idle_start, idle_end), browser.launched),
        }
        if args.tabs:
            urls = [f"http://127.0.0.1:{fixtures.port}/page/{n}" for n in range(args.tabs)]
            tabs = browser.m.execute(TABS_SCRIPT, [urls, args.tab_rounds])
            switch: dict = {"timeouts": 0}
            for visit in ("first", "warm"):
                for what in ("presented", "chrome"):
                    values = [s[what] for s in tabs[visit]]
                    switch["timeouts"] += sum(v is None for v in values)
                    switch[f"{visit}_{what}_ms"] = _stats([v for v in values if v is not None])
            result["tab_switch"] = _round(switch)
            time.sleep(3)
            result["memory_tabs"] = tree_memory(browser.proc.pid)
    finally:
        result_shutdown = browser.quit()
    result["shutdown_ms"] = round(result_shutdown, 1) if result_shutdown else None
    if not args.keep_profiles:
        shutil.rmtree(profile, ignore_errors=True)
    return result


def _stats(values):
    if not values:
        return None
    values = sorted(values)
    return {
        "n": len(values),
        "median": statistics.median(values),
        "p95": values[min(len(values) - 1, int(round(0.95 * (len(values) - 1))))],
        "min": values[0],
        "max": values[-1],
    }


def _paths(obj, prefix=""):
    """Flattens numeric leaves: {"a": {"b": 1}} -> {"a.b": 1}."""
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("hosts", "timeline"):
                continue
            out.update(_paths(v, f"{prefix}{k}."))
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out[prefix[:-1]] = obj
    return out


def summarize(runs):
    flat = [_paths(r) for r in runs]
    keys = sorted({k for f in flat for k in f})
    summary = {}
    for key in keys:
        values = [f[key] for f in flat if key in f]
        if len(values) == len(runs):
            summary[key] = _round({
                "median": statistics.median(values),
                "min": min(values),
                "max": max(values),
            })
    # Hosts contacted while idle in any run, with the number of runs.
    idle_hosts = {}
    for r in runs:
        for host in r["network"]["idle_window"]["hosts"]:
            idle_hosts[host] = idle_hosts.get(host, 0) + 1
    startup_hosts = {}
    for r in runs:
        for host in r["network"]["startup_and_settle"]["hosts"]:
            startup_hosts[host] = startup_hosts.get(host, 0) + 1
    return {"metrics": summary, "idle_hosts_runs": idle_hosts, "startup_hosts_runs": startup_hosts}


def parse_pref(text):
    key, _, value = text.partition("=")
    if value in ("true", "false"):
        return key, value == "true"
    try:
        return key, int(value)
    except ValueError:
        return key, value


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--exe", required=True, help="browser binary (dist/bin/firefox)")
    p.add_argument("--app-ini", help="-app ini (Aequera identity)")
    p.add_argument("--label", required=True)
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--settle", type=float, default=30, help="seconds after ready before the idle window")
    p.add_argument("--idle", type=float, default=60, help="idle window, seconds")
    p.add_argument("--warmup-seconds", type=float, default=45, help="first (unmeasured) launch")
    p.add_argument("--tabs", type=int, default=8, help="fixture tabs for the switch test (0 skips it)")
    p.add_argument("--tab-rounds", type=int, default=3)
    p.add_argument("--pref", action="append", default=[], help="name=value, written to user.js")
    p.add_argument("--env", action="append", default=[], help="NAME=value for the browser")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--purgecaches", action="store_true", help="pass -purgecaches like the dev launcher")
    p.add_argument("--workdir", help="profiles go here (default: a temp dir)")
    p.add_argument("--keep-profiles", action="store_true")
    p.add_argument("--out", required=True)
    args = p.parse_args()
    args.prefs = dict(parse_pref(t) for t in args.pref)

    env = dict(os.environ)
    for item in args.env:
        k, _, v = item.partition("=")
        env[k] = v

    workdir = Path(args.workdir or tempfile.mkdtemp(prefix="aequera-bench-"))
    workdir.mkdir(parents=True, exist_ok=True)
    proxy, fixtures = LoggingProxy(), FixtureServer()

    # Warm profile: one unmeasured launch does first-run work (profile
    # creation, add-on install, first-run pages); every measured run starts
    # from a copy of it.
    template = workdir / "template"
    if template.exists():
        shutil.rmtree(template)
    template.mkdir()
    warm = Browser(args, template, proxy, env)
    warm_startup = warm.startup()
    time.sleep(args.warmup_seconds)
    warm.quit()
    for leftover in ("lock", ".parentlock"):
        (template / leftover).unlink(missing_ok=True)

    runs = []
    for i in range(args.runs):
        try:
            runs.append(one_run(args, template, workdir, proxy, fixtures, env, i))
        except (MarionetteError, OSError) as e:
            runs.append({"error": str(e)})
        print(f"[{args.label}] run {i + 1}/{args.runs} done", file=sys.stderr, flush=True)

    good = [r for r in runs if "error" not in r]
    report = {
        "schema": "aequera.browser-bench/1",
        "label": args.label,
        "browser": {"exe": args.exe, "app_ini": args.app_ini, "name": warm.ready.get("appName"), "version": warm.ready.get("version")},
        "host": {
            "kernel": platform.release(),
            "cpus": os.cpu_count(),
            "display": "headless" if args.headless else (env.get("WAYLAND_DISPLAY") or env.get("DISPLAY") or "?"),
        },
        "settings": {
            "runs": args.runs, "settle_s": args.settle, "idle_s": args.idle, "tabs": args.tabs,
            "tab_rounds": args.tab_rounds, "prefs": args.prefs, "purgecaches": args.purgecaches,
        },
        "first_launch": {"startup": warm_startup},
        "summary": summarize(good) if good else None,
        "runs": runs,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if not args.workdir:
        shutil.rmtree(workdir, ignore_errors=True)
    print(f"[{args.label}] wrote {out} ({len(good)}/{len(runs)} runs ok)", file=sys.stderr)
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
