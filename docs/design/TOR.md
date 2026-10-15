# Tor Windows

Status: proposed (ADR 0004). Slice 1 (Tor windows on Linux and macOS) is
implemented in `aequera/shell/firefox/tor`; later slices are design.

A Tor window is a private window whose traffic goes through the Tor network,
opened beside ordinary windows: Brave's "New Private Window with Tor"
(`docs/adr/0004-tor-windows.md`).

## Goals

1. Sites and the local network never see the user's IP address or DNS
   lookups from a Tor window.
2. Sites cannot link each other's visits through a shared circuit.
3. Nothing from a Tor window is kept.
4. A Tor window that is not connected to Tor fails closed: it loads nothing.
5. No network activity without a user-visible reason: the Tor network is
   used only from a Tor window the user opened.

Non-goals: Tor Browser's fingerprinting uniformity (Aequera looks like
Firefox, not like every other Tor Browser), onion services hosted by the
user, and Tor for ordinary windows.

## What the user sees

| Where | What |
|---|---|
| App menu, File menu | "New Tor window" after "New private window" |
| Shortcut | Ctrl+Shift+Alt+P (Command+Option+Shift+P on macOS): Private Window's Ctrl+Shift+P plus Alt |
| Link context menu | "Open Link in Tor Window" for http(s) links |
| Address bar commands | "New Tor window" (also "private window with tor", "onion") |
| Tor window toolbar | The Tor button at its start: "Tor 45%" while connecting, "Tor" once connected, "Tor offline" on failure |
| Tor button panel | Status, bootstrap progress, tor's last warning, what works differently than set (the search engine could not be set up, a security level not remembered), "New circuit for this site", "Restart Tor" after a failure, and what a Tor window does and does not protect |
| Notification | When tor stopped or the window refused to browse; each "works differently" warning once, in a notification of its own |
| Search | DuckDuckGo's onion service for the session, `duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion`, search and suggestions (Tor Browser offers the same; the search never leaves the Tor network, and Google answers Tor exits with captchas) |

A page opened before tor finished connecting shows Firefox's proxy error.
That tab reloads by itself once tor is connected.

"Open Link in Tor Window" uses Firefox's `-private-window <url>`. A running
Tor instance opens the link in a new tab of its window. "New Tor window"
(`-private-window` with no URL) always opens a new window.

## Architecture

```text
ordinary instance (profile P)                Tor instance (profile P/tor/profile)
┌──────────────────────────────┐   spawn    ┌──────────────────────────────────────┐
│ aequera-tor.js (entry points)│ ─────────▶ │ aequera-tor.js (Tor button, panel)   │
│ aequera-tor-launch.sys.mjs   │  or remote │ aequera-tor-daemon.sys.mjs           │
│  - fresh profile + user.js   │ ─────────▶ │  - lock + check prefs (fail closed)  │
│  - socket dir (0700)         │            │  - circuit filter (last position)    │
└──────────────────────────────┘            │  - tor child: torrc, log, quit       │
                                            └───────────────┬──────────────────────┘
                                                            │ SOCKS5 over a Unix socket
                                                            ▼    ($XDG_RUNTIME_DIR/aequera-tor-*/socks)
                                                    tor (DataDirectory P/tor/data)
```

- **Two instances.** The ordinary instance writes the Tor profile and
  starts the same binary on it (`-app` identity ini, `-profile`, `-offline`,
  `-private-window`). The Tor instance writes its pid to the marker
  `P/tor/running` before anything else; if it cannot, it refuses to browse
  (the ordinary instance could rewrite its profile under it). While the
  process the marker names is alive and runs that profile (`/proc` on
  Linux, `ps` on macOS), the command line goes to it through Firefox's
  per-profile remoting. It always carries `-offline`: the remoting client
  consumes it, and a client that becomes an instance itself (the marker
  was wrong) stays offline until its own checks pass. A crashed instance's
  marker is stale and is ignored; a marker that cannot be read, or a
  liveness that cannot be told, counts as running (the profile is never
  rewritten on a guess). The child environment drops the variables that pick a profile
  ahead of `-profile` or turn remoting off (`MOZ_NEW_INSTANCE`), and those
  that turn on automation (Marionette, Remote Agent).
