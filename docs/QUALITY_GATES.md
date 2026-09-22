# Quality Gates

## Foundation Gate

- pinned upstream revision is reproducible;
- build environment is documented;
- patch application is deterministic;
- generated worktree is disposable;
- no hidden network behavior was introduced.

## Shell Gate

- navigation is usable without legacy UI assumptions;
- keyboard and pointer paths both work;
- focus state is visible;
- transitions can be interrupted;
- shell remains responsive under representative heavy pages.

## Design Gate

- UI uses semantic tokens;
- reduced-motion behavior is correct;
- accessibility states are preserved;
- visual effects degrade safely;
- no arbitrary one-off styling creates semantic drift.

## Customization Gate

- schemas validate;
- invalid values are rejected safely;
- migrations are explicit;
- previous valid state can be restored;
- import/export is deterministic;
- security boundaries are unchanged.

## Compatibility Gate

- representative Firefox WebExtensions pass;
- extension APIs are capability-scoped;
- platform-specific behavior is documented;
- upstream update does not silently alter browser-shell contracts.

## Release Gate

- clean reproducible build;
- required tests pass;
- no unresolved high-severity security issue;
- startup/interaction budgets are checked;
- Firefox revision + patchset + config manifest are recorded.
