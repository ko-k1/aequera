/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tor windows (tor/, docs/design/TOR.md). This process is an ordinary
// instance, so the Tor instance's parts are exercised piece by piece: the
// launcher with a fake spawn (profile, user.js, command line, environment),
// the circuit filter on real channels (applyFilter, never registered here:
// it would send this test's own traffic to a socket that does not exist),
// tor's lifecycle with a fake tor script (real Subprocess, log parsing,
// failure), and the indicator's rendering. The real thing, through the Tor
// network, is the manual check in docs/design/TOR.md.

const { AequeraTorLauncher } = ChromeUtils.importESModule(
  "chrome://browser/content/aequera/tor/aequera-tor-launch.sys.mjs",
);
const { AequeraTorDaemon } = ChromeUtils.importESModule(
  "chrome://browser/content/aequera/tor/aequera-tor-daemon.sys.mjs",
);
// NetUtil is a global of the test scope already; FileUtils may be too.
const { FileUtils: TorFileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");

const TOR_BASE = PathUtils.join(PathUtils.profileDir, "tor");
const isMac = AppConstants.platform == "macosx";

const MARKER = PathUtils.join(TOR_BASE, "running");

/** A fake browser process: exits at once with `exitCode`, or (null) runs
 *  until killed. */
function fakeProcess(exitCode = 0) {
  let exit = null;
  const exited = exitCode === null ? new Promise(resolve => (exit = resolve)) : Promise.resolve({ exitCode });
  return {
    stdout: { readString: async () => "" },
    wait: () => exited,
    kill: async () => {
      exit?.({ exitCode: 0 });
      return { exitCode: 0 };
    },
  };
}

/** spawn for a new Tor instance: it starts (writes its marker) and runs. */
function instanceSpawn(calls) {
  return async options => {
    calls.push({ ...options, markerAtSpawn: await IOUtils.exists(MARKER) });
    await IOUtils.writeUTF8(MARKER, "4242");
    return fakeProcess(null);
  };
}

async function resetLauncher() {
  await AequeraTorLauncher.child?.kill();
  AequeraTorLauncher.child = null;
  AequeraTorLauncher.spawn = null;
  AequeraTorLauncher.processAlive = null;
  await IOUtils.remove(MARKER, { ignoreAbsent: true });
}

async function removeSocketDirOf(profileDir) {
  const prefs = readUserJs(await IOUtils.readUTF8(PathUtils.join(profileDir, "user.js")));
  await IOUtils.remove(PathUtils.parent(prefs.get("aequera.tor.socksPath")), { recursive: true, ignoreAbsent: true });
}

/** Reads user.js text (JSON literals, tor-model.js userJs) into a Map; every
 *  line is a comment or a user_pref call. */
function readUserJs(text) {
  const prefs = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("//")) {
      continue;
    }
    const m = /^user_pref\(("(?:[^"\\]|\\.)*"), (.*)\);$/.exec(line);
    ok(m, `user.js line is a user_pref call: ${line}`);
    prefs.set(JSON.parse(m[1]), JSON.parse(m[2]));
  }
  return prefs;
}

registerCleanupFunction(async () => {
  await resetLauncher();
  await IOUtils.remove(TOR_BASE, { recursive: true, ignoreAbsent: true });
});

add_task(async function test_entry_points() {
  ok(window.AequeraTor, "window script loaded");
  is(AequeraTor.unavailable(), null, "Tor windows available here");

  const key = document.getElementById("aequera-key-tor-window");
  ok(key, "shortcut key exists");
  is(key.getAttribute("key"), "N");
  is(key.getAttribute("modifiers"), isMac ? "accel,alt" : "alt,shift", "Brave's shortcut");

  const fileItem = document.getElementById("menu_aequeraTorWindow");
  ok(fileItem, "File menu item exists");
  is(fileItem.previousElementSibling.id, "menu_newPrivateWindow", "right after New Private Window");
  is(fileItem.getAttribute("key"), "aequera-key-tor-window", "shows the shortcut");

  // App menu: its main view is built when it first shows.
  const shown = BrowserTestUtils.waitForEvent(PanelUI.mainView, "ViewShown");
  PanelUI.show();
  await shown;
  const appItem = document.getElementById("appMenu-aequera-tor-window-button");
  ok(appItem, "app menu item exists");
  is(appItem.previousElementSibling.id, "appMenu-new-private-window-button2", "right after New private window");
  const hidden = BrowserTestUtils.waitForEvent(PanelUI.panel, "popuphidden");
  PanelUI.hide();
  await hidden;
});

add_task(async function test_link_context_menu() {
  const html =
    '<a id="web" href="https://example.com/page">web</a> <a id="mail" href="mailto:a@example.com">mail</a> <p id="text">text</p>';
  await BrowserTestUtils.withNewTab(`data:text/html,${encodeURIComponent(html)}`, async browser => {
    const menu = document.getElementById("contentAreaContextMenu");
    const item = document.getElementById("context-aequera-openlinktor");
    ok(item, "link menu item exists");
    is(item.previousElementSibling.id, "context-openlinkprivate", "after Open Link in New Private Window");

    for (const [id, visible] of [
      ["web", true],
      ["mail", false],
      ["text", false],
    ]) {
      const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
      await BrowserTestUtils.synthesizeMouseAtCenter(`#${id}`, { type: "contextmenu", button: 2 }, browser);
      await shown;
      is(!item.hidden, visible, `${id}: shown only for web links`);
      const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
      menu.hidePopup();
      await hidden;
    }
  });
});

