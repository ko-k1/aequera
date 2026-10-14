/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tor windows: pure model (no Firefox APIs; unit-tested with node).
// docs/adr/0004-tor-windows.md, docs/design/TOR.md.
//
// A Tor window is a window of a second Aequera instance, on a throwaway
// profile whose every connection goes through a tor daemon the instance runs.
// This file holds what that rests on: the instance's prefs (each with its
// reason), the check that they are in force, tor's configuration, tor's log,
// and the per-site circuit key. A classic script for the same reason as
// workspace-model.js: the window loads it, the modules load it into a scope
// of their own (loadSubScript), and node tests require it.

var AequeraTorModel = (() => {
  "use strict";

  /** The instance's marker pref (user.js, then locked). */
  const INSTANCE_PREF = "aequera.tor.instance";
  /** The SOCKS socket path the instance's tor listens on (user.js). */
  const SOCKS_PATH_PREF = "aequera.tor.socksPath";
  /** tor's data directory, kept across sessions (user.js). */
  const DATA_DIR_PREF = "aequera.tor.dataDir";
  /** The tor executable; empty: `tor` on PATH (ordinary profile, copied). */
  const EXECUTABLE_PREF = "aequera.tor.executable";

  /** Longest socket path accepted, in UTF-8 bytes. sockaddr_un.sun_path is
   *  104 bytes on macOS and 108 on Linux, with the terminating NUL; Firefox
   *  refuses longer paths (nsSOCKSIOLayer SetLocalProxyPath). */
  const MAX_SOCKET_PATH_BYTES = 100;

  /** The socket's directory as the launcher names it: a directory of its
   *  own, the only kind the instance creates, locks down (0700), and removes
   *  on quit; a socket anywhere else is refused (socketPathProblem). */
  const SOCKET_DIR_PATTERN = /^aequera-tor-[0-9a-f]{8}$/;
  const SOCKET_NAME = "socks";

  /** The circuit key of channels with no site (browser requests). */
  const UNKNOWN_SITE = "--unknown--";

  /**
   * The prefs of the Tor instance. `required` prefs keep traffic on Tor: the
   * instance locks them and refuses to browse if one is not in force
   * (checkRequired). The others reduce what a Tor session sends or keeps,
   * and stay defaults. Values are written to user.js before the first start,
   * so they apply before any network activity.
   *
   * @type {{ name: string, value: boolean|number|string, required?: true, why: string }[]}
   */
  const PREFS = [
    // Routing: everything through tor's SOCKS socket, nothing around it.
    { name: "network.proxy.type", value: 1, required: true, why: "manual proxy configuration" },
    { name: "network.proxy.socks_version", value: 5, required: true, why: "SOCKS5: the proxy resolves names" },
    { name: "network.proxy.socks5_remote_dns", value: true, required: true, why: "host names go to tor, never to a local resolver" },
    { name: "network.proxy.socks_remote_dns", value: true, required: true, why: "the same for the older pref name" },
    { name: "network.proxy.http", value: "", required: true, why: "no HTTP proxy beside SOCKS" },
    { name: "network.proxy.ssl", value: "", required: true, why: "no HTTPS proxy beside SOCKS" },
    { name: "network.proxy.share_proxy_settings", value: false, required: true, why: "keeps the HTTP proxy from copying SOCKS" },
    { name: "network.proxy.no_proxies_on", value: "", required: true, why: "no host is exempt" },
    { name: "network.proxy.allow_hijacking_localhost", value: true, required: true, why: "localhost goes to tor too, which refuses it: pages cannot reach local services" },
    { name: "network.proxy.failover_direct", value: false, required: true, why: "a failed proxy never falls back to a direct connection (system requests)" },
    { name: "network.proxy.allow_bypass", value: false, required: true, why: "no request may skip the proxy (ServiceRequest sets bypass)" },
    { name: "network.dns.disabled", value: true, required: true, why: "no local DNS at all: what does not go through the proxy cannot resolve" },
    { name: "network.trr.mode", value: 5, required: true, why: "no DNS over HTTPS beside tor" },
    { name: "network.http.http3.enable", value: false, required: true, why: "QUIC is UDP, which SOCKS does not carry" },
    { name: "network.webtransport.enabled", value: false, required: true, why: "WebTransport runs on HTTP/3 (UDP)" },
    { name: "media.peerconnection.enabled", value: false, required: true, why: "WebRTC gathers local and public addresses outside the proxy" },
    { name: "browser.ipProtection.enabled", value: false, required: true, why: "Firefox's VPN proxy would replace tor (the circuit filter overrides it too)" },
    { name: "xpinstall.enabled", value: false, required: true, why: "no add-on installs: an add-on's proxy.onRequest could route around tor" },
    { name: "browser.privatebrowsing.autostart", value: true, required: true, why: "every window is private: nothing is kept" },

    // Requests a Tor session has no use for (they would go through tor, but
    // each is a connection the user did not ask for).
    { name: "network.dns.disablePrefetch", value: true, why: "no prefetch of link host names" },
    { name: "network.dns.disablePrefetchFromHTTPS", value: true, why: "the same on HTTPS pages" },
    { name: "network.prefetch-next", value: false, why: "no link prefetch" },
    { name: "network.http.speculative-parallel-limit", value: 0, why: "no speculative connections" },
    { name: "browser.urlbar.speculativeConnect.enabled", value: false, why: "no connections while typing" },
    { name: "browser.places.speculativeConnect.enabled", value: false, why: "no connections on hovering bookmarks" },
    { name: "network.captive-portal-service.enabled", value: false, why: "no captive portal probe" },
    { name: "network.connectivity-service.enabled", value: false, why: "no connectivity probe" },
    { name: "dom.push.connection.enabled", value: false, why: "no push service connection" },
    { name: "geo.enabled", value: false, why: "geolocation would send nearby Wi-Fi networks" },
    { name: "browser.region.update.enabled", value: false, why: "no region lookup" },
    { name: "browser.region.network.url", value: "", why: "the same" },
    { name: "extensions.update.enabled", value: false, why: "add-on updates belong to the ordinary profile" },
    { name: "extensions.getAddons.cache.enabled", value: false, why: "no add-on metadata fetches" },
    { name: "browser.safebrowsing.downloads.remote.enabled", value: false, why: "downloads are not sent for remote checks" },

    // Onion sites.
    { name: "network.dns.blockDotOnion", value: false, why: ".onion names go to tor" },
    { name: "dom.securecontext.allowlist_onions", value: true, why: "onion sites are end-to-end encrypted: secure contexts" },
    { name: "network.http.referer.hideOnionSource", value: true, why: "an onion address never leaves in a Referer" },

    // Search: an engine that answers Tor exits without captchas (Brave's and
    // Tor Browser's choice). Aequera's own pref: the instance makes it the
    // default for the session (aequera-tor-daemon.sys.mjs); empty keeps
    // Firefox's default. The user can still pick another one.
    { name: "aequera.tor.searchEngine", value: "DuckDuckGo", why: "searches from Tor windows go to DuckDuckGo" },

    // A fresh profile on every start: no first-run pages, no default-browser
    // prompt, nothing restored.
    { name: "browser.shell.checkDefaultBrowser", value: false, why: "never ask to be the default browser" },
    { name: "browser.aboutwelcome.enabled", value: false, why: "no first-run page" },
    { name: "browser.startup.homepage_override.mstone", value: "ignore", why: "no what's-new page" },
    { name: "browser.startup.page", value: 0, why: "start with the private browsing page, restore nothing" },
    { name: "browser.sessionstore.resume_from_crash", value: false, why: "never restore a Tor session" },
    { name: "browser.cache.disk.enable", value: false, why: "no disk cache" },
    { name: "signon.rememberSignons", value: false, why: "no saved logins" },
    { name: "browser.formfill.enable", value: false, why: "no form history" },
  ];

  /** Whether a path is an absolute POSIX path. */
  function isAbsolutePosix(path) {
    return typeof path == "string" && path.startsWith("/");
  }

  /** UTF-8 length of a string. */
  function utf8Length(text) {
    return new TextEncoder().encode(text).length;
  }

  /**
   * Why a SOCKS socket path cannot be used, or null if it can.
   *
   * @param {string} path
   * @returns {string|null}
   */
  function socketPathProblem(path) {
    if (!isAbsolutePosix(path)) {
      return "not an absolute path";
    }
    if (/[\0\n\r]/.test(path)) {
      return "contains a control character";
    }
    if (utf8Length(path) > MAX_SOCKET_PATH_BYTES) {
      return `longer than ${MAX_SOCKET_PATH_BYTES} bytes`;
    }
    const parts = path.split("/");
    if (parts.at(-1) != SOCKET_NAME || !SOCKET_DIR_PATTERN.test(parts.at(-2) ?? "") || parts.length < 3) {
      return `not ${SOCKET_NAME} in a directory named aequera-tor-<8 hex digits>`;
    }
    if (parts.includes("..") || parts.includes(".")) {
      return "not a normalized path";
    }
    return null;
  }

  /** The directory of a socket path socketPathProblem accepts. */
  function socketDir(path) {
    return path.slice(0, path.lastIndexOf("/"));
  }

  /** A new socket path under `root` with a random directory name. */
  function newSocketPath(root, hex8) {
    if (!/^[0-9a-f]{8}$/.test(hex8)) {
      throw new Error("socket directory name needs 8 hex digits");
    }
    return `${root.replace(/\/+$/, "")}/aequera-tor-${hex8}/${SOCKET_NAME}`;
  }

  /**
   * Every pref of the instance with its value, the socket included.
   *
   * @param {{ socksPath: string, socksUrl: string, dataDir?: string, executable?: string }} paths
   *   socksUrl is the socket's file: URL (Services.io.newFileURI), the form
   *   network.proxy.socks takes.
   * @returns {[string, boolean|number|string][]}
   */
  function instancePrefs({ socksPath, socksUrl, dataDir = "", executable = "" }) {
    if (!String(socksUrl).startsWith("file:///")) {
      throw new Error(`not a file URL: ${socksUrl}`);
    }
    return [
      [INSTANCE_PREF, true],
      [SOCKS_PATH_PREF, socksPath],
      [DATA_DIR_PREF, dataDir],
      [EXECUTABLE_PREF, executable],
      ["network.proxy.socks", socksUrl],
      ["network.proxy.socks_port", 0],
      ...PREFS.map(p => [p.name, p.value]),
    ];
  }

  /** The names `checkRequired` and the lock cover, beyond PREFS' required. */
  function requiredNames() {
    return [INSTANCE_PREF, "network.proxy.socks", ...PREFS.filter(p => p.required).map(p => p.name)];
  }

  /**
   * The prefs that are not as the instance needs them.
   *
   * @param {(name: string) => *} read  the pref's value, undefined if unset
   * @param {string} socksUrl           the socket URL the instance must use
   * @returns {string[]}  names of wrong prefs (empty: safe to browse)
   */
  function checkRequired(read, socksUrl) {
    const wrong = [];
    if (read(INSTANCE_PREF) !== true) {
      wrong.push(INSTANCE_PREF);
    }
    if (read("network.proxy.socks") !== socksUrl || !String(socksUrl).startsWith("file:///")) {
      wrong.push("network.proxy.socks");
    }
    for (const p of PREFS) {
      if (p.required && read(p.name) !== p.value) {
        wrong.push(p.name);
      }
    }
    return wrong;
  }

  /**
   * user.js text for prefs (JSON string literals are valid JS literals).
   *
   * @param {[string, boolean|number|string][]} prefs
   */
  function userJs(prefs) {
    const lines = [
      "// Aequera Tor window profile. Written by Aequera on every start;",
      "// edits are lost. docs/design/TOR.md.",
    ];
    for (const [name, value] of prefs) {
      if (!["boolean", "number", "string"].includes(typeof value)) {
        throw new Error(`unsupported pref value for ${name}`);
      }
      if (typeof value == "number" && !Number.isInteger(value)) {
        throw new Error(`pref ${name} must be an integer`);
      }
      lines.push(`user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
    }
    return lines.join("\n") + "\n";
  }

  /** A tor configuration string value, quoted with C escapes. */
  function torQuote(value) {
    if (/[\0\n\r]/.test(value)) {
      throw new Error("tor config value contains a control character");
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  /**
   * tor's configuration (torrc text). tor reads only this file
   * (`-f`, with an empty `--defaults-torrc`), never the system torrc.
   *
   * The bundled tor (the Tor Project's expert bundle, tools/tor) brings its
   * own GeoIP databases; tor otherwise looks for them in system paths.
   *
   * @param {{ dataDir: string, socksPath: string, ownerPid: number,
   *           geoipFile?: string|null, geoip6File?: string|null }} options
   */
  function torrc({ dataDir, socksPath, ownerPid, geoipFile = null, geoip6File = null }) {
    if (!isAbsolutePosix(dataDir)) {
      throw new Error("tor data directory must be an absolute path");
    }
    for (const file of [geoipFile, geoip6File]) {
      if (file !== null && !isAbsolutePosix(file)) {
        throw new Error("GeoIP files must be absolute paths");
      }
    }
    const problem = socketPathProblem(socksPath);
    if (problem) {
      throw new Error(`SOCKS socket path ${problem}`);
    }
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      throw new Error("owner pid must be a positive integer");
    }
    return [
      "# Aequera Tor window. Written by Aequera on every start.",
      `DataDirectory ${torQuote(dataDir)}`,
      // Clients only, on a socket private to the user. IsolateSOCKSAuth (a
      // default, spelled out) gives each SOCKS username/password its own
      // circuits: the per-site circuits (isolationKey).
      `SocksPort unix:${torQuote(socksPath)} IsolateSOCKSAuth`,
      "ControlPort 0",
      "ClientOnly 1",
      // tor exits when the browser instance does.
      `__OwningControllerProcess ${ownerPid}`,
      "AvoidDiskWrites 1",
      "Log notice stdout",
      ...(geoipFile ? [`GeoIPFile ${torQuote(geoipFile)}`] : []),
      ...(geoip6File ? [`GeoIPv6File ${torQuote(geoip6File)}`] : []),
      "",
    ].join("\n");
  }

  /**
   * One line of tor's log.
   *
   * @param {string} line  e.g. "Oct 14 18:00:00.000 [notice] Bootstrapped 5% (conn): Connecting to a relay"
   * @returns {null | { kind: "bootstrap", progress: number, tag: string, summary: string }
   *                | { kind: "warn"|"err", message: string }}
   */
  function parseLogLine(line) {
    const m = /\[(notice|warn|err)\]\s+(.*)$/.exec(String(line));
    if (!m) {
      return null;
    }
    const [, level, message] = m;
    const boot = /^Bootstrapped (\d{1,3})%(?: \(([a-z_]+)\))?: (.*)$/.exec(message);
    if (boot) {
      const progress = Math.min(100, Number(boot[1]));
      return { kind: "bootstrap", progress, tag: boot[2] ?? "", summary: boot[3].trim() };
    }
    if (level == "warn" || level == "err") {
      return { kind: level, message: message.trim() };
    }
    return null;
  }

  /**
   * The circuit key of a channel: its top-level site. A top-level document
   * is keyed by its own site (the partition key still names the previous
   * page while it loads); everything else by the site of the page it
   * belongs to.
   *
   * @param {{ topLevelDocument?: boolean, uriSite?: string, partitionSite?: string,
   *           firstPartyDomain?: string, topSite?: string }} facts
   * @returns {string}
   */
  function isolationKey(facts) {
    const pick = facts.topLevelDocument
      ? [facts.uriSite]
      : [facts.partitionSite, facts.firstPartyDomain, facts.topSite];
    for (const site of pick) {
      if (typeof site == "string" && site.trim()) {
        return site.trim().toLowerCase();
      }
    }
    return UNKNOWN_SITE;
  }

  /**
   * The browser's command line for a Tor window. A new instance (`start`)
   * starts offline (Firefox's -offline: before any window, nothing can load)
   * and goes online only once its checks pass (aequera-tor-daemon.sys.mjs),
   * so an instance whose checks never run stays offline. A running instance
   * gets the command line through remoting, where -offline means nothing.
   *
   * @param {{ appIni?: string|null, profileDir: string, url?: string|null, start?: boolean }} options
   * @returns {string[]}
   */
  function launchArgs({ appIni = null, profileDir, url = null, start = false }) {
    const args = [];
    if (appIni) {
      args.push("-app", appIni);
    }
    args.push("-profile", profileDir);
    if (start) {
      args.push("-offline");
    }
    args.push("-private-window");
    if (url) {
      args.push(url);
    }
    return args;
  }

  /**
   * Whether a URL may be handed to a Tor window from the ordinary instance:
   * web URLs only (a file: or about: URL would be loaded with the Tor
   * instance's privileges for no Tor reason).
   */
  function isTorOpenableUrl(url) {
    return /^(https?):\/\/[^\s]+$/i.test(String(url ?? ""));
  }

  return {
    INSTANCE_PREF,
    SOCKS_PATH_PREF,
    DATA_DIR_PREF,
    EXECUTABLE_PREF,
    MAX_SOCKET_PATH_BYTES,
    UNKNOWN_SITE,
    PREFS,
    socketPathProblem,
    socketDir,
    newSocketPath,
    instancePrefs,
    requiredNames,
    checkRequired,
    userJs,
    torQuote,
    torrc,
    parseLogLine,
    isolationKey,
    launchArgs,
    isTorOpenableUrl,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraTorModel;
}
