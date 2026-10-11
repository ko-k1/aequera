# Ad Veil

Status: proposed (ADR 0003). Slices 1 (block and hide), 2 (vault,
per-site modes), and 2b (veil mode) are implemented
(`aequera/extensions/ad-veil`); slices 3–5 are design.

Ad Veil is how Aequera handles ads: block what the filter lists match at the
network layer, hide what still reaches the page, keep a local vault of it,
and optionally visit hidden ads the way AdNauseam does
(`docs/adr/0003-aequera-owned-ad-veil.md`).

## Goals

1. Pages read without ads or trackers from the first run.
2. Matching never runs on the chrome thread.
3. Sites that wall ad blockers can be read through veil mode.
4. The user sees what was blocked or hidden (vault) and controls all of it.
5. No Aequera request without a user-visible reason.

Non-goals: malware blocking (Safe Browsing owns it), full uBlock Origin
filter syntax, an element picker (later, if a recurring task shows it),
in-player video ad defeat.

## Model

| Part | What it does | Default |
|---|---|---|
| Block | Cancels requests matched by network rules. | on |
| Hide | Applies cosmetic rules to what reaches the page. | on |
| Veil (per site) | Lets ad requests through (Ad Veil's lists, tracking protection's ad blocks, Firefox's ad shims) and hides the ads in place (AdNauseam's model); tracking protection keeps blocking analytics, social, fingerprinting, and cryptomining trackers. | off; chosen per site in the popup |
| Vault | Records blocked and hidden ads locally. | on |
| Visit | Requests hidden ads' target links in the background. | on, shown at first run |
| List updates | Fetches current EasyList / EasyPrivacy. | on, shown in the panel |

"On by default" (decided 2026-10-11) still means shown: the first-run
screen lists each part with its effect and the user confirms it.

## Engine (measured)

adblock-rust 0.13.3 (`adblock` crate, MPL-2.0) behind a small C ABI
(`aequera/extensions/ad-veil/engine`), built for `wasm32-unknown-unknown`
(no imports), loaded by the add-on's background page in the extension
process. Requests reach it through blocking `webRequest.onBeforeRequest`;
the parent process only suspends and resumes the channel.

Spike, 2026-10-11, EasyList + EasyPrivacy (138,470 lines), adblock-rust's
242,945-request corpus:

| | native | WebAssembly (bun/JSC) |
|---|---|---|
| compile both lists | 70 ms | 107 ms (40 MiB peak) |
| load serialized engine | 17 ms | 44 ms |
| memory, loaded | | 13.7 MiB |
| check, mean | 3.6 µs | 7.3 µs (p50 5.7, p99 28.6) |
| blocked | 105,644 | 105,644 |
| cosmetic lookup per page | | 0.05 ms |

In Aequera (slice 1, SpiderMonkey in a content process, the JIT the
extension process uses; 30,368 corpus requests, timer precision restored for
the run): 8.5 µs mean per check, p99 40 µs, p999 60–120 µs (20 µs timer
granularity), rare maxima near 2 ms; list compile 115 ms; module
instantiate 157 ms; cosmetic lookup 0.18 ms per page; 43.7% blocked, as
native. Why not declarativeNetRequest: ADR 0003 (parent-process linear
scan, 30,000-rule guarantee).

## Architecture

```text
build time                                    runtime (built-in add-on, extension process)
------------------------------------------    -------------------------------------------------
lists/ snapshots (EasyList, EasyPrivacy)      background
engine/ crate --cargo--> engine.wasm            engine.wasm: compile lists (each start, update)
                                                webRequest.onBeforeRequest (blocking) -> check
                                                cosmetic lookup per frame -> insertCSS (user)
                                              content script (all frames, document_start)
                                                class/id scan -> generic selectors
                                              vault store, visit queue (later slices)
```

### Packaging (verified against Firefox 157)

- Overlay `ad-veil`: `aequera/extensions/ad-veil/addon` →
  `worktree/firefox/browser/aequera-adveil`. Its `jar.mn` packages the
  add-on under `browser.jar: builtin-addons/adveil/…`.
- The shell overlay's `moz.build` adds `DIRS += ["/browser/aequera-adveil"]`
  (topsrcdir path, as `mozglue/moz.build` does for `/third_party/fmt`), so no
  Firefox patch lists the new directory.
- `gen_built_in_addons.py` scans `builtin-addons/*/manifest.json` into
  `built_in_addons.json`; the XPIProvider built-in location installs it.
- Built-in add-ons are hidden, system, privileged, and get private-window
  access. A test holds `manifest.json` to `storage`, `unlimitedStorage`,
  `tabs`, `webNavigation`, `webRequest`, `webRequestBlocking`, and
  `<all_urls>`. No `mozillaAddons`; one experiment API, `aequeraVeil`,
  parent process only (Veil mode, below).
