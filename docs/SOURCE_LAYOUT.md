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

## Source-of-Truth Rule

`worktree/firefox/` is generated and disposable. Manual fixes there are lost on the next regeneration and therefore are not valid project work.
