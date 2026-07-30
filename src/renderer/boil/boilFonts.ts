/**
 * Wait for the boiling display face to be in before anything is shown in it.
 *
 * The face is ten woff2 files cycled at 8fps by the `holmes-boil` keyframes, all
 * declared `font-display: swap`. A browser only fetches a web font when a frame
 * that needs it is painted, so on a cold start the wordmark is set in whatever
 * the fallback stack gives it (EB Garamond, itself still loading, then Palatino)
 * and each keyframe swaps to its own face the moment that file lands. The boil
 * faces carry Minion's advance widths and the fallbacks do not, so for the first
 * second the line re-sets on almost every frame — which is the jump.
 *
 * Nothing here is a timeout: `document.fonts.load()` is the real load signal for
 * each face, and this module simply asks for all eleven up front — at startup,
 * rather than as the animation stumbles into them — and marks the document when
 * they have all settled. index.css does the rest:
 *
 *   - `.font-serif-display` holds one face until the attribute is set, so the
 *     animation cannot flip between a loaded face and a fallback.
 *   - `.boil-reveal` keeps display text hidden until then, for the places (the
 *     home-screen wordmark) where even one swap is visible.
 */

/** The ten redrawn faces, matching the @font-face families in index.css. */
export const BOIL_FAMILIES = Array.from({ length: 10 }, (_, i) => `HolmesBoil${i}`)

/** Each boil face covers A-Z a-z 0-9 and common punctuation only; everything
 *  else falls through to EB Garamond, so that is part of "the face is in" too. */
const FALLBACK_FAMILY = 'EB Garamond'

/** Set on <html> once every face has settled. index.css keys off it. */
const READY_ATTR = 'data-boil-fonts'

/** Any size loads the same file — these are not variable fonts. */
const PROBE_PX = 38
/** Latin letters, which is all the wordmark and the greeting need. */
const PROBE_TEXT = 'Holmes'

/**
 * How long to wait for the @font-face rules themselves to be registered. Not a
 * wait on the network: `document.fonts.load()` for a family the document has
 * never heard of resolves immediately having loaded nothing, which would open
 * the gate on exactly the jitter it exists to prevent. In dev the stylesheet is
 * injected by the CSS import in main.tsx and in a build it is a <link> parsed
 * before the module script runs, so this normally passes on the first check;
 * the cap only stops a renamed family from hiding the wordmark forever.
 */
const MAX_REGISTRATION_FRAMES = 120

let pending: Promise<void> | null = null

/**
 * Resolves once the display face is loaded (or has failed) and <html> carries
 * the ready attribute. Memoised: call it from anywhere, as often as you like.
 */
export function boilFontsReady(): Promise<void> {
  pending ??= load()
  return pending
}

/** True once {@link boilFontsReady} has finished — for a synchronous check. */
export function areBoilFontsReady(): boolean {
  return document.documentElement.getAttribute(READY_ATTR) === 'ready'
}

async function load(): Promise<void> {
  const fonts = document.fonts
  // No FontFaceSet means no way to ask, so nothing may stay hidden waiting.
  if (!fonts) {
    markReady()
    return
  }
  await waitForRegistration(fonts)
  // Settled, not all-successful: a face that 404s must not hold the gate shut.
  await Promise.all(
    [...BOIL_FAMILIES, FALLBACK_FAMILY].map((family) =>
      fonts.load(`${PROBE_PX}px "${family}"`, PROBE_TEXT).catch(() => [])
    )
  )
  markReady()
}

function markReady(): void {
  document.documentElement.setAttribute(READY_ATTR, 'ready')
}

function familiesInSet(fonts: FontFaceSet): Set<string> {
  const present = new Set<string>()
  fonts.forEach((face) => present.add(face.family.replace(/^['"]|['"]$/g, '')))
  return present
}

async function waitForRegistration(fonts: FontFaceSet): Promise<void> {
  for (let frame = 0; frame < MAX_REGISTRATION_FRAMES; frame++) {
    const present = familiesInSet(fonts)
    if (BOIL_FAMILIES.every((family) => present.has(family))) return
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}
