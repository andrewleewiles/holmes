// Fetching and caching Play thumbnails.
//
// The image has to be fetched in main because the renderer cannot reach an
// https host under its CSP, and it has to be cached on disk because a feed of
// twelve maxres thumbnails is several megabytes that would otherwise be
// re-fetched on every mount.

import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import * as database from './database'
import { tabloidMediaPath, tabloidMediaRoot } from './tabloidProtocol'
import type { TabloidItem } from '../shared/types'

/** A thumbnail is tens of kilobytes; anything near this is not a thumbnail. */
const MAX_THUMBNAIL_BYTES = 512_000
const FETCH_CONCURRENCY = 6
const FETCH_TIMEOUT_MS = 10_000

/** Roughly 60MB at typical thumbnail sizes. */
const MAX_CACHED_THUMBNAILS = 2000
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Deterministic, so the same thumbnail across refreshes reuses one file, and
 * opaque, so the URL carries no path component.
 */
export function thumbnailId(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32)
}

/**
 * Fetches one thumbnail into the cache and returns its id, or null on any
 * failure. A missing thumbnail is a typographic card, not a broken feed, so
 * nothing here throws.
 */
export async function cacheThumbnail(sourceUrl: string): Promise<string | null> {
  if (!sourceUrl.startsWith('https://')) return null

  const id = thumbnailId(sourceUrl)
  const existing = database.getTabloidMediaById(id)
  if (existing && fs.existsSync(existing.filePath)) {
    database.touchTabloidMedia(id)
    return id
  }

  try {
    const response = await fetch(sourceUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!contentType.startsWith('image/')) return null

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_THUMBNAIL_BYTES) return null

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return null

    const filePath = tabloidMediaPath(id)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Written under a temporary name and renamed, so a partial download can
    // never be served as a truncated image.
    const tempPath = `${filePath}.partial`
    fs.writeFileSync(tempPath, bytes)
    fs.renameSync(tempPath, filePath)

    database.upsertTabloidMedia({
      id,
      sourceUrl,
      filePath,
      contentType,
      byteSize: bytes.byteLength,
      fetchedAt: Date.now(),
    })
    return id
  } catch {
    // A dead CDN, a timeout, a full disk. The card falls back to type.
    return null
  }
}

/**
 * Fills in thumbnails for a freshly stored feed.
 *
 * Runs after the feed is committed so a slow CDN costs fallback cards rather
 * than the whole refresh, and bounded in parallelism so twelve simultaneous
 * fetches do not starve anything else.
 */
export async function cacheTabloidThumbnails(items: TabloidItem[]): Promise<void> {
  const pending = items.filter((item) => item.thumbnailUrl && !item.thumbnailMediaId)
  let cursor = 0

  const runners = Array.from({ length: Math.min(FETCH_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const item = pending[cursor]!
      cursor += 1
      const id = await cacheThumbnail(item.thumbnailUrl!)
      if (id) database.setTabloidItemThumbnail(item.id, id)
    }
  })

  await Promise.all(runners)
}

/**
 * LRU eviction. Without this, a year of refreshes leaves tens of thousands of
 * files under userData that nothing ever looks at again.
 */
export function evictTabloidMedia(): void {
  const stale = database.listTabloidMediaForEviction(MAX_CACHED_THUMBNAILS, Date.now() - CACHE_TTL_MS)
  if (stale.length === 0) return

  for (const row of stale) {
    try {
      // Re-checked against the root: the row outlives the file, and a path that
      // escaped the cache directory must never be handed to unlink.
      if (row.filePath.startsWith(tabloidMediaRoot() + path.sep)) fs.rmSync(row.filePath, { force: true })
    } catch {
      // A file that will not delete is not a reason to keep its row.
    }
  }
  database.deleteTabloidMedia(stale.map((row) => row.id))
}
