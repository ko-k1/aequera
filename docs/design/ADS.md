# Ad Veil

Status: proposed (ADR 0003). Nothing here is implemented yet.

Ad Veil is how Aequera handles ads: hide them instead of blocking them, keep
what was hidden in a local vault, and let the user choose whether hidden ads
are also visited. The reference is AdNauseam's model; the implementation is
Aequera's own (`docs/adr/0003-aequera-owned-ad-veil.md`).

## Goals

1. Pages read without ads, with their layout and scripts intact.
2. Fewer "disable your ad blocker" walls than a request blocker causes.
3. The user can see what was hidden (vault) and controls every part of it.
4. Sites are not broken for the sake of blocking; ad requests still happen.
5. No Aequera network request without a user-visible reason.

Non-goals: tracker blocking (ETP Strict owns it), malware blocking (Safe
Browsing owns it), full uBlock Origin filter syntax, element picker (later,
if a recurring task shows up), YouTube-style in-player ad defeat.

## Model

| Part | What it does | Default |
|---|---|---|
| Hide | Applies cosmetic rules so ad elements are not shown. Ad requests still load. | on |
| Vault | Records each hidden ad (target link, creative URL, size, page, time) locally. | on |
| Visit | Requests a hidden ad's target link in the background, as AdNauseam's "click". | off until chosen at first run |

All three are user-visible: a per-site count and toggle in the address bar,
and the vault page. Turning Hide off for a site restores it immediately.

## Architecture

```text
build time                                    runtime (built-in add-on)
------------------------------------------    ---------------------------------------------
lists.lock (url, sha256, license)             background
  -> fetch pinned snapshot                      host index lookup (suffix walk)
  -> compile (subset)                           per-frame CSS injection (cssOrigin: user)
       generic.css   (shared sheet)             vault store (IndexedDB, capped)
       specific.json (host -> selectors,        visit queue (opt-in, rate limited)
                      host -> exceptions)     content script (all frames, document_start)
  -> packaged into builtin-addons/ad-veil/      collect hidden-ad metadata -> background
                                              address bar: count + per-site toggle
```

### Packaging (verified against Firefox 157)

- `aequera/extensions/ad-veil/` holds the add-on (manifest, background,
  content script, vault page, compiled rules).
