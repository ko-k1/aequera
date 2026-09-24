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
| `aequera-shell.js` | Mirrors the live launcher width into `--aequera-launcher-width` (ResizeObserver, no sync flush) |
| `moz.build`, `jar.mn` | Build registration -> `chrome://browser/content/aequera/` |

Classification (AGENTS.md): configuration + Aequera source, plus one
minimal browser patch (build/load hooks only). No telemetry, no network.

## Known gaps -> Stage 2

Prototype behaviors native Firefox cannot reach through prefs/CSS alone:

- **Collapse linger** (prototype 150ms): Firefox collapses on mouseleave
  immediately.
- **Interruptible motion**: Firefox ignores hover changes while the
  launcher animates (`onMouseEnter`/`onMouseLeave` early-return), which
  conflicts with the AGENTS.md rule that input must supersede animation.
- **Easing**: the launcher animation is fixed `ease-in-out`; the token
  curve is swift `cubic-bezier(0.3,0.7,0.3,1)`.
- Workspaces dock, unified palette UI, bookmark-bar hover peek, pinned
  pills: Aequera chrome modules backed by the `shell-chrome` extension
  adapter (`aequera/extensions/shell-chrome`).

Each Stage 2 behavior change to Firefox's sidebar is a separate, small
`patches/browser` patch with its own rationale and test.
