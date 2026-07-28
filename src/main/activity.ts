import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import Database from 'better-sqlite3'
import { redactMemoryContent } from './memory'
import * as database from './database'
import { assertPathAllowed } from './fileScope'
import { collectProjectDataFiles } from './projectContext'
import { getSettings } from './settings'
import type {
  ActivityRecord,
  ActivitySourceType,
  ActivityIngestProgress,
  DirectoryScanResult,
  EmailEvent,
} from '../shared/types'
import { ingestAmazonFile } from './activityAmazon'
import { ingestSubscriptionFile } from './activitySubscriptions'

export function redactActivityContent(value: string): string {
  return redactMemoryContent(value)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED EMAIL]')
    .replace(/[?&](utm_[a-z_]+|gclid|fbclid|mc_cid|mc_eid|ref|ref_?|icmp|subId|tag)=[^&\s]+/gi, '')
    .replace(/[?&](access_token|id_token|code|token|session_id|sessionId|auth)=[^&\s]+/gi, '$1=[REDACTED]')
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED IP]')
}

export function redactEmailContent(value: string, allowlistAddress: string = ''): string {
  let working = value
  if (allowlistAddress) {
    const escaped = allowlistAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const allowRe = new RegExp(escaped, 'gi')
    working = working.replace(allowRe, '\x00ALLOWED\x00')
  }
  working = redactActivityContent(working)
  working = working.replace(/\bMessage-ID:[^\n]+/gi, 'Message-ID: [REDACTED]')
  working = working.replace(/\bIn-Reply-To:[^\n]+/gi, 'In-Reply-To: [REDACTED]')
  working = working.replace(/\bReferences:[^\n]+/gi, 'References: [REDACTED]')
  if (allowlistAddress) {
    working = working.replace(/\x00ALLOWED\x00/g, allowlistAddress)
  }
  return working
}

const BATCH_SIZE = 1000
const MAX_YOUTUBE_BYTES = 50 * 1024 * 1024
const MAX_BROWSER_JSON_BYTES = 50 * 1024 * 1024
// The mbox parser streams line by line and flushes in batches, so peak memory
// does not scale with file size; the old 16 MB ceiling rejected every real
// Gmail Takeout (a full mailbox is commonly several gigabytes). What actually
// bounds the work is MAX_EVENTS_PER_FILE, which still applies.
const MAX_MBOX_BYTES = 16 * 1024 * 1024 * 1024
const MAX_LOCATION_BYTES = 100 * 1024 * 1024
const MAX_EVENTS_PER_FILE = 2_000_000
const MAX_BODY_EXCERPT_CHARS = 500

export type ActivityProgressSender = (progress: ActivityIngestProgress) => void

function hashContent(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function safeAbort(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted)
}

function makeActivityRecord(
  projectId: string,
  sourceType: ActivitySourceType,
  filename: string | null,
  size: number | null,
  contentHash: string | null
): ActivityRecord {
  return database.createActivityRecord({
    projectId,
    sourceType,
    filename,
    fileSize: size,
    contentHash,
  })
}

function completeActivityRecordEx(recordId: string, eventsCount: number): void {
  database.completeActivityRecord(recordId, eventsCount)
}

function failActivityRecordEx(recordId: string, message: string): void {
  database.failActivityRecord(recordId, message)
}

function freshActivityRecord(recordId: string): ActivityRecord {
  const fresh = database.getActivityRecord(recordId)
  if (fresh) return fresh
  return {
    id: recordId,
    projectId: '',
    sourceType: 'browser',
    filename: null,
    fileSize: null,
    contentHash: null,
    importedAt: new Date().toISOString(),
    status: 'parsed',
    parseError: null,
    eventsCount: 0,
  }
}

function computeFileHash(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return hashContent(buf)
}

/** Past this, a file is identified by its stat rather than its contents. */
const MAX_HASH_BYTES = 64 * 1024 * 1024

/**
 * Identifies a file without reading all of it. `computeFileHash` reads the
 * whole thing into memory, which is fine for a browser history database and
 * impossible for a Gmail Takeout mbox — a real one is several gigabytes. Above
 * the threshold the path, size and mtime stand in, the same trade the Apple
 * Health importer makes (`health_records.identity_hash`) for the same reason.
 */
function computeFileIdentity(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size <= MAX_HASH_BYTES) return computeFileHash(filePath)
    return crypto
      .createHash('sha256')
      .update(`${path.resolve(filePath)}|${stat.size}|${Math.round(stat.mtimeMs)}`)
      .digest('hex')
      .slice(0, 32)
  } catch {
    return null
  }
}

function emit(
  sendProgress: ActivityProgressSender | undefined,
  phase: ActivityIngestProgress['phase'],
  message: string,
  current: number | null,
  total: number | null,
  recordId: string,
  sourceType: ActivitySourceType
): void {
  if (!sendProgress) return
  sendProgress({ phase, message, current, total, recordId, sourceType })
}

