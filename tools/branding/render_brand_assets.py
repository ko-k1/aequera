"""Render Aequera's raster brand assets from the canonical geometric mark.

Source of truth: aequera/design/branding/source/aequera-icon.svg
(one congruent three-face block repeated by exact 120-degree rotations
about (205, 214), faces #4ED5FF / #4EFFFF, viewBox 0 0 200 200).

The renderer parses that file's #unit-sector shapes, so geometry edits
flow through. It replays the three rotations (0/120/240) plus the
scale(0.5) into the 200-unit viewBox, then scales to each output size.
Supersampled Pillow polygons + LANCZOS downscale keep edges clean.

Private variant reuses the same geometry with remapped fills
(#4ED5FF -> #8C5ADC, #4EFFFF -> #C4A8FF); see source/README.md.

Usage: python tools/branding/render_brand_assets.py [branding dir]
  (default: aequera/design/branding). Requires Pillow. Deterministic: the
  same inputs always produce byte-identical files.
"""

import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageDraw

SUPERSAMPLE = 8

# Source construction (mirrors aequera-icon.svg).
CENTER = (205.0, 214.0)
VIEWBOX = 200.0
ANGLES = (0.0, 120.0, 240.0)

BLUE = (78, 213, 255, 255)  # #4ED5FF
CYAN = (78, 255, 255, 255)  # #4EFFFF
PRIVATE_BLUE = (140, 90, 220, 255)  # #8C5ADC
PRIVATE_CYAN = (196, 168, 255, 255)  # #C4A8FF

COLOR_MAP = {
    "#4ed5ff": (BLUE, PRIVATE_BLUE),
    "#4effff": (CYAN, PRIVATE_CYAN),
}


def _source_path():
    root = Path(__file__).resolve().parents[2]
    return root / "aequera" / "design" / "branding" / "source" / "aequera-icon.svg"


def _parse_path_d(d):
    tokens = re.findall(r"[MLZmlz]|[-+]?\d*\.?\d+", d)
    points = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        i += 1
        if tok in ("M", "m", "L", "l"):
            x = float(tokens[i])
            y = float(tokens[i + 1])
            i += 2
            points.append((x, y))
        elif tok in ("Z", "z"):
            break
        else:
            raise ValueError(f"unexpected token in path d: {tok!r}")
    return points


def _load_unit_shapes(source=None):
    """Shapes of #unit-sector in document order: [(fill_hex, [(x, y), ...])]."""
    path = Path(source) if source else _source_path()
    root = ET.parse(path).getroot()
    sector = None
    for elem in root.iter():
        if elem.tag.endswith("}g") or elem.tag == "g":
            if elem.attrib.get("id") == "unit-sector":
                sector = elem
                break
    if sector is None:
        raise ValueError(f"#unit-sector not found in {path}")
    shapes = []
    for child in list(sector):
        tag = child.tag.split("}")[-1]
        fill = child.attrib.get("fill", "#4ED5FF")
        if tag == "path":
            shapes.append((fill, _parse_path_d(child.attrib["d"])))
        elif tag == "rect":
            x = float(child.attrib["x"])
            y = float(child.attrib["y"])
            w = float(child.attrib["width"])
            h = float(child.attrib["height"])
            shapes.append((fill, [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]))
    if not shapes:
        raise ValueError(f"no shapes in #unit-sector of {path}")
    return shapes


def _map_color(fill_hex, private):
    pair = COLOR_MAP.get(fill_hex.lower())
    if pair:
        return pair[1] if private else pair[0]
    h = fill_hex.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def _rotate_about(x, y, angle_deg):
    theta = math.radians(angle_deg)
    cos_a, sin_a = math.cos(theta), math.sin(theta)
    dx, dy = x - CENTER[0], y - CENTER[1]
    return (
        CENTER[0] + dx * cos_a - dy * sin_a,
        CENTER[1] + dx * sin_a + dy * cos_a,
    )


def mark(size, private=False, source=None):
    """The real mark at `size` px, antialiased by supersampling."""
    shapes = _load_unit_shapes(source)
    big = size * SUPERSAMPLE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")
    # Source units -> viewBox (scale 0.5) -> pixels (big / VIEWBOX).
    scale = big / (VIEWBOX * 2.0)
    for angle in ANGLES:
        for fill_hex, points in shapes:
            transformed = []
            for x, y in points:
                rx, ry = _rotate_about(x, y, angle)
                transformed.append((rx * scale, ry * scale))
            draw.polygon(transformed, fill=_map_color(fill_hex, private))
    return image.resize((size, size), Image.LANCZOS)


def tile(size, background, private=False):
    """Square tile (Start menu, installer art): the mark centered on a flat color."""
    image = Image.new("RGBA", (size, size), background + (255,))
    inner = round(size * 0.6)
    offset = (size - inner) // 2
    image.alpha_composite(mark(inner, private=private), (offset, offset))
    return image


def svg_mark(size=512, source=None):
    path = Path(source) if source else _source_path()
    text = path.read_text(encoding="utf-8")
    start = text.index(">") + 1
    end = text.rindex("</svg>")
    inner = text[start:end].strip() + "\n"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 200 200" role="img">\n{inner}</svg>\n'
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
    mark(256, private=True).save(out / "pbmode.ico", sizes=ico_sizes)
    tile_bg = (20, 23, 26)
    for size in (70, 150):
        tile(size, tile_bg).save(out / f"VisualElements_{size}.png", optimize=True)
        tile(size, (37, 0, 62), private=True).save(
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
    mark(192, private=True).save(content / "about-logo-private.png", optimize=True)
    mark(384, private=True).save(content / "about-logo-private@2x.png", optimize=True)
    mark(300).save(content / "about.png", optimize=True)
    (content / "about-logo.svg").write_text(svg_mark(), encoding="utf-8", newline="\n")
    (content / "document_pdf.svg").write_text(svg_mark(), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "aequera" / "design" / "branding"
    sys.exit(main(target))