- The shell overlay's `jar.mn` lists it under `browser.jar:
  builtin-addons/ad-veil/…`. `gen_built_in_addons.py` scans
  `browser/chrome/browser/builtin-addons/*/manifest.json` into
  `built_in_addons.json`; the XPIProvider built-in location installs every
  entry at startup. No Firefox patch.
- Built-in add-ons are hidden, system, and privileged. Consequences: Ad Veil
  needs its own controls (it does not appear in about:addons), and a test
  holds `manifest.json` to an allowed permission set: `storage`,
  `unlimitedStorage`, `tabs`, `webNavigation`, `<all_urls>` host access, and
  `management` only if coexistence detection ships. No `mozillaAddons`, no
  `experiment_apis`.
- To verify in slice 1: `built_in_addons.json` is regenerated after the
  overlay's `jar.mn` under `mach build faster` (the manifest is
  `force = True`, but the order relative to the overlay is unproven).

### Rules

- Source: EasyList (and later, optionally, regional lists) as **data**,
  pinned by sha256 in `lists.lock`, with its license and attribution in the
  package. EasyList is dual GPLv3 / CC BY-SA 3.0.
- Supported: `##selector`, `domain##selector`, `~domain`, `#@#` exceptions.
  Skipped and counted in the compile report: procedural (`#?#`), scriptlets
  (`##+js`, `#$#`), HTML filters (`##^`), network rules.
- Generic selectors that are expensive for Gecko's matcher (attribute
  substring, `:has()` over broad scopes) are moved out of the shared sheet;
  only id, class, tag, and simple attribute selectors stay generic.
- The compiler is a deterministic Rust tool (same input → byte-identical
  output) with unit tests; its report lists rule counts per class.

### Hiding modes

| Mode | CSS | Effect |
|---|---|---|
| collapse | `display: none !important` | Clean layout. Size-based bait checks (`offsetHeight == 0`) see the element as blocked. |
| veil | `opacity: 0 !important; pointer-events: none !important` | Keeps the element's box: gaps remain, size-based bait checks pass. Viewability scripts may count the ad as seen. |

Both keep the requests: an iframe or image loads whether or not it is
rendered. Which mode applies to which rule class (likely: veil for generic
selectors, where bait elements live; collapse for site-specific ones) is
decided by the measurement below, not assumed. The veil trade-off is stated
plainly: the site may be paid for an impression nobody saw.

### Vault

- Stored only in the add-on's IndexedDB. Capped (proposed 5,000 entries or
  90 days, oldest first). Never synced, never uploaded. Export (JSON) and
  clear are explicit actions.
- Private windows are never recorded.
- The vault page stores creative **URLs**, not images. Showing thumbnails
  is a network request to the ad server, so the page shows text cards and
  loads images only when the user asks ("Show images", credentials omitted).

### Visit (opt-in)

- Off until the user turns it on (first run or settings), with the
  explanation: it uses your connection, it is treated by ad networks as
  invalid traffic, and it may count against the site rather than for it.
- Mechanism: background `fetch(target, { credentials: "omit",
  referrerPolicy: "no-referrer", redirect: "follow" })`, response discarded,
  status logged on the vault entry.
- Limits: at most once per ad, a configurable probability, a per-hour cap,
  randomized delay, never from private windows, never for sites the user
  has turned Ad Veil off on.

### Network

| Request | Reason the user can see | When |
|---|---|---|
| Ad requests made by the page | the page itself | always (not blocked) |
| Visit | Visit setting + vault log | opt-in only |
| Vault images | "Show images" | on demand |
| List update | Ad Veil panel: "Lists updated N days ago · Update now" | open decision (below) |

Nothing else. A browser test observes every request whose loading principal
is the add-on and fails on any request not in this table.

### Coexistence

If the user installs another content blocker, Ad Veil offers to pause
itself (one prompt, remembered). Running both is allowed and documented as
double work, not prevented.

## Configuration

Prefs (documented in `aequera/shell/README.md` when they land), each with
a known-good default that invalid values fall back to:

| Pref | Type | Default |
|---|---|---|
| `aequera.adveil.enabled` | bool | `true` |
| `aequera.adveil.vault.enabled` | bool | `true` |
| `aequera.adveil.visit.enabled` | bool | `false` |
| `aequera.adveil.visit.probability` | int 0–100 | `100` |
| `aequera.adveil.lists.autoUpdate` | bool | open decision |

Per-site off is stored in the add-on (host list), not in prefs. A corrupt
rule set or store falls back to the build-time snapshot and an empty vault
(`AGENTS.md`: configuration failures recover to a known-good state).

## Performance budget (proposed numbers, confirmed in slice 1)

- Startup: no measurable first-window delay; background work starts after
  the first window is painted.
- Page load: style time delta under 5% on the corpus versus Ad Veil off.
- Chrome: rail, address bar, and command surface input latency unchanged
  under the corpus (`docs/engineering/PERFORMANCE.md`).
- Memory: background under 30 MB with the full EasyList compile loaded.

Missing the budget triggers the Gecko-level alternative in ADR 0003, not a
weaker product.

## Measurement

A real-launch corpus of about 30 live sites (news with anti-adblock walls,
recipes, forums, video, regional), driven by Marionette as in
`tools/build` real-launch checks, run manually (live sites are not CI).
Per site and per configuration (Ad Veil off / collapse / veil / mixed), with
uBlock Origin temp-installed as a dev-only baseline:

- anti-adblock wall shown (yes/no);
- ads hidden, ads leaked (screenshot review), layout gaps;
- page-load time and style time;
- whether ETP's `ads-track-digest256` blocked the ad before Ad Veil saw it.

The last metric is what decides whether ETP's ads list should yield to Ad
Veil (kept Strict until then, decided 2026-10-11).

## Slices

| Slice | Delivers | Acceptance |
|---|---|---|
| 1 Hide | compiler + pinned EasyList + built-in packaging + hiding runtime + `aequera.adveil.enabled` | compiler tests green; fixture page ads hidden, pref off restores them; manifest permission test; zero add-on requests; startup check in a real launch |
| 2 Vault | vault store + page + address bar count and per-site toggle | entries recorded and capped; private windows unrecorded; per-site off restores the page live |
| 3 Lists | user-visible list updates with last-known-good fallback | update shows in the panel; corrupt download keeps the old set |
| 4 Visit | first-run screen + visit queue | off by default until chosen; every visit logged; limits enforced; private windows never visit |
| 5 Tune | corpus run, mode assignment, ETP ads-list decision | numbers recorded in this file |

## Open decisions

1. **Rule source:** EasyList as data (recommended), or an Aequera-written
   list (much smaller coverage).
2. **List updates:** on by default and shown in the panel, or manual only.
   Build-time-only lists go stale within weeks.
3. **Visit at first run:** shown unchecked (recommended, since it works
   against the "sustainable for sites" goal) or pre-checked as AdNauseam does.
4. **Name:** "Ad Veil" is a working name.
