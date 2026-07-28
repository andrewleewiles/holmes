import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'
import * as database from './database'
import type { ActivityRecord, ActivityIngestProgress, KnowledgeEvent } from '../shared/types'
import type { ActivityProgressSender } from './activity'

const BATCH_SIZE = 1000
const MAX_EVENTS_PER_FILE = 2_000_000

const SYSTEM_BUNDLE_BLOCKLIST = new Set([
  'Receive',
  'com.apple.notificationcenter',
  'com.apple.notificationcenterui',
  'notificationd',
  'com.apple.OSDUI',
  'com.apple.system_preferences',
])

const BUNDLE_NAME_OVERRIDES: Record<string, string> = {
  'com.apple.Safari': 'Safari',
  'com.apple.Chrome': 'Chrome',
  'com.google.chrome': 'Chrome',
  'com.brave.Browser': 'Brave',
  'com.microsoft.edgemac': 'Edge',
  'org.mozilla.firefox': 'Firefox',
  'com.apple.Terminal': 'Terminal',
  'com.apple.dt.Xcode': 'Xcode',
  'com.todesktop.230313mct4l4': 'Cursor',
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.apple.MobileSMS': 'Messages',
  'com.apple.MobileMail': 'Mail',
  'com.apple.iCal': 'Calendar',
  'com.apple.Notes': 'Notes',
  'com.apple.Reminders': 'Reminders',
  'com.apple.finder': 'Finder',
  'com.apple.dock': 'Dock',
  'com.apple.systemuiserver': 'System UI',
  'com.apple.spotlight': 'Spotlight',
}

const KNOWLEDGE_DB_PATH = path.join(os.homedir(), 'Library/Application Support/Knowledge/knowledgeC.db')

function safeAbort(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
}

function emit(
  sendProgress: ActivityProgressSender | undefined,
  phase: ActivityIngestProgress['phase'],
  message: string,
  current: number | null,
  total: number | null,
  recordId: string,
  sourceType: ActivityIngestProgress['sourceType']
): void {
  if (!sendProgress) return
  sendProgress({ phase, message, current, total, recordId, sourceType })
}

function freshActivityRecord(recordId: string): ActivityRecord {
  const fresh = database.getActivityRecord(recordId)
  if (fresh) return fresh
  return {
    id: recordId,
    projectId: '',
    sourceType: 'knowledge',
    filename: null,
    fileSize: null,
    contentHash: null,
    importedAt: new Date().toISOString(),
    status: 'parsed',
    parseError: null,
    eventsCount: 0,
  }
}

function macAbsoluteToIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date((value + 978307200) * 1000).toISOString()
}

export function isOpenPermissionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  if (code === 'SQLITE_CANTOPEN') return true
  const message = err instanceof Error ? err.message : String(err)
  if (/SQLITE_CANTOPEN/i.test(message)) return true
  if (/operation not permitted/i.test(message)) return true
  if (/permission/i.test(message)) return true
  return false
}

