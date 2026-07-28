import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const SIDECAR_APP_NAME = 'holmes-sidecar.app'
const SIDECAR_BIN_NAME = 'holmes-sidecar'
const SIDECAR_TIMEOUT_MS = 30_000

export type LocationFix = { lat: number; lng: number; accuracyM: number }
export type LocationResult =
  | { status: 'ok'; fix: LocationFix }
  | { status: 'needs_permission' }
  | { status: 'timeout' }

export function getHolmesSidecarPath(): string | null {
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

export function isHolmesSidecarAvailable(): boolean {
  return getHolmesSidecarPath() !== null
}

function runHolmesSidecar(
  args: string[],
  signal?: AbortSignal,
  timeoutMs: number = SIDECAR_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const bin = getHolmesSidecarPath()
  if (!bin) {
    return Promise.reject(new Error('Holmes sidecar binary is not built. Run pnpm build:sidecar:holmes.'))
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        signal: signal as never,
      },
      (error, stdout, stderr) => {
        const code = error && 'code' in error ? (error as { code?: number | string }).code : null
        if (error && stdout.length === 0) {
          reject(new Error(stderr.trim() || error.message || 'Holmes sidecar failed'))
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

export type PhotoAssetMeta = {
  occurredAt: string | null
  assetKind: string | null
  lat: number | null
  lng: number | null
  locationName: string | null
}
export type PhotosResult =
  | { status: 'ok'; assets: PhotoAssetMeta[] }
  | { status: 'needs_permission' }
  | { status: 'error'; message: string }

const PHOTOKIT_TIMEOUT_MS = 120_000

export async function fetchPhotosMetadata(signal?: AbortSignal): Promise<PhotosResult> {
  let stdout: string
  try {
    const result = await runHolmesSidecar(['photokit'], signal, PHOTOKIT_TIMEOUT_MS)
    stdout = result.stdout
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  const trimmed = stdout.trim()
  if (!trimmed) return { status: 'error', message: 'PhotoKit sidecar returned no output' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { status: 'error', message: 'PhotoKit sidecar returned invalid JSON' }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const status = (parsed as { status?: unknown }).status
    if (status === 'needs_permission') return { status: 'needs_permission' }
    return { status: 'error', message: `PhotoKit sidecar returned unexpected status: ${String(status)}` }
  }
  if (!Array.isArray(parsed)) {
    return { status: 'error', message: 'PhotoKit sidecar returned an unexpected shape' }
  }
  const assets: PhotoAssetMeta[] = parsed
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : null,
      assetKind: typeof item.assetKind === 'string' ? item.assetKind : null,
      lat: typeof item.lat === 'number' && Number.isFinite(item.lat) ? item.lat : null,
      lng: typeof item.lng === 'number' && Number.isFinite(item.lng) ? item.lng : null,
      locationName: typeof item.locationName === 'string' ? item.locationName : null,
    }))
  return { status: 'ok', assets }
}

export async function fetchCurrentLocation(signal?: AbortSignal): Promise<LocationResult> {
  const { stdout } = await runHolmesSidecar(['corelocation'], signal)
  const trimmed = stdout.trim()
  if (!trimmed) return { status: 'timeout' }
  try {
    const parsed = JSON.parse(trimmed) as {
      status?: string
      lat?: number
      lng?: number
      accuracyM?: number
    }
    if (parsed.status === 'needs_permission') return { status: 'needs_permission' }
    if (parsed.status === 'timeout') return { status: 'timeout' }
    if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
      return {
        status: 'ok',
        fix: {
          lat: parsed.lat,
          lng: parsed.lng,
          accuracyM: typeof parsed.accuracyM === 'number' ? parsed.accuracyM : 0,
        },
      }
    }
    return { status: 'timeout' }
  } catch {
    return { status: 'timeout' }
  }
}
