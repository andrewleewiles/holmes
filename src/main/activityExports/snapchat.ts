/**
 * Snapchat "My Data" — a zip of per-category JSON files
 * (chat_history.json, snap_history.json, friends.json, location_history.json…).
 *
 * Snap has no read API of any kind for personal activity: Login Kit returns a
 * display name and a Bitmoji. This export is the only path.
 */

import { findEntriesContaining, readJson, type ExportSource } from './archive'
import type { ParsedAccountEvent } from './common'
import { walkDatedArrays, type WalkRule } from './walker'

const RULES: WalkRule[] = [
  { test: /chathistory|received|sent/, kind: 'message', label: 'Chat' },
  { test: /snaphistory/, kind: 'message', label: 'Snap' },
  { test: /friend/, kind: 'follow', label: 'Friend' },
  { test: /search/, kind: 'search', label: 'Search' },
  { test: /login|account/, kind: 'login', label: 'Login' },
  { test: /story|memories/, kind: 'post', label: 'Story' },
  { test: /purchase/, kind: 'purchase', label: 'Purchase' },
]

/** Category files worth reading. Everything else in the archive is settings. */
const CATEGORIES = [
  'chat_history.json',
  'snap_history.json',
  'friends.json',
  'story_history.json',
  'account_history.json',
  'search_history.json',
  'talk_history.json',
]

export function parseSnapchatExport(source: ExportSource): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  for (const category of CATEGORIES) {
    for (const entry of findEntriesContaining(source, category)) {
      const payload = readJson<unknown>(source, entry)
      if (!payload) continue
      events.push(...walkDatedArrays(payload, { rules: RULES, sourceMeta: { provider: 'snapchat' } }))
    }
  }

  return events
}

export function looksLikeSnapchatExport(source: ExportSource): boolean {
  return (
    findEntriesContaining(source, 'snap_history.json').length > 0 ||
    findEntriesContaining(source, 'chat_history.json').length > 0
  )
}
