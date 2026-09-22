# Shell Prototype — Minimal UI Interaction Proof

Throwaway-facing, honest-scoped: this directory proves the interaction model
for Aequera's minimal shell **before** any Firefox chrome is touched. It is
not wired to Gecko, carries no network, storage, or telemetry, and its fake
favicons/history exist only to make the shell testable.

## Open

Open `prototype/shell/index.html` directly (double-click / `file://`).
No server, no build, no dependencies, no network requests. Everything,
including favicons, is generated locally.

## What it proves (your spec, item by item)

- **Vertical tabs, minimized by default** — a 56px rail shows favicons only;
  hovering the sidebar (or focusing it by keyboard) reveals the titled panel.
- **Seamless connected surface** — rail and expander share one glass-token
  recipe and overlap as layers, so tab bar and address bar read as a single
  continuous surface instead of two boxes.
- **Address bar with 3-button cluster** — macOS-style traffic lights
  (close / collapse / pin-open) above nav buttons, with the full
  address+command input in the expanded panel.
- **Blur material overall** — one `backdrop-filter` recipe (blur + saturate)
  on both layers; the animated expander never touches blur radius, width, or
  background (those would break layer caching).
- **Cache + performance process** — show/hide runs on opacity + transform
  only (`will-change` scoped to the animated panel), tab rows are
  `contain: layout paint`, lists never animate, and a local FPS meter
  (bottom-right) makes frame cost visible while you interact.
- **Unified address/command surface** — typing filters tabs across all
  workspaces, workspace switches, and commands (new tab/workspace/restore)
  in one list; `Enter` runs, `Esc` backs out.
- **Keyboard-first** — `Ctrl/⌘ K` focuses, `↑/↓` + `Enter` selects,
  `1–9` switches tabs, `Esc` collapses. Reduced-motion users get zero
  transitions with all state information intact.

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
