# Ad Veil — built-in ad and tracker blocker

Design, decisions, and measurements: `docs/design/ADS.md` and
`docs/adr/0003-aequera-owned-ad-veil.md`. Slices 1 (block and hide), 2
(vault, address bar popup, per-site modes), and 2b (veil mode).

## Classification (AGENTS.md)

- Layer: `aequera/extensions` (first-party built-in add-on) + `aequera/shell`
  (its pref switch).
- Kind: **first-party extension + Aequera source + configuration**. No
  Firefox patch: overlay `ad-veil` is built from the shell overlay's
  `moz.build`, and Firefox's own built-in add-on machinery installs it.
- Public configuration: `aequera.adveil.enabled` (bool, default true),
  `aequera.adveil.veil.adTables` (classifier tables veil mode lifts). The
  per-site modes and the vault switch are the add-on's own settings
  (`storage.local`, validated by `model.js`).
- Privilege: one experiment API, `aequeraVeil` (`addon/experiments/`),
  parent process only: veil mode's channel classifier listener (ADR 0003).
- Dependencies: adblock-rust 0.13.3 (MPL-2.0, pinned exactly), EasyList and
  EasyPrivacy snapshots (data; `addon/lists/README.md`).

## Layout

| Path | Role |
|---|---|
| `engine/` | Rust crate: adblock-rust behind a C ABI (`src/abi.rs`), unit tests |
| `build-engine.sh` | Builds `addon/engine.wasm`; `--check` verifies the committed file |
| `addon/` | The add-on, overlaid to `worktree/firefox/browser/aequera-adveil` |
| `addon/background.js` | Compiles the lists, blocking `webRequest`, cosmetic injection, per-tab counts, per-site modes, messages |
| `addon/model.js` | Pure model: sites and modes, settings validation, ad hosts, vault records (`model.test.mjs`); also loaded by the parent API |
| `addon/experiments/` | `aequeraVeil`: lifts tracking protection's ad blocks on veiled sites (parent process) |
| `addon/vault.js` | The vault store (IndexedDB): hidden ads, daily blocked totals, saved ad images, prune, export, clear |
| `addon/engine.js` | `engine.wasm` wrapper |
| `addon/content.js` | Reports class and id names for generic rules; finds and describes hidden ads (inside ad frames too) for the popup and vault |
| `addon/pages/` | `popup.html` (toolbar button), `dashboard.html` (overview, vault, sites, settings), shared `common.js` and `ui.css` |
| `addon/icons/` | Theme-colored button icons (on, off for this site) |
| `addon/lists/` | Filter list snapshots, versions, license |

## Build and test

```sh
# Engine (any change under engine/): rebuild, commit engine.wasm with it.
cargo test -p aequera-adveil-engine
bash aequera/extensions/ad-veil/build-engine.sh          # NixOS: inside
#   nix shell nixpkgs#rustc nixpkgs#cargo nixpkgs#lld -c bash ...
bash aequera/extensions/ad-veil/build-engine.sh --check  # same toolchain

# Model.
node --test aequera/extensions/ad-veil/addon/model.test.mjs   # or bun test

# Browser: aequera patch apply, ./mach build, then the shell gate.
bash tools/build/test-shell.sh aequera
```

`engine.wasm` is committed so the browser build needs no Rust or wasm
toolchain. `build-engine.sh` is deterministic for a given rustc (checked:
two clean builds with rustc 1.98.1 are byte-identical, sha256
`970937a316dc50849e76deecf855c0327f03b59e1e81e83d8ef616ef2a4e7fef`).

## Acceptance

Slice 1:

- `cargo test -p aequera-adveil-engine`: 10 tests (network decisions,
  exceptions, `$third-party`, Firefox resource types, host-specific and
  generic cosmetics, serialize round trip, corrupt input, C ABI).
- `browser_aequera_adveil.js`: built-in install, least privilege (API
  permissions, internal grants, host access), a request EasyList matches is
  blocked and an element a generic rule matches is hidden, the pref turns
  both off and on, and the add-on opens no network channel of its own.
- Real launch (fresh profile, headless, Marionette): first launch and
  relaunch both block and hide on a fixture page. Generic rules are off on
  `127.0.0.1` and `localhost` by EasyList's own `$generichide` exceptions.
