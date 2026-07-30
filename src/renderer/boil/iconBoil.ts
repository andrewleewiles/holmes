/**
 * Boil every icon drawn in the Holmes turquoise.
 *
 * Same effect as the display face and the mark: ten roughened variants of the
 * shape, cycled at 8fps, so the outline looks redrawn by hand rather than
 * printed. Here the ten variants are generated from the icon's own path data at
 * runtime (see roughenPath.ts) instead of shipped as fonts or sprite strips.
 *
 * Icons are found by their *computed* colour, not by class name. Turquoise
 * arrives three different ways in this app — a `text-holmes-primary` utility on
 * the svg, the same utility on an ancestor with the svg inheriting
 * currentColor, and a literal `style={{ color: '#47a08f' }}` in ProjectIcon —
 * and a class-name scan would quietly miss two of them. Reading the colour that
 * actually got used catches all three, and keeps working if a fourth appears.
 *
 * An svg carrying `data-boil-always` is taken regardless of its colour, for the
 * few icons that are white on a turquoise chip rather than turquoise on the page.
 *
 * The whole thing is one module started once from App: nothing is threaded
 * through the 200-odd call sites that render an icon.
 */
import { roughenPath, seededRandom } from './roughenPath'

/** Wobble depth and wavelength as a fraction of the icon's own viewBox height,
 *  so an icon drawn on a 512 grid and one drawn on a 24 grid boil alike.
 *  Calibrated against FontAwesome's 512-unit icons: much past this the folder
 *  corners melt and the shapes start reading as damaged rather than drawn. */
const AMP_FRACTION = 0.016
const WAVE_FRACTION = 0.22

const FRAMES = 10
const FPS = 8
/** Long enough that the order reads as random rather than as a rotation. */
const SEQUENCE_STEPS = 80
/** Skip anything this size — an illustration is not an icon, and roughening a
 *  path with thousands of segments on every registration is not worth it. */
const MAX_PATH_CHARS = 8000

/**
 * The order the ten variants are shown in.
 *
 * Same rules as type-experiment/make_boil_css.py: every variant used equally
 * often and never twice in a row, because a repeat reads as the animation
 * stalling. Not the identical sequence the CSS uses — these are different
 * shapes, so only the properties matter, not the exact draw.
 */
function boilSequence(): number[] {
  const rand = seededRandom(20260729)
  const seq: number[] = []
  for (let round = 0; round < SEQUENCE_STEPS / FRAMES; round++) {
    const block = [...Array(FRAMES).keys()]
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[block[i], block[j]] = [block[j], block[i]]
    }
    if (seq.length && block[0] === seq[seq.length - 1]) {
      ;[block[0], block[block.length - 1]] = [block[block.length - 1], block[0]]
    }
    seq.push(...block)
  }
  if (seq[0] === seq[seq.length - 1]) {
    ;[seq[seq.length - 1], seq[seq.length - 2]] = [seq[seq.length - 2], seq[seq.length - 1]]
  }
  return seq
}

const SEQUENCE = boilSequence()

/** Variants are keyed on the path and the grid it is drawn on, so the same icon
 *  used in twenty places is roughened once. */
const variantCache = new Map<string, string[]>()

function variantsFor(d: string, viewHeight: number): string[] | null {
  const key = `${viewHeight}|${d}`
  const hit = variantCache.get(key)
  if (hit) return hit
  const amp = viewHeight * AMP_FRACTION
  const wave = viewHeight * WAVE_FRACTION
  const made: string[] = []
  for (let i = 0; i < FRAMES; i++) {
    made.push(roughenPath(d, { amp, wave, seed: 4708 + i * 101 }))
  }
  // Every variant identical to the source means the path did not parse. Cache
  // the null so a path that cannot be roughened is not retried every scan.
  if (made.every((v) => v === d)) {
    variantCache.set(key, [])
    return null
  }
  variantCache.set(key, made)
  return made
}

function rgbOf(colour: string): string | null {
  const nums = colour.match(/[\d.]+/g)
  return nums && nums.length >= 3 ? `${Math.round(+nums[0])},${Math.round(+nums[1])},${Math.round(+nums[2])}` : null
}

/** The turquoises, read from the theme rather than hard-coded, so retuning
 *  --color-holmes-primary retunes what boils. */
function turquoises(): Set<string> {
  const style = getComputedStyle(document.documentElement)
  const out = new Set<string>()
  for (const name of ['--color-holmes-primary', '--color-holmes-primary-light', '--color-holmes-primary-dark']) {
    const raw = style.getPropertyValue(name).trim()
    const hex = /^#([0-9a-f]{6})$/i.exec(raw)
    if (hex) {
      const n = parseInt(hex[1], 16)
      out.add(`${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`)
    } else {
      const rgb = rgbOf(raw)
      if (rgb) out.add(rgb)
    }
  }
  return out
}

