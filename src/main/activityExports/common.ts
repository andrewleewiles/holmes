/**
 * The scaffolding every account export parser shares: identity hashing so a
 * re-scan is free, record lifecycle, batched writes, and the redaction pass
 * that no parser is allowed to skip.
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as database from './../database'
import { redactActivityContent } from './../activity'
import type {
  AccountEventKind,
  ActivityIngestProgress,
  ActivityProviderId,
  ActivityRecord,
} from '../../shared/types'

/** Rows per transaction, matching the batch size the other ingest paths use. */
export const BATCH_SIZE = 1000

/** Refuse to write more than this from one archive. */
export const MAX_EVENTS_PER_EXPORT = 500_000

/** Content hashing is capped; past this we fall back to a stat identity. */
const MAX_HASH_BYTES = 64 * 1024 * 1024

export type ProgressSender = (progress: ActivityIngestProgress) => void

/** A parsed event, before it is redacted and written. */
export interface ParsedAccountEvent {
  kind: AccountEventKind
  occurredAt: string
  title?: string | null
  detail?: string | null
  counterparty?: string | null
  url?: string | null
  sourceMeta?: Record<string, unknown>
}

export function emitProgress(
  send: ProgressSender | undefined,
  provider: ActivityProviderId,
  phase: ActivityIngestProgress['phase'],
  message: string,
  current: number | null = null,
  total: number | null = null,
  recordId: string | null = null
): void {
  if (!send) return
  send({ phase, message, current, total, recordId, sourceType: 'account', provider })
}

/**
 * Identifies an export without re-reading it every scan. A file under the cap
 * is hashed; anything larger, and every folder, gets a stat identity instead —
 * an unzipped Takeout is not something to re-hash every fifteen minutes.
 */
export function exportIdentityHash(targetPath: string): string {
  const hash = crypto.createHash('sha256')
  try {
    const stat = fs.statSync(targetPath)

    if (stat.isFile() && stat.size <= MAX_HASH_BYTES) {
      hash.update(fs.readFileSync(targetPath))
      return hash.digest('hex').slice(0, 32)
    }

    if (stat.isFile()) {
      hash.update(`${path.resolve(targetPath)}|${stat.size}|${stat.mtimeMs}`)
      return hash.digest('hex').slice(0, 32)
    }

    // Folder: the sorted list of names, sizes and mtimes is enough to notice a
    // new export dropped alongside the old one.
    const parts: string[] = []
    const queue = [targetPath]
    let inspected = 0
    while (queue.length > 0 && inspected < 20_000) {
      const dir = queue.shift()
      if (!dir) break
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          queue.push(full)
        } else if (entry.isFile()) {
          try {
            const s = fs.statSync(full)
            parts.push(`${path.relative(targetPath, full)}|${s.size}|${Math.round(s.mtimeMs)}`)
          } catch {
            // An unreadable member simply does not contribute to the identity.
          }
          inspected += 1
        }
      }
    }
    parts.sort()
    hash.update(parts.join('\n'))
    return hash.digest('hex').slice(0, 32)
  } catch {
    hash.update(path.resolve(targetPath))
    return hash.digest('hex').slice(0, 32)
  }
}

export function exportSize(targetPath: string): number {
  try {
    const stat = fs.statSync(targetPath)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

/**
 * Redacts every free-text field on an event. This is the choke point: a parser
 * that builds `ParsedAccountEvent`s and writes them through `writeAccountEvents`
 * cannot forget to redact, because it never touches the database itself.
 */
function redactEvent(event: ParsedAccountEvent): ParsedAccountEvent {
  const scrub = (value: string | null | undefined): string | null => {
    if (value == null) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    return redactActivityContent(trimmed)
  }
  return {
    ...event,
    title: scrub(event.title),
    detail: scrub(event.detail),
    counterparty: scrub(event.counterparty),
    url: scrub(event.url),
  }
}

/** Writes parsed events in batches. Returns how many landed. */
export function writeAccountEvents(
  recordId: string,
  provider: ActivityProviderId,
  events: ParsedAccountEvent[],
  signal?: AbortSignal
): number {
  const capped = events.slice(0, MAX_EVENTS_PER_EXPORT)
  let written = 0

  for (let offset = 0; offset < capped.length; offset += BATCH_SIZE) {
    if (signal?.aborted) break
    const batch = capped.slice(offset, offset + BATCH_SIZE)
    database.runInTransaction(() => {
      for (const raw of batch) {
        const event = redactEvent(raw)
        database.createAccountEvent({
          recordId,
          provider,
          kind: event.kind,
          occurredAt: event.occurredAt,
          title: event.title ?? null,
          detail: event.detail ?? null,
          counterparty: event.counterparty ?? null,
          url: event.url ?? null,
          sourceMeta: event.sourceMeta ?? {},
        })
        written += 1
      }
    })
  }

  return written
}

/**
 * The full ingest wrapper: dedupe on identity, create the record, run the
 * parser, write and complete. A parser only has to turn a source into events.
 */
export async function ingestExport(
  provider: ActivityProviderId,
  projectId: string,
  targetPath: string,
  parse: () => Promise<ParsedAccountEvent[]> | ParsedAccountEvent[],
  signal?: AbortSignal,
  send?: ProgressSender
): Promise<ActivityRecord> {
  const identity = exportIdentityHash(targetPath)

  // Already ingested and unchanged — touch it so the UI shows it was checked.
  const existing = database.findActivityRecord(projectId, 'account', identity)
  if (existing && existing.status === 'parsed') {
    database.touchActivityRecordImportedAt(existing.id)
    emitProgress(send, provider, 'complete', 'Already imported — nothing new', null, null, existing.id)
    return existing
  }

  const record = database.createActivityRecord({
    projectId,
    sourceType: 'account',
    filename: path.basename(targetPath),
    fileSize: exportSize(targetPath),
    contentHash: identity,
  })

  try {
    emitProgress(send, provider, 'parsing', `Reading ${path.basename(targetPath)}`, null, null, record.id)
    const events = await parse()

    if (signal?.aborted) {
      database.failActivityRecord(record.id, 'Import aborted')
      return database.getActivityRecord(record.id) ?? record
    }

    emitProgress(send, provider, 'storing', `Storing ${events.length} events`, 0, events.length, record.id)
    const written = writeAccountEvents(record.id, provider, events, signal)

    database.completeActivityRecord(record.id, written)
    emitProgress(send, provider, 'complete', `Imported ${written} events`, written, written, record.id)
    return database.getActivityRecord(record.id) ?? record
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Import failed'
    database.failActivityRecord(record.id, message)
    throw err
  }
}

/**
 * Normalizes the many timestamp shapes these exports use into an ISO string.
 * Returns null rather than guessing when nothing parses — an event dated to the
 * epoch is worse than an event dropped.
 */
export function toIso(value: unknown): string | null {
  if (value == null) return null

  if (typeof value === 'number') {
    // Heuristic on magnitude: seconds, milliseconds, or microseconds.
    let ms = value
    if (value > 1e15) ms = value / 1000
    else if (value < 1e11) ms = value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    if (/^\d+$/.test(trimmed)) return toIso(Number(trimmed))

    const direct = new Date(trimmed)
    if (!Number.isNaN(direct.getTime())) return direct.toISOString()

    // "2024-03-11 14:02:55 UTC" and friends.
    const cleaned = trimmed.replace(/\s+UTC$/i, 'Z').replace(' ', 'T')
    const retry = new Date(cleaned)
    if (!Number.isNaN(retry.getTime())) return retry.toISOString()
  }

  return null
}
