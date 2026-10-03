# Aequera icon source

Canonical mark: `aequera-icon.svg`.

- Geometric construction: one congruent three-face block repeated by exact
  120° rotations about `(205, 214)` in source units, then `scale(0.5)` into
  the `viewBox 0 0 200 200`.
- Face colors: `#4ED5FF` (blue faces) and `#4EFFFF` (cyan bent face).
- No background field; all rasters keep transparency except BMP/JPG
  installer art, which composites onto its existing background.

Rules:

1. Edit the geometry here. Never hand-edit generated rasters.
2. Regenerate with `python tools/branding/render_brand_assets.py`
   (Pillow only; deterministic, byte-identical). The renderer parses this
   file's `#unit-sector` shapes, so geometry edits flow through.
3. Private variant reuses the same geometry with remapped fills:
   `#4ED5FF` → `#8C5ADC` `(140, 90, 220)`,
   `#4EFFFF` → `#C4A8FF` `(196, 168, 255)`.
4. `content/about-logo.svg` and `content/document_pdf.svg` are scaled
   copies of this file (512px, `viewBox 0 0 200 200`); wordmarks are
   unchanged text.