export async function ingestKnowledgeC(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const LIVE_FILENAME = 'knowledgeC.db'
  const existing = database.findLiveActivityRecord(projectId, 'knowledge', LIVE_FILENAME)
  let record: ActivityRecord
  if (existing) {
    database.resetActivityRecord(existing.id)
    database.touchActivityRecordImportedAt(existing.id)
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'knowledge',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  let db: Database.Database | null = null
  try {
    if (safeAbort(signal)) throw new Error('KnowledgeC ingest cancelled')
    emit(sendProgress, 'reading', 'Opening KnowledgeC.db', 0, null, record.id, 'knowledge')

    try {
      db = new Database(KNOWLEDGE_DB_PATH, { readonly: true })
      db.pragma('query_only = ON')
    } catch (err) {
      if (isOpenPermissionError(err)) {
        const message = err instanceof Error ? err.message : String(err)
        database.needsPermissionActivityRecord(record.id, `Full Disk Access required: ${message}`)
        emit(sendProgress, 'permission', 'Full Disk Access required', null, null, record.id, 'knowledge')
        return freshActivityRecord(record.id)
      }
      throw err
    }

    if (safeAbort(signal)) throw new Error('KnowledgeC ingest cancelled')

    const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    const zobjectTable = tableInfo.find((t) => t.name.toUpperCase() === 'ZOBJECT')
    if (!zobjectTable) throw new Error('ZOBJECT table not found in KnowledgeC.db')
    const tableName = zobjectTable.name
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    const colNames = cols.map((c) => c.name)
    const findCol = (candidates: string[]): string | null => {
      for (const c of candidates) {
        const match = colNames.find((n) => n.toUpperCase() === c.toUpperCase())
        if (match) return match
      }
      return null
    }
    const streamCol = findCol(['ZSTREAMNAME', 'ZSTREAM'])
    const valueCol = findCol(['ZVALUESTRING', 'ZVALUE', 'ZVALUESTR'])
    const startCol = findCol(['ZSTARTDATETIME', 'ZSTARTDATE', 'ZTIMEINTERVALSTART', 'ZTIMESTAMP'])
    const endCol = findCol(['ZENDDATETIME', 'ZENDDATE', 'ZTIMEINTERVALEND'])
    if (!streamCol || !startCol) {
      throw new Error(`KnowledgeC.db schema unrecognized. Available columns: ${colNames.join(', ')}`)
    }

    const selectCols = [
      `${streamCol} AS stream`,
      valueCol ? `${valueCol} AS value` : 'NULL AS value',
      `${startCol} AS start`,
      endCol ? `${endCol} AS end` : 'NULL AS end',
    ].join(', ')

    const rowStmt = db.prepare(
      `SELECT ${selectCols}
       FROM ${tableName}
       WHERE ${streamCol} IN ('/app/inFocus', '/display/isBacklit', '/notification/usage')
       ORDER BY ${startCol} ASC
       LIMIT ? OFFSET ?`
    )

    let offset = 0
    let total = 0

    while (true) {
      if (safeAbort(signal)) throw new Error('KnowledgeC ingest cancelled')
      const batch = rowStmt.all(BATCH_SIZE, offset) as Array<{
        stream: string | null
        value: string | null
        start: number | null
        end: number | null
      }>
      if (batch.length === 0) break

      database.runInTransaction(() => {
        for (const row of batch) {
          const streamName = row.stream
          const occurredAt = macAbsoluteToIso(row.start)
          if (!occurredAt) continue
          if (!streamName) continue

          let eventType: KnowledgeEvent['eventType'] | null = null
          let bundleId: string | null = null
          let durationSeconds: number | null = null

          if (streamName === '/app/inFocus') {
            eventType = 'app_open'
            bundleId = row.value ?? null
            if (typeof row.end === 'number' && typeof row.start === 'number' && Number.isFinite(row.end - row.start)) {
              durationSeconds = Math.max(0, row.end - row.start)
            }
          } else if (streamName === '/display/isBacklit') {
            if (row.value === '0') continue
            eventType = 'screen_on'
            if (typeof row.end === 'number' && typeof row.start === 'number' && Number.isFinite(row.end - row.start)) {
              durationSeconds = Math.max(0, row.end - row.start)
            }
          } else if (streamName === '/notification/usage') {
            const rawValue = row.value ?? ''
            if (SYSTEM_BUNDLE_BLOCKLIST.has(rawValue)) continue
            eventType = 'notification'
            bundleId = rawValue || null
          } else {
            continue
          }

          const appName = bundleId ? (BUNDLE_NAME_OVERRIDES[bundleId] ?? bundleId) : null

          database.createKnowledgeEvent({
            recordId: record.id,
            occurredAt,
            bundleId,
            appName,
            eventType,
            durationSeconds,
            sourceMeta: { streamName },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })

      offset += batch.length
      emit(sendProgress, 'storing', `Imported ${total} knowledge events`, total, null, record.id, 'knowledge')
      if (total >= MAX_EVENTS_PER_FILE) break
      if (batch.length < BATCH_SIZE) break
    }

    if (safeAbort(signal)) throw new Error('KnowledgeC ingest cancelled')
    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} knowledge events`, total, total, record.id, 'knowledge')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isOpenPermissionError(err)) {
      database.needsPermissionActivityRecord(record.id, `Full Disk Access required: ${message}`)
      emit(sendProgress, 'permission', 'Full Disk Access required', null, null, record.id, 'knowledge')
      return freshActivityRecord(record.id)
    }
    database.failActivityRecord(record.id, message)
    throw err
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}
