/**
 * TikTok "Download your data" (JSON).
 *
 * One `user_data.json` (older exports) or `user_data_tiktok.json` (newer)
 * holding everything. The nesting has been reorganized more than once, so this
 * classifies by key path through the tolerant walker rather than by fixed path.
 */

import { findEntriesContaining, readJson, type ExportSource } from './archive'
import type { ParsedAccountEvent } from './common'
import { walkDatedArrays, type WalkRule } from './walker'

const RULES: WalkRule[] = [
  { test: /browsinghistory|videobrowsing|watchhistory/, kind: 'watch', label: 'Watched' },
  { test: /searchhistory/, kind: 'search', label: 'Search' },
  { test: /likelist|favoritevideo|favorite/, kind: 'like', label: 'Like' },
  { test: /followinglist|followerlist/, kind: 'follow', label: 'Follow' },
  { test: /chathistory|directmessage/, kind: 'message', label: 'Direct message' },
  { test: /loginhistory/, kind: 'login', label: 'Login' },
  { test: /comment/, kind: 'comment', label: 'Comment' },
  { test: /post|video/, kind: 'post', label: 'Post' },
  { test: /purchase|order/, kind: 'purchase', label: 'Purchase' },
]

export function parseTikTokExport(source: ExportSource): ParsedAccountEvent[] {
  const entries = findEntriesContaining(source, 'user_data')
  const events: ParsedAccountEvent[] = []

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue
    const payload = readJson<unknown>(source, entry)
    if (!payload) continue
    events.push(...walkDatedArrays(payload, { rules: RULES, sourceMeta: { provider: 'tiktok' } }))
  }

  return events
}

export function looksLikeTikTokExport(source: ExportSource): boolean {
  return findEntriesContaining(source, 'user_data').some((e) => e.toLowerCase().endsWith('.json'))
}
