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
  /** The SOCKS socket path the instance's tor listens on (user.js); empty
   *  where tor listens on a loopback TCP port instead (Windows). */
  const SOCKS_PATH_PREF = "aequera.tor.socksPath";
  /** The loopback TCP port the instance's tor listens on (user.js); 0 where
   *  it listens on a Unix socket. Windows: Firefox reaches a local SOCKS
   *  proxy there only over TCP or a named pipe, and tor offers no pipe. */
  const SOCKS_PORT_PREF = "aequera.tor.socksPort";
  /** The only address a TCP SOCKS endpoint may have. */
  const LOOPBACK = "127.0.0.1";
  /** SOCKS ports the instance accepts: never a well-known service port. */
  const MIN_SOCKS_PORT = 1024;
  const MAX_SOCKS_PORT = 65535;
  /** tor's data directory, kept across sessions (user.js). */
  const DATA_DIR_PREF = "aequera.tor.dataDir";
  /** The tor executable; empty: `tor` on PATH (ordinary profile, copied). */
  const EXECUTABLE_PREF = "aequera.tor.executable";
  /** The session's search engine: its name, search and suggestion URLs. */
  const SEARCH_ENGINE_PREF = "aequera.tor.searchEngine";
  const SEARCH_URL_PREF = "aequera.tor.searchURL";
  const SEARCH_SUGGEST_URL_PREF = "aequera.tor.searchSuggestURL";

  /** Longest socket path accepted, in UTF-8 bytes. sockaddr_un.sun_path is
   *  104 bytes on macOS and 108 on Linux, with the terminating NUL; Firefox
   *  refuses longer paths (nsSOCKSIOLayer SetLocalProxyPath). */
  const MAX_SOCKET_PATH_BYTES = 100;

  /** The socket's directory as the launcher names it: a directory of its
   *  own, the only kind the instance creates, locks down (0700), and removes
   *  on quit; a socket anywhere else is refused (socketPathProblem). */
  const SOCKET_DIR_PATTERN = /^aequera-tor-[0-9a-f]{8}$/;
  const SOCKET_NAME = "socks";

  /** DuckDuckGo's onion service (its own address, served over HTTPS with a
   *  certificate for it). */
  const DDG_ONION = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";

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

    // Search: DuckDuckGo's onion service (Tor Browser offers the same):
    // answers Tor without captchas, and the search never leaves the Tor
    // network (no exit relay sees it). Aequera's own prefs: the instance adds
    // the engine and makes it the default for the session
    // (aequera-tor-daemon.sys.mjs); an empty name keeps Firefox's default.
    // The user can still pick another engine.
    { name: SEARCH_ENGINE_PREF, value: "DuckDuckGo (Onion)", why: "searches from Tor windows go to DuckDuckGo's onion service" },
    { name: SEARCH_URL_PREF, value: `https://${DDG_ONION}/?q={searchTerms}`, why: "its search URL" },
    { name: SEARCH_SUGGEST_URL_PREF, value: `https://${DDG_ONION}/ac/?q={searchTerms}&type=list`, why: "its suggestions (asked only where suggestions are on)" },

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

    // Hardening from Tor Browser and Mullvad Browser: their shared
    // base-browser profile (tor-browser 140.17.0esr-15.0,
    // browser/app/profile/001-base-profile.js), the prefs Firefox 157 knows.
    // Left out: prefs only Tor Browser's patches read (letterboxing
    // gradient and centering, canvas randomization lock, offscreen canvas,
    // asm.js), bundled fonts (Tor Browser ships its own), and first-party
    // isolation (Aequera keeps Firefox's dynamic partitioning, Strict
    // tracking protection, instead of privacy.firstparty.isolate).
    //
    // Fingerprinting: Firefox's resistFingerprinting, as Tor Browser locks
    // it (time, screen, fonts, canvas, user agent, language, ...).
    { name: "privacy.resistFingerprinting", value: true, required: true, why: "Firefox's fingerprinting resistance (Tor Browser's, locked)" },
    { name: "privacy.resistFingerprinting.exemptedDomains", value: "", required: true, why: "no site is exempt from it" },
    { name: "privacy.resistFingerprinting.letterboxing", value: true, required: true, why: "page sizes in steps, so the window size does not identify" },
    { name: "privacy.resistFingerprinting.skipEarlyBlankFirstPaint", value: true, why: "no blank first window (Tor Browser)" },
    { name: "privacy.resistFingerprinting.block_mozAddonManager", value: true, why: "sites cannot list add-ons" },
    { name: "privacy.spoof_english", value: 2, why: "pages see English, whatever the user's language" },
    { name: "webgl.disable-fail-if-major-performance-caveat", value: true, why: "WebGL does not reveal a weak graphics card" },
    { name: "webgl.enable-webgl2", value: false, why: "no WebGL 2 (Tor Browser: not audited)" },
    { name: "dom.disable_window_move_resize", value: true, why: "pages cannot move or resize windows" },
    { name: "browser.link.open_newwindow.restriction", value: 0, why: "pop-ups open as tabs, never sized windows" },
    { name: "media.hevc.enabled", value: false, why: "HEVC support reveals the hardware and codecs" },
    { name: "dom.webmidi.enabled", value: false, why: "no Web MIDI" },
    { name: "media.devices.enumerate.legacy.enabled", value: false, why: "no device IDs" },
    { name: "media.navigator.enabled", value: false, why: "no camera or microphone APIs (WebRTC is off)" },
    { name: "dom.vr.enabled", value: false, why: "no WebVR" },
    { name: "security.webauth.webauthn", value: false, why: "no Web Authentication (it identifies authenticators)" },
    { name: "dom.postMessage.sharedArrayBuffer.withCOOP_COEP", value: false, why: "no SharedArrayBuffer (high-resolution timers)" },
    { name: "dom.use_components_shim", value: false, why: "no Components in content" },
    { name: "dom.netinfo.enabled", value: false, why: "no Network Information API" },
    { name: "dom.text-recognition.enabled", value: false, why: "no platform text recognition" },
    { name: "browser.display.document_color_use", value: 1, why: "no forced system colors" },
    { name: "widget.non-native-theme.use-theme-accent", value: false, why: "form controls do not show the system accent color" },
    { name: "widget.wayland.vsync.enabled", value: false, why: "no Wayland vsync: the refresh rate does not leak" },
    { name: "javascript.options.spectre.disable_for_isolated_content", value: false, why: "Spectre mitigations stay on" },
    // Requests and headers.
    { name: "network.http.referer.defaultPolicy", value: 2, why: "Referer: origin when cross-origin" },
    { name: "network.http.referer.defaultPolicy.pbmode", value: 2, why: "the same in private windows" },
    { name: "network.http.referer.XOriginTrimmingPolicy", value: 2, why: "cross-origin Referer is only scheme, host, port" },
    { name: "network.auth.subresource-http-auth-allow", value: 1, why: "no login dialogs from cross-origin subresources" },
    { name: "network.http.tailing.enabled", value: true, why: "the same load order as every Tor Browser" },
    { name: "network.socket.ip_addr_any.disabled", value: true, why: "no requests to 0.0.0.0" },
    { name: "dom.prefetch_dns_for_anchor_http_document", value: false, why: "no DNS prefetch for links" },
    { name: "dom.prefetch_dns_for_anchor_https_document", value: false, why: "the same on HTTPS pages" },
    { name: "privacy.query_stripping.enabled", value: true, why: "tracking parameters stripped from links" },
    { name: "privacy.query_stripping.enabled.pbmode", value: true, why: "the same in private windows" },
    { name: "network.http.max-persistent-connections-per-proxy", value: 256, why: "every site has its own circuit: no shared connection cap (Tor Browser)" },
    { name: "network.http.connection-retry-timeout", value: 0, why: "no racing a second connection over tor (Tor Browser)" },
    // HTTPS and certificates.
    { name: "dom.security.https_only_mode", value: true, required: true, why: "HTTPS only: exits cannot read or change pages" },
    { name: "dom.security.https_only_mode_pbm", value: true, required: true, why: "the same in private windows" },
    { name: "dom.security.https_only_mode.upgrade_onion", value: false, why: "onion sites are encrypted already: http .onion works" },
    { name: "dom.security.https_first_add_exception_on_failure", value: false, why: "no automatic HTTP exceptions" },
    { name: "security.ssl.require_safe_negotiation", value: true, why: "no servers vulnerable to renegotiation attacks" },
    { name: "security.tls.version.enable-deprecated", value: false, why: "no TLS 1.0 or 1.1" },
    { name: "security.ssl.disable_session_identifiers", value: true, why: "no TLS session IDs to link visits" },
    { name: "security.cert_pinning.enforcement_level", value: 2, why: "certificate pins enforced strictly" },
    { name: "security.osclientcerts.autoload", value: false, why: "no system client certificates" },
    { name: "security.enterprise_roots.enabled", value: false, why: "no system or enterprise roots (interception)" },
    { name: "security.certerrors.mitm.priming.enabled", value: false, why: "no interception probe" },
    { name: "security.certerrors.mitm.auto_enable_enterprise_roots", value: false, why: "never trust enterprise roots on an error" },
    { name: "security.nocertdb", value: true, why: "no certificate database written" },
    // Leaving the browser: other applications connect without Tor.
    { name: "network.protocol-handler.external-default", value: false, required: true, why: "no links handed to other applications (they would connect without Tor)" },
    { name: "network.protocol-handler.external.mailto", value: false, why: "not mailto: either" },
    { name: "network.protocol-handler.warn-external-default", value: true, why: "ask before any that is allowed" },
    { name: "pdfjs.enableScripting", value: false, why: "no scripts in PDFs" },
    { name: "media.gmp-provider.enabled", value: false, why: "no media plugins (downloaded from Mozilla)" },
    { name: "media.eme.enabled", value: false, why: "no DRM" },
    { name: "browser.eme.ui.enabled", value: false, why: "nor its UI" },
    { name: "svg.context-properties.content.allowed-domains", value: "", why: "no site styles icons with context properties" },
    { name: "dom.serviceWorkers.enabled", value: false, why: "no service workers (they do not work in private windows)" },
    // Nothing kept, nothing shared.
    { name: "permissions.memory_only", value: true, why: "site permissions only in memory" },
    { name: "browser.download.useDownloadDir", value: false, why: "ask where to save each download" },
    { name: "browser.download.always_ask_before_handling_new_types", value: true, why: "ask before opening new file types" },
    { name: "browser.download.start_downloads_in_tmp_dir", value: true, why: "downloads start in the temporary directory" },
    { name: "browser.helperApps.deleteTempFileOnExit", value: true, why: "and are removed from it on exit" },
    { name: "browser.download.manager.addToRecentDocs", value: false, why: "not listed in the system's recent files" },
    { name: "clipboard.copyPrivateDataToClipboardCloudOrHistory", value: false, why: "copied text stays out of clipboard history and cloud" },
    { name: "browser.sessionstore.privacy_level", value: 2, why: "no form data or cookies in session state" },
    { name: "browser.privatebrowsing.forceMediaMemoryCache", value: true, why: "media cached in memory only" },
    { name: "browser.pagethumbnails.capturing_disabled", value: true, why: "no page thumbnails" },
    { name: "signon.autofillForms", value: false, why: "no autofill" },
    { name: "extensions.formautofill.addresses.enabled", value: false, why: "no address autofill" },
    { name: "extensions.formautofill.creditCards.enabled", value: false, why: "no card autofill" },
    { name: "browser.urlbar.suggest.topsites", value: false, why: "no top sites in the address bar" },
    { name: "browser.urlbar.quicksuggest.enabled", value: false, why: "no Firefox Suggest" },
    { name: "browser.tabs.searchclipboardfor.middleclick", value: false, why: "middle-click on new tab never searches the clipboard" },
  ];

  // Security levels: Tor Browser's Standard, Safer, Safest
  // (toolkit/components/securitylevel/SecurityLevel.sys.mjs, kSecuritySettings),
  // as prefs. Tor Browser also has NoScript block JavaScript on HTTP sites
  // (Safer) or everywhere (Safest), WebAssembly, media, and fonts per site.
  // Without NoScript, Aequera turns those off for every site at that level:
  // WebAssembly and autoplay at Safer; JavaScript and remote fonts at Safest.
  // HTTPS-only already keeps plain-HTTP pages from loading at all.
  const SECURITY_LEVELS = ["standard", "safer", "safest"];
  const SECURITY_LEVEL_PREF = "aequera.tor.securityLevel";
  /** name: [standard, safer, safest] */
  const SECURITY_LEVEL_PREFS = {
    "javascript.options.ion": [true, false, false],
    "javascript.options.baselinejit": [true, false, false],
    "javascript.options.native_regexp": [true, false, false],
    "mathml.disabled": [false, true, true],
    "gfx.font_rendering.graphite.enabled": [true, false, false],
    "gfx.font_rendering.opentype_svg.enabled": [true, false, false],
    "svg.disabled": [false, false, true],
    "javascript.options.wasm": [true, false, false],
    "media.autoplay.default": [1, 5, 5],
    "javascript.enabled": [true, true, false],
    "gfx.downloadable_fonts.enabled": [true, true, false],
  };

  /**
   * A known level, else `fallback`. Callers choose the fallback: a level
   * read back from the instance's own pref is Standard when unset; a level
   * remembered in a file that cannot be read is the strictest (an unreadable
   * Safest must not become Standard).
   *
   * @param {*} level
   * @param {string|null} [fallback]
   */
  function securityLevel(level, fallback = "standard") {
    return SECURITY_LEVELS.includes(level) ? level : fallback;
  }

  /**
   * The prefs of a security level.
   *
   * @param {string} level  "standard" | "safer" | "safest"
   * @returns {[string, boolean|number][]}
   */
  function securityLevelPrefs(level) {
    const i = SECURITY_LEVELS.indexOf(level);
    if (i < 0) {
      throw new Error(`unknown security level: ${level}`);
    }
    return Object.entries(SECURITY_LEVEL_PREFS).map(([name, values]) => [name, values[i]]);
  }

  /** Whether a path is an absolute POSIX path. */
  function isAbsolutePosix(path) {
    return typeof path == "string" && path.startsWith("/");
  }

  /** Whether a path is absolute: POSIX, or a Windows drive path (C:\...). */
  function isAbsolutePath(path) {
    return isAbsolutePosix(path) || (typeof path == "string" && /^[A-Za-z]:[\\/]/.test(path));
  }

  /**
   * Why a SOCKS port cannot be used, or null if it can.
   *
   * @param {*} port
   * @returns {string|null}
   */
  function socksPortProblem(port) {
    if (!Number.isInteger(port)) {
      return "not an integer";
    }
    if (port < MIN_SOCKS_PORT || port > MAX_SOCKS_PORT) {
      return `outside ${MIN_SOCKS_PORT}-${MAX_SOCKS_PORT}`;
    }
    return null;
  }

  /**
   * The one SOCKS endpoint of an options object: a Unix socket
   * ({ socksPath }) or a loopback TCP port ({ socksPort }), never both.
   */
  function endpointOf({ socksPath, socksPort }) {
    const unix = socksPath !== undefined && socksPath !== null && socksPath !== "";
    const tcp = socksPort !== undefined && socksPort !== null;
    if (unix == tcp) {
      throw new Error("give exactly one SOCKS endpoint: a socket path or a TCP port");
    }
    if (tcp) {
      const problem = socksPortProblem(socksPort);
      if (problem) {
        throw new Error(`SOCKS port ${problem}`);
      }
      return { kind: "tcp", port: socksPort };
    }
    return { kind: "unix", path: socksPath };
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
   * Every pref of the instance with its value, the SOCKS endpoint included:
   * a Unix socket (socksPath and its file: URL, the form network.proxy.socks
   * takes for one, from Services.io.newFileURI) or a loopback TCP port
   * (socksPort: 127.0.0.1 at that port).
   *
   * @param {{ socksPath?: string, socksUrl?: string, socksPort?: number,
   *           dataDir?: string, executable?: string, level?: string }} options
   * @returns {[string, boolean|number|string][]}
   */
  function instancePrefs({ socksPath, socksUrl, socksPort, dataDir = "", executable = "", level = "standard" }) {
    const endpoint = endpointOf({ socksPath, socksPort });
    if (endpoint.kind == "unix" && !String(socksUrl).startsWith("file:///")) {
      throw new Error(`not a file URL: ${socksUrl}`);
    }
    const tcp = endpoint.kind == "tcp";
    return [
      [INSTANCE_PREF, true],
      [SOCKS_PATH_PREF, tcp ? "" : socksPath],
      [SOCKS_PORT_PREF, tcp ? endpoint.port : 0],
      [DATA_DIR_PREF, dataDir],
      [EXECUTABLE_PREF, executable],
      ["network.proxy.socks", tcp ? LOOPBACK : socksUrl],
      ["network.proxy.socks_port", tcp ? endpoint.port : 0],
      ...PREFS.map(p => [p.name, p.value]),
      // The security level from the start (the JavaScript engine reads its
      // prefs when a content process starts).
      [SECURITY_LEVEL_PREF, securityLevel(level)],
      ...securityLevelPrefs(securityLevel(level)),
    ];
  }

  /** The prefs the instance locks and checks: the instance marker, the
   *  endpoint (Aequera's names and Firefox's), and PREFS marked required. */
  function requiredNames() {
    return [
      INSTANCE_PREF,
      SOCKS_PATH_PREF,
      SOCKS_PORT_PREF,
      "network.proxy.socks",
      "network.proxy.socks_port",
      ...PREFS.filter(p => p.required).map(p => p.name),
    ];
  }

  /**
   * The required prefs that are not as the instance needs them: a value
   * other than the wanted one, or not locked (a lock that failed leaves the
   * pref open to about:config and add-ons).
   *
   * @param {(name: string) => *} read      the pref's value, undefined if unset
   * @param {Map<string, *>} wanted         instancePrefs as a Map
   * @param {(name: string) => boolean} [isLocked]
   * @returns {string[]}  names of wrong prefs (empty: safe to browse)
   */
  function checkRequired(read, wanted, isLocked = () => true) {
    const wrong = [];
    for (const name of requiredNames()) {
      if (!wanted.has(name) || read(name) !== wanted.get(name) || !isLocked(name)) {
        wrong.push(name);
      }
    }
    if (!endpointInForce(wanted) && !wrong.includes("network.proxy.socks")) {
      wrong.push("network.proxy.socks");
    }
    return wrong;
  }

  /** Whether wanted prefs name a usable endpoint: a file: socket URL, or
   *  exactly 127.0.0.1 at a valid port that both port prefs agree on. */
  function endpointInForce(wanted) {
    const socks = String(wanted.get("network.proxy.socks"));
    if (socks.startsWith("file:///")) {
      return true;
    }
    const port = wanted.get("network.proxy.socks_port");
    return socks === LOOPBACK && socksPortProblem(port) === null && wanted.get(SOCKS_PORT_PREF) === port;
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

  /**
   * The prefs of user.js text written by userJs. Lenient: a line that is not
   * such a call (or does not parse) is skipped, because the launcher reads
   * what a crashed session left behind.
   *
   * @param {string} text
   * @returns {Map<string, boolean|number|string>}
   */
  function parseUserJs(text) {
    const prefs = new Map();
    for (const line of String(text).split("\n")) {
      const m = /^user_pref\(("(?:[^"\\]|\\.)*"), (.*)\);$/.exec(line);
      if (!m) {
        continue;
      }
      try {
        prefs.set(JSON.parse(m[1]), JSON.parse(m[2]));
      } catch {
        // Not JSON literals: not a line userJs wrote.
      }
    }
    return prefs;
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
   * @param {{ dataDir: string, socksPath?: string, socksPort?: number, ownerPid: number,
   *           geoipFile?: string|null, geoip6File?: string|null }} options
   */
  function torrc({ dataDir, socksPath, socksPort, ownerPid, geoipFile = null, geoip6File = null }) {
    if (!isAbsolutePath(dataDir)) {
      throw new Error("tor data directory must be an absolute path");
    }
    for (const file of [geoipFile, geoip6File]) {
      if (file !== null && !isAbsolutePath(file)) {
        throw new Error("GeoIP files must be absolute paths");
      }
    }
    const endpoint = endpointOf({ socksPath, socksPort });
    if (endpoint.kind == "unix") {
      const problem = socketPathProblem(socksPath);
      if (problem) {
        throw new Error(`SOCKS socket path ${problem}`);
      }
    }
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      throw new Error("owner pid must be a positive integer");
    }
    return [
      "# Aequera Tor window. Written by Aequera on every start.",
      `DataDirectory ${torQuote(dataDir)}`,
      // Clients only, on a socket private to the user (Windows: loopback
      // only). IsolateSOCKSAuth (a default, spelled out) gives each SOCKS
      // username/password its own circuits: the per-site circuits
      // (isolationKey).
      endpoint.kind == "unix"
        ? `SocksPort unix:${torQuote(socksPath)} IsolateSOCKSAuth`
        : `SocksPort ${LOOPBACK}:${endpoint.port} IsolateSOCKSAuth`,
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
   *                | { kind: "listener", address: string, port: number }
   *                | { kind: "warn"|"err", message: string }}
   */
  function parseLogLine(line) {
    // tor on Windows ends its stdout lines with CRLF; `.` stops at the CR.
    const m = /\[(notice|warn|err)\]\s+(.*)$/.exec(String(line).replace(/\r+$/, ""));
    if (!m) {
      return null;
    }
    const [, level, message] = m;
    const boot = /^Bootstrapped (\d{1,3})%(?: \(([a-z_]+)\))?: (.*)$/.exec(message);
    if (boot) {
      const progress = Math.min(100, Number(boot[1]));
      return { kind: "bootstrap", progress, tag: boot[2] ?? "", summary: boot[3].trim() };
    }
    // The SOCKS listener tor opened: over TCP, the instance goes online only
    // once tor itself reports it (nothing else may hold the port).
    const listener = /^Opened Socks listener(?: connection \(ready\))? on (.+):(\d{1,5})$/.exec(message.trim());
    if (listener && level == "notice") {
      return { kind: "listener", address: listener[1], port: Number(listener[2]) };
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
   * The browser's command line for a Tor window. Always -offline: a process
   * that becomes the instance starts offline (before any window, nothing can
   * load) and goes online only once its checks pass
   * (aequera-tor-daemon.sys.mjs), so an instance whose checks never run, or a
   * launch that wrongly took the instance for running, stays offline. A
   * remoting client consumes the flag at startup (nsAppRunner CheckArg) and
   * never passes it on.
   *
   * @param {{ appIni?: string|null, profileDir: string, url?: string|null }} options
   * @returns {string[]}
   */
  function launchArgs({ appIni = null, profileDir, url = null }) {
    if (!isAbsolutePath(profileDir)) {
      throw new Error("the Tor profile must be an absolute path");
    }
    if (url !== null && !isTorOpenableUrl(url)) {
      throw new Error("only http(s) URLs open in a Tor window");
    }
    const args = [];
    if (appIni) {
      args.push("-app", appIni);
    }
    args.push("-profile", profileDir, "-offline", "-private-window");
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

  /** A search URL template: http(s), with {searchTerms}, no whitespace. */
  function isSearchTemplate(url) {
    return isTorOpenableUrl(url) && String(url).includes("{searchTerms}");
  }

  /**
   * The session's search engine from its prefs (aequera.tor.searchEngine,
   * searchURL, searchSuggestURL): the engine's form (Firefox's
   * SearchService.addUserEngine), or only its name when no URL is given (a
   * built-in engine). null: keep Firefox's default.
   *
   * @param {{ name?: string, url?: string, suggestUrl?: string }} prefs
   * @returns {null | { name: string, url?: string, suggestUrl?: string }}
   */
  function searchEngine({ name = "", url = "", suggestUrl = "" }) {
    name = String(name).trim();
    if (!name) {
      return null;
    }
    if (!url) {
      return { name };
    }
    if (!isSearchTemplate(url)) {
      return null;
    }
    const engine = { name, url };
    if (suggestUrl && isSearchTemplate(suggestUrl)) {
      engine.suggestUrl = suggestUrl;
    }
    return engine;
  }

  return {
    INSTANCE_PREF,
    SOCKS_PATH_PREF,
    SOCKS_PORT_PREF,
    LOOPBACK,
    DATA_DIR_PREF,
    EXECUTABLE_PREF,
    MAX_SOCKET_PATH_BYTES,
    UNKNOWN_SITE,
    PREFS,
    socketPathProblem,
    socksPortProblem,
    isAbsolutePath,
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
    searchEngine,
    SEARCH_ENGINE_PREF,
    SEARCH_URL_PREF,
    SEARCH_SUGGEST_URL_PREF,
    SECURITY_LEVELS,
    SECURITY_LEVEL_PREF,
    SECURITY_LEVEL_PREFS,
    securityLevel,
    securityLevelPrefs,
    parseUserJs,
  };
})();

if (typeof module == "object" && module.exports) {
  module.exports = AequeraTorModel;
}
