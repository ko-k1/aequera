# Source Layout and Ownership

## Principle

Aequera source and Firefox source are different categories of source.

> **Do not use a patch as a substitute for ordinary Aequera source.**

A patch exists because an upstream Firefox behavior must actually change. It is not a convenient transport mechanism for all Aequera code.

## Aequera Source

### `aequera/core/`

Behavior and domain state.

### `aequera/shell/`

Browser chrome and workflow composition.

### `aequera/ui/`

Reusable UI primitives and components.

### `aequera/design/`

Tokens, motion, material, typography, density, accessibility, ergonomics.

### `aequera/customization/`

Settings, values, profiles, schema validation, migrations, CSS/theme integration.

### `aequera/services/`

Stable interfaces for browser data and services.

### `aequera/integrations/`

Boundaries to Firefox, WebExtensions, OS, and IPC.

### `aequera/extensions/`

Aequera-owned first-party browser extensions.

### Current state

The list above is the ownership target. Not every layer has code yet, and
work that will belong to an empty layer lives in its nearest owner until the
layer is built:

| Layer | Today |
|---|---|
| `core` | Rust domain model (tabs, workspaces, sessions, commands). Driven by `aequera demo`, the prototype, and the shell-chrome extension's mapping. The browser shell does not use it: its models are JS (`aequera/shell/firefox/workspaces/workspace-model.js`, `command/command-model.js`, `rail/*-model.js`), unit-tested with node. |
| `ui` | Empty. Shared styling lives in the shell (`aequera-in-content.css`) and consumes `aequera/design` tokens. |
| `customization` | Empty. Token profiles sit in `aequera/design/tokens.toml` (default profile emitted only); config validation is `aequera config validate` (`tools/cli/src/config.rs`). |
| `services`, `integrations` | Empty. Shell modules call Firefox (`gBrowser`, SessionStore, prefs) directly from `aequera/shell/firefox`. |

`configs/profiles/` and `configs/schemas/` are empty too: the schemas are
Rust types in `tools/cli/src/config.rs`.

Moving code into one of these layers is a refactor with its own task, not a
side effect of feature work.

## Patch Source

```text
patches/
├── browser/     # browser UI / browser behavior hooks
├── toolkit/     # shared browser UI/toolkit changes
├── gecko/       # engine/platform behavior; exceptional
└── build/       # Firefox build/release integration
```

A series only one OS builds sits one level deeper, under that OS
(`patches/<layer>/<windows|linux|macos>/<series>`, `platform:` in the
manifest; docs/engineering/PATCHING.md, Platform series).

## Configuration

`configs/` contains defaults, profiles, and public schemas. Configuration should be preferred over source modification when Firefox already exposes an adequate, supported mechanism.

## Example Classification

### Workspace UI

Normally `aequera/core` + `aequera/shell` + `aequera/ui` + `aequera/design`.

### New browser-shell behavior Firefox cannot expose

Aequera-owned implementation plus a narrow `patches/browser` hook if required.

### Privacy preference

Prefer `configs/` or a narrow patch only when necessary for an auditable default.

### Aequera command feature

Core command model + UI; use an extension if that gives a cleaner capability boundary.

### Gecko rendering change

`patches/gecko/` only after confirming higher layers cannot solve the requirement.

## Platform-Specific Source

Shared code stays shared. Anything true of only one OS lives in a
directory named for that OS (`windows/`, `linux/`, `macos/`) inside the
area that owns it. Each area keeps its layer, and each OS stays easy to
find:

| Area | Windows | Linux | macOS |
|---|---|---|---|
| Toolchain setup | `tools/bootstrap/windows.md` | `tools/bootstrap/linux.md` | `tools/bootstrap/macos.md` |
| Build, launch, test tooling | `tools/build/windows/` | `tools/build/linux/` (NixOS: `nixos/`) | `tools/build/macos/` |
| Tests | `tests/unit/build/windows/`, `tests/security/tor/windows/` | — | — |
| Shell runtime (window scripts, chrome CSS, Tor) | `aequera/shell/firefox/platform/windows/` | `aequera/shell/firefox/platform/linux/` | `aequera/shell/firefox/platform/macos/` |
| Shell tests | `browser_aequera_*_windows.js` | `browser_aequera_*_linux.js` | `browser_aequera_*_macos.js` |
| Firefox patches | `patches/<layer>/windows/` (none yet) | `patches/gecko/linux/`, `patches/toolkit/linux/` | `patches/gecko/macos/` |
| Branding | branding root (Firefox's layout) | `aequera/design/branding/linux/` | `aequera/design/branding/macos/` |

Each `tools/build/<os>/README.md` is the entry point for that OS and lists
everything else that belongs to it (patches, branding, shell behavior, CI).
Shared code never branches on the OS itself; it reaches OS behavior
through one contract per area, which every OS directory implements in full
and a test checks on every CI runner:

- build tooling: the hooks of `tools/build/common/host.sh`, implemented by
  `tools/build/<os>/platform.sh` (`tests/unit/build/test_platform_hooks.py`);
- shell runtime: `AequeraPlatform`, `AequeraTorPlatform`, and the platform
  stylesheet in `aequera/shell/firefox/platform/<os>/`, of which `jar.mn`
  packages only the build's own OS (`platform/platform-contract.test.mjs`);
- Firefox patches: `platform:` on a manifest entry, which the CLI requires
  to match the series directory (`<layer>/<platform>/<name>`). Patches keep
  the Firefox layer as their first level, and every series applies on every
  host: the worktree is one source tree, and only compilation is per-OS.

## Source-of-Truth Rule

`worktree/firefox/` is generated and disposable. Manual fixes there are lost on the next regeneration and therefore are not valid project work.
