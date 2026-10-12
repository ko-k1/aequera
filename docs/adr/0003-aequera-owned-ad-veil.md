# ADR 0003: Aequera-Owned Ad Veil

## Status

Proposed

## Decision

Aequera ships its own ad handling, **Ad Veil**, instead of bundling a
third-party blocker extension (uBlock Origin, AdNauseam).

- **Block, then hide.** Requests matching the filter lists are blocked at
  the network layer; ads that still reach the page (first-party, inline,
  static) are hidden by cosmetic rules. Per site, the user can switch to
  **veil** mode: AdNauseam's model, where visual ads load and are hidden
  instead of blocked (rendered, invisible, and collapsed, so the page closes
  up around them), for sites that wall ad blockers and as the vault's
  source of ads. Firefox's tracking protection stays on for the site and
  keeps blocking analytics, social, fingerprinting, and cryptomining
  trackers: veil mode lifts only its blocks of ad servers, through one
  parent-only privileged API (`aequeraVeil`), and Firefox's ad SmartBlock
  shims are off while Ad Veil is on (they would stub out those ads). Ad
  Veil's own lists let their matches through on a veiled site (EasyPrivacy
  lists whole ad networks as trackers; measured in `docs/design/ADS.md`).
- **Popups and redirects.** In every mode but off, a window a page opens
  is closed when the lists' popup rules name it or the click behind it was
  on plain content (a "click anywhere" popup), and a script redirect to
  another site on such a click is stopped (`webNavigation`, `tabs`, the
  content script; no further privilege).
- **Vault and Visit.** What was blocked or hidden is kept in a local vault;
  hidden ads can be *visited* in the background (AdNauseam's simulated
  click). All on by default, shown and changeable at first run.
- **Engine.** adblock-rust (Brave, MPL-2.0) compiled to WebAssembly, running
  in the extension process behind blocking `webRequest`. Rules: EasyList and
  EasyPrivacy, shipped as snapshots and kept current by automatic,
  user-visible updates.
- **Packaging.** A first-party built-in add-on: overlay `ad-veil`
  (`aequera/extensions/ad-veil/addon` → `browser/aequera-adveil`), reached
  from the shell overlay's `moz.build` and packaged under `builtin-addons/`.
  No Firefox patch.

Design and measurements: `docs/design/ADS.md`.

## Context

- Helium bundles a uBlock Origin fork as a Chromium component extension.
  Aequera wants the same "works from the first run", without third-party
  extension code, defaults, or update channels.
- Strict Enhanced Tracking Protection stays the network privacy model
  (decided 2026-10-11); Ad Veil adds to it.
- The engine must not load the parent process main thread, which is the
  browser chrome thread (`AGENTS.md`: chrome stays responsive under heavy
  content).

## Rationale

- **Owned behavior.** Every request and default is Aequera's to justify
  under `docs/RESTRICTIONS.md`. AdNauseam 3.29, for one, requests
  `api.github.com` on every startup and discards the answer on Firefox.
- **Engine placement.** Firefox 157's declarativeNetRequest evaluates rules
  in the parent process (`WebRequest.sys.mjs` → `ExtensionDNR.handleRequest`)
  with a linear scan over every enabled rule per request
  (`#collectMatchInRuleset`), and guarantees 30,000 static rules; EasyList
  + EasyPrivacy are about 138,000 lines. Blocking `webRequest` instead
  suspends the channel and matches in the extension process.
- **Engine choice.** adblock-rust parses EasyList syntax, token-indexes
  network rules, serializes to a flat buffer, and builds for
  `wasm32-unknown-unknown` with no imports. Measured on 242,945 corpus
  requests: 7.3 µs per request in WebAssembly under JSC, 13.7 MiB loaded,
  same block decisions as native; in Aequera's SpiderMonkey 8.5 µs mean,
  p99 40 µs (slice 1).
- **No patch.** `gen_built_in_addons.py` lists every
  `browser/chrome/browser/builtin-addons/*/manifest.json`; the XPIProvider
  built-in location installs each. The `aequera.adveil.enabled` pref
  enables and disables it with `allowSystemAddons`, as Firefox does for its
  own pref-driven system add-ons (`BrowserGlue`, webcompat reporter).
- **Veil mode needs one privileged API.** Strict tracking protection blocks
  every major ad network (Disconnect's Advertising category, Firefox's
  `ads-track-digest256`; Google's ad hosts are also on its fingerprinting
  list) in `nsHttpChannel::AsyncOpen`, before `http-on-modify-request`, so
  before any extension's `onBeforeRequest`. Turning tracking protection off
  for the site (Firefox's site exception) would also lift its cookie rules
  (`ContentBlockingAllowList::Check` in `StorageAccess.cpp`). Instead,
  `aequeraVeil` listens to Firefox's channel classifier service, as
  Firefox's own webcompat add-on does, and `allow()`s single blocks: on a
  veiled site, a tracking-protection block from an advertising table or of
  an EasyList ad host, and a fingerprinting-protection block of an EasyList
  ad host. An allowed channel is still a tracking channel to Firefox, so its
  tracker cookie rules keep applying. A channel it allowed that has no
  response 10 seconds later it cancels, as Firefox would have (an ad server
  that never answers holds the page's load event; measured on cnn.com). The
  API is parent-only, has two functions (ad hosts, site modes), and listens
  only while a site is veiled.

## Consequences

### Positive

- Ad and tracker blocking from the first run, with Aequera's prefs, design
  system, and recovery rules.
- Matching cost lands in the extension process, not on the chrome thread.
- One engine (both lists) decides every request and every cosmetic rule, so
  exception rules apply across lists. The same code compiles the shipped
  snapshots at start and updated lists later.

### Costs

- A third-party library (adblock-rust, MPL-2.0, with its `css-validation`
  feature: Servo's cssparser and selectors, MPL-2.0) and third-party data
  (EasyList, EasyPrivacy: GPLv3 / CC BY-SA 3.0, dual) become dependencies.
  Both are pinned, attributed, and updated deliberately.
- A committed WebAssembly binary built from `aequera/extensions/ad-veil/engine`;
  a script rebuilds it and checks the hash.
- Built-in add-ons are hidden from about:addons and run in the privileged,
  system location: Ad Veil needs its own controls, and a test holds its
  manifest to least privilege (no `mozillaAddons`; one experiment API,
  `aequeraVeil`, parent-only).
- `aequeraVeil` depends on Firefox's channel classifier service and its
  feature order (fingerprinting before tracking protection), which upstream
  can change; the veil-mode browser test exercises it with Firefox's test
  trackers on every gate run.
- Blocking makes anti-adblock walls more likely than AdNauseam's model;
  veil mode per site is the answer, measured on a site corpus. A veiled site
  loads its ads' scripts (cost: bandwidth, CPU, the ad networks seeing the
  visit), which is why it is the user's per-site choice.
- Visiting ads uses the user's connection and is treated by ad networks as
  invalid traffic. It is visible (first run, vault log) and can be turned
  off at any time.

## Rejected Alternatives

### Bundle AdNauseam or uBlock Origin

Signed AMO builds work through `distribution/extensions` with no patch, but
bring third-party requests (AdNauseam's startup GitHub check), defaults, UI,
and update channels. Building either from source makes Aequera the
maintainer of a large fork.

### declarativeNetRequest

Parent-process, linear matching and a 30,000-rule guarantee (above).

### Gecko-level engine (adblock-rust in a Gecko patch)

Fastest matching, but an exceptional Gecko patch with a permanent rebase
cost. Revisit only if the extension engine misses the budget in
`docs/design/ADS.md`.
