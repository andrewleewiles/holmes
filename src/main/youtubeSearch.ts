// YouTube Data API v3 client for the Tabloid feed.
//
// Two endpoints, and both are needed: `search.list` finds videos but reports no
// duration, no embeddable flag and no view count, and HTML-escapes its titles.
// `videos.list` fills all of that in for 1 unit per 50 ids, so the second call
// is effectively free next to the 100-unit search.
//
// These calls do NOT appear in Call History. `callLog.ts` wraps fetch but only
// matches URLs under the provider base URL, so googleapis.com passes through
// untouched. That is deliberate — adding logging here would double-count every
// provider call the wrapper already records (AGENTS.md landmine 11). The quota
// ledger on the Tabloid page is what makes this spend visible instead.

import { redactMemoryContent } from './memory'
import {
  classifyYoutubeError,
  decodeHtmlEntities,
  tabloidItemKey,
  youtubeDurationToSeconds,
  type TabloidCandidate,
  type TabloidYoutubeError,
} from '../shared/tabloidFeed'
import type { TabloidIntent } from '../shared/types'

const YOUTUBE_BASE = 'https://www.googleapis.com/youtube/v3'

/** Quota costs, per the published table. A search is a hundred times a lookup. */
export const YOUTUBE_SEARCH_UNITS = 100
export const YOUTUBE_VIDEOS_UNITS = 1

/**
 * Hard cap regardless of how many intents the planner emitted. Ten searches is
 * ~1,002 units, so roughly nine refreshes against the 10,000/day free tier.
 */
export const MAX_SEARCHES_PER_REFRESH = 10

/** Leaves headroom under the 10,000 daily allowance for a partial run. */
export const DAILY_UNIT_BUDGET = 9000

const RESULTS_PER_SEARCH = 8
const MAX_IDS_PER_LOOKUP = 50
const SEARCH_CONCURRENCY = 4
const MAX_RESPONSE_BYTES = 2_000_000
/** Below this is a Short; the feed is about things worth sitting down for. */
const MIN_DURATION_SECONDS = 60
const MAX_DESCRIPTION_CHARS = 600

export interface YoutubeRetrievalInput {
  apiKey: string
  intents: TabloidIntent[]
  /** `kind|provider|externalId` keys the retrieval must not surface again. */
  suppressed: Set<string>
  unitsAvailable: number
  onUnitsSpent: (units: number) => void
  regionCode?: string
  relevanceLanguage?: string
  signal?: AbortSignal
}

export interface YoutubeRetrievalOutcome {
  candidates: TabloidCandidate[]
  unitsUsed: number
  /** Per-intent failures that did not stop the run. */
  errors: TabloidYoutubeError[]
  /**
   * Set when the key itself is the problem. Every remaining search would fail
   * identically, so the run stops and the page explains rather than burning
   * quota discovering the same thing ten times.
   */
  fatal: TabloidYoutubeError | null
}

interface YoutubeSearchHit {
  videoId: string
  intentId: string
}

