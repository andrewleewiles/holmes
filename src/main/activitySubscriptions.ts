import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import * as database from './database'
import { assertPathAllowed } from './fileScope'
import type { ActivityRecord, ActivityIngestProgress, EmailEvent, SubscriptionEvent } from '../shared/types'
import type { ActivityProgressSender } from './activity'

const BATCH_SIZE = 1000
const MAX_EVENTS_PER_FILE = 2_000_000

const SUBSCRIPTION_SENDER_DOMAINS = [
  'apple.com',
  'itunes.store',
  'amazon.com',
  'netflix.com',
  'spotify.com',
  'stripe.com',
  'paypal.com',
  'google.com',
  'github.com',
  'adobe.com',
  'microsoft.com',
  'nytimes.com',
  'substack.com',
  'patreon.com',
]

const SUBJECT_KEYWORD_RE = /\b(receipt|invoice|subscription|renewal|renewed|cancelled|cancellation|payment|charged|thank you for|order confirmation)\b/i
const AMOUNT_RE = /\$\s?(\d+(?:\.\d{2})?)/
const MONTHLY_RE = /monthly/i
const YEARLY_RE = /yearly|annual/i
const WEEKLY_RE = /weekly/i

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

function freshActivityRecord(recordId: string, sourceType: ActivityRecord['sourceType']): ActivityRecord {
  const fresh = database.getActivityRecord(recordId)
  if (fresh) return fresh
  return {
    id: recordId,
    projectId: '',
    sourceType,
    filename: null,
    fileSize: null,
    contentHash: null,
    importedAt: new Date().toISOString(),
    status: 'parsed',
    parseError: null,
    eventsCount: 0,
  }
}

function domainFromAddress(address: string | null): string | null {
  if (!address) return null
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return null
  return address.slice(at + 1).toLowerCase()
}

function isSubscriptionSender(address: string | null): boolean {
  const domain = domainFromAddress(address)
  if (!domain) return false
  if (SUBSCRIPTION_SENDER_DOMAINS.includes(domain)) return true
  for (const d of SUBSCRIPTION_SENDER_DOMAINS) {
    if (domain.endsWith(`.${d}`)) return true
  }
  return false
}

