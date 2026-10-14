/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor windows: the Tor instance's side (docs/adr/0004-tor-windows.md).
// Started from the instance's first window, once per process. The instance
// was started offline (-offline, tor-model.js launchArgs), so nothing loads
// before this runs, and nothing ever loads if it does not run:
//
// 1. Enforce: the prefs that keep traffic on tor (tor-model.js, written to
//    user.js by the ordinary instance) are locked and checked. If one is not
//    in force, the process stays offline for good ("refused"): going online
//    again (Work Offline) is undone, and every channel is sent to a socket
//    that does not exist.
// 2. Circuits: a proxy channel filter, applied after every other filter,
//    gives each channel tor's SOCKS socket with credentials named after its
//    top-level site, so each site gets its own circuits (IsolateSOCKSAuth).
//    Then the process goes online.
// 3. tor: started with a configuration of its own (never the system torrc),
//    its log read for bootstrap progress and errors, stopped at quit (and
//    exits by itself with this process: __OwningControllerProcess).
//
// Until tor listens, its socket does not exist and every load fails: the
// fail-closed state. Windows render `state` (aequera-tor.js).

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { randomHex, torModel } from "chrome://browser/content/aequera/tor/aequera-tor-common.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "proxyService",
  "@mozilla.org/network/protocol-proxy-service;1",
  Ci.nsIProtocolProxyService,
);

/** After every other channel filter (extensions, IP Protection, the new tab
 *  page's): whatever they chose, the result is tor's socket. */
const FILTER_POSITION = 0xffffffff;

/** Where a refused instance sends every channel: nothing listens there. */
const REFUSED_SOCKET_URL = "file:///nonexistent/aequera-tor-refused/socks";

/** Circuit keys kept per session; the oldest is dropped beyond this (a site
 *  coming back after that gets new credentials: a new circuit). */
const MAX_CIRCUIT_KEYS = 1000;

const OFFLINE_TOPIC = "network:offline-status-changed";

/** The site of a URI (eTLD+1, or the host for IP addresses and the like). */
function siteOf(uri) {
  if (!uri) {
    return "";
  }
  try {
    return Services.eTLD.getSchemelessSite(uri);
  } catch {
    try {
      return uri.host;
    } catch {
      return "";
    }
  }
}

/** The site of a web partition key ("(https,example.com)"). Other schemes'
 *  keys name browser pages (the JSON viewer's is "(resource,devtools)"),
 *  never the site a request belongs to: the top-level page decides then. */
function siteOfPartitionKey(key) {
  if (!key || !/^\(https?,/.test(key)) {
    return "";
  }
  try {
    return ChromeUtils.getBaseDomainFromPartitionKey(key);
  } catch {
    return "";
  }
}

function proxyInfo(url, username, password) {
  return lazy.proxyService.newProxyInfoWithAuth(
    "socks",
    url,
    0,
    username,
    password,
    "",
    "",
    Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
    0xffffffff,
    null,
  );
}

/** Sends every channel nowhere: the refused instance's filter. */
const refusalFilter = {
  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),
  applyFilter(_channel, _defaultProxyInfo, callback) {
    callback.onProxyFilterResult(proxyInfo(REFUSED_SOCKET_URL, "refused", ""));
  },
};

/**
 * @typedef {object} TorState
 * @property {"idle"|"starting"|"bootstrapping"|"connected"|"failed"|"refused"} status
 * @property {number} progress     bootstrap percent
 * @property {string} summary      tor's bootstrap summary, or the failure
 * @property {string} detail       last warning or error from tor
 */

