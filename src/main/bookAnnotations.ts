// Generating annotations over a chapter range, anchoring them into the book's
// canonical text, and keeping them anchored when the file changes.
//
// The hard part is not the generation, it is the anchoring. An annotation is a
// note about a specific passage; if the offsets drift, the note ends up on the
// wrong sentence, which is worse than no note. So every annotation carries the
// quote and its surrounding text (the W3C TextQuoteSelector pattern), an
// annotation that cannot be located is DROPPED AND COUNTED rather than silently
// omitted, and one that stops matching after an edit is marked orphaned rather
// than deleted — it was true when it was written.
import type { BookAnnotation, ProviderConfig } from '../shared/types'
import { parseAnnotationBlock } from '../shared/bookFocuses'
import * as database from './database'
import { getCanonicalText } from './library'
import { callLLMRetrying, type SpendTracker } from './llmCall'
import { hasProviderCredentials, missingCredentialsError } from './providerEndpoint'
import { annotationPromptFor, type AnnotationFocusSelection } from './annotationFocuses'
import type { RateLimiter } from './rateLimit'

/** Matches MAX_FOLDER_CHILD_INPUT_CHARS: one call's worth of prose. */
const MAX_ANNOTATION_INPUT_CHARS = 90_000
/** Context kept either side of a quote so it can be re-found after an edit. */
const ANCHOR_CONTEXT_CHARS = 32
/** How far from the old offset to search before giving up and going global. */
const REANCHOR_WINDOW_RATIO = 0.05

export interface AnnotationRunOptions {
  spend?: SpendTracker
  limiter?: RateLimiter
  signal?: AbortSignal
}

export interface AnnotationRunResult {
  runId: string
  created: number
  dropped: number
  cached: boolean
}

/**
 * Whitespace, quote marks and dashes are exactly what a model normalizes without
 * meaning to, and exactly what differs between two builds of the same EPUB.
 * Matching on a normalized form recovers those without loosening the match to
 * the point where it finds the wrong passage.
 */