interface Boiled {
  path: SVGPathElement
  /** The shape as the component drew it, before any roughening. */
  source: string
  height: number
  variants: string[]
  /** The exact string last written, so a write by anyone else is detectable. */
  painted: string | null
}

export interface IconBoilHandle {
  stop: () => void
  /** Registered paths — for the effect's own tests, not for callers. */
  count: () => number
}

/**
 * Start boiling turquoise icons. Returns a handle that undoes everything.
 *
 * Safe to call once per app; calling it twice would double the tick rate, so
 * App owns the single instance.
 */
export function startIconBoil(): IconBoilHandle {
  let boiled: Boiled[] = []
  let step = 0
  let scanQueued = false

  const colours = turquoises()

  const scan = () => {
    scanQueued = false
    const found: Boiled[] = []
    const seen = new Set<SVGPathElement>()
    for (const svg of document.querySelectorAll('svg')) {
      const height = svg.viewBox?.baseVal?.height
      if (!height) continue
      // Turquoise is how an icon normally asks to boil, but an icon drawn in
      // white *on* turquoise — the composer's Send arrow — wants the same
      // treatment and can never pass a colour test. Those opt in by attribute.
      if (!svg.hasAttribute('data-boil-always')) {
        const rgb = rgbOf(getComputedStyle(svg).color)
        if (!rgb || !colours.has(rgb)) continue
      }
      for (const path of svg.querySelectorAll('path')) {
        if (seen.has(path)) continue
        // The live `d` is whatever frame is showing, so the source has to be
        // stashed the first time we meet the element and read from there after.
        const source = path.dataset.boilSource ?? path.getAttribute('d')
        if (!source || source.length > MAX_PATH_CHARS) continue
        const variants = variantsFor(source, height)
        if (!variants) continue
        path.dataset.boilSource = source
        seen.add(path)
        const existing = boiled.find((b) => b.path === path)
        found.push(existing ?? { path, source, height, variants, painted: null })
      }
    }
    boiled = found
  }

  // Debounced well past a frame: a streaming reply mutates the DOM continuously,
  // and a scan per burst is plenty to catch an icon that has just appeared.
  const queueScan = () => {
    if (scanQueued) return
    scanQueued = true
    setTimeout(scan, 500)
  }

  const frozen = () =>
    document.documentElement.getAttribute('data-boil') === 'off' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const paint = (index: number) => {
    for (let i = boiled.length - 1; i >= 0; i--) {
      const entry = boiled[i]
      const { path } = entry
      if (!path.isConnected) {
        boiled.splice(i, 1)
        continue
      }
      // If the attribute is not the frame we last wrote, the component has
      // drawn something else into it. Usually that is a re-render of the same
      // icon and the shape is unchanged, but it is also how an icon that swaps
      // in place — play to pause, a spinner to a tick — announces itself. Take
      // whatever is there as the new source, or we would repaint the old glyph
      // over the new one eight times a second, forever.
      const live = path.getAttribute('d')
      if (live && entry.painted !== null && live !== entry.painted && live !== entry.source) {
        const fresh = variantsFor(live, entry.height)
        if (!fresh) {
          boiled.splice(i, 1)
          delete path.dataset.boilSource
          continue
        }
        entry.source = live
        entry.variants = fresh
        path.dataset.boilSource = live
      }
      entry.painted = entry.variants[index]
      path.setAttribute('d', entry.painted)
    }
  }

  const tick = () => {
    if (document.hidden) return
    if (frozen()) {
      // Hold one frame: the icon keeps the hand-drawn line and loses only the
      // movement, which is what index.css does for the display face.
      paint(0)
      return
    }
    step = (step + 1) % SEQUENCE.length
    paint(SEQUENCE[step])
    // An icon can turn turquoise without the DOM changing at all — a :hover
    // rule, a theme tweak — so sweep once per cycle as well as on mutation.
    if (step === 0) queueScan()
  }

  scan()
  paint(frozen() ? 0 : SEQUENCE[0])
  const timer = window.setInterval(tick, 1000 / FPS)

  // Only class and style are watched, so the `d` attribute this module writes
  // eight times a second never feeds back in as a reason to rescan.
  const observer = new MutationObserver(queueScan)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  })

  const onBoilSetting = new MutationObserver(() => paint(frozen() ? 0 : SEQUENCE[step]))
  onBoilSetting.observe(document.documentElement, { attributes: true, attributeFilter: ['data-boil'] })

  return {
    stop: () => {
      window.clearInterval(timer)
      observer.disconnect()
      onBoilSetting.disconnect()
      // Put every icon back the way it was drawn.
      for (const { path } of boiled) {
        const source = path.dataset.boilSource
        if (source && path.isConnected) path.setAttribute('d', source)
        delete path.dataset.boilSource
      }
      boiled = []
    },
    count: () => boiled.length,
  }
}
