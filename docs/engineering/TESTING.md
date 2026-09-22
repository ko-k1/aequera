# Testing Strategy

## Test Layers

```text
unit
  ↓
integration
  ↓
UI / accessibility
  ↓
extension compatibility
  ↓
security
  ↓
performance
  ↓
upstream regression
```

## Unit Tests

Target domain logic, value resolution, migrations, command routing, tab/workspace state, and service interfaces.

## Integration Tests

Verify interactions between shell, services, customization, and Firefox integrations.

## UI Tests

Cover navigation, workspaces, tabs, command surface, panels, overlays, focus, keyboard paths, and state visibility.

## Accessibility Tests

Cover keyboard access, focus visibility, text scaling, contrast-sensitive modes, reduced motion, semantic roles, and target-size behavior where applicable.

## Compatibility Tests

Maintain representative Firefox WebExtension fixtures and Aequera shell-API fixtures.

## Security Tests

Exercise privilege boundaries, configuration import, extension capability checks, and update/install paths.

## Performance Tests

Keep benchmark scenarios focused on real interaction:

- startup;
- command open;
- tab switch;
- workspace switch;
- sidebar open/close;
- heavy-page resilience;
- idle CPU/memory.

## Regression Corpus

Each upstream sync should preserve a repeatable regression corpus so patch rebases do not become “build passes, therefore done.”
