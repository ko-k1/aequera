# Security Policy

Aequera keeps Firefox/Gecko's security architecture as its foundation and
adds browser-shell source, first-party extensions, patches, and
configuration on top of it. This policy explains what is in scope, how to
report a problem privately, and how reports are handled.

## Reporting a vulnerability

- **Do not open a public issue for an unfixed vulnerability.**
- Report privately through GitHub's private vulnerability reporting:
  repository → **Security** tab → **Report a vulnerability**
  (`https://github.com/ko-k1/aequera/security/advisories/new`).
- If you cannot use that channel, open an issue that contains **no technical
  details** and ask for a private contact channel.
- A useful report includes: affected component (path or feature), build or
  commit, reproduction steps or a minimal proof of concept, the impact
  (does it cross a privilege, origin, or network boundary?), and whether web
  content is involved.
- Never test against systems you do not own, and never include live
  secrets or other people's data.

Reports are handled on the active development line; Aequera has no stable
released versions yet. Fixes are recorded with upstream provenance
(`docs/engineering/RELEASE_EVIDENCE_AND_TRUST.md`). Please allow time for a
fix before publishing details. An unfixed report is treated as confidential;
a fixed report may be credited unless you ask otherwise.

## What is in scope

Aequera-owned source and configuration:

- `aequera/` — shell (`aequera/shell/firefox`, including
  `tor/`), core, design, and first-party extensions (shell chrome, Ad Veil
  and its privileged `aequeraVeil` API);
- `patches/` — Aequera's explicit divergence from Firefox;
- `configs/` — defaults, profiles, schemas, and the configuration
  validation/migration/failure model;
- `tools/` — CLI, patch, upstream, build, branding, and tor tooling, plus
  `tests/`.

Review especially the threat areas named in `docs/engineering/SECURITY.md`:

- custom CSS/script mechanisms;
- Aequera shell APIs;
- built-in privileged extensions;
- imported configuration and theme packages;
- local IPC;
- update mechanisms;
- web content interacting with privileged shell surfaces.

Tor windows are also in scope (`aequera/shell/firefox/tor`): the fail-closed
guarantees, leak paths around the proxy, and per-site circuit isolation are
documented with their verification in `docs/design/TOR.md`.

## What to report elsewhere

- **Firefox/Gecko vulnerabilities** — report to Mozilla
  (`https://www.mozilla.org/security/`). Aequera inherits upstream security
  behavior and integrates upstream fixes by rebasing its pinned revision
  (`docs/engineering/UPSTREAM1.md`); tell us too if the issue requires an
  Aequera-specific action.
- **Third-party extensions** — the extension's author / addons.mozilla.org.
- **Dependencies** — adblock-rust, EasyList/EasyPrivacy, and the Tor expert
  bundle to their upstream projects (attribution and pins:
  `docs/adr/0003-aequera-owned-ad-veil.md`, `docs/adr/0004-tor-windows.md`).

## Security model

- Firefox/Gecko security behavior is foundational and is not weakened for
  convenience: origin and site isolation, sandboxing, certificate
  validation, permission prompts, storage isolation, extension privilege
  boundaries, and secure update behavior (`docs/engineering/SECURITY.md`).
- Presentation customization is not privileged browser scripting.
  Privileged Aequera APIs are explicitly declared, capability-scoped,
  origin/extension-scoped where appropriate, auditable, and denied by
  default (`docs/design/EXTENSIONS.md`).
- Privacy defaults are product requirements: no telemetry, no advertising
  or sponsored surfaces, no mandatory account, local-first settings and
  profiles. Network activity must have a user-visible or platform-required
  reason (`docs/RESTRICTIONS.md`).
- Security-sensitive defaults are not weakenable through normal
  customization. Any privilege-boundary change requires security review;
  substantial boundary changes require an ADR (`AGENTS.md`,
  `docs/engineering/SECURITY.md`).

## Scope of security claims

Claims are scoped, not absolute: Tor windows protect what
`docs/design/TOR.md` lists and explicitly not the rest (for example,
membership in Tor Browser's crowd), and Ad Veil's blocking covers what its
filter lists and tracking protection cover (`docs/design/ADS.md`). Known
limitations are documented rather than hidden, and release evidence records
what was verified, measured, or left unknown
(`docs/engineering/RELEASE_EVIDENCE_AND_TRUST.md`).
