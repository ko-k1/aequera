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
| `aequera-prefs.js` | Default prefs: rail (revamp off, vertical tabs on), motion tokens, hover delays, drawer, workspaces, new tab, private, and in-content pages, promos off, window fullscreen keeps chrome up, frame material (`aequera.material.frame`: Acrylic on Windows, vibrancy or Liquid Glass on macOS, Linux glass on blurring desktops, opaque elsewhere), privacy defaults (telemetry/studies/sponsored/pocket/crash-upload off per `configs/defaults/privacy.toml`), privacy model (Strict tracking protection target, GPC), dark appearance, session restore, Ad Veil on, Tor windows on |
| `aequera-shell.css` | Frame model: the page card clips back (left: widened rail, top: drawer) as plain CSS transitions; unclipped only while fullscreen hides the chrome; imports every feature stylesheet, this OS's last |
| `aequera-shell.js` | Bootstrap, never changed: loads `aequera-main.js` past the startup cache (below) |
| `aequera-main.js` | The window scripts, in load order, each loaded past the startup cache |
| `aequera-frame.js` | `AequeraFrame`: publishes motion tokens and the frame material from prefs, owns the page's top inset |
| `platform/` | What differs per OS, one directory each (`windows/`, `macos/`, `linux/`); a build packages only its own (below) |
| `aequera-hover.js` | `AequeraHover`: hover tracking shared by the rail and the bookmarks drawer (hover delays; an open surface coming to lie under a resting pointer is hovered only once the pointer moves, presses, or scrolls) |
| `fullscreen/` | `AequeraFullscreen`: popups open whole in Wayland fullscreen |
| `rail/` | The tab rail |
| `workspaces/` | Workspaces + dock, sort tabs by site |
| `command/` | Command surface: Aequera rows in the address bar |
| `newtab/` | New tab page (about:newtab, about:home): shortcuts grid |
| `privatebrowsing/` | about:privatebrowsing in the new tab page design (stylesheet) |
| `incontent/` | Firefox's in-content pages (Settings, Add-ons, error pages...) in the Aequera palette (token stylesheet), Aequera illustrations in place of Firefox's mascot art |
| `privacy/` | Privacy model: applies Strict tracking protection once per profile |
| `adveil/` | Ad Veil switch: `aequera.adveil.enabled` enables or disables the built-in ad blocker (`aequera/extensions/ad-veil`) |
| `tor/` | Tor windows: a second instance on a throwaway profile, all traffic through tor (below) |
| `bookmarks/` | Bookmarks drawer |
| `notifications/` | Floating notification bars (stylesheet) |
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

### Per-OS code (`platform/`)

Shared shell code never asks which OS it runs on: no
`AppConstants.platform`, no `(-moz-platform)`. What differs lives in
`platform/<os>/`, three files per OS with the same names and members:

| File | Defines | Read by |
|---|---|---|
| `aequera-platform.js` | `AequeraPlatform` (window script, loaded first): frame material (`systemBackdrop`, `desktopBlurs()`, `publishBackdrop()`, `watchBlur()`), `updatesDragImage`, `workspaceDigitModifier` | `aequera-frame.js`, `rail/aequera-tabs-drag.js`, `workspaces/aequera-workspaces.js` |
| `aequera-platform.css` | Frame material paint (Windows Acrylic pass-through, Linux tint, macOS tint + vibrant layer), per-OS metrics | imported last by `aequera-shell.css` |
| `aequera-tor-platform.sys.mjs` | `AequeraTorPlatform`: `transport` (`tcp` on Windows, `unix` elsewhere), the bundled tor's name and library path variable, whether a process runs a profile | `tor/` |

`jar.mn` packages one OS's files at `chrome://browser/content/aequera/platform/`
(`#ifdef XP_WIN` / `#elifdef XP_MACOSX` / `#else`: Linux and any other
Unix), the way Firefox ships its per-OS themes. A new OS difference is a
member added to all three files, never a branch in shared code.
`platform/platform-contract.test.mjs` (node, every PR CI runner) checks
that the three OSes define the same members, that `jar.mn` maps each OS's
own files, and that no shared code checks the OS;
`platform/tor-platform.test.mjs` runs every OS's Tor checks on stubbed
Gecko globals, so their fail-closed answers (an unreadable lock or command
line counts as a running instance) are tested on every runner;
`tests/browser/browser_aequera_platform.js` checks that a build runs its own
OS's files. Tests state per-OS expectations in per-OS files
(`browser_aequera_material_<os>.js`, `browser_aequera_tor_windows.js`,
`run-if` in `browser.toml`).

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
hover intent (`aequera.hover.openDelayMs` / `closeDelayMs`; a widened rail
the pointer is not on may come to lie under it while it rests, e.g. widened
by the address bar, and the pointer hovers it only once it moves, presses,
or scrolls); holds (keyboard focus in the rail, a context menu opened from it,
address-bar focus; focus holds only while the window is active);
pinned mode (`aequera.rail.pinned`, takes layout space); and
`tabbrowser-tabs[expanded]`. The widened rail overlays the page and the page
card clips back on the same timing. Turning `sidebar.revamp` on hands the
rail back to Firefox's launcher.

