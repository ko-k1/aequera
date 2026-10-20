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
                                                  selectors + the frame's mark rule
                                              content script (all frames, document_start)
                                                class/id scan -> generic selectors
                                                procedural filters, emptied wrappers -> mark
                                                hidden ads -> vault
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
- adblock-rust is built with `css-validation`, so procedural operators
  (`:has-text()`, `:-abp-contains()`, `:upward()`, `:xpath()`, `:remove()`,
  …) parse into operator chains instead of passing as plain selectors no
  browser accepts. Measured on the shipped lists: 24,459 plain cosmetic
  rules, 219 procedural (before: 0; they were dropped as invalid CSS), 7
  rejected (1 before). Cost in SpiderMonkey: engine.wasm 2.56 → 2.71 MB,
  instantiate 155 → 177 ms, list compile 101–111 → 112–134 ms; request
  checks unchanged (9.2–10.2 µs, p99 40 µs, same decisions on 30,368 corpus
  requests); cosmetic lookup unchanged (0.21 ms per page).
- Other unsupported syntax is skipped by adblock-rust; scriptlets are not
  loaded (no resources), so `##+js` rules do nothing.

### Hiding

- Host-specific selectors: from `url_cosmetic_resources`, injected per frame
  with `tabs.insertCSS({ cssOrigin: "user" })` when the navigation commits
  (`webNavigation.onCommitted`).
- Generic selectors: the content script collects class and id names and
  asks for matches (`hidden_class_id_selectors`), so no page carries the
  full generic list.
- Procedural filters (host-specific only, as adblock-rust allows): the
  background validates them (`VeilModel.proceduralFrom`: known operators,
  string arguments, actions hide, `remove`, `remove-attr`,
  `remove-class`; `:style()` is never applied, so list data sets no styles)
  and `procedural.js` runs them in the content script when the page is
  idle. What they hide is marked with the frame's **mark**: an attribute
  with a random name per frame, hidden by a user-origin rule the background
  inserts (the page cannot name it in advance or override it; a mark the
  page removes is put back). What they remove is described for the vault
  first.
- Elements hidden by what they load: a request block mode cancels (or,
  in veil mode, would have: Ad Veil's lists, and an ad network tracking
  protection classifies `tracking_ad` that `aequeraVeil` let through) that
  loads into an image, frame, object, or media element has its element
  hidden, whatever the cosmetic rules say. The background sends the URLs,
  batched per frame (a frame's element is in its parent; a document without
  the content script, such as an ad's script-written `about:blank` frame,
  through the top frame, which looks into same-origin frames), and
  content.js marks the element `o`. In block mode that removes the empty
  box a cancel leaves (a broken image, a blank frame; uBlock Origin calls it
  collapsing); in veil mode the element is taken out of the flow at its own
  size, invisible and unclickable, so veil mode hides everything block mode
  removes, and the ad still draws and is described for the vault like any
  hidden ad. Elements under 32×32 (tracking pixels) are hidden without
  being counted. Measured (2026-10-12, 12 live sites, Strict): before,
  veil mode showed ad media block mode did not (accuweather.com 15
  Connatix images, merriam-webster.com an adsrvr.org video: networks
  tracking protection blocks and no cosmetic rule names); after, neither
  mode showed any, and the veil vault recorded 96 entries with 66 saved
  images (before: 80, 43; accuweather.com 0 → 15).
- Vault coverage: a hidden slot whose ad has not drawn yet is looked at
  again on every page change and at 1, 3, 8, 15, 30, and 60 s (lazy slots
  fill when scrolled to); a cross-origin frame the page finds in a hidden
  slot is told at once that it is an ad (it also asks for 60 s after it
  loads), and a frame veil mode let load from a blocked URL is known as an
  ad before it loads.
- Emptied wrappers: once an ad is hidden, a box around it holding only
  hidden ads, an "Advertisement"-style label (a short list of words, in
  several languages), or nothing rendered would stay as an empty frame
  with a label; it is marked too, up to three levels up, never a page
  landmark (body, main, article, header, footer, nav, form, lists, tables)
  or a box with more than six children, and unmarked if it gains content.
