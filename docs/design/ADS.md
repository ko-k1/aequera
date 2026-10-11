# Ad Veil

Status: proposed (ADR 0003). Slices 1 (block and hide) and 2 (vault,
per-site switch) are implemented (`aequera/extensions/ad-veil`); veil mode
and slices 3–5 are design.

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
| Veil (per site) | Lets visual ad requests through and hides them instead (AdNauseam's model). | off; offered on sites with a wall |
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
  `<all_urls>`. No `mozillaAddons`, no `experiment_apis`.
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
- `display: none !important` (collapse) by default; veil mode uses
  `opacity: 0 !important; pointer-events: none !important`, which keeps the
  element's box so size-based bait checks pass.

### Address bar button and popup (slice 2)

- A page action (`pageAction-urlbar-adveil_aequera`) on http(s) pages: its
  tooltip carries this page's counts ("Ad Veil: 12 blocked, 3 hidden on this
  page"), its icon (theme colored, `context-fill`) shows when Ad Veil is off
  for the site. Page actions have no badge, so the count is in the tooltip
  and the popup.
- The popup (`pages/popup.html`): the site, an "On for this site" switch,
  this page's Blocked and Hidden counts, and "Open vault". Switching reloads
  the page, since blocking and hiding apply from a page's start.
- A site turned off covers its subdomains (`example.com` covers
  `news.example.com`); the site is the host without a leading `www.`. Off
  means no blocking, no hiding, no recording, and the content script stops.

### Vault (slice 2)

- IndexedDB in the add-on only (`vault.js`; the background page is its only
  writer), never synced or uploaded; export (JSON) and a two-step clear are
  explicit. A database that cannot be opened is recreated empty.
- Hidden ads: one entry each (time, site, page, link, creative URL, up to
  200 characters of text), deduplicated per page, newest 5,000 kept.
  Content scripts find them by querying the applied selectors when the page
  is idle; what they send is validated (http(s) URLs only, bounded sizes).
- Blocked requests: per day, site, and blocked host, a count (a page can
  block dozens; single entries would drown the ads). Summed in memory,
  written every 5 seconds.
- Everything older than 90 days is dropped (hourly prune).
- Private windows are never recorded; their counts exist only in the popup.
- Creative URLs are stored, not images; the vault shows images only on
  "Show images": a request to the ad server without cookies or a referrer,
  shown only if the response is an image. Ad Veil never blocks its own
  pages' requests.
- The page (`pages/vault.html`): last 7 days blocked, most blocked hosts and
  the sites they were on, the hidden ads as cards (text, site, time, link),
  and the "Keep a vault" switch.
- Known gap: Firefox's "Clear history" does not clear the vault (an add-on
  learns of it only with the `history` permission); the vault's own Clear
  and its 90-day limit do.

### Veil mode (slice 2b, not built)

Per-site "let ads load, hide them" needs the network rules split by list
(EasyList's visual-ad rules allowed, the rest still blocked) and the veil
hiding style; it follows once the per-site store above has proven out.

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
| Vault images | "Show images" |
| List updates | panel: "Lists updated N days ago · Update now" |

A browser test fails on any request from the add-on outside this table.

## Configuration

One pref, the global switch, applied by Aequera chrome code:

| Pref | Type | Default |
|---|---|---|
| `aequera.adveil.enabled` | bool | `true` |

Everything else is Ad Veil's own setting, kept in the add-on's
`storage.local` (an add-on cannot read prefs) and changed in its pages:

| Setting | Type | Default | Where |
|---|---|---|---|
| `offSites` | list of sites | `[]` | popup switch |
| `vault` | bool | `true` | vault page, "Keep a vault" |
| visit, list updates | | slices 3–4 | first run, panel |

Settings are validated on every load (`model.js`, `settingsFrom`): unknown
or malformed values fall back to the defaults. Sites turned off from a
private window are kept in memory only, so a private visit never reaches the
profile; turning a site back on there may clear a normal-window choice. A
compiled engine or list update that fails to load falls back to the shipped
snapshots (`AGENTS.md`: configuration failures recover to a known-good
state).

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
| 2b Veil mode | per-site veil (network rules split by list, veil style) | a walled site reads in veil mode; the rest stays blocked |
| 3 Updates | automatic list updates with fallback | update shows in the panel; a corrupt download keeps the previous set |
| 4 First run + Visit | first-run screen, visit queue | every visit logged; limits enforced; private windows never visit |
| 5 Tune | corpus run, ETP ads-list decision | numbers recorded here |