export function detectBrowser(filePath: string): 'chrome' | 'brave' | 'edge' | 'safari' | 'firefox' {
  const base = path.basename(filePath).toLowerCase()
  if (base === 'history.db' || base.endsWith('.db') && base.includes('history')) return 'safari'
  if (base === 'places.sqlite' || base.endsWith('places.sqlite')) return 'firefox'
  if (base.includes('brave')) return 'brave'
  if (base.includes('edge')) return 'edge'
  return 'chrome'
}

export function findBrowserHistoryFiles(): Array<{ path: string; browser: 'chrome' | 'brave' | 'edge' | 'safari' | 'firefox' }> {
  const results: Array<{ path: string; browser: 'chrome' | 'brave' | 'edge' | 'safari' | 'firefox' }> = []
  const home = os.homedir()

  const firefoxProfiles = path.join(home, 'Library/Application Support/Firefox/Profiles')
  try {
    const entries = fs.readdirSync(firefoxProfiles)
    for (const entry of entries) {
      const placesPath = path.join(firefoxProfiles, entry, 'places.sqlite')
      try {
        if (fs.statSync(placesPath).isFile()) {
          results.push({ path: placesPath, browser: 'firefox' })
        }
      } catch { /* not present */ }
    }
  } catch { /* Firefox not installed or no profiles */ }

  const chromeHistory = path.join(home, 'Library/Application Support/Google/Chrome/Default/History')
  try {
    if (fs.statSync(chromeHistory).isFile()) {
      results.push({ path: chromeHistory, browser: 'chrome' })
    }
  } catch { /* Chrome not installed */ }

  const braveHistory = path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/History')
  try {
    if (fs.statSync(braveHistory).isFile()) {
      results.push({ path: braveHistory, browser: 'brave' })
    }
  } catch { /* Brave not installed */ }

  const edgeHistory = path.join(home, 'Library/Application Support/Microsoft Edge/Default/History')
  try {
    if (fs.statSync(edgeHistory).isFile()) {
      results.push({ path: edgeHistory, browser: 'edge' })
    }
  } catch { /* Edge not installed */ }

  const safariHistory = path.join(home, 'Library/Safari/History.db')
  try {
    if (fs.statSync(safariHistory).isFile()) {
      results.push({ path: safariHistory, browser: 'safari' })
    }
  } catch { /* Safari not installed */ }

  return results
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function tableExistsCaseInsensitive(db: Database.Database, name: string): boolean {
  const lower = name.toLowerCase()
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>
  return rows.some((r) => r.name.toLowerCase() === lower)
}

function chromeTimestampToIso(microseconds: number | null | undefined): string | null {
  if (typeof microseconds !== 'number' || !Number.isFinite(microseconds)) return null
  const ms = microseconds / 1000 - 11644473600000
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function safariTimestampToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  return new Date((seconds + 978307200) * 1000).toISOString()
}

function firefoxTimestampToIso(microseconds: number | null | undefined): string | null {
  if (typeof microseconds !== 'number' || !Number.isFinite(microseconds)) return null
  return new Date(microseconds / 1000).toISOString()
}

export async function ingestBrowserHistory(
  filePath: string,
  projectId: string,
  browser: 'chrome' | 'brave' | 'edge' | 'safari' | 'firefox',
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)
  const size = fileSize(resolved)
  let contentHash: string | null = null
  try {
    contentHash = computeFileHash(resolved)
  } catch {
    contentHash = null
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'browser', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = makeActivityRecord(projectId, 'browser', path.basename(resolved), size, contentHash)
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'browser history'}`, 0, null, record.id, 'browser')

  let db: Database.Database | null = null
  let tempDbPath: string | null = null
  let total = 0
  try {
    if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
    try {
      db = new Database(resolved, { readonly: true })
      db.pragma('query_only = ON')
    } catch {
      const tmpDir = os.tmpdir()
      tempDbPath = path.join(tmpDir, `holmes-browser-${Date.now()}-${path.basename(resolved)}`)
      fs.copyFileSync(resolved, tempDbPath)
      const walPath = resolved + '-wal'
      try { fs.copyFileSync(walPath, tempDbPath + '-wal') } catch { /* no WAL file */ }
      const shmPath = resolved + '-shm'
      try { fs.copyFileSync(shmPath, tempDbPath + '-shm') } catch { /* no SHM file */ }
      db = new Database(tempDbPath, { readonly: true })
      db.pragma('query_only = ON')
    }

    let schema: 'chromium' | 'safari' | 'firefox'
    if (tableExists(db, 'history_items') || tableExistsCaseInsensitive(db, 'history_items')) {
      schema = 'safari'
    } else if (tableExists(db, 'moz_places') || tableExistsCaseInsensitive(db, 'moz_places')) {
      schema = 'firefox'
    } else if (tableExists(db, 'urls') || tableExistsCaseInsensitive(db, 'urls')) {
      schema = 'chromium'
    } else {
      throw new Error('Unrecognized browser history schema: no urls/history_items/moz_places table')
    }

    let visitSql: string
    if (schema === 'safari') {
      visitSql = `SELECT history_items.url AS url, history_items.title AS title, history_visits.visit_time AS visit_time
                  FROM history_items JOIN history_visits ON history_items.id = history_visits.history_item`
    } else if (schema === 'firefox') {
      visitSql = `SELECT moz_places.url AS url, moz_places.title AS title, moz_historyvisits.visit_date AS visit_time
                  FROM moz_places JOIN moz_historyvisits ON moz_places.id = moz_historyvisits.place_id`
    } else {
      visitSql = `SELECT urls.url AS url, urls.title AS title, visits.visit_time AS visit_time
                  FROM urls JOIN visits ON urls.id = visits.url`
    }

    const visitStmt = db.prepare(`${visitSql} LIMIT ? OFFSET ?`)
    let offset = 0
    while (true) {
      if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
      const batch = visitStmt.all(BATCH_SIZE, offset) as Array<{ url: string | null; title: string | null; visit_time: number | null }>
      if (batch.length === 0) break
      database.runInTransaction(() => {
        for (const row of batch) {
          const occurredAt =
            schema === 'safari'
              ? safariTimestampToIso(row.visit_time)
              : schema === 'firefox'
                ? firefoxTimestampToIso(row.visit_time)
                : chromeTimestampToIso(row.visit_time)
          if (!occurredAt) continue
          database.createBrowserEvent({
            recordId: record.id,
            kind: 'visit',
            occurredAt,
            title: row.title ?? null,
            url: row.url ?? null,
            sourceMeta: { browser, schema },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
      offset += batch.length
      emit(sendProgress, 'storing', `Imported ${total} visits`, total, null, record.id, 'browser')
      if (total >= MAX_EVENTS_PER_FILE) break
      if (batch.length < BATCH_SIZE) break
    }

    if (schema === 'chromium' && total < MAX_EVENTS_PER_FILE) {
      try {
        if (tableExists(db, 'bookmarks') || tableExistsCaseInsensitive(db, 'bookmarks')) {
          const bmStmt = db.prepare('SELECT url, title, date_added FROM bookmarks LIMIT ? OFFSET ?')
          let bmOffset = 0
          while (true) {
            if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
            const batch = bmStmt.all(BATCH_SIZE, bmOffset) as Array<{ url: string | null; title: string | null; date_added: number | null }>
            if (batch.length === 0) break
            database.runInTransaction(() => {
              for (const row of batch) {
                if (!row.url) continue
                const occurredAt = chromeTimestampToIso(row.date_added)
                database.createBrowserEvent({
                  recordId: record.id,
                  kind: 'bookmark',
                  occurredAt: occurredAt ?? new Date(0).toISOString(),
                  title: row.title ?? null,
                  url: row.url,
                  sourceMeta: { browser, schema, kind: 'bookmark' },
                })
                total += 1
                if (total >= MAX_EVENTS_PER_FILE) break
              }
            })
            bmOffset += batch.length
            if (total >= MAX_EVENTS_PER_FILE) break
            if (batch.length < BATCH_SIZE) break
          }
        }
      } catch { /* bookmarks optional */ }

      try {
        if (tableExists(db, 'downloads') || tableExistsCaseInsensitive(db, 'downloads')) {
          const dlStmt = db.prepare('SELECT target_path, tab_url, start_time FROM downloads LIMIT ? OFFSET ?')
          let dlOffset = 0
          while (true) {
            if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
            const batch = dlStmt.all(BATCH_SIZE, dlOffset) as Array<{ target_path: string | null; tab_url: string | null; start_time: number | null }>
            if (batch.length === 0) break
            database.runInTransaction(() => {
              for (const row of batch) {
                const occurredAt = chromeTimestampToIso(row.start_time)
                if (!occurredAt) continue
                const title = row.target_path ? path.basename(row.target_path) : null
                database.createBrowserEvent({
                  recordId: record.id,
                  kind: 'download',
                  occurredAt,
                  title,
                  url: row.tab_url ?? null,
                  sourceMeta: { browser, schema, kind: 'download', targetPath: row.target_path },
                })
                total += 1
                if (total >= MAX_EVENTS_PER_FILE) break
              }
            })
            dlOffset += batch.length
            if (total >= MAX_EVENTS_PER_FILE) break
            if (batch.length < BATCH_SIZE) break
          }
        }
      } catch { /* downloads optional */ }
    }

    if (schema === 'firefox' && total < MAX_EVENTS_PER_FILE) {
      try {
        if (tableExists(db, 'moz_bookmarks') || tableExistsCaseInsensitive(db, 'moz_bookmarks')) {
          const bmStmt = db.prepare(
            `SELECT moz_places.url AS url, moz_bookmarks.title AS title, moz_bookmarks.dateAdded AS date_added
             FROM moz_bookmarks JOIN moz_places ON moz_bookmarks.fk = moz_places.id
             WHERE moz_places.url IS NOT NULL LIMIT ? OFFSET ?`
          )
          let bmOffset = 0
          while (true) {
            if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
            const batch = bmStmt.all(BATCH_SIZE, bmOffset) as Array<{ url: string | null; title: string | null; date_added: number | null }>
            if (batch.length === 0) break
            database.runInTransaction(() => {
              for (const row of batch) {
                if (!row.url) continue
                const occurredAt = firefoxTimestampToIso(row.date_added)
                database.createBrowserEvent({
                  recordId: record.id,
                  kind: 'bookmark',
                  occurredAt: occurredAt ?? new Date(0).toISOString(),
                  title: row.title ?? null,
                  url: row.url,
                  sourceMeta: { browser, schema, kind: 'bookmark' },
                })
                total += 1
                if (total >= MAX_EVENTS_PER_FILE) break
              }
            })
            bmOffset += batch.length
            if (total >= MAX_EVENTS_PER_FILE) break
            if (batch.length < BATCH_SIZE) break
          }
        }
      } catch { /* bookmarks optional */ }
    }

    if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
    completeActivityRecordEx(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} browser events`, total, total, record.id, 'browser')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failActivityRecordEx(record.id, message)
    throw err
  } finally {
    try {
      db?.close()
    } catch { /* ignore */ }
    if (tempDbPath) {
      try { fs.unlinkSync(tempDbPath) } catch { /* ignore */ }
      try { fs.unlinkSync(tempDbPath + '-wal') } catch { /* ignore */ }
      try { fs.unlinkSync(tempDbPath + '-shm') } catch { /* ignore */ }
    }
  }
}

