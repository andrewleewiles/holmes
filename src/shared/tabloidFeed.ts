// The Tabloid feed contract: parsing, validation and the pure arithmetic the
// pipeline runs on.
//
// Import-free leaf (type-only imports are stripped at runtime), so
// `test-tabloid.mjs` can drive the parsers without the bootstrap loader. Landmine
// 9 applies: do not give this file a runtime import.

import type {
  TabloidFlag,
  TabloidFlagKind,
  TabloidFlagSeverity,
  TabloidIntent,
  TabloidItemKind,
  TabloidRetrieverId,
  TabloidSourceRef,
} from './types'

/**
 * One retrieval result, before the curator has ranked it. `candidateId` is
 * assigned by the retriever and is the ONLY handle the curator is given: a pick
 * naming anything else was invented and is dropped.
 */
export interface TabloidCandidate {
  candidateId: string
  kind: TabloidItemKind
  provider: TabloidRetrieverId
  externalId: string
  url: string
  title: string
  creator: string | null
  description: string | null
  publishedAt: string | null
  durationSeconds: number | null
  thumbnailUrl: string | null
  embeddable: boolean
  viewCount: number | null
  /** Every intent that surfaced this candidate — the same video can answer two. */
  intentIds: string[]
}

/** One accepted pick from the curator, before it is joined to its candidate. */
export interface TabloidCuratorPick {
  candidateId: string
  intentIds: string[]
  rationale: string
  /** A `preferences` field key a thumbs-up should land in, or null for none. */
  memoryFieldKey: string | null
  memoryValue: string | null
}

/** One line of transcript with the second it is spoken at. */
export interface TranscriptCue {
  start: number
  end: number
  text: string
}

export type TabloidYoutubeErrorKind = 'key-invalid' | 'quota' | 'not-configured' | 'transient' | 'unknown'

export interface TabloidYoutubeError {
  kind: TabloidYoutubeErrorKind
  message: string
}

/** One line on a card; longer than this wraps and breaks the grid rhythm. */
export const MAX_RATIONALE_CHARS = 120
/** A query a person would actually type, not a paragraph. */
export const MAX_QUERY_CHARS = 120
/** The value written into a memory list field — a creator name, not a title. */
export const MAX_MEMORY_VALUE_CHARS = 60

/**
 * Identity for an item across refreshes. The seen-set, the suppression list and
 * the upsert all key on this, so it must not include anything that changes
 * between runs (rank, rationale, the intent that happened to surface it).
 */
export function tabloidItemKey(kind: string, provider: string, externalId: string): string {
  return `${kind}|${provider}|${externalId}`
}

/**
 * ISO-8601 duration to seconds. `videos.list` reports `PT14M32S`; the `search`
 * endpoint reports no duration at all, which is why the second call exists.
 *
 * Returns null rather than 0 for junk: a video of unknown length must render as
 * unknown, not as an instant.
 */
export function youtubeDurationToSeconds(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().toUpperCase()
  // `M` means months before the T and minutes after it, so the two halves are
  // matched separately rather than by one repeated group.
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    text
  )
  if (!match) return null
  const [, years, months, weeks, days, hours, minutes, seconds] = match
  // Bare `P` or `PT` parses but carries no duration.
  if (!years && !months && !weeks && !days && !hours && !minutes && !seconds) return null
  // Years and months have no fixed length; YouTube never emits them, and
  // guessing 365/30 would quietly fabricate a number.
  if (years || months) return null
  const total =
    Number(weeks ?? 0) * 604800 +
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  if (!Number.isFinite(total)) return null
  return Math.round(total)
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * `search.list` HTML-escapes every title, so a channel called "Tom & Jerry"
 * arrives as `Tom &amp; Jerry` and would be rendered literally.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return HTML_ENTITIES[key] ?? whole
  })
}

/**
 * The JSON the prompt asked for, wherever it ended up. Models that think out
 * loud put it after the reasoning, some wrap it in a fence, and providers other
 * than OpenRouter ignore `response_format` entirely — so every reply is
 * salvaged rather than trusted.
 *
 * Candidates are tried newest-first because a brace inside the reasoning text
 * is always earlier than the real answer.
 */
