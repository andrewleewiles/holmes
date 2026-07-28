/**
 * Google Takeout "My Activity" in its HTML form.
 *
 * This exists because HTML is what Takeout gives you by default — JSON is an
 * opt-in the export wizard buries, and most people never touch it. A parser
 * that only read MyActivity.json would find nothing in a typical archive and
 * report zero events rather than an error, which is the worst possible failure.
 *
 * The file is also large: a few years of search history is comfortably 90 MB
 * of markup for a few hundred thousand entries. So it is read as a stream and
 * consumed one `outer-cell` block at a time, never held whole.
 */

import fs from 'fs'
import { toIso, type ParsedAccountEvent } from './common'

/** Guard against a pathological file; well past any real export. */
const MAX_ENTRIES = 1_000_000

/** Bytes read per chunk. */
const CHUNK_BYTES = 1 << 20

const BLOCK_OPEN = '<div class="outer-cell'
const BODY_CELL = /<div class="content-cell[^"]*mdl-typography--body-1[^"]*">([\s\S]*?)<\/div>/
const HEADER_CELL = /<div class="header-cell[^"]*">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/
const ANCHOR_ALL = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g

/**
 * One activity block, decoded but not yet interpreted. Google uses the same
 * markup for every product — YouTube's watch-history.html and My Activity's
 * MyActivity.html differ only in which product the header names and how many
 * anchors the body carries — so the structural parse is shared and each caller
 * decides what the pieces mean.
 */
export interface ActivityBlock {
  /** Header text: "Search", "YouTube", "Maps"… */
  product: string
  /** Leading verb phrase: "Searched for", "Watched", "Visited". */
  lead: string
  /** Every link in the body, in order. */
  links: Array<{ url: string; text: string }>
  occurredAt: string
}

/**
 * Takeout writes dates with narrow no-break spaces before AM/PM and non-break
 * spaces after the verb. V8 happens to tolerate them, but normalizing keeps the
 * parse from depending on that.
 */
function normalizeSpaces(value: string): string {
  return value.replace(/[   ]/g, ' ')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function stripTags(value: string): string {
  return decodeEntities(normalizeSpaces(value.replace(/<[^>]*>/g, ' '))).replace(/\s+/g, ' ').trim()
}

/**
 * A body cell reads "Searched for<a>query</a><br>Jul 12, 2026, 5:06:37 PM EDT".
 * The verb classifies, the anchor is the subject, and the trailing run is the
 * timestamp.
 */
export function parseActivityBlock(block: string): ActivityBlock | null {
  const bodyMatch = BODY_CELL.exec(block)
  if (!bodyMatch) return null
  const body = bodyMatch[1]

  const headerMatch = HEADER_CELL.exec(block)
  const product = headerMatch ? stripTags(headerMatch[1]) : ''

  // The cell is <br>-delimited: description first, timestamp last. Scanning
  // from the end finds the date without assuming how many segments precede it.
  const rawSegments = normalizeSpaces(body).split(/<br\s*\/?>/i)
  const segments = rawSegments.map(stripTags).filter(Boolean)

  let occurredAt: string | null = null
  let dateIndex = -1
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const candidate = toIso(segments[i])
    if (candidate) {
      occurredAt = candidate
      dateIndex = i
      break
    }
  }
  if (!occurredAt) return null

  const links: Array<{ url: string; text: string }> = []
  ANCHOR_ALL.lastIndex = 0
  for (let m = ANCHOR_ALL.exec(body); m !== null; m = ANCHOR_ALL.exec(body)) {
    links.push({ url: decodeEntities(m[1]), text: stripTags(m[2]) })
  }

  // The description is the first segment, with the anchor text removed so the
  // verb is left on its own. Taking everything before the <a> would swallow the
  // timestamp on the entries that have no anchor at all.
  const descriptionSegment = rawSegments[0] ?? ''
  const rawLead = stripTags(descriptionSegment.split(/<a /i)[0] ?? '')
  // Never let the segment that turned out to be the date pose as a description.
  const lead = dateIndex === 0 ? '' : rawLead

  return { product, lead, links, occurredAt }
}

/** A My Activity block as a Search-account event, or null if it belongs elsewhere. */
export function searchEventFromBlock(block: ActivityBlock): ParsedAccountEvent | null {
  // Only the Search-shaped products belong to this account; YouTube, Maps and
  // the rest have their own homes.
  if (block.product && !/search|discover/i.test(block.product)) return null

  let kind: ParsedAccountEvent['kind'] = 'other'
  if (/^searched for/i.test(block.lead)) kind = 'search'
  else if (/^watched/i.test(block.lead)) kind = 'watch'

  const title = block.links[0]?.text || block.lead
  if (!title) return null

  return {
    kind,
    occurredAt: block.occurredAt,
    title,
    detail: block.product || null,
    url: block.links[0]?.url ?? null,
    sourceMeta: { provider: 'google-search', format: 'html' },
  }
}

/**
 * Streams a MyActivity.html off disk, yielding one event per activity block.
 * The buffer only ever holds the tail after the last complete block, so peak
 * memory is a chunk plus one entry regardless of file size.
 */
export function parseGoogleActivityHtmlFile<T>(
  filePath: string,
  interpret: (block: ActivityBlock) => T | null,
  maxEntries = MAX_ENTRIES
): T[] {
  const events: T[] = []
  const fd = fs.openSync(filePath, 'r')

  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    let pending = ''

    for (;;) {
      const read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null)
      if (read === 0) break
      pending += buffer.toString('utf8', 0, read)

      // Consume every block that is definitely complete: a block ends where the
      // next one begins, so the last opener in the buffer is always held back.
      let start = pending.indexOf(BLOCK_OPEN)
      if (start === -1) {
        // Keep only enough tail to recognize an opener split across chunks.
        if (pending.length > BLOCK_OPEN.length) pending = pending.slice(-BLOCK_OPEN.length)
        continue
      }

      for (;;) {
        const next = pending.indexOf(BLOCK_OPEN, start + BLOCK_OPEN.length)
        if (next === -1) break
        const block = parseActivityBlock(pending.slice(start, next))
        const event = block ? interpret(block) : null
        if (event) events.push(event)
        if (events.length >= maxEntries) return events
        start = next
      }

      pending = pending.slice(start)
    }

    // Whatever is left is the final block.
    if (pending.includes(BLOCK_OPEN)) {
      const block = parseActivityBlock(pending.slice(pending.indexOf(BLOCK_OPEN)))
      const event = block ? interpret(block) : null
      if (event) events.push(event)
    }
  } finally {
    fs.closeSync(fd)
  }

  return events
}

/** In-memory variant for a zip member, which has no path to stream from. */
export function parseGoogleActivityHtmlText<T>(
  text: string,
  interpret: (block: ActivityBlock) => T | null,
  maxEntries = MAX_ENTRIES
): T[] {
  const events: T[] = []
  let start = text.indexOf(BLOCK_OPEN)
  if (start === -1) return events

  for (;;) {
    const next = text.indexOf(BLOCK_OPEN, start + BLOCK_OPEN.length)
    const block = parseActivityBlock(text.slice(start, next === -1 ? undefined : next))
    const event = block ? interpret(block) : null
    if (event) events.push(event)
    if (next === -1 || events.length >= maxEntries) break
    start = next
  }

  return events
}

/** Search-account events from a My Activity HTML string. */
export function parseGoogleActivityHtml(text: string, maxEntries = MAX_ENTRIES): ParsedAccountEvent[] {
  return parseGoogleActivityHtmlText(text, searchEventFromBlock, maxEntries)
}
