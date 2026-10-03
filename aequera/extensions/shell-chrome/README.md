# shell-chrome — first-party wireup v0 + unified palette (no Firefox patch)

Proves the prototype tab/workspace/command model against **real Firefox tabs**
through stable WebExtensions APIs only. Firefox source is untouched:
`patches/manifest.yaml` stays v0 empty, `worktree/firefox` stays clean.

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

## Acceptance (this slice)

- `cargo test -p aequera-core` green (20 tests).
- `node --test src/palette.test.js` green (6 tests: order, case-folding, gating, cap).
- `aequera upstream verify` → verified; `aequera patch status` → base match, applied state matches manifest.
- `manifest.json` parses; `strict_min_version` == lock version `156.0`; permissions ⊆ {tabs, sessions, storage, history, bookmarks}; `icons` 16/32/48/128 resolve to `icons/` (real mark).
- `background.js` / `palette.js` contain no `fetch(` / `XMLHttpRequest` / `WebSocket` call sites, no telemetry.
- Temporary load in the pinned build works without errors (manual; full Firefox build is hours — not run in this slice).

## Explicit non-goals (v0 + palette)

Sidebar/panel UI bundling, workspace persistence beyond window values, exact
`Ctrl+K` chord, touch/a11y audit — all later Phase 1 slices.
