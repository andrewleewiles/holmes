import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { SaxesParser } from 'saxes'
import { XMLParser } from 'fast-xml-parser'
import type {
  ProviderConfig,
  HealthRecord,
  HealthObservation,
  HealthObservationType,
  HealthSourceType,
  HealthIngestProgress,
  DirectoryScanResult,
} from '../shared/types'
import * as database from './database'
import { collectProjectDataFiles } from './projectContext'
import { redactMemoryContent } from './memory'
import { loadPdfjs } from './pdfjs'
import { getBaseUrl, getHeaders } from './providerEndpoint'

export function redactHealthContent(value: string): string {
  return redactMemoryContent(value)
    .replace(/\bMRN\s*[:#]?\s*[A-Za-z0-9-]{4,}\b/gi, 'MRN [REDACTED]')
    .replace(/\bNPI\s+\d{10}\b/g, 'NPI [REDACTED]')
    .replace(/\b(?:DOB|Date of Birth)\s*[:#]?\s*(?:\d{1,4}[-/ ])?\d{1,2}[-/ ]\d{1,4}\b/gi, 'DOB [REDACTED]')
    .replace(/\bEHN\s*\d{6,}\b/gi, 'EHN [REDACTED]')
    .replace(/\bMyChart\s+Account\s*#?\s*\d{4,}\b/gi, 'MyChart Account [REDACTED]')
    .replace(/\b1[-. (]?\d{3}[-. )]?\d{3}[-. ]?\d{4}\b/g, '[REDACTED PHONE]')
}

const BATCH_SIZE = 1000
const MAX_CCDA_BYTES = 8 * 1024 * 1024
const MAX_CSV_BYTES = 16 * 1024 * 1024
const MAX_PDF_PAGES = 200
const MAX_OBSERVATIONS_PER_FILE = 2_000_000

export type HealthProgressSender = (progress: HealthIngestProgress) => void

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

/**
 * Cheap identity for a file on disk: path, size and mtime rather than its bytes.
 *
 * An Apple Health export runs to hundreds of megabytes, so hashing contents on
 * every scan would cost minutes of disk I/O to conclude that nothing changed.
 * Health exports are written whole and replaced, never edited in place, so
 * size+mtime is a sound change signal for them.
 */
export function healthFileIdentity(filePath: string): string {
  // Resolved first: a folder scan yields realpath'd files while the file picker
  // yields whatever the user navigated to, and on macOS those differ for
  // anything under /var (symlinked to /private/var). Without this, importing a
  // file by hand and then scanning its folder ingests it twice.
  let resolved = filePath
  try {
    resolved = fs.realpathSync(filePath)
  } catch { /* Missing file: keep the path as given and fail on ingest below. */ }
  let size = 0
  let mtime = 0
  try {
    const stat = fs.statSync(resolved)
    size = stat.size
    mtime = Math.round(stat.mtimeMs)
  } catch { /* Unreadable files hash as zeros and fail on ingest below. */ }
  return crypto.createHash('sha256').update(`${resolved}\n${size}\n${mtime}`).digest('hex').slice(0, 32)
}

function makeRecord(
  projectId: string,
  sourceType: HealthSourceType,
  filePath: string,
  buffer?: Buffer
): HealthRecord {
  return database.createHealthRecord({
    projectId,
    sourceType,
    filename: path.basename(filePath),
    fileSize: fileSize(filePath),
    contentHash: buffer ? hashContent(buffer) : null,
    // Recorded on every path, including a manual import: what matters is that a
    // later folder scan can recognize the file, not how it first arrived.
    sourcePath: filePath,
    identityHash: healthFileIdentity(filePath),
    status: 'pending',
    parseError: null,
    observationsCount: 0,
  })
}

function failRecord(recordId: string, message: string): void {
  database.updateHealthRecordStatus(recordId, 'failed', message, 0)
}

function freshRecord(recordId: string): HealthRecord {
  const fresh = database.getHealthRecord(recordId)
  if (fresh) return fresh
  return {
    id: recordId,
    projectId: '',
    sourceType: 'other',
    filename: '',
    fileSize: 0,
    contentHash: null,
    sourcePath: null,
    identityHash: null,
    importedAt: 0,
    status: 'parsed',
    parseError: null,
    observationsCount: 0,
  }
}

function completeRecord(recordId: string, count: number): void {
  database.updateHealthRecordStatus(recordId, 'parsed', null, count)
}

function observationFromRow(
  recordId: string,
  partial: Omit<HealthObservation, 'id' | 'createdAt' | 'recordId'>
): HealthObservation {
  return database.createHealthObservation({ recordId, ...partial })
}

function observationMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/[<>=~]/g, '').trim()
    if (!cleaned) return null
    const match = cleaned.match(/^(-?\d+(?:\.\d+)?)/)
    if (match) {
      const num = Number(match[1])
      if (Number.isFinite(num)) return num
    }
  }
  return null
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const iso = trimmed.length <= 10
    ? `${trimmed}T00:00:00`
    : trimmed
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

async function detectXmlRoot(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(filePath, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const match = head.match(/<\s*([A-Za-z][A-Za-z0-9:._-]*)/)
    return match ? match[1] : null
  } catch {
    return null
  } finally {
    if (handle) await handle.close()
  }
}

const VITAL_TYPES = new Set<string>([
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierWalkingHeartRateAverage',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierBloodPressureSystolic',
  'HKQuantityTypeIdentifierBloodPressureDiastolic',
  'HKQuantityTypeIdentifierRespiratoryRate',
  'HKQuantityTypeIdentifierOxygenSaturation',
  'HKQuantityTypeIdentifierBodyTemperature',
  'HKQuantityTypeIdentifierStepCount',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierBasalEnergyBurned',
  'HKQuantityTypeIdentifierDistanceWalkingRunning',
  'HKQuantityTypeIdentifierDistanceCycling',
  'HKQuantityTypeIdentifierFlightsClimbed',
  'HKQuantityTypeIdentifierAppleExerciseTime',
  'HKQuantityTypeIdentifierAppleStandTime',
  'HKQuantityTypeIdentifierSleepAnalysis',
  'HKQuantityTypeIdentifierBodyMass',
  'HKQuantityTypeIdentifierBodyMassIndex',
  'HKQuantityTypeIdentifierHeight',
  'HKQuantityTypeIdentifierWaistCircumference',
  'HKQuantityTypeIdentifierDietaryCaffeine',
  'HKQuantityTypeIdentifierDietarySugar',
  'HKQuantityTypeIdentifierBiologicalSex',
  'HKQuantityTypeIdentifierBloodGlucose',
  'HKQuantityTypeIdentifierBloodAlcoholContent',
  'HKQuantityTypeIdentifierEnvironmentalAudioExposure',
  'HKQuantityTypeIdentifierHeadphoneAudioExposure',
  'HKQuantityTypeIdentifierUVExposure',
  'HKQuantityTypeIdentifierInhaledOxygenVolume',
  'HKQuantityTypeIdentifierNumberOfTimesFallen',
  'HKQuantityTypeIdentifierSixMinuteWalkTestDistance',
])

const WORKOUT_TYPES = new Set<string>([
  'HKWorkoutTypeIdentifier',
])

function classifyAppleHealthType(type: string): HealthObservationType {
  if (WORKOUT_TYPES.has(type) || type === 'HKWorkout') return 'workout'
  if (VITAL_TYPES.has(type)) return 'vital'
  return 'observation'
}

interface PendingAppleObservation {
  type: HealthObservationType
  code: string | null
  displayName: string
  valueReal: number | null
  valueText: string | null
  unit: string | null
  refLow: number | null
  refHigh: number | null
  effectiveDate: string | null
  sourceMeta: Record<string, unknown>
}

export async function ingestAppleHealthExport(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: HealthProgressSender
): Promise<HealthRecord> {
  const record = makeRecord(projectId, 'apple_health', filePath)
  if (sendProgress) sendProgress({ phase: 'reading', message: `Reading ${record.filename}`, current: 0, total: 0, recordId: record.id })
  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('Apple Health ingest cancelled')
  }

  let parsed = 0
  let pending: PendingAppleObservation[] = []
  let clinicalRecordBuffer: Record<string, unknown> | null = null
  let clinicalRecords: HealthRecord[] = []

  const flush = () => {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    database.runInTransaction(() => {
      for (const p of batch) {
        database.createHealthObservation({ recordId: record.id, ...p })
        parsed += 1
        if (parsed >= MAX_OBSERVATIONS_PER_FILE) break
      }
    })
  }

  const parser = new SaxesParser()
  parser.on('error', () => {
    // saxes reports errors on malformed bytes; keep going
  })

  parser.on('opentag', (node) => {
    if (safeAbort(signal)) return
    const name = node.name
    const attrs = node.attributes as Record<string, string>
    if (name === 'Record') {
      const type = attrs.type || ''
      const value = attrs.value
      const unit = attrs.unit || ''
      const startDate = attrs.startDate
      const displayName = type.replace(/^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier/, '')
      pending.push({
        type: classifyAppleHealthType(type),
        code: type,
        displayName: displayName || type,
        valueReal: parseNumber(value),
        valueText: value ?? null,
        unit: unit || null,
        refLow: null,
        refHigh: null,
        effectiveDate: normalizeDate(startDate),
        sourceMeta: observationMeta({ source: 'apple_health', type }),
      })
      if (pending.length >= BATCH_SIZE) flush()
    } else if (name === 'Workout') {
      const workoutType = attrs.workoutActivityType || 'HKWorkout'
      const startDate = attrs.startDate
      const duration = parseNumber(attrs.duration)
      const totalEnergy = parseNumber(attrs.totalEnergyBurned)
      const unit = attrs.totalEnergyBurnedUnit || ''
      pending.push({
        type: 'workout',
        code: workoutType,
        displayName: workoutType.replace(/^HKWorkoutActivityType/, '') || 'Workout',
        valueReal: totalEnergy,
        valueText: totalEnergy != null ? String(totalEnergy) : null,
        unit: unit || null,
        refLow: null,
        refHigh: null,
        effectiveDate: normalizeDate(startDate),
        sourceMeta: observationMeta({
          source: 'apple_health',
          workoutType,
          duration,
        }),
      })
      if (pending.length >= BATCH_SIZE) flush()
    } else if (name === 'ClinicalRecord') {
      clinicalRecordBuffer = {
        type: attrs.type || '',
        displayName: attrs.displayName || attrs.type || 'Clinical Record',
        startDate: attrs.startDate,
        identifier: attrs.identifier,
      }
    }
  })

  parser.on('closetag', (node) => {
    const tagName: string = (node as { name?: string }).name ?? ''
    if (tagName === 'ClinicalRecord' && clinicalRecordBuffer) {
      const clinical = clinicalRecordBuffer
      clinicalRecordBuffer = null
      const childRecord = database.createHealthRecord({
        projectId,
        sourceType: 'mychart',
        filename: `${record.filename}#${parsed}`,
        fileSize: 0,
        contentHash: null,
        // A clinical record parsed out of a parent document, not a file on disk.
        sourcePath: null,
        identityHash: null,
        status: 'parsed',
        parseError: null,
        observationsCount: 0,
      })
      clinicalRecords.push(childRecord)
      database.createHealthObservation({
        recordId: childRecord.id,
        type: 'observation',
        code: typeof clinical.type === 'string' ? clinical.type : null,
        displayName: typeof clinical.displayName === 'string' ? clinical.displayName : 'Clinical Record',
        valueReal: null,
        valueText: null,
        unit: null,
        refLow: null,
        refHigh: null,
        effectiveDate: normalizeDate(clinical.startDate),
        sourceMeta: observationMeta({
          source: 'apple_health_clinical',
          identifier: clinical.identifier,
        }),
      })
    }
  })

  parser.on('end', () => {
    flush()
  })

  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    stream.on('data', (chunk: string) => {
      if (safeAbort(signal)) {
        stream.destroy()
        return
      }
      parser.write(chunk)
      if (sendProgress && parsed % 5000 === 0) {
        sendProgress({ phase: 'parsing', message: `Parsed ${parsed} records`, current: parsed, total: 0, recordId: record.id })
      }
    })
    stream.on('end', () => {
      try {
        parser.close()
        resolve()
      } catch (err) {
        reject(err)
      }
    })
    stream.on('error', (err) => reject(err))
  })

  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('Apple Health ingest cancelled')
  }

  completeRecord(record.id, parsed)
  if (sendProgress) sendProgress({ phase: 'complete', message: `Imported ${parsed} records`, current: parsed, total: parsed, recordId: record.id })
  return freshRecord(record.id)
}