Side: Settings > Tabs and browsing > Browser layout > Vertical tabs side (Left /
Right; `patches/browser/rail-position`) writes Firefox's
`sidebar.position_start`. Firefox orders the rail after the page when it is
false; `rail/aequera-rail.js` sets `:root[aequera-rail-end]`, and the
Aequera CSS mirrors the rail's own geometry for that side: it widens from
the window's edge toward the page, the page card clips back (and rounds) on
the side the rail meets, the bookmarks drawer ends where the rail begins,
and tab rows and workspace rows mirror (icon at the outer edge, title
reading toward the page) so icons still never move; the essentials grid
keeps its far edge on the rail's outer edge so the widening reveals it in
place.

The rail is on the frame material with the top bar (Firefox's legacy sidebar
color is removed): like the toolbox, it paints nothing, so collapsed, widened,
and the top bar are one material whatever the frame is (see Frame material).
Its state
is split: the target (`aequera-rail-expanded`) drives width, page clip, and
drawer edge at once; the content (`aequera-rail-content-expanded` +
`tabbrowser-tabs[expanded]`: tab rows, essentials, dock) widens at once but
collapses only after the width transition, so the narrowing rail clips it
away instead of it snapping to icons.

### Tab list (`rail/aequera-tabs{,-drag}.js`, `rail/aequera-tabs.css`)

Unpinned tabs are an Aequera-rendered list (Firefox's own rows switch
layouts with display toggles and cannot animate like the prototype); Firefox's
tab elements stay the source of truth and are hidden. Prototype row language
(`prototype/shell/styles.css` `.tab-row`, same values): 30px rows 6px apart
with 9px corners, transparent at rest with the prototype's hover and selected
washes (`--ae-wash-*` from `aequera/design/tokens.toml`, generated into
`aequera-tokens.css`), 12px titles; collapsed, each row is a 30px square
whose icon sits on the rail's center line and never moves; rows grow with
the rail, titles are revealed by the widening and fade in (clipped away,
then faded out, on collapse). Click selects, middle-click and the dim "x"
(on hover, widened rail only) close, right-click opens Firefox's own tab
context menu for that row (rows carry `.tab`). Hidden tabs (other
workspaces, extensions) are not listed.

Drag and drop (each row below was checked with real pointer drags on a
Wayland compositor, and is covered headless by `browser_aequera_tabs.js`):

| Drag | Result |
|---|---|
| A row within the list | Live slide under the pointer (also while the list autoscrolls at its edges), settle glide on drop (`gBrowser.moveTabTo`); the release point decides the slot, not the last dragover |
| A row out of the list | The rows return to their order and the row dims: nothing will be reordered. Release far from the rail tears it into a new window (`gBrowser.replaceTabsWithWindow`); release by the rail (dock, essentials, just past its edge), Escape, or a drop something else took does not |
| A row onto the essentials grid | Pinned, by Firefox's own drop code |
| An essential onto the rows | Unpinned at the drop position |
| A row onto another window's rail or Firefox tab strip | Adopted there at the drop position (`gBrowser.adoptTab`); never between a private and a normal window, or across process models (Firefox's own rules) |
| A link (page, address bar, bookmark) onto the rows | Opens as a new tab at the gap, with the drop's principal and policy container (`gBrowser.loadTabs`, Firefox's tab-strip link drop) |

Every drag decision is the pure `rail/drag-model.js` (`AequeraDragModel`):
the live slide (where the dragged row is drawn, the target slot, the visible
gap chasing it one slot per frame, the autoscroll zone), the landing slot
and tab index of a drop, the settle glide's start offsets, the foreign gap,
and the tear-off rule. `aequera-tabs-drag.js` holds the drag and drop
methods (loaded right after `aequera-tabs.js`, they join its `AequeraTabs`
list); the two only measure, write transforms, and call gBrowser. The model
is a classic script (loaded before `aequera-tabs.js`) that
also exports itself as CommonJS; node tests:
`node --test aequera/shell/firefox/rail/drag-model.test.mjs`.