add_task(async function test_launch_writes_a_fresh_profile() {
  const calls = [];
  AequeraTorLauncher.spawn = instanceSpawn(calls);
  const profileDir = PathUtils.join(TOR_BASE, "profile");

  // Something left from an earlier session: removed, with the socket
  // directory of a session that did not quit cleanly.
  await IOUtils.makeDirectory(profileDir);
  await IOUtils.writeUTF8(PathUtils.join(profileDir, "leftover"), "x");
  const oldSocketDir = PathUtils.join(PathUtils.tempDir, "aequera-tor-0123abcd");
  await IOUtils.makeDirectory(oldSocketDir);
  await IOUtils.writeUTF8(
    PathUtils.join(profileDir, "user.js"),
    `user_pref("aequera.tor.socksPath", ${JSON.stringify(PathUtils.join(oldSocketDir, "socks"))});\n`,
  );

  await AequeraTorLauncher.openWindow("https://example.com/");
  is(calls.length, 1, "one process started");
  const { command, arguments: args, environment, environmentAppend } = calls[0];
  is(command, Services.dirsvc.get("XREExeF", Ci.nsIFile).path, "this browser's own binary");
  const profileAt = args.indexOf("-profile");
  is(args[profileAt + 1], profileDir, "the Tor profile");
  ok(args.includes("-offline"), "starts offline: online only once its checks pass");
  ok(args.includes("-private-window"), "a private window");
  is(args.at(-1), "https://example.com/", "with the link");
  ok(environmentAppend, "environment inherited");
  Assert.strictEqual(environment.XRE_PROFILE_PATH, null, "a restart's profile variable is removed");
  Assert.strictEqual(environment.MOZ_NEW_INSTANCE, null, "remoting stays on for later windows");
  Assert.strictEqual(environment.MOZ_MARIONETTE, null, "automation is not inherited");
  Assert.strictEqual(environment.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, null, "nor system access for it");
  ok(AequeraTorLauncher.child, "the new instance is tracked");

  ok(!(await IOUtils.exists(PathUtils.join(profileDir, "leftover"))), "old profile removed");
  ok(!(await IOUtils.exists(oldSocketDir)), "the crashed session's socket directory removed");
  const prefs = readUserJs(await IOUtils.readUTF8(PathUtils.join(profileDir, "user.js")));
  is(prefs.get("aequera.tor.instance"), true, "marks the instance");
  is(prefs.get("network.proxy.type"), 1, "manual proxy");
  is(prefs.get("network.dns.disabled"), true, "no local DNS");
  is(prefs.get("network.proxy.failover_direct"), false, "no direct failover");
  is(prefs.get("browser.privatebrowsing.autostart"), true, "always private");
  is(prefs.get("aequera.tor.dataDir"), PathUtils.join(TOR_BASE, "data"), "tor's data kept beside the profile");

  const socksPath = prefs.get("aequera.tor.socksPath");
  is(AequeraTorModel.socketPathProblem(socksPath), null, "a socket in a launcher-named directory");
  is(prefs.get("network.proxy.socks"), Services.io.newFileURI(new TorFileUtils.File(socksPath)).spec, "SOCKS at that socket");
  const socketDir = PathUtils.parent(socksPath);
  is((await IOUtils.stat(socketDir)).permissions & 0o777, 0o700, "socket directory private to the user");
  ok(!(await IOUtils.exists(socksPath)), "nothing listens before tor");
  is((await IOUtils.stat(PathUtils.join(TOR_BASE, "data"))).permissions & 0o777, 0o700, "tor data private");
  await IOUtils.remove(socketDir, { recursive: true });
  await resetLauncher();
});

add_task(async function test_launch_never_removes_other_directories() {
  AequeraTorLauncher.spawn = instanceSpawn([]);
  const profileDir = PathUtils.join(TOR_BASE, "profile");
  const notOurs = PathUtils.join(PathUtils.tempDir, "aequera-tor-test-not-ours");
  await IOUtils.makeDirectory(notOurs);
  await IOUtils.writeUTF8(PathUtils.join(notOurs, "keep"), "x");
  await IOUtils.makeDirectory(profileDir);
  await IOUtils.writeUTF8(
    PathUtils.join(profileDir, "user.js"),
    `user_pref("aequera.tor.socksPath", ${JSON.stringify(PathUtils.join(notOurs, "socks"))});\n`,
  );
  await AequeraTorLauncher.openWindow();
  ok(await IOUtils.exists(PathUtils.join(notOurs, "keep")), "a directory the launcher did not name stays");
  await IOUtils.remove(notOurs, { recursive: true });
  await removeSocketDirOf(profileDir);
  await resetLauncher();
});

