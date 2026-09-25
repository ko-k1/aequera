# aequera/shell — browser chrome on real Firefox

Staged native wireup: the prototype (`prototype/shell`) interaction model
lands on Firefox's own chrome, diverging only where Firefox cannot express
it. Build and run: `tools/build/README.md`.

## Stage 1 — frame model on native vertical tabs (this slice)

`firefox/` is overlaid into `worktree/firefox/browser/aequera/` (manifest
overlay `shell-chrome`) and loaded by `patches/browser/shell-hooks`.

| File | Role |
|---|---|
| `aequera-prefs.js` | Default prefs: vertical tabs, expand-on-hover rail, 250ms motion, 40ms hover intent, Mica backdrop |
| `aequera-shell.css` | Frame model: widened rail keeps its collapsed paint; page card clips back instead of being covered |
| `aequera-shell.js` | Page clip: rest-state launcher width via ResizeObserver; mirrors Firefox's launcher animation while it runs (Stage 2a) |
| `moz.build`, `jar.mn` | Build registration -> `chrome://browser/content/aequera/` |

Classification (AGENTS.md): configuration + Aequera source, plus one
minimal browser patch (build/load hooks only). No telemetry, no network.

## Stage 2a — motion parity (this slice)

`patches/browser/sidebar-motion` (3 patches; Firefox defaults unchanged, so
upstream tests pass with Firefox's defaults restored):

| Patch | Pref (Aequera value) | Behavior |
|---|---|---|
| 0001 easing | `sidebar.animation.expand-on-hover.easing` (swift) | Launcher animation curve; invalid values fall back to `ease-in-out` |
| 0002 collapse delay | `...collapse-delay-ms` (150) | Linger before collapsing; re-entering cancels |
| 0003 interruptible | none | Hover input during the animation reverses it from its on-screen position |

`aequera-shell.js` mirrors Firefox's launcher animation onto the page clip
(same endpoints, duration, easing, start time). Firefox animates the rail by
`translate` over an already-final width, so a width-only clip would lead the
rail on expand and trail it on collapse.

Tests: `firefox/tests/browser/browser_aequera_sidebar_motion.js` (easing,
invalid-easing fallback, linger + cancel, interrupt without jump, clip
tracks rail mid-flight); gate: `tools/build/test-shell.sh`.

## Stage 2b — workspaces (this slice)

Tab sets in one window (prototype model): the dock's dots switch which tabs
the rail shows; the rest are parked with Firefox's native hidden tabs.

| File | Role |
|---|---|
| `workspaces/workspace-model.mjs` | Pure model: state validation/recovery, switch plans. Node tests: `node --test aequera/shell/firefox/workspaces/workspace-model.test.mjs` |
| `workspaces/aequera-workspaces.js` | Window controller: applies plans via gBrowser, persists with SessionStore (window value `aequera-workspaces`, tab value `aequera-workspace`), renders the dock |
| `workspaces/aequera-workspaces.css` | Dock: dots collapsed, named rows + counts when the rail is expanded |

Rules:

- Pinned tabs are global (Firefox cannot hide them): visible in every
  workspace, like the prototype's pinned pills.
- Only tabs hidden by workspaces are ever shown again; tabs hidden by
  extensions keep their state (extension privilege boundary).
- Tabs sharing camera/mic/screen are never hidden.
- Reaching another workspace's tab (tab search, all-tabs menu) switches to
  that workspace.
- Closing a workspace's last tab replaces it with a new tab in the same
  workspace; the window never closes while other workspaces hold tabs
  (`patches/browser/workspace-hooks/0001`, pref
  `browser.tabs.parkedHiddenSources`).
- Corrupt persisted state recovers to one workspace with every tab reachable.

Tests: `tests/browser/browser_aequera_workspaces.js` (membership, switch +
selection restore, empty workspace, pinned/extension-hidden untouched,
reach-to-switch, dock clicks, persistence, corrupt-state recovery,
last-tab close keeps the window).

## Next -> Stage 2c

- Unified palette UI, bookmark-bar hover peek, pinned pills.
- Workspaces: rename/delete/reorder, move tab to workspace, dot/row morph
  animation from the prototype, keyboard switching, localized strings
  (dock labels are English literals for now).
- Interrupted launcher animations still run their full duration over the
  shorter remaining distance (slower reversals); scale duration by distance.