function findFirst(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const stack: unknown[] = [obj]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }
    const record = current as Record<string, unknown>
    for (const key of keys) {
      if (key in record) return record[key]
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return undefined
}

function findSectionByName(doc: Record<string, unknown>, names: string[]): Record<string, unknown> | null {
  const stack: unknown[] = [doc]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }
    const record = current as Record<string, unknown>
    const code = record.code
    const title = record.title
    const nameMatch = (typeof title === 'string' && names.some((n) => title.toLowerCase().includes(n)))
      || (typeof code === 'object' && code !== null
        && names.some((n) => String((code as Record<string, unknown>).displayName ?? '').toLowerCase().includes(n)))
    if (nameMatch) return record
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return null
}

function extractCcdaEntries(section: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const stack: unknown[] = [section]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item)
      continue
    }
    const record = current as Record<string, unknown>
    if ('entry' in record) {
      const entry = record.entry
      if (Array.isArray(entry)) out.push(...(entry as Record<string, unknown>[]))
      else if (entry && typeof entry === 'object') out.push(entry as Record<string, unknown>)
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }
  return out
}

function extractText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join(' ').trim()
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record._ === 'string') return record._
    return Object.values(record).map(extractText).join(' ').trim()
  }
  return ''
}

function findCode(node: unknown): { code: string | null; system: string | null } {
  if (!node || typeof node !== 'object') return { code: null, system: null }
  const record = node as Record<string, unknown>
  const code = record.code
  if (code && typeof code === 'object') {
    const c = code as Record<string, unknown>
    return {
      code: typeof c.code === 'string' ? c.code : null,
      system: typeof c.codeSystem === 'string' ? c.codeSystem : null,
    }
  }
  if (typeof code === 'string') return { code, system: null }
  return { code: null, system: null }
}

