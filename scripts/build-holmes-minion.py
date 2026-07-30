#!/usr/bin/env python3
"""Builds the Holmes Minion document face from the boiling display font.

    python3 scripts/build-holmes-minion.py

This is a ONE-SHOT generator, not a build step. It writes a committed artifact,
src/office-shell/fonts/HolmesMinion-Regular.ttf, which scripts/build-office-shell.mjs
installs into the ONLYOFFICE bundle. Re-run it only when the boil faces change;
nothing in `pnpm build` calls it, so fontTools is not a build dependency.

Two decisions are worth the explanation.

**Why it is a merge.** Each boil face was drawn for the wordmark and covers 78
characters — A-Z a-z 0-9, a little punctuation and the curly quotes. It has no
comma. A word processor whose default font cannot set a comma is not a word
processor, so the base of this font is EB Garamond, which Holmes already ships
as its serif and which sits at the same 1000 units/em, and the boil drawings are
laid over the characters they cover.

**Why the outlines are converted.** The boil faces are CFF and EB Garamond is a
variable font; ONLYOFFICE renders neither. Every one of the 218 fonts in its
bundle is a static TrueType, which is a fair sign of what its font engine was
built to read — and a CFF face registered by hand renders as a silent fallback
with the toolbar still naming it correctly, which is a hard failure to read. So
the variable axes are pinned first and the boil curves are converted from cubic
to quadratic on the way in.

The result is one static regular weight. There is no bold or italic: ONLYOFFICE
synthesises both, which is what it already does for every other single-face font
in the bundle.
"""
import sys
from pathlib import Path

from fontTools.ttLib import TTFont, newTable
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
BOIL = ROOT / "src/renderer/assets/fonts/boil/HolmesBoil-0.woff2"
BASE = ROOT / "src/renderer/assets/fonts/EBGaramond-Variable.woff2"
OUT = ROOT / "src/office-shell/fonts/HolmesMinion-Regular.ttf"

FAMILY = "Holmes Minion"
POSTSCRIPT = "HolmesMinion-Regular"
VERSION = "Version 1.000"

# How closely the quadratic curves have to follow the cubic ones, in font units
# at 1000/em. Half a unit is far below a printed pixel and keeps the boil wobble
# — the whole point of these drawings — intact.
MAX_ERROR = 0.5


def main() -> int:
    for path in (BOIL, BASE):
        if not path.exists():
            print(f"missing source font: {path}", file=sys.stderr)
            return 1

    boil = TTFont(BOIL)
    font = TTFont(BASE)

    if boil["head"].unitsPerEm != font["head"].unitsPerEm:
        print("the two faces disagree on units/em; this script assumes they match", file=sys.stderr)
        return 1

    # Pin the weight axis and drop the variation machinery: a static instance is
    # all ONLYOFFICE can read, and leaving fvar behind would advertise axes that
    # no longer have deltas.
    if "fvar" in font:
        instancer.instantiateVariableFont(font, {"wght": 400}, inplace=True, updateFontNames=False)
    for tag in ("fvar", "gvar", "avar", "HVAR", "VVAR", "MVAR", "STAT", "cvar"):
        if tag in font:
            del font[tag]

    # Shaping tables come from EB Garamond and know nothing about the boil
    # drawings. Left in place, an `fi` ligature would substitute one Garamond
    # glyph for two boil ones in the middle of a word.
    for tag in ("GSUB", "GPOS", "kern"):
        if tag in font:
            del font[tag]

    base_cmap = font.getBestCmap()
    boil_cmap = boil.getBestCmap()
    boil_glyphs = boil.getGlyphSet()
    boil_metrics = boil["hmtx"].metrics
    glyf, hmtx = font["glyf"], font["hmtx"].metrics

    replaced, added = 0, 0
    # Sorted so the glyph order — and so the bytes on disk — is stable across
    # runs; an artifact that churns is one nobody can review.
    for code in sorted(boil_cmap):
        source = boil_cmap[code]
        name = base_cmap.get(code)
        if name is None:
            # A character the boil face has and EB Garamond does not. Rare, but
            # dropping it would silently lose a glyph the wordmark relies on.
            name = f"holmesboil{code:04X}"
            font.setGlyphOrder(font.getGlyphOrder() + [name])
            added += 1
        else:
            replaced += 1
        pen = TTGlyphPen(None)
        boil_glyphs[source].draw(Cu2QuPen(pen, MAX_ERROR))
        glyf[name] = pen.glyph()
        hmtx[name] = (boil_metrics[source][0], boil_metrics[source][1])
        base_cmap[code] = name

    font["maxp"].numGlyphs = len(font.getGlyphOrder())
    rebuild_cmap(font, base_cmap)
    rename(font)

    font["OS/2"].fsType = 0                   # installable embedding
    font["OS/2"].usWeightClass = 400
    font["head"].macStyle = 0
    font.flavor = None                        # plain TTF, not woff2

    OUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUT)

    print(f"{OUT.relative_to(ROOT)}")
    print(f"  {replaced} boil glyphs over EB Garamond, {added} added, {len(base_cmap)} characters")
    print(f"  {OUT.stat().st_size / 1024:.0f} KB")
    return 0


def rebuild_cmap(font: TTFont, mapping: dict) -> None:
    """One format-4 BMP subtable and one format-12, which is what every shaper
    expects and what ONLYOFFICE's font engine reads."""
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

    cmap = newTable("cmap")
    cmap.tableVersion = 0
    bmp = CmapSubtable.newSubtable(4)
    bmp.platformID, bmp.platEncID, bmp.language = 3, 1, 0
    bmp.cmap = {code: name for code, name in mapping.items() if code <= 0xFFFF}
    full = CmapSubtable.newSubtable(12)
    full.platformID, full.platEncID, full.language = 3, 10, 0
    full.format, full.reserved, full.length, full.nGroups = 12, 0, 0, 0
    full.cmap = dict(mapping)
    cmap.tables = [bmp, full]
    font["cmap"] = cmap


def rename(font: TTFont) -> None:
    """The family name is what ONLYOFFICE shows in the toolbar and what x2t
    writes into the .docx, so it has to be the name AllFonts.js registers."""
    name = font["name"]
    name.names = []
    for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
        for name_id, value in (
            (1, FAMILY),
            (2, "Regular"),
            (3, f"{FAMILY}; {VERSION}"),
            (4, FAMILY),
            (5, VERSION),
            (6, POSTSCRIPT),
        ):
            name.setName(value, name_id, platform, encoding, language)


if __name__ == "__main__":
    raise SystemExit(main())