function normalizeForMatch(value: string): string {
  return value
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Strips the decoration a model puts around a quotation without being asked.
 *
 * Asked for a verbatim quote, models reliably return `"like this,"` — wrapped in
 * quotation marks, sometimes with a trailing comma or ellipsis, sometimes inside
 * brackets. None of that is in the book, so a literal match fails on every
 * single annotation and the whole run comes back empty. Each variant below is
 * tried in turn, tightest first.
 */
export function quoteVariants(quote: string): string[] {
  const seen = new Set<string>()
  const push = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length >= 3) seen.add(trimmed)
  }

  push(quote)
  let working = quote.trim()

  // Wrapping quotation marks, straight or curly, possibly doubled.
  for (let i = 0; i < 2; i += 1) {
    const unwrapped = working.replace(/^["'“”‘’«»`]+/, '').replace(/["'“”‘’«»`]+$/, '').trim()
    if (unwrapped === working) break
    working = unwrapped
    push(working)
  }
  // Wrapping brackets.
  const unbracketed = working.replace(/^[[(<{]+/, '').replace(/[\])>}]+$/, '').trim()
  if (unbracketed !== working) { working = unbracketed; push(working) }

  // Leading and trailing ellipses, which mark an elision the book does not have.
  const unelided = working.replace(/^(\.\.\.|…)\s*/, '').replace(/\s*(\.\.\.|…)$/, '').trim()
  if (unelided !== working) { working = unelided; push(working) }

  // A trailing sentence-ender the model added or the book lacks. Dropped last,
  // because it is the loosest change and the most likely to shorten a match.
  push(working.replace(/[.,;:!?]+$/, ''))

  return [...seen]
}

/**
 * Finds a quote in a haystack, exactly first and then normalized. Returns the
 * offset in the ORIGINAL string, or -1. `preferNear` breaks ties toward a
 * previous location, which is what makes re-anchoring stable when a phrase
 * legitimately recurs.
 */
export interface QuoteSpan {
  start: number
  /** Exclusive end IN THE HAYSTACK, which is not always start + quote.length. */
  end: number
}

/**
 * Finds a quote and returns the span it actually occupies in the haystack.
 *
 * The end matters as much as the start. A quote matched through the normalized
 * path can be a different LENGTH from the text it matched — the book may have a
 * line break where the quote has a space, or two spaces where it has one — so
 * assuming `start + quote.length` puts the end short and the highlight lands on
 * a slice that is not the quote.
 */
export function locateQuoteSpan(haystack: string, quote: string, preferNear?: number): QuoteSpan | null {
  if (!quote.trim()) return null

  const exact: number[] = []
  let at = haystack.indexOf(quote)
  while (at !== -1) {
    exact.push(at)
    at = haystack.indexOf(quote, at + 1)
  }
  const pick = (candidates: number[]): number => {
    if (candidates.length === 0) return -1
    if (candidates.length === 1 || preferNear === undefined) return candidates[0]
    return candidates.reduce((best, candidate) =>
      Math.abs(candidate - preferNear) < Math.abs(best - preferNear) ? candidate : best
    )
  }
  if (exact.length > 0) {
    const start = pick(exact)
    return { start, end: start + quote.length }
  }

  // Normalized fallback: walk the haystack building a normalized projection with
  // an index back to the original, so a hit maps to a real offset.
  const needle = normalizeForMatch(quote)
  if (!needle) return null
  let projected = ''
  const originalIndex: number[] = []
  let lastWasSpace = true
  for (let i = 0; i < haystack.length; i += 1) {
    const char = haystack[i]
    const mapped = normalizeForMatch(char)
    if (!mapped) {
      // Whitespace collapses to a single space, and leading space is dropped.
      if (!lastWasSpace) {
        projected += ' '
        originalIndex.push(i)
        lastWasSpace = true
      }
      continue
    }
    projected += mapped
    originalIndex.push(i)
    lastWasSpace = false
  }
  const hits: Array<{ start: number; end: number }> = []
  let hit = projected.indexOf(needle)
  while (hit !== -1) {
    const start = originalIndex[hit]
    // One past the last matched character, mapped back — this is the end the
    // book actually has, whatever the quote's own length happens to be.
    const end = originalIndex[hit + needle.length] ?? haystack.length
    if (start !== undefined && end > start) hits.push({ start, end })
    hit = projected.indexOf(needle, hit + 1)
  }
  if (hits.length === 0) return null
  const chosen = pick(hits.map((span) => span.start))
  return hits.find((span) => span.start === chosen) ?? hits[0]
}

/** Start offset only. Kept for callers that do not need the end. */
export function locateQuote(haystack: string, quote: string, preferNear?: number): number {
  return locateQuoteSpan(haystack, quote, preferNear)?.start ?? -1
}

function contextAround(text: string, start: number, end: number): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + ANCHOR_CONTEXT_CHARS)),
  }
}

/** Which chapter an absolute offset falls in. */
function chapterAt(chapters: Array<{ spineIndex: number; charStart: number; charEnd: number }>, offset: number): number {
  for (const chapter of chapters) {
    if (offset >= chapter.charStart && offset <= chapter.charEnd) return chapter.spineIndex
  }
  return chapters.length > 0 ? chapters[chapters.length - 1].spineIndex : 0
}