- Every selector is parsed by Gecko into each of the mode's rules and kept
  only if each is a single style rule whose declarations are exactly the
  mode's (compared with the same declarations parsed on a plain selector),
  so list data cannot add declarations (a `url()` that leaks page state) or
  rules.
- Block mode: `display: none !important`. Veil mode keeps the element
  rendered, so its ad loads and is recorded, but `opacity: 0;
  pointer-events: none` and collapsed (`height`, `min-height`,
  `max-height`, `margin`, `padding`, `border-width` 0), so the page closes
  up around it. Its overflow is not clipped: a lazy ad inside still
  intersects the viewport, as lazy-loading scripts check. An empty element
  (`:is(selector):empty`: an anti-adblock bait, or a slot not yet filled)
  keeps 1px of height, so a bait check of `offsetHeight` sees it laid out.
  An element hidden by what it loads (above) is instead `position:
  absolute; opacity: 0; pointer-events: none`: out of the flow, at its own
  size.
- Why collapse (measured, 2026-10-12, 10 live sites, Strict, fresh
  profiles): the kept box left 1.9 to 13.2 million px² of blank space per
  page (foxnews.com 80 boxes); collapsing ad slots with ad content only,
  0.4 to 9.9 million; collapsing every non-empty element, 0.4 to 2.1
  million; collapsing everything, none (page heights as in block mode),
  with as many ads recorded in each variant (58 to 61 found, 49 to 58
  different).
