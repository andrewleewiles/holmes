import type { EvidenceBasis } from './types'

/**
 * Where a behavioral claim came from, marked inline in the generated prose.
 *
 * The profile prompts ask for claims about a person — routines, priorities,
 * tendencies, trajectory — and a reader of the finished text cannot tell which
 * of them the person said about themselves, which a device or an export
 * recorded, and which the analyst concluded. All three are legitimate evidence
 * and they are not interchangeable: "oscillates between structured abstinence
 * and compulsive outlets" reads as an established fact when it is a reading of
 * one person's self-report.
 *
 * So every claim carries a marker naming its basis. Unlike the citation tags —
 * which are stripped once their spans are recorded (see `extractClaims`) — these
 * are KEPT in the stored text. The whole point is that a later reader, human or
 * model, sees the boundary at the same moment it sees the claim.
 */
export const EVIDENCE_BASES: EvidenceBasis[] = ['stated', 'recorded', 'inferred']

/**
 * Braces, deliberately: brackets are the citation namespace (`[F1]`, `[L42-58]`)
 * and are stripped before storage, so a marker written in brackets would vanish
 * along with them.
 */
export function evidenceMarker(basis: EvidenceBasis): string {
  return `{${basis}}`
}

export const STATED_MARKER = evidenceMarker('stated')
export const RECORDED_MARKER = evidenceMarker('recorded')
export const INFERRED_MARKER = evidenceMarker('inferred')

/**
 * Words models write instead of the vocabulary. Kept generous: a marker that
 * fails to normalize is worse than no marker, because it survives into the text
 * looking like a marker while every counter and filter ignores it.
 */
const BASIS_ALIASES: Record<string, EvidenceBasis> = {
  stated: 'stated',
  'self-reported': 'stated',
  'self-report': 'stated',
  selfreported: 'stated',
  reported: 'stated',
  'said': 'stated',
  'their-words': 'stated',
  'own-words': 'stated',
  firsthand: 'stated',
  'first-hand': 'stated',
  testimony: 'stated',

  recorded: 'recorded',
  record: 'recorded',
  measured: 'recorded',
  logged: 'recorded',
  observed: 'recorded',
  counted: 'recorded',
  data: 'recorded',
  metric: 'recorded',
  timestamped: 'recorded',

  inferred: 'inferred',
  inference: 'inferred',
  interpreted: 'inferred',
  interpretation: 'inferred',
  read: 'inferred',
  synthesis: 'inferred',
  concluded: 'inferred',
  judgment: 'inferred',
  speculative: 'inferred',
}

export function normalizeEvidenceBasis(raw: string | null | undefined): EvidenceBasis | null {
  const key = (raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z-]/g, '')
  if (!key) return null
  return BASIS_ALIASES[key] ?? null
}

// A single brace group short enough to be a marker rather than prose. Prose in
// these syntheses does not use braces at all, but the length bound keeps an
// unlucky sentence from being rewritten.
const BRACE_GROUP = /\{([A-Za-z][A-Za-z\s_-]{2,24})\}/g

/**
 * Rewrites recognized synonyms to the canonical markers and drops nothing else.
 * An unrecognized brace group is left exactly as written — it is prose, or a
 * marker nobody anticipated, and silently deleting either would be worse.
 */
export function normalizeEvidenceMarkers(text: string): string {
  if (!text) return text
  return text.replace(BRACE_GROUP, (whole, inner: string) => {
    const basis = normalizeEvidenceBasis(inner)
    return basis ? evidenceMarker(basis) : whole
  })
}

const CANONICAL_MARKER = new RegExp(`\\{(?:${EVIDENCE_BASES.join('|')})\\}`, 'g')

/**
 * Removes the markers for a surface that wants clean prose — the SHORT headline,
 * a UI that renders the basis some other way. Collapses the whitespace the
 * removal leaves behind, including before punctuation.
 */
export function stripEvidenceMarkers(text: string): string {
  if (!text) return text
  return text
    .replace(CANONICAL_MARKER, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]+$/gm, '')
}

/** How many claims of each basis the text carries. The mix is the diagnostic. */
export function countEvidenceMarkers(text: string): Record<EvidenceBasis, number> {
  const counts: Record<EvidenceBasis, number> = { stated: 0, recorded: 0, inferred: 0 }
  if (!text) return counts
  CANONICAL_MARKER.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CANONICAL_MARKER.exec(text)) !== null) {
    const basis = normalizeEvidenceBasis(match[0].slice(1, -1))
    if (basis) counts[basis] += 1
  }
  return counts
}

/** True once a context was generated under this contract. */
export function hasEvidenceMarkers(text: string): boolean {
  CANONICAL_MARKER.lastIndex = 0
  return CANONICAL_MARKER.test(text ?? '')
}

/**
 * The contract itself. Shared by every level of the behavioral index so one
 * vocabulary runs from a single file's summary up to the apex profile.
 */
export function evidenceBasisPromptSection(): string {
  return `MARK WHAT EACH CLAIM RESTS ON (required). Every sentence that asserts something about the person ends with one of exactly three markers, placed before the sentence's final punctuation:

- ${STATED_MARKER} — the person said it themselves: their own words in a message, note, journal entry, form, review, caption or conversation. This marker does not weaken the claim. It records that the source is the person's own account of themselves rather than an independent observation of them.
- ${RECORDED_MARKER} — something other than their own account recorded it: a device log, an export, a transaction, a timestamp, a measurement, a file listing, or a count you made yourself over the material.
- ${INFERRED_MARKER} — your own reading. Any pattern, cause, tendency, trait, motive, state or trajectory you concluded rather than read. If the material does not say it in so many words, it is inferred no matter how well supported it is.

Rules: one marker per claim; a sentence rooted in both self-report and record takes ${STATED_MARKER}${RECORDED_MARKER}. Purely structural sentences ("The export covers March to August 2024.") take no marker. Never upgrade an inference to ${STATED_MARKER} or ${RECORDED_MARKER} to make it look firmer — a claim about what someone tends to do, oscillates between, avoids, or is driven by is ${INFERRED_MARKER} even when the evidence behind it is strong, and a self-reported feeling stays ${STATED_MARKER} however plainly it was stated. These markers stay in the stored text; they are what lets a later reader tell your conclusions from the record.`
}

/**
 * The extra rule for the synthesis levels, which read already-marked children
 * rather than raw material. Without it a folder pass silently re-bases every
 * claim it inherits on its own authority.
 */
export function evidenceBasisCarryForwardRule(unit: string): string {
  return `Basis markers at this level: carry each ${unit}'s markers forward unchanged — a claim that arrives ${STATED_MARKER} stays ${STATED_MARKER} when you restate it, and nothing becomes firmer by being repeated in more than one ${unit}. Your own work across ${unit}s — the through-line, the relations between patterns, the tensions, the read on where this is heading — is ${INFERRED_MARKER}, always, including the opening portrait. A ${unit} that carries no markers at all was written before this contract existed: mark what it shows by what it actually is, and where you cannot tell whether something was the person's own account or an independent record, ${INFERRED_MARKER} is the honest marker.`
}