export async function ingestMyChartCcda(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: HealthProgressSender
): Promise<HealthRecord> {
  const buffer = await fs.promises.readFile(filePath)
  if (buffer.byteLength > MAX_CCDA_BYTES) {
    const record = makeRecord(projectId, 'mychart', filePath, buffer)
    failRecord(record.id, `CCDA file exceeds ${MAX_CCDA_BYTES} bytes`)
    throw new Error('CCDA file is too large')
  }
  const record = makeRecord(projectId, 'mychart', filePath, buffer)
  if (sendProgress) sendProgress({ phase: 'parsing', message: `Parsing ${record.filename}`, current: 0, total: 0, recordId: record.id })
  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('MyChart CCDA ingest cancelled')
  }

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: true,
  })
  const doc = xmlParser.parse(buffer.toString('utf8')) as Record<string, unknown>
  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('MyChart CCDA ingest cancelled')
  }

  let parsed = 0
  const sectionNames: Array<[string[], HealthObservationType]> = [
    [['medication'], 'medication'],
    [['problem'], 'condition'],
    [['lab'], 'lab'],
    [['vital'], 'vital'],
    [['allerg'], 'observation'],
    [['immunization'], 'observation'],
    [['procedure'], 'observation'],
  ]

  for (const [names, type] of sectionNames) {
    if (safeAbort(signal)) break
    const section = findSectionByName(doc, names)
    if (!section) continue
    const entries = extractCcdaEntries(section)
    for (const entry of entries) {
      if (parsed >= MAX_OBSERVATIONS_PER_FILE) break
      const displayName = extractText(entry).slice(0, 200) || names[0]
      const { code } = findCode(entry)
      const value = findFirst(entry, ['value', 'valueQuantity', 'effectiveTime', 'low', 'high'])
      const valueText = typeof value === 'string' ? value : (value && typeof value === 'object' ? extractText(value) : '')
      const valueReal = parseNumber(valueText)
      const unit = (value && typeof value === 'object' && 'unit' in (value as Record<string, unknown>))
        ? String((value as Record<string, unknown>).unit)
        : null
      const effective = findFirst(entry, ['effectiveTime', 'low', 'startDate'])
      const effectiveStr = typeof effective === 'string' ? effective : (effective && typeof effective === 'object' ? extractText(effective) : '')
      database.createHealthObservation({
        recordId: record.id,
        type,
        code,
        displayName: displayName || type,
        valueReal,
        valueText: valueText || null,
        unit,
        refLow: null,
        refHigh: null,
        effectiveDate: normalizeDate(effectiveStr) || normalizeDate(extractText(effective)),
        sourceMeta: observationMeta({ source: 'mychart', section: names[0] }),
      })
      parsed += 1
    }
  }

  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('MyChart CCDA ingest cancelled')
  }
  completeRecord(record.id, parsed)
  if (sendProgress) sendProgress({ phase: 'complete', message: `Imported ${parsed} observations`, current: parsed, total: parsed, recordId: record.id })
  return freshRecord(record.id)
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

