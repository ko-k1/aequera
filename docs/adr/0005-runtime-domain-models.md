# ADR 0005: The Shell's Domain Models Are Its Core

## Status

Proposed

## Decision

The domain models the browser runs are the JS models in
`aequera/shell/firefox` (`workspaces/workspace-model.js`,
`workspaces/site-sort-model.js`, `command/command-model.js`,
`tor/tor-model.js`, and the rail's `drag-model.js`, `scroll-model.js`,
`magnify-model.js`). They are the `core` layer of `docs/ARCHITECTURE.md` for
the shipped browser: behavior and state transitions, no presentation, no
Firefox API.

- **What makes a file core.** A `*-model.js` file is pure: no `Services`,
  `gBrowser`, `SessionStore`, `ChromeUtils`, or DOM; inputs in, new values
  out. Its window controller (`aequera-workspaces.js`, `aequera-command.js`,
  ...) turns its plans into Firefox calls. It is unit-tested with `node
  --test`, which PR CI runs on every OS.
- **Where it lives.** Next to its controller, as today. Moving the models
  under `aequera/core/` is a separate refactor (`docs/SOURCE_LAYOUT.md`:
  moving code into a layer is its own task), worth doing only if a second
  consumer (a WebExtension, the in-content pages) needs them.
- **The Rust crate.** `aequera/core` (Rust) is frozen as a reference model:
  it keeps building and passing its tests, drives `aequera demo`, and gains
  no new behavior. It is removed together with its last consumer, or
  revived by a new ADR if Aequera gets a runtime that can host it (for
  example a privileged WebAssembly module, as Ad Veil's engine is).
- **The shell-chrome extension.** `aequera/extensions/shell-chrome` (manual
  proof, not shipped, Manifest V2) maps the prototype onto WebExtension
  APIs. The shipped command surface replaced it; it is retired with the
  Rust crate's `demo`, or earlier if it stops building.

## Context

- `docs/ARCHITECTURE.md` assigns domain state to `aequera/core`; the Rust
  crate was written for it before the shell existed.
- The browser chrome runs JavaScript in the parent process. The shell's
  workspaces, command surface, rail, and Tor windows were built as pure JS
  models plus window controllers, and none of them calls the Rust crate:
  nothing in the Firefox build compiles or loads it.
- As a result four models of tabs, workspaces, and commands exist: the Rust
  crate, the shell's JS models, `shell-chrome/src/palette.js`, and
  `prototype/shell/app.js`. Only the shell's ships.

## Rationale

- **One model per concept.** Parallel models drift: a rule fixed in one
  (for example how a closed tab restores) is not fixed in the others, and
  only the shipped one is exercised by browser tests.
- **No new runtime for the chrome thread.** Hosting Rust in the chrome
  would need an XPCOM component (a Firefox patch and a compiled build) or
  a WebAssembly module loaded into every window; both cost startup and
  memory (`AGENTS.md`: no runtime dependency without considering startup,
  memory, and input latency) for logic that is already pure, tested JS.
- **The layer is about ownership, not language.** `Cargo.toml` already
  says language choice does not change layer ownership; the converse holds
  too.

## Consequences

- `docs/ARCHITECTURE.md` (Core) and `docs/SOURCE_LAYOUT.md` (Current state)
  name the JS models as the runtime core and point here.
- A new domain concept in the shell starts as a pure `*-model.js` with
  node tests, never as Rust in `aequera/core`.
- `aequera demo` stays a reference proof until the Rust crate is retired;
  it says nothing about the shipped browser.
- Purity is a review rule, and a model that reaches a Firefox global fails
  its node tests, which load it without Firefox.

## Rejected Alternatives

- **Make the shell call the Rust crate.** Needs an XPCOM or WebAssembly
  bridge in every window and a patch or compiled build, for no behavior
  the JS models lack.
- **Delete the Rust crate now.** It is small, tested, and the only model
  `aequera demo` and the prototype parity notes describe; deleting it is
  cheap later and loses nothing by waiting for its consumers to go.
- **Port the JS models to Rust/WebAssembly.** Same startup and memory cost
  as the bridge, plus a rewrite of tested code.
