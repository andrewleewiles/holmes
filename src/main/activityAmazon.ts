import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { redactActivityContent } from './activity'
import type { ActivityProgressSender } from './activity'
import * as database from './database'
import { assertPathAllowed } from './fileScope'
import { getAmazonCookies } from './keychain'
import type { ActivityRecord, ActivityIngestProgress } from '../shared/types'

export function redactAmazonContent(value: string): string {
  return redactActivityContent(value)
    .replace(/\b\d{3}-\d{7}-\d{3}(\d{4})\b/g, '[ORDER ...$1]')
    .replace(/\b(?:session[- ]?id|sessionId|ubid[- ]?main|at[- ]?main)\s*[=:]\s*[A-Za-z0-9._-]+/gi, '$1=[REDACTED]')
    .replace(/\b(?:ship[- ]?to|recipient|billing)[\s:]+([A-Z][a-z]+ [A-Z][a-z]+)/g, '$1 [REDACTED NAME]')
}

const BATCH_SIZE = 1000
const MAX_CSV_BYTES = 16 * 1024 * 1024
const MAX_EVENTS_PER_FILE = 2_000_000

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
    sourceType: 'amazon',
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
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
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
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = splitCsvLine(lines[0])
  const rows: string[][] = []
  for (let i = 1; i < lines.length; i += 1) {
    rows.push(splitCsvLine(lines[i]))
  }
  return { headers, rows }
}

function matchHeader(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i].trim().toLowerCase().replace(/[\s_]+/g, '')
    for (const alias of aliases) {
      const normalizedAlias = alias.toLowerCase().replace(/[\s_]+/g, '')
      if (header === normalizedAlias || header.includes(normalizedAlias)) return i
    }
  }
  return -1
}

function parsePriceCents(value: string | null | undefined): number | null {
  if (value == null) return null
  const cleaned = String(value).replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const num = Number.parseFloat(cleaned)
  if (!Number.isFinite(num)) return null
  return Math.round(num * 100)
}

function parseDateIso(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function pickField(obj: Record<string, unknown>, keys: string[]): unknown {
  const lowerKeys = keys.map((k) => k.toLowerCase())
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase()
    for (const lk of lowerKeys) {
      if (lower === lk || lower.replace(/[\s_]+/g, '') === lk.replace(/[\s_]+/g, '')) return v
    }
  }
  return undefined
}

interface AmazonItem {
  title: string
  quantity: number
  priceCents: number | null
}

