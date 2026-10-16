/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tor windows on Windows (docs/design/TOR.md, Windows): tor listens on a
// loopback TCP port instead of a Unix socket. The launcher picks the port,
// writes it to the Tor profile, and bans it in this ordinary instance; a
// running Tor instance is told by its profile lock; the daemon goes online
// only while the current tor reports its listener on that port. The Unix
// parts are browser_aequera_tor.js; the real network check is the live check
// (tests/security/tor).

const { AequeraTorLauncher } = ChromeUtils.importESModule(
  "chrome://browser/content/aequera/tor/aequera-tor-launch.sys.mjs",
);
const { AequeraTorDaemon } = ChromeUtils.importESModule(
  "chrome://browser/content/aequera/tor/aequera-tor-daemon.sys.mjs",
);
const { AequeraTorPlatform } = ChromeUtils.importESModule(
  "chrome://browser/content/aequera/platform/aequera-tor-platform.sys.mjs",
);

const OFFLINE_TOPIC = "network:offline-status-changed";
const BANNED = "network.security.ports.banned";

/** A Tor layout under a temporary directory (the launcher's torPaths). */
async function tempTorPaths(name) {
  const base = PathUtils.join(PathUtils.tempDir, `aequera-tor-win-${name}`);
  await IOUtils.remove(base, { recursive: true, ignoreAbsent: true });
  await IOUtils.makeDirectory(base);
  registerCleanupFunction(() => IOUtils.remove(base, { recursive: true, ignoreAbsent: true }));
  return {
    base,
    profile: PathUtils.join(base, "profile"),
    data: PathUtils.join(base, "data"),
    marker: PathUtils.join(base, "running"),
  };
}

async function userPrefsOf(paths) {
  return AequeraTorModel.parseUserJs(await IOUtils.readUTF8(PathUtils.join(paths.profile, "user.js")));
}

add_task(async function test_the_launcher_writes_a_loopback_port() {
  AequeraTorLauncher.model ??= AequeraTorModel;
  is(AequeraTorLauncher.unavailable(), null, "Tor windows are available on Windows");
  const paths = await tempTorPaths("prepare");
  await AequeraTorLauncher.prepareProfile(paths);
  const prefs = await userPrefsOf(paths);
  const port = prefs.get(AequeraTorModel.SOCKS_PORT_PREF);
  is(AequeraTorModel.socksPortProblem(port), null, `a usable port: ${port}`);
  is(prefs.get("network.proxy.socks"), "127.0.0.1", "SOCKS on loopback");
  is(prefs.get("network.proxy.socks_port"), port, "at that port");
  is(prefs.get(AequeraTorModel.SOCKS_PATH_PREF), "", "no Unix socket");
  Assert.deepEqual(
    AequeraTorModel.checkRequired(name => prefs.get(name), prefs),
    [],
    "what it wrote passes the instance's own check",
  );
  is(
    AequeraTorModel.torrc({ dataDir: paths.data, socksPort: port, ownerPid: 1 }).includes(
      `SocksPort 127.0.0.1:${port} IsolateSOCKSAuth`,
    ),
    true,
    "and tor's configuration names the same port",
  );
});

add_task(async function test_free_ports_are_unprivileged_loopback_ports() {
  AequeraTorLauncher.model ??= AequeraTorModel;
  for (let i = 0; i < 3; i++) {
    const port = AequeraTorLauncher.freeLoopbackPort();
    is(AequeraTorModel.socksPortProblem(port), null, `port ${port} is in range`);
  }
});

