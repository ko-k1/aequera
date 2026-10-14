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

function fakeProcess(exitCode = 0) {
  return {
    stdout: { readString: async () => "" },
    wait: async () => ({ exitCode }),
    kill: async () => ({ exitCode }),
  };
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
  AequeraTorLauncher.spawn = null;
  AequeraTorLauncher.child = null;
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
  AequeraTorLauncher.spawn = async options => {
    calls.push(options);
    return fakeProcess();
  };
  const profileDir = PathUtils.join(TOR_BASE, "profile");

  // Something left from an earlier session: removed.
  await IOUtils.makeDirectory(profileDir);
  await IOUtils.writeUTF8(PathUtils.join(profileDir, "leftover"), "x");

  await AequeraTorLauncher.openWindow("https://example.com/");
  is(calls.length, 1, "one process started");
  const { command, arguments: args, environment, environmentAppend } = calls[0];
  is(command, Services.dirsvc.get("XREExeF", Ci.nsIFile).path, "this browser's own binary");
  const profileAt = args.indexOf("-profile");
  is(args[profileAt + 1], profileDir, "the Tor profile");
  ok(args.includes("-private-window"), "a private window");
  is(args.at(-1), "https://example.com/", "with the link");
  ok(environmentAppend, "environment inherited");
  Assert.strictEqual(environment.XRE_PROFILE_PATH, null, "a restart's profile variable is removed");
  Assert.strictEqual(environment.MOZ_MARIONETTE, null, "automation is not inherited");
  Assert.strictEqual(environment.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, null, "nor system access for it");

  ok(!(await IOUtils.exists(PathUtils.join(profileDir, "leftover"))), "old profile removed");
  const prefs = readUserJs(await IOUtils.readUTF8(PathUtils.join(profileDir, "user.js")));
  is(prefs.get("aequera.tor.instance"), true, "marks the instance");
  is(prefs.get("network.proxy.type"), 1, "manual proxy");
  is(prefs.get("network.dns.disabled"), true, "no local DNS");
  is(prefs.get("network.proxy.failover_direct"), false, "no direct failover");
  is(prefs.get("browser.privatebrowsing.autostart"), true, "always private");
  is(prefs.get("aequera.tor.dataDir"), PathUtils.join(TOR_BASE, "data"), "tor's data kept beside the profile");

  const socksPath = prefs.get("aequera.tor.socksPath");
  ok(socksPath.endsWith("/socks"), "a socket path");
  is(prefs.get("network.proxy.socks"), Services.io.newFileURI(new TorFileUtils.File(socksPath)).spec, "SOCKS at that socket");
  const socketDir = PathUtils.parent(socksPath);
  is((await IOUtils.stat(socketDir)).permissions & 0o777, 0o700, "socket directory private to the user");
  ok(!(await IOUtils.exists(socksPath)), "nothing listens before tor");
  is((await IOUtils.stat(PathUtils.join(TOR_BASE, "data"))).permissions & 0o777, 0o700, "tor data private");
  await IOUtils.remove(socketDir, { recursive: true });
});

add_task(async function test_launch_while_running_keeps_the_profile() {
  const calls = [];
  AequeraTorLauncher.spawn = async options => {
    calls.push(options);
    return fakeProcess();
  };
  const profileDir = PathUtils.join(TOR_BASE, "profile");
  await IOUtils.makeDirectory(profileDir);
  await IOUtils.writeUTF8(PathUtils.join(profileDir, "in-use"), "x");
  // The running instance's marker.
  await IOUtils.writeUTF8(PathUtils.join(TOR_BASE, "running"), "1234");

  await AequeraTorLauncher.openWindow();
  is(calls.length, 1, "a remoting client started");
  ok(await IOUtils.exists(PathUtils.join(profileDir, "in-use")), "the running instance's profile is untouched");
  ok(!calls[0].arguments.some(a => a.startsWith("http")), "no URL");
  is(AequeraTorLauncher.child, null, "a remoting client is not the instance");
  await IOUtils.remove(PathUtils.join(TOR_BASE, "running"));
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
  daemon.socksPath = PathUtils.join(base, "sock", "socks");
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
