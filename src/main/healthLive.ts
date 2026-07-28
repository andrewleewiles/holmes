import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import * as database from './database'
import type {
  HealthKitObservationInput,
  HealthKitQueryResult,
  HealthLiveAuthorization,
  HealthLiveStatus,
  HealthSyncResult,
  HealthObservationType,
  HealthSourceType,
} from '../shared/types'

const SIDECAR_APP_NAME = 'healthkit-sidecar.app'
const SIDECAR_BIN_NAME = 'healthkit-sidecar'
const SIDECAR_TIMEOUT_MS = 60_000
const LIVE_RECORD_FILENAME = 'live-sync'

let cachedAuthorization: HealthLiveAuthorization | null = null
let cachedAuthorizationAt = 0
const AUTH_CACHE_TTL_MS = 30_000

export function getSidecarPath(): string | null {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, SIDECAR_APP_NAME, 'Contents', 'MacOS', SIDECAR_BIN_NAME))
  }
  candidates.push(
    join(app.getAppPath(), 'node_modules', '.holmes', SIDECAR_APP_NAME, 'Contents', 'MacOS', SIDECAR_BIN_NAME),
    join(app.getAppPath(), '..', 'node_modules', '.holmes', SIDECAR_APP_NAME, 'Contents', 'MacOS', SIDECAR_BIN_NAME),
  )
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function isSidecarAvailable(): boolean {
  return getSidecarPath() !== null
}

function runSidecar(
  args: string[],
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const bin = getSidecarPath()
  if (!bin) {
    return Promise.reject(new Error('HealthKit sidecar binary is not built. Run pnpm build:sidecar.'))
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: SIDECAR_TIMEOUT_MS,
        windowsHide: true,
        signal: signal as never,
      },
      (error, stdout, stderr) => {
        const code = error && 'code' in error ? (error as { code?: number | string }).code : null
        if (error && stdout.length === 0) {
          reject(new Error(stderr.trim() || error.message || 'HealthKit sidecar failed'))
          return
        }
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : null })
      },
    )
    if (signal) {
      if (signal.aborted) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      } else {
        signal.addEventListener(
          'abort',
          () => {
            try { child.kill('SIGKILL') } catch { /* already gone */ }
          },
          { once: true },
        )
      }
    }
  })
}

function normalizeObservationType(raw: unknown): HealthObservationType {
  if (raw === 'lab' || raw === 'vital' || raw === 'workout' || raw === 'medication' || raw === 'observation' || raw === 'condition') {
    return raw
  }
  return 'observation'
}

function coerceObservation(input: HealthKitObservationInput): {
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
} {
  const valueReal = typeof input.valueReal === 'number' && Number.isFinite(input.valueReal) ? input.valueReal : null
  const valueText = typeof input.valueText === 'string' && input.valueText.length > 0 ? input.valueText : null
  const effectiveDate = typeof input.effectiveDate === 'string' && input.effectiveDate.length > 0 ? input.effectiveDate : null
  const sourceMeta = (input.sourceMeta && typeof input.sourceMeta === 'object')
    ? input.sourceMeta as Record<string, unknown>
    : {}
  return {
    type: normalizeObservationType(input.type),
    code: typeof input.code === 'string' && input.code.length > 0 ? input.code : null,
    displayName: typeof input.displayName === 'string' && input.displayName.length > 0 ? input.displayName : 'Unknown',
    valueReal,
    valueText: valueText ?? (valueReal !== null ? String(valueReal) : null),
    unit: typeof input.unit === 'string' && input.unit.length > 0 ? input.unit : null,
    refLow: typeof input.refLow === 'number' && Number.isFinite(input.refLow) ? input.refLow : null,
    refHigh: typeof input.refHigh === 'number' && Number.isFinite(input.refHigh) ? input.refHigh : null,
    effectiveDate,
    sourceMeta,
  }
}

export async function queryHealthKit(
  type: string,
  days: number,
  signal?: AbortSignal,
): Promise<HealthKitQueryResult> {
  const safeDays = Math.max(1, Math.min(Math.floor(days), 3650))
  const { stdout, stderr } = await runSidecar(['--type', type, '--days', String(safeDays), '--json'], signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new Error(`HealthKit sidecar produced invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`)
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
    const message = (parsed as { error?: unknown }).error
    throw new Error(typeof message === 'string' && message.length > 0 ? message : 'HealthKit sidecar reported an error')
  }
  if (Array.isArray(parsed)) {
    return {
      observations: parsed as HealthKitObservationInput[],
      queryDate: new Date().toISOString(),
      typesQueried: [type],
    }
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { observations?: unknown }).observations)) {
    const result = parsed as HealthKitQueryResult
    return {
      observations: Array.isArray(result.observations) ? result.observations : [],
      queryDate: typeof result.queryDate === 'string' ? result.queryDate : new Date().toISOString(),
      typesQueried: Array.isArray(result.typesQueried) ? result.typesQueried : [type],
      error: typeof result.error === 'string' ? result.error : undefined,
    }
  }
  throw new Error(stderr.trim() || 'HealthKit sidecar returned no observations array')
}

