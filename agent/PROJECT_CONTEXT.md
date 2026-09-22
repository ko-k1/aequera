# Agent Project Context

## One Sentence

Build a Firefox-based browser that is complete by default, exceptionally responsive, ergonomically designed, visually expressive with purpose, privacy-first, deeply customizable, and maintainable against upstream.

## Mental Model

```text
Firefox / Gecko
      ↓
Aequera integration boundary
      ↓
Browser services + core
      ↓
Browser shell + UI
      ↓
Design system
      ↓
Customization + extensions
```

## Key Product References

- learn workflow lessons from Arc/Zen without cloning them;
- learn restraint/lightness from Helium-like products;
- learn privacy discipline from LibreWolf-like approaches;
- retain Firefox's platform and extension ecosystem as a major compatibility target.

## Key Architectural Rule

Do not turn Aequera into a hand-maintained Firefox fork. Keep Aequera source separate, keep patches explicit, pin upstream, and generate the patched build tree.

## Current Stage

Architecture/foundation. Prioritize reproducible source, patch, configuration, build, test, benchmark, and agent workflow before broad feature accumulation.
