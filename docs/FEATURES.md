# Feature and Capability Map

This file describes the intended capability surface and, importantly, where each class of capability should live.

## Core Browsing

- navigation and URL/search input;
- tabs;
- workspaces;
- sessions and restore;
- history;
- bookmarks;
- downloads;
- find-in-page;
- permissions;
- search providers;
- commands;
- profiles/settings.

## Workflow Features

- unified command/search surface;
- keyboard-first operation;
- workspace-aware tab management;
- contextual browser surfaces;
- persistent state and recovery;
- customizable density/layout;
- configurable navigation placement;
- interruption-friendly interactions.

## Visual System

- semantic design tokens;
- typography;
- density;
- surface/material families;
- motion profiles;
- focus and state styling;
- reduced-motion/accessibility variants.

## Customization

- native settings;
- typed values;
- named profiles;
- themes;
- documented CSS customization;
- Firefox WebExtensions;
- optional Aequera shell APIs.

## Privacy/Security

- privacy-first defaults;
- auditable configuration;
- no unwanted telemetry/advertising behavior;
- explicit privilege boundaries;
- secure handling of imported configuration;
- local-first settings and profiles.

## Responsibility Classification

When implementing a capability, classify it in this order:

| Mechanism | Use when |
|---|---|
| `configs/` | Firefox already supports the behavior through preferences/policies/default configuration |
| `aequera/extensions/` | the behavior can be implemented cleanly as a first-party WebExtension/built-in extension |
| `aequera/` | the behavior is Aequera product logic, shell workflow, UI, state, or customization |
| `patches/browser` | Firefox browser-level hooks/behavior must change |
| `patches/toolkit` | shared UI/platform toolkit behavior must change |
| `patches/gecko` | Gecko engine behavior itself must change; exceptional |
| `patches/build` | build/release integration requires upstream source changes |

The highest-level viable implementation should be preferred.