- `aequera.adveil.enabled` (default true) is applied by Aequera chrome code
  with `AddonManager` enable/disable and `allowSystemAddons` (the add-on
  manager refuses to disable a system add-on otherwise), as Firefox does in
  `BrowserGlue` for the webcompat reporter.

### Rules

- Snapshots of EasyList and EasyPrivacy are committed under
  `addon/lists/` with their license and version header (the uBlock Origin
  and AdNauseam repositories do the same). They are refreshed per release
  and are the known-good fallback for updates.
- The engine compiles them at every start (slice 1; about 270 ms with
  instantiation). Caching the serialized engine (44 ms load in the spike)
  is the planned startup improvement, with the snapshots as fallback.
- Until the engine is ready, `onBeforeRequest` waits for it (as uBlock
  Origin does on Firefox) instead of letting requests through.
- Unsupported syntax is skipped by adblock-rust; scriptlets are not loaded
  (no resources), so `##+js` rules do nothing.

### Hiding

- Host-specific selectors: from `url_cosmetic_resources`, injected per frame
  with `tabs.insertCSS({ cssOrigin: "user" })` when the navigation commits
  (`webNavigation.onCommitted`).
- Generic selectors: the content script collects class and id names and
  asks for matches (`hidden_class_id_selectors`), so no page carries the
  full generic list.
- Every selector is parsed by Gecko as one rule and kept only if it is a
  single style rule whose only declaration is the hiding one, so list data
  cannot add declarations (a `url()` that leaks page state) or rules.
- `display: none !important` (collapse) in block mode; veil mode uses
  `opacity: 0 !important; pointer-events: none !important`, which keeps the
  element's box so size-based bait checks pass. Each style is validated as
  its own rule (only its declarations).

### Toolbar button and popup

- A toolbar button (`browser_action`, navbar): its badge is this page's
  blocked count (`12`, `1.2k`; none for 0 or Off), its tooltip the counts
  and mode ("Ad Veil: 12 blocked, 3 hidden on this page", "Ad Veil, veil
  mode: …", "Ad Veil is off for …"), its icon (theme colored,
  `context-fill`) the mode: shield with a band (block), a dotted band
  (veil), struck through (off).
