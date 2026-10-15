/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor windows: the Tor instance's side (docs/adr/0004-tor-windows.md).
// Started from the instance's first window, once per process. The instance
// was started offline (-offline, tor-model.js launchArgs), so nothing loads
// before this runs, and nothing ever loads if it does not run:
//
// 1. Enforce: the running-session marker is written, and the prefs that keep
//    traffic on tor (tor-model.js, written to user.js by the ordinary
//    instance) are locked and checked: each must have its value and be
//    locked. If the marker cannot be written or a pref is not in force, the
//    process stays offline for good ("refused"): going online again (Work
//    Offline) is undone, and every channel is sent to a socket that does not
//    exist.
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
//
// On Windows tor listens on a loopback TCP port instead (docs/design/TOR.md,
// Windows). A TCP proxy setting does not fail closed by itself (no port means
// no proxy; a port tor has not bound may be another program's), so there the
// instance stays offline until the current tor reports its listener on that
// port, and goes offline again the moment that tor stops.

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  randomHex,
  readPref,
  removeSocketDir,
  torModel,
  writePref,
} from "chrome://browser/content/aequera/tor/aequera-tor-common.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
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

/** How long tor's last log lines are awaited after it exited. Bounded: a
 *  process that inherited the pipe (a pluggable transport) can hold it open
 *  after tor is gone. */
const LAST_WORDS_MS = 2000;

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

/** SOCKS proxy info: a Unix socket's file: URL with port 0, or a host and
 *  port. */
function proxyInfo(host, port, username, password) {
  return lazy.proxyService.newProxyInfoWithAuth(
    "socks",
    host,
    port,
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
    callback.onProxyFilterResult(proxyInfo(REFUSED_SOCKET_URL, 0, "refused", ""));
  },
};

/**
 * @typedef {object} TorState
 * @property {"idle"|"starting"|"bootstrapping"|"connected"|"failed"|"refused"} status
 * @property {number} progress     bootstrap percent
 * @property {string} summary      tor's bootstrap summary, or the failure
 * @property {string} detail       last warning or error from tor
 * @property {string[]} warnings   what works differently than promised (shown)
 */

