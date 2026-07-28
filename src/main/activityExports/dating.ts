/**
 * Tinder and Bumble data requests.
 *
 * Tinder's `data.json` is the richer of the two and has a distinctive shape:
 * `Usage` is a set of parallel date→count maps (app opens, swipes left/right,
 * matches, messages sent) rather than a list of events, so it needs explicit
 * handling — the generic walker sees objects, not dated arrays.
 *
 * Bumble's archive has no stable documented format and has changed shape more
 * than once, so it goes through the tolerant walker and takes what it finds.
 */

import { findEntriesContaining, readJson, type ExportSource } from './archive'
import { toIso, type ParsedAccountEvent } from './common'
import { walkDatedArrays, type WalkRule } from './walker'

type Json = Record<string, unknown>

/** Tinder `Usage` counters, mapped to the event kind each represents. */
const USAGE_SERIES: Array<{ key: RegExp; kind: ParsedAccountEvent['kind']; label: string }> = [
  { key: /app_opens/i, kind: 'login', label: 'Opened app' },
  { key: /swipes_likes/i, kind: 'swipe', label: 'Swiped right' },
  { key: /swipes_passes/i, kind: 'swipe', label: 'Swiped left' },
  { key: /matches/i, kind: 'match', label: 'Matched' },
  { key: /messages_sent/i, kind: 'message', label: 'Message sent' },
  { key: /messages_received/i, kind: 'message', label: 'Message received' },
  { key: /advertising_id|superlikes/i, kind: 'other', label: 'Activity' },
]

/**
 * Tinder aggregates by day: `{"2024-03-11": 14}`. Each day with a non-zero
 * count becomes one event carrying the count, rather than fourteen synthetic
 * events for swipes that have no individual timestamps.
 */
function parseTinderUsage(usage: Json): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  for (const [seriesName, series] of Object.entries(usage)) {
    if (!series || typeof series !== 'object' || Array.isArray(series)) continue
    const matched = USAGE_SERIES.find((s) => s.key.test(seriesName))
    if (!matched) continue

    for (const [day, count] of Object.entries(series as Json)) {
      const value = typeof count === 'number' ? count : Number(count)
      if (!Number.isFinite(value) || value <= 0) continue
      const occurredAt = toIso(day)
      if (!occurredAt) continue

      events.push({
        kind: matched.kind,
        occurredAt,
        title: `${matched.label} ×${value}`,
        detail: matched.label,
        sourceMeta: { provider: 'tinder', series: seriesName, count: value },
      })
    }
  }

  return events
}

/** Message metadata only — Tinder stores full conversation text and we do not. */
function parseTinderMessages(messages: unknown): ParsedAccountEvent[] {
  if (!Array.isArray(messages)) return []
  const events: ParsedAccountEvent[] = []

  for (const thread of messages as Json[]) {
    const matchId = typeof thread.match_id === 'string' ? thread.match_id : null
    const list = Array.isArray(thread.messages) ? (thread.messages as Json[]) : []
    for (const message of list) {
      const occurredAt = toIso(message.sent_date ?? message.date ?? message.timestamp)
      if (!occurredAt) continue
      const body = typeof message.message === 'string' ? message.message : ''
      events.push({
        kind: 'message',
        occurredAt,
        title: 'Match conversation',
        detail: null,
        counterparty: matchId ? `match ${matchId.slice(0, 8)}` : null,
        sourceMeta: { provider: 'tinder', length: body.length },
      })
    }
  }

  return events
}

export function parseTinderExport(source: ExportSource): ParsedAccountEvent[] {
  const entries = findEntriesContaining(source, 'data.json')
  const events: ParsedAccountEvent[] = []

  for (const entry of entries) {
    const payload = readJson<Json>(source, entry)
    if (!payload) continue

    if (payload.Usage && typeof payload.Usage === 'object') {
      events.push(...parseTinderUsage(payload.Usage as Json))
    }
    events.push(...parseTinderMessages(payload.Messages))
  }

  return events
}

export function looksLikeTinderExport(source: ExportSource): boolean {
  for (const entry of findEntriesContaining(source, 'data.json')) {
    const payload = readJson<Json>(source, entry)
    if (payload && ('Usage' in payload || 'Messages' in payload) && 'User' in payload) return true
  }
  return false
}

const BUMBLE_RULES: WalkRule[] = [
  { test: /message|chat/, kind: 'message', label: 'Message' },
  { test: /match|connection/, kind: 'match', label: 'Match' },
  { test: /vote|swipe|encounter/, kind: 'swipe', label: 'Swipe' },
  { test: /login|session|access/, kind: 'login', label: 'Login' },
  { test: /purchase|payment|subscription/, kind: 'purchase', label: 'Purchase' },
]

export function parseBumbleExport(source: ExportSource): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  for (const entry of source.list()) {
    if (!entry.toLowerCase().endsWith('.json')) continue
    const payload = readJson<unknown>(source, entry)
    if (!payload) continue
    events.push(
      ...walkDatedArrays(payload, {
        rules: BUMBLE_RULES,
        // Bumble's key names are unpredictable enough that dropping everything
        // unmatched would usually mean dropping the whole export.
        fallbackKind: 'other',
        sourceMeta: { provider: 'bumble', file: entry },
      })
    )
  }

  return events
}