export async function ingestAmazonOrdersCsv(
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

  if (size > MAX_CSV_BYTES) {
    const record = database.createActivityRecord({
      projectId,
      sourceType: 'amazon',
      filename: path.basename(resolved),
      fileSize: size,
      contentHash,
    })
    database.failActivityRecord(record.id, `Amazon CSV exceeds ${MAX_CSV_BYTES} bytes`)
    throw new Error('Amazon CSV is too large')
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'amazon', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = database.createActivityRecord({
    projectId,
    sourceType: 'amazon',
    filename: path.basename(resolved),
    fileSize: size,
    contentHash,
  })
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'Amazon CSV'}`, 0, null, record.id, 'amazon')

  try {
    if (safeAbort(signal)) throw new Error('Amazon CSV ingest cancelled')
    const buffer = await fs.promises.readFile(resolved)
    if (buffer.byteLength > MAX_CSV_BYTES) {
      throw new Error('Amazon CSV exceeds size cap')
    }
    emit(sendProgress, 'parsing', 'Parsing Amazon orders CSV', 0, null, record.id, 'amazon')
    const text = buffer.toString('utf8')
    const { headers, rows } = parseCsv(text)
    if (headers.length === 0) {
      throw new Error('Amazon CSV has no headers')
    }

    const orderIdIdx = matchHeader(headers, ['orderid', 'order'])
    const dateIdx = matchHeader(headers, ['orderdate', 'date', 'purchasedate'])
    const titleIdx = matchHeader(headers, ['itemtitle', 'title', 'productname', 'name'])
    const quantityIdx = matchHeader(headers, ['quantity', 'qty'])
    const priceIdx = matchHeader(headers, ['itemprice', 'price', 'unitprice'])
    const subtotalIdx = matchHeader(headers, ['itemsubtotal', 'subtotal'])
    const totalIdx = matchHeader(headers, ['ordertotal', 'total', 'grandtotal'])

    if (orderIdIdx === -1) {
      throw new Error('Amazon CSV is missing an Order ID column')
    }

    const orders = new Map<string, { occurredAt: string | null; items: AmazonItem[]; totalFromOrderCol: number | null }>()
    for (const row of rows) {
      const orderId = (row[orderIdIdx] ?? '').trim()
      if (!orderId) continue
      let entry = orders.get(orderId)
      if (!entry) {
        entry = { occurredAt: null, items: [], totalFromOrderCol: null }
        orders.set(orderId, entry)
      }
      if (entry.occurredAt === null && dateIdx >= 0) {
        const parsed = parseDateIso(row[dateIdx])
        if (parsed) entry.occurredAt = parsed
      }
      if (entry.totalFromOrderCol === null && totalIdx >= 0) {
        const cents = parsePriceCents(row[totalIdx])
        if (cents != null) entry.totalFromOrderCol = cents
      }
      const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : ''
      const quantityRaw = quantityIdx >= 0 ? (row[quantityIdx] ?? '').trim() : ''
      const quantity = Number.parseInt(quantityRaw, 10)
      const priceCents = parsePriceCents(priceIdx >= 0 ? row[priceIdx] : null)
        ?? parsePriceCents(subtotalIdx >= 0 ? row[subtotalIdx] : null)
      if (title) {
        entry.items.push({
          title,
          quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
          priceCents,
        })
      }
    }

    let total = 0
    let pending: Array<{ orderId: string; occurredAt: string; totalCents: number | null; title: string | null; items: AmazonItem[] }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const o of batch) {
          database.createAmazonEvent({
            recordId: record.id,
            occurredAt: o.occurredAt,
            orderId: o.orderId,
            title: o.title,
            totalCents: o.totalCents,
            items: o.items,
            sourceMeta: { source: 'csv' },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    let i = 0
    for (const [orderId, entry] of orders) {
      if (safeAbort(signal)) throw new Error('Amazon CSV ingest cancelled')
      const occurredAt = entry.occurredAt ?? new Date(0).toISOString()
      const computedTotal = entry.items.reduce((sum, it) => {
        if (it.priceCents == null) return sum
        return sum + it.priceCents * it.quantity
      }, 0)
      const totalCents = entry.totalFromOrderCol != null ? entry.totalFromOrderCol : (computedTotal > 0 ? computedTotal : null)
      const title = entry.items[0]?.title ?? null
      pending.push({ orderId, occurredAt, totalCents, title, items: entry.items })
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
      i += 1
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${total} orders`, total, orders.size, record.id, 'amazon')
    }
    flush()

    if (safeAbort(signal)) throw new Error('Amazon CSV ingest cancelled')
    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} Amazon orders`, total, total, record.id, 'amazon')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    throw err
  }
}

export async function ingestAmazonOrdersJson(
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

  if (size > MAX_CSV_BYTES) {
    const record = database.createActivityRecord({
      projectId,
      sourceType: 'amazon',
      filename: path.basename(resolved),
      fileSize: size,
      contentHash,
    })
    database.failActivityRecord(record.id, `Amazon JSON exceeds ${MAX_CSV_BYTES} bytes`)
    throw new Error('Amazon JSON is too large')
  }

  if (contentHash) {
    const existing = database.findActivityRecord(projectId, 'amazon', contentHash)
    if (existing && existing.status === 'parsed') {
      database.touchActivityRecordImportedAt(existing.id)
      return existing
    }
  }

  const record = database.createActivityRecord({
    projectId,
    sourceType: 'amazon',
    filename: path.basename(resolved),
    fileSize: size,
    contentHash,
  })
  emit(sendProgress, 'reading', `Reading ${record.filename ?? 'Amazon JSON'}`, 0, null, record.id, 'amazon')

  try {
    if (safeAbort(signal)) throw new Error('Amazon JSON ingest cancelled')
    const buffer = await fs.promises.readFile(resolved)
    if (buffer.byteLength > MAX_CSV_BYTES) {
      throw new Error('Amazon JSON exceeds size cap')
    }
    emit(sendProgress, 'parsing', 'Parsing Amazon orders JSON', 0, null, record.id, 'amazon')
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown
    let ordersArray: unknown[] = []
    if (Array.isArray(parsed)) {
      ordersArray = parsed
    } else if (parsed && typeof parsed === 'object') {
      const wrapper = parsed as Record<string, unknown>
      const candidate = wrapper.orders ?? wrapper.orderHistory ?? wrapper.items
      if (Array.isArray(candidate)) ordersArray = candidate
    }

    let total = 0
    let pending: Array<{ orderId: string; occurredAt: string; totalCents: number | null; title: string | null; items: AmazonItem[] }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const o of batch) {
          database.createAmazonEvent({
            recordId: record.id,
            occurredAt: o.occurredAt,
            orderId: o.orderId,
            title: o.title,
            totalCents: o.totalCents,
            items: o.items,
            sourceMeta: { source: 'json' },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    for (let i = 0; i < ordersArray.length; i += 1) {
      if (safeAbort(signal)) throw new Error('Amazon JSON ingest cancelled')
      const entry = ordersArray[i] as Record<string, unknown>
      if (!entry || typeof entry !== 'object') continue
      const orderIdRaw = pickField(entry, ['orderId', 'order_id', 'id', 'orderNumber'])
      const orderId = typeof orderIdRaw === 'string' ? orderIdRaw.trim() : (typeof orderIdRaw === 'number' ? String(orderIdRaw) : '')
      if (!orderId) continue
      const dateRaw = pickField(entry, ['orderDate', 'order_date', 'date', 'purchaseDate', 'purchase_date'])
      const occurredAt = parseDateIso(typeof dateRaw === 'string' ? dateRaw : null)
        ?? parseDateIso(typeof dateRaw === 'number' ? new Date(dateRaw).toISOString() : null)
        ?? new Date(0).toISOString()
      const totalRaw = pickField(entry, ['orderTotal', 'order_total', 'total', 'grandTotal', 'totalAmount'])
      const totalCents = parsePriceCents(typeof totalRaw === 'string' ? totalRaw : null)
        ?? (typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? Math.round(totalRaw * 100) : null)

      const itemsRaw = pickField(entry, ['items', 'lineItems', 'orderItems'])
      const items: AmazonItem[] = []
      if (Array.isArray(itemsRaw)) {
        for (const it of itemsRaw) {
          if (!it || typeof it !== 'object') continue
          const ir = it as Record<string, unknown>
          const titleRaw = pickField(ir, ['title', 'name', 'productName', 'product_name'])
          const title = typeof titleRaw === 'string' ? titleRaw.trim() : ''
          if (!title) continue
          const qtyRaw = pickField(ir, ['quantity', 'qty'])
          const quantity = typeof qtyRaw === 'number' && Number.isFinite(qtyRaw) && qtyRaw > 0
            ? Math.floor(qtyRaw)
            : (typeof qtyRaw === 'string' ? (Number.parseInt(qtyRaw, 10) || 1) : 1)
          const priceRaw = pickField(ir, ['price', 'priceCents', 'price_cents', 'unitPrice', 'itemPrice'])
          let priceCents: number | null = null
          if (typeof priceRaw === 'number' && Number.isFinite(priceRaw)) {
            priceCents = priceRaw > 1000 ? Math.round(priceRaw) : Math.round(priceRaw * 100)
          } else if (typeof priceRaw === 'string') {
            priceCents = parsePriceCents(priceRaw)
          }
          items.push({ title, quantity, priceCents })
        }
      }

      const computedTotal = items.reduce((sum, it) => {
        if (it.priceCents == null) return sum
        return sum + it.priceCents * it.quantity
      }, 0)
      const finalTotalCents = totalCents != null ? totalCents : (computedTotal > 0 ? computedTotal : null)
      const title = items[0]?.title ?? null

      pending.push({ orderId, occurredAt, totalCents: finalTotalCents, title, items })
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${total} orders`, total, ordersArray.length, record.id, 'amazon')
    }
    flush()

    if (safeAbort(signal)) throw new Error('Amazon JSON ingest cancelled')
    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} Amazon orders`, total, total, record.id, 'amazon')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    throw err
  }
}

export async function syncAmazonOrdersGraphQL(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const LIVE_FILENAME = 'graphql-sync'
  const existing = database.findLiveActivityRecord(projectId, 'amazon', LIVE_FILENAME)
  let record: ActivityRecord
  if (existing) {
    database.resetActivityRecord(existing.id)
    database.touchActivityRecordImportedAt(existing.id)
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'amazon',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  let cookies: string | null = null
  try {
    cookies = await getAmazonCookies()
  } catch {
    cookies = null
  }

  if (!cookies) {
    database.failActivityRecord(record.id, 'Amazon cookies not set — reauth required')
    emit(sendProgress, 'reauth', 'Connect your Amazon account in Settings', null, null, record.id, 'amazon')
    return freshActivityRecord(record.id)
  }

  try {
    if (safeAbort(signal)) throw new Error('Amazon GraphQL sync cancelled')
    emit(sendProgress, 'reading', 'Fetching order history from Amazon', 0, null, record.id, 'amazon')

    let response: Response
    try {
      response = await fetch('https://www.amazon.com/api/graphql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
        body: JSON.stringify({
          query: '{ orderHistory { orders { orderId orderDate orderTotal items { title quantity price } } } }',
        }),
        signal,
      } as never)
    } catch (err) {
      if (safeAbort(signal)) throw err
      database.failActivityRecord(record.id, 'Amazon cookies expired — reauth required')
      emit(sendProgress, 'reauth', 'Amazon cookies expired — please reconnect', null, null, record.id, 'amazon')
      return freshActivityRecord(record.id)
    }

    if (!response.ok) {
      database.failActivityRecord(record.id, `Amazon returned HTTP ${response.status} — reauth required`)
      emit(sendProgress, 'reauth', 'Amazon cookies expired — please reconnect', null, null, record.id, 'amazon')
      return freshActivityRecord(record.id)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      database.failActivityRecord(record.id, 'Amazon response unparseable — reauth required')
      emit(sendProgress, 'reauth', 'Amazon response unparseable — please reconnect', null, null, record.id, 'amazon')
      return freshActivityRecord(record.id)
    }

    if (!payload || typeof payload !== 'object') {
      database.completeActivityRecord(record.id, 0)
      emit(sendProgress, 'complete', 'No Amazon orders returned', 0, 0, record.id, 'amazon')
      return freshActivityRecord(record.id)
    }
    const dataObj = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined
    const orderHistory = dataObj?.orderHistory as Record<string, unknown> | undefined
    const ordersArr = orderHistory?.orders
    if (!Array.isArray(ordersArr) || ordersArr.length === 0) {
      database.completeActivityRecord(record.id, 0)
      emit(sendProgress, 'complete', 'Amazon sync returned no orders — use CSV import from amazon.com/gp/your-account/order-history instead', 0, 0, record.id, 'amazon')
      return freshActivityRecord(record.id)
    }

    const ordersRaw = extractOrdersFromGraphQLPayload(payload)

    let total = 0
    let pending: Array<{ orderId: string; occurredAt: string; totalCents: number | null; title: string | null; items: AmazonItem[] }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const o of batch) {
          database.createAmazonEvent({
            recordId: record.id,
            occurredAt: o.occurredAt,
            orderId: o.orderId,
            title: o.title,
            totalCents: o.totalCents,
            items: o.items,
            sourceMeta: { source: 'graphql' },
          })
          total += 1
          if (total >= MAX_EVENTS_PER_FILE) break
        }
      })
    }

    for (let i = 0; i < ordersRaw.length; i += 1) {
      if (safeAbort(signal)) throw new Error('Amazon GraphQL sync cancelled')
      pending.push(ordersRaw[i])
      if (pending.length >= BATCH_SIZE) flush()
      if (total >= MAX_EVENTS_PER_FILE) break
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${total} orders`, total, ordersRaw.length, record.id, 'amazon')
    }
    flush()

    if (safeAbort(signal)) throw new Error('Amazon GraphQL sync cancelled')
    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} Amazon orders`, total, total, record.id, 'amazon')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    throw err
  }
}

interface GraphQLOrder {
  orderId: string
  occurredAt: string
  totalCents: number | null
  title: string | null
  items: AmazonItem[]
}

function extractOrdersFromGraphQLPayload(payload: unknown): GraphQLOrder[] {
  if (!payload || typeof payload !== 'object') return []
  const candidates: unknown[] = []
  const stack: unknown[] = [payload]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }
    const record = current as Record<string, unknown>
    if ('orderId' in record || 'order_id' in record) {
      candidates.push(current)
      continue
    }
    if ('orders' in record && Array.isArray(record.orders)) {
      stack.push(...(record.orders as unknown[]))
      continue
    }
    if ('orderHistory' in record && typeof record.orderHistory === 'object') {
      stack.push(record.orderHistory)
      continue
    }
    if ('data' in record && typeof record.data === 'object') {
      stack.push(record.data)
      continue
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }

  const out: GraphQLOrder[] = []
  for (const candidate of candidates) {
    const r = candidate as Record<string, unknown>
    const orderIdRaw = pickField(r, ['orderId', 'order_id'])
    const orderId = typeof orderIdRaw === 'string' ? orderIdRaw.trim() : (typeof orderIdRaw === 'number' ? String(orderIdRaw) : '')
    if (!orderId) continue
    const dateRaw = pickField(r, ['orderDate', 'order_date', 'date', 'purchaseDate'])
    const occurredAt = parseDateIso(typeof dateRaw === 'string' ? dateRaw : null)
      ?? parseDateIso(typeof dateRaw === 'number' ? new Date(dateRaw).toISOString() : null)
      ?? new Date(0).toISOString()
    const totalRaw = pickField(r, ['orderTotal', 'order_total', 'total', 'grandTotal'])
    const totalCents = parsePriceCents(typeof totalRaw === 'string' ? totalRaw : null)
      ?? (typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? Math.round(totalRaw * 100) : null)
    const itemsRaw = pickField(r, ['items', 'lineItems', 'orderItems'])
    const items: AmazonItem[] = []
    if (Array.isArray(itemsRaw)) {
      for (const it of itemsRaw) {
        if (!it || typeof it !== 'object') continue
        const ir = it as Record<string, unknown>
        const titleRaw = pickField(ir, ['title', 'name', 'productName'])
        const title = typeof titleRaw === 'string' ? titleRaw.trim() : ''
        if (!title) continue
        const qtyRaw = pickField(ir, ['quantity', 'qty'])
        const quantity = typeof qtyRaw === 'number' && Number.isFinite(qtyRaw) && qtyRaw > 0
          ? Math.floor(qtyRaw)
          : (typeof qtyRaw === 'string' ? (Number.parseInt(qtyRaw, 10) || 1) : 1)
        const priceRaw = pickField(ir, ['price', 'priceCents', 'unitPrice'])
        let priceCents: number | null = null
        if (typeof priceRaw === 'number' && Number.isFinite(priceRaw)) {
          priceCents = priceRaw > 1000 ? Math.round(priceRaw) : Math.round(priceRaw * 100)
        } else if (typeof priceRaw === 'string') {
          priceCents = parsePriceCents(priceRaw)
        }
        items.push({ title, quantity, priceCents })
      }
    }
    const title = items[0]?.title ?? null
    out.push({ orderId, occurredAt, totalCents, title, items })
  }
  return out
}

export async function ingestAmazonFile(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.csv') return ingestAmazonOrdersCsv(filePath, projectId, signal, sendProgress)
  if (ext === '.json') return ingestAmazonOrdersJson(filePath, projectId, signal, sendProgress)
  throw new Error(`Unsupported Amazon file type: ${ext}`)
}
