# Security and Privacy

## Security Foundation

Firefox/Gecko security behavior remains foundational. Aequera should preserve browser security boundaries unless a deliberate, reviewed architectural decision changes them.

Protect:

- origin/site isolation;
- sandboxing;
- certificate validation;
- permission prompts;
- storage isolation;
- extension privilege boundaries;
- secure update behavior.

Aequera's content-process defaults change only how many processes one site may
use and how many sit idle: `dom.ipc.processCount.webIsolated` consolidates
tabs of the same site, and `dom.ipc.processPrelaunch.fission.number` reduces
idle preallocation. Different sites still never share a content process;
`fission.webContentIsolationStrategy` remains Firefox's isolate-everything
default. Changing either boundary requires security review.

## Customization Security

Presentation customization is not privileged browser scripting.

The design system may permit broad visual control while privileged operations remain capability-scoped.

## Privacy Defaults

Aequera should provide:

- no telemetry by default;
- no advertising/sponsored surfaces;
- no mandatory cloud account;
- local-first settings and profiles;
- understandable permission/data-use surfaces;
- auditable privacy configuration.

## Threat Areas

Review especially:

- custom CSS/script mechanisms;
- Aequera shell APIs;
- built-in privileged extensions;
- imported configuration;
- theme packages;
- local IPC;
- update mechanisms;
- web content interacting with privileged shell surfaces.

## Review Rule

Any privilege-boundary change requires security review. Substantial boundary changes require an ADR.
