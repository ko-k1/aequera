# Roadmap

Roadmap progress is based on **quality gates**, not feature count.

## Phase 0 — Foundation

Goal: make the project reproducible before making it large.

- pin a Firefox revision/channel;
- bootstrap source and build environment;
- establish `upstream/firefox` and lock metadata;
- establish reproducible patch application;
- establish project branding/profile separation;
- establish baseline privacy configuration;
- add CI for basic build/smoke checks;
- establish initial performance instrumentation;
- document source ownership boundaries.

**Exit:** a clean Firefox baseline and a reproducible Aequera-derived build process exist.

## Phase 1 — Shell Prototype

Goal: prove that the browser can diverge meaningfully at the shell layer without becoming a giant fork.

- reshape browser chrome;
- command surface;
- sidebar;
- tab presentation model;
- basic workspaces;
- keyboard-first navigation;
- default layout;
- accessibility baseline.

**Exit:** ordinary browsing can be completed through the new shell model.

## Phase 2 — Unified Browser Workflow

Goal: connect browser concepts into one mental model.

- unified search across tabs/history/bookmarks/commands/workspaces;
- workspace persistence;
- session recovery;
- integrated downloads and permission surfaces;
- contextual actions;
- cross-surface state consistency.

**Exit:** common browsing-management tasks feel like one system rather than several mini-apps.

## Phase 3 — Design System

Goal: establish the visual/interaction foundation before adding arbitrary styling.

- semantic design tokens;
- typography;
- density;
- state primitives;
- material system;
- motion system;
- reduced motion;
- high contrast/accessibility variants;
- ergonomic target/placement rules.

**Exit:** browser-shell UI can be implemented entirely through shared semantics.

## Phase 4 — Customization Platform

Goal: make the browser deeply configurable without source forks.

- native settings;
- profiles;
- typed values;
- CSS/token customization;
- themes;
- validation and migrations;
- import/export;
- recovery/safe mode.

**Exit:** an advanced user can materially change UI and workflow without editing source.

## Phase 5 — Extension Integration

Goal: preserve Firefox ecosystem compatibility while extending browser-shell capabilities.

- broad WebExtension compatibility suite;
- first-party built-in extensions;
- shell API subset;
- capability/permission model;
- extension examples and fixtures.

**Exit:** common Firefox extensions remain viable and Aequera shell APIs have stable boundaries.

## Phase 6 — Performance Hardening

Goal: make responsiveness a measurable invariant.

- startup profiling;
- input-to-feedback measurement;
- frame-time diagnostics;
- tab/workspace transition measurements;
- memory and idle CPU baselines;
- browser-chrome resilience under heavy content;
- performance regression CI where practical.

**Exit:** defined performance budgets are consistently met on representative hardware.

## Phase 7 — Alpha

- freeze core interaction model;
- stabilize configuration schema;
- stabilize extension API subset;
- perform security review;
- conduct representative UX evaluation;
- establish upstream regression corpus;
- document migration/recovery behavior.

## Phase 8 — Beta / Long-Term Maintenance

- broaden platform coverage;
- strengthen migration tooling;
- automate upstream rebases;
- publish developer/user documentation;
- establish release channels;
- establish long-term security/update policy.

## Roadmap Discipline

A phase is complete when its architectural/quality property is stable and testable—not when every listed item merely exists.
