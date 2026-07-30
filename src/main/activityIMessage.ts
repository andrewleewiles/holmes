/**
 * iMessage as an Activity account.
 *
 * This is the only account in the registry that is genuinely live with no
 * network call and no credential — the database is already on the machine. The
 * cost is a TCC grant: without Full Disk Access, opening chat.db fails with
 * SQLITE_CANTOPEN and the record goes to `needs_permission`, which is what
 * drives the "Grant Full Disk Access" button on the Data page.
 *
 * Message text is read along with the metadata, at the user's request. This is
 * a deliberate departure from `src/main/imessage.ts`, which stays aggregates-only
 * because it feeds relationship analysis; the Activity account is the place the
 * conversation itself is wanted. Bodies are excerpted to the same 500 characters
 * the .mbox email importer uses, and — like every other Activity field — they go
 * through `redactActivityContent` before storage, so addresses, tokens, keys and
 * card numbers never land in the table.
 *
 * The other accounts in the registry (TikTok, Meta, Discord) remain
 * metadata-only; this is not a general relaxation.
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as database from './database'
import { appleDateToUnix } from './imessage'
import { lookupContact, readContactIndex, type ContactIndex } from './contactsDb'
import { isOpenPermissionError } from './activityKnowledge'
import { messageBodyText } from './imessageBody'
import { emitProgress, writeAccountEvents, type ParsedAccountEvent, type ProgressSender } from './activityExports/common'
import type { ActivityAccountSyncResult, ActivityRecord } from '../shared/types'

const IMESSAGE_DB = path.join(os.homedir(), 'Library/Messages/chat.db')

/** Sentinel filename for the live record, matching the knowledgeC convention. */
const LIVE_FILENAME = 'imessage-live'

/** Ceiling on one sync, so a first run over a decade of history stays bounded. */
const MAX_MESSAGES_PER_SYNC = 200_000

/** Matches MAX_BODY_EXCERPT_CHARS in the .mbox email importer. */
const MAX_BODY_EXCERPT_CHARS = 500

/**
 * Stamped on every event. Because syncing is incremental — each run only reads
 * messages newer than the newest one stored — a change to what an event
 * *contains* would otherwise never reach rows already written: the watermark
 * says there is nothing new, and the old shape survives forever. Bumping this
 * forces one full re-import so existing rows are rebuilt in the current shape.
 *
 * 1: metadata only.
 * 2: message body excerpt, and contact names from the AddressBook store.
 * 3: sent messages attributed through the chat they belong to (see the query).
 */
const SYNC_FORMAT_VERSION = 3

interface MessageRow {
  date: number
  is_from_me: number
  handle_id: string | null
  service: string | null
  text: string | null
  attributed_body: Buffer | null
  has_attachment: number
}

/** Read once per process; the AddressBook store does not change mid-sync. */
let contactIndexCache: ContactIndex | null = null

function contactIndex(): ContactIndex {
  if (!contactIndexCache) contactIndexCache = readContactIndex()
  return contactIndexCache
}

/**
 * Turns a raw handle into something safe to store. A known contact becomes
 * their name; anything else becomes a stable pseudonym, because a bare phone
 * number is exactly the kind of identifier that should not sit in a table that
 * later feeds a model. The pseudonym is deterministic, so counting how often
 * one unknown number appears still works.
 */
function identify(handle: string | null): string | null {
  if (!handle) return null
  const trimmed = handle.trim()
  if (!trimmed) return null

  const known = lookupContact(contactIndex(), trimmed)
  if (known) return known

  const fingerprint = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 6)
  return `contact-${fingerprint}`
}

function openChatDb(): Database.Database {
  return new Database(IMESSAGE_DB, { readonly: true, fileMustExist: true })
}