How it fits Firefox: the drag source is the row (`addElement`), so
`dragend` comes back to the list; the native tab type comes first and
`tab._dragData` has the shape of a drag from Firefox's all-tabs menu
(`fromTabList`), which is what lets Firefox's strip and other windows take
it. The tab's address rides as `text/x-moz-text-internal`. A drag over the
rail counts as hover (drag and drop sends no mouseover/mouseout): it widens
a collapsed rail, and a dragged row holds it open. Drag image: on Windows and
macOS a hidden image swapped with `updateDragImage` once the pointer leaves
the list; Linux cannot swap mid-drag, so a drag panel (live DOM) carries the
row as a pill and shows it only outside the list. Reduced motion: no slide;
a still accent line marks the landing gap.

 The selected row is kept in view: however a tab gets
 selected (Ctrl+Tab, the command surface, a new tab, a restored session), the
 list scrolls to show it, measured after the next natural layout flush
 (`promiseDocumentFlushed`) so a switch never forces a reflow, and only the
 list scrolls, never the rail. A switch rewrites only the outgoing and
 incoming rows, and a row update writes only what changed, so switching costs
 the same with 5 or 500 tabs. New Tab is the same row with a dim "+" centered in both
 states: a 30px square collapsed, a full-width row widened. Once the rows
 overflow it leaves the scrolling list and stays right under it, above the
 workspace dock, so it is always in reach; the list's top and bottom edges
 fade (an eased mask) while rows are scrolled away past them. The wheel
 scrolls the list with momentum (rail/scroll-model.js): a notch kicks it and
 it coasts 108px to wherever friction stops it, with no row grid; notches
 while it moves add up and accelerate (up to 3x for fast spins); a notch the
 other way turns it at once. Revealing the selected row rides a critically
 damped spring (niri's view movement). Touchpads (pixel deltas) keep
 Firefox's kinetic scrolling; reduced motion or general.smoothScroll=false
 jumps. Closing a tab fades its row where it was while the rows below slide
 up into the slot (at the bottom of a scrolled list the rows above glide down
 instead); only rows on screen animate, and reduced motion drops it at once.
 Magnification (`aequera.rail.magnify`, off by default; Settings > Tabs and
 browsing > Browser layout, `patches/browser/rail-magnify`): the icons near
 the pointer grow on a raised-cosine bell over 2.5 rows
 (`rail/magnify-model.js`), peaking at `aequera.rail.magnifyPercent`
 (150, clamped to 100..175). Unlike the macOS Dock, rows never spread: only
 the icon scales, in place, so no target moves under the pointer; one update
 per frame from layout offsets, a 90ms ease between pointer reports, off
 under reduced motion and while a tab is dragged.
 Pinned tabs stay Firefox's (the essentials grid). Not yet: keyboard focus
 and arrow-key navigation of the rows (tabs switch with Ctrl+Tab / Ctrl+Page Down
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
pref can unlock them, and production launchers must never set the variable.

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

### Fullscreen

Window fullscreen (F11, View > Full Screen) keeps the top bar and the tab
rail on screen: Aequera defaults Firefox's own `browser.fullscreen.autohide`
to `false` (Firefox's macOS default), so no patch. The page stays a card,
clipped by the widened rail as in a window. Page-requested (DOM) fullscreen,
e.g. video, still hides all chrome and shows the page unclipped, and so does
F11 once the user turns "Hide Toolbars" back on in the toolbar context menu.
The bookmarks drawer peeks in F11 exactly as in a window (its peek rule
outranks Firefox's fullscreen toolbar collapse); it is gone with the rest of
the chrome in DOM fullscreen and while "Hide Toolbars" hides the top bar.

Popups on Wayland (`fullscreen/aequera-fullscreen.js`): the compositor places
popups, and some confine them to the output minus bars and docks even while
a fullscreen window covers those (Hyprland: `logicalBoxMinusReserved`). With
the top bar kept up, every panel opened from it starts inside that strip, and
Firefox lets the compositor flip or resize a popup anchored below its button,
not slide it. So the compositor trimmed the overlap: extension popups and
small panels opened short, their bottom cut off, and Firefox kept that size
for the popup. While the window is fullscreen on Wayland, `AequeraFullscreen`
gives chrome popups `flip="slide"` (Firefox then allows the vertical slide),
including popups added later, before they open; `flip="none"` is left alone
and the original value returns on exit. X11, Windows, and macOS place popups
in layout and are untouched. Test: `browser_aequera_fullscreen.js`.

### Frame material

The prototype's one glass layer behind all chrome (`#frame`: blur 24,
saturate 1.5) maps to an OS backdrop, never to an in-page blur.
`aequera.material.frame`, resolved in `aequera-frame.js` to
`:root[aequera-material]` (`glass` or `solid`; an invalid value falls back to
`auto`):

| Value | Windows 11 | macOS | Linux |
|---|---|---|---|
| `auto` (default) | Acrylic | glass | `glass` on a desktop that blurs (below), else `solid` |
| `glass` | Acrylic | vibrancy behind the whole frame | the compositor's blur behind a translucent frame |
| `solid` | no backdrop | opaque, upstream's toolbox vibrancy off too | the opaque frame |

Under glass, `body`, the frame behind every chrome surface, paints the
theme's own toolbox color at `aequera.material.opacity` percent (default 80,
clamped to 60-100 so a bright wallpaper cannot wash out chrome text; Linux and
macOS). The rail and the toolbox paint nothing, so they are the frame. Glass
skips themes with their own colors or images (lwtheme)
and keeps the page card and popups opaque (no stacked blur,
`docs/design/MATERIAL.md`).

- Windows: DWM draws the backdrop. `AequeraPlatform.publishBackdrop`
  (`platform/windows/`) sets Firefox's
  `widget.windows.mica` (off for solid) and
  `widget.windows.mica.toplevel-backdrop` (2, Acrylic) on the default branch,
  so a user value in about:config still wins; upstream's
  `(-moz-windows-mica)` styles make the frame transparent to it. With
  Windows' "Show accent color on title bars" on, upstream paints the accent
  over the whole frame; `platform/windows/aequera-platform.css` keeps the frame transparent with
  the scheme's text color, and the accent stays on the window border.
- macOS: `body::before` carries the titlebar vibrancy
  (`-moz-window-titlebar`, the material upstream puts behind the toolbox) over
  the whole frame, blending behind the window
  (`widget.macos.titlebar-blend-mode.behind-window`), off in native
  fullscreen like upstream's. On macOS 26+ the titlebar region is Liquid Glass
  (`NSGlassEffectView`) when `widget.macos.titlebar-glass.enabled` (read at
  startup, `patches/gecko/macos/macos-glass`).
- Linux: the root paints nothing, so Gecko already gives the window an alpha
  channel; glass needs `-moz-gtk-csd-transparency-available` (a compositing
  desktop). A desktop blurs when it is Hyprland (blurs every translucent
  window, seen as `HYPRLAND_INSTANCE_SIGNATURE`) or offers
  `ext-background-effect-v1` blur (KDE Plasma 6.7+, GNOME): with
  `widget.wayland.background-blur.enabled` Gecko then asks the compositor to
  blur exactly the window's translucent parts (client area minus the opaque
  region and the rounded corners, `patches/gecko/linux/background-blur`) and
  reports it as `(-moz-gtk-background-blur-available)`, which `auto` follows
  live. Elsewhere (sway, X11) an explicit `glass` is translucent but
  unblurred, which is why `auto` does not pick it there.

The macOS and Linux blur requests are Gecko patches: they need a compiled
build (`tools/build/mozconfig.compiled`). An artifact build runs Mozilla's
prebuilt binary, where Linux `auto` is glass on Hyprland only and macOS stays
on plain vibrancy. Test: `browser_aequera_material.js`.

## Workspaces (`workspaces/`)

Tab sets in one window: the dock's dots switch which tabs the rail shows;
the rest are parked with Firefox's native hidden tabs.

| File | Role |
|---|---|
| `workspace-model.js` | Pure model: state validation/recovery, switch plans, digit shortcuts, close plans. A classic script (the bootstrap loads it uncached) that also exports itself as CommonJS; node tests: `node --test aequera/shell/firefox/workspaces/workspace-model.test.mjs` |
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
- Ctrl+1..8 switch to workspace 1..8 and Ctrl+9 to the last one (the tab
  strip's convention). Firefox selects tabs with Alt+digit on Linux and
  Cmd+digit on macOS, so Ctrl+digit is free there; on Windows Firefox's tabs
  own Ctrl+digit, so workspaces use Alt+digit. A missing workspace does
  nothing. Each dock row names its shortcut in its tooltip and
  `aria-keyshortcuts`. Keys live in Aequera's own keyset (`#aequera-keyset`).
- Middle-click on a dock row closes that workspace, as it closes a tab: its
  tabs close into recently closed tabs (Ctrl+Shift+T reopens them; a whole
  tab group is saved, as Firefox does). With more than one tab it asks first
  ("Close “Work” and its 3 tabs?", Firefox's window-modal prompt); unchecking
  "Ask before closing a workspace with several tabs" sets
  `aequera.workspaces.warnOnClose` to false. Closing the active workspace
  switches to the next one (the previous one for the last) before any tab
  closes, so the selection never walks through closing tabs. The window's
  only workspace never closes. A page that asks before being left can keep
  its tab; the workspace then stays with what remains. Closed workspace ids
  are never reused.

### Sort tabs by site

Never automatic: Ctrl+Alt+S (Cmd+Opt+S on macOS), "Sort Tabs by Site" at
the end of the tab context menu, or the command surface's "Sort tabs by site"
sorts the active workspace's visible tabs.

- Order: by site (registrable domain, so `docs.github.com` sorts with
  `github.com`), then by address (scheme and `www.` ignored); web pages
  first, other pages (about:, file:, extension pages) after them. Ties keep
  their order. The sorted tabs start where the first of them was.
- A site with more than `aequera.tabs.sortBySite.over` tabs (default 7; 0
  never moves) moves to a workspace named after it, appended in sorted
  order; an existing workspace of that name (any case) is reused. The
  workspace you sort in stays active: the dock shows where tabs went, and
  the site's workspace opens on its most recently used tab.
- The workspace never empties: a site that would take all its tabs stays
  (sorting inside the `github.com` workspace moves nothing out of it).
- Tabs in a tab group or split view keep their place and never move; tabs
  sharing camera/mic/screen are sorted but stay (they cannot be hidden).
  When the selected tab moves, the most recently used staying tab is
  selected.
- The shortcut is a keyset of its own (as WebExtension shortcuts are). The
  menu item sits in the context menu's open (trailing) section, where
  WebExtension items go: Firefox's menu layout (`TabContextMenu.MENU_SECTIONS`)
  refuses unknown items anywhere else.
- Cost (one user action, not an input path): a tab already right after its
  predecessor is not moved, and the rail renders the result once
  (`AequeraTabs.batch`) instead of after every move. 150 tabs on 30 sites in
  reverse order: 44 ms (80 ms without the batch), logged by
  `test_sort_cost_with_many_tabs`.

| File | Role |
|---|---|
| `site-sort-model.js` | Pure model: order, which sites move where, the selection. Classic script + CommonJS; node tests: `node --test aequera/shell/firefox/workspaces/site-sort-model.test.mjs` |
| `aequera-workspaces.js` | `sortBySite()`: site per tab (`Services.eTLD`; a restoring tab by the page it will load), applies the plan via gBrowser; the shortcut and menu item |

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
holds it open, but never opens it. An open drawer that comes to lie under a
resting pointer (opened by the address bar, a window retile) still closes
when the address bar blurs, unless that pointer has since moved, pressed,
or scrolled. Focus holds only while the window is active. A hold that goes
away without its event still releases: Gecko fires no `popuphidden` for an
open menu removed from the document (a toolbar folder deleted while its menu
is open) and no `focusout` for a removed focused control, so while a menu or
keyboard focus outside the address bar holds the drawer, a MutationObserver
re-decides on removals (nothing is observed otherwise, so typing in the
address bar costs nothing). Firefox's own "Never" / "Only on new tab"
behave natively; customize mode turns it off.

Tests: `tests/browser/browser_aequera_bookmarks_drawer.js`.

## Floating notification bars (`notifications/`)

Firefox stacks its notification bars (a blocked pop-up, a crashed tab, a
protocol handler offer, the window-wide `gNotificationBox` ones) in
`#notifications-toolbar`, the top bar's last row, where each bar grew the top
bar: the page card dropped and reflowed, and the bookmarks drawer hanging from
the top bar moved with it. The row now leaves the flow and floats over the top
of the page as cards on Firefox's popup surface tokens (`--panel-*`, forced
colors included), so the top bar, the page, and the drawer never move. The
cards keep Firefox's markup, buttons, focus order, and slide. The row has the
drawer's geometry: it starts where the rail currently ends and slides below
the open drawer, on the shared motion tokens (instant under reduced motion).
Only the cards take the pointer; their gutters pass it to the page. The cards
sit in the top bar's subtree but are not the top bar: hovering or focusing
one never opens or holds the drawer (`AequeraHover`'s `ignore`), which
would push the card away from a pointer reaching for its buttons. While the
top bar holds a notification it stacks above the browser area (Firefox's
`--browser-area-z-index-toolbox-while-animating`, as for the open drawer); the
widened rail still stacks above it. With the chrome hidden in fullscreen the
cards go with the top bar, as in Firefox. The trade-off of floating: a card
covers the top of the page (at most 48rem wide, centered) until it is
answered or dismissed, where the bar used to push the page down. Stylesheet
and the drawer's hover exception, no Firefox patch.

Tests: `tests/browser/browser_aequera_notifications.js`.

## Command surface (`command/`)

The address bar is the command surface, as in the prototype: one input for
URL/search, tabs, workspaces, history, bookmarks, closed tabs, and commands.
Firefox's urlbar already covers URL/search, open tabs (in every workspace:
picking a hidden tab switches to its workspace), history, and bookmarks.
Aequera adds the rest as one urlbar provider, registered through Firefox's
public `ProvidersManager` API (no Firefox patch):

- other workspaces of this window ("Switch to workspace");
- this window's recently closed tabs ("Reopen closed tab", with the
  workspace they were closed from; restored with history via SessionStore);
- commands: New tab, New workspace, Restore closed tab, Sort tabs by site
  (from 3 typed characters, so a short URL prefix does not push history
  aside).

Rows sit right after the first (heuristic) row, at most 3 per query, so
Firefox's own results keep the rest of the list. Enter still runs the
heuristic row (Firefox behavior); arrow keys or Tab reach the Aequera rows.
An empty input adds nothing: the zero-prefix list (top sites) is Firefox's.
Matching follows Firefox's tab-group rule: one character matches the start of
a word, longer input matches when every word occurs.

| File | Role |
|---|---|
| `command-model.js` | Pure model: matching, section order, cap. Classic script + CommonJS; node tests: `node --test aequera/shell/firefox/command/command-model.test.mjs` |
| `aequera-command.js` | Window side: gathers this window's workspaces and closed tabs, runs picked actions |
| `aequera-urlbar.sys.mjs` | The provider: a thin bridge that asks the querying window (`controller.browserWindow`) for rows and hands picks back to it. One per process (module singleton) |

The provider module is the one ES module in the shell. Modules are kept in
the startup cache (above), so keep it a bridge and put behavior in the window
scripts, which always load fresh. Rows carry plain strings under
`payload.aequera`: the view reserves fields such as `payload.action`, and the
payload crosses the urlbar actor boundary. Strings are English literals, like
the workspace dock. Cost per keystroke: median 0.23 ms, p95 0.41 ms with 25
closed tabs (budget: 16 ms, `docs/engineering/PERFORMANCE.md`).

Tests: `tests/browser/browser_aequera_command.js`.

## New tab page (`newtab/`)

`about:newtab` and `about:home` show a small Aequera page: the Aequera
mark and wordmark over your shortcuts (Firefox's top sites: pinned and
most-visited) as one grid, the two centered as one block a little above the
middle of the page, nothing else. The address bar is focused and is the search, so there is
no second search box and no search-engine tiles. No stories, weather,
sponsored tiles, or wallpapers; nothing is fetched from the network (the
page's CSP allows images from `chrome:` and `data:` only).

`patches/browser/newtab` (one pref-gated line in `AboutNewTabRedirector`)
serves the page when `aequera.newtab.enabled` is on. The address stays
`about:newtab`, so Firefox keeps preloading it, focuses the address bar, and
runs it in the privileged about process. The pref is a boolean, never a URL:
the page holds the about:newtab message port, so it must be this packaged
file. Off restores Firefox's page.

Data and changes go through the port Firefox's own page uses
(`ActivityStream:MainToContent` / `ContentToMain`): the page asks for the
state, reads only `TopSites.rows` and the two prefs that size it
(`topSitesRows`, `feeds.topsites`), and sends `TOP_SITES_PIN`,
`TOP_SITES_UNPIN`, `BLOCK_URL`. Pin, unpin, and dismiss therefore use
Firefox's storage and stay in sync with its settings. Links are plain
anchors: middle-click, the context menu, and drag work natively.

- Brand: `chrome://branding/content/about-logo.svg` (48px) and
  `firefox-wordmark.svg` (104x32, `fill` follows the text color), so a
  rebrand changes them too; one image named by Firefox's
  `newtab-logo-and-wordmark` string. The wordmark SVG stretches its text to a
  fixed width (`textLength`), so the row stays centered whatever the system
  font. Fixed boxes: nothing shifts while they decode.
- Tiles: 56px icon (the site's large icon on its brand color, else its
  favicon, else its first letter), label below; up to 8 per row, rows from
  Firefox's `topSitesRows`. Pinned tiles show a pin beside the icon.
- Options (⋯) per tile: Pin/Unpin and Dismiss. Shown on hover or keyboard
  focus (always, at a touch size, on touch screens); a popover menu with
  arrow keys, Home/End, Escape, and focus back on the button.
- Theme: follows the browser theme's new tab colors (`contentTheme.js`),
  else Firefox's light/dark in-content canvas; forced colors supported.
  Geometry from `aequera/design/tokens.toml` (rad 9, gap 6, fs 14).
- Motion: none on load; hover feedback 120ms, off under reduced motion.
- Strings: Firefox's own `newtab.ftl` ("New Tab", "Top Sites", Pin, Unpin,
  Dismiss, the options label), so the page is localized already. The one
  exception is the empty state ("Sites you visit often will appear here."),
  an English literal: Firefox has no string for it.
- Data: the page renders from the full state or from any full shortcut list
  (`TOP_SITES_UPDATED`), so it never depends on one reply alone.

Defaults that go with it (`aequera-prefs.js`): search-engine shortcut tiles,
stories, and weather off (their feeds would otherwise keep fetching for a
page that does not show them), and the about:home startup cache off (it holds
a render of Firefox's page).

Startup dependency: the new tab backend starts from BrowserGlue's
first-window step, which reads `app.update.checkInstallTime.days` whenever
the old-build update check is on. The Aequera branding prefs turn that check
off and define the day count (`aequera/design/branding/pref`); without them
first-window startup throws and every about:newtab and about:home load hangs
on an empty document. Test profiles turn the check off themselves, so only a
real launch shows this; the new tab test pins the shipped defaults.

Checking a real launch with Marionette: set `remote.prefs.recommended` to
false in the profile. The remote agent's recommended prefs include
`activity-stream.testing.shouldInitializeFeeds = false`, which leaves the
backend without the feed that answers a page's state request.

Measured against Firefox's page on the same build (headless, Linux,
8 pinned shortcuts, medians; the pref switches the page):

| | Firefox page | Aequera page |
|---|---:|---:|
| Script and style loaded | ~1.8 MB JS + 0.7 MB CSS | 22 KB (incl. Firefox's 6 KB theme script) |
| Cold load: DOMContentLoaded | 68 ms | 14 ms |
| Cold load: shortcuts on screen | 101 ms | 30 ms |
| Preloaded: open to shortcuts on screen | 23.2 ms | 19.1 ms |
| Memory per page (window objects) | 7.4 MiB | 1.0 MiB |
| Privileged about process, 5 pages | 133.5 MiB | 35.7 MiB |

Tests: `tests/browser/browser_aequera_newtab.js` (served at both addresses,
preloaded with the address bar focused, shortcuts, empty state,
pin/unpin/dismiss by keyboard, Escape, pref off, startup prefs). The
upstream gate runs Firefox's about:home cache tests with the pref off.

## Private browsing page (`privatebrowsing/`)

about:privatebrowsing stays Firefox's page (its markup, localized strings,
and behavior); `patches/browser/privatebrowsing` adds one stylesheet that
gives it the new tab page's design: the same Aequera brand row (mark and
wordmark from the branding) with the branding's private mark
(`about-logo-private.svg`, the same geometry in violet), then Firefox's heading, explanation, and
"who can see my activity" link, all one block centered like the new tab
page. The brand row is decorative; the heading says the window is private.
Left out: the Firefox artwork, the in-page search box (the address bar is the search), the search-engine
banner, and product promos. The canvas is tinted violet just enough to tell
a private window apart at a glance; light and dark follow the system, forced
colors are supported.

