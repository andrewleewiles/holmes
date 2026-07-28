/**
 * Google Takeout "My Activity" — the only way to get search history out of
 * Google. There has never been an API for it.
 */

import { findEntriesContaining, readJson, type ExportSource } from './archive'
import { toIso, type ParsedAccountEvent } from './common'
import { parseGoogleActivityHtml, parseGoogleActivityHtmlFile, searchEventFromBlock } from './googleHtml'

interface MyActivityEntry {
  header?: string
  title?: string
  titleUrl?: string
  time?: string
  products?: string[]
  subtitles?: Array<{ name?: string }>
  details?: Array<{ name?: string }>
}

/**
 * Takeout titles are sentences: "Searched for weather in oslo", "Visited
 * example.com". The verb is the useful classifier and the remainder is the
 * actual query, so both are kept apart.
 */
function splitTitle(title: string): { kind: 'search' | 'watch' | 'other'; text: string } {
  const searched = /^Searched for\s+/i.exec(title)
  if (searched) return { kind: 'search', text: title.slice(searched[0].length) }

  const watched = /^Watched\s+/i.exec(title)
  if (watched) return { kind: 'watch', text: title.slice(watched[0].length) }

  const visited = /^Visited\s+/i.exec(title)
  if (visited) return { kind: 'other', text: title.slice(visited[0].length) }

  return { kind: 'other', text: title }
}

export function parseGoogleSearchExport(source: ExportSource): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  // HTML is what Takeout produces unless the user changed the format, so it is
  // tried first and is the common case, not the fallback. Streamed off disk
  // when possible — a few years of search history is ~90 MB of markup.
  for (const entry of findEntriesContaining(source, 'myactivity.html')) {
    const onDisk = source.entryPath(entry)
    if (onDisk) {
      events.push(...parseGoogleActivityHtmlFile(onDisk, searchEventFromBlock))
    } else {
      const text = source.readText(entry)
      if (text) events.push(...parseGoogleActivityHtml(text))
    }
  }

  // Takeout nests this as "Takeout/My Activity/Search/MyActivity.json", but the
  // user may have pulled the file out on its own, so match on the filename and
  // narrow by the entries themselves rather than by the path.
  const candidates = findEntriesContaining(source, 'myactivity.json')

  for (const entry of candidates) {
    const parsed = readJson<MyActivityEntry[]>(source, entry)
    if (!Array.isArray(parsed)) continue

    for (const item of parsed) {
      const occurredAt = toIso(item.time)
      if (!occurredAt || !item.title) continue

      // "My Activity" covers every Google product. Only the Search-shaped
      // entries belong to this account; YouTube has its own.
      const header = (item.header ?? '').toLowerCase()
      if (header && !header.includes('search') && !header.includes('discover')) continue

      const { kind, text } = splitTitle(item.title)
      events.push({
        kind: kind === 'watch' ? 'watch' : kind === 'search' ? 'search' : 'other',
        occurredAt,
        title: text,
        detail: item.header ?? null,
        url: item.titleUrl ?? null,
        sourceMeta: { products: item.products ?? [] },
      })
    }
  }

  return events
}

/** True when this source looks like a My Activity export at all. */
export function looksLikeGoogleActivity(source: ExportSource): boolean {
  return (
    findEntriesContaining(source, 'myactivity.json').length > 0 ||
    findEntriesContaining(source, 'myactivity.html').length > 0
  )
}
