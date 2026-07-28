/**
 * A tolerant walker for the "one big JSON" exports.
 *
 * TikTok, Snapchat and Bumble all ship a single deeply nested document whose
 * exact key paths change between export versions — pinning a path like
 * `Activity["Video Browsing History"].VideoList` produces a parser that returns
 * zero events after the next redesign, and returns it silently.
 *
 * So instead of naming paths, this finds every array whose objects carry
 * something date-shaped and classifies each by the key path that led to it.
 * A renamed wrapper key costs a less precise label, not the data.
 */

import { toIso, type ParsedAccountEvent } from './common'

type Json = Record<string, unknown>

/** Keys that hold a timestamp, in rough order of preference. */
const DATE_KEYS = ['date', 'timestamp', 'time', 'created', 'createdat', 'creationtime', 'senddate', 'datetime']

/** Keys that hold the human-meaningful text of an entry. */
const TEXT_KEYS = [
  'searchterm', 'searchtext', 'query', 'text', 'content', 'message', 'title',
  'name', 'videolink', 'link', 'url', 'sharedlink', 'app', 'description',
]

/** Keys naming the other party. */
const PARTY_KEYS = ['from', 'username', 'user', 'sender', 'author', 'to', 'nickname', 'displayname']

const URL_KEYS = ['link', 'url', 'videolink', 'sharedlink', 'weblink']

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_\-.]+/g, '')
}

/** A value that is a bare link and nothing else. */
function isBareUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

function pick(item: Json, candidates: string[]): unknown {
  const normalized = new Map(Object.keys(item).map((k) => [normalizeKey(k), k]))
  for (const candidate of candidates) {
    const actual = normalized.get(candidate)
    if (actual !== undefined) {
      const value = item[actual]
      if (value != null && value !== '') return value
    }
  }
  return undefined
}

export interface WalkRule {
  /** Matched against the lowercased key path, e.g. "activity.searchhistory". */
  test: RegExp
  kind: ParsedAccountEvent['kind']
  label: string
}

export interface WalkOptions {
  rules: WalkRule[]
  /** Applied when no rule matches. Omit to drop unmatched arrays entirely. */
  fallbackKind?: ParsedAccountEvent['kind']
  maxEvents?: number
  maxDepth?: number
  sourceMeta?: Record<string, unknown>
}

function classify(pathKey: string, options: WalkOptions): { kind: ParsedAccountEvent['kind']; label: string } | null {
  for (const rule of options.rules) {
    if (rule.test.test(pathKey)) return { kind: rule.kind, label: rule.label }
  }
  if (options.fallbackKind) return { kind: options.fallbackKind, label: pathKey.split('.').pop() ?? 'entry' }
  return null
}

export function walkDatedArrays(root: unknown, options: WalkOptions): ParsedAccountEvent[] {
  const maxEvents = options.maxEvents ?? 200_000
  const maxDepth = options.maxDepth ?? 12
  const events: ParsedAccountEvent[] = []

  const visit = (node: unknown, pathParts: string[], depth: number): void => {
    if (events.length >= maxEvents || depth > maxDepth || node == null) return

    if (Array.isArray(node)) {
      const pathKey = pathParts.map(normalizeKey).join('.')
      const classified = classify(pathKey, options)

      for (const entry of node) {
        if (events.length >= maxEvents) return
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const item = entry as Json

        const occurredAt = toIso(pick(item, DATE_KEYS))
        if (!occurredAt) {
          // Not an event itself, but it may contain nested event arrays.
          visit(item, pathParts, depth + 1)
          continue
        }
        if (!classified) continue

        const text = pick(item, TEXT_KEYS)
        const party = pick(item, PARTY_KEYS)
        const url = pick(item, URL_KEYS)

        // Direct messages are metadata only. The text keys that carry a search
        // query on one entry carry the body of a private conversation on
        // another, and these exports are structurally identical either way —
        // so for anything classified as a message the body is measured and
        // discarded, never stored. Same rule as the Discord, Meta and iMessage
        // readers.
        const isMessage = classified.kind === 'message'
        const body = typeof text === 'string' ? text : ''

        // A title that is nothing but a URL is not worth carrying. TikTok's
        // watch history has no video titles, only share links whose 19-digit id
        // redaction (correctly) reads as a payment number — so the title would
        // be the same "[REDACTED …]" string on tens of thousands of rows,
        // spending the analysis prompt's budget to say nothing. The link still
        // goes to `url`; the label describes what happened.
        const titleText = body && !isBareUrl(body) ? body : classified.label

        events.push({
          kind: classified.kind,
          occurredAt,
          title: isMessage ? classified.label : titleText,
          detail: classified.label,
          counterparty: typeof party === 'string' ? party : null,
          url: isMessage ? null : typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null,
          sourceMeta: {
            ...(options.sourceMeta ?? {}),
            path: pathKey,
            ...(isMessage ? { length: body.length } : {}),
          },
        })
      }
      return
    }

    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Json)) {
        visit(value, [...pathParts, key], depth + 1)
      }
    }
  }

  visit(root, [], 0)
  return events
}