add_task(async function test_launch_while_running_hands_off() {
  const calls = [];
  const asked = [];
  AequeraTorLauncher.processAlive = async (pid, profile) => {
    asked.push([pid, profile]);
    return true;
  };
  AequeraTorLauncher.spawn = async options => {
    calls.push(options);
    return fakeProcess(0);
  };
  const profileDir = PathUtils.join(TOR_BASE, "profile");
  await IOUtils.makeDirectory(profileDir);
  await IOUtils.writeUTF8(PathUtils.join(profileDir, "in-use"), "x");
  await IOUtils.writeUTF8(MARKER, "1234");

  await AequeraTorLauncher.openWindow();
  Assert.deepEqual(asked, [[1234, profileDir]], "the marker's pid is checked against the profile");
  is(calls.length, 1, "a remoting client started");
  ok(await IOUtils.exists(PathUtils.join(profileDir, "in-use")), "the running instance's profile is untouched");
  ok(!calls[0].arguments.includes("-offline"), "a handoff carries no startup flag");
  ok(!calls[0].arguments.some(a => a.startsWith("http")), "no URL");
  is(AequeraTorLauncher.child, null, "a remoting client is not the instance");

  // A handoff that failed is an error, not a silent no-op.
  AequeraTorLauncher.spawn = async () => fakeProcess(3);
  await Assert.rejects(AequeraTorLauncher.openWindow(), /did not take the window \(exit 3\)/);
  await resetLauncher();
  await IOUtils.remove(profileDir, { recursive: true });
});

add_task(async function test_stale_marker_gets_a_fresh_profile() {
  // A crashed instance's marker: its pid no longer runs the profile.
  AequeraTorLauncher.processAlive = async () => false;
  const calls = [];
  AequeraTorLauncher.spawn = instanceSpawn(calls);
  const profileDir = PathUtils.join(TOR_BASE, "profile");
  await IOUtils.makeDirectory(profileDir);
  await IOUtils.writeUTF8(PathUtils.join(profileDir, "crashed-session"), "x");
  await IOUtils.writeUTF8(MARKER, "999999");

  await AequeraTorLauncher.openWindow();
  ok(!calls[0].markerAtSpawn, "the stale marker is gone before the new instance starts");
  ok(calls[0].arguments.includes("-offline"), "a new instance, not a handoff");
  ok(!(await IOUtils.exists(PathUtils.join(profileDir, "crashed-session"))), "the crashed session's profile is gone");
  await removeSocketDirOf(profileDir);
  await resetLauncher();
});

add_task(async function test_early_exit_is_an_error() {
  // Exits before it ever writes its marker (startup failure, bad profile).
  AequeraTorLauncher.spawn = async () => fakeProcess(1);
  await Assert.rejects(AequeraTorLauncher.openWindow(), /exited before it started \(exit 1\)/);
  is(AequeraTorLauncher.child, null, "nothing tracked");
  await removeSocketDirOf(PathUtils.join(TOR_BASE, "profile"));
  await resetLauncher();
});

add_task(async function test_process_liveness() {
  // A real process whose command line names a profile path ($0 of sh -c).
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const profile = PathUtils.join(PathUtils.tempDir, "aequera-tor-liveness-profile");
  // `read` is a shell builtin: the shell itself waits on its stdin pipe.
  const proc = await Subprocess.call({ command: "/bin/sh", arguments: ["-c", "read line", profile] });
  try {
    ok(await AequeraTorLauncher.processRunsProfile(proc.pid, profile), "a live process running that profile");
    ok(!(await AequeraTorLauncher.processRunsProfile(proc.pid, `${profile}-other`)), "the same process, another profile");
  } finally {
    await proc.kill();
  }
  ok(!(await AequeraTorLauncher.processRunsProfile(proc.pid, profile)), "gone once it exited");
  ok(!(await AequeraTorLauncher.processRunsProfile(2 ** 30 + 7, profile)), "no such process");
});

add_task(async function test_launch_refuses_non_web_urls() {
  let spawned = false;
  AequeraTorLauncher.spawn = async () => {
    spawned = true;
    return fakeProcess();
  };
  for (const url of ["file:///etc/passwd", "about:config", "javascript:alert(1)"]) {
    await Assert.rejects(AequeraTorLauncher.openWindow(url), /only http/, url);
  }
  ok(!spawned, "nothing started");
});

