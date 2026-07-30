// The Tabloid feed orchestrator: plan -> retrieve -> curate -> store.
//
// Shaped like homeIdeas.ts — a prompt version, an input hash that gates the
// whole run, one in-flight promise shared across windows, and a failure cooldown
// so a broken provider cannot be re-paid for on every mount.
//
// It differs from homeIdeas in one deliberate way: failures are SURFACED. The
// home screen can quietly keep showing yesterday's prompts because nobody asked
// it for new ones. Play has a Refresh button, and a button that silently returns
// the same twelve cards reads as broken software.

import { createHash } from 'node:crypto'
import * as database from './database'
import * as settings from './settings'
import { hasProviderCredentials } from '../shared/providerConfig'
import { canCallProvider } from './providerCredit'
import {
  collectPlanSources,
  planHasMaterial,
  planTabloidIntents,
  planSourcesFingerprint,
  PLANNER_PROMPT_VERSION,
  TABLOID_INTENT_TARGET,
  TABLOID_MEMORY_FIELD_KEYS,
  type PlanSources,
} from './tabloidPlanner'
import { curateTabloidPicks, CURATOR_PROMPT_VERSION, TABLOID_ITEM_TARGET } from './tabloidCurator'
import { enabledTabloidKinds, retrieveTabloidCandidates, SUPPRESS_DAYS } from './tabloidRetrieval'
import { cacheTabloidThumbnails, evictTabloidMedia } from './tabloidMedia'
import { applyReactionToMemory } from './tabloidReactions'
import { analyzeTranscript, ANALYSIS_PROMPT_VERSION } from './tabloidAnalysis'
import { fetchTranscript, TranscriptUnavailableError } from './youtubeTranscript'
import {
  beginTabloidRun,
  finishTabloidRun,
  getTabloidRunState,
  isTabloidRunActive,
  reportTabloidRunProgress,
  wasTabloidRunStopped,
  type TabloidRun,
} from './tabloidRuns'
import { createIdleWatchdog } from './documentIndexRuns'
import { archiveTabloidItem } from './tabloidArchive'
import { requestTabloidRunStop } from './tabloidRuns'
import { DAILY_UNIT_BUDGET } from './youtubeSearch'
import { quotaDayPacific, type TabloidCandidate } from '../shared/tabloidFeed'
import type { TabloidItemInput } from './database'
import type {
  ContextProvenance,
  TabloidAnalysisStatus,
  TabloidFeed,
  TabloidFeedStatus,
  TabloidIntent,
  TabloidItem,
  TabloidRunProgress,
  TabloidRunState,
  TabloidReaction,
  TabloidSourceRef,
  TabloidWatchState,
  ProvenanceEdge,
  ProvenanceSourceKind,
  ProviderConfig,
} from '../shared/types'

export const TABLOID_PROMPT_VERSION = 'v1'

/** A failed refresh must not be retried on every visit to the tab. */
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000

/**
 * How many refreshes stay on the page. A refresh stacks a new batch on top, so
 * this is the depth of the scrollback rather than a cache size — at twelve picks
 * a batch it is roughly six screens of history.
 */
const VISIBLE_BATCHES = 6

/** Bounds the tail below the visible batches. Reacted items are always kept. */
const MAX_UNREACTED_HISTORY = 500

const MAX_SUPPRESSED_TITLES = 25

function inputHash(sources: PlanSources, enabledKinds: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(TABLOID_PROMPT_VERSION)
  hash.update(CURATOR_PROMPT_VERSION)
  hash.update(String(TABLOID_ITEM_TARGET))
  hash.update(String(TABLOID_INTENT_TARGET))
  hash.update(enabledKinds.join(','))
  hash.update(planSourcesFingerprint(sources))
  return hash.digest('hex')
}

/**
 * `ProvenanceEdge.kind` is a fixed vocabulary shared with the context tree, so
 * the feed's richer ref kinds are folded into the nearest one. Nothing is lost:
 * the full kind lives on the `TabloidSourceRef` stored with each item, and this
 * mapping only affects the feed-level record of what the planner was shown.
 */
function provenanceKindFor(kind: TabloidSourceRef['kind']): ProvenanceSourceKind {
  if (kind === 'project') return 'project-root'
  if (kind === 'book') return 'book'
  return 'memory'
}

