/**
 * YouTube watch history from Takeout's HTML form.
 *
 * `activity.ts` already ingests `watch-history.json`, but Takeout only produces
 * JSON when the user changes the export format away from its default — a real
 * archive contains `watch-history.html` and the JSON path finds nothing at all.
 * The markup is the same MDL structure My Activity uses, so the block parser is
 * shared; only the interpretation differs.
 *
 * These events go to `youtube_events` rather than `account_events`, because the
 * table and its analysis path predate the account registry and already
 * understand the shape (title, channel, url).
 */

import path from 'path'
import * as database from '../database'
import { redactActivityContent } from '../activity'
import type { ActivityRecord } from '../../shared/types'
import { findEntries, findEntriesContaining, type ExportSource } from './archive'
import { emitProgress, exportIdentityHash, exportSize, type ProgressSender } from './common'
import {
  parseGoogleActivityHtmlFile,
  parseGoogleActivityHtmlText,
  type ActivityBlock,
} from './googleHtml'

const BATCH_SIZE = 1000

interface WatchEvent {
  occurredAt: string
  title: string | null
  channel: string | null
  url: string | null
}

/**
 * A watch-history block is "Watched <a>video</a><br><a>channel</a><br>date".
 * Ads and removed videos appear with no anchor at all; they are still real
 * activity, so they keep their lead text as the title.
 */
export function watchEventFromBlock(block: ActivityBlock): WatchEvent | null {
  if (block.product && !/youtube/i.test(block.product)) return null

  const [video, channel] = block.links
  const title = video?.text || block.lead
  if (!title) return null

  return {
    occurredAt: block.occurredAt,
    title,
    // The second link is the channel; a single-link entry has none.
    channel: channel?.text ?? null,
    url: video?.url ?? null,
  }
}

/**
 * True when this source carries YouTube history in either format.
 *
 * `findEntries` matches any of the suffixes; `findEntriesContaining` would
 * require an entry to contain them all, which no single file ever does.
 */
export function looksLikeYouTubeHistory(source: ExportSource): boolean {
  return findEntries(source, 'watch-history.html', 'watch-history.json').length > 0
}

function collectWatchEvents(source: ExportSource): WatchEvent[] {
  const events: WatchEvent[] = []

  for (const entry of findEntriesContaining(source, 'watch-history.html')) {
    const onDisk = source.entryPath(entry)
    if (onDisk) {
      events.push(...parseGoogleActivityHtmlFile(onDisk, watchEventFromBlock))
    } else {
      const text = source.readText(entry)
      if (text) events.push(...parseGoogleActivityHtmlText(text, watchEventFromBlock))
    }
  }

  return events
}

/**
 * Ingests YouTube watch history from a Takeout HTML export. Mirrors the record
 * lifecycle and hash dedupe every other Activity importer uses.
 */
export async function ingestYouTubeHistoryHtml(
  filePath: string,
  projectId: string,
  source: ExportSource,
  signal?: AbortSignal,
  send?: ProgressSender
): Promise<ActivityRecord> {
  const identity = exportIdentityHash(filePath)

  const existing = database.findActivityRecord(projectId, 'youtube', identity)
  if (existing && existing.status === 'parsed') {
    database.touchActivityRecordImportedAt(existing.id)
    emitProgress(send, 'youtube', 'complete', 'Already imported — nothing new', null, null, existing.id)
    return existing
  }

  const record = database.createActivityRecord({
    projectId,
    sourceType: 'youtube',
    filename: path.basename(filePath),
    fileSize: exportSize(filePath),
    contentHash: identity,
  })

  try {
    emitProgress(send, 'youtube', 'parsing', 'Reading YouTube watch history', null, null, record.id)
    const events = collectWatchEvents(source)

    if (signal?.aborted) {
      database.failActivityRecord(record.id, 'Import aborted')
      return database.getActivityRecord(record.id) ?? record
    }

    emitProgress(send, 'youtube', 'storing', `Storing ${events.length} watch events`, 0, events.length, record.id)

    let written = 0
    for (let offset = 0; offset < events.length; offset += BATCH_SIZE) {
      if (signal?.aborted) break
      const batch = events.slice(offset, offset + BATCH_SIZE)
      database.runInTransaction(() => {
        for (const event of batch) {
          database.createYoutubeEvent({
            recordId: record.id,
            occurredAt: event.occurredAt,
            // Redacted like every other Activity field before it is stored.
            title: event.title ? redactActivityContent(event.title) : null,
            channel: event.channel ? redactActivityContent(event.channel) : null,
            url: event.url ? redactActivityContent(event.url) : null,
            durationSeconds: null,
            sourceMeta: { provider: 'youtube', format: 'html' },
          })
          written += 1
        }
      })
    }

    database.completeActivityRecord(record.id, written)
    emitProgress(send, 'youtube', 'complete', `Imported ${written} watch events`, written, written, record.id)
    return database.getActivityRecord(record.id) ?? record
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YouTube import failed'
    database.failActivityRecord(record.id, message)
    throw err
  }
}