add_task(async function test_disabled_removes_nothing_but_refuses() {
  await SpecialPowers.pushPrefEnv({ set: [["aequera.tor.enabled", false]] });
  is(AequeraTorLauncher.unavailable(), "disabled");
  await Assert.rejects(AequeraTorLauncher.openWindow(), /unavailable \(disabled\)/);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  ok(!win.document.getElementById("menu_aequeraTorWindow"), "no File menu item when off");
  ok(!win.document.getElementById("aequera-key-tor-window"), "no shortcut when off");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

// The circuit filter.

function channelFor(spec, { document = false, partitionSite = null, system = false } = {}) {
  if (document) {
    return NetUtil.newChannel({
      uri: spec,
      loadUsingSystemPrincipal: true,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
    });
  }
  if (system) {
    return NetUtil.newChannel({ uri: spec, loadUsingSystemPrincipal: true });
  }
  const page = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(`https://www.${partitionSite}/`), {
    partitionKey: `(https,${partitionSite})`,
  });
  return NetUtil.newChannel({
    uri: spec,
    loadingPrincipal: page,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_IMAGE,
  });
}

function filtered(channel) {
  let result;
  AequeraTorDaemon.applyFilter(channel, null, { onProxyFilterResult: pi => (result = pi) });
  return result;
}

add_task(async function test_circuit_filter() {
  const daemon = AequeraTorDaemon;
  const saved = { model: daemon.model, socksUrl: daemon.socksUrl };
  daemon.model = AequeraTorModel;
  daemon.socksUrl = "file:///run/user/1000/aequera-tor-test/socks";
  daemon.nonces.clear();
  try {
    const top = filtered(channelFor("https://www.example.com/a", { document: true }));
    is(top.type, "socks", "SOCKS");
    is(top.host, daemon.socksUrl, "tor's socket");
    is(top.username, "example.com", "a top-level page is its own site's circuit");
    ok(top.flags & Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST, "the proxy resolves names");
    ok(top.password.length >= 16, "a per-site password");

    const sub = filtered(channelFor("https://cdn.tracker.net/pixel.png", { partitionSite: "example.com" }));
    is(sub.username, "example.com", "a third-party load rides its page's circuit");
    is(sub.password, top.password, "same site, same credentials");

    const other = filtered(channelFor("https://cdn.tracker.net/pixel.png", { partitionSite: "news.org" }));
    is(other.username, "news.org", "the same third party on another site: that site's circuit");
    isnot(other.password, top.password, "different sites never share credentials");

    // A browser page's partition key (the JSON viewer's) is not a site.
    const viewer = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI("https://www.example.com/"), {
      partitionKey: "(resource,devtools)",
    });
    const fromViewer = NetUtil.newChannel({
      uri: "https://www.example.com/favicon.ico",
      loadingPrincipal: viewer,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_IMAGE,
    });
    isnot(filtered(fromViewer).username, "devtools", "a non-web partition key never names a circuit");

    const browserRequest = filtered(channelFor("https://updates.example.net/list", { system: true }));
    is(browserRequest.username, AequeraTorModel.UNKNOWN_SITE, "browser requests share a circuit of their own");

    const key = daemon.newCircuitFor("example.com");
    is(key, "example.com");
    const renewed = filtered(channelFor("https://www.example.com/b", { document: true }));
    isnot(renewed.password, top.password, "new circuit: new credentials");
    is(filtered(channelFor("https://cdn.tracker.net/x.png", { partitionSite: "news.org" })).password, other.password, "other sites keep theirs");

    // A filter must answer even when it cannot key a channel.
    const broken = { get loadInfo() { throw new Error("boom"); }, URI: null };
    is(filtered(broken).username, AequeraTorModel.UNKNOWN_SITE, "falls back to the shared circuit, still tor");
  } finally {
    Object.assign(daemon, saved);
    daemon.nonces.clear();
  }
});

// tor's lifecycle, with a fake tor.

async function fakeTor(name, body) {
  const dir = PathUtils.join(PathUtils.tempDir, `aequera-tor-test-${name}`);
  await IOUtils.makeDirectory(dir);
  const path = PathUtils.join(dir, "tor");
  await IOUtils.writeUTF8(path, `#!/bin/sh\necho "$@" > "${dir}/args"\n${body}\n`);
  await IOUtils.setPermissions(path, 0o755);
  return { dir, path };
}

function waitForStatus(status) {
  return new Promise(resolve => {
    const done = AequeraTorDaemon.subscribe(state => {
      if (state.status == status) {
        done();
        resolve(state);
      }
    });
  });
}

async function withDaemon(executable, run) {
  const daemon = AequeraTorDaemon;
  const base = PathUtils.join(PathUtils.tempDir, "aequera-tor-daemon-test");
  const saved = { model: daemon.model, socksPath: daemon.socksPath, state: daemon.state };
  await SpecialPowers.pushPrefEnv({
    set: [
      ["aequera.tor.executable", executable],
      ["aequera.tor.dataDir", PathUtils.join(base, "data")],
    ],
  });
  daemon.model = AequeraTorModel;
  daemon.socksPath = AequeraTorModel.newSocketPath(base, "0badc0de");
  try {
    await run(base);
  } finally {
    await daemon.stopTor();
    Object.assign(daemon, saved);
    await SpecialPowers.popPrefEnv();
    await IOUtils.remove(base, { recursive: true, ignoreAbsent: true });
  }
}

