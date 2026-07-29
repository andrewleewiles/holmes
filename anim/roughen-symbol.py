#!/usr/bin/env /usr/bin/python3
"""Build a boiling idle sprite for the Holmes mark by roughening its outline.

No generation, no tracing — the one symbol path is perturbed N times with
smooth pseudo-random noise, which is what hand-drawn "boil" actually is: the
same shape redrawn slightly differently each frame.

The noise is a sum of sines indexed by *distance along the outline*, not by
point index. That matters: the symbol's path has control points bunched tightly
on curves and spread out on straight runs, so index-based noise would shimmer
finely on the curves and coarsely on the straights. Distance-based noise gives
one consistent wobble wavelength all the way round, which reads as a wobbling
line rather than sandpaper.

Output matches the existing mark strips: one row of 96px square frames,
grayscale + alpha, ready for the .holmes-mark CSS mask sweep.

Run with /usr/bin/python3 — that's the one with fontTools.
"""
import math, os, random, re, subprocess, sys

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.svgLib.path import parse_path

ROOT = "/Volumes/andrews-ssd/projects/holmes"
SRC = f"{ROOT}/assets/holmesSymbol.svg"
OUT_STRIP = f"{ROOT}/assets/anim/holmes-idle-boil.png"
TMP = "/private/tmp/claude-501/-Volumes-andrews-ssd-projects-holmes/9a02051b-f123-4e24-b229-aebdd32f0e04/scratchpad/boilmark"

FRAMES = int(os.environ.get("FRAMES", "10"))
SIZE = 96                       # matches the other mark strips
AMP = float(os.environ.get("AMP", "2.0"))      # wobble depth, in viewBox units
WAVE = float(os.environ.get("WAVE", "22"))     # wobble wavelength, viewBox units
SEED = 4708


def noise(seed):
    """Smooth 1-D noise: three octaves of sine with random phase."""
    rng = random.Random(seed)
    terms = [(f, rng.uniform(0, 2 * math.pi), w)
             for f, w in ((1.0, 1.0), (2.3, 0.5), (4.7, 0.25))]
    norm = sum(w for _, _, w in terms)
    return lambda t: sum(w * math.sin(f * t + p) for f, p, w in terms) / norm


def roughen(rec, seed):
    """Perturb every point, offset driven by distance travelled along the path."""
    fx, fy = noise(seed), noise(seed + 9973)
    out = RecordingPen()
    s = 0.0
    last = None

    def jog(pt):
        nonlocal s, last
        x, y = pt
        if last is not None:
            s += math.hypot(x - last[0], y - last[1])
        last = (x, y)
        t = s / WAVE
        return (x + AMP * fx(t), y + AMP * fy(t))

    for op, args in rec.value:
        if op in ("moveTo", "lineTo"):
            out.value.append((op, (jog(args[0]),)))
        elif op in ("curveTo", "qCurveTo"):
            out.value.append((op, tuple(jog(p) for p in args)))
        else:
            out.value.append((op, args))
    return out


def main():
    os.makedirs(TMP, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_STRIP), exist_ok=True)
    svg = open(SRC).read()
    d = re.search(r'<path[^>]*\sd="([^"]+)"', svg).group(1)
    vb = re.search(r'viewBox="([^"]+)"', svg).group(1)
    w, h = (float(v) for v in vb.split()[2:4])

    base = RecordingPen()
    parse_path(d, base)

    frames = []
    for i in range(FRAMES):
        pen = SVGPathPen(None)
        roughen(base, SEED + i * 101).replay(pen)
        one = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
               f'viewBox="{vb}"><path d="{pen.getCommands()}" fill="#000"/></svg>')
        svg_p, png_p = f"{TMP}/f{i}.svg", f"{TMP}/f{i}.png"
        open(svg_p, "w").write(one)
        # square canvas so every frame lands identically under the mask sweep
        subprocess.run(["rsvg-convert", "-w", str(SIZE), "-h", str(SIZE),
                        "-a", "-o", png_p, svg_p], check=True)
        subprocess.run(["magick", png_p, "-background", "none", "-gravity", "center",
                        "-extent", f"{SIZE}x{SIZE}", png_p], check=True)
        frames.append(png_p)

    # +repage matters: -extent leaves a 96x96 page on each frame, and without
    # clearing it the appended strip reports a stale page geometry that makes
    # any later -crop return a single tile instead of the ten frames.
    subprocess.run(["magick", *frames, "+append", "+repage", "-colorspace", "gray",
                    OUT_STRIP], check=True)
    dims = subprocess.run(["magick", "identify", "-format", "%wx%h %[channels]",
                           OUT_STRIP], capture_output=True, text=True).stdout
    print(f"{FRAMES} frames  amp={AMP} wave={WAVE}  ->  {OUT_STRIP}  ({dims})")


if __name__ == "__main__":
    main()
