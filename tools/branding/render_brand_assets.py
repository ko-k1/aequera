"""Render Aequera's raster brand assets from the mark defined here.

The mark ("aequus": level, even) is two equal white bars on a round
teal-to-indigo field. It is drawn with plain geometry so the same shapes
produce the SVGs (about-logo.svg) and every PNG/ICO/BMP Firefox's branding
directory expects; nothing is derived from Mozilla artwork.

Usage: python tools/branding/render_brand_assets.py [branding dir]
  (default: aequera/design/branding). Requires Pillow. Deterministic: the
  same inputs always produce byte-identical files.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

TOP = (63, 208, 201)  # teal, top-left of the field
BOTTOM = (79, 91, 213)  # indigo, bottom-right
PRIVATE_TOP = (140, 90, 220)  # private browsing: violet field
PRIVATE_BOTTOM = (60, 30, 120)
BAR = (255, 255, 255)
SUPERSAMPLE = 8

# Geometry as fractions of the icon size.
FIELD_INSET = 0.04
BAR_WIDTH = 0.50
BAR_HEIGHT = 0.11
BAR_GAP = 0.10


def mark(size, top=TOP, bottom=BOTTOM, field=True):
    """The mark at `size` px, antialiased by supersampling."""
    big = size * SUPERSAMPLE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    if field:
        # A linear gradient: exact at a small size, then scaled up smoothly.
        steps = 64
        gradient = Image.new("RGBA", (steps, steps))
        pixels = gradient.load()
        for y in range(steps):
            for x in range(steps):
                t = (x + y) / (2 * (steps - 1))
                pixels[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,)
        gradient = gradient.resize((big, big), Image.BILINEAR)
        disc = Image.new("L", (big, big), 0)
        inset = round(big * FIELD_INSET)
        ImageDraw.Draw(disc).ellipse((inset, inset, big - inset - 1, big - inset - 1), fill=255)
        image.paste(gradient, (0, 0), disc)
    draw = ImageDraw.Draw(image)
    width, height, gap = big * BAR_WIDTH, big * BAR_HEIGHT, big * BAR_GAP
    left = (big - width) / 2
    for top_edge in ((big - gap) / 2 - height, (big + gap) / 2):
        draw.rounded_rectangle(
            (left, top_edge, left + width, top_edge + height), radius=height / 2, fill=BAR + (255,)
        )
    return image.resize((size, size), Image.LANCZOS)


def tile(size, background, top=TOP, bottom=BOTTOM):
    """Square tile (Start menu, installer art): the mark centered on a flat color."""
    image = Image.new("RGBA", (size, size), background + (255,))
    inner = round(size * 0.6)
    offset = (size - inner) // 2
    image.alpha_composite(mark(inner, top, bottom), (offset, offset))
    return image


def svg_mark(size=512):
    inset = size * FIELD_INSET
    radius = (size - 2 * inset) / 2
    width, height, gap = size * BAR_WIDTH, size * BAR_HEIGHT, size * BAR_GAP
    left = (size - width) / 2
    bars = "".join(
        f'<rect x="{left:g}" y="{y:g}" width="{width:g}" height="{height:g}" rx="{height / 2:g}" fill="#fff"/>'
        for y in ((size - gap) / 2 - height, (size + gap) / 2)
    )
    hex_ = lambda c: "#%02x%02x%02x" % c
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f'<defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{hex_(TOP)}"/><stop offset="1" stop-color="{hex_(BOTTOM)}"/>'
        f"</linearGradient></defs>"
        f'<circle cx="{size / 2:g}" cy="{size / 2:g}" r="{radius:g}" fill="url(#f)"/>{bars}</svg>\n'
    )


def main(out):
    out.mkdir(parents=True, exist_ok=True)
    for size in (16, 22, 24, 32, 48, 64, 128, 256):
        mark(size).save(out / f"default{size}.png", optimize=True)
    ico_sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    base = mark(256)
    for name in ("firefox.ico", "document.ico", "document_pdf.ico", "newtab.ico", "newwindow.ico"):
        base.save(out / name, sizes=ico_sizes)
    mark(256).save(out / "firefox64.ico", sizes=[(64, 64)])
    mark(256, PRIVATE_TOP, PRIVATE_BOTTOM).save(out / "pbmode.ico", sizes=ico_sizes)
    tile_bg = (20, 23, 26)
    for size in (70, 150):
        tile(size, tile_bg).save(out / f"VisualElements_{size}.png", optimize=True)
        tile(size, (37, 0, 62), PRIVATE_TOP, PRIVATE_BOTTOM).save(
            out / f"PrivateBrowsing_{size}.png", optimize=True
        )
    # Windows installer art (NSIS wizard bitmaps, stub installer background).
    wizard_bg = (20, 23, 26)
    for name, size in (("wizHeader.bmp", (150, 57)), ("wizHeaderRTL.bmp", (150, 57))):
        header = Image.new("RGB", size, (255, 255, 255))
        logo = mark(size[1] - 12)
        x = size[0] - logo.width - 6 if name == "wizHeader.bmp" else 6
        header.paste(logo, (x, 6), logo)
        header.save(out / name)
    watermark = Image.new("RGB", (164, 314), wizard_bg)
    logo = mark(96)
    watermark.paste(logo, ((164 - 96) // 2, 60), logo)
    watermark.save(out / "wizWatermark.bmp")
    stub = out / "stubinstaller"
    stub.mkdir(exist_ok=True)
    background = Image.new("RGB", (1344, 822), wizard_bg)
    logo = mark(160)
    background.paste(logo, ((1344 - 160) // 2, 180), logo)
    background.save(stub / "bgstub.jpg", quality=90)
    content = out / "content"
    content.mkdir(exist_ok=True)
    mark(192).save(content / "about-logo.png", optimize=True)
    mark(384).save(content / "about-logo@2x.png", optimize=True)
    mark(192, PRIVATE_TOP, PRIVATE_BOTTOM).save(content / "about-logo-private.png", optimize=True)
    mark(384, PRIVATE_TOP, PRIVATE_BOTTOM).save(content / "about-logo-private@2x.png", optimize=True)
    mark(300).save(content / "about.png", optimize=True)
    (content / "about-logo.svg").write_text(svg_mark(), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "aequera" / "design" / "branding"
    sys.exit(main(target))