export const AequeraTorDaemon = {
  model: null,
  started: false,
  /** The startup in progress or done (ensureStarted). */
  ready: null,

  /** @type {TorState} */
  state: { status: "idle", progress: 0, summary: "", detail: "", warnings: [] },
  listeners: new Set(),

  /** The running tor process; null while none runs or it is being stopped
   *  on purpose (a process that is no longer this is never a failure). */
  proc: null,
  socksPath: "",
  socksUrl: "",
  /** Windows: tor's loopback SOCKS port, and whether the current tor has
   *  reported listening on it (the only state in which this goes online). */
  socksPort: 0,
  listening: false,
  /** tor processes whose exit was seen: their buffered lines may still
   *  name the listener, which no longer holds. */
  exited: new WeakSet(),
  /** Per-site SOCKS passwords: a new one is a new circuit for the site. */
  nonces: new Map(),

  /** Test hook: { prefs, io, proxy, obs } in place of Firefox's services. */
  services: null,

  svc() {
    return this.services ?? { prefs: Services.prefs, io: Services.io, proxy: lazy.proxyService, obs: Services.obs };
  },

  /** Whether tor listens on a loopback TCP port (Windows) rather than a
   *  Unix socket. */
  usesTcp() {
    return AppConstants.platform == "win";
  },

  /** Whether this process is the Tor instance. */
  isInstance() {
    this.model ??= torModel();
    return this.svc().prefs.getBoolPref(this.model.INSTANCE_PREF, false);
  },

  /**
   * Start everything once per process. Safe to call from every window.
   * Returns the startup (also kept as `ready`).
   */
  ensureStarted() {
    if (this.started || !this.isInstance()) {
      return this.ready;
    }
    this.started = true;
    this.model ??= torModel();
    this.ready = this.startup();
    return this.ready;
  },

  /**
   * The instance is offline until this has checked everything (it was
   * started with -offline). Order: the marker (the ordinary instance must
   * never rewrite this profile under it), the locked and checked prefs, the
   * circuit filter; only then online, and tor.
   */
  async startup() {
    const { io, obs } = this.svc();
    obs.addObserver(this, "quit-application");
    const wrong = [];
    try {
      await this.writeMarker();
    } catch (error) {
      console.error("aequera-tor: cannot write the running-session marker", error);
      wrong.push(`the running-session marker (${error?.message ?? error})`);
    }
    if (!this.enforce(wrong)) {
      this.refuse();
      return;
    }
    this.registerFilter();
    if (this.usesTcp()) {
      // Online only once tor reports its listener (onLogLine): nothing else
      // brings it online meanwhile, neither the network link service nor
      // Work Offline (observe).
      io.manageOfflineStatus = false;
      io.offline = true;
      obs.addObserver(this, OFFLINE_TOPIC);
    } else {
      io.offline = false;
    }
    this.startTor().catch(error => this.fail(String(error?.message ?? error)));
    this.setSearchDefault().catch(error => this.warn(`The search engine could not be set: ${error?.message ?? error}`));
  },

  /** Record something the user should know (Tor panel, notification). */
  warn(message) {
    console.warn("aequera-tor:", message);
    this.setState({ warnings: [...this.state.warnings, message] });
  },

  /**
   * The session's search engine (tor-model.js searchEngine: by default
   * DuckDuckGo's onion service, added as a user engine), for normal and
   * private use alike (every window is private). If the onion engine cannot
   * be added, the built-in DuckDuckGo is used and the user is told (its
   * searches leave through an exit relay).
   */
  async setSearchDefault() {
    const prefs = this.svc().prefs;
    this.model ??= torModel();
    const name = prefs.getStringPref(this.model.SEARCH_ENGINE_PREF, "");
    const wanted = this.model.searchEngine({
      name,
      url: prefs.getStringPref(this.model.SEARCH_URL_PREF, ""),
      suggestUrl: prefs.getStringPref(this.model.SEARCH_SUGGEST_URL_PREF, ""),
    });
    if (!wanted) {
      if (name.trim()) {
        this.warn(`The Tor search engine "${name}" has no valid search URL; searches use Firefox's default engine.`);
      }
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
    if (!engine) {
      engine = search.getEngineByName("DuckDuckGo");
      this.warn(
        engine
          ? `${wanted.name} could not be set up; searches use DuckDuckGo through a Tor exit relay.`
          : `${wanted.name} could not be set up; searches use Firefox's default engine.`,
      );
      if (!engine) {
        return;
      }
    }
    const reason = search.CHANGE_REASON.UNKNOWN;
    await search.setDefault(engine, reason);
    await search.setDefaultPrivate(engine, reason);
  },

  /** The session's security level (tor-model.js SECURITY_LEVELS). */
  securityLevel() {
    this.model ??= torModel();
    return this.model.securityLevel(this.svc().prefs.getStringPref(this.model.SECURITY_LEVEL_PREF, ""));
  },

  /**
   * Switch the security level: its prefs now (pages loaded from now on
   * follow them; the JavaScript engine's in new content processes), and
   * remembered for the next Tor session in <profile>/tor/settings.json (the
   * Tor profile itself is thrown away). All or nothing: a pref that cannot
   * be set puts every pref back and rejects. Not remembered: applied, and
   * the user is told.
   *
   * @param {string} level  "standard" | "safer" | "safest"
   */
  async setSecurityLevel(level) {
    this.model ??= torModel();
    if (this.model.securityLevel(level, null) === null) {
      throw new Error(`unknown security level: ${level}`);
    }
    const prefs = this.svc().prefs;
    const levelPrefs = this.model.securityLevelPrefs(level);
    const before = levelPrefs.map(([name]) => [name, prefs.prefHasUserValue(name), readPref(name, prefs)]);
    try {
      for (const [name, value] of levelPrefs) {
        writePref(name, value, prefs);
      }
    } catch (error) {
      for (const [name, hadUserValue, value] of before) {
        if (hadUserValue) {
          writePref(name, value, prefs);
        } else {
          prefs.clearUserPref(name);
        }
      }
      throw error;
    }
    prefs.setStringPref(this.model.SECURITY_LEVEL_PREF, level);
    try {
      await IOUtils.writeJSON(this.settingsPath(), { securityLevel: level });
    } catch (error) {
      this.warn(`The security level applies now but could not be remembered for the next Tor session (${error?.message ?? error}).`);
      return;
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

  /** tor failed: stopped (offline first) and the user told. */
  fail(summary) {
    this.stopTor();
    this.setState({ status: "failed", summary });
  },

  /**
   * Lock the required prefs at the values the instance needs and check them:
   * each must have its value and be locked (a lock that failed counts as
   * not in force).
   *
   * @returns {string[]} what is not in force (empty: browsing may go on)
   */
  check() {
    const { prefs, io } = this.svc();
    let wanted;
    if (this.usesTcp()) {
      this.socksPort = prefs.getIntPref(this.model.SOCKS_PORT_PREF, 0);
      const portProblem = this.model.socksPortProblem(this.socksPort);
      if (portProblem) {
        return [`aequera.tor.socksPort (${portProblem})`];
      }
      wanted = new Map(this.model.instancePrefs({ socksPort: this.socksPort, level: this.securityLevel() }));
    } else {
      this.socksPath = prefs.getStringPref(this.model.SOCKS_PATH_PREF, "");
      const pathProblem = this.model.socketPathProblem(this.socksPath);
      if (pathProblem) {
        return [`aequera.tor.socksPath (${pathProblem})`];
      }
      this.socksUrl = io.newFileURI(new lazy.FileUtils.File(this.socksPath)).spec;
      wanted = new Map(
        this.model.instancePrefs({ socksPath: this.socksPath, socksUrl: this.socksUrl, level: this.securityLevel() }),
      );
    }
    const defaults = prefs.getDefaultBranch("");
    const failed = new Set();
    for (const name of this.model.requiredNames()) {
      try {
        writePref(name, wanted.get(name), defaults);
        prefs.lockPref(name);
      } catch (error) {
        console.error("aequera-tor: cannot lock", name, error);
        failed.add(name);
      }
    }
    return this.model.checkRequired(
      name => readPref(name, prefs),
      wanted,
      name => !failed.has(name) && prefs.prefIsLocked(name),
    );
  },

  /**
   * @param {string[]} [alsoWrong]  problems found before the prefs
   * @returns {boolean} whether browsing may go on
   */
  enforce(alsoWrong = []) {
    let checked;
    try {
      checked = this.check();
    } catch (error) {
      // A pref of the wrong type, or anything else that stops the check:
      // not in force (refused), never an unchecked instance.
      console.error("aequera-tor: the checks failed", error);
      checked = [`the instance prefs (${error?.message ?? error})`];
    }
    const wrong = [...alsoWrong, ...checked];
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
    const { io, proxy, obs } = this.svc();
    io.manageOfflineStatus = false;
    io.offline = true;
    proxy.registerChannelFilter(refusalFilter, FILTER_POSITION);
    obs.addObserver(this, OFFLINE_TOPIC);
  },

  /** The filter a refused instance sends every channel through. */
  refusalFilter,

  // nsIProtocolProxyChannelFilter

  QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter", "nsIObserver"]),

  registerFilter() {
    this.svc().proxy.registerChannelFilter(this, FILTER_POSITION);
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
    const nonce = this.nonceFor(key);
    callback.onProxyFilterResult(
      this.usesTcp()
        ? proxyInfo(this.model.LOOPBACK, this.socksPort, key, nonce)
        : proxyInfo(this.socksUrl, 0, key, nonce),
    );
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
    const bundled = PathUtils.join(bundle, AppConstants.platform == "win" ? "tor.exe" : "tor");
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
    const tcp = this.usesTcp();
    if (tcp) {
      const portProblem = this.model.socksPortProblem(this.socksPort);
      if (portProblem) {
        throw new Error(`tor's SOCKS port is ${portProblem}`);
      }
    } else {
      const pathProblem = this.model.socketPathProblem(this.socksPath);
      if (pathProblem) {
        throw new Error(`tor's socket path is ${pathProblem}`);
      }
    }
    const dataDir = Services.prefs.getStringPref(this.model.DATA_DIR_PREF, "");
    if (!dataDir || !PathUtils.isAbsolute(dataDir)) {
      throw new Error("no tor data directory (aequera.tor.dataDir)");
    }
    const tor = await this.findTor();
    await IOUtils.makeDirectory(dataDir, { permissions: 0o700 });
    await IOUtils.setPermissions(dataDir, 0o700);
    if (!tcp) {
      const socketDir = this.model.socketDir(this.socksPath);
      await IOUtils.makeDirectory(socketDir, { permissions: 0o700 });
      await IOUtils.setPermissions(socketDir, 0o700);
      await IOUtils.remove(this.socksPath, { ignoreAbsent: true });
    }

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
      ...(tcp ? { socksPort: this.socksPort } : { socksPath: this.socksPath }),
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
    if (tor.bundle && !tcp) {
      // The expert bundle's tor has no RPATH: its libevent and OpenSSL sit
      // beside it, found as Tor Browser finds them. (Windows: the bundle's
      // tor.exe is self-contained.)
      const name = AppConstants.platform == "macosx" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
      options.environment = { [name]: tor.bundle };
      options.environmentAppend = true;
    }
    await this.superviseTor(await lazy.Subprocess.call(options));
  },

  /**
   * Follow a started tor until it exits. On exit: offline at once (Windows:
   * the port is free), and its listener lines ignored from then on; its
   * last lines (the error that ended it) are awaited, briefly, for the
   * verdict.
   */
  async superviseTor(proc) {
    this.proc = proc;
    this.setState({ status: "bootstrapping", summary: "Connecting to the Tor network" });
    const reading = this.readLog(proc);
    let exitCode = -1;
    try {
      ({ exitCode } = await proc.wait());
    } catch {}
    this.exited.add(proc);
    if (this.proc === proc) {
      this.setListening(false);
    }
    await Promise.race([reading, new Promise(resolve => lazy.setTimeout(resolve, LAST_WORDS_MS))]);
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
    if (entry.kind == "listener") {
      // Over TCP: tor itself holds the port now (its own report, from the
      // child this process started). Any other address or port is not ours,
      // nor a line read after that tor exited.
      if (
        this.usesTcp() &&
        !this.exited.has(proc) &&
        entry.address == this.model.LOOPBACK &&
        entry.port === this.socksPort
      ) {
        this.setListening(true);
      }
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

  /** Start tor again, only after it failed (never a second tor beside a
   *  running or starting one, never in a refused instance). */
  async restart() {
    if (!this.started || this.state.status != "failed") {
      return;
    }
    // Not "failed" from here on: a second click starts no second tor.
    this.setState({ status: "starting", progress: 0, summary: "Starting Tor", detail: "" });
    await this.stopTor();
    this.startTor().catch(error => this.fail(String(error?.message ?? error)));
  },

  /**
   * Windows: online exactly while the current tor reports its listener.
   * Offline first when it stops, before anything else can bind the freed
   * port. No effect over a Unix socket (online from startup) or when
   * refused (offline for good).
   */
  setListening(listening) {
    if (!this.usesTcp() || this.state.status == "refused") {
      return;
    }
    this.listening = listening;
    this.svc().io.offline = !listening;
  },

  async stopTor() {
    const proc = this.proc;
    this.proc = null;
    this.setListening(false);
    try {
      await proc?.kill();
    } catch {}
  },

  /** The ordinary instance reads this to tell a running Tor instance. */
  markerPath() {
    // The instance's profile is <ordinary profile>/tor/profile.
    return PathUtils.join(PathUtils.parent(PathUtils.profileDir), "running");
  },

  /** Write the marker (this process's pid); rejects when it cannot. */
  writeMarker() {
    return IOUtils.writeUTF8(this.markerPath(), String(Services.appinfo.processID));
  },

  observe(_subject, topic, data) {
    const { io, proxy, obs } = this.svc();
    if (topic == OFFLINE_TOPIC) {
      // Refused, or (Windows) no listener reported: Work Offline cannot
      // bring it online.
      if (data == "online" && (this.state.status == "refused" || (this.usesTcp() && !this.listening))) {
        io.offline = true;
      }
      return;
    }
    if (topic != "quit-application") {
      return;
    }
    obs.removeObserver(this, "quit-application");
    // Each on its own: one that was never registered (a quit during the
    // startup) does not keep the others registered.
    const refused = this.state.status == "refused";
    for (const unregister of [
      () => obs.removeObserver(this, OFFLINE_TOPIC),
      () => proxy.unregisterChannelFilter(refused ? refusalFilter : this),
    ]) {
      try {
        unregister();
      } catch {}
    }
    const proc = this.proc;
    this.proc = null;
    this.setListening(false);
    try {
      proc?.kill()?.catch?.(() => {});
    } catch {}
    // Leave nothing behind but tor's data directory. Only a socket path in a
    // directory the launcher named is ever removed (removeSocketDir).
    removeSocketDir(this.model, this.socksPath).catch(() => {});
    IOUtils.remove(this.markerPath(), { ignoreAbsent: true }).catch(() => {});
  },
};
