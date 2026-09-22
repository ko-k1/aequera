# Product Definition

## Product Promise

Aequera is a complete browser by default and a deeply personal browser by choice.

## Primary Concepts

### Workspace

A persistent browsing context that groups related tabs and state. Workspace behavior should reduce the need to mentally manage large flat tab sets.

### Tab

A live navigation context. Tabs must be easy to locate, switch, close, restore, search, and organize.

### Command Surface

A unified entry point for navigation and management:

```text
URL / Search
Tabs
Workspaces
History
Bookmarks
Commands
Settings
Extensions
```

The user should not need to know which subsystem owns an item before being able to find it.

### Sidebar

An optional contextual surface for organization and navigation. It should be positionable, resizable, density-aware, and integrated with workspaces/tabs.

### Browser Surface

A generic shell surface for transient or contextual tasks such as downloads, permissions, find-in-page, extension panels, settings, and notifications.

## Information Hierarchy

The persistent interface should prioritize:

1. page/content;
2. immediate navigation;
3. current workspace/tab context;
4. contextual actions;
5. secondary management;
6. configuration.

As a concept becomes less central to the current task, it should require less persistent UI space.

## AIO Principle

“All-in-one” means integrated workflows, not feature accumulation.

Integrated features should reuse shared navigation, commands, search, settings, state, and design-system primitives rather than become isolated mini-applications.

## Default vs Advanced

Default mode should expose a small number of stable concepts. Advanced mode should expose deeper controls progressively, not force all complexity into the default interface.

## Feature Quality Rule

A feature belongs in the product when it improves a real workflow and can be integrated into the existing mental model. Feature count alone is not a product metric.
