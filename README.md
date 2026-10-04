# Aequera

> A Firefox/Gecko-based browser designed around human-centered UX, responsiveness, simplicity, deep customization, privacy, and a complete default experience.

Aequera is a browser project built on Firefox/Gecko. The project treats the browser shell—the interface, workflow, navigation model, customization system, motion, materials, and interaction architecture—as a first-class product rather than as a thin layer around the web platform.

Aequera is intended to combine the strengths of several categories of browser without becoming a copy of any of them:

- **Firefox/Gecko** as the mature web-platform and extension foundation.
- **Arc/Zen-like ideas** as inspiration for rethink­ing browser workflow, workspaces, navigation, and browser-shell UX.
- **Helium-like lightness** as inspiration for a restrained, low-overhead browser shell and a strong focus on responsiveness.
- **LibreWolf-like privacy discipline** as inspiration for privacy-first defaults, auditable configuration, and removal of unwanted telemetry/advertising behavior.

These are reference points, not implementation templates. Aequera should develop its own interaction model from human factors, measurable UX goals, and a coherent architecture.

## Core Idea

Aequera aims to make a broad capability surface feel simple:

```text
Large capability surface
          ↓
coherent information architecture
          ↓
small number of mental concepts
          ↓
fast feedback + predictable state
          ↓
personal browser
```

The project explicitly seeks a balance between:

- simplicity and capability;
- performance and visual richness;
- automation and user control;
- consistency and personalization;
- exploration and focus;
- a strong default experience and deep customization.

## What “Complete by Default” Means

Aequera should feel finished from its first launch. A new user should not need to install a large extension stack or learn a complicated configuration system before the browser becomes useful.

At the same time, advanced users should be able to substantially reshape presentation and workflow without maintaining a private source fork.

“All-in-one” therefore means **integrated**, not “contains every possible feature.” Tabs, workspaces, search, history, bookmarks, downloads, permissions, sessions, commands, settings, and extensions should behave as parts of a shared browser model.

## UX Principles

Aequera is human-centered rather than feature-centered.

The central interaction loop is:

```text
intent → immediate feedback → predictable state → minimal correction
```

The browser should reduce:

- visual search time;
- pointer travel and repeated motor effort;
- unnecessary clicks;
- mode confusion;
- duplicate navigation concepts;
- waiting for browser-shell feedback;
- repeated configuration work.

Responsiveness is considered a UX property. Performance work is therefore evaluated in terms of input latency, visual feedback, frame consistency, startup, memory behavior, idle CPU, and resilience of browser chrome under heavy web-content workloads—not only page benchmarks.

## Visual and Interaction System

Aequera deliberately allows rich UI when it carries semantic value. Blur, translucency, gradients, depth, elevation, typography, motion, and density are tools for hierarchy, state, context, and continuity—not decoration for its own sake.

The design system includes:

- semantic design tokens;
- typography and density;
- surfaces and materials;
- motion roles and easing;
- focus/hover/active/disabled states;
- accessibility and reduced motion;
- ergonomic target and reachability rules.

Animation is treated as an interaction system. Transitions should be short, interruptible, compositor-friendly where possible, and immediately superseded by newer user intent.

## Deep Customization

Customization is layered so ordinary users can stay simple while advanced users gain precision:

```text
Native Settings
      ↓
Profiles / Values
      ↓
Themes / CSS
      ↓
Firefox WebExtensions
      ↓
Aequera browser-shell APIs
```

The configuration model should use typed, documented, versioned values with deterministic precedence, validation, migration, and recovery. Customization must not become a hidden security boundary escape.

Conceptually:

```toml
ui.sidebar.position = "left"
ui.sidebar.width = 280px
ui.tabs.presentation = "icon-title"
ui.tabs.density = "compact"
workspace.presentation = "expanded"
material.sidebar.type = "frosted"
motion.global.profile = "balanced"
```

Exact syntax is an implementation decision; predictable semantics are not.

## Firefox Compatibility

Firefox WebExtensions remain a major compatibility target. Existing Firefox add-ons should work wherever Aequera's shell architecture allows it, and project-specific APIs should be additive and capability-scoped rather than needlessly proprietary.

