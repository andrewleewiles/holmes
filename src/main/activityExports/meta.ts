/**
 * Facebook and Instagram "Download Your Information" archives.
 *
 * Both are the same JSON dialect: a zip of per-category files, each a wrapper
 * object around one array, with timestamps as `timestamp` (epoch seconds) or
 * `string_map_data` entries. Every string in them is mojibake — see
 * `fixMetaMojibake` — so nothing is read out of these files raw.
 */

import { fixMetaMojibake, findEntriesContaining, readJson, type ExportSource } from './archive'
import { toIso, type ParsedAccountEvent } from './common'
import type { ActivityProviderId } from '../../shared/types'

type Json = Record<string, unknown>

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const fixed = fixMetaMojibake(value).trim()
  return fixed || null
}

/** Meta wraps every export array in a single-key object whose name varies. */
function unwrapArray(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload as Json[]
  if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload as Json)) {
      if (Array.isArray(value)) return value as Json[]
    }
  }
  return []
}

/** Pulls the first usable timestamp out of a Meta record. */
function metaTimestamp(item: Json): string | null {
  const direct = item.timestamp ?? item.creation_timestamp ?? item.time
  const iso = toIso(direct)
  if (iso) return iso

  // Some categories bury it in string_map_data under a human-readable key.
  const map = item.string_map_data
  if (map && typeof map === 'object') {
    for (const [key, value] of Object.entries(map as Json)) {
      if (!/time|date/i.test(key)) continue
      const nested = value as Json | undefined
      const candidate = nested?.timestamp ?? nested?.value
      const parsed = toIso(candidate)
      if (parsed) return parsed
    }
  }
  return null
}

/** Meta stores post text under a `data` array of `{post: "..."}` entries. */
function metaText(item: Json): string | null {
  const data = item.data
  if (Array.isArray(data)) {
    for (const entry of data as Json[]) {
      const text = str(entry.post) ?? str(entry.comment) ?? str(entry.name)
      if (text) return text
    }
  }
  return str(item.title) ?? str(item.name)
}

interface CategoryRule {
  /** Path fragments that must all appear in the entry name. */
  match: string[]
  kind: ParsedAccountEvent['kind']
  label: string
}

const CATEGORY_RULES: CategoryRule[] = [
  { match: ['your_posts'], kind: 'post', label: 'Post' },
  { match: ['your_videos'], kind: 'post', label: 'Video' },
  { match: ['posts_1.json'], kind: 'post', label: 'Post' },
  { match: ['comments'], kind: 'comment', label: 'Comment' },
  { match: ['liked_posts'], kind: 'like', label: 'Like' },
  { match: ['likes_and_reactions'], kind: 'like', label: 'Reaction' },
  { match: ['saved_posts'], kind: 'like', label: 'Saved' },
  { match: ['following'], kind: 'follow', label: 'Follow' },
  { match: ['followers'], kind: 'follow', label: 'Follower' },
  { match: ['recently_viewed'], kind: 'watch', label: 'Viewed' },
  { match: ['word_or_phrase_searches'], kind: 'search', label: 'Search' },
  { match: ['your_search_history'], kind: 'search', label: 'Search' },
  { match: ['login_activity'], kind: 'login', label: 'Login' },
  { match: ['account_activity'], kind: 'login', label: 'Account activity' },
]

/**
 * Message threads are read for metadata only — who and when, never the text.
 * The same rule the iMessage reader has followed since it was written.
 */
function parseMessageThreads(source: ExportSource, provider: ActivityProviderId): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []
  const threads = findEntriesContaining(source, 'messages', 'message_1.json')

  for (const entry of threads) {
    const payload = readJson<Json>(source, entry)
    if (!payload) continue

    const participants = Array.isArray(payload.participants)
      ? (payload.participants as Json[]).map((p) => str(p.name)).filter((n): n is string => Boolean(n))
      : []
    const threadTitle = str(payload.title) ?? participants.join(', ')
    const messages = Array.isArray(payload.messages) ? (payload.messages as Json[]) : []

    for (const message of messages) {
      const occurredAt = toIso(message.timestamp_ms ?? message.timestamp)
      if (!occurredAt) continue
      events.push({
        kind: 'message',
        occurredAt,
        title: `Message in ${threadTitle ?? 'thread'}`,
        detail: null,
        counterparty: str(message.sender_name),
        sourceMeta: { provider, participants: participants.length },
      })
    }
  }

  return events
}

export function parseMetaExport(source: ExportSource, provider: ActivityProviderId): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  for (const rule of CATEGORY_RULES) {
    for (const entry of findEntriesContaining(source, ...rule.match)) {
      if (!entry.toLowerCase().endsWith('.json')) continue
      const items = unwrapArray(readJson<unknown>(source, entry))

      for (const item of items) {
        const occurredAt = metaTimestamp(item)
        if (!occurredAt) continue
        events.push({
          kind: rule.kind,
          occurredAt,
          title: metaText(item) ?? rule.label,
          detail: rule.label,
          url: str(item.url) ?? null,
          sourceMeta: { provider, category: rule.match[0] },
        })
      }
    }
  }

  events.push(...parseMessageThreads(source, provider))
  return events
}

export function looksLikeMetaExport(source: ExportSource): boolean {
  return (
    findEntriesContaining(source, 'your_posts').length > 0 ||
    findEntriesContaining(source, 'your_instagram_activity').length > 0 ||
    findEntriesContaining(source, 'personal_information', '.json').length > 0
  )
}
