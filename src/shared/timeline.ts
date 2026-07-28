import type {
  AnalysisTimelineEntry,
  ParsedTimelineEntry,
  TimelineCategory,
  TimelineEvent,
  TimelinePrecision,
} from './types'

export const TIMELINE_BLOCK_HEADING = 'TIMELINE:'

export const TIMELINE_CATEGORIES: TimelineCategory[] = [
  'milestone',
  'health',
  'training',
  'work',
  'education',
  'finance',
  'travel',
  'relationships',
  'media',
  'technology',
  'home',
  'life',
  'other',
]

// `record` is deliberately absent from TIMELINE_CATEGORIES: it is never offered
// to a model. It marks the timeline's account of itself — when a context was
// generated or superseded — and is filtered out of chat context.
export const TIMELINE_ALL_CATEGORIES: TimelineCategory[] = [...TIMELINE_CATEGORIES, 'record']

const CATEGORY_ALIASES: Record<string, TimelineCategory> = {
  fitness: 'training',
  exercise: 'training',
  workout: 'training',
  gym: 'training',
  nutrition: 'health',
  medical: 'health',
  clinical: 'health',
  career: 'work',
  job: 'work',
  employment: 'work',
  school: 'education',
  study: 'education',
  learning: 'education',
  money: 'finance',
  finances: 'finance',
  financial: 'finance',
  spending: 'finance',
  purchase: 'finance',
  subscription: 'finance',
  trip: 'travel',
  location: 'travel',
  move: 'home',
  moving: 'home',
  housing: 'home',
  household: 'home',
  family: 'relationships',
  social: 'relationships',
  friends: 'relationships',
  relationship: 'relationships',
  entertainment: 'media',
  reading: 'media',
  watching: 'media',
  music: 'media',
  tech: 'technology',
  software: 'technology',
  device: 'technology',
  achievement: 'milestone',
  event: 'milestone',
  personal: 'life',
  general: 'life',
}

const PRECISION_RANK: Record<TimelinePrecision, number> = { day: 0, month: 1, year: 2 }

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

const MIN_YEAR = 1900
const MAX_YEAR = 2100

const OPEN_ENDED_TOKENS = new Set(['present', 'now', 'ongoing', 'current', 'today', 'continuing'])
const NULL_TOKENS = new Set(['none', 'unknown', 'n/a', 'na', 'undated', 'tbd', '-', '—', '?'])

export function normalizeTimelineCategory(raw: string | null | undefined): TimelineCategory {
  const key = (raw ?? '').trim().toLowerCase().replace(/[^a-z]/g, '')
  if (!key) return 'life'
  if ((TIMELINE_ALL_CATEGORIES as string[]).includes(key)) return key as TimelineCategory
  return CATEGORY_ALIASES[key] ?? 'other'
}

export function normalizeTimelinePrecision(raw: string | null | undefined): TimelinePrecision | null {
  const key = (raw ?? '').trim().toLowerCase()
  if (key.startsWith('day') || key === 'exact' || key === 'd') return 'day'
  if (key.startsWith('month') || key === 'm') return 'month'
  if (key.startsWith('year') || key === 'y' || key.startsWith('approx') || key.startsWith('decade')) return 'year'
  return null
}

// The coarser (less precise) of two precisions wins: a stated precision may only
// widen what the literal date implies, never sharpen it.
export function coarsestPrecision(a: TimelinePrecision, b: TimelinePrecision): TimelinePrecision {
  return PRECISION_RANK[a] >= PRECISION_RANK[b] ? a : b
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isValidYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR
}

export interface ParsedDateToken {
  year: number
  month: number | null
  day: number | null
  precision: TimelinePrecision
}

