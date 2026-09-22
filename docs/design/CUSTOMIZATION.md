# Customization System

## Layers

```text
Native Settings
      ↓
Profiles
      ↓
Typed Values
      ↓
Themes / CSS
      ↓
WebExtensions
      ↓
Scoped Aequera APIs
```

Each layer should add control without forcing its complexity into lower layers.

## Configuration Resolution

Recommended precedence:

```text
Built-in Defaults
    < Product Profile
    < User Profile
    < User Values
    < Theme/CSS Layer
    < Scoped Extension Overrides
```

The exact rules must be explicit and deterministic.

## Public Value Metadata

Every public value should define:

- stable name;
- type;
- unit, if any;
- semantic meaning;
- default;
- range/enum constraints;
- documentation;
- compatibility status;
- migration behavior;
- performance impact when relevant.

## Example

```toml
ui.sidebar.position = "left"
ui.sidebar.width = 280px
ui.tabs.presentation = "icon-title"
ui.tabs.density = "compact"
workspace.presentation = "expanded"
material.sidebar.type = "frosted"
motion.global.profile = "balanced"
```

## Failure Model

When a value is malformed:

1. reject the invalid value;
2. keep the previous valid value;
3. emit a local actionable diagnostic;
4. allow reset/safe mode recovery.

A configuration problem must not produce a half-applied shell.

## Persistence and Migration

Public configuration is versioned. Schema migrations are explicit, deterministic, and reversible where practical.