- **Errors are shown.** A new instance that exits before it starts, or a
  handoff the running instance did not take, is reported in the window
  that asked ("Could not open a Tor window"). The launcher never waits on
  a child longer than its start (20 s) or a handoff (15 s); both timeouts
  are errors too. A child still running then is kept as this session's
  Tor instance (offline: it never passed its checks), so the next "New Tor
  window" goes to it rather than rewriting its profile.
- **Fresh profile.** The Tor profile is removed and rewritten whenever no
  Tor instance runs, together with what a crashed session left: its marker
  and its socket directory. tor's data directory beside it is kept: guards
  and the directory cache, so later starts connect in seconds (2.5 s
  measured, 10.5 s the first time).
- **Load order.** `tor/aequera-tor.js` is the first window script. In the
  Tor instance it locks the prefs, registers the circuit filter, and only
  then takes the instance online and starts tor. Everything that needs
  markup waits for `load`.

## Network model

### Prefs

Every pref of the Tor instance, with its reason, is in `tor/tor-model.js`
(`PREFS`). They are written to the profile's `user.js`, so they apply before
any network activity. The **required** ones keep traffic on Tor. At the
first window the instance sets each one on the default branch, locks it,
and checks both its value and its lock (`checkRequired`; a lock that
failed counts as not in force), with the socket path (it must be `socks`
in a directory named `aequera-tor-<8 hex>`: the only kind the instance
creates, locks down, and removes). If any is not in force, the instance
stays offline ("refused"; see Fail closed). A locked pref ignores writes
(about:config, add-ons), so a tampered `user.js` value is overridden, not
obeyed.

| Required | Why |
|---|---|
| `network.proxy.type` 1, `socks` = the socket's `file:` URL, `socks_version` 5, `socks5_remote_dns` | All traffic to tor's SOCKS socket; tor resolves names |
| `network.proxy.http`, `ssl` empty, `share_proxy_settings` false, `no_proxies_on` empty | No other proxy, no exemption |
| `network.proxy.allow_hijacking_localhost` | localhost goes to tor, which refuses it: pages cannot reach local services |
| `network.proxy.failover_direct` false, `network.proxy.allow_bypass` false | Firefox builds fall back to DIRECT for "conservative" system requests when a proxy fails, and `ServiceRequest` sets a proxy bypass. Both off |
| `network.dns.disabled` | No local DNS at all: a path around the proxy cannot resolve a name |
| `network.trr.mode` 5 | No DNS over HTTPS beside tor |
| `network.http.http3.enable`, `network.webtransport.enabled` false | QUIC is UDP; SOCKS carries TCP |
| `media.peerconnection.enabled` false | WebRTC ICE gathers addresses outside the proxy |
| `browser.ipProtection.enabled` false | Firefox's VPN registers its own proxy filter |
| `xpinstall.enabled` false | An add-on's `proxy.onRequest` could route around tor |
| `browser.privatebrowsing.autostart` | Every window is private |

The optional prefs drop requests a Tor session has no use for: prefetch,
speculative connections, captive portal and connectivity probes, push,
geolocation, and region lookups. They also stop first-run pages and
restoring, and turn on the onion settings (`dom.securecontext.allowlist_onions`,
`network.http.referer.hideOnionSource`).

Firefox 157 has neither the GIO protocol handler nor the network predictor,
so their prefs are not listed.

### Circuits

