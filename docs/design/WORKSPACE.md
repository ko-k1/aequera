# Workspace and Tab Model

## Goal

Reduce the cognitive burden of managing large numbers of browsing contexts without hiding useful information.

## Workspace as Context

A workspace represents a coherent browsing task/context. Tabs are members of that context rather than the sole organizing primitive.

A workspace may contain:

- tabs;
- pinned items;
- metadata;
- session state;
- contextual UI preferences.

## Interaction Goals

- switching workspace should provide immediate visible feedback;
- current workspace should always be identifiable;
- tab discovery should not depend on remembering spatial positions;
- search/command entry should bridge across workspaces;
- restoring a workspace should recover meaningful state;
- users should not be forced into an unlimited horizontal tab strip.

## Information Model

```text
Browser
├── Workspace A
│   ├── tabs
│   └── state
├── Workspace B
│   ├── tabs
│   └── state
└── Workspace C
    ├── tabs
    └── state
```

## Flexibility

The workspace model should support different presentations—compact, expanded, list-like, sidebar-oriented, keyboard-oriented—without changing the underlying domain model.

## Performance

Workspace switches are high-frequency interactions and therefore belong in the performance budget. State updates should avoid unnecessary browser-wide reflow or expensive recreation of unaffected surfaces.