Features that can be implemented as first-party built-in WebExtensions should generally be considered before introducing deeper privileged source changes, provided this does not undermine performance, UX coherence, or security.

## Privacy and User Control

Privacy is a product requirement. Aequera should not introduce:

- telemetry without explicit consent;
- advertising or sponsored UI;
- forced accounts for normal browsing;
- unnecessary vendor services;
- silent remote configuration;
- unnecessary background activity or data collection.

Network activity must have a user-visible or platform-required reason and security-sensitive behavior must remain protected from ordinary customization.

## Upstream Architecture

Aequera should not become a permanently hand-edited Firefox fork.

The preferred source-of-truth model is:

```text
Mozilla Firefox / Gecko
        ↓
 pinned upstream revision
        ↓
 clean upstream source
        ↓
 reproducible Aequera patchset
        ↓
 Aequera-owned source + configuration
        ↓
 build / test / benchmark
        ↓
 Aequera artifact
```

The key boundary is:

> **Aequera-owned code is source; Firefox modifications are an explicit, reviewable patchset.**

Upstream Firefox is treated as an input/artifact, not as the place where Aequera's product identity lives.

## Documentation Map

### Product and vision

- `docs/VISION.md` — project philosophy, principles, and success conditions.
- `docs/PRODUCT.md` — default browser experience and primary concepts.
- `docs/FEATURES.md` — feature/capability map and responsibility classification.
- `docs/RESTRICTIONS.md` — hard constraints and non-goals.

### Architecture and design

- `docs/ARCHITECTURE.md` — system layers and dependency direction.
- `docs/SOURCE_LAYOUT.md` — Aequera source ownership and repository boundaries.
- `docs/WORKFLOW.md` — development, patch, upstream, test, and release flow.
- `docs/design/UX_PRINCIPLES.md` — HCI and ergonomic principles.
- `docs/design/MOTION.md` — motion and transition system.
- `docs/design/MATERIAL.md` — surface/material system.
- `docs/design/CUSTOMIZATION.md` — values, profiles, settings, CSS, themes, and add-ons.
- `docs/design/WORKSPACE.md` — workspace and tab interaction model.

### Engineering

- `docs/engineering/DEVELOPMENT.md` — day-to-day development loop.
- `docs/engineering/CLI.md` — intent-oriented Aequera CLI.
- `docs/engineering/UPSTREAM1.md` — Firefox source pinning and synchronization.
- `docs/engineering/UPSTREAM2.md` — upstream track policy for this phase.
- `docs/engineering/PATCHING.md` — patch-stack structure, lifecycle, metadata, and conflict handling.
- `docs/engineering/PERFORMANCE.md` — performance model and budgets.
- `docs/engineering/SECURITY.md` — security/privacy requirements and threat areas.
- `docs/engineering/COMPATIBILITY.md` — Firefox/WebExtension/platform compatibility policy.
- `docs/engineering/TESTING.md` — test hierarchy and acceptance gates.
- `docs/engineering/RELEASE.md` — release, versioning, reproducibility, and rollback.
- `docs/engineering/RELEASE_EVIDENCE_AND_TRUST.md` — proposed release evidence and trust policy.

### Delivery

- `docs/ROADMAP.md` — staged implementation roadmap.
- `docs/QUALITY_GATES.md` — phase-exit quality gates.
- `docs/adr/0001-project-direction.md` — initial architectural/product direction.
- `docs/adr/0002-upstream-and-patch-model.md` — upstream and patch architecture decision.

### Agent support

- `agent/PROJECT_CONTEXT.md` — concise context for coding agents.
- `agent/IMPLEMENTATION_RULES.md` — implementation invariants and task rules.
- `agent/TASK_WORKFLOW.md` — agent-specific task decomposition and verification loop.

## Project Status

Current stage: **architecture and foundation**.

The immediate work is to establish a reproducible Firefox baseline, formalize the source/patch/config boundaries, establish measurable performance instrumentation, and build the first browser-shell foundations without allowing the project to become a giant undifferentiated fork.

## Name

**Aequera** is a coined name inspired by Latin *aequus* (“balanced, harmonious, even”) and the idea of an *era*.

The project uses the name to express a new era of balanced, human-centered, adaptable computing and browsing.
