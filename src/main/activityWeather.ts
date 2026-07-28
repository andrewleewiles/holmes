import * as database from './database'
import { getSettings } from './settings'
import type { ActivityRecord, ActivityIngestProgress } from '../shared/types'
import type { ActivityProgressSender } from './activity'

const BATCH_SIZE = 1000
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
    sourceType: 'weather',
    filename: null,
    fileSize: null,
    contentHash: null,
    importedAt: new Date().toISOString(),
    status: 'parsed',
    parseError: null,
    eventsCount: 0,
  }
}

export function wmoCodeToCondition(code: number | null | undefined): string {
  if (typeof code !== 'number' || !Number.isFinite(code)) return 'Unknown'
  if (code === 0) return 'Clear'
  if (code >= 1 && code <= 3) return 'Partly cloudy'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Rain showers'
  if (code >= 95 && code <= 99) return 'Thunderstorm'
  return 'Unknown'
}

function todayYmd(): string {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function daysAgoYmd(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export async function fetchWeatherHistory(
  projectId: string,
  lat: number,
  lng: number,
  days: number,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const LIVE_FILENAME = 'weather-history'
  const existing = database.findLiveActivityRecord(projectId, 'weather', LIVE_FILENAME)
  let record: ActivityRecord
  if (existing) {
    database.resetActivityRecord(existing.id)
    database.touchActivityRecordImportedAt(existing.id)
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'weather',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  try {
    if (safeAbort(signal)) throw new Error('Weather ingest cancelled')
    const startDate = daysAgoYmd(days)
    const endDate = todayYmd()
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lng}&start_date=${startDate}&end_date=${endDate}&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&timezone=auto`

    emit(sendProgress, 'reading', `Fetching weather history (${days} days)`, 0, null, record.id, 'weather')
    const res = await fetch(url, { signal })
    if (!res.ok) {
      throw new Error(`open-meteo archive API returned ${res.status} ${res.statusText}`)
    }
    if (safeAbort(signal)) throw new Error('Weather ingest cancelled')

    emit(sendProgress, 'parsing', 'Parsing weather history', 0, null, record.id, 'weather')
    const data = (await res.json()) as {
      hourly?: {
        time?: unknown[]
        temperature_2m?: unknown[]
        relative_humidity_2m?: unknown[]
        precipitation?: unknown[]
        wind_speed_10m?: unknown[]
        weather_code?: unknown[]
      }
    }
    const hourly = data.hourly
    const times = Array.isArray(hourly?.time) ? (hourly!.time as unknown[]) : []
    const temps = Array.isArray(hourly?.temperature_2m) ? (hourly!.temperature_2m as unknown[]) : []
    const humids = Array.isArray(hourly?.relative_humidity_2m) ? (hourly!.relative_humidity_2m as unknown[]) : []
    const precips = Array.isArray(hourly?.precipitation) ? (hourly!.precipitation as unknown[]) : []
    const winds = Array.isArray(hourly?.wind_speed_10m) ? (hourly!.wind_speed_10m as unknown[]) : []
    const codes = Array.isArray(hourly?.weather_code) ? (hourly!.weather_code as unknown[]) : []

    const total = times.length
    let count = 0
    let pending: Array<{
      occurredAt: string
      tempC: number | null
      humidityPct: number | null
      precipMm: number | null
      windKph: number | null
      conditions: string | null
    }> = []
    const flush = () => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      database.runInTransaction(() => {
        for (const e of batch) {
          database.createWeatherEvent({
            recordId: record.id,
            occurredAt: e.occurredAt,
            tempC: e.tempC,
            humidityPct: e.humidityPct,
            precipMm: e.precipMm,
            windKph: e.windKph,
            conditions: e.conditions,
            sourceMeta: { source: 'open-meteo' },
          })
        }
      })
    }

    for (let i = 0; i < total; i += 1) {
      if (safeAbort(signal)) throw new Error('Weather ingest cancelled')
      const t = times[i]
      if (typeof t !== 'string') continue
      const occurredAt = new Date(t).toISOString()
      if (!Number.isFinite(Date.parse(occurredAt))) continue
      const tempC = typeof temps[i] === 'number' ? (temps[i] as number) : null
      const humidityPct = typeof humids[i] === 'number' ? (humids[i] as number) : null
      const precipMm = typeof precips[i] === 'number' ? (precips[i] as number) : null
      const windKph = typeof winds[i] === 'number' ? (winds[i] as number) : null
      const code = typeof codes[i] === 'number' ? (codes[i] as number) : null
      const conditions = wmoCodeToCondition(code)
      pending.push({ occurredAt, tempC, humidityPct, precipMm, windKph, conditions })
      count += 1
      if (pending.length >= BATCH_SIZE) flush()
      if (count >= MAX_EVENTS_PER_FILE) break
      if (i % 1000 === 0) emit(sendProgress, 'storing', `Imported ${count} weather hours`, count, total, record.id, 'weather')
    }
    flush()

    if (safeAbort(signal)) throw new Error('Weather ingest cancelled')
    database.completeActivityRecord(record.id, count)
    emit(sendProgress, 'complete', `Imported ${count} weather hours`, count, count, record.id, 'weather')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    throw err
  }
}

export async function tickWeatherHourly(projectId: string, signal?: AbortSignal): Promise<void> {
  const settings = getSettings()
  if (!settings.activityWeatherEnabled) return
  const lat = settings.activityLocationLatitude
  const lng = settings.activityLocationLongitude
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return

  const dateKey = new Date().toISOString().slice(0, 10)
  const filename = `hourly-${dateKey}`

  const existing = database
    .listActivityRecords(projectId)
    .find((r) => r.sourceType === 'weather' && r.filename === filename && (r.status === 'parsed' || r.status === 'pending'))
  let record: ActivityRecord
  if (existing) {
    database.resetActivityRecord(existing.id)
    database.touchActivityRecordImportedAt(existing.id)
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'weather',
      filename,
      fileSize: null,
      contentHash: null,
    })
  }

  try {
    if (safeAbort(signal)) return
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code`
    const res = await fetch(url, { signal })
    if (!res.ok) return
    if (safeAbort(signal)) return
    const data = (await res.json()) as {
      current?: {
        time?: unknown
        temperature_2m?: unknown
        relative_humidity_2m?: unknown
        precipitation?: unknown
        wind_speed_10m?: unknown
        weather_code?: unknown
      }
    }
    const current = data.current
    if (!current) return
    const time = typeof current.time === 'string' ? current.time : null
    if (!time) return
    const occurredAt = new Date(time).toISOString()
    if (!Number.isFinite(Date.parse(occurredAt))) return

    const tempC = typeof current.temperature_2m === 'number' ? current.temperature_2m : null
    const humidityPct = typeof current.relative_humidity_2m === 'number' ? current.relative_humidity_2m : null
    const precipMm = typeof current.precipitation === 'number' ? current.precipitation : null
    const windKph = typeof current.wind_speed_10m === 'number' ? current.wind_speed_10m : null
    const code = typeof current.weather_code === 'number' ? current.weather_code : null
    const conditions = wmoCodeToCondition(code)

    database.runInTransaction(() => {
      database.createWeatherEvent({
        recordId: record.id,
        occurredAt,
        tempC,
        humidityPct,
        precipMm,
        windKph,
        conditions,
        sourceMeta: { source: 'open-meteo', kind: 'hourly' },
      })
    })

    const count = Math.max(1, record.eventsCount + 1)
    database.completeActivityRecord(record.id, count)
  } catch {
    /* hourly tick is best-effort; swallow errors */
  }
}