add_task(async function test_tor_bootstraps() {
  const tor = await fakeTor(
    "ok",
    [
      'echo "Oct 14 18:00:00.000 [notice] Tor 0.4.8.0 opening log file."',
      'echo "Oct 14 18:00:00.100 [notice] Bootstrapped 10% (conn_done): Connected to a relay"',
      "sleep 0.3",
      'echo "Oct 14 18:00:01.000 [notice] Bootstrapped 100% (done): Done"',
      "exec sleep 600",
    ].join("\n"),
  );
  await withDaemon(tor.path, async base => {
    const progress = [];
    const off = AequeraTorDaemon.subscribe(state => progress.push(state.progress));
    const connected = waitForStatus("connected");
    AequeraTorDaemon.startTor();
    const state = await connected;
    off();
    is(state.progress, 100);
    is(state.summary, "Connected to the Tor network");
    ok(progress.includes(10), "progress reported on the way");

    const torrc = await IOUtils.readUTF8(PathUtils.join(base, "torrc"));
    ok(torrc.includes(`SocksPort unix:"${AequeraTorDaemon.socksPath}" IsolateSOCKSAuth`), "the instance's socket");
    ok(torrc.includes(`__OwningControllerProcess ${Services.appinfo.processID}`), "owned by this process");
    const args = (await IOUtils.readUTF8(PathUtils.join(tor.dir, "args"))).trim();
    is(args, `-f ${PathUtils.join(base, "torrc")} --defaults-torrc ${PathUtils.join(base, "torrc-defaults")}`, "only its own config");
    is((await IOUtils.stat(PathUtils.join(base, "data"))).permissions & 0o777, 0o700, "data dir private");

    // Stopping on purpose is not a failure.
    await AequeraTorDaemon.stopTor();
    await new Promise(resolve => setTimeout(resolve, 200));
    is(AequeraTorDaemon.state.status, "connected", "a deliberate stop is not reported as a failure");
  });
  await IOUtils.remove(tor.dir, { recursive: true });
});

add_task(async function test_tor_failure_is_reported() {
  const tor = await fakeTor(
    "fail",
    ['echo "Oct 14 18:00:00.000 [warn] Could not bind to the SOCKS socket"', 'echo "Oct 14 18:00:00.000 [err] Reading config failed--see warnings above."', "exit 1"].join("\n"),
  );
  await withDaemon(tor.path, async () => {
    const failed = waitForStatus("failed");
    AequeraTorDaemon.startTor();
    const state = await failed;
    is(state.summary, "Tor stopped");
    is(state.detail, "Reading config failed--see warnings above.", "tor's last error shown");
  });
  await IOUtils.remove(tor.dir, { recursive: true });
});

add_task(async function test_tor_missing_is_reported() {
  await withDaemon("/nonexistent/tor", async () => {
    await Assert.rejects(AequeraTorDaemon.startTor(), /tor not found at \/nonexistent\/tor/);
  });
});

/** A fake expert bundle (tools/tor/fetch-bundle.sh layout): its tor records
 *  its library path and arguments, connects, and runs until killed. */
async function fakeBundle({ marker = true } = {}) {
  const dir = PathUtils.join(PathUtils.tempDir, "aequera-tor-test-bundle");
  await IOUtils.makeDirectory(dir);
  const tor = PathUtils.join(dir, "tor");
  await IOUtils.writeUTF8(
    tor,
    [
      "#!/bin/sh",
      `echo "$LD_LIBRARY_PATH$DYLD_LIBRARY_PATH" > "${dir}/libpath"`,
      `echo "$@" > "${dir}/args"`,
      'echo "Oct 14 18:00:01.000 [notice] Bootstrapped 100% (done): Done"',
      "exec sleep 600",
    ].join("\n") + "\n",
  );
  await IOUtils.setPermissions(tor, 0o755);
  await IOUtils.writeUTF8(PathUtils.join(dir, "geoip"), "");
  await IOUtils.writeUTF8(PathUtils.join(dir, "geoip6"), "");
  if (marker) {
    await IOUtils.writeUTF8(PathUtils.join(dir, "aequera-tor-bundle.json"), "{}");
  }
  return { dir, tor };
}

add_task(async function test_bundled_tor_is_found_and_run_with_its_libraries() {
  const bundle = await fakeBundle();
  const saved = AequeraTorDaemon.bundleDir;
  AequeraTorDaemon.bundleDir = () => bundle.dir;
  try {
    await withDaemon("", async base => {
      Assert.deepEqual(await AequeraTorDaemon.findTor(), { path: bundle.tor, bundle: bundle.dir }, "the bundle, before PATH");
      const connected = waitForStatus("connected");
      AequeraTorDaemon.startTor();
      await connected;
      await TestUtils.waitForCondition(() => IOUtils.exists(PathUtils.join(bundle.dir, "libpath")), "tor ran");
      is((await IOUtils.readUTF8(PathUtils.join(bundle.dir, "libpath"))).trim(), bundle.dir, "with the bundle's libraries");
      const torrc = await IOUtils.readUTF8(PathUtils.join(base, "torrc"));
      ok(torrc.includes(`GeoIPFile "${PathUtils.join(bundle.dir, "geoip")}"`), "the bundle's GeoIP database");
      ok(torrc.includes(`GeoIPv6File "${PathUtils.join(bundle.dir, "geoip6")}"`), "and its IPv6 one");
    });

    // The user's choice wins over the bundle.
    const other = await fakeTor("chosen", "exit 0");
    await withDaemon(other.path, async () => {
      Assert.deepEqual(await AequeraTorDaemon.findTor(), { path: other.path, bundle: null }, "aequera.tor.executable first");
    });
    await IOUtils.remove(other.dir, { recursive: true });
  } finally {
    AequeraTorDaemon.bundleDir = saved;
    await IOUtils.remove(bundle.dir, { recursive: true });
  }
});