add_task(async function test_the_ordinary_instance_bans_the_tor_port() {
  AequeraTorLauncher.model ??= AequeraTorModel;
  const defaults = Services.prefs.getDefaultBranch("");
  const before = defaults.getStringPref(BANNED, "");
  registerCleanupFunction(() => defaults.setStringPref(BANNED, before));
  const paths = await tempTorPaths("ban");
  await AequeraTorLauncher.prepareProfile(paths);
  const port = (await userPrefsOf(paths)).get(AequeraTorModel.SOCKS_PORT_PREF);
  ok(Services.io.allowPort(port, "http"), "allowed before");

  await AequeraTorLauncher.banTorPort(paths);
  ok(!Services.io.allowPort(port, "http"), "this instance refuses http to tor's port");
  ok(!Services.io.allowPort(port, "https"), "and https");
  ok(!Services.prefs.prefHasUserValue(BANNED), "never saved: the default branch only");

  await AequeraTorLauncher.banTorPort(paths);
  const listed = defaults.getStringPref(BANNED, "").split(",").filter(p => p.trim() == String(port));
  is(listed.length, 1, "banned once, however often a Tor window opens");
});

add_task(async function test_a_running_instance_is_told_by_its_profile_lock() {
  ok(await AequeraTorPlatform.runsWithoutMarker(PathUtils.profileDir), "this running instance holds its profile");

  const paths = await tempTorPaths("lock");
  await IOUtils.makeDirectory(paths.profile);
  ok(!(await AequeraTorPlatform.runsWithoutMarker(paths.profile)), "no lock file: not running");
  await IOUtils.writeUTF8(PathUtils.join(paths.profile, "parent.lock"), "");
  ok(!(await AequeraTorPlatform.runsWithoutMarker(paths.profile)), "a lock file left by an exited instance: not running");

  ok(
    await AequeraTorLauncher.processRunsProfile(Services.appinfo.processID, PathUtils.profileDir),
    "the launcher's liveness uses the lock on Windows",
  );
});

// The daemon over TCP, on fake services (as browser_aequera_tor.js does).

function fakePrefs(user) {
  const defaults = new Map();
  const locked = new Set();
  const value = name => (locked.has(name) || !user.has(name) ? defaults.get(name) : user.get(name));
  const typeOf = v => ({ boolean: 128, number: 64, string: 32 })[typeof v] ?? 0;
  const setter = map => (name, v) => void map.set(name, v);
  return {
    PREF_INVALID: 0,
    PREF_STRING: 32,
    PREF_INT: 64,
    PREF_BOOL: 128,
    locked,
    getPrefType: name => typeOf(value(name)),
    getBoolPref: (name, d) => value(name) ?? d,
    getIntPref: (name, d) => value(name) ?? d,
    getStringPref: (name, d) => value(name) ?? d,
    setBoolPref: setter(user),
    setIntPref: setter(user),
    setStringPref: setter(user),
    prefHasUserValue: name => user.has(name),
    clearUserPref: name => user.delete(name),
    lockPref: name => void locked.add(name),
    prefIsLocked: name => locked.has(name),
    getDefaultBranch: () => ({ setBoolPref: setter(defaults), setIntPref: setter(defaults), setStringPref: setter(defaults) }),
  };
}

const PORT = 49731;

async function withTcpDaemon(user, fn) {
  const d = AequeraTorDaemon;
  const keys = ["started", "ready", "state", "services", "socksPort", "listening", "model", "startTor", "setSearchDefault", "markerPath", "settingsPath", "proc"];
  const saved = Object.fromEntries(keys.map(k => [k, d[k]]));
  const base = PathUtils.join(PathUtils.tempDir, "aequera-tor-win-daemon");
  await IOUtils.makeDirectory(base);
  const env = {
    calls: { startTor: 0 },
    io: { offline: true, manageOfflineStatus: true },
    proxy: { registered: [], registerChannelFilter(f) { this.registered.push(f); }, unregisterChannelFilter() {} },
    obs: { added: [], addObserver(_o, topic) { this.added.push(topic); }, removeObserver() {} },
  };
  Object.assign(d, {
    started: false,
    ready: null,
    state: { status: "idle", progress: 0, summary: "", detail: "", warnings: [] },
    model: AequeraTorModel,
    proc: null,
    listening: false,
    startTor: async () => void env.calls.startTor++,
    setSearchDefault: async () => {},
    markerPath: () => PathUtils.join(base, "running"),
    settingsPath: () => PathUtils.join(base, "settings.json"),
  });
  try {
    env.prefs = fakePrefs(user);
    d.services = { prefs: env.prefs, io: env.io, proxy: env.proxy, obs: env.obs };
    await fn(env, d);
  } finally {
    Object.assign(d, saved);
    await IOUtils.remove(base, { recursive: true, ignoreAbsent: true });
  }
}

