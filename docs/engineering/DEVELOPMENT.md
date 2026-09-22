# Development Guide

## Normal Loop

1. reproduce current behavior;
2. read the relevant architecture/design docs;
3. classify the change;
4. make the smallest meaningful implementation;
5. add tests;
6. run performance checks for UI/input changes;
7. build and smoke-test;
8. document architectural or public behavior changes.

## Branches and Commits

Prefer short-lived branches and small commits. Commit messages should make logical architecture changes understandable.

Patch commits should be especially focused because the commit sequence becomes the maintainable patch series.

## UI Change Checks

- keyboard interaction;
- pointer interaction;
- focus visibility;
- reduced motion;
- compact/expanded density;
- representative scaling;
- startup/interaction performance sanity.

## Configuration Change Checks

- schema validation;
- migration;
- invalid-value recovery;
- safe defaults;
- import/export round-trip.

## Upstream Change Checks

- clean baseline build;
- patch application;
- browser-shell smoke tests;
- extension compatibility;
- security-sensitive behavior;
- startup/interaction performance;
- patch conflict assumptions.
