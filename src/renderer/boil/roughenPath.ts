/**
 * Roughen an SVG path the way the app's mark and display face boil.
 *
 * Same effect as anim/roughen-symbol.py and type-experiment/build_rough_fonts.py,
 * ported to run in the renderer: every point on the outline is offset by smooth
 * pseudo-random noise indexed on distance travelled along the path, so the line
 * wobbles at a consistent wavelength instead of shimmering finely on the curves
 * and coarsely on the straights.
 *
 * Two details carried over from the type build, because icons have the same
 * problem letters do:
 *
 *   - Long segments are cut up before they are perturbed. An icon's straight
 *     edge is two points; move only those and the edge stays perfectly straight,
 *     just slightly tilted.
 *   - Control points are perturbed along with the on-curve points, which is what
 *     keeps the result a set of curves rather than a polygon wearing noise.
 *
 * Everything here is pure and deterministic: the same (path, seed) always gives
 * the same output, so a frame can be regenerated rather than stored.
 */

type Pt = [number, number]

/** Deterministic PRNG — Math.random cannot be seeded, and frames must repeat. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth 1-D noise: three octaves of sine with random phase. */
function noise(seed: number): (t: number) => number {
  const r = seededRandom(seed)
  const terms: Array<[number, number, number]> = [
    [1.0, r() * Math.PI * 2, 1.0],
    [2.3, r() * Math.PI * 2, 0.5],
    [4.7, r() * Math.PI * 2, 0.25],
  ]
  const norm = terms.reduce((s, [, , w]) => s + w, 0)
  return (t) => terms.reduce((s, [f, p, w]) => s + w * Math.sin(f * t + p), 0) / norm
}

/* ---------------------------------------------------------------- parsing --*/

interface Seg {
  /** Everything is normalised to these three: absolute move, cubic, close. */
  op: 'M' | 'C' | 'A' | 'Z'
  pts: Pt[]
  /** Arc flags, preserved verbatim — only an arc's endpoint gets perturbed. */
  arc?: [number, number, number, number, number]
}

function reflect(p: Pt, about: Pt): Pt {
  return [2 * about[0] - p[0], 2 * about[1] - p[1]]
}

/**
 * Parse a `d` string into absolute cubics.
 *
 * Quadratics are elevated to cubics and the shorthand forms resolved, so
 * everything downstream deals with one segment type. Arcs are the exception:
 * converting them to cubics is a lot of code for a case FontAwesome's icons do
 * not use, so they pass through with only their endpoint moved.
 */
export function parsePath(d: string): Seg[] {
  const out: Seg[] = []
  const tokens = d.match(/[astvzqmhlc]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  let i = 0
  let cur: Pt = [0, 0]
  let start: Pt = [0, 0]
  let prevCubicCtl: Pt | null = null
  let prevQuadCtl: Pt | null = null
  let cmd = ''
  const num = () => parseFloat(tokens[i++])
  const pt = (rel: boolean): Pt => {
    const x = num()
    const y = num()
    return rel ? [cur[0] + x, cur[1] + y] : [x, y]
  }
  const quadToCubic = (q: Pt, end: Pt): Pt[] => [
    [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])],
    [end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1])],
    end,
  ]

  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++]
    else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()

    if (C === 'Z') {
      out.push({ op: 'Z', pts: [] })
      cur = start
      prevCubicCtl = prevQuadCtl = null
      continue
    }
    if (C === 'M') {
      cur = pt(rel)
      start = cur
      out.push({ op: 'M', pts: [cur] })
      prevCubicCtl = prevQuadCtl = null
      continue
    }
    if (C === 'L' || C === 'H' || C === 'V') {
      const p: Pt =
        C === 'H' ? [rel ? cur[0] + num() : num(), cur[1]]
        : C === 'V' ? [cur[0], rel ? cur[1] + num() : num()]
        : pt(rel)
      // A line is a cubic with its control points on the line — that way the
      // resampler and the noise only ever handle one kind of segment.
      out.push({ op: 'C', pts: [cur, p, p] })
      cur = p
      prevCubicCtl = prevQuadCtl = null
      continue
    }
    if (C === 'C' || C === 'S') {
      const c1: Pt = C === 'S' ? (prevCubicCtl ? reflect(prevCubicCtl, cur) : cur) : pt(rel)
      const c2 = pt(rel)
      const end = pt(rel)
      out.push({ op: 'C', pts: [c1, c2, end] })
      prevCubicCtl = c2
      prevQuadCtl = null
      cur = end
      continue
    }
    if (C === 'Q' || C === 'T') {
      const q: Pt = C === 'T' ? (prevQuadCtl ? reflect(prevQuadCtl, cur) : cur) : pt(rel)
      const end = pt(rel)
      out.push({ op: 'C', pts: quadToCubic(q, end) })
      prevQuadCtl = q
      prevCubicCtl = null
      cur = end
      continue
    }
    if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), laf = num(), sf = num()
      const end = pt(rel)
      out.push({ op: 'A', pts: [end], arc: [rx, ry, rot, laf, sf] })
      prevCubicCtl = prevQuadCtl = null
      cur = end
      continue
    }
    // Unknown command: stop rather than emit nonsense.
    break
  }
  return out
}