export function salvageJsonObject(raw: string, key: string): unknown | null {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const end = withoutThinking.lastIndexOf('}')
  if (end < 0) return null

  // The key is not necessarily the FIRST in its object — {"summary":…,"flags":…}
  // is a perfectly good reply — so the opening brace is found by walking back
  // from the key rather than by requiring the object to start with it.
  const keyPositions = [...withoutThinking.matchAll(new RegExp(`"${key}"\\s*:`, 'g'))]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0)
    .reverse()

  const candidates: number[] = []
  for (const position of keyPositions) {
    // A couple of enclosing braces back, in case the nearest one opens a nested
    // object rather than the reply itself.
    let cursor = position
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const open = withoutThinking.lastIndexOf('{', cursor)
      if (open < 0) break
      if (!candidates.includes(open)) candidates.push(open)
      cursor = open - 1
    }
  }

  for (const start of candidates) {
    try {
      return JSON.parse(withoutThinking.slice(start, end + 1))
    } catch {
      // A brace inside the model's own prose. Try an earlier candidate.
    }
  }
  return null
}

function asString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxChars)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim())
}

export interface ParsePlannerOptions {
  allowedKinds: readonly TabloidItemKind[]
  /** Tag (`S1`, `M2`, `W1`) to the ref the code built for it. */
  refsByTag: Record<string, TabloidSourceRef>
  maxIntents: number
}

/**
 * Planner reply to intents.
 *
 * The trust rule: a `sources` tag with no entry in `refsByTag` is DROPPED. Only
 * facts the prompt actually showed were given a tag, so a citation to anything
 * else can only be invented — the same reasoning as the citation markers in
 * `documentContext.ts`. An intent left with no resolvable source is kept, but
 * with an empty ref list, so the card shows no provenance rather than a wrong one.
 */
export function parsePlannerResponse(raw: string, options: ParsePlannerOptions): TabloidIntent[] {
  const parsed = salvageJsonObject(raw, 'intents')
  const list = (parsed as { intents?: unknown } | null)?.intents
  if (!Array.isArray(list)) return []

  const allowed = new Set<string>(options.allowedKinds)
  const seenQueries = new Set<string>()
  const intents: TabloidIntent[] = []

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>

    const kind = typeof record['kind'] === 'string' ? record['kind'].trim().toLowerCase() : ''
    if (!allowed.has(kind)) continue

    const query = asString(record['query'], MAX_QUERY_CHARS)
    if (!query) continue
    const dedupeKey = query.toLowerCase()
    if (seenQueries.has(dedupeKey)) continue
    seenQueries.add(dedupeKey)

    const sourceRefs: TabloidSourceRef[] = []
    const seenRefs = new Set<string>()
    for (const tag of asStringArray(record['sources'])) {
      const ref = options.refsByTag[tag] ?? options.refsByTag[tag.toUpperCase()]
      if (!ref || seenRefs.has(ref.ref)) continue
      seenRefs.add(ref.ref)
      sourceRefs.push(ref)
    }

    intents.push({
      // The model's own id is ignored: the curator cites these back, so they
      // have to be unique and dense whatever the model numbered them.
      id: `i${intents.length + 1}`,
      kind: kind as TabloidItemKind,
      query,
      rationale: asString(record['rationale'], MAX_RATIONALE_CHARS * 2),
      sourceRefs,
      filters: parseFilters(record['filters']),
    })

    if (intents.length >= options.maxIntents) break
  }

  return intents
}

function parseFilters(value: unknown): TabloidIntent['filters'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const filters: NonNullable<TabloidIntent['filters']> = {}

  const publishedAfter = asString(record['publishedAfter'], 32)
  if (/^\d{4}-\d{2}-\d{2}/.test(publishedAfter)) filters.publishedAfter = publishedAfter.slice(0, 10)

  const minMinutes = Number(record['minMinutes'])
  if (Number.isFinite(minMinutes) && minMinutes > 0) filters.minMinutes = Math.min(600, Math.round(minMinutes))

  const maxMinutes = Number(record['maxMinutes'])
  if (Number.isFinite(maxMinutes) && maxMinutes > 0) filters.maxMinutes = Math.min(600, Math.round(maxMinutes))

  const channelHint = asString(record['channelHint'], 80)
  if (channelHint) filters.channelHint = channelHint

  const language = asString(record['language'], 8)
  if (/^[a-z]{2}$/i.test(language)) filters.language = language.toLowerCase()

  return Object.keys(filters).length > 0 ? filters : undefined
}

