/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor windows: the Tor instance's side (docs/adr/0004-tor-windows.md).
// Started from the instance's first window, once per process:
//
// 1. Enforce: the prefs that keep traffic on tor (tor-model.js, written to
//    user.js by the ordinary instance) are locked; if one is not in force,
//    the process goes offline and stays there ("refused").
// 2. Circuits: a proxy channel filter, applied after every other filter,
//    gives each channel tor's SOCKS socket with credentials named after its
//    top-level site, so each site gets its own circuits (IsolateSOCKSAuth).
// 3. tor: started with a configuration of its own (never the system torrc),
//    its log read for bootstrap progress and errors, stopped at quit (and
//    exits by itself with this process: __OwningControllerProcess).
//
// Until tor listens, its socket does not exist and every load fails: the
// fail-closed state. Windows render `state` (aequera-tor.js).

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

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

const MODEL_URL = "chrome://browser/content/aequera/tor/tor-model.js";

/** After every other channel filter (extensions, IP Protection, the new tab
 *  page's): whatever they chose, the result is tor's socket. */
const FILTER_POSITION = 0xffffffff;

/** tor log lines kept for the panel. */
const LOG_LINES = 40;

function loadModel() {
  const scope = {};
  Services.scriptloader.loadSubScript(MODEL_URL, scope);
  return scope.AequeraTorModel;
}