function parseDurationText(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => Number.isNaN(p))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 1) return Number.isFinite(parts[0]) ? parts[0] : null
  return null
}

export async function ingestYouTubeHistory(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)
  const size = fileSize(resolved)
  let contentHash: string | null = null
  try {
    contentHash = computeFileHash(resolved)
  } catch {
    contentHash = null
  }

  if (size > MAX_YOUTUBE_BYTES) {
    const record = makeActivityRecord(projectId, 'youtube', path.basename(resolved), size, contentHash)
    failActivityRecordEx(record.id, `YouTube history file exceeds ${MAX_YOUTUBE_BYTES} bytes`)
    throw new Error('YouTube history file is too large')
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'youtube', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = makeActivityRecord(projectId, 'youtube', path.basename(resolved), size, contentHash)
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'YouTube history'}`, 0, null, record.id, 'youtube')

  try {
    if (safeAbort(signal)) throw new Error('YouTube history ingest cancelled')
    const buffer = await fs.promises.readFile(resolved)
    if (buffer.byteLength > MAX_YOUTUBE_BYTES) {
      throw new Error('YouTube history file exceeds size cap')
    }
    emit(sendProgress, 'parsing', 'Parsing YouTube history', 0, null, record.id, 'youtube')
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown
    const entries: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as Record<string, unknown>)?.locations) ? (parsed as Record<string, unknown>).locations as unknown[] : []

    let total = 0
    let pending: Array<{ occurredAt: string; title: string | null; channel: string | null; url: string | null; durationSeconds: number | null }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const e of batch) {
          database.createYoutubeEvent({
            recordId: record.id,
            occurredAt: e.occurredAt,
            title: e.title,
            channel: e.channel,
            url: e.url,
            durationSeconds: e.durationSeconds,
            sourceMeta: {},
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    for (let i = 0; i < entries.length; i += 1) {
      if (safeAbort(signal)) throw new Error('YouTube history ingest cancelled')
      const entry = entries[i] as Record<string, unknown>
      if (!entry || typeof entry !== 'object') continue
      const header = entry.header
      if (typeof header === 'string' && header.toLowerCase().includes('youtube') === false && header.trim() !== '') {
        // Some entries (ads/search) have different headers; skip non-YouTube where header is explicit.
      }
      const rawTitle = typeof entry.title === 'string' ? entry.title : null
      const title = rawTitle ? rawTitle.replace(/^Watched\s+/i, '').trim() : null
      const titleUrl = typeof entry.titleUrl === 'string' ? entry.titleUrl : null
      const time = typeof entry.time === 'string' ? entry.time : null
      if (!time) continue
      const occurredAt = new Date(time).toISOString()
      if (!Number.isFinite(Date.parse(occurredAt))) continue
      let channel: string | null = null
      const subtitles = entry.subtitles
      if (Array.isArray(subtitles) && subtitles.length > 0) {
        const first = subtitles[0] as Record<string, unknown>
        if (first && typeof first.name === 'string') channel = first.name
      }
      const durationSeconds = parseDurationText(entry.duration && typeof entry.duration === 'object' ? (entry.duration as Record<string, unknown>).text : null)
      pending.push({ occurredAt, title, channel, url: titleUrl, durationSeconds })
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${total} videos`, total, entries.length, record.id, 'youtube')
    }
    flush()

    if (safeAbort(signal)) throw new Error('YouTube history ingest cancelled')
    completeActivityRecordEx(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} YouTube events`, total, total, record.id, 'youtube')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failActivityRecordEx(record.id, message)
    throw err
  }
}

function extractEmails(value: string): string[] {
  const matches = value.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)
  return matches ? Array.from(new Set(matches)) : []
}

function extractFirstEmail(value: string): string | null {
  const match = value.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  return match ? match[0] : null
}

interface ParsedEmail {
  date: string | null
  fromAddress: string | null
  toAddresses: string[]
  subject: string | null
  bodyExcerpt: string | null
}

function parseEmailBlock(lines: string[]): ParsedEmail {
  const headers: Record<string, string[]> = {}
  let i = 0
  let currentName: string | null = null
  while (i < lines.length) {
    const line = lines[i]
    if (line === '') {
      i += 1
      break
    }
    if (/^\s/.test(line) && currentName) {
      headers[currentName].push(line.trim())
    } else {
      const colon = line.indexOf(':')
      if (colon > 0) {
        const name = line.slice(0, colon).trim().toLowerCase()
        const value = line.slice(colon + 1).trim()
        if (!headers[name]) headers[name] = []
        headers[name].push(value)
        currentName = name
      } else {
        currentName = null
      }
    }
    i += 1
  }
  const bodyLines = lines.slice(i)
  let body = bodyLines.join('\n').trim()
  if (body.length > MAX_BODY_EXCERPT_CHARS) body = body.slice(0, MAX_BODY_EXCERPT_CHARS)

  const dateRaw = headers.date?.join(' ').trim() ?? null
  let date: string | null = null
  if (dateRaw) {
    const parsed = Date.parse(dateRaw)
    if (Number.isFinite(parsed)) date = new Date(parsed).toISOString()
  }
  const fromRaw = headers.from?.join(' ').trim() ?? null
  const fromAddress = fromRaw ? extractFirstEmail(fromRaw) : null
  const toRaw = headers.to?.join(' ').trim() ?? ''
  const toAddresses = extractEmails(toRaw)
  const subject = headers.subject?.join(' ').trim() ?? null
  return { date, fromAddress, toAddresses, subject, bodyExcerpt: body || null }
}

export async function ingestEmailMbox(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)
  const size = fileSize(resolved)
  const contentHash = computeFileIdentity(resolved)

  if (size > MAX_MBOX_BYTES) {
    const record = makeActivityRecord(projectId, 'email', path.basename(resolved), size, contentHash)
    const gb = (size / 1024 / 1024 / 1024).toFixed(1)
    const capGb = (MAX_MBOX_BYTES / 1024 / 1024 / 1024).toFixed(0)
    failActivityRecordEx(record.id, `Email file is ${gb} GB, above the ${capGb} GB limit`)
    throw new Error(`Email file is ${gb} GB, above the ${capGb} GB limit`)
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'email', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = makeActivityRecord(projectId, 'email', path.basename(resolved), size, contentHash)
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'email file'}`, 0, null, record.id, 'email')

  const isEml = resolved.toLowerCase().endsWith('.eml')
  const allowlistAddress = getSettings().activityEmailAllowedAddress ?? ''

  try {
    if (safeAbort(signal)) throw new Error('Email ingest cancelled')
    emit(sendProgress, 'parsing', 'Parsing email file', 0, null, record.id, 'email')

    const stream = fs.createReadStream(resolved, { encoding: 'utf8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    let total = 0
    let currentLines: string[] = []
    let started = false
    let pending: ParsedEmail[] = []

    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const e of batch) {
          if (!e.date) continue
          const kind: EmailEvent['kind'] =
            allowlistAddress && e.fromAddress && e.fromAddress.toLowerCase() === allowlistAddress.toLowerCase()
              ? 'sent'
              : 'received'
          database.createEmailEvent({
            recordId: record.id,
            kind,
            occurredAt: e.date,
            fromAddress: e.fromAddress,
            toAddresses: e.toAddresses,
            subject: e.subject,
            bodyExcerpt: e.bodyExcerpt,
            sourceMeta: {},
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    const processBlock = () => {
      const parsed = parseEmailBlock(currentLines)
      currentLines = []
      if (!parsed.date) return
      pending.push(parsed)
      if (pending.length >= BATCH_SIZE) flush()
    }

    for await (const line of rl) {
      if (safeAbort(signal)) {
        rl.close()
        stream.destroy()
        throw new Error('Email ingest cancelled')
      }
      if (isEml) {
        currentLines.push(line)
        continue
      }
      if (/^From /.test(line) && started) {
        processBlock()
        currentLines = []
        started = true
        continue
      }
      if (/^From /.test(line) && !started) {
        started = true
        continue
      }
      currentLines.push(line)
    }
    if (currentLines.length > 0) processBlock()
    flush()
    rl.close()
    stream.destroy()

    if (safeAbort(signal)) throw new Error('Email ingest cancelled')
    completeActivityRecordEx(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} emails`, total, total, record.id, 'email')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failActivityRecordEx(record.id, message)
    throw err
  }
}

function locationTimestampToIso(entry: Record<string, unknown>): string | null {
  const ts = entry.timestamp
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  const tsMs = entry.timestampMs
  if (typeof tsMs === 'string' || typeof tsMs === 'number') {
    const n = Number.parseInt(String(tsMs), 10)
    if (Number.isFinite(n)) return new Date(n).toISOString()
  }
  return null
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = splitCsvLine(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i += 1) {
    rows.push(splitCsvLine(lines[i]))
  }
  return { headers, rows }
}

function matchCsvHeader(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i].trim().toLowerCase().replace(/[\s_]+/g, '')
    for (const alias of aliases) {
      const normalizedAlias = alias.toLowerCase().replace(/[\s_]+/g, '')
      if (header === normalizedAlias || header.includes(normalizedAlias)) return i
    }
  }
  return -1
}

function parseLocationCsv(text: string): Array<{ occurredAt: string; lat: number | null; lng: number | null; accuracyM: number | null }> {
  const { headers, rows } = parseCsv(text)
  if (headers.length === 0) return []

  const latIdx = matchCsvHeader(headers, ['latitude', 'lat'])
  const lngIdx = matchCsvHeader(headers, ['longitude', 'lng', 'lon'])
  const timeIdx = matchCsvHeader(headers, ['timestamp', 'time', 'date', 'datetime', 'occurredat', 'starttime'])
  const accIdx = matchCsvHeader(headers, ['accuracy', 'accuracyM', 'accuracyMeters'])

  if (latIdx === -1 || lngIdx === -1) return []

  const result: Array<{ occurredAt: string; lat: number | null; lng: number | null; accuracyM: number | null }> = []
  for (const row of rows) {
    const latStr = row[latIdx]?.trim()
    const lngStr = row[lngIdx]?.trim()
    if (!latStr || !lngStr) continue
    const lat = Number.parseFloat(latStr)
    const lng = Number.parseFloat(lngStr)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue

    let occurredAt: string | null = null
    if (timeIdx >= 0) {
      const tsStr = row[timeIdx]?.trim()
      if (tsStr) {
        const parsed = Date.parse(tsStr)
        if (Number.isFinite(parsed)) occurredAt = new Date(parsed).toISOString()
      }
    }
    if (!occurredAt) continue

    let accuracyM: number | null = null
    if (accIdx >= 0) {
      const accStr = row[accIdx]?.trim()
      if (accStr) {
        const acc = Number.parseFloat(accStr)
        if (Number.isFinite(acc)) accuracyM = acc
      }
    }

    result.push({ occurredAt, lat, lng, accuracyM })
  }
  return result
}

export async function ingestLocationHistory(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)
  const size = fileSize(resolved)
  let contentHash: string | null = null
  try {
    contentHash = computeFileHash(resolved)
  } catch {
    contentHash = null
  }

  if (size > MAX_LOCATION_BYTES) {
    const record = makeActivityRecord(projectId, 'location', path.basename(resolved), size, contentHash)
    failActivityRecordEx(record.id, `Location history file exceeds ${MAX_LOCATION_BYTES} bytes`)
    throw new Error('Location history file is too large')
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'location', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = makeActivityRecord(projectId, 'location', path.basename(resolved), size, contentHash)
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'location history'}`, 0, null, record.id, 'location')

  try {
    if (safeAbort(signal)) throw new Error('Location history ingest cancelled')
    const buffer = await fs.promises.readFile(resolved)
    if (buffer.byteLength > MAX_LOCATION_BYTES) {
      throw new Error('Location history file exceeds size cap')
    }
    emit(sendProgress, 'parsing', 'Parsing location history', 0, null, record.id, 'location')
    const rawText = buffer.toString('utf8').replace(/^\uFEFF/, '')
    const ext = path.extname(resolved).toLowerCase()
    const isCsv = ext === '.csv' || (!rawText.trimStart().startsWith('{') && !rawText.trimStart().startsWith('['))

    let locations: Array<{ occurredAt: string; lat: number | null; lng: number | null; accuracyM: number | null }> = []

    if (isCsv) {
      locations = parseLocationCsv(rawText)
    } else {
      const parsed = JSON.parse(rawText) as unknown
      const rawLocations: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.locations)
          ? ((parsed as Record<string, unknown>).locations as unknown[])
          : Array.isArray((parsed as Record<string, unknown>)?.timelineObjects)
            ? ((parsed as Record<string, unknown>).timelineObjects as unknown[])
            : []

      for (const entry of rawLocations) {
        if (!entry || typeof entry !== 'object') continue
        const obj = entry as Record<string, unknown>
        const occurredAt = locationTimestampToIso(obj)
        if (!occurredAt) continue
        let lat: number | null = null
        let lng: number | null = null
        if (typeof obj.latitudeE7 === 'number' && Number.isFinite(obj.latitudeE7)) {
          lat = obj.latitudeE7 / 1e7
        } else if (typeof obj.latitude === 'number' && Number.isFinite(obj.latitude)) {
          lat = obj.latitude
        }
        if (typeof obj.longitudeE7 === 'number' && Number.isFinite(obj.longitudeE7)) {
          lng = obj.longitudeE7 / 1e7
        } else if (typeof obj.longitude === 'number' && Number.isFinite(obj.longitude)) {
          lng = obj.longitude
        }
        if (lat === null || lng === null) continue
        let accuracyM: number | null = null
        if (typeof obj.accuracy === 'number' && Number.isFinite(obj.accuracy)) {
          accuracyM = obj.accuracy
        }
        locations.push({ occurredAt, lat, lng, accuracyM })
      }
    }

    let total = 0
    let pending: Array<{ occurredAt: string; lat: number | null; lng: number | null; accuracyM: number | null }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const e of batch) {
          database.createLocationEvent({
            recordId: record.id,
            occurredAt: e.occurredAt,
            lat: e.lat,
            lng: e.lng,
            accuracyM: e.accuracyM,
            source: isCsv ? 'csv_import' : 'google_takeout',
            sourceMeta: {},
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    for (let i = 0; i < locations.length; i += 1) {
      if (safeAbort(signal)) throw new Error('Location history ingest cancelled')
      const loc = locations[i]
      if (!loc.occurredAt || loc.lat === null || loc.lng === null) continue
      pending.push(loc)
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${total} points`, total, locations.length, record.id, 'location')
    }
    flush()

    if (safeAbort(signal)) throw new Error('Location history ingest cancelled')
    completeActivityRecordEx(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} location points`, total, total, record.id, 'location')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failActivityRecordEx(record.id, message)
    throw err
  }
}

export async function ingestChromeTakeoutJson(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)
  const size = fileSize(resolved)
  let contentHash: string | null = null
  try {
    contentHash = computeFileHash(resolved)
  } catch {
    contentHash = null
  }

  if (size > MAX_BROWSER_JSON_BYTES) {
    const record = makeActivityRecord(projectId, 'browser', path.basename(resolved), size, contentHash)
    failActivityRecordEx(record.id, `Browser history JSON exceeds ${MAX_BROWSER_JSON_BYTES} bytes`)
    throw new Error('Browser history JSON is too large')
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'browser', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = makeActivityRecord(projectId, 'browser', path.basename(resolved), size, contentHash)
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'browser history'}`, 0, null, record.id, 'browser')

  try {
    if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
    const buffer = await fs.promises.readFile(resolved)
    emit(sendProgress, 'parsing', 'Parsing Chrome Takeout history', 0, null, record.id, 'browser')
    const parsed = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>
    const entries: unknown[] = Array.isArray(parsed?.['Browser History'])
      ? (parsed['Browser History'] as unknown[])
      : []

    let total = 0
    let pending: Array<{ occurredAt: string; title: string | null; url: string | null }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const e of batch) {
          database.createBrowserEvent({
            recordId: record.id,
            kind: 'visit',
            occurredAt: e.occurredAt,
            title: e.title,
            url: e.url,
            sourceMeta: { browser: 'chrome', schema: 'takeout-json' },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    for (let i = 0; i < entries.length; i += 1) {
      if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
      const entry = entries[i] as Record<string, unknown>
      if (!entry || typeof entry !== 'object') continue
      const timeUsec = typeof entry.time_usec === 'number' ? entry.time_usec : Number(entry.time_usec)
      if (!Number.isFinite(timeUsec)) continue
      const occurredAt = new Date(timeUsec / 1000).toISOString()
      if (!Number.isFinite(Date.parse(occurredAt))) continue
      pending.push({
        occurredAt,
        title: typeof entry.title === 'string' ? entry.title : null,
        url: typeof entry.url === 'string' ? entry.url : null,
      })
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${total} visits`, total, entries.length, record.id, 'browser')
    }
    flush()

    if (safeAbort(signal)) throw new Error('Browser history ingest cancelled')
    completeActivityRecordEx(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} browser events`, total, total, record.id, 'browser')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failActivityRecordEx(record.id, message)
    throw err
  }
}

export async function ingestActivityFile(
  filePath: string,
  projectId: string,
  source: ActivitySourceType,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  switch (source) {
    case 'browser':
      if (path.extname(filePath).toLowerCase() === '.json') {
        return ingestChromeTakeoutJson(filePath, projectId, signal, sendProgress)
      }
      return ingestBrowserHistory(filePath, projectId, detectBrowser(filePath), signal, sendProgress)
    case 'youtube':
      return ingestYouTubeHistory(filePath, projectId, signal, sendProgress)
    case 'email':
      return ingestEmailMbox(filePath, projectId, signal, sendProgress)
    case 'location':
      return ingestLocationHistory(filePath, projectId, signal, sendProgress)
    default:
      throw new Error(`Unsupported activity source for file ingest: ${source}`)
  }
}

const DETECT_EXCLUDE_FILES = new Set(['knowledgec.db', 'photos.sqlite', 'envelope index'])

function isSqliteDatabase(filePath: string): boolean {
  try {
    const descriptor = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(16)
    const bytesRead = fs.readSync(descriptor, buffer, 0, 16, 0)
    fs.closeSync(descriptor)
    if (bytesRead < 16) return false
    return buffer.subarray(0, 15).toString('ascii') === 'SQLite format 3'
  } catch {
    return false
  }
}

function peekFileText(filePath: string, bytes: number): string {
  try {
    const descriptor = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(bytes)
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytes, 0)
    fs.closeSync(descriptor)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  }
}

export function csvHeaderColumns(filePath: string): string[] {
  const peek = peekFileText(filePath, 8192).replace(/^\uFEFF/, '')
  const firstLine = peek.split(/\r?\n/, 1)[0] ?? ''
  if (!firstLine.trim()) return []
  return splitCsvLine(firstLine).map((c) => c.trim().toLowerCase().replace(/[\s_]+/g, ''))
}

function hasColumn(columns: string[], aliases: string[]): boolean {
  return columns.some((c) => aliases.some((alias) => c === alias || c.includes(alias)))
}

export function detectActivitySource(filePath: string): ActivitySourceType | null {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()

  if (DETECT_EXCLUDE_FILES.has(base)) return null

  if (ext === '.mbox') return 'email'

  if (ext === '.db' || ext === '.sqlite') return 'browser'

  if (ext === '.json') {
    if (base === 'records.json' || base === 'timeline.json') return 'location'
    if (base.includes('youtube') || base.includes('watch-history')) return 'youtube'
    const peek = peekFileText(filePath, 8192)
    if (peek.includes('"timelineObjects"') || peek.includes('"locations"') || peek.includes('"latitudeE7"')) return 'location'
    if (base.includes('location') && peek.includes('"latitude"')) return 'location'
    if (peek.includes('"titleUrl"')) return 'youtube'
    if (peek.includes('"Browser History"')) return 'browser'
    return null
  }

  if (ext === '.csv') {
    const columns = csvHeaderColumns(filePath)
    if (columns.length === 0) return null
    if (hasColumn(columns, ['serviceprovider']) && hasColumn(columns, ['subscriptionstatus'])) return 'subscription'
    if (hasColumn(columns, ['offername']) && hasColumn(columns, ['planbillingfrequency'])) return 'subscription'
    if (hasColumn(columns, ['subscriptionid'])) return null
    if (hasColumn(columns, ['orderid'])) return 'amazon'
    const hasLat = columns.some((c) => c === 'lat' || c.startsWith('latitude'))
    const hasLng = columns.some((c) => c === 'lng' || c === 'lon' || c.startsWith('longitude'))
    if (hasLat && hasLng) return 'location'
    return null
  }

  if (ext === '') {
    if (isSqliteDatabase(filePath)) return 'browser'
  }

  return null
}

export async function scanActivityDirectory(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<DirectoryScanResult> {
  const project = database.getProjectById(projectId)
  if (!project || !project.path) {
    return { scanned: 0, ingested: 0, skipped: 0, errors: [] }
  }

  const allFiles = collectProjectDataFiles(project.path)
  const detectable: Array<{ file: string; source: ActivitySourceType }> = []
  for (const file of allFiles) {
    const source = detectActivitySource(file)
    if (source) detectable.push({ file, source })
  }

  if (sendProgress) emit(sendProgress, 'reading', `Scanning ${detectable.length} file${detectable.length === 1 ? '' : 's'} in directory`, 0, detectable.length, '', 'browser')

  let ingested = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < detectable.length; i += 1) {
    if (safeAbort(signal)) break
    const { file, source } = detectable[i]
    try {
      if (sendProgress) emit(sendProgress, 'reading', `Ingesting ${path.basename(file)}`, i, detectable.length, '', source)
      if (source === 'amazon') {
        await ingestAmazonFile(file, projectId, signal, sendProgress)
      } else if (source === 'subscription') {
        await ingestSubscriptionFile(file, projectId, signal, sendProgress)
      } else {
        await ingestActivityFile(file, projectId, source, signal, sendProgress)
      }
      ingested += 1
    } catch (err) {
      if (signal?.aborted) break
      skipped += 1
      errors.push(`${path.basename(file)}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  if (sendProgress) emit(sendProgress, 'complete', `Scanned ${detectable.length} files — ${ingested} ingested, ${skipped} skipped`, detectable.length, detectable.length, '', 'browser')

  return { scanned: detectable.length, ingested, skipped, errors }
}