export interface ParseCuratorOptions {
  allowedCandidateIds: readonly string[]
  allowedIntentIds: readonly string[]
  allowedMemoryFieldKeys: readonly string[]
  maxPicks: number
}

/**
 * Curator reply to picks.
 *
 * Same trust rule, one level up: a pick naming a candidate that was not offered
 * is dropped rather than fetched, and an `intentIds` entry that was not in the
 * plan is dropped. The curator never authors a source ref at all — the item's
 * refs are computed from the intents it cited.
 */
export function parseCuratorResponse(raw: string, options: ParseCuratorOptions): TabloidCuratorPick[] {
  const parsed = salvageJsonObject(raw, 'picks')
  const list = (parsed as { picks?: unknown } | null)?.picks
  if (!Array.isArray(list)) return []

  const candidates = new Set(options.allowedCandidateIds)
  const intents = new Set(options.allowedIntentIds)
  const memoryKeys = new Set(options.allowedMemoryFieldKeys)
  const seen = new Set<string>()
  const picks: TabloidCuratorPick[] = []

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>

    const candidateId = asString(record['candidateId'], 64)
    if (!candidateId || !candidates.has(candidateId) || seen.has(candidateId)) continue
    seen.add(candidateId)

    const intentIds = asStringArray(record['intentIds']).filter((id) => intents.has(id))

    const memoryFieldKeyRaw = asString(record['memoryFieldKey'], 64)
    const memoryFieldKey = memoryKeys.has(memoryFieldKeyRaw) ? memoryFieldKeyRaw : null
    const memoryValue = memoryFieldKey ? asString(record['memoryValue'], MAX_MEMORY_VALUE_CHARS) : ''

    picks.push({
      candidateId,
      intentIds,
      rationale: asString(record['rationale'], MAX_RATIONALE_CHARS),
      memoryFieldKey,
      memoryValue: memoryValue || null,
    })

    if (picks.length >= options.maxPicks) break
  }

  return picks
}

const FLAG_KINDS: readonly TabloidFlagKind[] = [
  'unsupported',
  'false',
  'misleading',
  'bias',
  'omission',
  'outdated',
  'speculation',
]

const FLAG_SEVERITIES: readonly TabloidFlagSeverity[] = ['low', 'medium', 'high']

/** A video with more than this many flags is being nitpicked, not analysed. */
export const MAX_FLAGS_PER_VIDEO = 12
const MAX_QUOTE_CHARS = 240
const MAX_NOTE_CHARS = 300
const MAX_SUMMARY_CHARS = 220

export interface ParseAnalysisOptions {
  cues: TranscriptCue[]
  /** Total video length, used to reject a timestamp past the end. */
  durationSeconds: number | null
}

export interface ParsedAnalysis {
  summary: string
  flags: TabloidFlag[]
}

/**
 * Snaps a cited timestamp to the transcript cue that actually contains it.
 *
 * The model reads timestamps that are only marked every few lines, so its
 * citation lands near the claim rather than on it. Snapping to a real cue is
 * what makes clicking a flag seek to the words being quoted instead of a few
 * seconds after them. Returns null when the time is past the end of the video,
 * which is the signature of an invented timestamp.
 */
function snapToCue(seconds: number, cues: TranscriptCue[], durationSeconds: number | null): number | null {
  if (durationSeconds !== null && seconds > durationSeconds + 5) return null
  if (cues.length === 0) return seconds

  const last = cues[cues.length - 1]!
  if (seconds > last.end + 30) return null

  let best = cues[0]!
  let bestDistance = Number.POSITIVE_INFINITY
  for (const cue of cues) {
    if (seconds >= cue.start && seconds <= cue.end) return cue.start
    const distance = Math.min(Math.abs(cue.start - seconds), Math.abs(cue.end - seconds))
    if (distance < bestDistance) {
      bestDistance = distance
      best = cue
    }
  }
  return best.start
}

/**
 * The analysis reply into flags.
 *
 * Every flag must survive three checks, and the reasoning is the same each time:
 * a claim about what someone said, attached to the wrong moment or to words
 * they did not say, is worse than no flag at all.
 *
 *  - the kind and severity must be in the taxonomy
 *  - the timestamp must land inside the video, and is snapped to a real cue
 *  - there must be a quote, so the viewer can check the flag against the video
 */