/** Newest event already stored, so each sync only reads what arrived since. */
function watermark(recordId: string): number | null {
  const latest = database.listAccountEvents(recordId, { limit: 1 })[0]
  if (!latest) return null
  const ms = Date.parse(latest.occurredAt)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/** True when the stored rows were written by an older event shape. */
function needsRebuild(recordId: string): boolean {
  const latest = database.listAccountEvents(recordId, { limit: 1 })[0]
  if (!latest) return false
  const stored = latest.sourceMeta?.v
  return typeof stored !== 'number' || stored < SYNC_FORMAT_VERSION
}

export async function syncIMessageActivity(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ProgressSender
): Promise<ActivityAccountSyncResult> {
  if (!fs.existsSync(IMESSAGE_DB)) {
    return { provider: 'imessage', status: 'skipped', eventsCount: 0, message: 'No iMessage database on this Mac' }
  }

  let record: ActivityRecord
  const existing = database.findLiveActivityRecord(projectId, 'account', LIVE_FILENAME)
  if (existing) {
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'account',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  emitProgress(sendProgress, 'imessage', 'reading', 'Opening the Messages database', null, null, record.id)

  let db: Database.Database
  try {
    db = openChatDb()
  } catch (err) {
    if (isOpenPermissionError(err)) {
      const message = err instanceof Error ? err.message : String(err)
      database.needsPermissionActivityRecord(record.id, `Full Disk Access required: ${message}`)
      emitProgress(sendProgress, 'imessage', 'permission', 'Full Disk Access required', null, null, record.id)
      return {
        provider: 'imessage',
        status: 'needs_permission',
        eventsCount: 0,
        message: 'Full Disk Access required',
      }
    }
    throw err
  }

  try {
    // Rows written by an older event shape are rebuilt rather than left behind.
    const rebuilding = needsRebuild(record.id)
    if (rebuilding) {
      emitProgress(sendProgress, 'imessage', 'reading', 'Rebuilding stored messages in the current format', null, null, record.id)
      database.resetActivityRecord(record.id)
    }
    const since = rebuilding ? null : watermark(record.id)

    // `message.date` is Apple-epoch and has been both seconds and nanoseconds
    // across macOS versions, so the cutoff is converted the same way the rows
    // are rather than assumed. Both text columns are selected: modern macOS
    // leaves `text` null on most rows and puts the body in `attributedBody`,
    // so reading only the former would drop roughly seventy percent of the
    // conversation without reporting anything wrong.
    //
    // `message.handle_id` is 0 on most rows the user SENT — 78% of them on this
    // machine — because the column records who the message came from, and a
    // sent message came from nobody. Read on its own it silently drops the
    // owner's half of nearly every thread, which is how a person's year summary
    // ends up reporting that the owner never speaks. The chat a message belongs
    // to knows the other party, so an unattributed message falls back to it, and
    // only when that chat has exactly one participant: attributing a sent group
    // message to one member would be an invented one-to-one relationship, which
    // is the failure this codebase is most careful about. `imessage.ts` has
    // always resolved counterparties this way; this importer did not.
    const rows = db
      .prepare(
        `SELECT m.date            AS date,
                m.is_from_me      AS is_from_me,
                COALESCE(h.id, (
                  SELECT ch.id
                  FROM chat_message_join cmj
                  JOIN chat_handle_join chj ON chj.chat_id = cmj.chat_id
                  JOIN handle ch ON ch.ROWID = chj.handle_id
                  WHERE cmj.message_id = m.ROWID
                    AND (SELECT COUNT(*) FROM chat_handle_join p WHERE p.chat_id = cmj.chat_id) = 1
                  LIMIT 1
                ))               AS handle_id,
                m.service         AS service,
                m.text            AS text,
                m.attributedBody  AS attributed_body,
                CASE WHEN m.cache_has_attachments = 1 THEN 1 ELSE 0 END AS has_attachment
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         ORDER BY m.date DESC
         LIMIT ?`
      )
      .all(MAX_MESSAGES_PER_SYNC) as MessageRow[]

    const events: ParsedAccountEvent[] = []
    for (const row of rows) {
      if (signal?.aborted) break
      if (typeof row.date !== 'number') continue

      const unix = appleDateToUnix(row.date)
      if (since !== null && unix <= since) continue

      const counterparty = identify(row.handle_id)
      const outgoing = row.is_from_me === 1

      const body = messageBodyText(row.text, row.attributed_body)
      const excerpt = body ? body.slice(0, MAX_BODY_EXCERPT_CHARS) : null

      events.push({
        kind: 'message',
        occurredAt: new Date(unix * 1000).toISOString(),
        title: outgoing ? `Message to ${counterparty ?? 'unknown'}` : `Message from ${counterparty ?? 'unknown'}`,
        // Redacted on the way in by writeAccountEvents, like every other field.
        detail: excerpt,
        counterparty,
        sourceMeta: {
          v: SYNC_FORMAT_VERSION,
          provider: 'imessage',
          direction: outgoing ? 'sent' : 'received',
          service: row.service ?? null,
          length: body?.length ?? 0,
          truncated: Boolean(body && body.length > MAX_BODY_EXCERPT_CHARS),
          hasAttachment: row.has_attachment === 1,
        },
      })
    }

    emitProgress(
      sendProgress,
      'imessage',
      'storing',
      `Storing ${events.length} message events`,
      0,
      events.length,
      record.id
    )

    const written = writeAccountEvents(record.id, 'imessage', events, signal)
    // A rebuild replaced the record's events, so its count is what was just
    // written; an incremental run adds to what was already there.
    database.completeActivityRecord(record.id, rebuilding ? written : (existing?.eventsCount ?? 0) + written)
    database.touchActivityRecordImportedAt(record.id)

    emitProgress(
      sendProgress,
      'imessage',
      'complete',
      rebuilding ? `Rebuilt ${written} messages` : `Synced ${written} new messages`,
      written,
      written,
      record.id
    )
    return { provider: 'imessage', status: 'synced', eventsCount: written }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'iMessage sync failed'
    database.failActivityRecord(record.id, message)
    return { provider: 'imessage', status: 'error', eventsCount: 0, message }
  } finally {
    try {
      db.close()
    } catch {
      // Closing a database that failed to open properly is not interesting.
    }
  }
}