function buildFeedProvenance(
  sources: PlanSources,
  intents: TabloidIntent[],
  models: { planner: string; curator: string },
  inputChars: number
): ContextProvenance {
  const cited = new Set(intents.flatMap((intent) => intent.sourceRefs.map((ref) => ref.ref)))
  const all = Object.values(sources.refsByTag)

  const edges: ProvenanceEdge[] = all.map((ref) => ({
    kind: provenanceKindFor(ref.kind),
    ref: ref.ref,
    label: ref.label,
    hash: createHash('sha256').update(ref.detail).digest('hex').slice(0, 16),
    // A fact that reached the prompt but that nothing was planned from stays
    // visible as an unused input rather than vanishing from the record.
    included: cited.has(ref.ref),
  }))

  return {
    promptVersion: `${TABLOID_PROMPT_VERSION}/${PLANNER_PROMPT_VERSION}/${CURATOR_PROMPT_VERSION}`,
    model: `${models.planner} + ${models.curator}`,
    generatedAt: new Date().toISOString(),
    sources: edges,
    unrecordedCount: 0,
    omittedCount: edges.filter((edge) => !edge.included).length,
    leafCount: 0,
    inputChars,
    truncated: false,
    // Deliberately no `claims`. A 120-character rationale has no spans worth
    // indexing, and ProvenanceText needs offsets into stored prose to render
    // anything — wiring it here would draw blank spans. The per-item
    // `sourceRefs` carry the attribution instead.
  }
}

function toFeed(status?: TabloidFeedStatus, lastError?: string | null): TabloidFeed {
  const row = database.getTabloidFeedRow()
  const items = database.listTabloidItems({ maxBatches: VISIBLE_BATCHES })
  const quotaDay = quotaDayPacific(Date.now())
  return {
    items,
    intents: row.intents,
    generatedAt: row.generatedAt,
    personalized: items.length > 0,
    stale: false,
    status: status ?? row.status,
    lastError: lastError === undefined ? row.lastError : lastError,
    provenance: row.provenance,
    searchUnitsUsedToday: database.getTabloidSearchUnits(quotaDay),
    searchUnitBudget: DAILY_UNIT_BUDGET,
  }
}

/**
 * The stored feed. Never calls a model — the page paints this immediately on
 * mount and only then asks whether a refresh is worth it.
 */
export function getTabloidFeed(): TabloidFeed {
  const feed = toFeed()
  let stale = false
  try {
    const sources = collectPlanSources()
    const kinds = enabledTabloidKinds({ youtubeApiKey: settings.getYoutubeApiKey() })
    // Reporting stale with no profile or no key would put the page in a retry
    // loop against a gate that can never open.
    stale =
      kinds.length > 0 &&
      planHasMaterial(sources) &&
      database.getTabloidFeedRow().inputHash !== inputHash(sources, kinds)
  } catch {
    // A source that will not read is not a reason to claim the feed is stale.
  }
  return { ...feed, stale }
}

// One generation at a time. The page refreshes on mount and two windows (or a
// remount mid-flight) should share the one run rather than pay for it twice.
let inFlight: Promise<TabloidFeed> | null = null
let lastFailureAt = 0

/**
 * A build is long enough to need a watchdog: `fetch` has no default timeout, so
 * a dead socket in the middle of twelve transcript downloads would otherwise
 * hang the run forever. This measures SILENCE, not duration — a legitimately
 * slow analysis pass keeps pinging it.
 */