add_task(async function test_a_directory_without_the_marker_is_no_bundle() {
  const bundle = await fakeBundle({ marker: false });
  const saved = AequeraTorDaemon.bundleDir;
  AequeraTorDaemon.bundleDir = () => bundle.dir;
  try {
    await withDaemon("", async () => {
      let found = null;
      try {
        found = await AequeraTorDaemon.findTor();
      } catch (error) {
        ok(/no bundled tor/.test(error.message), `none bundled: ${error.message}`);
      }
      if (found) {
        isnot(found.path, bundle.tor, "a stray tor without the marker is never run");
        is(found.bundle, null, "found on PATH instead");
      }
    });
  } finally {
    AequeraTorDaemon.bundleDir = saved;
    await IOUtils.remove(bundle.dir, { recursive: true });
  }
});

add_task(async function test_tor_refuses_a_socket_outside_its_directory() {
  const tor = await fakeTor("never", "exit 0");
  await withDaemon(tor.path, async base => {
    // A socket path the launcher would never write: nothing is created,
    // locked down, or (at quit) removed there.
    const elsewhere = PathUtils.join(base, "elsewhere");
    AequeraTorDaemon.socksPath = PathUtils.join(elsewhere, "socks");
    await Assert.rejects(AequeraTorDaemon.startTor(), /socket path is not socks in a directory named aequera-tor-/);
    ok(!(await IOUtils.exists(elsewhere)), "no directory made there");
    ok(!(await IOUtils.exists(PathUtils.join(tor.dir, "args"))), "tor never started");
  });
  await IOUtils.remove(tor.dir, { recursive: true });
});

add_task(async function test_restart_ignores_the_old_tor() {
  // The old tor keeps talking after it was replaced: none of it may reach
  // the new session's state.
  const daemon = AequeraTorDaemon;
  const saved = { model: daemon.model, proc: daemon.proc, state: daemon.state };
  daemon.model = AequeraTorModel;
  const oldProc = {};
  const newProc = {};
  daemon.proc = newProc;
  daemon.state = { status: "bootstrapping", progress: 30, summary: "x", detail: "" };
  try {
    daemon.onLogLine(oldProc, "Oct 14 18:00:00.000 [err] Old tor dying");
    daemon.onLogLine(oldProc, "Oct 14 18:00:00.000 [notice] Bootstrapped 100% (done): Done");
    is(daemon.state.detail, "", "no stale error");
    is(daemon.state.status, "bootstrapping", "no stale progress");
    daemon.onLogLine(newProc, "Oct 14 18:00:00.000 [notice] Bootstrapped 50% (loading_descriptors): Loading relay descriptors");
    is(daemon.state.progress, 50, "the current tor's lines count");
  } finally {
    Object.assign(daemon, saved);
  }
});

add_task(async function test_refused_stays_offline() {
  // A refused instance re-asserts offline when something turns it online
  // (Work Offline). Restored at once: this test browser needs the network.
  const wasOffline = Services.io.offline;
  try {
    Services.io.offline = false;
    AequeraTorDaemon.observe(null, "network:offline-status-changed", "online");
    ok(Services.io.offline, "back offline");
  } finally {
    Services.io.offline = wasOffline;
  }
});

add_task(async function test_circuit_keys_are_bounded() {
  const daemon = AequeraTorDaemon;
  const saved = daemon.nonces;
  daemon.nonces = new Map();
  try {
    for (let i = 0; i < 1005; i++) {
      daemon.nonceFor(`site${i}.example`);
    }
    is(daemon.nonces.size, 1000, "at most 1000 sites kept");
    ok(!daemon.nonces.has("site0.example"), "the oldest dropped first");
    ok(daemon.nonces.has("site1004.example"), "the newest kept");
  } finally {
    daemon.nonces = saved;
  }
});