const tcpUserPrefs = (port = PORT) => new Map(AequeraTorModel.instancePrefs({ socksPort: port }));
const listenerLine = (address, port) =>
  `Oct 16 02:00:00.000 [notice] Opened Socks listener connection (ready) on ${address}:${port}`;

add_task(async function test_online_only_once_tor_reports_its_listener() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    isnot(d.state.status, "refused", "its checks pass");
    Assert.deepEqual(env.proxy.registered, [d], "the circuit filter is registered");
    is(env.calls.startTor, 1, "tor is started");
    is(env.io.offline, true, "but it stays offline");
    is(env.io.manageOfflineStatus, false, "and the network link cannot bring it online");
    ok(env.obs.added.includes(OFFLINE_TOPIC), "nor Work Offline (watched)");

    const tor = {};
    d.proc = tor;
    d.onLogLine(tor, listenerLine("127.0.0.1", PORT + 1));
    is(env.io.offline, true, "a listener on another port is not ours");
    d.onLogLine(tor, listenerLine("0.0.0.0", PORT));
    is(env.io.offline, true, "nor one on another address");
    d.onLogLine({}, listenerLine("127.0.0.1", PORT));
    is(env.io.offline, true, "nor one from a tor that is not the current one");
    d.onLogLine(tor, listenerLine("127.0.0.1", PORT));
    is(env.io.offline, false, "online once the current tor holds the port");
  });
});

add_task(async function test_offline_again_the_moment_tor_stops() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    const tor = { kill: async () => {} };
    d.proc = tor;
    d.onLogLine(tor, listenerLine("127.0.0.1", PORT));
    is(env.io.offline, false, "online");
    await d.stopTor();
    is(env.io.offline, true, "offline before the port is free for anyone else");
  });
});

add_task(async function test_work_offline_cannot_bring_it_online_without_a_listener() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    env.io.offline = false;
    d.observe(null, OFFLINE_TOPIC, "online");
    is(env.io.offline, true, "undone while no listener is reported");

    const tor = {};
    d.proc = tor;
    d.onLogLine(tor, listenerLine("127.0.0.1", PORT));
    env.io.offline = true;
    env.io.offline = false;
    d.observe(null, OFFLINE_TOPIC, "online");
    is(env.io.offline, false, "with the listener, going online is the user's to choose");
  });
});

add_task(async function test_a_bad_port_is_refused() {
  const user = tcpUserPrefs();
  user.set(AequeraTorModel.SOCKS_PORT_PREF, 80);
  await withTcpDaemon(user, async (env, d) => {
    await d.ensureStarted();
    is(d.state.status, "refused", "refused");
    ok(d.state.detail.includes("socksPort"), d.state.detail);
    is(env.io.offline, true, "offline");
    is(env.calls.startTor, 0, "no tor");
  });
});

add_task(async function test_every_channel_goes_to_the_loopback_port_with_its_circuit() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    const channel = NetUtil.newChannel({ uri: "https://example.com/", loadUsingSystemPrincipal: true });
    const info = await new Promise(resolve => d.applyFilter(channel, null, { onProxyFilterResult: resolve }));
    is(info.type, "socks", "SOCKS");
    is(info.host, "127.0.0.1", "on loopback");
    is(info.port, PORT, "at tor's port");
    ok(info.username, `with a circuit key: ${info.username}`);
    ok(info.password, "and its token");
  });
});

// Review fixes: the exit path, restart, and checks that throw.

