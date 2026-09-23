# Shell Prototype — Minimal UI Interaction Proof

Throwaway-facing, honest-scoped: this directory proves the interaction model
for Aequera's minimal shell **before** any Firefox chrome is touched. It is
not wired to Gecko, carries no network, storage, or telemetry, and its fake
favicons/history exist only to make the shell testable.

## Open

Open `prototype/shell/index.html` directly (double-click / `file://`).
No server, no build, no dependencies, no network requests. Everything,
including favicons, is generated locally. Append `#expanded` to the URL to
open with the sidebar pinned (testing aid).

## What it proves (your spec, item by item)

- **Top address bar, vertical tabs** — a full-width horizontal bar
  (traffic lights, nav, unified input) sits above everything, so a hovering
  tab bar can never overlap it, by construction. Tabs live vertically below
  the bar: minimized to favicons, revealed in place on hover as the bar
  itself widens, icons never moving, titles appearing beside them.
- **Seamless connected surface** — bar, rail, and content share one
  glass-token recipe; the bar's bottom edge and the content's left edge meet
  in a single clean L with no divider cutting the top strip.
- **Address bar with macOS 3-button cluster** — red/yellow/green traffic
  lights in macOS order sit atop the rail (close is decorative here, yellow
  collapses, green pins); nav buttons and the full address+command input run
  horizontally in the top bar.
- **Blur material overall** — one `backdrop-filter` recipe (blur + saturate)
  on both layers; blur radius and backgrounds never animate (those would
  break layer caching).
- **Cache + performance process** — the widening transition is short and
  interruptible, tab rows are `contain: layout paint`, lists never animate,
  and a local FPS meter (bottom-right) makes frame cost visible while you
  interact.
- **Unified address/command surface** — typing filters tabs across all
  workspaces, workspace switches, and commands (new tab/workspace/restore)
  in one list; `Enter` runs, `Esc` backs out.
- **Workspace dots with gliding active indicator** — collapsed shows dots
  in a solid dock (no blur); switching glides the accent dot on transform
  only. Expanded, the dock stretches and dots morph into named session rows
   (dot + name + tab count) with the active row highlighted.
- **Keyboard-first** — `Ctrl/⌘ K` focuses, `↑/↓` + `Enter` selects,
  `1–9` switches tabs, `Esc` collapses. Reduced-motion users get zero
  transitions with all state information intact.

## Tuning (your feedback loop)

Open the sidebar and press **Tune** in the top bar. The panel anchors below
it as a popover on the same glass surface.
Every settable value is editable — that is the explicit first test:

- **Profiles — Minus / Default / Plus.** One basement value set
  (`BASEMENT` in `app.js`, the single source under test); profiles apply
  deltas over it (−8/+12 rail, −6/+8 buttons, −2/+2 spacing, and so on).
  Traffic lights default to macOS 12px but are editable like everything else.
- **Every token exposed** — rail, panel, buttons, tab rows, spacing, radius,
  blur, saturation, font, lights, motion duration, easing (Snappy/Smooth/
  Swift). Edited fields gain an accent border as custom overlays that survive
  profile switches, so a profile can be judged with personal tweaks intact.
- **Motion duration user-testable** — slider from 0–400ms applies live;
  **Replay expand** collapses and re-expands the panel in isolation so each
  duration can be felt, with the FPS meter beside it as witness.
- Values persist in `localStorage` on **this machine only** (nothing leaves
  the page); Reset returns to the basement default profile. When you declare
  the winning basement, it graduates into `aequera/design` tokens — this
  panel is how we find it.

## Model mapping (prototype → product)

| Prototype (`app.js` store) | `aequera-core` | Future shell home |
|---|---|---|
| workspaces/tabs/activeTab/closed | `Browser`, `Workspace`, `Tab`, `ClosedTab` | `aequera/core` (done) |
| open/close/restore/switch/move | `Browser::{open_tab, close_tab, …}` | `aequera/core` (done) |
| address filter list | `CommandRegistry::search`, `commands_for` | `aequera/core` (done) |
| rail + expander + page | — (presentation layer) | `aequera/shell` + `aequera/ui` |
| blur/expand tokens | motion + material semantics | `aequera/design` |

Rendering here is a full re-render per mutation — acceptable at prototype
scale and explicitly **not** the production strategy (the shell will project
and diff). The `aequera demo` CLI command proves the same loop against the
real core model; this page proves humans can operate it.

## Non-goals

Real navigation, real favicons, persistence, theming beyond
light/dark system scheme, touch ergonomics, screen-reader audit (roles and
focus rings are present as a baseline, not a pass).