add_task(async function test_search_default() {
  const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
  await SearchService.init();
  const before = await SearchService.getDefault();
  const beforePrivate = await SearchService.getDefaultPrivate();
  const separate = "browser.search.separatePrivateDefault.enabled";
  const separateWasSet = Services.prefs.prefHasUserValue(separate);
  try {
    // The Tor profile's value (tor-model.js); this profile has none.
    await SpecialPowers.pushPrefEnv({ set: [["aequera.tor.searchEngine", "DuckDuckGo"]] });
    await AequeraTorDaemon.setSearchDefault();
    is((await SearchService.getDefault()).name, "DuckDuckGo", "the session's engine");
    is((await SearchService.getDefaultPrivate()).name, "DuckDuckGo", "in private windows too");
    await SpecialPowers.popPrefEnv();

    // The Tor profile's default: DuckDuckGo's onion service, added as an
    // engine of its own, with its suggestions.
    const onion = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
    const onionPrefs = AequeraTorModel.PREFS.filter(p => /^aequera\.tor\.search/.test(p.name)).map(p => [p.name, p.value]);
    await SpecialPowers.pushPrefEnv({ set: onionPrefs });
    try {
      await AequeraTorDaemon.setSearchDefault();
      await AequeraTorDaemon.setSearchDefault();
      const engine = await SearchService.getDefaultPrivate();
      is(engine.name, "DuckDuckGo (Onion)", "the onion engine is the default");
      is((await SearchService.getDefault()).name, "DuckDuckGo (Onion)", "for every window");
      is(engine.getSubmission("tor windows").uri.spec, `https://${onion}/?q=tor+windows`, "searches go to the onion service");
      is(
        engine.getSubmission("tor", "application/x-suggestions+json")?.uri.spec,
        `https://${onion}/ac/?q=tor&type=list`,
        "and so do suggestions",
      );
      is((await SearchService.getEngines()).filter(e => e.name == engine.name).length, 1, "added once");
    } finally {
      const added = SearchService.getEngineByName("DuckDuckGo (Onion)");
      await SearchService.setDefault(before, SearchService.CHANGE_REASON.UNKNOWN);
      await SearchService.setDefaultPrivate(beforePrivate, SearchService.CHANGE_REASON.UNKNOWN);
      if (added) {
        await SearchService.removeEngine(added, SearchService.CHANGE_REASON.UNKNOWN);
      }
      await SpecialPowers.popPrefEnv();
    }

    // A URL that is not a search template: no engine is added, Firefox's
    // default stays.
    await SpecialPowers.pushPrefEnv({
      set: [
        ["aequera.tor.searchEngine", "Broken"],
        ["aequera.tor.searchURL", "https://example.com/no-terms"],
      ],
    });
    await AequeraTorDaemon.setSearchDefault();
    is((await SearchService.getDefault()).name, before.name, "an invalid engine changes nothing");
    await SpecialPowers.popPrefEnv();

    // Empty: Firefox's default stays.
    await SearchService.setDefault(before, SearchService.CHANGE_REASON.UNKNOWN);
    await SpecialPowers.pushPrefEnv({ set: [["aequera.tor.searchEngine", ""]] });
    await AequeraTorDaemon.setSearchDefault();
    is((await SearchService.getDefault()).name, before.name, "empty pref changes nothing");
    await SpecialPowers.popPrefEnv();
  } finally {
    await SearchService.setDefault(before, SearchService.CHANGE_REASON.UNKNOWN);
    await SearchService.setDefaultPrivate(beforePrivate, SearchService.CHANGE_REASON.UNKNOWN);
    if (!separateWasSet) {
      Services.prefs.clearUserPref(separate);
    }
  }
});

// Security levels.

/** Runs `fn` with the level's prefs and settings file restored afterwards
 *  (this test browser must keep its JavaScript engine). */
async function withSecurityLevels(fn) {
  const settings = PathUtils.join(PathUtils.tempDir, "aequera-tor-test-settings.json");
  const saved = AequeraTorDaemon.settingsPath;
  AequeraTorDaemon.settingsPath = () => settings;
  // Restored exactly as they were (the test profile sets some of them).
  const prefs = Services.prefs;
  const before = [AequeraTorModel.SECURITY_LEVEL_PREF, ...AequeraTorModel.securityLevelPrefs("standard").map(([n]) => n)].map(name => {
    const type = prefs.getPrefType(name);
    const user = prefs.prefHasUserValue(name);
    const value = !user
      ? null
      : type == prefs.PREF_BOOL
        ? prefs.getBoolPref(name)
        : type == prefs.PREF_INT
          ? prefs.getIntPref(name)
          : prefs.getStringPref(name);
    return { name, user, value };
  });
  try {
    await fn(settings);
  } finally {
    AequeraTorDaemon.settingsPath = saved;
    for (const { name, user, value } of before) {
      if (!user) {
        prefs.clearUserPref(name);
      } else if (typeof value == "boolean") {
        prefs.setBoolPref(name, value);
      } else if (typeof value == "number") {
        prefs.setIntPref(name, value);
      } else {
        prefs.setStringPref(name, value);
      }
    }
    await IOUtils.remove(settings, { ignoreAbsent: true });
  }
}