function extractAmountCents(subject: string | null): number | null {
  if (!subject) return null
  const m = subject.match(AMOUNT_RE)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function inferCadence(subject: string | null): SubscriptionEvent['cadence'] {
  if (!subject) return 'unknown'
  if (MONTHLY_RE.test(subject)) return 'monthly'
  if (YEARLY_RE.test(subject)) return 'yearly'
  if (WEEKLY_RE.test(subject)) return 'weekly'
  return 'unknown'
}

function truncatePlanName(subject: string | null): string | null {
  if (!subject) return null
  const trimmed = subject.trim()
  if (trimmed.length <= 100) return trimmed
  return trimmed.slice(0, 100)
}

export async function detectSubscriptionsFromEmail(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const LIVE_FILENAME = 'subscriptions-sync'
  const existing = database.findLiveActivityRecord(projectId, 'subscription', LIVE_FILENAME)
  let record: ActivityRecord
  if (existing) {
    database.resetActivityRecord(existing.id)
    database.touchActivityRecordImportedAt(existing.id)
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'subscription',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  try {
    if (safeAbort(signal)) throw new Error('Subscription detection cancelled')
    emit(sendProgress, 'reading', 'Loading email events', 0, null, record.id, 'subscription')

    const emails = database.listAllEmailEvents(projectId, { limit: 10000 })
    if (emails.length === 0) {
      database.completeActivityRecord(record.id, 0)
      emit(sendProgress, 'complete', 'No email events to scan', 0, 0, record.id, 'subscription')
      return freshActivityRecord(record.id, 'subscription')
    }

    emit(sendProgress, 'extracting', `Scanning ${emails.length} emails`, 0, emails.length, record.id, 'subscription')

    let total = 0
    let pending: Array<{
      occurredAt: string
      provider: string | null
      planName: string | null
      amountCents: number | null
      cadence: SubscriptionEvent['cadence']
      fromAddress: string | null
      subject: string | null
    }> = []

    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const e of batch) {
          database.createSubscriptionEvent({
            recordId: record.id,
            occurredAt: e.occurredAt,
            provider: e.provider,
            planName: e.planName,
            amountCents: e.amountCents,
            currency: 'USD',
            cadence: e.cadence,
            sourceMeta: { from: e.fromAddress, subject: e.subject },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    for (let i = 0; i < emails.length; i += 1) {
      if (safeAbort(signal)) throw new Error('Subscription detection cancelled')
      if (i % 1000 === 0 && i > 0) {
        emit(sendProgress, 'storing', `Processed ${i}/${emails.length} emails`, i, emails.length, record.id, 'subscription')
      }
      const email: EmailEvent = emails[i]
      const subject = email.subject ?? null
      const fromAddress = email.fromAddress ?? null
      const senderMatch = isSubscriptionSender(fromAddress)
      const subjectMatch = subject ? SUBJECT_KEYWORD_RE.test(subject) : false
      if (!senderMatch && !subjectMatch) continue

      const provider = domainFromAddress(fromAddress) ?? 'unknown'
      const planName = truncatePlanName(subject)
      const amountCents = extractAmountCents(subject)
      const cadence = inferCadence(subject)

      pending.push({
        occurredAt: email.occurredAt,
        provider,
        planName,
        amountCents,
        cadence,
        fromAddress,
        subject,
      })
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
    }
    flush()

    if (safeAbort(signal)) throw new Error('Subscription detection cancelled')
    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Detected ${total} subscription events`, total, total, record.id, 'subscription')
    return freshActivityRecord(record.id, 'subscription')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    throw err
  }
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
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = splitCsvLine(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i += 1) {
    rows.push(splitCsvLine(lines[i]))
  }
  return { headers, rows }
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_]+/g, '')
}

function headerIndex(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader)
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias)
    if (idx !== -1) return idx
  }
  return -1
}

function cellValue(row: string[], idx: number): string | null {
  if (idx < 0) return null
  const value = row[idx]?.trim()
  if (!value || value === 'Not Applicable' || value === 'Not Available') return null
  return value
}

function parseAmountCents(value: string | null): number | null {
  if (!value) return null
  const cleaned = value.replace(/[$,\s]/g, '')
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function parseDateIso(value: string | null): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function cadenceFromInterval(value: string | null): SubscriptionEvent['cadence'] {
  if (!value) return 'unknown'
  const lower = value.toLowerCase()
  if (/12\s*month|year|annual/.test(lower)) return 'yearly'
  if (/month/.test(lower)) return 'monthly'
  if (/week/.test(lower)) return 'weekly'
  return 'unknown'
}

function cadenceFromMonths(value: string | null): SubscriptionEvent['cadence'] {
  if (!value) return 'unknown'
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return cadenceFromInterval(value)
  if (n === 1) return 'monthly'
  if (n === 12) return 'yearly'
  return 'unknown'
}

export async function ingestAmazonSubscriptionCsv(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)

  let contentHash: string | null = null
  try {
    const buf = fs.readFileSync(resolved)
    contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)
  } catch {
    contentHash = null
  }
  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'subscription', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  let size: number | null = null
  try {
    size = fs.statSync(resolved).size
  } catch {
    size = null
  }

  const record = database.createActivityRecord({
    projectId,
    sourceType: 'subscription',
    filename: path.basename(resolved),
    fileSize: size,
    contentHash,
  })

  try {
    if (safeAbort(signal)) throw new Error('Subscription CSV ingest cancelled')
    emit(sendProgress, 'reading', `Reading ${path.basename(resolved)}`, 0, null, record.id, 'subscription')

    const text = fs.readFileSync(resolved, 'utf8')
    const { headers, rows } = parseCsv(text)
    if (headers.length === 0) {
      throw new Error('Subscription CSV is empty')
    }

    const providerIdx = headerIndex(headers, ['serviceprovider', 'merchantname'])
    const statusIdx = headerIndex(headers, ['subscriptionstatus', 'status'])
    const startIdx = headerIndex(headers, ['subscriptionstartdate', 'billingperiodstartdate'])
    const statusDateIdx = headerIndex(headers, ['subscriptionstatusdate', 'statuslastupdateddate'])
    const amountIdx = headerIndex(headers, ['nextbillamount', 'totalamount', 'planbillingfee'])
    const cadenceIdx = headerIndex(headers, ['contracttimeinterval'])
    const frequencyIdx = headerIndex(headers, ['planbillingfrequency'])
    const currencyIdx = headerIndex(headers, ['basecurrencycode', 'currency'])
    const planIdx = headerIndex(headers, ['offername', 'plan'])
    const marketplaceIdx = headerIndex(headers, ['marketplace'])
    const typeIdx = headerIndex(headers, ['type'])

    if (providerIdx === -1) {
      throw new Error('Subscription CSV is missing a provider column')
    }

    emit(sendProgress, 'extracting', `Parsing ${rows.length} subscription rows`, 0, rows.length, record.id, 'subscription')

    let total = 0
    database.runInTransaction(() => {
      for (const row of rows) {
        const rowType = cellValue(row, typeIdx)
        if (rowType && rowType.toLowerCase() !== 'charge') continue

        const occurredAt = parseDateIso(cellValue(row, startIdx)) ?? parseDateIso(cellValue(row, statusDateIdx))
        if (!occurredAt) continue

        const provider = cellValue(row, providerIdx) ?? cellValue(row, marketplaceIdx) ?? 'unknown'
        const status = cellValue(row, statusIdx)
        const offerName = cellValue(row, planIdx)
        const planParts = [offerName, status].filter((part): part is string => Boolean(part))
        const planName = planParts.length > 0 ? planParts.join(' · ').slice(0, 100) : null

        const cadence =
          cadenceIdx !== -1 ? cadenceFromInterval(cellValue(row, cadenceIdx)) : cadenceFromMonths(cellValue(row, frequencyIdx))

        database.createSubscriptionEvent({
          recordId: record.id,
          occurredAt,
          provider,
          planName,
          amountCents: parseAmountCents(cellValue(row, amountIdx)),
          currency: cellValue(row, currencyIdx) ?? 'USD',
          cadence,
          sourceMeta: {
            source: 'amazon_subscription_csv',
            file: path.basename(resolved),
            ...(status ? { status } : {}),
          },
        })
        total += 1
        if (total >= MAX_EVENTS_PER_FILE) break
      }
    })

    if (safeAbort(signal)) throw new Error('Subscription CSV ingest cancelled')
    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} subscription events`, total, total, record.id, 'subscription')
    return freshActivityRecord(record.id, 'subscription')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    throw err
  }
}

export async function ingestSubscriptionFile(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  if (path.extname(filePath).toLowerCase() === '.csv') {
    return ingestAmazonSubscriptionCsv(filePath, projectId, signal, sendProgress)
  }
  return ingestAppleSubscriptionsLedger(filePath, projectId, signal, sendProgress)
}

function columnNames(db: Database.Database, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.map((r) => r.name)
  } catch {
    return []
  }
}

function findSubscriptionTable(db: Database.Database): string | null {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>
  for (const r of rows) {
    const lower = r.name.toLowerCase()
    if (lower.includes('subscription') || lower.includes('sub')) return r.name
  }
  for (const r of rows) {
    const cols = columnNames(db, r.name)
    const hasSubscription = cols.some((c) => c.toLowerCase().includes('subscription'))
    const hasExpires = cols.some((c) => c.toLowerCase().includes('expires'))
    const hasProduct = cols.some((c) => c.toLowerCase().includes('product'))
    if (hasSubscription || (hasExpires && hasProduct)) return r.name
  }
  return null
}

export async function ingestAppleSubscriptionsLedger(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const resolved = path.resolve(filePath)
  try {
    assertPathAllowed(resolved)
  } catch {
    const record = database.createActivityRecord({
      projectId,
      sourceType: 'subscription',
      filename: path.basename(resolved),
      fileSize: null,
      contentHash: null,
    })
    database.completeActivityRecord(record.id, 0)
    emit(sendProgress, 'complete', 'No Apple subscriptions ledger found', 0, 0, record.id, 'subscription')
    return freshActivityRecord(record.id, 'subscription')
  }

  const record = database.createActivityRecord({
    projectId,
    sourceType: 'subscription',
    filename: path.basename(resolved),
    fileSize: null,
    contentHash: null,
  })

  let exists = false
  try {
    const stat = fs.statSync(resolved)
    exists = stat.isFile()
  } catch {
    exists = false
  }

  if (!exists) {
    database.completeActivityRecord(record.id, 0)
    emit(sendProgress, 'complete', 'No Apple subscriptions ledger found', 0, 0, record.id, 'subscription')
    return freshActivityRecord(record.id, 'subscription')
  }

  if (safeAbort(signal)) {
    database.completeActivityRecord(record.id, 0)
    return freshActivityRecord(record.id, 'subscription')
  }

  emit(sendProgress, 'reading', `Reading ${path.basename(resolved)}`, 0, null, record.id, 'subscription')

  let db: Database.Database | null = null
  let total = 0
  try {
    db = new Database(resolved, { readonly: true })
    db.pragma('query_only = ON')

    if (safeAbort(signal)) {
      database.completeActivityRecord(record.id, 0)
      return freshActivityRecord(record.id, 'subscription')
    }

    const table = findSubscriptionTable(db)
    if (!table) {
      database.completeActivityRecord(record.id, 0)
      emit(sendProgress, 'complete', 'Apple ledger: no subscription table recognized', 0, 0, record.id, 'subscription')
      return freshActivityRecord(record.id, 'subscription')
    }

    const cols = columnNames(db, table)
    const col = (needle: string): string | null => {
      const lower = needle.toLowerCase()
      const found = cols.find((c) => c.toLowerCase().includes(lower))
      return found ?? null
    }
    const occurredCol = col('date') ?? col('time') ?? cols[0]
    const productCol = col('product') ?? col('name') ?? col('plan')
    const expiresCol = col('expires')
    const amountCol = col('amount') ?? col('price')

    const rowStmt = db.prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`)
    let offset = 0
    while (true) {
      if (safeAbort(signal)) break
      const batch = rowStmt.all(BATCH_SIZE, offset) as Array<Record<string, unknown>>
      if (batch.length === 0) break
      database.runInTransaction(() => {
        for (const row of batch) {
          const occurredAtRaw = occurredCol ? row[occurredCol] : null
          let occurredAt: string | null = null
          if (typeof occurredAtRaw === 'string') {
            const parsed = Date.parse(occurredAtRaw)
            if (Number.isFinite(parsed)) occurredAt = new Date(parsed).toISOString()
          } else if (typeof occurredAtRaw === 'number') {
            const asDate = new Date(occurredAtRaw * 1000)
            if (Number.isFinite(asDate.getTime())) occurredAt = asDate.toISOString()
          }
          if (!occurredAt) occurredAt = new Date().toISOString()

          let planName: string | null = null
          if (productCol && typeof row[productCol] === 'string') planName = row[productCol] as string
          if (expiresCol && typeof row[expiresCol] === 'string') {
            planName = planName ? `${planName} (expires ${row[expiresCol]})` : `expires ${row[expiresCol]}`
          }
          if (planName && planName.length > 100) planName = planName.slice(0, 100)

          let amountCents: number | null = null
          if (amountCol && typeof row[amountCol] === 'number') {
            amountCents = Math.round((row[amountCol] as number) * 100)
          } else if (amountCol && typeof row[amountCol] === 'string') {
            const m = (row[amountCol] as string).match(AMOUNT_RE)
            if (m) {
              const n = Number.parseFloat(m[1])
              if (Number.isFinite(n)) amountCents = Math.round(n * 100)
            }
          }

          database.createSubscriptionEvent({
            recordId: record.id,
            occurredAt,
            provider: 'apple',
            planName,
            amountCents,
            currency: 'USD',
            cadence: 'unknown',
            sourceMeta: { source: 'apple_ledger', table, columns: cols },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
      offset += batch.length
      emit(sendProgress, 'storing', `Imported ${total} Apple subscriptions`, total, null, record.id, 'subscription')
      if (total >= MAX_EVENTS_PER_FILE) break
      if (batch.length < BATCH_SIZE) break
    }

    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} Apple subscriptions`, total, total, record.id, 'subscription')
    return freshActivityRecord(record.id, 'subscription')
  } catch {
    database.completeActivityRecord(record.id, 0)
    emit(sendProgress, 'complete', 'Apple ledger format unrecognized', 0, 0, record.id, 'subscription')
    return freshActivityRecord(record.id, 'subscription')
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}
