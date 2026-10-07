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
| `aequera-prefs.js` | Default prefs: rail (revamp off, vertical tabs on), motion tokens, hover delays, drawer, workspaces, frame material (Mica on Windows, opaque toolbar fallback elsewhere) |
| `aequera-shell.css` | Frame model: the page card clips back (left: widened rail, top: drawer) as plain CSS transitions |
| `aequera-shell.js` | Bootstrap, never changed: loads `aequera-main.js` past the startup cache (below) |
| `aequera-main.js` | The window scripts, in load order, each loaded past the startup cache |
| `aequera-frame.js` | `AequeraFrame`: publishes motion tokens from prefs, owns the page's top inset |
| `rail/` | The tab rail |
| `workspaces/` | Workspaces + dock |
| `bookmarks/` | Bookmarks drawer |
| `moz.build`, `jar.mn` | Build registration -> `chrome://browser/content/aequera/` |

### Startup cache

Firefox keeps the compiled scripts of `browser.xhtml` in each profile's
startup cache, and a front-end rebuild (`mach build faster`) does not
invalidate it: the `.purgecaches` sentinel lives in the app directory, so
the first profile to start consumes it and every other profile keeps
running the shell code it cached before. So `aequera-shell.js`, the one
script `browser.xhtml` names, never changes: it loads `aequera-main.js` with
`ignoreCache`, which loads every feature script the same way (a few small
scripts compiled per window, no cache reads or writes). The code that runs is
the code that was built, however Firefox is started. New scripts go in
`aequera-main.js` and `jar.mn`, never in the bootstrap.

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
width (collapsed = Firefox's `--tab-collapsed-width`, set to the 42px token
rail: 30px token tabs + 2 x 6px inset; expanded =
`aequera.rail.expandedWidth`) as a plain, interruptible CSS transition;
hover intent (`aequera.hover.openDelayMs` / `closeDelayMs`); holds (keyboard
focus in the rail, a context menu opened from it, address-bar focus);
pinned mode (`aequera.rail.pinned`, takes layout space); and
`tabbrowser-tabs[expanded]`. The widened rail overlays the page and the page
card clips back on the same timing. Turning `sidebar.revamp` on hands the
rail back to Firefox's launcher.

The rail paints nothing of its own (Firefox's legacy sidebar color is
removed), so collapsed, widened, and the top bar are one material. Its state
is split: the target (`aequera-rail-expanded`) drives width, page clip, and
drawer edge at once; the content (`aequera-rail-content-expanded` +
`tabbrowser-tabs[expanded]`: tab rows, essentials, dock) widens at once but
collapses only after the width transition, so the narrowing rail clips it
away instead of it snapping to icons.

### Tab list (`rail/aequera-tabs.{js,css}`)

Unpinned tabs are an Aequera-rendered list (Firefox's own rows switch
layouts with display toggles and cannot animate like the prototype); Firefox's
tab elements stay the source of truth and are hidden. Prototype row language
(`prototype/shell/styles.css` `.tab-row`, same values): 30px rows 6px apart
with 9px corners, transparent at rest with the prototype's hover and selected
washes, 12px titles; collapsed, each row is a 30px square whose icon sits on
the rail's center line and never moves; rows grow with the rail, titles are
revealed by the widening and fade in (clipped away, then faded out, on
 collapse). Click selects, middle-click and the dim "x" (on hover, widened
 rail only) close, right-click opens Firefox's own tab context menu for that
 row (rows carry `.tab`). Dragging reorders with a live slide and a settle
 glide (`gBrowser.moveTabTo`); dropping outside the rail tears the tab into a
 new window (`gBrowser.replaceTabsWithWindow`); tabs dragged from another
 window preview a gap and are adopted at the drop position
 (`gBrowser.adoptTab`, carrying the native tab-drop type so vanilla Firefox
 windows interoperate both ways). Hidden tabs (other workspaces, extensions)
 are not listed. New Tab is the same row with a dim "+" centered in both
 states: a 30px square collapsed, a full-width row widened. Pinned tabs stay
 Firefox's (the essentials grid). Not yet: keyboard focus and arrow-key
 navigation of the rows (tabs switch with Ctrl+Tab / Ctrl+Page Down
 meanwhile), tab groups (grouped tabs list as plain rows), sound indicators,
 multiselect.

### Essentials

`rail/aequera-essentials.css` (Arc favorites / Zen Essentials): pinned tabs
are uniform pill tiles in a grid at the top of the rail, one column while
collapsed. Geometry and colors are Zen's essentials, taken from its source
(`zen-browser/desktop`): 46px tiles, 4px grid gaps plus Firefox's pinned-tab
inline margin per tile, icons
centered on both axes, 5px insets (6px on macOS), `--border-radius-medium`, Zen's rest/hover/selected
paint (skipped in forced-colors, where Firefox's system colors apply). Rows are balanced for 1-9 essentials (3 x 3 is the designed maximum) on
a 6-column grid (a tile spans 6, 3, or 2): 1 | 2 | 3 | 2 2 | 3 2 | 3 3 |
3 2 2 | 3 3 2 | 3 3 3; past 9 tiles continue 3 per row and Firefox's pinned
area scrolls (pinning is never refused). The count is read in CSS from the
tabs actually in the pinned container (`:has()` + `:nth-child(of)`), so it is
right however tabs got there (session restore, pin, drag, close). Spacing is
even on both axes (row gap = visible gap between tiles; equal insets). Pinned tabs are already global
across workspaces. The grid is laid out at the full expanded width as soon
as the rail starts widening and is revealed by the widening, so columns never
reflow mid-animation. Pin/unpin and drag stay
Firefox-native. Test: `tests/browser/browser_aequera_essentials.js`.

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
layouts are only changed once: `layout/aequera-layout.js` runs versioned,
one-time migrations (`aequera.layout.migrationVersion`) that bring profiles
saved before a new default to it, like Firefox's own layout migrations; a
widget the user adds back afterwards stays. Test:
`browser_aequera_default_layout.js`.

## Workspaces (`workspaces/`)

Tab sets in one window: the dock's dots switch which tabs the rail shows;
the rest are parked with Firefox's native hidden tabs.

| File | Role |
|---|---|
| `workspace-model.js` | Pure model: state validation/recovery, switch plans. A classic script (the bootstrap loads it uncached) that also exports itself as CommonJS; node tests: `node --test aequera/shell/firefox/workspaces/workspace-model.test.mjs` |
| `aequera-workspaces.js` | Window controller: applies plans via gBrowser, persists with SessionStore (window value `aequera-workspaces`, tab value `aequera-workspace`), renders the dock |
| `aequera-workspaces.css` | Dock: one layout in both states ("icons never move": each dot stays centered on the collapsed icon column); names and counts are always laid out and fade in/out, revealed by the widening rail and clipped away by the narrowing one |

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
does; out of the page flow, the page card clips back from the top. The
pointer on the drawer holds it like the top bar does, over its whole area
from the first frame (before the wipe has revealed all of it); while open,
the top bar stacks above the browser area, whose positioned `#browser` box
would otherwise take every pointer event over the drawer. A menu or panel
opened from the top bar or drawer (a bookmark's context menu, a folder)
holds it open, but never opens it. Firefox's own "Never" / "Only on new tab"
behave natively; customize mode turns it off.

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