const BUILD_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export function refreshTabloidFeed(
  config: ProviderConfig,
  models: { planner: string; curator: string },
  signal?: AbortSignal,
  force = false
): Promise<TabloidFeed> {
  if (!inFlight) {
    inFlight = runBuild(config, models, signal, force).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function runBuild(
  config: ProviderConfig,
  models: { planner: string; curator: string },
  callerSignal: AbortSignal | undefined,
  force: boolean
): Promise<TabloidFeed> {
  const run = beginTabloidRun()
  const watchdog = createIdleWatchdog(run.controller, BUILD_IDLE_TIMEOUT_MS)
  // A caller-supplied abort (the window closing) folds into the run's own.
  const onCallerAbort = (): void => run.controller.abort()
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const feed = await generate(config, models, run, watchdog, force)
    finishTabloidRun(run)
    return feed
  } catch (error) {
    // A build the user stopped is not a failure, and must not be reported as
    // one — it would blame the app for the user's own click.
    if (wasTabloidRunStopped()) {
      finishTabloidRun(run)
      return { ...toFeed('ok', null), stale: true }
    }
    const message = watchdog.fired()
      ? 'The build stalled with no response and was stopped.'
      : error instanceof Error
        ? error.message
        : 'The feed could not be built.'
    lastFailureAt = Date.now()
    finishTabloidRun(run, { failed: true, message })
    return fail('error', message)
  } finally {
    watchdog.cancel()
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

export { requestTabloidRunStop }

export function getTabloidRunStateForRenderer(): TabloidRunState {
  return getTabloidRunState()
}

export function isTabloidBuildActive(): boolean {
  return isTabloidRunActive()
}

function fail(status: TabloidFeedStatus, message: string | null): TabloidFeed {
  database.setTabloidFeedStatus(status, message)
  return { ...toFeed(status, message), stale: false }
}

async function generate(
  config: ProviderConfig,
  models: { planner: string; curator: string },
  run: TabloidRun,
  watchdog: { ping: () => void; fired: () => boolean },
  force: boolean
): Promise<TabloidFeed> {
  const signal = run.signal
  const step = (progress: Omit<TabloidRunProgress, 'completed' | 'total'> & { completed?: number; total?: number }): void => {
    watchdog.ping()
    reportTabloidRunProgress(run, { completed: 0, total: 0, ...progress })
  }

  const youtubeApiKey = settings.getYoutubeApiKey()
  const enabledKinds = enabledTabloidKinds({ youtubeApiKey })

  // Gate order matters: each of these is a state the page explains, and none of
  // them costs a provider call to discover.
  if (enabledKinds.length === 0) {
    return fail('no-api-key', 'Add a YouTube Data API key in Settings to build a feed.')
  }

  const sources = collectPlanSources()
  if (!planHasMaterial(sources)) {
    return fail('no-profile', 'Holmes needs to index some of your data before it can suggest anything.')
  }
  if (!hasProviderCredentials(config) || !models.planner.trim() || !models.curator.trim()) {
    return fail('no-credentials', 'Connect a model provider in Settings to build a feed.')
  }
  if (!canCallProvider(config)) {
    return fail('no-credentials', 'Your provider is refusing calls for lack of credit.')
  }

  const hash = inputHash(sources, enabledKinds)
  const stored = database.getTabloidFeedRow()
  const currentItems = database.listTabloidItems()
  const isStale = stored.inputHash !== hash

  if (!force && !isStale && currentItems.length > 0) return { ...toFeed('ok', null), stale: false }
  if (!force && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) return { ...toFeed(), stale: isStale }

  const quotaDay = quotaDayPacific(Date.now())
  if (database.getTabloidSearchUnits(quotaDay) >= DAILY_UNIT_BUDGET) {
    return fail('quota', "YouTube's daily quota for this key is used up. It resets at midnight Pacific time.")
  }

  try {
    step({ phase: 'planning', detail: 'Reading your profile' })
    const intents = await planTabloidIntents(config, models.planner, sources, enabledKinds, signal)
    if (intents.length === 0) {
      lastFailureAt = Date.now()
      return fail('error', 'The planner did not return any usable search terms. Try again.')
    }

    step({ phase: 'retrieving', total: intents.length, detail: intents[0]?.query ?? '' })
    const retrieval = await retrieveTabloidCandidates(intents, {
      youtubeApiKey,
      signal,
    })

    if (retrieval.fatal) {
      lastFailureAt = Date.now()
      const status: TabloidFeedStatus =
        retrieval.fatal.kind === 'quota' ? 'quota' : retrieval.fatal.kind === 'unknown' ? 'error' : 'no-api-key'
      return fail(status, retrieval.fatal.message)
    }

    if (retrieval.candidates.length === 0) {
      lastFailureAt = Date.now()
      const detail = retrieval.errors[0]?.message
      return fail(
        'error',
        detail
          ? `Nothing came back from YouTube: ${detail}`
          : 'Nothing new came back from YouTube. Everything found has already been shown.'
      )
    }

    step({ phase: 'curating', detail: `${retrieval.candidates.length} results to choose from` })
    const picks = await curateTabloidPicks(
      config,
      models.curator,
      {
        candidates: retrieval.candidates,
        intents,
        allowedMemoryFieldKeys: TABLOID_MEMORY_FIELD_KEYS,
        suppressedTitles: recentlyShownTitles(),
        target: TABLOID_ITEM_TARGET,
      },
      signal
    )

    if (picks.length === 0) {
      lastFailureAt = Date.now()
      return fail('error', 'The curator did not choose anything from the results. Try again.')
    }

    const byCandidateId = new Map(retrieval.candidates.map((candidate) => [candidate.candidateId, candidate]))
    const intentsById = new Map(intents.map((intent) => [intent.id, intent]))

    const items: TabloidItemInput[] = picks.map((pick, index) => {
      const candidate = byCandidateId.get(pick.candidateId)!
      // The curator cited intents; the refs come from those intents, not from
      // anything the model wrote. This is what makes a "because you..." line
      // checkable rather than plausible.
      const intentIds = pick.intentIds.length > 0 ? pick.intentIds : candidate.intentIds
      const sourceRefs = dedupeRefs(
        intentIds.flatMap((id) => intentsById.get(id)?.sourceRefs ?? [])
      )
      return {
        kind: candidate.kind,
        provider: candidate.provider,
        externalId: candidate.externalId,
        url: candidate.url,
        title: candidate.title,
        creator: candidate.creator,
        description: candidate.description,
        publishedAt: candidate.publishedAt,
        durationSeconds: candidate.durationSeconds,
        thumbnailUrl: candidate.thumbnailUrl,
        embeddable: candidate.embeddable,
        rationale: pick.rationale,
        intentIds,
        sourceRefs,
        memoryFieldKey: pick.memoryFieldKey,
        rank: index,
      }
    })

    const inputChars =
      sources.superContext.length +
      sources.memorySummary.length +
      sources.timeline.length +
      sources.people.length +
      sources.preferences.length +
      sources.watchHistory.length +
      sources.library.length +
      sources.reactions.length

    database.saveTabloidFeed({
      inputHash: hash,
      intents,
      provenance: buildFeedProvenance(sources, intents, models, inputChars),
      plannerModel: models.planner,
      curatorModel: models.curator,
      promptVersion: TABLOID_PROMPT_VERSION,
      status: 'ok',
      lastError: null,
    })
    const saved = database.replaceTabloidFeedItems(items)

    // Thumbnails are fetched after the feed is committed, so a slow or dead CDN
    // costs a fallback card rather than the whole refresh.
    await cacheTabloidThumbnails(saved)

    // The transcript pass runs LAST, over the twelve picks rather than the sixty
    // candidates. Analysing the whole candidate pool would cost five times as
    // much to annotate cards nobody will ever see; the trade is that a flagged
    // video is still shown, with its flags, rather than filtered out before the
    // user gets a say.
    await analyzePicks(config, models.curator, saved, run, step)
    database.pruneTabloidItems(VISIBLE_BATCHES, MAX_UNREACTED_HISTORY)
    evictTabloidMedia()

    // The memory writes for any picks the user has already reacted to are
    // handled by the reaction handler, not here: a fresh feed has no reactions.
    return { ...toFeed('ok', null), stale: false }
  } catch (error) {
    if (signal?.aborted) throw error
    lastFailureAt = Date.now()
    const message = error instanceof Error ? error.message : 'The feed could not be built.'
    return fail('error', message)
  }
}

/**
 * Downloads and reviews the transcript of every pick, one at a time.
 *
 * Serial on purpose. Parallel caption downloads are what produced the 429 that
 * made this feature look impossible in the first place, and the analysis calls
 * are paced by the provider's own rate limit anyway.
 *
 * Nothing here can fail the build. The feed is already committed and on screen
 * by the time this runs; a video with no captions, a missing yt-dlp, or a model
 * error each land on that one card as a status the UI explains, and the other
 * eleven are unaffected.
 */
async function analyzePicks(
  config: ProviderConfig,
  model: string,
  items: TabloidItem[],
  run: TabloidRun,
  step: (progress: { phase: TabloidRunProgress['phase']; completed?: number; total?: number; detail: string }) => void
): Promise<void> {
  const total = items.length

  for (const [index, item] of items.entries()) {
    if (run.signal.aborted) return

    const stored = database.getTabloidAnalysis(item.externalId)
    const transcript = database.getTabloidTranscript(item.externalId)

    // Already reviewed, by this prompt, against these exact words.
    if (
      stored &&
      stored.promptVersion === ANALYSIS_PROMPT_VERSION &&
      transcript &&
      stored.textHash === transcript.textHash &&
      stored.status === 'ok'
    ) {
      continue
    }

    step({ phase: 'transcribing', completed: index, total, detail: item.title })

    let cues = transcript?.cues ?? []
    let language = transcript?.language ?? null
    let textHash = transcript?.textHash ?? ''

    if (cues.length === 0) {
      try {
        const fetched = await fetchTranscript(item.externalId, run.signal)
        cues = fetched.cues
        language = fetched.language
        textHash = fetched.hash
        database.saveTabloidTranscript({
          externalId: item.externalId,
          language: fetched.language,
          cues: fetched.cues,
          textHash: fetched.hash,
        })
      } catch (error) {
        if (run.signal.aborted) return
        const reason = error instanceof TranscriptUnavailableError ? error.reason : 'failed'
        const status: TabloidAnalysisStatus = reason === 'no-captions' ? 'no-transcript' : 'unavailable'
        database.saveTabloidAnalysis({
          externalId: item.externalId,
          textHash: '',
          promptVersion: ANALYSIS_PROMPT_VERSION,
          status,
          summary: '',
          flags: [],
          language: null,
          model,
          error: error instanceof Error ? error.message : 'Captions could not be fetched.',
        })
        continue
      }
    }

    step({ phase: 'analysing', completed: index, total, detail: item.title })

    try {
      const result = await analyzeTranscript(
        config,
        model,
        {
          title: item.title,
          creator: item.creator,
          publishedAt: item.publishedAt,
          durationSeconds: item.durationSeconds,
          cues,
        },
        run.signal
      )
      database.saveTabloidAnalysis({
        externalId: item.externalId,
        textHash,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        status: 'ok',
        summary: result.summary,
        flags: result.flags,
        language,
        model,
        error: null,
      })
    } catch (error) {
      if (run.signal.aborted) return
      database.saveTabloidAnalysis({
        externalId: item.externalId,
        textHash,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        status: 'failed',
        summary: '',
        flags: [],
        language,
        model,
        error: error instanceof Error ? error.message : 'The review failed.',
      })
    }
  }
}

function dedupeRefs(refs: TabloidSourceRef[]): TabloidSourceRef[] {
  const seen = new Set<string>()
  const out: TabloidSourceRef[] = []
  for (const ref of refs) {
    if (seen.has(ref.ref)) continue
    seen.add(ref.ref)
    out.push(ref)
  }
  return out
}

function recentlyShownTitles(): string[] {
  const since = Date.now() - SUPPRESS_DAYS * 24 * 60 * 60 * 1000
  return database
    .listTabloidItems({ currentOnly: false })
    .filter((item) => item.reaction === 'down' || item.shownAt >= since)
    .slice(0, MAX_SUPPRESSED_TITLES)
    .map((item) => `${item.title}${item.creator ? ` (${item.creator})` : ''}`)
}

/**
 * Records a reaction and, for a thumbs-up, offers it to the memory profile.
 *
 * Returns the whole feed rather than the one item so the page re-renders from a
 * single source of truth — including `stale`, which a reaction moves.
 */
export function reactToTabloidItem(id: string, reaction: TabloidReaction | null): TabloidFeed {
  const item = database.setTabloidItemReaction(id, reaction)
  if (item && reaction === 'up') applyReactionToMemory(item)
  return getTabloidFeed()
}

/**
 * Records where playback got to. Returns the item alone rather than the whole
 * feed: this fires every few seconds while a video plays, and rebuilding twelve
 * cards to move one progress bar would be absurd.
 */
export function recordTabloidProgress(
  id: string,
  positionSeconds: number,
  durationSeconds: number | null
): TabloidWatchState | null {
  const item = database.getTabloidItemById(id)
  if (!item) return null
  const duration = durationSeconds ?? item.durationSeconds
  // "Finished" is the last stretch rather than the very end: nobody watches the
  // outro, and a video that never reads as complete never leaves the progress bar.
  const completed = duration !== null && duration > 0 && positionSeconds >= duration * 0.95
  return database.saveTabloidWatchState({
    externalId: item.externalId,
    positionSeconds,
    durationSeconds: duration,
    completed,
  })
}

export async function archiveTabloidItemById(id: string): Promise<TabloidFeed> {
  const item = database.getTabloidItemById(id)
  if (!item) throw new Error('That suggestion is no longer in the feed.')
  await archiveTabloidItem(item)
  return getTabloidFeed()
}

export type { TabloidCandidate }
