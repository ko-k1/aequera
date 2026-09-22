# Motion System

## Purpose

Motion communicates state, causality, hierarchy, and continuity. It must never become a mandatory waiting period.

## Motion Roles

- `enter` — a surface becomes available;
- `exit` — a surface leaves the current context;
- `transform` — an object changes location/state;
- `reorder` — spatial relationships change;
- `focus` — attention moves;
- `feedback` — an input/state change is acknowledged.

## Rules

- prefer short transitions;
- transitions must be interruptible;
- new intent supersedes obsolete animation;
- prefer compositor-friendly properties;
- use related easing families consistently;
- reduced motion preserves state information without decorative movement.

## User Controls

Conceptual values:

```toml
motion.global.profile = "balanced"
motion.global.duration_scale = 1.0
motion.sidebar.open.duration = 140ms
motion.sidebar.open.easing = "snappy"
motion.workspace.switch.duration = 120ms
motion.popup.enter.duration = 90ms
```

Suggested profiles:

- `instant`
- `minimal`
- `balanced`
- `fluid`
- `expressive`
- `reduced`
- `custom`

Profiles are semantic presets, not hard-coded component animations.

## Performance Constraint

A visual effect is unacceptable when it causes frame instability, input lag, or delayed task completion without a measurable UX benefit.