Every rule is inside `@media -moz-pref("aequera.privatebrowsing.enabled")`
(the query Firefox's own stylesheet uses for its Nova layout), so turning
the pref off restores Firefox's design. Mozilla's product promos (VPN,
Relay, pin to taskbar) are advertising (`docs/RESTRICTIONS.md`) and are off
by pref, here and on the other pages that show them.

Tests: `tests/browser/browser_aequera_private.js`. The upstream gate runs
Firefox's about:privatebrowsing tests with the pref off and Firefox's promo
defaults.

## In-content pages (`incontent/`)

Firefox's in-content pages (Settings, Add-ons, the network and certificate
error pages, about:config, about:support, about:protections, dialogs) stay
Firefox's pages and take Aequera's look in two ways, neither touching their
markup or behavior.

**Tokens.** `aequera-in-content.css` redefines Firefox's design tokens from
`aequera/design/tokens.toml`: the `[palette]` (cool neutral canvas and
surfaces instead of Nova's violet-tinted grays, the logo's cyan as the
accent, darkened to `#0369A1` in light for contrast; `aequera design
tokens` refuses any text pair under WCAG AA 4.5:1) and the shell's radius
family (`rad` 9: buttons and fields are rounded rectangles like the address
bar, not pills). Settings and the error card are built from shadow-DOM
components that page CSS cannot reach, but they read these tokens, so the
whole page follows. The look is minimal: cards are the surface step and
one hairline, no shadow. A few page rules complete it:

