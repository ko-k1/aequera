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

## Frame Material Backends

The frame (the one surface behind all chrome) is blurred by the OS, never by
an in-page `backdrop-filter`, so the blur costs the browser nothing per frame:

- Windows 11: Mica (`widget.windows.mica`).
- Linux: `aequera.material.frame` = `auto` | `glass` | `solid`. Glass tints
  the frame with the theme color at `aequera.material.opacity` (60-100%) and
  the compositor blurs the desktop behind it; `auto` picks glass only where
  the desktop blurs translucent windows by default (Hyprland). A desktop that
  does not blur gets the solid frame, never chrome text over a sharp
  wallpaper.
- macOS: no vibrancy wiring yet; solid.

Implementation: `aequera/shell/README.md` (Frame material).

## Material Performance

- expensive effects must degrade gracefully;
- blur/transparency should not be stacked unnecessarily;
- static/cached surfaces are valid alternatives to live effects;
- material settings must not silently break readability or accessibility.

## Visual Rule

Richness should communicate depth, grouping, focus, or state. The product should not depend on decorative complexity to feel complete.
