# aequera/shell — browser chrome on real Firefox

The prototype (`prototype/shell`) interaction model on Firefox's own
engine and tab machinery, with Aequera owning the chrome around it (the
Zen approach: no sidebar revamp launcher). Build, run, and test:
`tools/build/README.md`.

`firefox/` is overlaid into `worktree/firefox/browser/aequera/` (manifest
overlay `shell-chrome`) and loaded by `patches/browser/shell-hooks`.
Classification (AGENTS.md): configuration + Aequera source, plus minimal,
pref-gated browser patches. No telemetry, no network.

| File | Role |
|---|---|
| `aequera-prefs.js` | Default prefs: rail (revamp off, vertical tabs on), motion tokens, hover delays, drawer, workspaces, Mica |
| `aequera-shell.css` | Frame model: the page card clips back (left: widened rail, top: drawer) as plain CSS transitions |
| `aequera-shell.js` | `AequeraFrame`: publishes motion tokens from prefs, owns the page's top inset; loads the feature controllers |
| `rail/` | The tab rail |
| `workspaces/` | Workspaces + dock |
| `bookmarks/` | Bookmarks drawer |
| `moz.build`, `jar.mn` | Build registration -> `chrome://browser/content/aequera/` |

## Tab rail (`rail/`)

Firefox's vertical tab strip (`#vertical-tabs` holding `tabbrowser-tabs`,
with its native drag-and-drop, pinned tabs, and groups) hosted without the
sidebar revamp. `patches/browser/aequera-rail` makes that possible:

| Patch | Change (all gated by `sidebar.verticalTabs.requireRevamp`, default true = Firefox unchanged) |
|---|---|
| 0001 | Vertical tabs and the revamp stop forcing each other on/off (CustomizableUI + SidebarManager), and removing the sidebar button no longer forces horizontal tabs |
| 0002 | `toggleTabstrip` works without the launcher component loaded |
| 0003 | Customize mode's Restore Defaults returns vertical tabs to their default instead of writing `false` |

Aequera shows `#sidebar-container` as the rail and owns what the launcher did:
width (collapsed = Firefox's `--tab-collapsed-width`, expanded =
`aequera.rail.expandedWidth`) as a plain, interruptible CSS transition;
hover intent (`aequera.hover.openDelayMs` / `closeDelayMs`); holds (keyboard
focus in the rail, a context menu opened from it, address-bar focus);
pinned mode (`aequera.rail.pinned`, takes layout space); and
`tabbrowser-tabs[expanded]`. The widened rail overlays the page and the page
card clips back on the same timing. Turning `sidebar.revamp` on hands the
rail back to Firefox's launcher.

Tests: `tests/browser/browser_aequera_rail.js` (hosting, widen without
reflow + hit-testable, linger/re-entry, interrupt without jump, address-bar
and context-menu holds, pinned, revamp hand-back).

### Locked prefs

Structural invariants are declared `locked` in `aequera-prefs.js`, like Zen:
about:config shows them locked, writes are ignored (never an error), and
remote/policy default changes are refused.

| Pref | Locked value | Why |
|---|---|---|
| `sidebar.revamp` | false | Turning it on hands the rail back to Firefox's launcher |
| `sidebar.verticalTabs.requireRevamp` | false | Re-coupling lets Firefox switch vertical tabs off behind the rail |
| `browser.tabs.parkedHiddenSources` | `aequera-workspaces` | Clearing it lets closing a workspace's last tab close the window and discard the others |

`sidebar.verticalTabs` stays a user choice (the rail steps aside for
horizontal tabs). The only unlock is `AEQUERA_UNLOCK_SHELL_PREFS=1` in the
environment, used by `tools/build/test-shell.sh` for Firefox's own tests; no
pref can unlock them.

### Default layout

`patches/browser/customization-defaults` adds
`browser.uiCustomization.defaultExclusions` (empty in Firefox). Aequera sets
`alltabs-button`: no "List all tabs" button in the default layout (new
profiles, Restore Defaults); it stays in the customize palette, and saved
layouts are never changed. Test: `browser_aequera_default_layout.js`.

## Workspaces (`workspaces/`)

Tab sets in one window: the dock's dots switch which tabs the rail shows;
the rest are parked with Firefox's native hidden tabs.

| File | Role |
|---|---|
| `workspace-model.mjs` | Pure model: state validation/recovery, switch plans. Node tests: `node --test aequera/shell/firefox/workspaces/workspace-model.test.mjs` |
| `aequera-workspaces.js` | Window controller: applies plans via gBrowser, persists with SessionStore (window value `aequera-workspaces`, tab value `aequera-workspace`), renders the dock |
| `aequera-workspaces.css` | Dock: dots collapsed, named rows + counts when the rail is expanded |

- Pinned tabs are global (Firefox cannot hide them).
- Only tabs hidden by workspaces are ever shown again; tabs hidden by
  extensions keep their state (extension privilege boundary).
- Tabs sharing camera/mic/screen are never hidden.
- Reaching another workspace's tab switches to that workspace.
- Closing a workspace's last tab replaces it with a new tab in the same
  workspace; the window never closes while other workspaces hold tabs
  (`patches/browser/workspace-hooks/0001`, pref
  `browser.tabs.parkedHiddenSources`).
- Corrupt persisted state recovers to one workspace with every tab reachable.

Tests: `tests/browser/browser_aequera_workspaces.js`.

## Bookmarks drawer (`bookmarks/`)

With `aequera.bookmarks.hoverPeek` on and Firefox's toolbar visibility
"always", the Bookmarks Toolbar stays built but becomes a drawer under the
top bar: opens on top-bar hover (rail timing), immediately and held while the
address bar is focused; keyboard focus holds it, a mouse-clicked button never
does; out of the page flow, the page card clips back from the top. Firefox's
own "Never" / "Only on new tab" behave natively; customize mode turns it off.

Tests: `tests/browser/browser_aequera_bookmarks_drawer.js`.

## Robustness

`tests/browser/browser_aequera_chrome_rebuild.js`: vertical tabs off/on,
sidebar panel, revamp on/off, customize mode + removing a button, Restore
Defaults, removing the sidebar button; after each step the page clip,
address bar, tabs, dock, and drawer must be sane.

## Next

- Unified palette UI, pinned pills.
- Workspaces: rename/delete/reorder, move tab to workspace, dot/row morph
  animation, keyboard switching, localized strings (English literals now).
- Rail: position end (right side), resizable expanded width.
- Full branding build (own exe name/icon): see `patches/build/branding`.