/* ------------------------------------------------------------- resampling --*/

function splitCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): [Pt[], Pt[]] {
  const lerp = (a: Pt, b: Pt): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const a = lerp(p0, c1), b = lerp(c1, c2), c = lerp(c2, p1)
  const d = lerp(a, b), e = lerp(b, c)
  const m = lerp(d, e)
  return [[a, d, m], [e, c, p1]]
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Control-polygon length — an over-estimate of arc length, which is the safe
 *  direction to be wrong in: it splits a shade more finely than needed. */
function cubicLen(p0: Pt, c1: Pt, c2: Pt, p1: Pt): number {
  return dist(p0, c1) + dist(c1, c2) + dist(c2, p1)
}

function resample(segs: Seg[], step: number): Seg[] {
  const out: Seg[] = []
  let cur: Pt = [0, 0]
  for (const seg of segs) {
    if (seg.op !== 'C') {
      out.push(seg)
      if (seg.pts.length) cur = seg.pts[seg.pts.length - 1]
      continue
    }
    let [c1, c2, end] = seg.pts
    const n = Math.max(1, Math.round(cubicLen(cur, c1, c2, end) / step))
    let p0 = cur
    for (let k = 0; k < n - 1; k++) {
      // split off 1/(n-k) of what is left, so the pieces come out even
      const [head, tail] = splitCubic(p0, c1, c2, end, 1 / (n - k))
      out.push({ op: 'C', pts: head })
      p0 = head[2]
      ;[c1, c2, end] = tail
    }
    out.push({ op: 'C', pts: [c1, c2, end] })
    cur = end
  }
  return out
}

/* -------------------------------------------------------------- roughening -*/

const round = (v: number) => Math.round(v * 100) / 100

export interface RoughenOptions {
  /** Wobble depth, in the path's own user units. */
  amp: number
  /** How far along the outline the wobble takes to change its mind. */
  wave: number
  seed: number
}

/**
 * Perturb every point of `d`, returning a new `d`.
 *
 * Returns the input untouched if it cannot be parsed — a mangled icon is a much
 * worse outcome than an icon that simply does not boil.
 */
export function roughenPath(d: string, { amp, wave, seed }: RoughenOptions): string {
  let segs: Seg[]
  try {
    segs = resample(parsePath(d), wave / 3)
  } catch {
    return d
  }
  if (!segs.length) return d

  const fx = noise(seed)
  const fy = noise(seed + 9973)
  let s = 0
  let last: Pt | null = null
  const jog = ([x, y]: Pt): Pt => {
    if (last) s += Math.hypot(x - last[0], y - last[1])
    last = [x, y]
    const t = s / wave
    return [x + amp * fx(t), y + amp * fy(t)]
  }

  const parts: string[] = []
  for (const seg of segs) {
    if (seg.op === 'Z') {
      parts.push('Z')
      // The contour closes back on its own (already perturbed) start point, so
      // the distance counter must not carry the closing run into the next one.
      last = null
      continue
    }
    if (seg.op === 'A') {
      const [rx, ry, rot, laf, sf] = seg.arc!
      const [x, y] = jog(seg.pts[0])
      parts.push(`A${rx} ${ry} ${rot} ${laf} ${sf} ${round(x)} ${round(y)}`)
      continue
    }
    if (seg.op === 'M') {
      const [x, y] = jog(seg.pts[0])
      parts.push(`M${round(x)} ${round(y)}`)
      continue
    }
    const [c1, c2, end] = seg.pts.map(jog)
    parts.push(
      `C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(end[0])} ${round(end[1])}`
    )
  }
  const result = parts.join('')
  // A path that only *partly* parsed produces NaN coordinates, and an SVG path
  // containing NaN renders as nothing at all — the icon would silently vanish.
  return result.includes('NaN') ? d : result
}