- SpiderMonkey (content process, 30,368 corpus requests): 8.5 µs mean per
  check, p99 40 µs; list compile 115 ms; module instantiate 157 ms.

Slice 2:

- `model.test.mjs`: 6 tests (site naming, subdomain matching, settings
  recovery, the switch, ad record validation, days and retention).
- `browser_aequera_adveil.js`: the vault records the fixture's hidden ad
  (link, site, text, image URL) and its blocked host; a private window
  records nothing (mutation-checked: the test fails with the incognito
  checks removed); the address bar popup names the site, counts the page,
  and its switch turns blocking and hiding off and back on; the add-on opens
  no network channel of its own with the vault open. 10 repeated runs green.
- Real launch: the address bar button shows "Ad Veil: 1 blocked, 1 hidden on
  this page"; popup and vault render (dark, tokens).

Slice 2b:

- `model.test.mjs`: 9 tests (adds modes, private-window choices, settings
  from before veil mode, ad host extraction).
- `browser_aequera_adveil.js`, with Firefox's test trackers on an
  example.net page: in veil mode the EasyList ad and a tracking-protection
  blocked ad network load, an EasyPrivacy tracker and a social tracker stay
  blocked, the ad element keeps its box (invisible, unclickable), tracking
  protection stays on for the site (no site exception), and Block restores
  it all; the least-privilege test pins `aequeraVeil` (parent only); the
  button icon follows the mode. Mutation-checked (without `allow()` the ad
  network check fails). Full shell gate 1199/0.
- SpiderMonkey: block mode unchanged (8.7 µs, p99 40 µs); every request on a
  veiled page 13.7 µs, p99 80 µs; both instances compile in 164 ms.
- Fixed from slice 2: `pageAction.setTitle` is synchronous in Firefox, and
  chaining `.catch` on it threw before the icon was set, so the off icon
  never showed. The tests now check the icon.

Display (toolbar badge, popup, dashboard) and the ad view:

- Toolbar button with this page's blocked count as its badge; popup with
  this page's tiles, blocked hosts, and hidden ads; dashboard with
  overview (7-day chart), vault, sites, and settings.
- Ads are read from inside the frames real ad slots draw into (same-origin
  friendly iframes from the page, cross-origin safeframes from their own
  content script), retried while they load; images the page loaded are
  saved once as thumbnails, so the view needs no request; links go to the
  advertiser (click URL `adurl=`), not through the ad click.
- Veil mode follows AdNauseam (Ad Veil's lists let through on a veiled
  site) and Firefox's ad SmartBlock shims are off while Ad Veil is on:
  with EasyPrivacy blocked or the shims on, no real ad slot filled.
  Measured live (dictionary.com, defaults): slots filled 1/2 and 2/2, the
  vault recorded the Google ads with destinations and saved images.
- Tests: `browser_aequera_adveil.js` 67 checks, adding the badge, popup
  contents, saved images (and none fetched with the setting off), an ad a
  script draws into a `src`-less iframe (with a 1×1 pixel and script text
  it leaves out, and a click URL whose destination it shows), dashboard
  sites, and the ad shims following Ad Veil. Full shell gate 1219/0.

## Known gaps (later slices)

- Startup cost: instantiate + compile (about 270 ms) runs on every start;
  requests wait for it. A cached serialized engine (load 44 ms in the spike)
  and a smaller module are the first candidates.
- Block mode stops ads before they exist, so the vault fills mostly from
  veiled sites; ads drawn on a canvas or as HTML5 without an `<img>` are
  recorded without an image; lazy images never scrolled into view are not
  loaded, so not saved.
- No list updates, first-run screen, or Visit yet (`docs/design/ADS.md`,
  Slices). Veil mode's effect on real walled sites is slice 5's
  measurement.
- `aequeraVeil` depends on Firefox's channel classifier service and its
  feature order; the veil-mode test covers it on every gate run.
- Firefox's "Clear history" does not clear the vault (the vault's Clear and
  its 90-day limit do).
- Strings are English literals (as the rest of the shell, for now).
- `about:blank` and `srcdoc` frames get no cosmetic rules.
- Scriptlet (`##+js`) rules do nothing: no resources are loaded.