- The popup (`pages/popup.html`), after uBlock Origin's and AdNauseam's:
  the site and "On this site: Block · Veil · Off" (native radios) with a
  line on what the mode does; tiles for this page (blocked, with its share
  of the page's requests; ads hidden; domains blocked of those contacted);
  "Blocked on this page" by host with share bars; "Ads hidden here" (saved
  image, words, destination); all-time totals; "Open vault" and the
  dashboard. Choosing a mode reloads the page, since blocking and hiding
  apply from a page's start.
- A mode set for a site covers its subdomains (`example.com` covers
  `news.example.com`); the site is the host without a leading `www.`. Off
  wins over veil. Off means no blocking, no hiding, no recording, and the
  content script stops.

### Vault (slice 2)

- IndexedDB in the add-on only (`vault.js`; the background page is its only
  writer), never synced or uploaded; export (JSON) and a two-step clear are
  explicit. A database that cannot be opened is recreated empty.
- Hidden ads: one entry each (time, site, page, link, creative URL, up to
  200 characters of text), deduplicated per page, newest 5,000 kept.
  Content scripts find them by querying the applied selectors when the page
  is idle; what they send is validated (http(s) URLs only, bounded sizes).
- Reading an ad: real ad slots draw their ad into iframes a script writes
  after the slot exists (Google Publisher Tags: `src`-less friendly
  iframes; safeframes on another origin). The page's content script looks
  inside same-origin frames (largest real image, not 1×1 pixels; its link;
  visible text, not script text) and looks again at 1, 3, 8, and 15 s; a
  cross-origin frame found in a hidden slot is reported to the background,
  and that frame's own content script, told it is an ad, describes it.
- Which ads there are depends on the mode: in block mode ad requests never
  happen, so only ads that reached the page anyway are recorded; veil mode
  is where the vault fills (AdNauseam's model).
- Links point where the ad leads: the advertiser address in an ad click URL
  (`adurl=` and similar), opened directly, so following one from Ad Veil is
  not an ad click.
- Blocked requests: per day, site, and blocked host, a count (a page can
  block dozens; single entries would drown the ads). Summed in memory,
  written every 5 seconds.
- Everything older than 90 days is dropped (hourly prune).
- Private windows are never recorded; their counts exist only in the popup.
- Saved images ("Save ad images", on by default): when an ad is recorded and
  the page had loaded its image (an image still loading is waited for), the
  background fetches that image once, without cookies or a referrer, and
  keeps a thumbnail (at most 320 px, WebP; an image it cannot decode is
  kept as is if small) keyed by its URL, at most 2,000, dropped with the
  ads. The popup and vault show the saved thumbnail and make no request
  themselves. Never in private windows; nothing is fetched with the
  setting off. The fetch has no tab, so Ad Veil's blocking skips it, and
  tracking protection lets an add-on with host access load it
  (`UrlClassifierCommon::AddonMayLoad`).
- The dashboard (`pages/dashboard.html`): Vault (first), Blocking
  (all-time totals, 7-day chart, most blocked hosts and sites), Sites
  (per-site modes), Settings ("Keep a vault", "Save ad images", export,
  clear, list versions).
- The vault view follows AdNauseam's vault, in Aequera's own code and
  tokens:
  - numbers: ads found (every sighting), different ads, advertisers (sites
    ads lead to), sites they were found on; a Statistics section with the
    top advertisers, ad networks (sites serving the images), and sites;
  - the same ad found again is one ad with a count (an image ad by its
    image URL; a text ad by its words and the site it leads to;
    `VeilModel.groupAds`);
  - a wall that packs ads of any shape (CSS grid rows by height), newest
    first, at six sizes (zoom buttons, Ctrl+wheel; the size is remembered
    in `localStorage`, a per-viewer convenience); text ads as text boxes;
    added 120 at a time as it scrolls;
  - a timeline of ads found per day (from the first ad, 14 to 90 days):
    dragging across it, or the From/To date fields, filters the wall to
    those days, and the days left out are faded; tooltip and table view;
  - search, site, and kind (image, text) filters;
  - an inspector (a modal dialog): the image at full size, words, where it
    leads, the ad network, the page it was found on and when, and each
    time it was found ("2 / 5", arrows and arrow keys); removing it from
    the vault (two clicks) drops every sighting and its saved image.
  - No click count or cost estimate (AdNauseam's) until Visit exists.
- Known gap: Firefox's "Clear history" does not clear the vault (an add-on
  learns of it only with the `history` permission); the vault's own Clear
  and its 90-day limit do.

### Veil mode (slice 2b)

For sites that refuse ad blockers, and the vault's source of ads
(AdNauseam's model): ads load and are hidden in place. Three things stand
between a page and its ads; veil mode lifts each.

- **Ad Veil's own.** One engine holds both lists and decides every request,
  so an exception rule in either list applies to both. On a veiled site its
  matches load, except beacons, pings, and CSP reports. EasyPrivacy is not
  kept blocked there: it lists whole ad networks and bidders as trackers
  (`||media.net^$third-party`, `||nexx360.io^$third-party`, …). Measured on
  dictionary.com (2026-10-11, live, Strict tracking protection): keeping
  EasyPrivacy blocked left 0 of its ad slots defined (178 requests
  blocked); lifting it only for EasyList ad hosts, 0 (132); lifting it,
  2/2 and 1/2 filled. Trackers on a veiled site are left to Firefox's
  tracking protection (below), as AdNauseam leaves them to cookie blocking.
- **Firefox's ad SmartBlock shims.** When tracking protection blocks a known
  ad script (Google Publisher Tags, AdSense, IMA, Amazon, Criteo, …),
  Firefox's webcompat add-on redirects it to a stub that never draws an ad,
  and it does so even after `aequeraVeil` allowed the block (webcompat
  marks the request "replaced" first; `lib/shims.js`). The 13 ad-delivery
  shims are off while Ad Veil is on (`extensions.webcompat.disabled_shims.*`
  on the default branch, from `adveil/aequera-adveil.js`; back on when Ad
  Veil is off; a value set by hand wins). In block mode nothing changes:
  Ad Veil's cancel of those scripts runs before webcompat's redirect
  (measured: `gpt.js` ends `NS_ERROR_ABORT` from Ad Veil). Analytics and
  measurement shims are untouched.
- **Firefox's tracking protection.** Strict blocks every major ad network
  (Disconnect's Advertising category: `ads-track-digest256`; Google's ad
  hosts are on the fingerprinting list too), and does it in
  `nsHttpChannel::AsyncOpen`, before any extension's `onBeforeRequest`.
  `experiments/veil.js` (the add-on's one privileged API, parent process
  only) listens to Firefox's channel classifier service while a site is
  veiled and `allow()`s, on that site only:
  - a tracking-protection block from an advertising table
    (`aequera.adveil.veil.adTables`) or of an EasyList ad host;
  - a fingerprinting-protection block of an EasyList ad host (EasyList's
    whole-host `||host^` rules: 50,177 hosts, 21 ms to extract).
  Social, cryptomining, email, and analytics blocks stay. Firefox's site
  exception (the shield's "off") is not used: it would also lift tracking
  protection's cookie and storage rules. An allowed channel is still a
  tracking channel to Firefox, so its tracker cookie rules keep applying;
  Ad Veil therefore strips no headers itself.
- Modes resolve the same way on both sides (`model.js`, `resolveMode`,
  loaded into the parent API).
- Cost: one check per request in every mode (8.7 µs mean, p99 40 µs in
  SpiderMonkey over 30,368 corpus requests); one engine instance (lists
  compile in about 115 ms at start).
- End to end (2026-10-11, live, fresh profile, defaults, dictionary.com
  veiled): ad slots 1/2 and 2/2 filled over two runs; the vault recorded
  the Google ads with their destinations and saved images.
- Not covered: walls that check something other than ad requests and bait
  sizes (scriptlet-level defusing is not loaded), and ads served from
  hosts EasyList does not list whole that Firefox blocks as fingerprinters.
  Slice 5 measures what remains.

### Visit (slice 4)

- Background `fetch(target, { credentials: "omit", referrerPolicy:
  "no-referrer" })`, response discarded, status logged in the vault.
- At most once per ad, a probability setting, a per-hour cap, randomized
  delay; never from private windows or sites the user turned Ad Veil off on.
- First-run text says it plainly: it uses your connection, ad networks
  treat it as invalid traffic, and it may count against the site.

### Network

| Request | Reason the user can see |
|---|---|
| Page requests not matched | the page itself |
| Visit | first-run choice, vault log |
| Saved ad images | "Save ad images" (Settings): once per image the page already loaded |
| List updates | panel: "Lists updated N days ago · Update now" |

A browser test fails on any request from the add-on outside this table.

## Configuration

One pref, the global switch, applied by Aequera chrome code:

| Pref | Type | Default |
|---|---|---|
| `aequera.adveil.enabled` | bool | `true` |
| `aequera.adveil.veil.adTables` | comma-separated classifier tables | `ads-track-digest256` (the tracking-protection tables veil mode lifts) |

Everything else is Ad Veil's own setting, kept in the add-on's
`storage.local` (an add-on cannot read prefs) and changed in its pages:

| Setting | Type | Default | Where |
|---|---|---|---|
| `offSites` | list of sites | `[]` | popup, Off |
| `veilSites` | list of sites | `[]` | popup, Veil |
| `vault` | bool | `true` | dashboard Settings, "Keep a vault" |
| `saveImages` | bool | `true` | dashboard Settings, "Save ad images" |
| visit, list updates | | slices 3–4 | first run, panel |

Settings are validated on every load (`model.js`, `settingsFrom`): unknown
or malformed values fall back to the defaults, and settings saved before
veil mode keep their sites. Modes chosen in a private window are kept in
memory only and win there (nearest site first) until the browser closes,
so a private visit never reaches the profile. A compiled engine or list
update that fails to load falls back to the shipped snapshots (`AGENTS.md`:
configuration failures recover to a known-good state).

## Performance budget

- Chrome: no new parent-process work per request beyond webRequest's
  channel suspend; rail, address bar, and command surface latency unchanged.
- Startup: first window not delayed; first-run compile happens in the
  extension process.
- Per request: p99 under 100 µs in SpiderMonkey.
- Memory: add-on process share under 60 MiB with both lists loaded.

Missing the budget points to the Gecko-level alternative in ADR 0003.

## Measurement (slice 5)

A real-launch corpus of about 30 live sites (news with anti-adblock walls,
recipes, forums, video, regional), driven by Marionette, run manually. Per
site and mode (off, block, veil), with uBlock Origin temp-installed as a
dev-only baseline: wall shown, ads leaked, layout gaps, load time, and
whether ETP's `ads-track-digest256` blocked a request before Ad Veil saw it.

## Slices

| Slice | Delivers | Acceptance |
|---|---|---|
| 1 Block + hide | engine crate + wasm, list snapshots, built-in add-on, webRequest blocking, cosmetic hiding, `aequera.adveil.enabled` | engine tests; fixture page: ad request blocked and ad element hidden, pref off restores both; manifest permission test; real launch installs the add-on; SpiderMonkey per-request numbers recorded |
| 2 Vault + controls | vault store and page, address bar button and popup, per-site off | done: vault records the fixture's ad (link, site, text, image) and blocked host; private windows record nothing (mutation-checked); popup switch turns blocking and hiding off and on for the site; no request of the add-on's own with the vault open |
| 2b Veil mode | per-site veil: list split, veil style, `aequeraVeil` classifier listener | done: on a veiled page the EasyList ad and an ad network tracking protection blocks load, an EasyPrivacy tracker and a social tracker stay blocked, the ad element keeps its box (invisible, unclickable), tracking protection stays on for the site, and Block restores it all (Firefox's test trackers; mutation-checked: fails without `allow()`) |
| 3 Updates | automatic list updates with fallback | update shows in the panel; a corrupt download keeps the previous set |
| 4 First run + Visit | first-run screen, visit queue | every visit logged; limits enforced; private windows never visit |
| 5 Tune | corpus run, ETP ads-list decision | numbers recorded here |
