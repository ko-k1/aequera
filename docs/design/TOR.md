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
| Shortcut | Alt+Shift+N (Option+Command+N on macOS), Brave's |
| Link context menu | "Open Link in Tor Window" for http(s) links |
| Address bar commands | "New Tor window" (also "private window with tor", "onion") |
| Tor window toolbar | The Tor button at its start: "Tor 45%" while connecting, "Tor" once connected, "Tor offline" on failure |
| Tor button panel | Status, bootstrap progress, tor's last warning, "New circuit for this site", "Restart Tor" after a failure, and what a Tor window does and does not protect |
| Notification | Only when tor stopped or the window refused to browse |
| Search | DuckDuckGo for the session (Brave's and Tor Browser's choice; Google answers Tor exits with captchas) |

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
  `P/tor/running` as soon as it starts. While the process the marker names
  is alive and runs that profile (`/proc` on Linux, `ps` on macOS), the
  command line (without `-offline`) goes to it through Firefox's
  per-profile remoting. A crashed instance's marker is stale and is
  ignored. The child environment drops the variables that pick a profile
  ahead of `-profile` or turn remoting off (`MOZ_NEW_INSTANCE`), and those
  that turn on automation (Marionette, Remote Agent).
- **Errors are shown.** A new instance that exits before it starts, or a
  handoff the running instance did not take, is reported in the window
  that asked ("Could not open a Tor window"). The launcher never waits on
  a child longer than its start (20 s) or a handoff (15 s).
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
and checks it (`checkRequired`), with the socket path (it must be `socks`
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
- **Refused:** a failed check keeps it offline. Turning it online (File >
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
- On quit: the filter is unregistered, tor is killed, and the socket
  directory and the marker are removed.

## Configuration

| Pref | Profile | Default | Effect |
|---|---|---|---|
| `aequera.tor.enabled` | ordinary | true | Off: no entry points |
| `aequera.tor.executable` | ordinary | "" | tor's absolute path; empty: the bundled tor, else `tor` on PATH |
| `aequera.tor.searchEngine` | Tor (`user.js`) | DuckDuckGo | The session's search engine; empty keeps Firefox's |

## What it protects, and what not

Protects: the IP address and DNS lookups from sites and the local network;
linking sites through shared circuits; local services from pages; anything
kept after the session (history, cookies, cache: the profile is thrown away).

Does not protect: fingerprinting (Aequera's own protections apply, Tor
Browser's uniformity does not); what the user tells a site; downloads opened
in other applications, which connect without Tor; the fact that tor runs on
this machine (visible to the network unless bridges are used, a later
slice).

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
  - DuckDuckGo is the default.

  In a real window session: Alt+Shift+N started the Tor instance in 0.9 s
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
| 1 Tor windows | Two instances, required prefs locked, per-site circuits, tor child, Tor button and panel, entry points, DuckDuckGo | done (Linux; macOS unverified) |
| 2 Onion-Location | Ordinary windows: the address bar offers ".onion available" for sites that send `Onion-Location`; `.onion` links open in a Tor window | design |
| 3 Bridges | Settings for built-in bridges (obfs4, Snowflake) and custom bridge lines; pluggable transports found like tor | design |
| 4 Packaging | tor (and transports) bundled, signature-checked, updated with Aequera | builds: done (`tools/tor`, Tor Browser 15.0.25's expert bundle; Linux verified, macOS pinned); release installers: design |
| 5 Windows | A loopback TCP port in place of the Unix socket, with its own review | design |
| 6 Tor page | The Tor window's private browsing page says it is a Tor window and shows the connection | design |
