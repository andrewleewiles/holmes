import path from 'path'
import { parseDateToken } from '../shared/timeline'
import type { TimelinePrecision } from '../shared/types'

export interface DateSighting {
  date: string
  precision: TimelinePrecision
  raw: string
}

const DATE_PATTERNS: RegExp[] = [
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/gi,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi,
  // Bare YYYY-MM, but never the leading half of a full YYYY-MM-DD date.
  /(?<![\d-])\d{4}-\d{2}(?![-\d])/g,
]

const YEAR_PATTERN = /\b(19[5-9]\d|20[0-4]\d)\b/g

const MAX_SIGHTINGS = 4000

// Scans free text for every date it states. Used to tell the summarizer what the
// document itself claims about when its contents happened, so it never has to
// fall back to the file's mtime when the content says otherwise.
export function extractContentDates(text: string, maxSightings = MAX_SIGHTINGS): DateSighting[] {
  const sightings: DateSighting[] = []
  const seenSpans = new Set<string>()
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      if (sightings.length >= maxSightings) return sightings
      const raw = match[0]
      const spanKey = `${match.index}:${raw.length}`
      if (seenSpans.has(spanKey)) continue
      seenSpans.add(spanKey)
      const token = parseDateToken(raw)
      if (!token) continue
      sightings.push({
        date: `${String(token.year).padStart(4, '0')}-${String(token.month ?? 1).padStart(2, '0')}-${String(token.day ?? 1).padStart(2, '0')}`,
        precision: token.precision,
        raw,
      })
    }
  }
  return sightings
}

export function extractContentYears(text: string, maxYears = MAX_SIGHTINGS): number[] {
  const years: number[] = []
  YEAR_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = YEAR_PATTERN.exec(text)) !== null) {
    if (years.length >= maxYears) break
    years.push(Number(match[1]))
  }
  return years
}

// Dates embedded in a file or folder name ("2023-04 statement.pdf", "journal_2019.md").
export function datesFromPath(filePath: string): DateSighting[] {
  const name = path.basename(filePath).replace(/[_]+/g, ' ')
  const sightings = extractContentDates(name)
  if (sightings.length > 0) return sightings
  const yearOnly = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(name)
  if (yearOnly) {
    return [{ date: `${yearOnly[1]}-01-01`, precision: 'year', raw: yearOnly[1] }]
  }
  return []
}

function topCounts(values: number[], limit: number): Array<{ value: number; count: number }> {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count) || (a.value - b.value))
    .slice(0, limit)
}

export interface DatingEvidence {
  contentRange: { earliest: string; latest: string } | null
  contentDateCount: number
  dominantYears: Array<{ value: number; count: number }>
  pathDates: DateSighting[]
  modifiedAt: string | null
  createdAt: string | null
}

export function collectDatingEvidence(input: {
  filePath: string
  text: string
  modifiedAtMs?: number | null
  createdAtMs?: number | null
}): DatingEvidence {
  const sightings = extractContentDates(input.text)
  const sorted = sightings.map((s) => s.date).sort()
  const years = sightings.length > 0
    ? sightings.map((s) => Number(s.date.slice(0, 4)))
    : extractContentYears(input.text)

  return {
    contentRange: sorted.length > 0 ? { earliest: sorted[0], latest: sorted[sorted.length - 1] } : null,
    contentDateCount: sightings.length,
    dominantYears: topCounts(years, 5),
    pathDates: datesFromPath(input.filePath),
    modifiedAt: input.modifiedAtMs ? new Date(input.modifiedAtMs).toISOString().slice(0, 10) : null,
    createdAt: input.createdAtMs ? new Date(input.createdAtMs).toISOString().slice(0, 10) : null,
  }
}

// Rendered into the summarization prompt so the model dates its timeline from
// real evidence, in the documented priority order, instead of guessing.
export function formatDatingEvidence(evidence: DatingEvidence): string {
  const lines: string[] = []
  if (evidence.contentRange) {
    lines.push(
      evidence.contentRange.earliest === evidence.contentRange.latest
        ? `- Dates stated inside this document: ${evidence.contentDateCount} mention${evidence.contentDateCount === 1 ? '' : 's'}, all on ${evidence.contentRange.earliest}.`
        : `- Dates stated inside this document: ${evidence.contentDateCount} mentions spanning ${evidence.contentRange.earliest} to ${evidence.contentRange.latest}. These are authoritative — date the timeline from them.`
    )
  } else {
    lines.push('- Dates stated inside this document: none detected in a recognizable format.')
  }
  if (evidence.dominantYears.length > 0) {
    lines.push(`- Years appearing most often in the text: ${evidence.dominantYears.map((y) => `${y.value} (x${y.count})`).join(', ')}.`)
  }
  if (evidence.pathDates.length > 0) {
    lines.push(`- Date in the file name: ${evidence.pathDates.map((d) => d.date).join(', ')} — use only when the content states nothing more precise.`)
  }
  if (evidence.modifiedAt) {
    lines.push(`- File last modified: ${evidence.modifiedAt}. This bounds when the file was last written, not when its contents happened — treat it as a last resort and use year precision for it.`)
  }
  if (evidence.createdAt && evidence.createdAt !== evidence.modifiedAt) {
    lines.push(`- File created: ${evidence.createdAt} (same caveat as the modification time).`)
  }
  return `DATING EVIDENCE for this document (use in this priority order):\n${lines.join('\n')}`
}