- the page navigation (Settings, Add-ons) is a vertical bar on its own
  card, floating inside the viewport; the selected category is an accent
  bar on its left edge under the semibold label, with no fill;
- rows inside a group lose their outline and full-width rules: a hairline
  inset from both sides separates each row from the one above (island
  separators);
- search fields (Settings, Add-ons, about:config) are one bottom line, no
  box; a 2px accent line marks focus (the field's own focus ring is
  clipped);
- Settings' own canvas, the default-browser promo (no inner box, art
  centered so a narrow window crops only its halo), the AI intro card,
  quiet table headers (about:support), and the error message on one card.

Button hover and press use the rail rows' wash (`[color]` in
`tokens.toml`).
`patches/toolkit/in-content` adds one line to toolkit's shared in-content
stylesheet, the only Firefox change: it imports a toolkit URL
(`chrome://global/skin/in-content/aequera-in-content.css`) that `jar.mn`
overrides to the shell's sheet, so toolkit names no browser file. The nav
card is `content-box`, so its padding and border go around whatever width
each page gives its nav and no page's sizing is repeated.

Every rule is inside `@media -moz-pref("aequera.incontent.enabled")`, so the
pref off restores Firefox's design, and steps aside under
`prefers-contrast` and forced colors: the tokens are unlayered and would
otherwise beat Firefox's accessible ones. about:privatebrowsing keeps its
own design (`:root:where(:not(.private))`). Nothing animates that Firefox
does not already animate; the sheet is one cached chrome stylesheet.

