# Material and Visual System

## Goal

Allow rich, configurable surfaces while maintaining hierarchy, legibility, accessibility, and responsiveness.

## Material Families

- `solid`
- `frosted`
- `translucent`
- `gradient`
- `monochrome`
- `custom`

## Semantic Surface Levels

```text
background
surface
raised-surface
floating-surface
overlay
modal
```

These describe hierarchy, not fixed colors.

## Example Values

```toml
material.sidebar.type = "frosted"
material.sidebar.opacity = 0.86
material.sidebar.blur = 20
material.sidebar.saturation = 1.0
material.sidebar.border = true
material.sidebar.shadow = "soft"
```

## Material Performance

- expensive effects must degrade gracefully;
- blur/transparency should not be stacked unnecessarily;
- static/cached surfaces are valid alternatives to live effects;
- material settings must not silently break readability or accessibility.

## Visual Rule

Richness should communicate depth, grouping, focus, or state. The product should not depend on decorative complexity to feel complete.
