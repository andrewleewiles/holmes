// Retrieval dispatch for the Tabloid feed. No model runs here.
//
// One retriever per kind, so adding articles or podcasts later is a new entry in
// this table plus its client — not a change to the planner, the curator, the
// schema or the UI. V1 fills in `video` only; every other kind is null, which is
// what makes the planner's enabled-kinds list a single source of truth.

import { retrieveYoutubeCandidates, DAILY_UNIT_BUDGET, YOUTUBE_SEARCH_UNITS } from './youtubeSearch'
import * as database from './database'
import { quotaDayPacific, type TabloidCandidate, type TabloidYoutubeError } from '../shared/tabloidFeed'
import { TABLOID_ITEM_KINDS, type TabloidItemKind } from '../shared/types'

/** Items shown this recently are not offered again, reacted or not. */
export const SUPPRESS_DAYS = 30

export interface RetrievalContext {
  youtubeApiKey: string
  regionCode?: string
  relevanceLanguage?: string
  signal?: AbortSignal
}

export interface RetrievalOutcome {
  candidates: TabloidCandidate[]
  unitsUsed: number
  errors: TabloidYoutubeError[]
  fatal: TabloidYoutubeError | null
}

type Retriever = (
  intents: import('../shared/types').TabloidIntent[],
  suppressed: Set<string>,
  context: RetrievalContext
) => Promise<RetrievalOutcome>

const youtubeRetriever: Retriever = async (intents, suppressed, context) => {
  const quotaDay = quotaDayPacific(Date.now())
  const alreadySpent = database.getTabloidSearchUnits(quotaDay)
  const unitsAvailable = Math.max(0, DAILY_UNIT_BUDGET - alreadySpent)

  if (unitsAvailable < YOUTUBE_SEARCH_UNITS) {
    return {
      candidates: [],
      unitsUsed: 0,
      errors: [],
      fatal: {
        kind: 'quota',
        message: "YouTube's daily quota for this key is used up. It resets at midnight Pacific time.",
      },
    }
  }

  return retrieveYoutubeCandidates({
    apiKey: context.youtubeApiKey,
    intents,
    suppressed,
    unitsAvailable,
    // Spent as it goes rather than at the end: a run that dies halfway has still
    // spent the units, and a ledger that only writes on success would under-count
    // its way straight past the daily allowance.
    onUnitsSpent: (units) => database.addTabloidSearchUnits(quotaDay, units),
    regionCode: context.regionCode,
    relevanceLanguage: context.relevanceLanguage,
    signal: context.signal,
  })
}

/**
 * The dispatch table. A null entry means the kind is understood by the types and
 * the schema but has no way to be retrieved yet, so the planner is never told it
 * is available.
 */
const RETRIEVERS: Record<TabloidItemKind, Retriever | null> = {
  video: youtubeRetriever,
  article: null,
  podcast: null,
  book: null,
  audiobook: null,
}

/** The kinds that can actually be retrieved right now, given the keys on hand. */
export function enabledTabloidKinds(context: { youtubeApiKey: string }): TabloidItemKind[] {
  return TABLOID_ITEM_KINDS.filter((kind) => {
    if (!RETRIEVERS[kind]) return false
    if (kind === 'video') return Boolean(context.youtubeApiKey.trim())
    return true
  })
}

/**
 * Runs every retriever whose kind appears in the plan, and merges the results.
 *
 * Candidate ids are renumbered across the merged set so the curator sees one
 * dense list: two retrievers each numbering from c1 would collide, and a
 * collision silently reattributes a pick to the wrong item.
 */
export async function retrieveTabloidCandidates(
  intents: import('../shared/types').TabloidIntent[],
  context: RetrievalContext
): Promise<RetrievalOutcome> {
  const suppressed = database.listTabloidSuppressedKeys(Date.now() - SUPPRESS_DAYS * 24 * 60 * 60 * 1000)

  const merged: TabloidCandidate[] = []
  const errors: TabloidYoutubeError[] = []
  let unitsUsed = 0
  let fatal: TabloidYoutubeError | null = null

  const kinds = [...new Set(intents.map((intent) => intent.kind))]
  for (const kind of kinds) {
    const retriever = RETRIEVERS[kind]
    if (!retriever) continue
    const outcome = await retriever(intents, suppressed, context)
    unitsUsed += outcome.unitsUsed
    errors.push(...outcome.errors)
    if (outcome.fatal && !fatal) fatal = outcome.fatal
    for (const candidate of outcome.candidates) {
      merged.push({ ...candidate, candidateId: `c${merged.length + 1}` })
    }
  }

  return { candidates: merged, unitsUsed, errors, fatal }
}
