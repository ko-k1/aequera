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

## Patch Source

```text
patches/
├── browser/     # browser UI / browser behavior hooks
├── toolkit/     # shared browser UI/toolkit changes
├── gecko/       # engine/platform behavior; exceptional
└── build/       # Firefox build/release integration
```

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
| Branding | branding root (Firefox's layout) | `aequera/design/branding/linux/` | `aequera/design/branding/macos/` |

Each `tools/build/<os>/README.md` is the entry point for that OS and lists
everything else that belongs to it (patches, branding, shell behavior, CI).
Shared build scripts reach OS behavior only through the hooks of
`tools/build/common/host.sh`, which every `tools/build/<os>/platform.sh`
implements; they never branch on the OS themselves.

Two exceptions keep their own layout. Patches stay ordered by Firefox layer
(`patches/<layer>/<series>`); the series name says which OS it is for
(`linux-desktop`, `macos-glass`). Shell runtime code
(`aequera/shell/firefox`) branches on `AppConstants.platform` where Firefox
does, because the overlay is one chrome package for every OS.

## Source-of-Truth Rule

`worktree/firefox/` is generated and disposable. Manual fixes there are lost on the next regeneration and therefore are not valid project work.