- End to end, same 10 sites (2026-10-12): block mode showed no ad and left
  no empty box (before: weather.com showed 10 ads in sections labeled
  "Advertisement"); veil mode left 0 px² of blank space except one 29,000
  px² box on merriam-webster.com (before: 1.6 to 11.6 million px² per page,
  and merriam-webster.com and cnn.com never finished loading), and the
  vault recorded 62 ads found, 58 different, 41 with saved images (before:
  49, 41, 25).

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
  `news.example.com`); the site is the host without a leading `www.`. A
  single label (`com`, `localhost`) covers only itself, so a top-level
  domain entered as a site never turns blocking off under it. Off
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
  keeps a copy (at most 800 px on its long side, WebP, with the image's own
  size; an image it cannot decode is kept as is if small) keyed by its URL,
  at most 2,000, dropped with the ads. The popup and vault show the saved
  copy and make no request
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
  - a canvas (`pages/canvas.js`, AdNauseam's stage): ads at their own size
    (at most 800 px wide), packed around the middle, each where its middle
    is closest to it, never overlapping (`VeilModel.packAds`); text ads as
    text boxes; the newest 400 matching ads at once (AdNauseam shows 300).
    Drag to pan, the wheel zooms around the pointer (5–400%), zoom buttons
    and Fit; keys pan (arrows), zoom (+, -), and fit (0); Tab moves between
    ads and brings each into view. The view is one CSS transform on the
    canvas (compositor work); fit and going to an ad ease unless reduced
    motion is asked for, and any input supersedes the easing;
  - a click on an ad goes to it (zoom up to 200%), dims the others, and
    docks the inspector beside it: the image, words, where it leads, the ad
    network, its size, the page it was found on and when, and each time it
    was found ("2 / 5", arrows and arrow keys); Escape, the close button,
    or a click on the canvas returns the view to where it was. Removing it
    from the vault (two clicks) drops every sighting and its saved image;
  - a timeline of ads found per day (from the first ad, 14 to 90 days),
    over the canvas: dragging across it, or the From/To date fields,
    filters the canvas to those days, and the days left out are faded;
    tooltip and table view;
  - search, site, and kind (image, text) filters;
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
- A request `aequeraVeil` let through that has no response headers 10
  seconds later is cancelled (`NS_ERROR_NET_TIMEOUT`): tracking protection
  would have blocked it, and an ad server that never answers holds the
  page's load event forever. Measured (2026-10-12): veiled cnn.com stayed
  `interactive` for over 60 s on `ads.stickyadstv.com` scripts that never
  answered (curl: no response in 40 s), and merriam-webster.com and
  cnn.com timed out a 90 s navigation; with the timeout, cnn.com is
  `complete` at about 20 s and both load.
- Modes resolve the same way on both sides (`model.js`, `resolveMode`,
  loaded into the parent API).
- Cost: one check per request in every mode (8.7 µs mean, p99 40 µs in
  SpiderMonkey over 30,368 corpus requests); one engine instance (lists
  compile in about 115 ms at start).
- End to end (2026-10-11, live, fresh profile, defaults, dictionary.com
  veiled): ad slots 1/2 and 2/2 filled over two runs; the vault recorded
  the Google ads with their destinations and saved images.
- Not covered: walls that check something other than ad requests and bait
  sizes (scriptlet-level defusing is not loaded), ads served from hosts
  EasyList does not list whole that Firefox blocks as fingerprinters, and
  ad recovery services that serve ads from rotating domains no list names
  (weather.com: before this slice its block mode showed 10 such ads; now
  their sections are hidden, but the domains still serve, 55 requests on
  one load; EasyPrivacy's answer at the source is a scriptlet,
  `weather.com##+js(acs, document.getElementsByTagName, .pubads)`). Slice 5
  measures what remains.

### Popups and redirects

In block and veil mode alike (never off). Veil mode lets ad scripts load,
popup scripts among them (canyoublockit.com's pop-under test: a WordPress
plugin EasyList names, `/plugins/ultimate-popunder/*$~stylesheet`), but
never their popups.

- **Popup rules.** adblock-rust rejects the `popup` option, so EasyList's
  2,969 `$popup` rules were dropped. The engine rewrites them as `$document`
  rules into a second, small engine (`popup_rules`, `check_popup`): a new
  window's URL, judged with its opener page as the source, so
  `$third-party` and `$domain=` keep their meaning; other type options of a
  `$popup` rule are dropped. All 2,969 parse.
- **The click behind it.** content.js records the last click in each frame
  and what it was on: plain content, a link (its URL), or a control
  (buttons, form fields, ARIA roles, anything with a pointer cursor). An
  element covering half the viewport with nothing to see counts as plain:
  an overlay laid over the page to catch clicks.
- **A new window** (`webNavigation.onCreatedNavigationTarget`) is closed
  (`tabs.remove`) when the popup rules name its URL, or when the click
  behind it, within the last second, was on plain content and it opens
  another site or a blank window, or was on a link and it opens another
  site's page than that link (`VeilModel.popupVerdict`). A control may
  open anything (sign-in and share windows); a link opens itself. Its page
  request waits for the verdict (at most 0.8 s) and is cancelled when it
  is closed; a popup kept that goes on, within 3 s, to a page the popup
  rules name is closed then. Without a recent click, Firefox's own popup
  blocker has decided.
- **Redirects.** In the top frame, a navigation a script starts (not the
  user's own: `NavigateEvent.userInitiated`), to another site, within a
  second of a click on plain content, or on a link it does not follow, is
  cancelled (`preventDefault`); the page stays.
- Closed popups and stopped redirects count as blocked requests on the
  opener's page (badge, popup, vault).
- "Same site" is the last two host labels (three under a two-letter
  country's short second level): an approximation of the public suffix
  list, enough to tell a page's own pages from another site's.
- Measured (2026-10-12, live, fresh profile): canyoublockit.com's pop-under
  test with a real click opened a window to google.com with Ad Veil off;
  in block mode its script was cancelled; in veil mode the window opened
  and was closed, the page alone left.
- Not covered: a popup opened from a control (a fake "Download" button
  that is a `<button>`), and a redirect from a link the page rewrote
  before the click.

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
| 2c Hiding | procedural filters, the frame mark, emptied wrappers, veil collapse, veil stall timeout | done: each procedural operator in a real page; a slot left with only a label folds and the box around it stays; veiled ad rendered at height 0, an empty bait at 1px; a silent ad server is cancelled and the page loads (mutation-checked: without the fold or the timeout the tests fail); live numbers in Hiding and Veil mode |
| 3 Updates | automatic list updates with fallback | update shows in the panel; a corrupt download keeps the previous set |
| 4 First run + Visit | first-run screen, visit queue | every visit logged; limits enforced; private windows never visit |
| 5 Tune | corpus run, ETP ads-list decision | numbers recorded here |
