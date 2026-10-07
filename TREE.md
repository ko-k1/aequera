# Aequera Repository Skeleton

This document describes the intended repository shape. The documentation phase can exist before all implementation directories are created.

> Note: `aequera/ui|services|integrations|customization` and several
> `tests/*` / `configs/schemas|profiles` entries below are still skeleton
> placeholders (see `docs/ROADMAP.md`, `docs/QUALITY_GATES.md`). Implemented
> since the skeleton: `aequera/core`, `aequera/shell/firefox`,
> `aequera/design/tokens.toml+branding`, `aequera/extensions/shell-chrome`,
> `patches/*/ + patches/manifest.yaml`, `tools/cli|branding|patch/assemble.py`,
> `prototype/`, `Cargo.toml/lock`. No `.gitmodules`: upstream is a managed
> checkout per `docs/engineering/UPSTREAM1.md`, never a submodule.
> `upstream/firefox/` and `worktree/firefox/` exist on disk but are
> git-ignored generated state, never source of truth (`docs/SOURCE_LAYOUT.md`).

```text
aequera/
├── README.md
├── AGENTS.md
├── LICENSE
├── Cargo.toml / Cargo.lock     # Rust workspace (aequera/core, tools/cli)
├── .gitignore
│
├── docs/
│   ├── VISION.md
│   ├── PRODUCT.md
│   ├── FEATURES.md
│   ├── RESTRICTIONS.md
│   ├── ARCHITECTURE.md
│   ├── SOURCE_LAYOUT.md
│   ├── WORKFLOW.md
│   ├── ROADMAP.md
│   ├── QUALITY_GATES.md
│   ├── PHASE0_FOUNDATION.md
│   ├── README.md               # doc index
│   ├── design/
│   │   ├── UX_PRINCIPLES.md
│   │   ├── MOTION.md
│   │   ├── MATERIAL.md
│   │   ├── CUSTOMIZATION.md
│   │   ├── EXTENSIONS.md
│   │   └── WORKSPACE.md
│   ├── engineering/
│   │   ├── DEVELOPMENT.md
│   │   ├── CLI.md
│   │   ├── UPSTREAM1.md
│   │   ├── UPSTREAM2.md
│   │   ├── PATCHING.md
│   │   ├── PERFORMANCE.md
│   │   ├── SECURITY.md
│   │   ├── COMPATIBILITY.md
│   │   ├── TESTING.md
│   │   ├── RELEASE.md
│   │   └── RELEASE_EVIDENCE_AND_TRUST.md
│   └── adr/
│       ├── 0001-project-direction.md
│       └── 0002-upstream-and-patch-model.md
│
├── agent/
│   ├── PROJECT_CONTEXT.md
│   ├── IMPLEMENTATION_RULES.md
│   └── TASK_WORKFLOW.md
│
├── aequera/
│   ├── core/
│   ├── shell/
│   ├── ui/
│   ├── design/
│   ├── customization/
│   ├── services/
│   ├── integrations/
│   └── extensions/
│
├── patches/
│   ├── browser/
│   ├── toolkit/
│   ├── gecko/                  # exceptional, empty until justified
│   ├── build/
│   └── manifest.yaml           # ordered series + overlays (see patches/)
│
├── configs/
│   ├── defaults/
│   ├── profiles/
│   └── schemas/
│
├── upstream/
│   ├── firefox/
│   └── manifests/
│       ├── firefox.lock
│       └── patchsets/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── ui/
│   ├── ux/
│   ├── accessibility/
│   ├── compatibility/
│   ├── security/
│   └── performance/
│
├── tools/
│   ├── bootstrap/
│   ├── upstream/
│   ├── patch/                  # assemble.py (Git-native series helper)
│   ├── build/
│   ├── benchmark/
│   ├── branding/               # brand asset renderer
│   ├── cli/                    # `aequera` Rust CLI
│   └── ci/
│
├── prototype/shell/           # design-spike prototype, not shipped chrome
│
└── worktree/
    └── firefox/              # generated, never the source of truth
```

## Ownership Summary

| Path | Responsibility | Source of truth? |
|---|---|---|
| `aequera/core` | browsing domain/state | yes |
| `aequera/shell` | browser chrome/workflow | yes |
| `aequera/ui` | reusable UI components | yes |
| `aequera/design` | semantic design system | yes |
| `aequera/customization` | settings/values/profiles | yes |
| `aequera/services` | browser services | yes |
| `aequera/integrations` | Firefox/OS boundaries | yes |
| `aequera/extensions` | first-party built-in extensions | yes |
| `patches` | deliberate Firefox divergence | yes, as patch history |
| `configs` | defaults/policies/schemas | yes |
| `upstream/firefox` | pinned Firefox source | external input |
| `worktree/firefox` | patched generated tree | no |

## Boundary Rule

A feature should live at the highest layer that can implement it without sacrificing correctness, UX, performance, security, or compatibility.
