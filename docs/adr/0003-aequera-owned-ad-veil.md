# ADR 0003: Aequera-Owned Ad Veil

## Status

Proposed

## Decision

Aequera ships its own ad handling, **Ad Veil**, instead of bundling a
third-party blocker (uBlock Origin, AdNauseam). Ad Veil follows AdNauseam's
model rather than uBlock Origin's: ads are *hidden*, not blocked, so pages
keep loading the way their authors expect; hidden ads are kept in a local
**vault** the user can browse; *visiting* hidden ads (AdNauseam's simulated
click) is a separate, opt-in action.

It is a first-party built-in WebExtension (`aequera/extensions/ad-veil/`),
packaged through the shell overlay's `jar.mn` under `builtin-addons/`, so it
needs no Firefox patch. Rules come from published filter lists (data, not
code), compiled at build time. Design: `docs/design/ADS.md`.

## Context

- Helium bundles a uBlock Origin fork as a Chromium component extension. The
  goal here is different: less hostile pages (fewer anti-adblock walls,
  intact layout) and a web that keeps working for sites, not maximal
  request blocking.
- Bundling AdNauseam was evaluated and rejected (below). Its approach is the
  reference; its code is not the product.
- Strict Enhanced Tracking Protection stays the network privacy model
  (decided 2026-10-11): Ad Veil adds a presentation layer on top of it, it
  does not replace it. Whether ETP's `ads-track-digest256` list should yield
  to Ad Veil is decided by measurement (`docs/design/ADS.md`, Measurement).

## Rationale

- **Owned behavior.** Every network request and every default is Aequera's
  to justify under `docs/RESTRICTIONS.md`. A bundled third-party extension
  brings its own (AdNauseam 3.29: an `api.github.com` release check on every
  startup, unused on Firefox).
- **No patch.** Firefox 157 installs every add-on listed under
  `browser/chrome/browser/builtin-addons/*/manifest.json`
  (`toolkit/mozapps/extensions/gen_built_in_addons.py` → `built_in_addons.json`
  → the XPIProvider built-in location). The overlay already contributes to
  `browser.jar`.
- **Fit.** Cosmetic hiding, a vault, and opt-in visits map onto ordinary
  WebExtension APIs (`docs/design/EXTENSIONS.md`: first-party extensions for
  privacy/status surfaces).

## Consequences

### Positive

- Ad handling is part of the browser from the first run, with Aequera's
  design system, prefs, and recovery rules.
- No third-party extension code, no third-party update channel.
- Hidden ads still load, so bait-element and request-based anti-adblock
  checks see a normal page more often (hypothesis; measured, not assumed).

### Costs

- Aequera owns a rule compiler, a hiding runtime, list updates, and their
  breakage reports. Filter syntax support is a deliberate subset.
- Built-in add-ons are hidden from about:addons and run in the privileged,
  system location. Ad Veil must therefore expose its own on/off and per-site
  controls, and a test must hold its manifest to least privilege
  (no `mozillaAddons`, no experiment APIs).
- Hiding instead of blocking lets ad scripts run. Trackers inside them are
  left to ETP Strict; Ad Veil is not a tracker blocker.
- Filter lists are third-party data with their own licenses (EasyList:
  GPLv3 / CC BY-SA 3.0, dual); attribution and license files ship with them.
- Visiting ads costs the user's bandwidth and IP exposure and is treated by
  ad networks as invalid traffic, which may count against the site. It is
  therefore opt-in, explained, and never silent.

## Rejected Alternatives

### Bundle AdNauseam (AMO-signed XPI via `distribution/extensions`)

Works without a patch (Mozilla-signed 3.28.8, GPLv3, MV2), but its startup
GitHub request cannot be removed without breaking the signature, its
updates come from AMO on its own schedule, and its defaults and UI are not
Aequera's.

### Build AdNauseam or uBlock Origin from source as a built-in add-on

Removes the request but makes Aequera the maintainer of a large fork of
someone else's product.

### Bundle uBlock Origin (the Helium approach)

Blocks rather than hides: the opposite of the intended experience, with the
same third-party ownership costs.

### Gecko-level engine (e.g. adblock-rust in a Gecko patch)

Fastest matching, but an exceptional Gecko patch with a permanent rebase
cost. Revisit only if the extension runtime misses the performance budget
in `docs/design/ADS.md`.