export async function generateBookAnnotations(
  bookId: string,
  focus: AnnotationFocusSelection,
  chapterStart: number,
  chapterEnd: number,
  config: ProviderConfig,
  model: string,
  options: AnnotationRunOptions = {}
): Promise<AnnotationRunResult> {
  const book = database.getBookById(bookId)
  if (!book) throw new Error('That book is no longer on the shelf')
  if (book.status !== 'ready') throw new Error(book.scanError ?? 'This book could not be read')

  const { prompt, version, label } = annotationPromptFor(focus)

  // The uniqueness key carries the prompt version, so the same focus over the
  // same range is a cache hit and an edited custom focus is a new run.
  const existing = database.getAnnotationRun(bookId, chapterStart, chapterEnd, version)
  if (existing && existing.status === 'ready' && existing.textHash === book.textHash) {
    return { runId: existing.id, created: existing.annotationCount, dropped: existing.droppedCount, cached: true }
  }

  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No text model configured for this tier')

  const { text, charStart } = await getCanonicalText(bookId, chapterStart, chapterEnd)
  if (!text.trim()) throw new Error('There is no readable text in that chapter range')
  // Truncation would mean the end of the range never reaches the model while the
  // result still claims to cover it. Refuse and let the caller split instead.
  if (text.length > MAX_ANNOTATION_INPUT_CHARS) {
    throw new Error(
      `That range is too long to annotate in one pass (${Math.round(text.length / 1000)}k characters). Select fewer chapters.`
    )
  }

  const run = database.upsertAnnotationRun({
    bookId,
    focusKey: focus.key,
    focusLabel: label,
    customFocus: focus.key === 'custom' ? focus.customText ?? null : null,
    promptVersion: version,
    chapterStart,
    chapterEnd,
    textHash: book.textHash,
    model,
    status: 'pending',
    error: null,
  })

  let raw: string
  try {
    raw = await callLLMRetrying(
      config,
      model,
      prompt,
      `Annotate the passage below.\n\n"""\n${text}\n"""`,
      options.signal,
      3,
      { spend: options.spend, limiter: options.limiter }
    )
  } catch (error) {
    database.updateAnnotationRun(run.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  const parsed = parseAnnotationBlock(raw)
  const chapters = database.listBookChapters(bookId)
  const annotations: Array<Omit<BookAnnotation, 'id' | 'createdAt' | 'updatedAt'>> = []
  let dropped = 0
  const claimed: Array<{ start: number; end: number }> = []

  for (const entry of parsed) {
    // Try the quote as given, then progressively undecorated — a model asked for
    // a verbatim quote still tends to hand it back wrapped in quotation marks.
    let span: QuoteSpan | null = null
    for (const variant of quoteVariants(entry.quote)) {
      span = locateQuoteSpan(text, variant)
      if (span) break
    }
    if (!span) {
      // An annotation whose quote is not in the text is a fabricated anchor.
      // Counted, so the UI can say "3 of 42 could not be located" — silent
      // omission is how a run comes to look more complete than it was.
      dropped += 1
      continue
    }
    const absoluteStart = charStart + span.start
    const absoluteEnd = charStart + span.end
    // The text the BOOK contains at that span, which is what re-anchoring will
    // look for later — not the decorated form the model handed back.
    const matched = text.slice(span.start, span.end)
    // The same quote returned twice would stack two identical underlines.
    if (claimed.some((span) => span.start === absoluteStart && span.end === absoluteEnd)) {
      dropped += 1
      continue
    }
    claimed.push({ start: absoluteStart, end: absoluteEnd })
    const { prefix, suffix } = contextAround(text, span.start, span.end)
    annotations.push({
      runId: run.id,
      bookId,
      chapterIndex: chapterAt(chapters, absoluteStart),
      charStart: absoluteStart,
      charEnd: absoluteEnd,
      quote: matched,
      prefix,
      suffix,
      kind: entry.kind,
      label: entry.label,
      body: entry.note,
      origin: 'ai',
      pinned: false,
      anchorStatus: 'exact',
    })
  }

  database.replaceRunAnnotations(run.id, annotations)

  // Producing annotations and then losing every one of them is a failure, not an
  // empty success: stored as `ready` with a count of zero it reads as "there was
  // nothing to find here", which is the opposite of what happened.
  const lostEverything = annotations.length === 0 && dropped > 0
  database.updateAnnotationRun(run.id, {
    status: lostEverything ? 'failed' : 'ready',
    error: lostEverything
      ? `The model returned ${dropped} annotation${dropped === 1 ? '' : 's'}, but none of their quotes could be found in this chapter. Try a different focus, or a chapter with more prose in it.`
      : null,
    annotationCount: annotations.length,
    droppedCount: dropped,
    inputTokens: options.spend?.inputTokens ?? 0,
    outputTokens: options.spend?.outputTokens ?? 0,
    costUsd: options.spend?.costUsd ?? null,
  })

  if (lostEverything) {
    throw new Error(
      `None of the ${dropped} annotation${dropped === 1 ? '' : 's'} could be located in the chapter text.`
    )
  }

  return { runId: run.id, created: annotations.length, dropped, cached: false }
}

/**
 * Re-points a book's annotations after its file changed.
 *
 * Search order is narrow-to-wide so a phrase that recurs lands back where it
 * was: quote-with-context first, then the quote near its old home, then the
 * quote anywhere. Nothing is ever deleted — an annotation that cannot be found
 * becomes `orphaned`, keeps its offsets and its quote, and is still listed under
 * "could not be located in this version".
 */
export async function reanchorBookAnnotations(bookId: string): Promise<{ exact: number; shifted: number; orphaned: number }> {
  const book = database.getBookById(bookId)
  if (!book) throw new Error('That book is no longer on the shelf')

  const annotations = database.listBookAnnotations(bookId)
  if (annotations.length === 0) return { exact: 0, shifted: 0, orphaned: 0 }

  const { text } = await getCanonicalText(bookId)
  const chapters = database.listBookChapters(bookId)
  const window = Math.max(2_000, Math.round(text.length * REANCHOR_WINDOW_RATIO))
  const counts = { exact: 0, shifted: 0, orphaned: 0 }

  for (const annotation of annotations) {
    // Still exactly where it was: nothing to do, and no version churn.
    if (text.slice(annotation.charStart, annotation.charEnd) === annotation.quote) {
      if (annotation.anchorStatus !== 'exact') {
        database.updateBookAnnotationAnchor(annotation.id, annotation.charStart, annotation.charEnd, 'exact', annotation.chapterIndex)
      }
      counts.exact += 1
      continue
    }

    const withContext = `${annotation.prefix}${annotation.quote}${annotation.suffix}`
    let found = -1
    if (annotation.prefix || annotation.suffix) {
      const contextAt = locateQuote(text, withContext, annotation.charStart)
      if (contextAt !== -1) found = contextAt + annotation.prefix.length
    }
    if (found === -1) {
      const near = text.slice(Math.max(0, annotation.charStart - window), Math.min(text.length, annotation.charEnd + window))
      const nearAt = locateQuote(near, annotation.quote)
      if (nearAt !== -1) found = Math.max(0, annotation.charStart - window) + nearAt
    }
    if (found === -1) found = locateQuote(text, annotation.quote, annotation.charStart)

    if (found === -1) {
      database.updateBookAnnotationAnchor(annotation.id, annotation.charStart, annotation.charEnd, 'orphaned', annotation.chapterIndex)
      counts.orphaned += 1
      continue
    }
    const end = found + annotation.quote.length
    database.updateBookAnnotationAnchor(annotation.id, found, end, 'shifted', chapterAt(chapters, found))
    counts.shifted += 1
  }

  return counts
}

/** A highlight the reader made by hand. Shares the whole anchor mechanism. */
export async function createManualAnnotation(input: {
  bookId: string
  chapterIndex: number
  charStart: number
  charEnd: number
  label: string
  body: string
}): Promise<BookAnnotation> {
  const book = database.getBookById(input.bookId)
  if (!book) throw new Error('That book is no longer on the shelf')
  const { text } = await getCanonicalText(input.bookId)
  const quote = text.slice(input.charStart, input.charEnd)
  if (!quote.trim()) throw new Error('That selection is empty')
  const { prefix, suffix } = contextAround(text, input.charStart, input.charEnd)
  return database.insertBookAnnotation({
    runId: null,
    bookId: input.bookId,
    chapterIndex: input.chapterIndex,
    charStart: input.charStart,
    charEnd: input.charEnd,
    quote,
    prefix,
    suffix,
    kind: 'highlight',
    label: input.label,
    body: input.body,
    origin: 'manual',
    pinned: false,
    anchorStatus: 'exact',
  })
}

export { MAX_ANNOTATION_INPUT_CHARS }
