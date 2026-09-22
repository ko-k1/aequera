# Agent Implementation Rules

## Priority Ladder

Prefer, in order:

1. correctness and security;
2. input responsiveness;
3. clear interaction semantics;
4. maintainability and upstream compatibility;
5. accessibility;
6. visual richness;
7. micro-optimization without evidence.

## Feature Proposal

For a non-trivial feature capture:

- user problem;
- target workflow;
- current pain point;
- default behavior;
- customization surface;
- performance impact;
- accessibility impact;
- security/privacy impact;
- upstream maintenance impact;
- acceptance tests.

## Source Classification

Before editing code:

```text
config → first-party extension → Aequera source → Firefox patch → Gecko patch
```

Choose the highest-level mechanism that satisfies the requirement.

## Verification

A feature is not complete because it builds. Check its behavior, performance, accessibility, compatibility, and recovery characteristics as appropriate.
