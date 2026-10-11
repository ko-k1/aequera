# Ad Veil — built-in ad and tracker blocker

Design, decisions, and measurements: `docs/design/ADS.md` and
`docs/adr/0003-aequera-owned-ad-veil.md`. Slices 1 (block and hide) and 2
(vault, address bar popup, per-site switch).

## Classification (AGENTS.md)

- Layer: `aequera/extensions` (first-party built-in add-on) + `aequera/shell`
  (its pref switch).
- Kind: **first-party extension + Aequera source + configuration**. No
  Firefox patch: overlay `ad-veil` is built from the shell overlay's
  `moz.build`, and Firefox's own built-in add-on machinery installs it.
- Public configuration: `aequera.adveil.enabled` (bool, default true). The
  per-site list and the vault switch are the add-on's own settings
  (`storage.local`, validated by `model.js`).
- Dependencies: adblock-rust 0.13.3 (MPL-2.0, pinned exactly), EasyList and
  EasyPrivacy snapshots (data; `addon/lists/README.md`).

## Layout

| Path | Role |
|---|---|
| `engine/` | Rust crate: adblock-rust behind a C ABI (`src/abi.rs`), unit tests |
| `build-engine.sh` | Builds `addon/engine.wasm`; `--check` verifies the committed file |
| `addon/` | The add-on, overlaid to `worktree/firefox/browser/aequera-adveil` |
| `addon/background.js` | Compiles the lists, blocking `webRequest`, cosmetic injection, per-tab counts, per-site switch, messages |
| `addon/model.js` | Pure model: sites, settings validation, vault records (`model.test.mjs`) |
| `addon/vault.js` | The vault store (IndexedDB): hidden ads, daily blocked totals, prune, export, clear |
| `addon/engine.js` | `engine.wasm` wrapper |
| `addon/content.js` | Reports class and id names for generic rules; finds hidden ads for the vault |
| `addon/pages/` | `popup.html` (address bar button), `vault.html`, shared `ui.css` |
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

## Known gaps (later slices)

- Startup cost: instantiate + compile (about 270 ms) runs on every start;
  requests wait for it. A cached serialized engine (load 44 ms in the spike)
  and a smaller module are the first candidates.
- No veil mode (2b), list updates, first-run screen, or Visit yet
  (`docs/design/ADS.md`, Slices).
- Firefox's "Clear history" does not clear the vault (the vault's Clear and
  its 90-day limit do).
- Strings are English literals (as the rest of the shell, for now).
- `about:blank` and `srcdoc` frames get no cosmetic rules.
- Scriptlet (`##+js`) rules do nothing: no resources are loaded.