**Illustrations.** Firefox's mascot art (the fox, "Kit") and its violet
brand shields are replaced through chrome registry overrides in `jar.mn`:
the same URLs serve `incontent/illustrations/*.svg` (the Aequera mark on a
halo with a status badge, 1 to 2 KB each, light and dark through
`prefers-color-scheme`), at each original's intrinsic size, which pages that
do not size the image rely on. Every page, shadow root, and Firefox test
that names those URLs keeps working. Product identity, like the branding,
so not pref-gated.

| Firefox illustration | Shown in | Aequera |
|---|---|---|
| `kit-happy`, `kit-concerned` | Settings, default browser | mark + check / mark + amber "!" |
| `kit-confetti`, `kit-holding-lock` | Settings, app icon | mark + sparks / mark + lock |
| `kit-in-circle` | about:pdf | the mark on its halo |
| `fox-ai` | Settings, AI controls | mark + spark |
| `no-connection`, `security-error` | error pages | dimmed mark + unlinked badge / amber shield |
| `shield-check`, `shield-alert` | Settings, privacy status | accent shield + check / amber shield + "!" |

The same promo rule as the private page: Settings' "More from Mozilla"
pane and about:protections' mobile app and VPN promos are off by pref.

Not covered: about:downloads (a XUL window on `global.css`, outside the
in-content stylesheets) and about:newtab / about:privatebrowsing (their own
Aequera designs above).

