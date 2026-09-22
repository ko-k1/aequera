# Restrictions and Non-Goals

## Privacy

- No telemetry or analytics by default.
- No advertising or sponsored UI.
- No automatic upload of diagnostics.
- No mandatory account for normal browsing.
- No silent remote configuration.
- Network activity must have a user-visible or platform-required reason.

## Security

- Do not weaken origin isolation, site isolation, sandboxing, certificate validation, permission handling, storage isolation, or extension security for convenience.
- Customization must not become an implicit privilege-escalation mechanism.
- Privileged Aequera APIs require explicit capabilities and scoped access.

## UX

- No feature bloat merely to match another product's checklist.
- No permanent UI element without a recurring user task.
- No motion that blocks direct manipulation.
- Avoid multiple competing navigation systems for the same task.
- Do not sacrifice readability for visual novelty.

## Performance

- Avoid synchronous disk/network work on input-critical paths.
- Avoid unnecessary browser-chrome work on hot paths.
- Avoid repeated per-frame style/layout work where compositor-friendly approaches are viable.
- Do not knowingly regress startup or idle performance without a documented trade-off.
- Browser chrome must remain responsive while web content is heavy.

## Architecture

- Keep Firefox-derived source separate from Aequera-owned source.
- Keep project divergence explicit through patches/configuration.
- Public configuration schemas must be versioned.
- Do not make CSS a hidden requirement for supported features.
- Avoid undocumented Firefox internals when a stable abstraction can be built.
- Large architectural changes require an ADR.

## Non-Goals

- replacing Gecko in the initial project;
- becoming an operating system or desktop environment;
- rebuilding the web platform;
- maximizing feature count;
- maximizing benchmark scores while making interactions feel slower;
- cloning Arc, Zen, Helium, or LibreWolf.
