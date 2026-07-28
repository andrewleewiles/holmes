/**
 * LinkedIn "Get a copy of your data" — a zip of flat CSVs, one per category.
 *
 * LinkedIn's public API returns your name, email and profile photo; the Member
 * Data Portability API that would return this data needs LinkedIn's approval
 * outside the EU. The archive is the practical path.
 */

import { findEntriesContaining, type ExportSource } from './archive'
import { csvColumn, csvValue, parseCsv } from './csv'
import { toIso, type ParsedAccountEvent } from './common'

interface CsvRule {
  file: string
  kind: ParsedAccountEvent['kind']
  label: string
  dateAliases: string[]
  titleAliases: string[]
  partyAliases?: string[]
}

const RULES: CsvRule[] = [
  {
    file: 'connections.csv',
    kind: 'follow',
    label: 'Connection',
    dateAliases: ['connected on', 'connectedon'],
    titleAliases: ['position', 'company'],
    partyAliases: ['first name', 'firstname'],
  },
  {
    file: 'messages.csv',
    kind: 'message',
    label: 'Message',
    dateAliases: ['date'],
    titleAliases: ['subject'],
    partyAliases: ['from', 'to'],
  },
  {
    file: 'searches.csv',
    kind: 'search',
    label: 'Search',
    dateAliases: ['time', 'date'],
    titleAliases: ['search query', 'searchquery', 'query'],
  },
  {
    file: 'shares.csv',
    kind: 'post',
    label: 'Post',
    dateAliases: ['date'],
    titleAliases: ['sharecommentary', 'share commentary'],
  },
  {
    file: 'comments.csv',
    kind: 'comment',
    label: 'Comment',
    dateAliases: ['date'],
    titleAliases: ['message'],
  },
  {
    file: 'job applications.csv',
    kind: 'other',
    label: 'Job application',
    dateAliases: ['application date', 'applicationdate'],
    titleAliases: ['job title', 'jobtitle', 'company name'],
  },
  {
    file: 'logins.csv',
    kind: 'login',
    label: 'Login',
    dateAliases: ['login date', 'logindate', 'date'],
    titleAliases: ['user agent', 'useragent'],
  },
  {
    file: 'reactions.csv',
    kind: 'like',
    label: 'Reaction',
    dateAliases: ['date'],
    titleAliases: ['type'],
  },
]

export function parseLinkedInExport(source: ExportSource): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  for (const rule of RULES) {
    for (const entry of findEntriesContaining(source, rule.file)) {
      const text = source.readText(entry)
      if (!text) continue

      const { headers, rows } = parseCsv(text)
      if (headers.length === 0) continue

      const dateCol = csvColumn(headers, ...rule.dateAliases)
      const titleCol = csvColumn(headers, ...rule.titleAliases)
      const partyCol = rule.partyAliases ? csvColumn(headers, ...rule.partyAliases) : -1
      if (dateCol === -1) continue

      for (const row of rows) {
        const occurredAt = toIso(csvValue(row, dateCol))
        if (!occurredAt) continue
        events.push({
          kind: rule.kind,
          occurredAt,
          title: csvValue(row, titleCol) || rule.label,
          detail: rule.label,
          counterparty: partyCol === -1 ? null : csvValue(row, partyCol) || null,
          sourceMeta: { provider: 'linkedin', file: rule.file },
        })
      }
    }
  }

  return events
}

export function looksLikeLinkedInExport(source: ExportSource): boolean {
  return (
    findEntriesContaining(source, 'connections.csv').length > 0 ||
    findEntriesContaining(source, 'shares.csv').length > 0
  )
}
