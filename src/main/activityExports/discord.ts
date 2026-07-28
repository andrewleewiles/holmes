/**
 * Discord "Request all of my Data".
 *
 * The archive holds `messages/index.json` (channel id → readable name) plus one
 * folder per channel containing `channel.json` and `messages.csv`. The CSVs
 * have embedded newlines in message content, which is why this module uses the
 * record-oriented parser in `./csv` and not the line-splitting ones elsewhere
 * in the codebase.
 *
 * Message *bodies* are read only to measure them — length and attachment count
 * go to `sourceMeta`, the content itself is never stored. That matches how the
 * iMessage reader has always worked and keeps a Discord export from becoming
 * the most sensitive table in the database.
 */

import { findEntriesContaining, readJson, type ExportSource } from './archive'
import { csvColumn, csvValue, parseCsv } from './csv'
import { toIso, type ParsedAccountEvent } from './common'

export function parseDiscordExport(source: ExportSource): ParsedAccountEvent[] {
  const events: ParsedAccountEvent[] = []

  // channel id → human name, when the index is present.
  const index = readJson<Record<string, string>>(source, 'messages/index.json') ?? {}

  for (const entry of findEntriesContaining(source, 'messages.csv')) {
    const text = source.readText(entry)
    if (!text) continue

    // ".../messages/c1234567890/messages.csv" → "c1234567890"
    const folder = entry.split('/').slice(-2, -1)[0] ?? ''
    const channelId = folder.replace(/^c/, '')
    const channelName = index[channelId] || folder || 'channel'

    const { headers, rows } = parseCsv(text)
    if (headers.length === 0) continue

    const timestampCol = csvColumn(headers, 'timestamp', 'date')
    const contentsCol = csvColumn(headers, 'contents', 'content', 'message')
    const attachmentsCol = csvColumn(headers, 'attachments')

    if (timestampCol === -1) continue

    for (const row of rows) {
      const occurredAt = toIso(csvValue(row, timestampCol))
      if (!occurredAt) continue

      const contents = csvValue(row, contentsCol)
      const attachments = csvValue(row, attachmentsCol)

      events.push({
        kind: 'message',
        occurredAt,
        title: `Message in ${channelName}`,
        detail: null,
        counterparty: channelName,
        sourceMeta: {
          provider: 'discord',
          channelId,
          // Metadata about the message, never the message.
          length: contents.length,
          hasAttachment: attachments.length > 0,
        },
      })
    }
  }

  return events
}

export function looksLikeDiscordExport(source: ExportSource): boolean {
  return findEntriesContaining(source, 'messages.csv').length > 0
}