export async function checkHealthKitAuthorization(): Promise<HealthLiveAuthorization> {
  if (!isSidecarAvailable()) return 'unavailable'
  const now = Date.now()
  if (cachedAuthorization && now - cachedAuthorizationAt < AUTH_CACHE_TTL_MS) {
    return cachedAuthorization
  }
  try {
    const result = await queryHealthKit('steps', 1)
    cachedAuthorization = 'authorized'
    cachedAuthorizationAt = now
    void result
    return 'authorized'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not available/i.test(message)) {
      cachedAuthorization = 'unavailable'
    } else if (/authorization|denied|not authorized|permission/i.test(message)) {
      cachedAuthorization = 'denied'
    } else {
      cachedAuthorization = 'notDetermined'
    }
    cachedAuthorizationAt = now
    return cachedAuthorization
  }
}

function invalidateAuthorizationCache(): void {
  cachedAuthorization = null
  cachedAuthorizationAt = 0
}

function findOrCreateLiveRecord(projectId: string): string {
  const existing = database.findHealthRecord(projectId, 'apple_health', LIVE_RECORD_FILENAME)
  if (existing) {
    database.touchHealthRecordImportedAt(existing.id)
    return existing.id
  }
  const record = database.createHealthRecord({
    projectId,
    sourceType: 'apple_health' as HealthSourceType,
    filename: LIVE_RECORD_FILENAME,
    fileSize: 0,
    contentHash: null,
    // Streamed from HealthKit; there is no file for a scan to recognize.
    sourcePath: null,
    identityHash: null,
    status: 'pending',
    parseError: null,
    observationsCount: 0,
  })
  return record.id
}

function dedupeObservations(
  recordId: string,
  incoming: HealthKitObservationInput[],
): { inserted: HealthKitObservationInput[]; skipped: number } {
  const existingKeys = database.findExistingHealthObservationKeys(recordId)
  const seen = new Set<string>()
  const inserted: HealthKitObservationInput[] = []
  let skipped = 0
  for (const obs of incoming) {
    const code = typeof obs.code === 'string' && obs.code.length > 0 ? obs.code : ''
    const effectiveDate = typeof obs.effectiveDate === 'string' && obs.effectiveDate.length > 0 ? obs.effectiveDate : ''
    const key = `${code}|${effectiveDate}`
    if (existingKeys.has(key) || seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    inserted.push(obs)
  }
  return { inserted, skipped }
}

export async function syncHealthKitToProject(
  projectId: string,
  types?: string[],
  signal?: AbortSignal,
): Promise<HealthSyncResult> {
  const queryType = (!types || types.length === 0) ? 'all' : (types.length === 1 ? types[0] : 'all')
  let queryResult: HealthKitQueryResult
  try {
    queryResult = await queryHealthKit(queryType, 7, signal)
  } catch (err) {
    invalidateAuthorizationCache()
    const message = err instanceof Error ? err.message : String(err)
    const recordId = findOrCreateLiveRecord(projectId)
    database.updateHealthRecordStatus(recordId, 'failed', message, 0)
    return {
      recordId,
      observationsInserted: 0,
      observationsSkipped: 0,
      error: message,
    }
  }

  if (queryResult.error) {
    invalidateAuthorizationCache()
  }

  const recordId = findOrCreateLiveRecord(projectId)
  const { inserted, skipped } = dedupeObservations(recordId, queryResult.observations)

  database.runInTransaction(() => {
    for (const obs of inserted) {
      const normalized = coerceObservation(obs)
      database.createHealthObservation({
        recordId,
        type: normalized.type,
        code: normalized.code,
        displayName: normalized.displayName,
        valueReal: normalized.valueReal,
        valueText: normalized.valueText,
        unit: normalized.unit,
        refLow: normalized.refLow,
        refHigh: normalized.refHigh,
        effectiveDate: normalized.effectiveDate,
        sourceMeta: normalized.sourceMeta,
      })
    }
  })

  const totalObservations = database.listHealthObservations(recordId).length
  database.updateHealthRecordStatus(recordId, 'parsed', null, totalObservations)

  if (inserted.length > 0) {
    cachedAuthorization = 'authorized'
    cachedAuthorizationAt = Date.now()
  }

  return {
    recordId,
    observationsInserted: inserted.length,
    observationsSkipped: skipped,
  }
}

export async function getLiveStatus(projectId: string): Promise<HealthLiveStatus> {
  const available = isSidecarAvailable()
  const authorized = available ? await checkHealthKitAuthorization() : 'unavailable'
  const sidecarPath = getSidecarPath()
  const liveRecord = database.findHealthRecord(projectId, 'apple_health', LIVE_RECORD_FILENAME)
  return {
    available,
    authorized,
    sidecarPath,
    lastSyncAt: liveRecord ? liveRecord.importedAt : null,
  }
}