Tests: `tests/browser/browser_aequera_incontent.js` (Settings' accent,
canvas, navigation card and selection bar, island separators, and search
line; a certificate error's card and illustration; the
overrides and their sizes; pref off; forced colors; the private page). The
upstream gate runs Firefox's error-page illustration, More from Mozilla,
default browser, and protections VPN tests with the pref off and Firefox's
promo defaults.

## Privacy model (`privacy/`, `aequera-prefs.js`)

LibreWolf's direction (block tracking by default) without the hardening
that costs everyday use. Every piece is a Firefox feature with a Settings
control, so each stays a user choice; nothing changes the web platform.

| | Aequera | Why |
|---|---|---|
| Data collection | off (telemetry, studies, sponsored UI, Pocket, crash upload) | `configs/defaults/privacy.toml`, enforced by `aequera config validate` |
| Tracking protection | Enhanced Tracking Protection **Strict** + Firefox's "convenience" exceptions | blocks cross-site tracking content, fingerprinters, cryptominers, social trackers, tracking query parameters, bounce trackers, and turns on fingerprinting protection in every window; the exceptions keep logins, embeds, and video working |
| Global Privacy Control | on | tells sites not to sell or share the user's data |
| User agent | Firefox's own (`UAName=Firefox`, see `tools/build/common/aequera_app_ini.py`) | "Aequera/157" is an unknown browser to sites (captchas) and a rare fingerprint |
| Language | the app locale's (`en-US, en` on an en-US build) | Settings > Language; Firefox's `privacy.spoof_english` only works with resistFingerprinting |
| resistFingerprinting | off | forces a light color scheme, UTC time, and letterboxed windows; search engines answer it with captchas |
| Clear cookies/history on exit | off | logs the user out and defeats session restore |
| Search suggestions, Safe Browsing | Firefox's defaults | usability; Safe Browsing is a security protection (`docs/RESTRICTIONS.md`) |