export const AequeraTorDaemon = {
  model: null,
  started: false,

  /** @type {TorState} */
  state: { status: "idle", progress: 0, summary: "", detail: "" },
  listeners: new Set(),

  /** The running tor process; null while none runs or it is being stopped
   *  on purpose (a process that is no longer this is never a failure). */
  proc: null,
  socksPath: "",
  socksUrl: "",
  /** Per-site SOCKS passwords: a new one is a new circuit for the site. */
  nonces: new Map(),

  /** Whether this process is the Tor instance. */
  isInstance() {
    return Services.prefs.getBoolPref("aequera.tor.instance", false);
  },

  /** Start everything once per process. Safe to call from every window. */
  ensureStarted() {
    if (this.started || !this.isInstance()) {
      return;
    }
    this.started = true;
    this.model ??= torModel();
    // Running, whether it may browse or not: the ordinary instance must
    // never rewrite this profile under it.
    this.writeMarker();
    Services.obs.addObserver(this, "quit-application");
    if (!this.enforce()) {
      this.refuse();
      return;
    }
    this.registerFilter();
    Services.io.offline = false;
    this.startTor().catch(error => this.fail(String(error?.message ?? error)));
    this.setSearchDefault().catch(error => console.error("aequera-tor: search default not set", error));
  },

  /**
   * The session's search engine (tor-model.js searchEngine: by default
   * DuckDuckGo's onion service, added as a user engine), for normal and
   * private use alike (every window is private). It falls back to the
   * built-in DuckDuckGo, then to Firefox's default.
   */
  async setSearchDefault() {
    const prefs = Services.prefs;
    this.model ??= torModel();
    const wanted = this.model.searchEngine({
      name: prefs.getStringPref("aequera.tor.searchEngine", ""),
      url: prefs.getStringPref("aequera.tor.searchURL", ""),
      suggestUrl: prefs.getStringPref("aequera.tor.searchSuggestURL", ""),
    });
    if (!wanted) {
      return;
    }
    const search = lazy.SearchService;
    await search.init();
    let engine = search.getEngineByName(wanted.name);
    if (!engine && wanted.url) {
      try {
        engine = await search.addUserEngine(wanted);
      } catch (error) {
        console.error(`aequera-tor: cannot add the ${wanted.name} search engine`, error);
      }
    }
    engine ??= search.getEngineByName("DuckDuckGo");
    if (!engine) {
      console.warn(`aequera-tor: no search engine named ${wanted.name}`);
      return;
    }
    const reason = search.CHANGE_REASON.UNKNOWN;
    await search.setDefault(engine, reason);
    await search.setDefaultPrivate(engine, reason);
  },

  /** The session's security level (tor-model.js SECURITY_LEVELS). */
  securityLevel() {
    this.model ??= torModel();
    return this.model.securityLevel(Services.prefs.getStringPref(this.model.SECURITY_LEVEL_PREF, ""));
  },

  /**
   * Switch the security level: its prefs now (pages loaded from now on
   * follow them; the JavaScript engine's in new content processes), and
   * remembered for the next Tor session in <profile>/tor/settings.json (the
   * Tor profile itself is thrown away).
   *
   * @param {string} level  "standard" | "safer" | "safest"
   */
  async setSecurityLevel(level) {
    this.model ??= torModel();
    level = this.model.securityLevel(level);
    const prefs = Services.prefs;
    for (const [name, value] of this.model.securityLevelPrefs(level)) {
      if (typeof value == "boolean") {
        prefs.setBoolPref(name, value);
      } else {
        prefs.setIntPref(name, value);
      }
    }
    prefs.setStringPref(this.model.SECURITY_LEVEL_PREF, level);
    try {
      await IOUtils.writeJSON(this.settingsPath(), { securityLevel: level });
    } catch (error) {
      console.error("aequera-tor: cannot remember the security level", error);
    }
    this.setState({});
  },

  /** What Tor sessions remember: <ordinary profile>/tor/settings.json (the
   *  instance's profile is <ordinary profile>/tor/profile). */
  settingsPath() {
    return PathUtils.join(PathUtils.parent(PathUtils.profileDir), "settings.json");
  },

  /** Listen to state changes; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },

  setState(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("aequera-tor: state listener failed", error);
      }
    }
  },

  fail(summary) {
    this.setState({ status: "failed", summary });
  },

  /**
   * Lock the required prefs at the values the instance needs and check them.
   *
   * @returns {string[]} what is not in force (empty: browsing may go on)
   */
  check() {
    const prefs = Services.prefs;
    this.socksPath = prefs.getStringPref(this.model.SOCKS_PATH_PREF, "");
    const pathProblem = this.model.socketPathProblem(this.socksPath);
    if (!pathProblem) {
      this.socksUrl = Services.io.newFileURI(new lazy.FileUtils.File(this.socksPath)).spec;
    }
    const wanted = new Map(this.model.instancePrefs({ socksPath: this.socksPath, socksUrl: this.socksUrl || "file:///" }));
    const defaults = prefs.getDefaultBranch("");
    for (const name of this.model.requiredNames()) {
      const value = wanted.get(name);
      try {
        if (typeof value == "boolean") {
          defaults.setBoolPref(name, value);
        } else if (typeof value == "number") {
          defaults.setIntPref(name, value);
        } else {
          defaults.setStringPref(name, value);
        }
        prefs.lockPref(name);
      } catch (error) {
        console.error("aequera-tor: cannot lock", name, error);
      }
    }
    const read = name => {
      switch (prefs.getPrefType(name)) {
        case prefs.PREF_BOOL:
          return prefs.getBoolPref(name);
        case prefs.PREF_INT:
          return prefs.getIntPref(name);
        case prefs.PREF_STRING:
          return prefs.getStringPref(name);
      }
      return undefined;
    };
    return pathProblem ? [`aequera.tor.socksPath (${pathProblem})`] : this.model.checkRequired(read, this.socksUrl);
  },

  /** @returns {boolean} whether browsing may go on */
  enforce() {
    const wrong = this.check();
    if (wrong.length) {
      this.setState({
        status: "refused",
        summary: "This window is not configured for Tor, so it stays offline.",
        detail: `Not in force: ${wrong.join(", ")}`,
      });
      console.error("aequera-tor: refusing to browse; not in force:", wrong);
      return false;
    }
    return true;
  },

  /** Offline for good, and every channel sent nowhere should it go online. */
  refuse() {
    Services.io.manageOfflineStatus = false;
    Services.io.offline = true;
    lazy.proxyService.registerChannelFilter(refusalFilter, FILTER_POSITION);
    Services.obs.addObserver(this, OFFLINE_TOPIC);
  },

  // nsIProtocolProxyChannelFilter

  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter", "nsIObserver"]),

  registerFilter() {
    lazy.proxyService.registerChannelFilter(this, FILTER_POSITION);
  },

  /** The circuit key of a channel (tor-model.js isolationKey). */
  keyFor(channel) {
    const facts = {};
    const loadInfo = channel.loadInfo;
    facts.topLevelDocument = loadInfo?.externalContentPolicyType == Ci.nsIContentPolicy.TYPE_DOCUMENT;
    if (facts.topLevelDocument) {
      facts.uriSite = siteOf(channel.URI);
    } else if (loadInfo) {
      try {
        facts.partitionSite =
          siteOfPartitionKey(loadInfo.cookieJarSettings?.partitionKey) ||
          siteOfPartitionKey(loadInfo.originAttributes?.partitionKey);
      } catch {}
      facts.firstPartyDomain = loadInfo.originAttributes?.firstPartyDomain;
      try {
        facts.topSite = siteOf(loadInfo.browsingContext?.top?.currentURI);
      } catch {}
    }
    return this.model.isolationKey(facts);
  },

  setNonce(key, nonce) {
    this.nonces.delete(key);
    this.nonces.set(key, nonce);
    while (this.nonces.size > MAX_CIRCUIT_KEYS) {
      this.nonces.delete(this.nonces.keys().next().value);
    }
  },

  nonceFor(key) {
    let nonce = this.nonces.get(key);
    if (!nonce) {
      nonce = randomHex();
      this.setNonce(key, nonce);
    }
    return nonce;
  },

  applyFilter(channel, _defaultProxyInfo, callback) {
    let key = this.model.UNKNOWN_SITE;
    try {
      key = this.keyFor(channel);
    } catch (error) {
      console.error("aequera-tor: circuit key failed", error);
    }
    callback.onProxyFilterResult(proxyInfo(this.socksUrl, key, this.nonceFor(key)));
  },

  /** New circuits for a site: the next connections use new credentials. */
  newCircuitFor(site) {
    const key = this.model.isolationKey({ topSite: site });
    this.setNonce(key, randomHex());
    return key;
  },

  /** The circuit key for a page (what newCircuitFor takes). */
  siteForURI(uri) {
    return siteOf(uri);
  },

  // tor

  /** Where a build carries the Tor Project's tor expert bundle
   *  (tools/tor/fetch-bundle.sh): <app>/tor. */
  bundleDir() {
    return PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "tor");
  },

  /**
   * The tor to run: aequera.tor.executable when set (the user's choice),
   * else the bundled tor (a directory with the bundle's marker file), else
   * `tor` on PATH.
   *
   * @returns {Promise<{ path: string, bundle: string|null }>} bundle: the
   *   bundle directory (its libraries and GeoIP files), for the bundled tor
   */
  async findTor() {
    const configured = Services.prefs.getStringPref(this.model.EXECUTABLE_PREF, "");
    if (configured) {
      if (!PathUtils.isAbsolute(configured) || !(await IOUtils.exists(configured))) {
        throw new Error(`tor not found at ${configured} (aequera.tor.executable)`);
      }
      return { path: configured, bundle: null };
    }
    const bundle = this.bundleDir();
    const bundled = PathUtils.join(bundle, "tor");
    if ((await IOUtils.exists(PathUtils.join(bundle, "aequera-tor-bundle.json"))) && (await IOUtils.exists(bundled))) {
      return { path: bundled, bundle };
    }
    try {
      return { path: await lazy.Subprocess.pathSearch("tor"), bundle: null };
    } catch {
      throw new Error("tor not found: this build has no bundled tor and none is on PATH (or set aequera.tor.executable)");
    }
  },

  async startTor() {
    this.setState({ status: "starting", progress: 0, summary: "Starting Tor", detail: "" });
    const pathProblem = this.model.socketPathProblem(this.socksPath);
    if (pathProblem) {
      throw new Error(`tor's socket path is ${pathProblem}`);
    }
    const dataDir = Services.prefs.getStringPref(this.model.DATA_DIR_PREF, "");
    if (!dataDir || !PathUtils.isAbsolute(dataDir)) {
      throw new Error("no tor data directory (aequera.tor.dataDir)");
    }
    const tor = await this.findTor();
    await IOUtils.makeDirectory(dataDir, { permissions: 0o700 });
    await IOUtils.setPermissions(dataDir, 0o700);
    const socketDir = this.model.socketDir(this.socksPath);
    await IOUtils.makeDirectory(socketDir, { permissions: 0o700 });
    await IOUtils.setPermissions(socketDir, 0o700);
    await IOUtils.remove(this.socksPath, { ignoreAbsent: true });

    const configDir = PathUtils.parent(dataDir);
    const torrcPath = PathUtils.join(configDir, "torrc");
    const defaultsPath = PathUtils.join(configDir, "torrc-defaults");
    // The bundled tor's GeoIP databases, when it brings them.
    const bundleFile = async name => {
      const path = tor.bundle && PathUtils.join(tor.bundle, name);
      return path && (await IOUtils.exists(path)) ? path : null;
    };
    const torrc = this.model.torrc({
      dataDir,
      socksPath: this.socksPath,
      ownerPid: Services.appinfo.processID,
      geoipFile: await bundleFile("geoip"),
      geoip6File: await bundleFile("geoip6"),
    });
    await IOUtils.writeUTF8(torrcPath, torrc);
    await IOUtils.writeUTF8(defaultsPath, "");

    const options = {
      command: tor.path,
      arguments: ["-f", torrcPath, "--defaults-torrc", defaultsPath],
      stderr: "stdout",
    };
    if (tor.bundle) {
      // The expert bundle's tor has no RPATH: its libevent and OpenSSL sit
      // beside it, found as Tor Browser finds them.
      const name = AppConstants.platform == "macosx" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
      options.environment = { [name]: tor.bundle };
      options.environmentAppend = true;
    }
    const proc = await lazy.Subprocess.call(options);
    this.proc = proc;
    this.setState({ status: "bootstrapping", summary: "Connecting to the Tor network" });
    const reading = this.readLog(proc);
    const { exitCode } = await proc.wait();
    // Its last lines (the error that ended it) before the verdict.
    await reading;
    // Not this anymore: stopped on purpose (restart, quit).
    if (this.proc === proc) {
      this.proc = null;
      const reason = this.state.detail || `tor exited (code ${exitCode})`;
      this.setState({ status: "failed", summary: "Tor stopped", detail: reason });
    }
  },

  async readLog(proc) {
    let pending = "";
    try {
      for (;;) {
        const chunk = await proc.stdout.readString();
        if (chunk === "") {
          break;
        }
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          this.onLogLine(proc, line);
        }
      }
    } catch {
      // The pipe closed with the process.
    }
    if (pending) {
      this.onLogLine(proc, pending);
    }
  },

  /** A line of `proc`'s log; only the current tor's lines change the state
   *  (a stopped one's last words never reach a restarted session). */
  onLogLine(proc, line) {
    if (proc !== this.proc) {
      return;
    }
    const entry = this.model.parseLogLine(line);
    if (!entry) {
      return;
    }
    if (entry.kind == "bootstrap") {
      const done = entry.progress >= 100;
      this.setState({
        status: done ? "connected" : "bootstrapping",
        progress: entry.progress,
        summary: done ? "Connected to the Tor network" : entry.summary,
        detail: done ? "" : this.state.detail,
      });
    } else {
      this.setState({ detail: entry.message });
    }
  },

  /** Stop tor and start it again (from a failed state). */
  async restart() {
    if (!this.started || this.state.status == "refused") {
      return;
    }
    await this.stopTor();
    this.startTor().catch(error => this.fail(String(error?.message ?? error)));
  },

  async stopTor() {
    const proc = this.proc;
    this.proc = null;
    try {
      await proc?.kill();
    } catch {}
  },

  /** The ordinary instance reads this to tell a running Tor instance. */
  markerPath() {
    // The instance's profile is <ordinary profile>/tor/profile.
    return PathUtils.join(PathUtils.parent(PathUtils.profileDir), "running");
  },

  writeMarker() {
    IOUtils.writeUTF8(this.markerPath(), String(Services.appinfo.processID)).catch(error =>
      console.error("aequera-tor: cannot write marker", error),
    );
  },

  observe(_subject, topic, data) {
    if (topic == OFFLINE_TOPIC) {
      // Refused: Work Offline cannot bring it online.
      if (data == "online") {
        Services.io.offline = true;
      }
      return;
    }
    if (topic != "quit-application") {
      return;
    }
    Services.obs.removeObserver(this, "quit-application");
    if (this.state.status == "refused") {
      Services.obs.removeObserver(this, OFFLINE_TOPIC);
      lazy.proxyService.unregisterChannelFilter(refusalFilter);
    } else {
      lazy.proxyService.unregisterChannelFilter(this);
    }
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.kill();
    } catch {}
    // Leave nothing behind but tor's data directory. Only a socket path in a
    // directory the launcher named is ever removed (socketPathProblem).
    if (!this.model.socketPathProblem(this.socksPath)) {
      IOUtils.remove(this.model.socketDir(this.socksPath), { recursive: true, ignoreAbsent: true }).catch(() => {});
    }
    IOUtils.remove(this.markerPath(), { ignoreAbsent: true }).catch(() => {});
  },
};
