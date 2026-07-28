import * as database from './database'
import { isHolmesSidecarAvailable, fetchPhotosMetadata } from './sidecarLive'
import type { ActivityRecord, ActivityIngestProgress } from '../shared/types'
import type { ActivityProgressSender } from './activity'

const BATCH_SIZE = 1000

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
    sourceType: 'photos',
    filename: null,
    fileSize: null,
    contentHash: null,
    importedAt: new Date().toISOString(),
    status: 'needs_permission',
    parseError: null,
    eventsCount: 0,
  }
}

export async function syncPhotosMetadata(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: ActivityProgressSender
): Promise<ActivityRecord> {
  const LIVE_FILENAME = 'photos-sync'
  const existing = database.findLiveActivityRecord(projectId, 'photos', LIVE_FILENAME)
  let record: ActivityRecord
  if (existing) {
    database.resetActivityRecord(existing.id)
    database.touchActivityRecordImportedAt(existing.id)
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId,
      sourceType: 'photos',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  if (!isHolmesSidecarAvailable()) {
    database.needsPermissionActivityRecord(record.id, 'Holmes sidecar is not built. Run pnpm build:sidecar:holmes.')
    emit(sendProgress, 'permission', 'Photos sidecar not built', null, null, record.id, 'photos')
    return freshActivityRecord(record.id)
  }

  try {
    emit(sendProgress, 'reading', 'Reading Photos library metadata', 0, null, record.id, 'photos')
    const result = await fetchPhotosMetadata(signal)

    if (result.status === 'needs_permission') {
      database.needsPermissionActivityRecord(record.id, 'Photos access not authorized. Grant Photos access in System Settings > Privacy & Security.')
      emit(sendProgress, 'permission', 'Photos access not authorized', null, null, record.id, 'photos')
      return freshActivityRecord(record.id)
    }
    if (result.status === 'error') {
      throw new Error(result.message)
    }

    const assets = result.assets
    emit(sendProgress, 'storing', `Storing ${assets.length} photo assets`, 0, assets.length, record.id, 'photos')

    let total = 0
    for (let start = 0; start < assets.length; start += BATCH_SIZE) {
      if (signal?.aborted) throw new Error('Photos sync cancelled')
      const batch = assets.slice(start, start + BATCH_SIZE)
      database.runInTransaction(() => {
        for (const asset of batch) {
          if (!asset.occurredAt) continue
          if (!Number.isFinite(Date.parse(asset.occurredAt))) continue
          database.createPhotoEvent({
            recordId: record.id,
            occurredAt: new Date(asset.occurredAt).toISOString(),
            assetKind: asset.assetKind,
            locationName: asset.locationName,
            faces: [],
            sourceMeta: {
              source: 'photokit',
              ...(asset.lat !== null && asset.lng !== null ? { lat: asset.lat, lng: asset.lng } : {}),
            },
          })
          total += 1
        }
      })
      emit(sendProgress, 'storing', `Stored ${total} photo assets`, total, assets.length, record.id, 'photos')
    }

    database.completeActivityRecord(record.id, total)
    emit(sendProgress, 'complete', `Imported ${total} photo assets`, total, total, record.id, 'photos')
    return freshActivityRecord(record.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    database.failActivityRecord(record.id, message)
    emit(sendProgress, 'complete', `Photos sync failed: ${message}`, null, null, record.id, 'photos')
    return freshActivityRecord(record.id)
  }
}