`AequeraTorDaemon` is an `nsIProtocolProxyChannelFilter` registered at the
last position (`0xffffffff`). Whatever earlier filters chose (WebExtensions,
IP Protection, the new tab page's own), every channel gets tor's socket with
SOCKS credentials:

- username: the channel's circuit key (`isolationKey`): the site of a
  top-level document's own URL, else the site of the page it belongs to
  (web partition key, first-party domain, the top browsing context's URL),
  else `--unknown--` for browser requests;
- password: a random token per key. "New circuit for this site" replaces
  that site's token and reloads the tab.

tor's `IsolateSOCKSAuth` gives each username/password pair its own circuits.
Firefox includes the credentials in the HTTP connection key, so sites never
share a connection and a new token never reuses an old one. Partition keys
of other schemes name browser pages, never a site: the JSON viewer's is
`(resource,devtools)`.

### Fail closed

- **Until checked:** the instance starts offline (`-offline`) and goes online
  only after the checks pass and the circuit filter is registered. If that
  code never runs, nothing loads (`netOffline`).
- **Refused:** a failed check, or a marker that could not be written, keeps
  it offline. Turning it online (File >
  Work Offline) is undone at once, and a filter sends every channel to a
  socket that does not exist, so even an online state loads nothing.
- **Before tor listens, or after it stops:** the socket does not exist, and
  loads fail with `proxyConnectFailure`. A failed `tor` shows the
  notification with "Restart Tor".

Nothing ever falls back to a direct connection. Tabs that failed with
`netOffline` or a proxy error reload once tor is connected.

## tor

- Which tor: `aequera.tor.executable` (copied from the ordinary profile)
  when set; else the bundled tor, `<app>/tor/tor`, the Tor Project's tor
  expert bundle (Tor Browser's tor). A build gets it from
  `tools/tor/fetch-bundle.sh`, pinned and signature-checked
  (`tools/tor/README.md`). It is run with its own libraries
  (`LD_LIBRARY_PATH`, as Tor Browser does) and its own GeoIP databases. Else
  `tor` on `PATH`. The browser never downloads tor. If none is found, the
  window says "Tor offline" with the reason.
- Configuration `P/tor/torrc`, read alone (`-f`, empty `--defaults-torrc`):
  `DataDirectory`, `SocksPort unix:"<socket>" IsolateSOCKSAuth`,
  `ControlPort 0`, `ClientOnly 1`, `__OwningControllerProcess <pid>` (tor exits
  with the instance), `AvoidDiskWrites 1`, `Log notice stdout`.
- Bootstrap progress and errors come from tor's log (`parseLogLine`); there
  is no control port in slice 1. Only the current tor's lines count: after
  "Restart Tor", the stopped one's last lines never reach the new session.
  "Restart Tor" acts only after a failure: never a second tor beside a
  running or starting one, never in a refused instance.
- On quit: the filter is unregistered, tor is killed, and the socket
  directory and the marker are removed. A socket directory is removed only
  when its name is one the launcher gives (`aequera-tor-<8 hex>`).
- When it is killed: SIGTERM ends the instance before any quit code runs
  (Firefox's profile lock catches it, removes its lock files, and re-raises
  it; measured: exit by signal, no `quit-application`), as do SIGKILL and a
  crash. The ordinary instance that started it watches it: when its child
  exits, the launcher removes the socket directory and the marker (queued
  behind any launch in progress, and only while no Tor instance runs on the
  profile). tor exits by itself once its owner is gone
  (`__OwningControllerProcess`, within about a minute). If the ordinary
  instance is not running either, the next "New Tor window" treats the
  marker as stale and removes both.

## Configuration

| Pref | Profile | Default | Effect |
|---|---|---|---|
| `aequera.tor.enabled` | ordinary | true | Off: no entry points |
| `aequera.tor.executable` | ordinary | "" | tor's absolute path; empty: the bundled tor, else `tor` on PATH |
| `aequera.tor.searchEngine` | Tor (`user.js`) | DuckDuckGo (Onion) | The session's search engine; empty keeps Firefox's; without a URL, a built-in engine by name |
| `aequera.tor.searchURL`, `aequera.tor.searchSuggestURL` | Tor (`user.js`) | DuckDuckGo's onion service (`/?q=`, `/ac/?…&type=list`) | Its search and suggestion templates (`{searchTerms}`); the engine is added for the session. If it cannot be added, the built-in DuckDuckGo is used |

## Hardening (Tor Browser and Mullvad Browser)

Tor windows take the hardening of Tor Browser and Mullvad Browser: their
shared base-browser profile (tor-browser `140.17.0esr-15.0`,
`browser/app/profile/001-base-profile.js`). Every pref Firefox 157 knows is in
`tor-model.js` with its reason. In short:

- **Fingerprinting:** `privacy.resistFingerprinting`, locked and checked like
  the network prefs, no exempt sites, with letterboxing. Pages see UTC,
  English, 4 cores, and a screen the size of the stepped page. Also off:
  WebGL 2, WebMIDI, WebVR, WebAuthn, SharedArrayBuffer, Network Information,
  HEVC, device IDs, the add-on manager, window moving and resizing, system
  accent and colors, Wayland vsync (refresh rate).
- **Network and headers:** cross-origin Referer is trimmed to the origin, no
  cross-origin login prompts, no requests to 0.0.0.0, query parameters
  stripped, Tor Browser's connection settings for the proxy.
- **HTTPS:** HTTPS-only, locked (http `.onion` still loads: onion services are
  encrypted end to end); safe TLS renegotiation only; no TLS 1.0/1.1, session
  IDs, enterprise roots, or OS client certificates; strict pinning.
- **Leaving the browser:** no links handed to other applications (locked:
  they would connect without Tor); no PDF scripts, DRM, media plugins, or
  service workers.
- **Nothing kept:** permissions in memory only, downloads ask where and start
  in the temporary directory, no clipboard history, thumbnails, autofill, or
  session form data.

Left out, deliberately:

- prefs only Tor Browser's patches read (letterboxing centering and
  gradient, canvas-randomization lock, offscreen canvas, asm.js, and others);
- bundled fonts and their allow lists: Tor Browser ships its own fonts;
- `privacy.firstparty.isolate`: Aequera keeps Firefox's dynamic partitioning
  (Strict tracking protection), which Firefox now builds on;
- Tor Browser's "no tracking protection": Aequera keeps Strict tracking
  protection and Ad Veil, as Mullvad Browser keeps uBlock Origin.

### Security levels

The Tor panel offers Tor Browser's **Standard / Safer / Safest**
(`SecurityLevel.sys.mjs`, `kSecuritySettings`):

| | Standard | Safer | Safest |
|---|---|---|---|
| JavaScript JIT (Ion, Baseline, native regexp) | on | off | off |
| WebAssembly | on | off | off |
| MathML, Graphite and SVG fonts | on | off | off |
| Autoplay (audible and inaudible) | Firefox's | off | off |
| SVG | on | on | off |
| JavaScript | on | on | off |
| Web fonts | on | on | off |

Tor Browser has NoScript allow JavaScript on HTTPS sites at Safer and block
media and fonts per site. Aequera has no NoScript, so it sets these for every
site at the level: WebAssembly and autoplay go at Safer, and JavaScript and
web fonts at Safest. HTTPS-only already keeps plain-HTTP pages out. The level
is remembered for the next Tor session in `<profile>/tor/settings.json`, and
it applies to pages loaded after the change. A change is all or nothing: if
one of its prefs cannot be set, every pref is put back and the panel says
so. One that applies but cannot be remembered is shown as a warning. A
`settings.json` that cannot be read, or names no known level, starts the
next session at Safest, never a silent Standard.

## What it protects, and what not

Protects: the IP address and DNS lookups from sites and the local network;
linking sites through shared circuits; local services from pages; anything
kept after the session (history, cookies, cache: the profile is thrown away);
much of what fingerprinting reads (above).

Does not protect: membership in Tor Browser's crowd. Pages can still tell an
Aequera Tor window from Tor Browser (another Firefox version, system fonts
rather than bundled ones, Ad Veil's blocking). Also not covered: what the
user tells a site; downloads opened in other applications, which connect
without Tor; the fact that tor runs on this machine (visible to the network
unless bridges are used, a later slice).

## Verification

- `node --test aequera/shell/firefox/tor/tor-model.test.mjs`: prefs and their
  required set, `user.js` and torrc generation (quoting, socket path limits),
  tor log parsing, circuit keys, launch arguments, which URLs a Tor window
  takes.
- `browser_aequera_tor.js` (gate): entry points, the launcher with a fake
  spawn (fresh profile, `user.js`, 0700 directories, command line, stripped
  environment, refusal of non-web URLs, the running instance's profile
  untouched), the circuit filter on real channels, tor's lifecycle with a fake
  tor (real `Subprocess`), the search default, and the Tor button and panel.
  The daemon's startup and quit run against a fake pref system and stubbed
  network, proxy, and observer services: online only after the marker and
  the locked checks, refusal on a failed lock, an unwritable marker, or a
  bad socket path, quit cleanup of only its own directory, restart only
  after a failure, all-or-nothing security levels. Launcher edge cases:
  concurrent launches, unknown liveness, start and handoff timeouts, a
  corrupt `settings.json`, cleanup after a child that exits without quitting
  (and none while another instance or a newer child runs).
- SIGTERM, by hand 2026-10-15: the Tor instance exited by the signal, and
  the ordinary instance removed its marker and socket directory within
  260 ms (before this, both stayed).
- `tests/security/tor/scripts.test.sh` (PR CI, offline): the bundle
  scripts' pin, lock, and signature checks with shimmed `curl`, `gpg`, and
  `uname`.
- Live check (`tests/security/tor`: Marionette into both instances, a
  headless sway as the window system), 2026-10-14, tor 0.4.9.14 from
  nixpkgs. 15 of 15 passed:
  - tor bootstraps (10.5 and 12.8 s on first starts, 2.5 s with the kept directory);
  - required prefs are locked, and a write to `network.proxy.type` has no effect;
  - local DNS fails (`NS_ERROR_UNKNOWN_PROXY_HOST`);
  - check.torproject.org reports `IsTor: true`;
  - torproject.org and ipify.org saw different exits;
  - "new circuit" changed the exit;
  - the Tor Project's onion site loads;
  - `127.0.0.1` is unreachable (a local server got no request);
  - `RTCPeerConnection` is undefined;
  - with tor stopped, loads end in `proxyConnectFailure`, and the tab reloads after reconnecting;
  - DuckDuckGo is the default (from 2026-10-14 its onion service; a search returns its results).

  In a real window session: Alt+Shift+N (the shortcut then) started the Tor instance in 0.9 s
  without Marionette in its environment, and "New Tor window" while it ran
  opened a second window there. On clean quit, tor stopped, the socket and
  marker were removed, and the directory cache was kept. Headless Firefox
  never acts as a remoting client (`nsAppRunner`), so that handoff can be
  checked only with a window system.
- Failure paths, checked by hand the same day (after the code review fixes;
  the live check and handoff passed again):
  - **Crash.** The Tor instance was killed with SIGKILL, so its marker stayed.
    "New Tor window" saw the marker's pid was gone and started a fresh
    instance in 0.7 s, offline until checked. Its tor took over the data
    directory once the old tor (owned by the dead process) exited, and
    answered `IsTor: true` on its socket.
  - **Checks never run** (simulated with `aequera.tor.instance` false): the
    instance stayed offline (`netOffline`) and started no tor.
  - **Refused** (socket path `/tmp/socks`): the instance stayed offline,
    turning it online was undone, nothing loaded, no tor started, and `/tmp`
    was untouched (mode 1777, present after quit).

- 2026-10-15, after the PR review fixes: "New Tor window" from a headless
  ordinary instance started the bundled tor (Tor Browser 15.0.25), and its
  socket answered `IsTor: true`; the gate passed (1001 checks).

  The liveness check reads `/proc/<pid>/stat` and `cmdline` with
  `maxBytes`. procfs reports a size of 0, and IOUtils otherwise reads
  nothing. The first version of this check passed with a stub in the
  browser test, then failed in the live handoff. The browser test now runs
  it against a real child process.

### On each upstream update

Re-check what can route around the proxy: new prefs in
`network.proxy.*`, `network.dns.*`, HTTP/3 and WebTransport, WebRTC, new
`registerChannelFilter` callers, and new direct-connection paths in
`ServiceRequest`. Then run the live check (`tests/security/tor/README.md`).

## Slices

| Slice | Content | State |
|---|---|---|
| 1 Tor windows | Two instances, required prefs locked, per-site circuits, tor child, Tor button and panel, entry points, DuckDuckGo (onion) | done (Linux; macOS unverified) |
| 2 Onion-Location | Ordinary windows: the address bar offers ".onion available" for sites that send `Onion-Location`; `.onion` links open in a Tor window | design |
| 3 Bridges | Settings for built-in bridges (obfs4, Snowflake) and custom bridge lines; pluggable transports found like tor | design |
| 4 Packaging | tor (and transports) bundled, signature-checked, updated with Aequera | builds: done (`tools/tor`, Tor Browser 15.0.25's expert bundle; Linux verified, macOS pinned); release installers: design |
| 5 Windows | A loopback TCP port in place of the Unix socket, with its own review | design |
| 6 Tor page | The Tor window's private browsing page says it is a Tor window and shows the connection | design |
