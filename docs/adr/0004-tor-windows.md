# ADR 0004: Tor Windows

## Status

Proposed

## Decision

Aequera offers **Tor windows**: private windows whose traffic goes through
the Tor network, opened next to ordinary windows (Brave's "New Private
Window with Tor"). Ordinary windows and ordinary private windows never use
Tor.

- **A separate browser instance.** A Tor window belongs to a second
  Aequera process. It runs the same build on a throwaway profile
  (`<profile>/tor/profile`), always in private browsing
  (`browser.privatebrowsing.autostart`). The ordinary instance only starts
  it, or asks the running one for another window through Firefox's
  per-profile remoting. Tabs, cookies, storage, caches, and connections are
  never shared: they belong to different processes.
- **The whole instance goes through Tor.** Its proxy is Firefox's global
  SOCKS5 proxy, set before anything loads (the profile's `user.js`) and
  locked once the first window opens. The proxy is a Unix domain socket
  (`network.proxy.socks = file://…`) of a tor daemon the instance runs
  itself. There is no local DNS (`network.dns.disabled`), the proxy
  resolves every host name, and nothing falls back to a direct connection
  (`network.proxy.failover_direct`, `network.proxy.allow_bypass` off).
  Before tor is up, the socket does not exist and every load fails. That
  is the fail-closed state, never a direct connection.
- **Offline until checked.** The instance starts with Firefox's `-offline`
  and goes online only after it has locked and checked its prefs and
  registered its circuit filter. If that code never runs (a script that
  fails to load after an upstream change), the instance stays offline. If
  a check fails (a pref's value or its lock), or the instance cannot mark
  itself running, it stays offline for good ("refused"): going online again
  is undone, and every channel is sent to a socket that does not exist.
- **Per-site circuits.** A channel filter gives each channel SOCKS
  credentials named after its top-level site, and tor's default
  `IsolateSOCKSAuth` gives each site its own circuits. "New circuit for
  this site" changes that site's password and reloads it.
- **tor, not Arti; Tor Browser's own tor, bundled.** The daemon is C tor
  (the Tor Project's reference client), as the Tor Project ships it in the
  **tor expert bundle**: the same tor, libraries, and pluggable transports
  as Tor Browser. A build carries it as `<app>/tor`. It is pinned by
  SHA-256 in `upstream/manifests/tor-expert-bundle.lock`; the pins come
  only from a release's checksum list whose signature verifies with the Tor
  Browser Developers key (`tools/tor`). It is fetched at build time, never
  by the browser. The Tor instance runs `aequera.tor.executable` when set,
  else the bundled tor, else `tor` on `PATH`. Where none is found, the Tor
  window explains that. (Amended 2026-10-14: first "found, not fetched".)
- **No Firefox patch.** All of this is Aequera shell source
  (`aequera/shell/firefox/tor`): window script, two modules, a pure model.

Design, prefs, and verification: `docs/design/TOR.md`.

## Context

- Brave's Tor window is a private profile whose network context goes
  through a bundled tor, with per-site circuits and no local DNS. Brave
  says it does not protect as much as Tor Browser (no fingerprinting
  uniformity). Aequera promises that much: it hides the user's IP address
  and DNS from sites and the network, and keeps sites unlinked. Since
  2026-10-14 it also takes Tor Browser's and Mullvad Browser's hardening
  (fingerprinting resistance, HTTPS-only, security levels;
  `docs/design/TOR.md`), but it still does not join Tor Browser's crowd.
- Firefox keeps one private-browsing context per process
  (`privateBrowsingId` 1). A Tor window in the same process would share
  private cookies and storage with ordinary private windows, unless every
  tab carried a reserved container: every way of opening a tab (new tab
  button, links, drag and drop, moving tabs between windows) would have to
  set it, and a tab that missed it would share state silently.
- `docs/RESTRICTIONS.md`: every network activity needs a user-visible
  reason. The Tor network is used only from a Tor window the user opened.

## Rationale

- **Leaks are the failure that matters.** A per-channel proxy filter in the
  ordinary instance (Firefox's `nsIProtocolProxyChannelFilter`) sees only
  channels. DNS prefetch, speculative connections, WebRTC ICE, HTTP/3, and
  WebTransport, and system requests with direct failover (`ServiceRequest`)
  all live outside it or around it, and each new Firefox feature can add
  another. A global SOCKS proxy with DNS disabled is what Tor Browser
  relies on: in that process, anything that does not go through the proxy
  cannot resolve a name.
- **A Unix socket fails closed.** A TCP port picked before launch can be
  taken by another process. A port tor picks itself is not known when the
  profile is written, and an unset port makes Firefox's proxy service fall
  back to DIRECT (`nsProtocolProxyService::Resolve_Internal`). A socket
  path is known in advance, is private to the user (a 0700 directory), and
  refuses connections until tor listens.
- **Isolation by site.** Firefox includes SOCKS credentials in the HTTP
  connection key (`nsHttpConnectionInfo::BuildHashKey`), so two sites never
  share a connection and a new password never reuses an old one.
- **No control port in the first slices.** tor's log on stdout gives
  bootstrap progress and errors. New circuits come from SOCKS credentials.
  `__OwningControllerProcess` makes tor exit with the instance.

## Consequences

### Positive

- One leak model, Tor Browser's, enforced by prefs that the instance
  locks and checks at startup (it refuses to browse if they are wrong).
- Nothing persists from a Tor session except tor's own state (guards and
  directory cache, `<profile>/tor/data`), which tor needs to start quickly
  and to keep its guards.
- No Firefox patch, so no rebase cost.

### Costs

- A second browser process tree: memory (one more parent process) and about
  a second of startup, which overlaps tor's bootstrap (several seconds).
- Tor windows have no bookmarks, history, or extensions of the ordinary
  profile. Ad Veil, which is built in, runs in them.
- Tor Browser's and Mullvad Browser's hardening is taken as prefs
  (fingerprinting resistance with letterboxing, HTTPS-only, and the rest;
  security levels), amended 2026-10-14. Still no membership in Tor Browser's
  crowd: another Firefox version and no bundled fonts. This is stated in the
  Tor window panel and in the doc.
- Unix (Linux, macOS) first: Firefox reaches a local SOCKS proxy on Windows
  only through a named pipe, which tor does not offer. Windows needs a TCP
  port design and its own review.
- The prefs that keep the instance on Tor are Firefox prefs. Upstream can
  add network features that need a new entry. Every pref is listed with its
  reason in `tor/tor-model.js`, and `docs/design/TOR.md` names the
  re-check for each upstream update.

## Rejected Alternatives

### Per-channel proxy filter in the ordinary instance

Shares private browsing state with ordinary private windows and leaves
non-channel network paths to be found one by one (above).

### Route every private window through Tor

Changes what an ordinary private window means and makes Tor's latency the
price of every private window. Brave keeps the two apart, and so does
Aequera.

### Arti (the Rust Tor client)

It fits the Rust workspace, but has no control port for status. Its onion
service client and bridge support are newer than C tor's. Revisit when
Arti's RPC and security parity are stable.

### Download tor on first use (Brave's component updater)

A silent binary download and an update channel of its own, against
`docs/RESTRICTIONS.md`. The expert bundle is fetched when Aequera is built
instead, pinned and signature-checked, and updated with Aequera.

### Build tor from source in the Aequera build

A C build of tor, libevent, and OpenSSL, and the Go builds of the
transports, would duplicate Tor Browser's reproducible build. The expert
bundle is that build's output, signed by the same developers.

### Require a system tor

Distribution packages lag Tor Browser's tor, are absent on macOS, and are
one more install step before a Tor window works. A system tor still works:
on `PATH`, or named by `aequera.tor.executable`.