// Parses one date token in any of the forms the models are asked to emit
// (and the common forms they emit anyway). Returns null when the token
// carries no usable date.
export function parseDateToken(raw: string): ParsedDateToken | null {
  const text = raw.trim().replace(/^[[(]+|[\])]+$/g, '').trim()
  if (!text) return null
  const lower = text.toLowerCase()
  if (NULL_TOKENS.has(lower) || OPEN_ENDED_TOKENS.has(lower)) return null

  // Qualifiers ("early 2019", "circa 2019", "mid-2019") only ever yield year precision.
  const qualified = /^(early|mid|late|circa|around|about|approx\.?|approximately|c\.)[\s-]+(.*)$/i.exec(text)
  if (qualified) {
    const inner = parseDateToken(qualified[2])
    if (!inner) return null
    return { year: inner.year, month: null, day: null, precision: 'year' }
  }

  // Decade: 1990s / 2010s
  const decade = /^(\d{4})'?s$/.exec(text)
  if (decade) {
    const year = Number(decade[1])
    return isValidYear(year) ? { year, month: null, day: null, precision: 'year' } : null
  }

  // ISO-ish: YYYY-MM-DD, YYYY/MM/DD, YYYY-MM, YYYY
  const iso = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/.exec(text)
  if (iso) {
    const year = Number(iso[1])
    if (!isValidYear(year)) return null
    const month = iso[2] !== undefined ? Number(iso[2]) : null
    const day = iso[3] !== undefined ? Number(iso[3]) : null
    if (month !== null && (month < 1 || month > 12)) return null
    if (day !== null && (month === null || day < 1 || day > daysInMonth(year, month))) return null
    if (day !== null) return { year, month, day, precision: 'day' }
    if (month !== null) return { year, month, day: null, precision: 'month' }
    return { year, month: null, day: null, precision: 'year' }
  }

  // US-style numeric: MM/DD/YYYY (falls back to DD/MM/YYYY when the first part cannot be a month)
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text)
  if (numeric) {
    const year = Number(numeric[3])
    if (!isValidYear(year)) return null
    let month = Number(numeric[1])
    let day = Number(numeric[2])
    if (month > 12) {
      const swap = month
      month = day
      day = swap
    }
    if (month < 1 || month > 12) return null
    if (day < 1 || day > daysInMonth(year, month)) return null
    return { year, month, day, precision: 'day' }
  }

  // Month name forms: "March 2024", "March 15, 2024", "15 March 2024", "Mar-2024"
  const monthFirst = /^([A-Za-z]{3,9})\.?[\s,-]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})$/.exec(text)
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1].toLowerCase()]
    const year = Number(monthFirst[3])
    const day = Number(monthFirst[2])
    if (month && isValidYear(year) && day >= 1 && day <= daysInMonth(year, month)) {
      return { year, month, day, precision: 'day' }
    }
    return null
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?[\s,-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/.exec(text)
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2].toLowerCase()]
    const year = Number(dayFirst[3])
    const day = Number(dayFirst[1])
    if (month && isValidYear(year) && day >= 1 && day <= daysInMonth(year, month)) {
      return { year, month, day, precision: 'day' }
    }
    return null
  }

  const monthYear = /^([A-Za-z]{3,9})\.?[\s,-]+(\d{4})$/.exec(text)
  if (monthYear) {
    const month = MONTH_NAMES[monthYear[1].toLowerCase()]
    const year = Number(monthYear[2])
    if (month && isValidYear(year)) return { year, month, day: null, precision: 'month' }
    return null
  }

  // Quarters: Q3 2021 / 2021 Q3
  const quarter = /^(?:q([1-4])\s*(\d{4})|(\d{4})\s*q([1-4]))$/i.exec(text)
  if (quarter) {
    const q = Number(quarter[1] ?? quarter[4])
    const year = Number(quarter[2] ?? quarter[3])
    if (isValidYear(year)) return { year, month: (q - 1) * 3 + 1, day: null, precision: 'month' }
    return null
  }

  return null
}