Strict cannot be a pref default: Firefox defines its Standard category as
"every tracking-protection pref at its default" and writes the matching
category into the profile at startup, so a default of `strict` is rewritten
to `standard` before any window opens. `privacy/aequera-privacy.js`
therefore switches the category the way Settings does, once per profile on
its first window (`aequera.privacy.trackingProtectionApplied` marks it), and
only over Firefox's automatic Standard (Custom is left alone). After that,
Settings is the control: choosing Standard there sticks.
`aequera.privacy.trackingProtection = ""` leaves new profiles to Firefox.

Appearance and startup defaults that go with it: dark by default
(`ui.systemUsesDarkTheme = 1`: the default theme draws dark chrome and pages
get `prefers-color-scheme: dark`; the Light theme or a Light website
appearance still wins, and resetting the pref follows the OS), and the
previous session's windows and tabs are restored at startup
(`browser.startup.page = 3`).

Tests: `tests/browser/browser_aequera_privacy.js`. The upstream gate runs
Firefox's tests with Standard protection, GPC off, and the light scheme.

## Ad Veil (`adveil/`, `aequera/extensions/ad-veil`)

Aequera's built-in ad and tracker blocker (`docs/design/ADS.md`, ADR 0003):
requests EasyList or EasyPrivacy match are cancelled, and ads that still
reach the page are hidden. It is a built-in add-on (overlay `ad-veil`),
hidden from about:addons, so `aequera.adveil.enabled` (default true) is its
control: `adveil/aequera-adveil.js` keeps the add-on's enabled state equal
to the pref, as Firefox does for its own pref-driven system add-ons. It is
a window script, not a module, for the reason in "Startup cache" (each
window's copy is an idempotent sync). The switch stays in the shell because
a disabled add-on cannot enable itself. Matching runs in the extension
process; nothing here touches the network.

Its address bar button (a page action) shows this page's counts and opens
a popup with the site's mode (Block, Veil: ads load hidden for sites that
refuse ad blockers, as AdNauseam does; Off) and the vault (what was
blocked and hidden, kept locally for 90 days; never from private windows).
`aequera.adveil.veil.adTables` names the tracking-protection tables veil
mode lifts (Firefox's advertising list).

Tests: the add-on's own `addon/tests/browser/browser_aequera_adveil.js`
(`aequera/extensions/ad-veil/README.md`), run by the same `aequera` gate
step. The upstream gate runs Firefox's tests with the pref off.

## Tor windows (`tor/`)

Private windows whose traffic goes through Tor, beside ordinary windows
(Brave's "New Private Window with Tor"; `docs/design/TOR.md`, ADR 0004).
A Tor window belongs to a second Aequera process on a throwaway profile
(`<profile>/tor/profile`), with Firefox's global SOCKS proxy on a tor daemon
that instance runs: no local DNS, no direct fallback, and the network prefs
locked. Linux and macOS (`aequera.tor.enabled`). tor: `aequera.tor.executable`,
else the bundled Tor Browser tor (`<app>/tor`, `tools/tor/fetch-bundle.sh`),
else `PATH`; the browser never downloads it.

| File | Role |
|---|---|
| `tor-model.js` | Pure model: the Tor instance's prefs with reasons (which are required), their check, `user.js` and torrc text, tor log parsing, circuit keys, launch arguments. Classic script + CommonJS, also loaded by the modules; node tests: `node --test aequera/shell/firefox/tor/tor-model.test.mjs` |
| `aequera-tor-launch.sys.mjs` | Ordinary instance: writes the fresh profile and the socket directory, starts the Tor instance offline, or hands the command line to the running one (remoting; the marker's pid is checked, a crashed instance's ignored); removes the socket directory and marker of a child that exited without quitting (SIGTERM, crash); reports failures |
| `aequera-tor-daemon.sys.mjs` | Tor instance: locks and checks the required prefs, then goes online (refused: stays offline for good), the per-site circuit filter (last position, SOCKS credentials per site), tor's process and log, the session's search engine |
| `aequera-tor-common.sys.mjs` | What both modules share: the model, random tokens |
| `aequera-tor.js` | Window script, loaded first: entry points (app and File menus, Ctrl+Shift+Alt+P / Command+Option+Shift+P, link context menu); in the Tor instance, the Tor button and panel, failure notifications, reloading tabs that failed while connecting |
| `aequera-tor.css`, `tor.svg` | The Tor button (state label, violet accent of the private page) and its panel |

Tests: `tests/browser/browser_aequera_tor.js` (launcher with a fake spawn,
the circuit filter on real channels, tor's lifecycle with a fake tor, the
panel); the live check through the Tor network: `tests/security/tor`.

## Robustness

`tests/browser/browser_aequera_chrome_rebuild.js`: vertical tabs off/on,
sidebar panel, revamp on/off, customize mode + removing a button, Restore
Defaults, removing the sidebar button; after each step the page clip,
address bar, tabs, dock, and drawer must be sane.

## Next

- Pinned pills (prototype: drag a tab onto the top bar to pin it).
- Command surface: `Ctrl+K` focus (Firefox uses it for web search; reclaiming
  it is a separate decision), zero-prefix Aequera rows, localized strings.
- Workspaces: rename/delete/reorder, move tab to workspace, dot/row morph
  animation, keyboard switching, localized strings (English literals now).
- Rail: resizable expanded width.
- New tab: add/edit a shortcut and drag to reorder (Firefox's page has both;
  the Aequera page has pin, unpin, and dismiss).
- Full branding build (own exe name/icon): see `patches/build/branding`.