function matchHeader(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i].trim().toLowerCase()
    for (const alias of aliases) {
      if (header === alias || header.includes(alias)) return i
    }
  }
  return -1
}

function parseRefRange(value: string): { low: number | null; high: number | null } {
  if (!value) return { low: null, high: null }
  const cleaned = value.replace(/[<>\s]/g, '')
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(-?\d+(?:\.\d+)?)$/i)
  if (match) {
    const low = Number(match[1])
    const high = Number(match[2])
    if (Number.isFinite(low) && Number.isFinite(high)) return { low, high }
  }
  const single = cleaned.match(/^([<>]?)\s*(\d+(?:\.\d+)?)$/)
  if (single) {
    const num = Number(single[2])
    if (Number.isFinite(num)) {
      if (single[1] === '<') return { low: null, high: num }
      if (single[1] === '>') return { low: num, high: null }
      return { low: null, high: num }
    }
  }
  return { low: null, high: null }
}

export async function ingestBloodworkCsv(
  filePath: string,
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: HealthProgressSender
): Promise<HealthRecord> {
  const buffer = await fs.promises.readFile(filePath)
  if (buffer.byteLength > MAX_CSV_BYTES) {
    const record = makeRecord(projectId, 'bloodwork', filePath, buffer)
    failRecord(record.id, `CSV exceeds ${MAX_CSV_BYTES} bytes`)
    throw new Error('Bloodwork CSV is too large')
  }
  const record = makeRecord(projectId, 'bloodwork', filePath, buffer)
  if (sendProgress) sendProgress({ phase: 'parsing', message: `Parsing ${record.filename}`, current: 0, total: 0, recordId: record.id })
  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('Bloodwork CSV ingest cancelled')
  }

  const text = buffer.toString('utf8')
  const { headers, rows } = parseCsv(text)
  if (headers.length === 0) {
    failRecord(record.id, 'No headers found in CSV')
    throw new Error('Bloodwork CSV has no headers')
  }

  const nameIdx = matchHeader(headers, ['name', 'test', 'biomarker', 'marker', 'analyte', 'panel'])
  const valueIdx = matchHeader(headers, ['value', 'result', 'reading'])
  const unitIdx = matchHeader(headers, ['unit', 'units'])
  const refIdx = matchHeader(headers, ['reference range', 'ref range', 'range', 'reference interval'])
  const dateIdx = matchHeader(headers, ['date', 'collection date', 'collected', 'draw date'])
  const flagIdx = matchHeader(headers, ['flag', 'flags', 'abnormal flag'])
  const labIdx = matchHeader(headers, ['lab', 'lab name', 'laboratory'])

  if (nameIdx === -1) {
    failRecord(record.id, 'No lab name column detected')
    throw new Error('Bloodwork CSV is missing a lab name column')
  }

  let parsed = 0
  for (const row of rows) {
    if (parsed >= MAX_OBSERVATIONS_PER_FILE) break
    if (safeAbort(signal)) break
    const name = row[nameIdx]?.trim()
    if (!name) continue
    const valueStr = valueIdx >= 0 ? (row[valueIdx] ?? '').trim() : ''
    const unit = unitIdx >= 0 ? (row[unitIdx] ?? '').trim() : ''
    const refStr = refIdx >= 0 ? (row[refIdx] ?? '').trim() : ''
    const dateStr = dateIdx >= 0 ? (row[dateIdx] ?? '').trim() : ''
    const flag = flagIdx >= 0 ? (row[flagIdx] ?? '').trim() : ''
    const labName = labIdx >= 0 ? (row[labIdx] ?? '').trim() : ''
    const ref = parseRefRange(refStr)
    database.createHealthObservation({
      recordId: record.id,
      type: 'lab',
      code: null,
      displayName: redactHealthContent(name).slice(0, 200),
      valueReal: parseNumber(valueStr),
      valueText: valueStr || null,
      unit: unit || null,
      refLow: ref.low,
      refHigh: ref.high,
      effectiveDate: normalizeDate(dateStr),
      sourceMeta: observationMeta({ source: 'bloodwork', flag, lab: labName || undefined }),
    })
    parsed += 1
  }

  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('Bloodwork CSV ingest cancelled')
  }
  completeRecord(record.id, parsed)
  if (sendProgress) sendProgress({ phase: 'complete', message: `Imported ${parsed} lab rows`, current: parsed, total: parsed, recordId: record.id })
  return freshRecord(record.id)
}