/** A fake tor whose log lines and exit the test releases. */
function controllableTor() {
  const lines = [];
  let wake = null;
  let exitNow;
  const exited = new Promise(resolve => (exitNow = resolve));
  let closed = false;
  return {
    push(line) {
      lines.push(line + "\r\n");
      wake?.();
    },
    exit(code = 1) {
      exitNow({ exitCode: code });
    },
    close() {
      closed = true;
      wake?.();
    },
    wait: () => exited,
    kill: async () => exitNow({ exitCode: 0 }),
    stdout: {
      async readString() {
        while (!lines.length && !closed) {
          await new Promise(resolve => (wake = resolve));
        }
        return lines.shift() ?? "";
      },
    },
  };
}

add_task(async function test_offline_when_tor_dies_and_a_late_listener_line_is_ignored() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    const tor = controllableTor();
    const supervised = d.superviseTor(tor);
    tor.push(listenerLine("127.0.0.1", PORT));
    await TestUtils.waitForCondition(() => env.io.offline === false, "online once listening");

    tor.exit(1);
    await TestUtils.waitForCondition(() => env.io.offline === true, "offline as soon as the exit is seen");
    tor.push(listenerLine("127.0.0.1", PORT));
    tor.push("Oct 16 02:00:01.000 [err] Tor died");
    tor.close();
    await supervised;
    is(env.io.offline, true, "a listener line read after the exit does not bring it online");
    is(d.state.status, "failed", "tor stopped");
    is(d.state.detail, "Tor died", "with its last words");
  });
});

add_task(async function test_a_log_pipe_held_open_after_the_exit_does_not_stall_the_verdict() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    const tor = controllableTor();
    const supervised = d.superviseTor(tor);
    tor.push(listenerLine("127.0.0.1", PORT));
    await TestUtils.waitForCondition(() => env.io.offline === false, "online");
    tor.exit(1); // the pipe stays open (never closed)
    await supervised;
    is(env.io.offline, true, "offline");
    is(d.state.status, "failed", "and failed, without waiting for the pipe");
    is(d.proc, null, "no current tor");
  });
});

add_task(async function test_restart_is_once_and_offline_until_the_new_listener() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    d.setState({ status: "failed" });
    const first = d.restart();
    const second = d.restart();
    await Promise.all([first, second]);
    is(env.calls.startTor, 2, "one restart (the first start was the startup's)");
    is(env.io.offline, true, "offline until the new tor reports its listener");
  });
});

add_task(async function test_a_failure_takes_it_offline() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    await d.ensureStarted();
    const tor = { kill: async () => {} };
    d.proc = tor;
    d.onLogLine(tor, listenerLine("127.0.0.1", PORT));
    is(env.io.offline, false, "online");
    d.fail("something broke");
    is(env.io.offline, true, "offline");
    is(d.proc, null, "and that tor is stopped");
  });
});

add_task(async function test_checks_that_throw_refuse() {
  await withTcpDaemon(tcpUserPrefs(), async (env, d) => {
    const savedCheck = d.check;
    d.check = () => {
      throw new Error("aequera.tor.socksPort is not an integer pref");
    };
    try {
      await d.ensureStarted();
    } finally {
      d.check = savedCheck;
    }
    is(d.state.status, "refused", "refused, not a rejected startup");
    is(env.io.offline, true, "offline");
    Assert.deepEqual(env.proxy.registered, [d.refusalFilter], "every channel sent nowhere");
  });
});

add_task(async function test_no_marker_but_a_locked_profile_is_running() {
  const paths = await tempTorPaths("nomarker");
  ok(
    await AequeraTorLauncher.instanceRunning({ ...paths, profile: PathUtils.profileDir }),
    "a held profile counts as running without a marker",
  );
  await IOUtils.makeDirectory(paths.profile);
  ok(!(await AequeraTorLauncher.instanceRunning(paths)), "no marker, no lock: not running");
});
