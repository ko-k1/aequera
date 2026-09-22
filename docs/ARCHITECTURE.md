# Architecture

## Architectural Goal

Retain Firefox/Gecko as the web-platform foundation while building a project-owned browser shell, design system, workflow model, and customization platform with a controlled upstream boundary.

## Layer Model

```text
┌──────────────────────────────────────────────────────────┐
│ User Customization                                       │
│ Settings / Profiles / Values / CSS / Themes / Add-ons   │
├──────────────────────────────────────────────────────────┤
│ Design System                                            │
│ Tokens / Layout / Typography / Material / Motion / A11y │
├──────────────────────────────────────────────────────────┤
│ Browser Shell                                            │
│ Tabs / Workspaces / Commands / Navigation / Surfaces    │
├──────────────────────────────────────────────────────────┤
│ Browser Services                                         │
│ State / Search / History / Bookmarks / Downloads / ...  │
├──────────────────────────────────────────────────────────┤
│ Firefox Integration                                      │
│ WebExtensions / Firefox APIs / OS / IPC                 │
├──────────────────────────────────────────────────────────┤
│ Firefox / Gecko                                          │
│ Rendering / Networking / Web Platform / Security        │
└──────────────────────────────────────────────────────────┘
```

## Dependency Direction

Higher layers may depend on lower layers through stable interfaces. Lower layers should not depend on product-specific visual concepts.

```text
customization
      ↓
 design system
      ↓
 browser shell
      ↓
 browser services
      ↓
 integrations / platform
      ↓
 Firefox / Gecko
```

## Core

`aequera/core/` owns domain concepts and state transitions:

- navigation;
- tab identity/state;
- workspaces;
- sessions;
- commands;
- search models;
- browser state coordination.

Core should not be a UI toolkit.

## Shell

`aequera/shell/` owns browser chrome and composition:

- window framing;
- navigation areas;
- sidebar;
- tab presentation;
- command surfaces;
- panels/overlays;
- shell-level layout.

## UI

`aequera/ui/` owns reusable components and primitives. Components should consume semantic tokens rather than hard-code product-wide visual decisions.

## Design

`aequera/design/` owns design semantics:

- tokens;
- typography;
- spacing/density;
- motion;
- materials;
- accessibility states;
- ergonomic rules.

## Customization

`aequera/customization/` resolves defaults, profiles, user values, themes, CSS integration, and configuration migrations.

The output is a deterministic resolved configuration graph consumed by the shell and design system.

## Services

`aequera/services/` provides stable domain interfaces such as:

- `TabService`;
- `WorkspaceService`;
- `SessionService`;
- `HistoryService`;
- `BookmarkService`;
- `DownloadService`;
- `PermissionService`;
- `SearchService`;
- `CommandService`;
- `ExtensionService`;
- `CustomizationService`.

UI components should not scatter direct privileged storage access across the tree.

## Integrations

`aequera/integrations/` isolates the boundary to Firefox and the operating system:

- WebExtensions;
- browser/privileged APIs;
- process/IPC integration;
- platform integration;
- desktop integration.

## First-Party Extensions

`aequera/extensions/` holds Aequera-owned capabilities that can be implemented as built-in WebExtensions or equivalent browser-integrated extension packages.

Candidate domains:

- workspace helpers;
- command/search helpers;
- sidebar panels;
- reader/productivity tools;
- privacy surfaces.

The extension mechanism should be preferred when it preserves clean boundaries and acceptable performance.

## Firefox Changes

Firefox source changes live outside Aequera-owned source and are represented by `patches/`.

```text
Aequera source
    │
    ├── mostly independent implementation
    │
    └── explicit hooks into Firefox
                 ↓
            patch series
```

This keeps the product architecture understandable and makes upstream rebases reviewable.

## Configuration Flow

```text
built-in defaults
      ↓
product profile
      ↓
user profile
      ↓
user values
      ↓
theme / CSS layer
      ↓
scoped extension overrides
      ↓
resolved value graph
      ↓
shell + design system + APIs
```

Precedence must be deterministic and documented.

## Process and Responsiveness

Heavy web-content activity must not starve browser-shell interaction. Input-critical tasks should be small, asynchronous, cancellable, and measurable.
