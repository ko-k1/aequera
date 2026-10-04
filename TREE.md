# Aequera Repository Skeleton

This document describes the intended repository shape. The documentation phase can exist before all implementation directories are created.

```text
aequera/
├── README.md
├── AGENTS.md
├── LICENSE
├── .gitignore
├── .gitmodules
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
│   ├── design/
│   │   ├── UX_PRINCIPLES.md
│   │   ├── MOTION.md
│   │   ├── MATERIAL.md
│   │   ├── CUSTOMIZATION.md
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
│   ├── gecko/
│   └── build/
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
│   ├── patch/
│   ├── build/
│   ├── benchmark/
│   └── ci/
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
