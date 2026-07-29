import path from 'path'
import type { IndexGranularity } from '../shared/types'

// The fraction of each folder's photos an index run reads at a given
// granularity. Full is the historical behavior: every photo, individually.
// At the real scale this feature exists for (a ~146k-photo archive), medium is
// roughly a quarter of the cost and low a sixteenth.
export const GRANULARITY_PHOTO_RATE: Record<IndexGranularity, number> = {
  full: 1,
  medium: 1 / 4,
  low: 1 / 16,
}

// A folder with a handful of photos is indexed whole at any granularity —
// sampling 1 of 3 photos saves nothing worth losing two-thirds of a folder for.
export const MIN_SAMPLED_PHOTOS_PER_FOLDER = 3

/**
 * The photos a run at this granularity does NOT read, chosen per folder.
 *
 * Deterministic on purpose, and shared by the estimator and the indexer: the
 * same tree must always yield the same sample, so the quoted cost matches the
 * run and a re-run cache-hits the exact photos the last run indexed. Within a
 * folder the kept photos are evenly spaced through the sorted filenames —
 * photo archives sort chronologically, so an even spread over names is an even
 * spread over time rather than the first K shots of the month.
 */
export function samplePhotosOut(imageFiles: string[], granularity: IndexGranularity): Set<string> {
  const sampledOut = new Set<string>()
  const rate = GRANULARITY_PHOTO_RATE[granularity] ?? 1
  if (rate >= 1) return sampledOut

  const byFolder = new Map<string, string[]>()
  for (const file of imageFiles) {
    const dir = path.dirname(file)
    const list = byFolder.get(dir)
    if (list) list.push(file)
    else byFolder.set(dir, [file])
  }

  for (const list of byFolder.values()) {
    const keep = Math.min(list.length, Math.max(MIN_SAMPLED_PHOTOS_PER_FOLDER, Math.ceil(list.length * rate)))
    if (keep >= list.length) continue
    list.sort()
    // Midpoint spacing: with keep < n the stride n/keep exceeds 1, so every
    // floor is distinct and exactly `keep` photos survive.
    const kept = new Set<number>()
    for (let i = 0; i < keep; i += 1) kept.add(Math.floor(((i + 0.5) * list.length) / keep))
    list.forEach((file, index) => {
      if (!kept.has(index)) sampledOut.add(file)
    })
  }

  return sampledOut
}