add_task(async function test_security_level_switch() {
  await withSecurityLevels(async settings => {
    is(AequeraTorDaemon.securityLevel(), "standard", "Standard unless chosen");
    await AequeraTorDaemon.setSecurityLevel("safer");
    is(AequeraTorDaemon.securityLevel(), "safer");
    is(Services.prefs.getBoolPref("javascript.options.ion"), false, "no JIT");
    is(Services.prefs.getBoolPref("javascript.options.wasm"), false, "no WebAssembly");
    is(Services.prefs.getBoolPref("mathml.disabled"), true, "no MathML");
    is(Services.prefs.getIntPref("media.autoplay.default"), 5, "no autoplay");
    is(Services.prefs.getBoolPref("javascript.enabled"), true, "scripts still run at Safer");
    Assert.deepEqual(await IOUtils.readJSON(settings), { securityLevel: "safer" }, "remembered for the next Tor session");

    await AequeraTorDaemon.setSecurityLevel("nonsense");
    is(AequeraTorDaemon.securityLevel(), "standard", "an unknown level is Standard");
    is(Services.prefs.getBoolPref("javascript.options.ion"), true, "JIT back");
  });
});

add_task(async function test_new_session_starts_at_the_remembered_level() {
  await IOUtils.makeDirectory(TOR_BASE);
  await IOUtils.writeJSON(PathUtils.join(TOR_BASE, "settings.json"), { securityLevel: "safest" });
  AequeraTorLauncher.spawn = instanceSpawn([]);
  try {
    await AequeraTorLauncher.openWindow();
    const profileDir = PathUtils.join(TOR_BASE, "profile");
    const prefs = readUserJs(await IOUtils.readUTF8(PathUtils.join(profileDir, "user.js")));
    is(prefs.get("aequera.tor.securityLevel"), "safest", "the level the last session chose");
    is(prefs.get("javascript.enabled"), false, "its prefs from the start");
    is(prefs.get("svg.disabled"), true);
    is(prefs.get("privacy.resistFingerprinting"), true, "fingerprinting resistance at every level");
    await removeSocketDirOf(profileDir);
  } finally {
    await resetLauncher();
    await IOUtils.remove(PathUtils.join(TOR_BASE, "settings.json"), { ignoreAbsent: true });
  }
});

// The indicator (in the Tor instance only; mounted here by hand).

add_task(async function test_indicator_renders_state() {
  AequeraTor.mountIndicator();
  const button = document.getElementById("aequera-tor-button");
  const panel = document.getElementById("aequera-tor-panel");
  try {
    ok(button && panel, "button and panel");
    is(button.nextElementSibling.id, "nav-bar-customization-target", "at the start of the toolbar, outside customization");

    AequeraTor.render({ status: "bootstrapping", progress: 45, summary: "Loading relay descriptors", detail: "" });
    is(button.getAttribute("label"), "Tor 45%");
    is(button.getAttribute("tor-status"), "bootstrapping");
    ok(!gNotificationBox.getNotificationWithValue("aequera-tor-status"), "no notification while connecting");

    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    AequeraTor.togglePanel();
    await shown;
    is(panel.querySelector(".aequera-tor-status").textContent, "Loading relay descriptors");
    is(panel.querySelector(".aequera-tor-progress").value, 45);
    ok(panel.querySelector(".aequera-tor-new-circuit").hidden, "no new circuit before connecting");
    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    panel.hidePopup();
    await hidden;

    AequeraTor.render({ status: "failed", progress: 45, summary: "Tor stopped", detail: "tor exited (code 1)" });
    is(button.getAttribute("label"), "Tor offline");
    await TestUtils.waitForCondition(() => gNotificationBox.getNotificationWithValue("aequera-tor-status"), "failure notification");
    ok(!panel.querySelector(".aequera-tor-restart").hidden, "restart offered");

    AequeraTor.render({ status: "connected", progress: 100, summary: "Connected to the Tor network", detail: "" });
    is(button.getAttribute("label"), "Tor");
    await TestUtils.waitForCondition(() => !gNotificationBox.getNotificationWithValue("aequera-tor-status"), "notification gone");
    ok(!panel.querySelector(".aequera-tor-new-circuit").hidden, "new circuit offered");

    // The security level radios show the session's level and switch it.
    const radios = [...panel.querySelectorAll(".aequera-tor-security input[type=radio]")];
    Assert.deepEqual(radios.map(r => r.value), ["standard", "safer", "safest"], "Tor Browser's three levels");
    is(radios.find(r => r.checked)?.value, "standard", "Standard checked");
    await withSecurityLevels(async () => {
      const opened = BrowserTestUtils.waitForEvent(panel, "popupshown");
      AequeraTor.togglePanel();
      await opened;
      const safer = radios.find(r => r.value == "safer");
      safer.click();
      await TestUtils.waitForCondition(() => AequeraTorDaemon.securityLevel() == "safer", "level switched");
      is(Services.prefs.getBoolPref("javascript.options.ion"), false, "Safer's prefs applied");
      ok(safer.checked, "Safer checked");
      const closed = BrowserTestUtils.waitForEvent(panel, "popuphidden");
      panel.hidePopup();
      await closed;
    });
    ok(panel.querySelector(".aequera-tor-progress").hidden, "no progress once connected");
  } finally {
    button?.remove();
    panel?.remove();
    AequeraTor.button = null;
    AequeraTor.panel = null;
    AequeraTor.lastStatus = null;
    AequeraTor.clearNotification();
  }
});