async function youtubeGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  signal?: AbortSignal
): Promise<unknown> {
  const url = new URL(`${YOUTUBE_BASE}/${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  url.searchParams.set('key', apiKey)

  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw Object.assign(new Error(error instanceof Error ? error.message : 'network error'), {
      youtube: { kind: 'transient', message: 'Could not reach YouTube.' } satisfies TabloidYoutubeError,
    })
  }

  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('YouTube response was unexpectedly large')
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('YouTube response was unexpectedly large')
  }

  if (!response.ok) {
    const classified = classifyYoutubeError(response.status, text)
    throw Object.assign(new Error(classified.message), { youtube: classified })
  }

  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('YouTube returned an invalid response'), {
      youtube: { kind: 'unknown', message: 'YouTube returned an invalid response' } satisfies TabloidYoutubeError,
    })
  }
}

function youtubeErrorOf(error: unknown): TabloidYoutubeError {
  const carried = (error as { youtube?: TabloidYoutubeError } | null)?.youtube
  if (carried) return carried
  return { kind: 'unknown', message: error instanceof Error ? error.message : 'YouTube request failed' }
}

/**
 * Maps the planner's minute hints onto the coarse bucket the API offers. Free:
 * it narrows the same 100-unit search rather than costing another one.
 */
function durationBucket(filters: TabloidIntent['filters']): string | null {
  const min = filters?.minMinutes
  const max = filters?.maxMinutes
  if (max !== undefined && max <= 4) return 'short'
  if (min !== undefined && min >= 20) return 'long'
  if (min !== undefined && max !== undefined && min >= 4 && max <= 20) return 'medium'
  return null
}

async function searchOneIntent(
  intent: TabloidIntent,
  input: YoutubeRetrievalInput
): Promise<YoutubeSearchHit[]> {
  // The query was built from the user's own profile, so it is user data leaving
  // the machine — same rule as webSearch.ts, and the easy one to forget.
  const query = redactMemoryContent(intent.query).trim()
  if (!query) return []

  const params: Record<string, string> = {
    part: 'snippet',
    type: 'video',
    q: query,
    maxResults: String(RESULTS_PER_SEARCH),
    order: 'relevance',
    safeSearch: 'moderate',
    // Filtered here as well as on status.embeddable below: this one is not
    // perfectly reliable, and a video the player refuses is a dead card.
    videoEmbeddable: 'true',
  }
  const bucket = durationBucket(intent.filters)
  if (bucket) params['videoDuration'] = bucket
  if (intent.filters?.publishedAfter) params['publishedAfter'] = `${intent.filters.publishedAfter}T00:00:00Z`
  const language = intent.filters?.language ?? input.relevanceLanguage
  if (language) params['relevanceLanguage'] = language
  if (input.regionCode) params['regionCode'] = input.regionCode

  const payload = (await youtubeGet('search', params, input.apiKey, input.signal)) as {
    items?: Array<{ id?: { videoId?: unknown } }>
  }
  const items = Array.isArray(payload?.items) ? payload.items : []

  const hits: YoutubeSearchHit[] = []
  for (const item of items) {
    const videoId = item?.id?.videoId
    if (typeof videoId !== 'string' || !videoId.trim()) continue
    hits.push({ videoId: videoId.trim(), intentId: intent.id })
  }
  return hits
}

interface HydratedVideo {
  externalId: string
  title: string
  creator: string | null
  description: string | null
  publishedAt: string | null
  durationSeconds: number | null
  thumbnailUrl: string | null
  embeddable: boolean
  viewCount: number | null
}

function pickThumbnail(thumbnails: unknown): string | null {
  if (!thumbnails || typeof thumbnails !== 'object') return null
  const record = thumbnails as Record<string, { url?: unknown }>
  // Widest first: the card is a 16:9 tile, and maxres is absent on older videos.
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = record[size]?.url
    if (typeof url === 'string' && url.startsWith('https://')) return url
  }
  return null
}

async function hydrateVideos(
  ids: string[],
  input: YoutubeRetrievalInput
): Promise<Map<string, HydratedVideo>> {
  const byId = new Map<string, HydratedVideo>()

  for (let index = 0; index < ids.length; index += MAX_IDS_PER_LOOKUP) {
    const chunk = ids.slice(index, index + MAX_IDS_PER_LOOKUP)
    const payload = (await youtubeGet(
      'videos',
      { part: 'snippet,contentDetails,status,statistics', id: chunk.join(',') },
      input.apiKey,
      input.signal
    )) as {
      items?: Array<{
        id?: unknown
        snippet?: { title?: unknown; channelTitle?: unknown; description?: unknown; publishedAt?: unknown; thumbnails?: unknown }
        contentDetails?: { duration?: unknown }
        status?: { embeddable?: unknown; privacyStatus?: unknown }
        statistics?: { viewCount?: unknown }
      }>
    }
    input.onUnitsSpent(YOUTUBE_VIDEOS_UNITS)

    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
      const externalId = typeof item?.id === 'string' ? item.id : ''
      if (!externalId) continue
      const title = typeof item.snippet?.title === 'string' ? decodeHtmlEntities(item.snippet.title).trim() : ''
      if (!title) continue

      const description =
        typeof item.snippet?.description === 'string'
          ? decodeHtmlEntities(item.snippet.description).trim().slice(0, MAX_DESCRIPTION_CHARS)
          : null
      const viewCountRaw = Number(item.statistics?.viewCount)

      byId.set(externalId, {
        externalId,
        title,
        creator:
          typeof item.snippet?.channelTitle === 'string'
            ? decodeHtmlEntities(item.snippet.channelTitle).trim() || null
            : null,
        description: description || null,
        publishedAt: typeof item.snippet?.publishedAt === 'string' ? item.snippet.publishedAt : null,
        durationSeconds: youtubeDurationToSeconds(item.contentDetails?.duration),
        thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
        embeddable: item.status?.embeddable === true,
        viewCount: Number.isFinite(viewCountRaw) ? viewCountRaw : null,
      })
    }
  }

  return byId
}

/** Runs `worker` over `items` at most `limit` at a time, preserving nothing. */
async function pooled<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results.push(await worker(items[index]!))
    }
  })
  await Promise.all(runners)
  return results
}

function passesDurationFilter(seconds: number | null, filters: TabloidIntent['filters']): boolean {
  if (seconds === null) return true
  const minSeconds = filters?.minMinutes !== undefined ? filters.minMinutes * 60 : MIN_DURATION_SECONDS
  if (seconds < minSeconds) return false
  if (filters?.maxMinutes !== undefined && seconds > filters.maxMinutes * 60) return false
  return true
}

/**
 * Searches for every video intent, hydrates the results, and returns candidates
 * the curator may choose from.
 *
 * One failed search never fails the refresh: intents are tried independently and
 * their errors collected, so nine good searches still produce a feed. The
 * exception is a bad key or exhausted quota, which is fatal by definition.
 */
export async function retrieveYoutubeCandidates(
  input: YoutubeRetrievalInput
): Promise<YoutubeRetrievalOutcome> {
  const videoIntents = input.intents.filter((intent) => intent.kind === 'video')
  const affordable = Math.max(0, Math.floor(input.unitsAvailable / YOUTUBE_SEARCH_UNITS))
  const runnable = videoIntents.slice(0, Math.min(MAX_SEARCHES_PER_REFRESH, affordable))

  const errors: TabloidYoutubeError[] = []
  let fatal: TabloidYoutubeError | null = null
  let unitsUsed = 0

  if (runnable.length === 0) {
    return { candidates: [], unitsUsed: 0, errors, fatal }
  }

  const intentsById = new Map(videoIntents.map((intent) => [intent.id, intent]))
  const hits: YoutubeSearchHit[] = []

  await pooled(runnable, SEARCH_CONCURRENCY, async (intent) => {
    if (fatal || input.signal?.aborted) return
    try {
      unitsUsed += YOUTUBE_SEARCH_UNITS
      input.onUnitsSpent(YOUTUBE_SEARCH_UNITS)
      hits.push(...(await searchOneIntent(intent, input)))
    } catch (error) {
      if (input.signal?.aborted) throw error
      const classified = youtubeErrorOf(error)
      if (classified.kind === 'key-invalid' || classified.kind === 'quota' || classified.kind === 'not-configured') {
        fatal = classified
      } else {
        errors.push(classified)
      }
    }
  })

  if (fatal) return { candidates: [], unitsUsed, errors, fatal }

  // The same video can answer two intents; keep both attributions on one card
  // rather than showing it twice.
  const intentIdsByVideo = new Map<string, string[]>()
  for (const hit of hits) {
    const existing = intentIdsByVideo.get(hit.videoId)
    if (existing) {
      if (!existing.includes(hit.intentId)) existing.push(hit.intentId)
    } else {
      intentIdsByVideo.set(hit.videoId, [hit.intentId])
    }
  }

  const ids = [...intentIdsByVideo.keys()].filter(
    (videoId) => !input.suppressed.has(tabloidItemKey('video', 'youtube', videoId))
  )
  if (ids.length === 0) return { candidates: [], unitsUsed, errors, fatal }

  let hydrated: Map<string, HydratedVideo>
  try {
    hydrated = await hydrateVideos(ids, input)
    unitsUsed += Math.ceil(ids.length / MAX_IDS_PER_LOOKUP) * YOUTUBE_VIDEOS_UNITS
  } catch (error) {
    if (input.signal?.aborted) throw error
    const classified = youtubeErrorOf(error)
    // Without hydration there is no duration, no embeddable flag and no honest
    // metadata, so there is nothing worth handing the curator.
    return { candidates: [], unitsUsed, errors, fatal: classified }
  }

  const candidates: TabloidCandidate[] = []
  for (const [videoId, intentIds] of intentIdsByVideo) {
    const video = hydrated.get(videoId)
    if (!video || !video.embeddable) continue
    const primaryIntent = intentsById.get(intentIds[0]!)
    if (!passesDurationFilter(video.durationSeconds, primaryIntent?.filters)) continue

    candidates.push({
      candidateId: `c${candidates.length + 1}`,
      kind: 'video',
      provider: 'youtube',
      externalId: video.externalId,
      url: `https://www.youtube.com/watch?v=${video.externalId}`,
      title: video.title,
      creator: video.creator,
      description: video.description,
      publishedAt: video.publishedAt,
      durationSeconds: video.durationSeconds,
      thumbnailUrl: video.thumbnailUrl,
      embeddable: true,
      viewCount: video.viewCount,
      intentIds,
    })
  }

  return { candidates, unitsUsed, errors, fatal }
}