interface PdfLabRow {
  name: string
  value: string
  unit: string
  refLow: number | null
  refHigh: number | null
  collectionDate: string | null
  labName: string | null
}

const BLOODWORK_EXTRACTION_SYSTEM_PROMPT = `You extract structured lab result rows from raw text extracted from bloodwork PDF documents.

Return ONLY a valid JSON object (no markdown, no code fences) with this exact shape:
{
  "rows": [
    {
      "name": "<test name>",
      "value": "<value as plain text>",
      "unit": "<unit if present, otherwise empty string>",
      "refLow": <number or null>,
      "refHigh": <number or null>,
      "collectionDate": "<ISO date if present, otherwise null>",
      "labName": "<lab name if present, otherwise null>"
    }
  ]
}

Rules:
- Only include rows that are clearly lab results with a numeric or categorical value.
- Preserve units exactly as written.
- For reference ranges, parse low/high numbers when expressed as "low - high" or "< x" or "> x".
- Use ISO 8601 (YYYY-MM-DD) for collectionDate when present.
- Do not invent values. If a field is missing, use null or empty string as appropriate.
- Ignore header rows, page numbers, and provider addresses.
- Return at most 200 rows.`

function extractJsonFromText(text: string): unknown | null {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

async function extractPdfText(filePath: string, signal?: AbortSignal): Promise<string> {
  const pdfjs = await loadPdfjs()
  const data = await fs.promises.readFile(filePath)
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    useSystemFonts: true,
  } as never)
  const doc = await loadingTask.promise
  let text = ''
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES)
  for (let i = 1; i <= pages; i += 1) {
    if (safeAbort(signal)) break
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const strings = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    text += `${strings}\n`
    if (text.length > 200_000) break
  }
  try {
    await loadingTask.destroy()
  } catch { /* ignore */ }
  return text
}