export function parseAnalysisResponse(raw: string, options: ParseAnalysisOptions): ParsedAnalysis {
  const parsed = salvageJsonObject(raw, 'flags') as
    | { flags?: unknown; summary?: unknown }
    | null
  // The summary rides in the same object; a reply with only a summary and no
  // flags is a legitimate "nothing wrong here" answer.
  const summary = asString(parsed?.summary, MAX_SUMMARY_CHARS)
  const list = parsed?.flags

  if (!Array.isArray(list)) return { summary, flags: [] }

  const flags: TabloidFlag[] = []
  const seen = new Set<string>()

  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>

    const kind = asString(record['kind'], 32).toLowerCase() as TabloidFlagKind
    if (!FLAG_KINDS.includes(kind)) continue

    const severityRaw = asString(record['severity'], 16).toLowerCase() as TabloidFlagSeverity
    const severity: TabloidFlagSeverity = FLAG_SEVERITIES.includes(severityRaw) ? severityRaw : 'medium'

    const at = parseClock(record['at'] ?? record['timestamp'] ?? record['startSeconds'])
    if (at === null) continue
    const snapped = snapToCue(at, options.cues, options.durationSeconds)
    if (snapped === null) continue

    const quote = asString(record['quote'], MAX_QUOTE_CHARS)
    const note = asString(record['note'], MAX_NOTE_CHARS)
    if (!quote || !note) continue

    const key = `${Math.round(snapped)}|${note.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    flags.push({
      id: `f${flags.length + 1}`,
      kind,
      severity,
      startSeconds: snapped,
      quote,
      note,
    })

    if (flags.length >= MAX_FLAGS_PER_VIDEO) break
  }

  flags.sort((left, right) => left.startSeconds - right.startSeconds)
  return { summary, flags: flags.map((flag, index) => ({ ...flag, id: `f${index + 1}` })) }
}

/**
 * A YouTube Data API failure, classified into what the page should do about it.
 *
 * Shaped like `describeTavilyError` in `webSearch.ts`: read the body once, pull
 * the reason, and never let a 429 look like a dead key.
 */
export function classifyYoutubeError(status: number, body: string): TabloidYoutubeError {
  let message = `HTTP ${status}`
  let reason = ''

  try {
    const payload = JSON.parse(body) as {
      error?: { message?: unknown; errors?: Array<{ reason?: unknown; message?: unknown }> }
    }
    const detail = payload?.error?.message
    if (typeof detail === 'string' && detail.trim()) message = detail.trim()
    const first = payload?.error?.errors?.[0]
    if (typeof first?.reason === 'string') reason = first.reason
  } catch {
    // A non-JSON body (an HTML error page from a proxy) leaves the status as
    // the whole story, which is still better than throwing here.
    const snippet = body.trim().replace(/\s+/g, ' ').slice(0, 200)
    if (snippet) message = `HTTP ${status} - ${snippet}`
  }

  if (reason === 'accessNotConfigured') {
    return {
      kind: 'not-configured',
      message: 'Enable YouTube Data API v3 for this key in the Google Cloud console.',
    }
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return {
      kind: 'quota',
      message: "YouTube's daily quota for this key is used up. It resets at midnight Pacific time.",
    }
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'backendError') {
    return { kind: 'transient', message }
  }
  if (reason === 'keyInvalid' || reason === 'ipRefererBlocked' || (status === 400 && reason === 'badRequest')) {
    return { kind: 'key-invalid', message: `Your YouTube key was rejected: ${message}` }
  }
  if (status === 429 || status >= 500) return { kind: 'transient', message }
  if (status === 400 || status === 401 || status === 403) {
    return { kind: 'key-invalid', message: `Your YouTube key was rejected: ${message}` }
  }
  return { kind: 'unknown', message }
}

function vttTimeToSeconds(raw: string): number | null {
  // hh:mm:ss.mmm, and the hour is optional on short videos.
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(raw.trim())
  if (!match) return null
  const [, hours, minutes, seconds, millis] = match
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis.padEnd(3, '0')) / 1000
  )
}

/**
 * YouTube's auto-caption VTT into clean timestamped lines.
 *
 * The raw format is a ROLLING caption designed to look like live typing, and it
 * is nothing like a transcript:
 *
 *   00:00:04.400 --> 00:00:06.869
 *
 *   This<00:00:04.799><c> is</c><00:00:04.960><c> a</c><00:00:05.200><c> three.</c>
 *
 *   00:00:06.869 --> 00:00:06.879
 *   This is a three. It's sloppily written
 *
 *
 * So every line appears two or three times — once being "typed" with per-word
 * timing tags, once as a settled line, once as the scrolled-up previous line —
 * and a 19-minute video yields ~1000 cues of which maybe 300 carry new words.
 * Feeding that to a model verbatim would triple the token bill and read as
 * stuttering nonsense.
 *
 * The de-duplication is by content, keeping the EARLIEST timestamp a line was
 * seen at: the first appearance is when the words are actually spoken, and the
 * later repeats are the caption scrolling. Timestamps have to be the spoken
 * moment or every flag would point a few seconds past what it refers to.
 */
export function parseVtt(raw: string): TranscriptCue[] {
  const cues: TranscriptCue[] = []
  const seen = new Map<string, number>()

  // Scanned line by line rather than split on blank lines. YouTube separates the
  // timestamp from its text with a line containing a single SPACE, and some
  // tracks use a truly empty one — splitting on /\n{2,}/ silently drops the
  // first caption of every file that does the latter.
  const lines = raw.replace(/\r\n/g, '\n').split('\n')

  let start: number | null = null
  let end: number | null = null

  const push = (line: string): void => {
    if (start === null || end === null) return
    const text = line
      // Per-word timing tags and the <c> spans that carry them.
      .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{1,3}>/g, '')
      .replace(/<\/?c[^>]*>/g, '')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return

    const key = text.toLowerCase()
    const existing = seen.get(key)
    if (existing !== undefined) {
      // Already spoken. Extend the end so a line held on screen keeps its span,
      // but never move the start backwards off the moment it was said.
      const cue = cues[existing]!
      if (end > cue.end) cue.end = end
      return
    }

    seen.set(key, cues.length)
    cues.push({ start, end, text })
  }

  for (const line of lines) {
    if (line.includes('-->')) {
      const [startRaw, endRaw] = line.split('-->')
      start = startRaw ? vttTimeToSeconds(startRaw) : null
      // The end carries cue settings (align:start position:0%) after the time.
      end = endRaw ? vttTimeToSeconds(endRaw.trim().split(/\s+/)[0] ?? '') : null
      continue
    }
    if (line.startsWith('WEBVTT') || /^(Kind|Language|NOTE|STYLE|REGION):/.test(line)) {
      start = null
      end = null
      continue
    }
    // Each text line is deduplicated SEPARATELY, not as one joined block. A
    // rolling cue holds the previous line and the new one together, so joining
    // them would make every cue unique and defeat the de-duplication entirely.
    push(line)
  }

  return cues
}

/**
 * The transcript as one block of text with a timestamp every few lines.
 *
 * The analysis has to cite the second a claim is made, so the model needs the
 * clock in front of it — but a timestamp on every line would be a third of the
 * tokens. Marking every `stampEvery` lines is enough to place a claim within a
 * few seconds, and the flag parser snaps each cited time to the nearest real cue
 * afterwards anyway.
 */
export function transcriptToPrompt(cues: TranscriptCue[], stampEvery = 4): string {
  return cues
    .map((cue, index) =>
      index % stampEvery === 0 ? `[${formatClock(cue.start)}] ${cue.text}` : cue.text
    )
    .join('\n')
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** `1:02:03` / `2:14` / `134` (bare seconds) to seconds. */
export function parseClock(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw)
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text))
  const parts = text.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const numbers = parts.map((part) => Number(part))
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) return null
  const seconds =
    numbers.length === 3
      ? numbers[0]! * 3600 + numbers[1]! * 60 + numbers[2]!
      : numbers[0]! * 60 + numbers[1]!
  return Math.max(0, seconds)
}

/**
 * The quota day in America/Los_Angeles.
 *
 * YouTube resets quota at Pacific midnight regardless of where the user is, so
 * a ledger keyed on the local date would reset at the wrong moment — and worse,
 * would tell the user "resets at midnight" and be hours out.
 */
export function quotaDayPacific(now: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}
