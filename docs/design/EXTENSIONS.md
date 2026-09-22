# Extension Integration

Aequera treats Firefox WebExtensions as part of its ecosystem contract.

## Compatibility Principle

Existing Firefox extensions should continue to work wherever the underlying Firefox APIs and Aequera shell architecture permit. Aequera-specific APIs should be additive rather than replacing WebExtensions unnecessarily.

## First-Party Extensions

Aequera-owned functionality that fits the WebExtension model may be implemented as built-in/first-party extensions.

Examples:

- command surface helpers;
- workspace controls;
- sidebar experiences;
- productivity/reader helpers;
- privacy/status surfaces.

## Shell APIs

When standard WebExtensions cannot express necessary browser-shell functionality, Aequera may expose APIs for:

- commands;
- workspaces;
- panels;
- shell theming/design tokens;
- navigation state;
- notifications.

## Capability Model

Privileged APIs must be:

- explicitly declared;
- capability-scoped;
- origin/extension scoped where appropriate;
- auditable;
- denied by default when no capability is present.

## Testing

The compatibility suite should contain both ordinary Firefox extension fixtures and Aequera-specific API fixtures.
