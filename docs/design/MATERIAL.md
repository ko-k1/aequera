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
an in-page `backdrop-filter`, so the blur costs the browser nothing per frame.
One setting, `aequera.material.frame` = `auto` | `glass` | `solid`, means the
same on every platform:

| | `auto` (default) | `glass` | `solid` |
|---|---|---|---|
| Windows 11 | Acrylic (live blur of what is behind the window) | Acrylic | no backdrop |
| macOS | vibrancy | vibrancy | opaque |
| Linux | glass where the desktop blurs, else solid | glass where the window can show transparency | opaque |

- Windows 11: DWM draws the backdrop (`widget.windows.mica`,
  `widget.windows.mica.toplevel-backdrop`, which `aequera-frame.js` sets per
  material on the default branch). Acrylic, not Mica: Mica samples the
  wallpaper once and reads as a flat tint, while glass is a live blur on
  every platform. The material wins over Windows' "Show accent color on
  title bars", which upstream paints over the whole frame; the accent stays
  on the window border. Windows 10 has no backdrop: solid.
- macOS: the window server blurs the desktop behind a vibrant region spread
  over the whole frame (the titlebar material upstream already puts behind
  the toolbox, blending behind the window). On macOS 26 and later that
  region is Liquid Glass (`NSGlassEffectView`, `widget.macos.titlebar-glass.enabled`,
  read at startup; `patches/gecko/macos-glass`). Solid also drops upstream's
  toolbox vibrancy.
- Linux: glass tints the frame with the theme color at
  `aequera.material.opacity` (60-100%, also on macOS) and the compositor blurs
  the desktop behind it. Hyprland blurs every translucent window; other
  Wayland compositors (KDE Plasma 6.7+, GNOME) blur when asked, and Gecko asks
  through `ext-background-effect-v1` for exactly the translucent parts of the
  window (`widget.wayland.background-blur.enabled`,
  `patches/gecko/background-blur`), exposing the result to the shell as the
  chrome-only media query `(-moz-gtk-background-blur-available)`. `auto` picks
  glass only on such a desktop and follows it live; anywhere else the frame
  stays solid, never chrome text over a sharp wallpaper. X11: solid.

The Gecko patches need a compiled build; an artifact build runs Mozilla's
prebuilt binary, where Linux `auto` falls back to Hyprland-only and macOS to
plain vibrancy.

Implementation: `aequera/shell/README.md` (Frame material).

## Material Performance

- expensive effects must degrade gracefully;
- blur/transparency should not be stacked unnecessarily;
- static/cached surfaces are valid alternatives to live effects;
- material settings must not silently break readability or accessibility.

## Visual Rule

Richness should communicate depth, grouping, focus, or state. The product should not depend on decorative complexity to feel complete.