function randomToken() {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[^0-9a-f]/g, "");
}

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
  log: [],

  proc: null,
  /** Set while tor is stopped on purpose (restart, quit): not a failure. */
  stopping: false,
  socksPath: "",
  socksUrl: "",
  /** Per-site SOCKS passwords: a new one is a new circuit for the site. */
  nonces: new Map(),

  /** Test hook: replaces Subprocess.call. */
  spawn: null,

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
    this.model ??= loadModel();
    if (!this.enforce()) {
      return;
    }
    this.registerFilter();
    Services.obs.addObserver(this, "quit-application");
    this.writeMarker();
    this.startTor().catch(error => this.fail(String(error?.message ?? error)));
    this.setSearchDefault().catch(error => console.error("aequera-tor: search default not set", error));
  },

  /** The session's search engine (aequera.tor.searchEngine), for normal and
   *  private use alike (every window is private). Missing: Firefox's. */
  async setSearchDefault() {
    const name = Services.prefs.getStringPref("aequera.tor.searchEngine", "");
    if (!name) {
      return;
    }
    const search = lazy.SearchService;
    await search.init();
    const engine = search.getEngineByName(name);
    if (!engine) {
      console.warn(`aequera-tor: no search engine named ${name}`);
      return;
    }
    const reason = search.CHANGE_REASON.UNKNOWN;
    await search.setDefault(engine, reason);
    await search.setDefaultPrivate(engine, reason);
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
   * Lock the required prefs at the values the instance needs and check
   * them. On any mismatch the whole process goes offline: nothing loads.
   *
   * @returns {boolean} whether browsing may go on
   */
  enforce() {
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
    const wrong = pathProblem ? ["aequera.tor.socksPath"] : this.model.checkRequired(read, this.socksUrl);
    if (wrong.length) {
      Services.io.manageOfflineStatus = false;
      Services.io.offline = true;
      this.setState({
        status: "refused",
        summary: "This window is not configured for Tor, so it stays offline.",
        detail: `Not in force: ${wrong.join(", ")}`,
      });
      console.error("aequera-tor: refusing to browse; prefs not in force:", wrong);
      return false;
    }
    return true;
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

  nonceFor(key) {
    let nonce = this.nonces.get(key);
    if (!nonce) {
      nonce = randomToken();
      this.nonces.set(key, nonce);
    }
    return nonce;
  },

  /** tor's SOCKS proxy with the credentials of a circuit key. */
  proxyFor(key) {
    return lazy.proxyService.newProxyInfoWithAuth(
      "socks",
      this.socksUrl,
      0,
      key,
      this.nonceFor(key),
      "",
      "",
      Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
      0xffffffff,
      null,
    );
  },

  applyFilter(channel, _defaultProxyInfo, callback) {
    let key = this.model.UNKNOWN_SITE;
    try {
      key = this.keyFor(channel);
    } catch (error) {
      console.error("aequera-tor: circuit key failed", error);
    }
    callback.onProxyFilterResult(this.proxyFor(key));
  },

  /** New circuits for a site: the next connections use new credentials. */
  newCircuitFor(site) {
    const key = this.model.isolationKey({ topSite: site });
    this.nonces.set(key, randomToken());
    return key;
  },

  /** The circuit key for a page (what newCircuitFor takes). */
  siteForURI(uri) {
    return siteOf(uri);
  },

  // tor

  async torExecutable() {
    const configured = Services.prefs.getStringPref(this.model.EXECUTABLE_PREF, "");
    if (configured) {
      if (!PathUtils.isAbsolute(configured) || !(await IOUtils.exists(configured))) {
        throw new Error(`tor not found at ${configured} (aequera.tor.executable)`);
      }
      return configured;
    }
    try {
      return await lazy.Subprocess.pathSearch("tor");
    } catch {
      throw new Error("tor is not installed (not on PATH; or set aequera.tor.executable)");
    }
  },

  async startTor() {
    this.setState({ status: "starting", progress: 0, summary: "Starting Tor", detail: "" });
    const dataDir = Services.prefs.getStringPref(this.model.DATA_DIR_PREF, "");
    if (!dataDir || !PathUtils.isAbsolute(dataDir)) {
      throw new Error("no tor data directory (aequera.tor.dataDir)");
    }
    const exe = await this.torExecutable();
    await IOUtils.makeDirectory(dataDir, { permissions: 0o700 });
    await IOUtils.setPermissions(dataDir, 0o700);
    const socketDir = PathUtils.parent(this.socksPath);
    await IOUtils.makeDirectory(socketDir, { permissions: 0o700 });
    await IOUtils.setPermissions(socketDir, 0o700);
    await IOUtils.remove(this.socksPath, { ignoreAbsent: true });

    const configDir = PathUtils.parent(dataDir);
    const torrcPath = PathUtils.join(configDir, "torrc");
    const defaultsPath = PathUtils.join(configDir, "torrc-defaults");
    const torrc = this.model.torrc({ dataDir, socksPath: this.socksPath, ownerPid: Services.appinfo.processID });
    await IOUtils.writeUTF8(torrcPath, torrc);
    await IOUtils.writeUTF8(defaultsPath, "");

    const call = this.spawn ?? (options => lazy.Subprocess.call(options));
    const proc = await call({
      command: exe,
      arguments: ["-f", torrcPath, "--defaults-torrc", defaultsPath],
      stderr: "stdout",
    });
    this.proc = proc;
    this.setState({ status: "bootstrapping", summary: "Connecting to the Tor network" });
    this.readLog(proc);
    const { exitCode } = await proc.wait();
    if (this.proc === proc) {
      this.proc = null;
      if (!this.stopping) {
        const reason = this.state.detail || `tor exited (code ${exitCode})`;
        this.setState({ status: "failed", summary: "Tor stopped", detail: reason });
      }
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
          this.onLogLine(line);
        }
      }
    } catch {
      // The pipe closed with the process.
    }
    if (pending) {
      this.onLogLine(pending);
    }
  },

  onLogLine(line) {
    this.log.push(line);
    if (this.log.length > LOG_LINES) {
      this.log.shift();
    }
    const entry = this.model.parseLogLine(line);
    if (!entry || this.proc === null) {
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
    if (proc) {
      this.stopping = true;
      try {
        await proc.kill();
      } catch {}
      this.stopping = false;
    }
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

  observe(_subject, topic) {
    if (topic != "quit-application") {
      return;
    }
    Services.obs.removeObserver(this, "quit-application");
    lazy.proxyService.unregisterChannelFilter(this);
    this.stopping = true;
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.kill();
    } catch {}
    // Leave nothing behind but tor's data directory.
    const socketDir = PathUtils.parent(this.socksPath);
    IOUtils.remove(socketDir, { recursive: true, ignoreAbsent: true }).catch(() => {});
    IOUtils.remove(this.markerPath(), { ignoreAbsent: true }).catch(() => {});
  },
};