async function extractLabRowsFromPdfText(
  text: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal
): Promise<PdfLabRow[]> {
  if (!text.trim()) return []
  const redacted = redactHealthContent(text)
  const response = await fetch(`${getBaseUrl(config)}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(config),
    signal: signal as never,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: BLOODWORK_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: redacted.slice(0, 50_000) },
      ],
      max_tokens: 4000,
      temperature: 0,
      stream: false,
    }),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(`Bloodwork extraction failed: HTTP ${response.status} ${errorBody.slice(0, 200)}`)
  }
  const payload = await response.json()
  const content: string = payload?.choices?.[0]?.message?.content || ''
  const parsed = extractJsonFromText(content)
  if (!parsed || typeof parsed !== 'object') return []
  const rows = (parsed as Record<string, unknown>).rows
  if (!Array.isArray(rows)) return []
  const out: PdfLabRow[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    out.push({
      name: typeof r.name === 'string' ? r.name : '',
      value: typeof r.value === 'string' ? r.value : '',
      unit: typeof r.unit === 'string' ? r.unit : '',
      refLow: typeof r.refLow === 'number' ? r.refLow : null,
      refHigh: typeof r.refHigh === 'number' ? r.refHigh : null,
      collectionDate: typeof r.collectionDate === 'string' ? r.collectionDate : null,
      labName: typeof r.labName === 'string' ? r.labName : null,
    })
  }
  return out
}

export async function ingestBloodworkPdf(
  filePath: string,
  projectId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  sendProgress?: HealthProgressSender
): Promise<HealthRecord> {
  const record = makeRecord(projectId, 'bloodwork', filePath)
  if (sendProgress) sendProgress({ phase: 'reading', message: `Reading ${record.filename}`, current: 0, total: 0, recordId: record.id })
  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('Bloodwork PDF ingest cancelled')
  }
  // Anything thrown between here and completeRecord has to land on the record.
  // Without this the row stayed 'pending' with no parse_error forever, and the
  // reason went into a scan-result array nothing displayed — which is how every
  // PDF failed silently while looking merely unfinished.
  let text: string
  let rows: PdfLabRow[]
  try {
    text = await extractPdfText(filePath, signal)
    if (sendProgress) sendProgress({ phase: 'extracting', message: 'Extracting lab rows', current: 0, total: 0, recordId: record.id })
    if (safeAbort(signal)) {
      failRecord(record.id, 'Cancelled')
      throw new Error('Bloodwork PDF ingest cancelled')
    }
    rows = await extractLabRowsFromPdfText(text, config, model, signal)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!signal?.aborted) failRecord(record.id, message)
    throw err
  }
  if (sendProgress) sendProgress({ phase: 'storing', message: `Storing ${rows.length} rows`, current: 0, total: rows.length, recordId: record.id })

  let parsed = 0
  for (const row of rows) {
    if (parsed >= MAX_OBSERVATIONS_PER_FILE) break
    if (safeAbort(signal)) break
    if (!row.name) continue
    database.createHealthObservation({
      recordId: record.id,
      type: 'lab',
      code: null,
      displayName: redactHealthContent(row.name).slice(0, 200),
      valueReal: parseNumber(row.value),
      valueText: row.value || null,
      unit: row.unit || null,
      refLow: row.refLow,
      refHigh: row.refHigh,
      effectiveDate: normalizeDate(row.collectionDate),
      sourceMeta: observationMeta({ source: 'bloodwork', lab: row.labName || undefined }),
    })
    parsed += 1
  }

  if (safeAbort(signal)) {
    failRecord(record.id, 'Cancelled')
    throw new Error('Bloodwork PDF ingest cancelled')
  }
  completeRecord(record.id, parsed)
  if (sendProgress) sendProgress({ phase: 'complete', message: `Imported ${parsed} lab rows`, current: parsed, total: parsed, recordId: record.id })
  return freshRecord(record.id)
}

export async function ingestHealthFile(
  filePath: string,
  projectId: string,
  config: ProviderConfig | null,
  model: string,
  signal?: AbortSignal,
  sendProgress?: HealthProgressSender
): Promise<HealthRecord> {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.xml') {
    const root = await detectXmlRoot(filePath)
    if (root === 'HealthData') {
      return ingestAppleHealthExport(filePath, projectId, signal, sendProgress)
    }
    if (root === 'ClinicalDocument') {
      return ingestMyChartCcda(filePath, projectId, signal, sendProgress)
    }
    const record = makeRecord(projectId, 'other', filePath)
    failRecord(record.id, `Unrecognized XML root element: ${root ?? 'unknown'}`)
    throw new Error('Unrecognized XML root element')
  }
  if (ext === '.pdf') {
    if (!config) {
      const record = makeRecord(projectId, 'bloodwork', filePath)
      failRecord(record.id, 'AI provider is required for PDF bloodwork extraction')
      throw new Error('AI provider is required for PDF bloodwork extraction')
    }
    return ingestBloodworkPdf(filePath, projectId, config, model, signal, sendProgress)
  }
  if (ext === '.csv') {
    return ingestBloodworkCsv(filePath, projectId, signal, sendProgress)
  }
  const record = makeRecord(projectId, 'other', filePath)
  completeRecord(record.id, 0)
  return record
}

const HEALTH_INGEST_EXTENSIONS = new Set(['.xml', '.pdf', '.csv', '.txt', '.md', '.json'])

export interface HealthScanOptions {
  /**
   * An unattended pass. It leaves previously failed files alone rather than
   * re-running them — a bloodwork PDF that fails extraction would otherwise be
   * sent to the model again every hour, for a cost and never a different answer.
   * An explicit rescan retries them.
   */
  automatic?: boolean
}

export async function scanHealthDirectory(
  projectId: string,
  config: ProviderConfig | null,
  model: string,
  signal?: AbortSignal,
  sendProgress?: HealthProgressSender,
  options: HealthScanOptions = {}
): Promise<DirectoryScanResult> {
  // Every connected folder, not just the legacy single path: Health is a data
  // source like any other, and a second folder added through the sources UI was
  // previously invisible to ingestion.
  const sourcePaths = database.listProjectSourcePaths(projectId)
  if (sourcePaths.length === 0) {
    return { scanned: 0, ingested: 0, skipped: 0, errors: [] }
  }

  const seen = new Set<string>()
  const files: string[] = []
  for (const sourcePath of sourcePaths) {
    for (const file of collectProjectDataFiles(sourcePath)) {
      // Connected folders may nest (a health folder inside a documents folder),
      // so the same file can be reached twice.
      if (seen.has(file)) continue
      seen.add(file)
      if (HEALTH_INGEST_EXTENSIONS.has(path.extname(file).toLowerCase())) files.push(file)
    }
  }

  // What is already ingested, so a rescan costs nothing for unchanged files
  // instead of duplicating every record it already holds.
  const known = database.listHealthRecordIdentities(projectId)
  const pending = files.filter((file) => {
    const status = known.get(healthFileIdentity(file))
    if (status === undefined) return true
    if (status === 'parsed') return false
    // 'pending' means an earlier run was interrupted before it finished, so it
    // is always worth another attempt.
    return status === 'failed' ? !options.automatic : true
  })
  const alreadyIngested = files.length - pending.length

  if (sendProgress) {
    sendProgress({
      phase: 'reading',
      message: `Scanning ${files.length} file${files.length === 1 ? '' : 's'}${alreadyIngested > 0 ? ` — ${alreadyIngested} already ingested` : ''}`,
      current: 0,
      total: pending.length,
    })
  }

  // Re-reading a file replaces its previous attempt instead of adding another
  // row beside it. Scoped to the files this pass will actually read, so a record
  // holding real observations — or the HealthKit live record, which is not a
  // file at all — is never in scope.
  if (pending.length > 0) {
    database.clearSupersededHealthRecords(
      projectId,
      pending.map(healthFileIdentity),
      pending.map((file) => path.basename(file))
    )
  }

  let ingested = 0
  let skipped = 0
  const errors: string[] = []

  for (let i = 0; i < pending.length; i += 1) {
    if (safeAbort(signal)) break
    const file = pending[i]
    try {
      if (sendProgress) sendProgress({ phase: 'reading', message: `Ingesting ${path.basename(file)}`, current: i, total: pending.length })
      await ingestHealthFile(file, projectId, config, model, signal)
      ingested += 1
    } catch (err) {
      if (signal?.aborted) break
      skipped += 1
      errors.push(`${path.basename(file)}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  const summary = `Scanned ${files.length} file${files.length === 1 ? '' : 's'} across ${sourcePaths.length} folder${sourcePaths.length === 1 ? '' : 's'} — ${ingested} ingested, ${alreadyIngested} unchanged, ${skipped} failed`
  if (sendProgress) sendProgress({ phase: 'complete', message: summary, current: files.length, total: files.length })

  // `skipped` stays the count of files that errored, not of cache hits: it feeds
  // an error list, and folding unchanged files into it would report a healthy
  // rescan as a scan that went mostly wrong.
  return { scanned: files.length, ingested, skipped, errors, unchanged: alreadyIngested }
}
