# shell-chrome — first-party wireup v0 + unified palette (no Firefox patch)

Proves the prototype tab/workspace/command model against **real Firefox tabs**
through stable WebExtensions APIs only. Firefox source is untouched by this
extension: it needs no `patches/browser` hook of its own (see
`patches/manifest.yaml` for the separate shell-chrome overlay and rail hooks);
`worktree/firefox` stays clean of manual edits.

## Classification (AGENTS.md)

- Layer: `aequera/extensions` + `aequera/integrations` boundary.
- Kind: **first-party extension + Aequera source**. Not a Firefox patch,
  not a Gecko patch — `tabs`/`windows`/`sessions`/`storage`/`history`/
  `bookmarks` suffice, so no `patches/browser` hook is justified yet
  (SOURCE_LAYOUT.md: do not use a patch as transport for ordinary Aequera code).
- Public API/config impact: none. No new prefs, no schema change, no
  privileged API. Least privilege: `tabs`, `sessions`, `storage` (v0 adapter)
  plus `history`, `bookmarks` (palette slice — read-only search backing the
  unified address/command surface from the prototype spec; still no remote).

## Model mapping

| Prototype (`app.js` store) / core | Extension adapter (`src/background.js`) | Firefox API |
|---|---|---|
| workspaces | `listWorkspaces` / `createWorkspace` / `switchWorkspace` | `windows.*` + `sessions.{get,set}WindowValue` (`aequera-workspace`) |
| open/switch/close/move/pin tab | `openTab` / `switchTab` / `closeTab` / `moveTab` / `togglePin` | `tabs.*` |
| closed-tab restore | `restoreClosed` | `sessions.getRecentlyClosed` + `sessions.restore` |
| `candidates(q)` unified filter | `rankCandidates` (`src/palette.js`, pure, prototype parity) + `collectSources` / `searchPalette` / `executeAction` | `windows` + `tabs` + `history.search` + `bookmarks.search` + `sessions.getRecentlyClosed` |
| `Ctrl/⌘ K` palette focus | `aequera-focus-command` (`Ctrl+Shift+K`, see note) | `commands.onCommand` + `storage.local` timestamp |

`Ctrl+K` is the prototype key; the extension ships `Ctrl+Shift+K` for v0
because `Ctrl+K` collides with Firefox's built-in search focus. Reclaiming
the exact chord is a later shell-integration decision, not a silent override.

## Load against the real tree

1. Build or run the pinned tree: `aequera patch apply && <firefox build/run from worktree/firefox @ 3bf8f468>`.
2. Open `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`.
3. Exercise: create workspace, open/switch/close/restore/move/pin tabs, fire the command; confirm no errors and `worktree/firefox` shows no source diff.

## Live smoke (proven 2026-09-24, TEMP-only harness, repo untouched)

Heads-up: the repo manifest pins `strict_min_version 156.0` (the lock).
The smoke runs a throwaway copy under `%TEMP%\aequera-smoke` with the min
version lowered, plus a TEMP-only `smoke.html` runner — none of it is committed.

1. `web-ext build` the temp copy → `.xpi`.
2. Launch a real Firefox headless with Marionette on a throwaway profile:
   `firefox --headless --no-remote --marionette -remote-allow-system-access --profile <tmp>`.
3. Via Marionette: temp-install the XPI, read the UUID from
   `extensions.webextensions.uuids` (chrome context), navigate to
   `moz-extension://<uuid>/src/smoke.html`, read `#out`.
4. Result (Nightly 153.0a1, real tabs/windows/sessions/storage/history):
   `listWorkspaces`, open-switch-close round trip, sessions+storage, and
   palette ranking over live sources — all green, 9/9 cap with
   Tab/Workspace/Bookmark ordering intact.

## Acceptance (this slice)

- `cargo test -p aequera-core` green (20 tests).
- `node --test src/palette.test.js` green (6 tests: order, case-folding, gating, cap).
- `aequera upstream verify` → verified; `aequera patch status` → base match, applied state matches manifest.
- `manifest.json` parses; `strict_min_version` == lock version `156.0`; permissions ⊆ {tabs, sessions, storage, history, bookmarks}; `icons` 16/32/48/128 resolve to `icons/` (real mark).
- `background.js` / `palette.js` contain no `fetch(` / `XMLHttpRequest` / `WebSocket` call sites, no telemetry.
- Live Marionette smoke in real Firefox green (4/4 steps; see above).
- Temporary load in the pinned 156.0 build remains the final gate (manual; full Firefox build is hours).

## Explicit non-goals (v0 + palette)

Sidebar/panel UI bundling, workspace persistence beyond window values, exact
`Ctrl+K` chord, touch/a11y audit — all later Phase 1 slices.

## Known residual: manifest_version 2

`manifest.json` stays on `manifest_version: 2` pinned to the `156.0` lock.
A future MV3 migration is tracked work: it must not silently widen
permissions (`history`, `bookmarks` stay read-only palette sources) and must
re-prove the live Marionette smoke before the version pin moves.