function startOfToken(token: ParsedDateToken): string {
  return `${pad(token.year, 4)}-${pad(token.month ?? 1, 2)}-${pad(token.day ?? 1, 2)}`
}

function endOfToken(token: ParsedDateToken): string {
  if (token.month === null) return `${pad(token.year, 4)}-12-31`
  if (token.day === null) return `${pad(token.year, 4)}-${pad(token.month, 2)}-${pad(daysInMonth(token.year, token.month), 2)}`
  return `${pad(token.year, 4)}-${pad(token.month, 2)}-${pad(token.day, 2)}`
}

// The last day the entry could refer to, given how precisely it is dated:
// a year-precision entry dated 2019-01-01 covers all of 2019.
export function periodEnd(startDate: string, precision: TimelinePrecision): string {
  const year = Number(startDate.slice(0, 4))
  if (!Number.isFinite(year)) return startDate
  if (precision === 'year') return `${pad(year, 4)}-12-31`
  if (precision === 'month') {
    const month = Number(startDate.slice(5, 7)) || 1
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(daysInMonth(year, month), 2)}`
  }
  return startDate
}

export function precisionRank(precision: TimelinePrecision): number {
  return PRECISION_RANK[precision]
}

const RANGE_SEPARATOR = /\s*(?:\.{2,}|–|—|→|->|=>|\bto\b|\bthrough\b|\buntil\b)\s*/i

export interface ParsedDateSpec {
  startDate: string
  endDate: string | null
  precision: TimelinePrecision
}

// Parses a date specification: a single date, or a range written with any of the
// separators the models use. Dates are canonicalized to YYYY-MM-DD; `precision`
// records how precisely the source actually pinned the entry down.
export function parseDateSpec(raw: string): ParsedDateSpec | null {
  const text = raw.trim()
  if (!text) return null

  let parts = text.split(RANGE_SEPARATOR).map((part) => part.trim()).filter(Boolean)
  if (parts.length === 1 && /\s-\s/.test(text)) {
    parts = text.split(/\s-\s/).map((part) => part.trim()).filter(Boolean)
  }

  if (parts.length >= 2) {
    const start = parseDateToken(parts[0])
    if (!start) return null
    const endToken = parseDateToken(parts[1])
    // "2019 to present", or an unparseable end: keep the real start, leave the span open.
    if (!endToken) {
      return { startDate: startOfToken(start), endDate: null, precision: start.precision }
    }
    const endDate = endOfToken(endToken)
    const startDate = startOfToken(start)
    if (endDate < startDate) return { startDate, endDate: null, precision: start.precision }
    return {
      startDate,
      endDate,
      precision: coarsestPrecision(start.precision, endToken.precision),
    }
  }

  const single = parseDateToken(parts[0] ?? text)
  if (!single) return null
  return { startDate: startOfToken(single), endDate: null, precision: single.precision }
}

function cleanCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
}

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•+]|\d+[.)])\s*/, '').trim()
}

const MAX_TITLE_CHARS = 200
const MAX_DETAIL_CHARS = 600

// Precision and category cells are single lowercase words; a title or detail is
// a phrase. Used only when the model omitted one of the middle cells.
function looksLikeBareWord(cell: string): boolean {
  return /^[a-z][a-z-]{0,19}$/.test(cell)
}

// Parses one "date | precision | category | title | detail" line. Tolerant of
// missing middle fields: models drop the precision or category cell often enough
// that a strict parser would silently lose real dated facts.
export function parseTimelineLine(line: string): ParsedTimelineEntry | null {
  const body = stripBullet(line)
  if (!body) return null
  if (NULL_TOKENS.has(body.toLowerCase())) return null

  const cells = body.split('|').map(cleanCell)
  if (cells.length === 0) return null

  const spec = parseDateSpec(cells[0])
  if (!spec) return null

  const rest = cells.slice(1).filter((cell) => cell.length > 0)
  let statedPrecision: TimelinePrecision | null = null
  let category: TimelineCategory | null = null
  let title = ''
  let detail = ''

  // With every cell present the mapping is positional. When the model drops the
  // precision or category cell, fall back to recognizing them by shape: both are
  // single lowercase words, while titles and details are phrases.
  if (rest.length >= 4) {
    statedPrecision = normalizeTimelinePrecision(rest[0])
    category = normalizeTimelineCategory(rest[1])
    title = rest[2]
    detail = rest.slice(3).join(' — ')
  } else {
    let index = 0
    if (index < rest.length && looksLikeBareWord(rest[index])) {
      const precision = normalizeTimelinePrecision(rest[index])
      if (precision) {
        statedPrecision = precision
        index += 1
      }
    }
    if (index < rest.length - 1 && looksLikeBareWord(rest[index])) {
      category = normalizeTimelineCategory(rest[index])
      index += 1
    }
    if (index < rest.length) {
      title = rest[index]
      index += 1
    }
    if (index < rest.length) {
      detail = rest.slice(index).join(' — ')
    }
  }

  if (!title) {
    // A dated line with no title carries no fact worth recording.
    if (!detail) return null
    title = detail
    detail = ''
  }

  return {
    startDate: spec.startDate,
    endDate: spec.endDate,
    precision: statedPrecision ? coarsestPrecision(spec.precision, statedPrecision) : spec.precision,
    category: category ?? normalizeTimelineCategory(null),
    title: title.slice(0, MAX_TITLE_CHARS),
    detail: detail.slice(0, MAX_DETAIL_CHARS),
  }
}

const TIMELINE_HEADING_LINE = /^\s*(?:#{1,4}\s*)?\**\s*TIMELINE\s*\**\s*:?\s*$/i

/** Whether one line opens a TIMELINE block, in any of the forms models emit. */
export function isTimelineHeadingLine(line: string): boolean {
  return TIMELINE_HEADING_LINE.test(line)
}

// The contract puts the block last, so the final heading wins: a synthesis that
// mentions the word earlier in its prose does not truncate the real block.
function findTimelineHeadingLine(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (TIMELINE_HEADING_LINE.test(lines[index])) return index
  }
  return -1
}

// Extracts the trailing TIMELINE: block from a generated context and parses it.
// Returns [] when the text has no timeline block or none of its lines are datable.
export function parseTimelineBlock(text: string): ParsedTimelineEntry[] {
  if (!text) return []
  const lines = text.split('\n')
  const headingIndex = findTimelineHeadingLine(lines)
  if (headingIndex === -1) return []

  const entries: ParsedTimelineEntry[] = []
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    // A new heading ends the block.
    if (/^#{1,4}\s/.test(trimmed) || /^[A-Z][A-Z \t]{3,}:$/.test(trimmed)) break
    const entry = parseTimelineLine(trimmed)
    if (entry) entries.push(entry)
  }
  return entries
}

// The generated prose keeps its timeline block; this strips it for UI surfaces
// that render the timeline separately.
export function stripTimelineBlock(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const headingIndex = findTimelineHeadingLine(lines)
  if (headingIndex === -1) return text
  return lines.slice(0, headingIndex).join('\n').trimEnd()
}

// The other half of `stripTimelineBlock`: the block itself, heading included,
// for a caller that renders the prose and the dated record to different places.
export function extractTimelineBlock(text: string): string {
  if (!text) return ''
  const lines = text.split('\n')
  const headingIndex = findTimelineHeadingLine(lines)
  if (headingIndex === -1) return ''
  const block: string[] = [lines[headingIndex].trim()]
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    if (/^#{1,4}\s/.test(trimmed) || /^[A-Z][A-Z \t]{3,}:$/.test(trimmed)) break
    block.push(trimmed)
  }
  return block.length > 1 ? block.join('\n') : ''
}

export function timelineTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|a|an|of|to|in|on|at|for|with|and|his|her|their|user|s)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

// Two entries describing the same fact from different sources (a file context and
// the folder synthesis above it) must collapse to one row.
export function timelineDedupeKey(entry: { startDate: string; title: string }): string {
  return `${entry.startDate}|${timelineTitleKey(entry.title)}`
}

export function compareTimelineEvents(
  a: { startDate: string; endDate?: string | null; title: string },
  b: { startDate: string; endDate?: string | null; title: string }
): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1
  const aEnd = a.endDate ?? ''
  const bEnd = b.endDate ?? ''
  if (aEnd !== bEnd) return aEnd < bEnd ? -1 : 1
  return a.title.localeCompare(b.title)
}

export function timelineYear(event: { startDate: string }): number {
  return Number(event.startDate.slice(0, 4))
}

export function groupTimelineByYear<T extends { startDate: string }>(events: T[]): Array<{ year: number; events: T[] }> {
  const byYear = new Map<number, T[]>()
  for (const event of events) {
    const year = timelineYear(event)
    if (!Number.isFinite(year)) continue
    const list = byYear.get(year) ?? []
    list.push(event)
    byYear.set(year, list)
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, list]) => ({ year, events: list }))
}

const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function formatTimelineDate(date: string, precision: TimelinePrecision): string {
  const year = date.slice(0, 4)
  if (precision === 'year') return year
  const month = Number(date.slice(5, 7))
  const monthLabel = MONTH_LABELS[month - 1] ?? ''
  if (precision === 'month') return `${monthLabel} ${year}`
  return `${monthLabel} ${Number(date.slice(8, 10))}, ${year}`
}

export function formatTimelineRange(event: {
  startDate: string
  endDate: string | null
  precision: TimelinePrecision
}): string {
  const start = formatTimelineDate(event.startDate, event.precision)
  if (!event.endDate) return start
  const end = formatTimelineDate(event.endDate, event.precision)
  return start === end ? start : `${start} – ${end}`
}

export function renderTimelineLine(event: TimelineEvent): string {
  const range = event.endDate && event.endDate !== event.startDate
    ? `${event.startDate}..${event.endDate}`
    : event.startDate
  const detail = event.detail ? ` — ${event.detail}` : ''
  return `- ${range} | ${event.precision} | ${event.category} | ${event.title}${detail} [${event.sourceLabel}]`
}

// One line per event, compact enough to hand back to a model as context.
export function renderTimelineForPrompt(events: TimelineEvent[], maxChars: number): string {
  const lines: string[] = []
  let used = 0
  for (const event of events) {
    const line = renderTimelineLine(event)
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/**
 * The cache key for one year's super-context: the exact lines that would be fed
 * to the model. Anything that would change the synthesis changes the key, and
 * nothing else does — so a rebuild that only adds events to 2026 regenerates
 * 2026 alone.
 */
export function yearEventsFingerprint(events: TimelineEvent[]): string {
  return events
    .map(renderTimelineLine)
    .sort()
    .join('\n')
}

// Structured analyses (health, activity, finances) carry their timeline as JSON
// rather than a text block; this validates whatever the model produced.
export function coerceAnalysisTimeline(value: unknown): AnalysisTimelineEntry[] {
  if (!Array.isArray(value)) return []
  const entries: AnalysisTimelineEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const date = typeof record.date === 'string' ? record.date.trim() : ''
    if (!title || !date) continue
    if (!parseDateSpec(date)) continue
    const entry: AnalysisTimelineEntry = { date, title: title.slice(0, MAX_TITLE_CHARS) }
    if (typeof record.endDate === 'string' && parseDateSpec(record.endDate)) entry.endDate = record.endDate.trim()
    const precision = normalizeTimelinePrecision(typeof record.precision === 'string' ? record.precision : null)
    if (precision) entry.precision = precision
    if (typeof record.category === 'string' && record.category.trim()) entry.category = record.category.trim()
    if (typeof record.detail === 'string' && record.detail.trim()) entry.detail = record.detail.trim().slice(0, MAX_DETAIL_CHARS)
    entries.push(entry)
  }
  return entries
}

export function analysisTimelineToEntries(entries: AnalysisTimelineEntry[] | undefined): ParsedTimelineEntry[] {
  if (!entries) return []
  const parsed: ParsedTimelineEntry[] = []
  for (const entry of entries) {
    const spec = parseDateSpec(entry.endDate ? `${entry.date}..${entry.endDate}` : entry.date)
    if (!spec) continue
    const stated = normalizeTimelinePrecision(entry.precision ?? null)
    parsed.push({
      startDate: spec.startDate,
      endDate: spec.endDate,
      precision: stated ? coarsestPrecision(spec.precision, stated) : spec.precision,
      category: normalizeTimelineCategory(entry.category ?? null),
      title: entry.title.slice(0, MAX_TITLE_CHARS),
      detail: (entry.detail ?? '').slice(0, MAX_DETAIL_CHARS),
    })
  }
  return parsed
}

// The JSON field the structured-analysis prompts declare, and the rule text that
// keeps its dating as honest as the text-block contract.
export const ANALYSIS_TIMELINE_JSON_FIELD = `  "timeline": [
    {
      "date": "<ISO date at the finest precision the evidence supports: YYYY-MM-DD, YYYY-MM, or YYYY>",
      "endDate": "<optional ISO date, same forms, when the entry spans a period>",
      "precision": "<day|month|year — how precisely the evidence pins this down>",
      "category": "<${TIMELINE_CATEGORIES.join('|')}>",
      "title": "<short factual statement of what happened or changed>",
      "detail": "<one sentence naming the evidence that dates it>"
    }
  ],`

export function analysisTimelinePromptRule(maxEntries: number): string {
  return `- "timeline" is the dated chronology behind this analysis, oldest first, at most ${maxEntries} entries. Dating priority: a date stated in the data itself, then a date in the source or file name, then the ingestion or modification time (which only bounds when the data was recorded — use year precision for it). Never state a precision the evidence does not support and never invent a date to fill the field: if a significant fact cannot be dated, leave it out of the timeline and keep it in the prose. Use an empty array when nothing can be dated.`
}

// The dating + timeline contract every generated context must follow. Shared so
// the file, folder, user, health, activity, finances and memory prompts all emit
// a block the same parser can read.
export function timelinePromptSection(maxEntries: number): string {
  return `TIMELINE (required):
After the prose, output a final section whose first line is exactly "${TIMELINE_BLOCK_HEADING}" and which then contains one line per dated fact, oldest first, in this exact pipe-delimited format:

- <date> | <precision> | <category> | <title> | <detail>

- <date>: an ISO date at the finest precision the evidence actually supports — YYYY-MM-DD, YYYY-MM, or YYYY. For something spanning a period, write <start>..<end> using those same forms (an open-ended span may end in "present").
- <precision>: day, month, or year — how precisely the evidence pins this down. Never state a precision the evidence does not support.
- <category>: one of ${TIMELINE_CATEGORIES.join(', ')}.
- <title>: a short factual statement of what happened or changed (under ~90 characters).
- <detail>: one sentence naming the evidence that dates it.

Dating rules, in priority order: (1) a date stated inside the data itself always wins; (2) then a date embedded in the file or source name; (3) then the file's modification time — which only bounds when the data was last written, so use year precision for it unless the content agrees. Convert relative references ("last summer", "three years ago") to absolute dates ONLY when the material fixes the reference point; otherwise fall back to the coarser precision. Never invent or guess a date to fill the field: if a significant fact cannot be dated, leave it out of the timeline and keep it in the prose. Emit at most ${maxEntries} entries, chosen for significance. If nothing in the material can be dated, output "${TIMELINE_BLOCK_HEADING}" followed by a single line reading "- none".`
}
