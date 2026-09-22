# Compatibility Policy

## Firefox WebExtensions

Firefox WebExtensions are a primary compatibility target.

Compatibility work should distinguish between:

- standard APIs that work unchanged;
- APIs affected by shell integration;
- APIs requiring Aequera-specific adaptation;
- APIs intentionally unsupported for security or architectural reasons.

## First-Party vs Third-Party

Aequera-owned built-in extensions may use privileged mechanisms unavailable to ordinary third-party add-ons, but they must not be treated as a silent precedent for granting equivalent privileges to all extensions.

## Platform Compatibility

Platform-specific behavior should be isolated behind integration boundaries. Linux/Wayland, Linux/X11, macOS, and Windows differences should not leak into browser-domain logic when they can be abstracted.

## Compatibility Matrix

The project should maintain a machine-readable matrix covering:

- Firefox revision/channel;
- OS/platform;
- browser-shell features;
- extension fixtures;
- known deviations;
- required workarounds.

## Regression Rule

An upstream update must not be considered complete merely because the browser builds. Extension compatibility and browser-shell behavior must be tested as separate acceptance properties.
