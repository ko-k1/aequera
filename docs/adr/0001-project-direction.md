# ADR 0001: Project Direction

## Status

Accepted

## Decision

Build a Firefox/Gecko-based browser whose primary differentiation is browser-shell UX, workflow, responsiveness, ergonomics, design-system quality, privacy, and deep customization.

## Context

Building a new rendering engine would shift the project toward web-platform maintenance rather than the intended browser UX problem. A pure Firefox theme/extension cannot express the desired degree of shell/workflow control. Aequera therefore keeps Firefox/Gecko as the foundation while owning the shell and design layers.

## Consequences

### Positive

- mature Gecko/web-platform base;
- strong Firefox WebExtension compatibility target;
- browser-shell UX can evolve independently;
- customization can be systematic;
- performance work can focus on interaction quality.

### Costs

- upstream synchronization becomes a permanent maintenance responsibility;
- Firefox browser UI internals can be complex;
- customization creates schema/migration burden;
- rich materials and motion can create performance regressions.

## Rejected Directions

- new rendering engine for the initial project;
- pure theme/extension implementation;
- exact clone of Arc/Zen;
- feature-count-driven product design.
