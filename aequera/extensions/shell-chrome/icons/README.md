# shell-chrome icons

`icon-{16,32,48,128}.png` are transparent exports of the canonical mark
(`aequera/design/branding/source/aequera-icon.svg`), rendered by
`tools/branding/render_brand_assets.py` — the same geometry as the
Firefox branding directory's `default*.png`.

Regenerate (from repo root):

```sh
python -c "import sys; sys.path.insert(0,'tools/branding'); \
  import render_brand_assets as r; \
  [r.mark(s).save(f'aequera/extensions/shell-chrome/icons/icon-{s}.png', \
  optimize=True) for s in (16,32,48,128)]"
```

Do not hand-edit the PNGs. Wired via top-level `icons` in `manifest.json`
(add-ons manager / `about:debugging` identity).
