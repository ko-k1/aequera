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
  starts the same binary on it (`-app` identity ini, `-profile`,
  `-private-window`). When the Tor instance is already running (its marker
  `P/tor/running` exists), the same command line goes to it through
  Firefox's per-profile remoting. The child environment drops the
  variables that pick a profile ahead of `-profile` and those that turn on
  automation (Marionette, Remote Agent).
- **Fresh profile.** The Tor profile is removed and rewritten whenever no
  Tor instance runs. tor's data directory beside it is kept: guards and
  the directory cache, so later starts connect in seconds (2.5 s measured,
  10.5 s the first time).
- **Load order.** `tor/aequera-tor.js` is the first window script. In the
  Tor instance it locks the prefs and starts tor before any other feature
  runs. Everything that needs markup waits for `load`.

## Network model

### Prefs

Every pref of the Tor instance, with its reason, is in `tor/tor-model.js`
(`PREFS`). They are written to the profile's `user.js`, so they apply before
any network activity. The **required** ones keep traffic on Tor. At the
first window the instance sets each one on the default branch, locks it,
and checks it (`checkRequired`). If any is not in force, the process goes
offline and stays there ("refused"). A locked pref ignores writes (about:config,
add-ons), so a tampered `user.js` value is overridden, not obeyed.

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

Before tor listens, the socket does not exist, and loads fail with
`proxyConnectFailure`. That is the same when tor stops. Nothing falls back
to a direct connection. A failed `tor` shows the notification with "Restart
Tor".

## tor

- Found as `aequera.tor.executable` (copied from the ordinary profile) or
  as `tor` on `PATH`. It is never downloaded. Missing: "Tor offline" with the
  reason.
- Configuration `P/tor/torrc`, read alone (`-f`, empty `--defaults-torrc`):
  `DataDirectory`, `SocksPort unix:"<socket>" IsolateSOCKSAuth`,
  `ControlPort 0`, `ClientOnly 1`, `__OwningControllerProcess <pid>` (tor exits
  with the instance), `AvoidDiskWrites 1`, `Log notice stdout`.
- Bootstrap progress and errors come from tor's log (`parseLogLine`); there
  is no control port in slice 1.
- On quit: the filter is unregistered, tor is killed, and the socket
  directory and the marker are removed.

## Configuration

| Pref | Profile | Default | Effect |
|---|---|---|---|
| `aequera.tor.enabled` | ordinary | true | Off: no entry points |
| `aequera.tor.executable` | ordinary | "" | tor's absolute path; empty: `tor` on PATH |
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
- Live check, 2026-10-14, tor 0.4.9.14 from nixpkgs (`.tmp/e2e` scripts:
  Marionette into both instances; headless sway for the window manager).
  15 of 15 passed:
  - tor bootstraps (10.5 s on first start, 2.5 s with the kept directory);
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

### On each upstream update

Re-check what can route around the proxy: new prefs in
`network.proxy.*`, `network.dns.*`, HTTP/3 and WebTransport, WebRTC, new
`registerChannelFilter` callers, and new direct-connection paths in
`ServiceRequest`. Then run the live check.

## Slices

| Slice | Content | State |
|---|---|---|
| 1 Tor windows | Two instances, required prefs locked, per-site circuits, tor child, Tor button and panel, entry points, DuckDuckGo | done (Linux; macOS unverified) |
| 2 Onion-Location | Ordinary windows: the address bar offers ".onion available" for sites that send `Onion-Location`; `.onion` links open in a Tor window | design |
| 3 Bridges | Settings for built-in bridges (obfs4, Snowflake) and custom bridge lines; pluggable transports found like tor | design |
| 4 Packaging | tor (and transports) bundled with release builds, signature-checked, updated with Aequera | design |
| 5 Windows | A loopback TCP port in place of the Unix socket, with its own review | design |
| 6 Tor page | The Tor window's private browsing page says it is a Tor window and shows the connection | design |
