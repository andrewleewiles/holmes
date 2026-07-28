import type {
  ProviderConfig,
  ActivityAnalysis,
  ActivitySummary,
  ActivitySourceType,
  SourceAnalysis,
  BrowserEvent,
  YoutubeEvent,
  AmazonEvent,
  EmailEvent,
  KnowledgeEvent,
  PhotoEvent,
  LocationEvent,
  WeatherEvent,
  SubscriptionEvent,
  AccountEvent,
  ActivityProviderId,
  AnalysisTimelineEntry,
  AnalysisPersonEntry,
  ActivityAnalysisEstimate,
  ActivityAnalysisEstimateLine,
  ModelTier,
} from '../shared/types'
import * as database from './database'
import * as settings from './settings'
import { activityProviderOrNull } from '../shared/activityProviders'
import {
  ACTIVITY_ANALYSIS_SYSTEM_PROMPT,
  SOURCE_ANALYSIS_SYSTEM_PROMPT,
  SOURCE_ANALYSIS_INTRO,
  accountAnalysisIntro,
  parseActivityAnalysisResponse,
  emptyActivityAnalysis,
} from './activityAnalysis'
import { redactActivityContent, redactEmailContent } from './activity'
import { parseTimelineBlock, stripTimelineBlock } from '../shared/timeline'
import { parsePeopleBlock, personKey, stripPeopleBlock } from '../shared/people'
import { getBaseUrl, getHeaders, hasProviderCredentials, missingCredentialsError } from './providerEndpoint'
import { getPriceTable, priceCall, type PriceTable } from './modelPricing'
import { estimateSecondsForCalls } from './rateLimit'
import { beginActivityRun, finishActivityRun, reportActivityRunProgress } from './activityRuns'

const SUMMARY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_SOURCE_EVENT_CHARS = 20_000
const MAX_SUPER_CONTEXT_CHARS = 60_000
/**
 * The analysis reads every stored event. This used to be 2,000 per source,
 * which meant eleven years of search history was represented by its most recent
 * few days — the sample was recency-biased, not representative. Chunking is what
 * makes the full read affordable to send.
 */
const PER_SOURCE_LIMIT = 1_000_000

/**
 * How many connected accounts get their own analysis pass in one run. Thirteen
 * registered accounts on top of the nine legacy source types would be twenty-two
 * calls per summary; the busiest six carry nearly all the signal.
 */
const MAX_ACCOUNT_ANALYSES = 6

// Bump when the activity prompts change so stored summaries are regenerated.
const PROMPT_VERSION = 'v6-full-read-chunked'

export function activityInputHash(projectId: string): string {
  return `${PROMPT_VERSION}:${database.getActivityEventsHash(projectId)}`
}

export function shouldUpdateActivitySummary(projectId: string): boolean {
  const current = database.getActivitySummary(projectId)
  const hash = activityInputHash(projectId)
  if (!current || !current.updatedAt) return true
  if (current.fieldHash !== hash) return true
  const updatedAtMs = new Date(current.updatedAt).getTime()
  if (!Number.isFinite(updatedAtMs)) return true
  if (Date.now() - updatedAtMs > SUMMARY_REFRESH_INTERVAL_MS) return true
  return false
}

interface CollectedEvents {
  browser: BrowserEvent[]
  youtube: YoutubeEvent[]
  amazon: AmazonEvent[]
  email: EmailEvent[]
  knowledge: KnowledgeEvent[]
  photos: PhotoEvent[]
  location: LocationEvent[]
  weather: WeatherEvent[]
  subscription: SubscriptionEvent[]
  account: AccountEvent[]
}

function collectEvents(projectId: string): CollectedEvents {
  return {
    browser: database.listAllBrowserEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    youtube: database.listAllYoutubeEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    amazon: database.listAllAmazonEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    email: database.listAllEmailEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    knowledge: database.listAllKnowledgeEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    photos: database.listAllPhotoEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    location: database.listAllLocationEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    weather: database.listAllWeatherEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    subscription: database.listAllSubscriptionEvents(projectId, { limit: PER_SOURCE_LIMIT }),
    account: database.listAllAccountEvents(projectId, { limit: PER_SOURCE_LIMIT }),
  }
}

function countEvents(events: CollectedEvents): number {
  return (
    events.browser.length +
    events.youtube.length +
    events.amazon.length +
    events.email.length +
    events.knowledge.length +
    events.photos.length +
    events.location.length +
    events.weather.length +
    events.subscription.length +
    events.account.length
  )
}

function r(value: string | null | undefined): string {
  if (value == null) return ''
  return redactActivityContent(String(value))
}

/**
 * Email redaction, with the allowlist passed in.
 *
 * This used to read `settings.getSettings()` itself, once per field. That call
 * re-reads and decrypts the settings file from disk every time — 74ms on a real
 * install — so formatting 2000 email events cost four reads each and turned a
 * two-second job into a ten-minute one that blocked the whole main process. It
 * only stayed hidden while there were no email events to format.
 */
function re(value: string | null | undefined, allowlist: string): string {
  if (value == null) return ''
  return redactEmailContent(String(value), allowlist)
}

/** Read once per format pass, never per field. */
function emailAllowlist(): string {
  return settings.getSettings().activityEmailAllowedAddress || ''
}

type SourceEvents = CollectedEvents

const SOURCE_KEYS: ActivitySourceType[] = [
  'browser', 'youtube', 'amazon', 'email', 'knowledge', 'photos', 'location', 'weather', 'subscription',
]

function truncateLines(lines: string[], maxChars: number): string[] {
  let used = 0
  const result: string[] = []
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break
    result.push(line)
    used += line.length + 1
  }
  return result
}

function formatBrowserSource(events: BrowserEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] ${r(e.title)} (${r(e.url)})`)
  return lines
}
function formatYoutubeSource(events: YoutubeEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] ${r(e.title)} — ${r(e.channel)}`)
  return lines
}
function formatAmazonSource(events: AmazonEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => {
    const items = e.items.map((it) => `${it.title ?? '[unknown]'} x${it.quantity}`).join('; ')
    const total = e.totalCents != null ? `$${(e.totalCents / 100).toFixed(2)}` : 'unknown'
    return `- [${e.occurredAt}] ${e.title ?? '[no title]'} | total=${total} | items: ${items}`
  })
  return lines
}
function formatEmailSource(events: EmailEvent[]): string[] {
  const allowlist = emailAllowlist()
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] [${e.kind}] from=${re(e.fromAddress, allowlist)} subj=${re(e.subject, allowlist)} body=${re(e.bodyExcerpt, allowlist)}`)
  return lines
}
function formatKnowledgeSource(events: KnowledgeEvent[]): string[] {
  const byApp = new Map<string, { name: string; openSeconds: number; notifCount: number; firstAt: string; lastAt: string }>()
  let screenOnSeconds = 0
  let screenOnFirst: string | null = null
  let screenOnLast: string | null = null

  for (const e of events) {
    const key = e.bundleId ?? e.appName ?? 'unknown'
    if (e.eventType === 'screen_on') {
      screenOnSeconds += e.durationSeconds ?? 0
      if (!screenOnFirst || e.occurredAt < screenOnFirst) screenOnFirst = e.occurredAt
      if (!screenOnLast || e.occurredAt > screenOnLast) screenOnLast = e.occurredAt
      continue
    }
    let entry = byApp.get(key)
    if (!entry) {
      entry = { name: e.appName ?? e.bundleId ?? 'unknown', openSeconds: 0, notifCount: 0, firstAt: e.occurredAt, lastAt: e.occurredAt }
      byApp.set(key, entry)
    }
    if (e.eventType === 'app_open') {
      entry.openSeconds += e.durationSeconds ?? 0
    } else if (e.eventType === 'notification') {
      entry.notifCount += 1
    }
    if (e.occurredAt < entry.firstAt) entry.firstAt = e.occurredAt
    if (e.occurredAt > entry.lastAt) entry.lastAt = e.occurredAt
  }

  const lines: string[] = []
  if (screenOnSeconds > 0) {
    const hours = (screenOnSeconds / 3600).toFixed(1)
    lines.push(`Screen on: ${hours}h total${screenOnFirst ? ` (${screenOnFirst.slice(0,10)} to ${screenOnLast?.slice(0,10)})` : ''}`)
  }
  const sorted = Array.from(byApp.values()).sort((a, b) => (b.openSeconds + b.notifCount * 10) - (a.openSeconds + a.notifCount * 10))
  for (const app of sorted) {
    const parts: string[] = []
    if (app.openSeconds > 0) {
      parts.push(`${(app.openSeconds / 3600).toFixed(1)}h active`)
    }
    if (app.notifCount > 0) {
      parts.push(`${app.notifCount} notification${app.notifCount === 1 ? '' : 's'}`)
    }
    if (parts.length === 0) continue
    lines.push(`${r(app.name)}: ${parts.join(', ')} (${app.firstAt.slice(0,10)}–${app.lastAt.slice(0,10)})`)
  }
  return lines
}
function formatPhotosSource(events: PhotoEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] kind=${r(e.assetKind)} place=${r(e.locationName)} faces=${e.faces.map((f) => r(f)).join(',')}`)
  return lines
}
function formatLocationSource(events: LocationEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] lat=${e.lat ?? 0} lng=${e.lng ?? 0} acc=${e.accuracyM ?? 0}m src=${r(e.source)}`)
  return lines
}
function formatWeatherSource(events: WeatherEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] temp=${e.tempC ?? 0}C hum=${e.humidityPct ?? 0}% precip=${e.precipMm ?? 0}mm wind=${e.windKph ?? 0}kph cond=${r(e.conditions)}`)
  return lines
}
function formatSubscriptionSource(events: SubscriptionEvent[]): string[] {
  const lines = events.slice().reverse().map((e) => `- [${e.occurredAt}] provider=${r(e.provider)} plan=${r(e.planName)} amount=${e.amountCents ?? 0}c ${e.cadence}`)
  return lines
}

function formatAccountSource(events: AccountEvent[]): string[] {
  const lines = events
    .slice()
    .reverse()
    .map((e) => {
      const parts = [`- [${e.occurredAt}] ${e.kind}`]
      if (e.title) parts.push(r(e.title))
      if (e.counterparty) parts.push(`with=${r(e.counterparty)}`)
      if (e.detail) parts.push(`(${r(e.detail)})`)
      return parts.join(' ')
    })
  return lines
}

function sourceLines(sourceType: ActivitySourceType, events: SourceEvents): string[] {
  switch (sourceType) {
    case 'browser': return formatBrowserSource(events.browser)
    case 'youtube': return formatYoutubeSource(events.youtube)
    case 'amazon': return formatAmazonSource(events.amazon)
    case 'email': return formatEmailSource(events.email)
    case 'knowledge': return formatKnowledgeSource(events.knowledge)
    case 'photos': return formatPhotosSource(events.photos)
    case 'location': return formatLocationSource(events.location)
    case 'weather': return formatWeatherSource(events.weather)
    case 'subscription': return formatSubscriptionSource(events.subscription)
    case 'account': return formatAccountSource(events.account)
  }
}

function eventsForSource(sourceType: ActivitySourceType, events: SourceEvents): unknown[] {
  switch (sourceType) {
    case 'browser': return events.browser
    case 'youtube': return events.youtube
    case 'amazon': return events.amazon
    case 'email': return events.email
    case 'knowledge': return events.knowledge
    case 'photos': return events.photos
    case 'location': return events.location
    case 'weather': return events.weather
    case 'subscription': return events.subscription
    case 'account': return events.account
  }
}

async function callLLM(
  config: ProviderConfig,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(`${getBaseUrl(config)}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(config),
    signal: signal as never,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 12000,
      temperature: 0.3,
      stream: false,
    }),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    let detail = `HTTP ${response.status}`
    if (errorBody) {
      try {
        const parsed = JSON.parse(errorBody)
        detail = parsed.error?.message || parsed.message || errorBody
      } catch {
        detail = errorBody
      }
    }
    throw new Error(`LLM call failed: ${detail}`)
  }
  const data = await response.json()
  const content: string = data?.choices?.[0]?.message?.content || ''
  return content
}

/**
 * One LLM call a run will make: which source, what it will be told, and how
 * many events stand behind it.
 *
 * The estimate and the run are both built from this, so a quote cannot drift
 * from what actually happens — the alternative is a second implementation of
 * "which sources qualify", which is exactly the kind of duplicate that silently
 * goes stale when the selection rules change.
 */
export interface AnalysisStep {
  sourceType: ActivitySourceType
  provider?: ActivityProviderId
  label: string
  /** Rendered user prompt, already capped and redacted. */
  userPrompt: string
  eventCount: number
  /** 1-based position within its source, and how many chunks that source has. */
  chunkIndex: number
  chunkCount: number
}

/**
 * How much of a model's context one chunk may fill.
 *
 * The rest is left for the system prompt, the model's own reasoning, and the
 * slack every provider's tokenizer introduces against a 4-chars-per-token
 * approximation. Filling a window to the brim gets the call rejected, and a
 * rejected chunk loses that slice of history silently.
 */
const CONTEXT_UTILIZATION = 0.55

/** Used when the provider reports no context length for the model. */
const FALLBACK_CONTEXT_TOKENS = 128_000

/** Never send a chunk smaller than this; below it the overhead dominates. */
const MIN_CHUNK_CHARS = 20_000

/**
 * Characters of event text per chunk, sized from the model actually being used.
 * A Frontier model with a 1M window reads roughly 2.2M characters per call; a
 * 128k Budget model reads ~280k.
 */
export function chunkCharsForModel(priceTable: PriceTable, model: string): number {
  const contextTokens = priceTable.get(model)?.contextLength ?? FALLBACK_CONTEXT_TOKENS
  return Math.max(MIN_CHUNK_CHARS, Math.floor(contextTokens * CONTEXT_UTILIZATION * CHARS_PER_TOKEN))
}

/**
 * Splits pre-rendered event lines into chunks that fit the model.
 *
 * Chunking is chronological rather than random: a chunk that covers one
 * contiguous stretch of time can describe what changed within it, which is the
 * whole point of reading history in order.
 */
function chunkLines(lines: string[], maxChars: number): string[][] {
  if (lines.length === 0) return []
  const chunks: string[][] = []
  let current: string[] = []
  let used = 0

  for (const line of lines) {
    // A single oversized line still has to go somewhere; it becomes its own
    // chunk rather than being dropped.
    if (current.length > 0 && used + line.length + 1 > maxChars) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(line)
    used += line.length + 1
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Everything a run would do, in order. Pure with respect to the provider — it
 * reads the database and formats prompts but makes no network call, so the
 * estimate costs nothing.
 */
export function planActivityAnalysis(projectId: string, chunkChars: number): AnalysisStep[] {
  const events = collectEvents(projectId)
  const steps: AnalysisStep[] = []

  /** Splits one source's rendered lines into as many calls as it needs. */
  const addSource = (
    sourceType: ActivitySourceType,
    label: string,
    intro: string,
    lines: string[],
    eventCount: number,
    provider?: ActivityProviderId
  ): void => {
    const chunks = chunkLines(lines, chunkChars)
    if (chunks.length === 0) return

    // Events are rendered oldest-first, so chunk N covers a contiguous, later
    // stretch of time than chunk N-1. Saying which slice this is lets the model
    // describe change within it instead of treating it as the whole history.
    chunks.forEach((chunk, index) => {
      const span =
        chunks.length > 1
          ? `\n\nThis is part ${index + 1} of ${chunks.length} of this source's history, in chronological order. Describe what this stretch shows; a later part will cover what follows.`
          : ''
      steps.push({
        sourceType,
        provider,
        label,
        userPrompt: `${intro}${span}\n\n${chunk.join('\n')}`,
        eventCount: Math.round(eventCount / chunks.length),
        chunkIndex: index + 1,
        chunkCount: chunks.length,
      })
    })
  }

  const suppressed = suppressedLegacySources(projectId)
  for (const sourceType of SOURCE_KEYS) {
    if (suppressed.has(sourceType)) continue
    const sourceEvents = eventsForSource(sourceType, events)
    if (sourceEvents.length === 0) continue
    addSource(
      sourceType,
      sourceType,
      SOURCE_ANALYSIS_INTRO[sourceType],
      sourceLines(sourceType, events),
      sourceEvents.length
    )
  }

  for (const { provider, events: providerEvents } of selectAccountsToAnalyze(projectId)) {
    const def = activityProviderOrNull(provider)
    addSource(
      'account',
      def?.label ?? provider,
      def ? accountAnalysisIntro(def.label, def.blurb) : SOURCE_ANALYSIS_INTRO.account,
      formatAccountSource(providerEvents),
      providerEvents.length,
      provider
    )
  }

  return steps
}

// Rough but stable: 4 characters per token is the usual English approximation,
// matching indexEstimate.ts. The estimate is a decision aid, not an invoice.
const CHARS_PER_TOKEN = 4

/** Measured from the constant prompt text, so it does not drift silently. */
const SOURCE_SYSTEM_PROMPT_TOKENS = Math.ceil(SOURCE_ANALYSIS_SYSTEM_PROMPT.length / CHARS_PER_TOKEN)
const SYNTHESIS_SYSTEM_PROMPT_TOKENS = Math.ceil(ACTIVITY_ANALYSIS_SYSTEM_PROMPT.length / CHARS_PER_TOKEN)

/**
 * A source analysis is asked for three substantial paragraphs, roughly 400–700
 * words. The upper end is the honest number to quote.
 */
const SOURCE_OUTPUT_TOKENS = 950

/** The synthesis returns structured JSON across ten fields. */
const SYNTHESIS_OUTPUT_TOKENS = 2_400

// These calls are large and sequential, so they run slower than an index call.
const SECONDS_PER_CALL = 12

/**
 * Prices a run without making one. Built from `planActivityAnalysis`, so what
 * is quoted is exactly what would execute — including which accounts the
 * per-run cap leaves out.
 */
export async function estimateActivityAnalysis(
  projectId: string,
  tier: ModelTier,
  textModel: string,
  config: ProviderConfig
): Promise<ActivityAnalysisEstimate> {
  const priceTable = await getPriceTable(config)
  const steps = planActivityAnalysis(projectId, chunkCharsForModel(priceTable, textModel))

  const lines: ActivityAnalysisEstimateLine[] = []
  let totalEvents = 0

  for (const step of steps) {
    const inputTokens = Math.ceil(step.userPrompt.length / CHARS_PER_TOKEN) + SOURCE_SYSTEM_PROMPT_TOKENS
    totalEvents += step.eventCount
    lines.push({
      label: step.label,
      eventCount: step.eventCount,
      inputTokens,
      outputTokens: SOURCE_OUTPUT_TOKENS,
      costUsd: priceCall(priceTable, textModel, inputTokens, SOURCE_OUTPUT_TOKENS),
    })
  }

  // A source split into several chunks needs one more call to fold them back
  // into a single analysis. Quoting the chunks alone would understate the run.
  const reduceCounts = new Map<string, number>()
  for (const step of steps) {
    if (step.chunkCount > 1) reduceCounts.set(step.label, step.chunkCount)
  }
  for (const [label, chunkCount] of reduceCounts) {
    const inputTokens =
      chunkCount * SOURCE_OUTPUT_TOKENS + Math.ceil(REDUCE_SYSTEM_PROMPT.length / CHARS_PER_TOKEN)
    lines.push({
      label: `${label} — consolidate ${chunkCount} parts`,
      eventCount: 0,
      inputTokens,
      outputTokens: SOURCE_OUTPUT_TOKENS,
      costUsd: priceCall(priceTable, textModel, inputTokens, SOURCE_OUTPUT_TOKENS),
    })
  }

  // The synthesis reads every source analysis back, capped. Its input is the
  // outputs above rather than the events, so it is sized from them.
  if (steps.length > 0) {
    const synthesisChars = Math.min(
      steps.length * SOURCE_OUTPUT_TOKENS * CHARS_PER_TOKEN,
      MAX_SUPER_CONTEXT_CHARS
    )
    const inputTokens = Math.ceil(synthesisChars / CHARS_PER_TOKEN) + SYNTHESIS_SYSTEM_PROMPT_TOKENS
    lines.push({
      label: 'Super-context synthesis',
      eventCount: 0,
      inputTokens,
      outputTokens: SYNTHESIS_OUTPUT_TOKENS,
      costUsd: priceCall(priceTable, textModel, inputTokens, SYNTHESIS_OUTPUT_TOKENS),
    })
  }

  // Any unpriced leg makes the whole total unknown rather than partial, the
  // same rule the index estimate follows.
  const pricingUnavailable = lines.some((line) => line.costUsd === null)

  // Accounts with events that the per-run cap excluded, so the UI can say what
  // this run will not cover.
  const analyzed = new Set(steps.map((step) => step.provider).filter(Boolean))
  const skippedAccounts = database
    .listActivityAccounts(projectId)
    .filter(
      (account) =>
        account.enabled &&
        account.eventsCount > 0 &&
        activityProviderOrNull(account.provider)?.eventTable === 'account_events' &&
        !analyzed.has(account.provider)
    )
    .map((account) => activityProviderOrNull(account.provider)?.label ?? account.provider)

  return {
    projectId,
    tier,
    textModel,
    lines,
    callCount: lines.length,
    inputTokens: lines.reduce((sum, line) => sum + line.inputTokens, 0),
    outputTokens: lines.reduce((sum, line) => sum + line.outputTokens, 0),
    costUsd: pricingUnavailable ? null : lines.reduce((sum, line) => sum + (line.costUsd ?? 0), 0),
    // Sequential by construction: each source analysis is awaited in turn.
    estimatedSeconds: estimateSecondsForCalls(
      lines.length,
      settings.getRequestsPerMinute(),
      1,
      SECONDS_PER_CALL
    ),
    pricingUnavailable,
    totalEvents,
    upToDate: !shouldUpdateActivitySummary(projectId),
    skippedAccounts,
  }
}

/**
 * Folds one source's chunk analyses into a single source analysis.
 *
 * Reduction is prose-only on purpose. The TIMELINE and PEOPLE blocks are
 * harvested from every chunk separately and carried up untouched — see
 * `harvestFromChunks`. Asking a reduce call to also re-emit them would put dated
 * events and named people through a second lossy summarization, which is
 * exactly how a person mentioned once in chunk 3 of 8 disappears.
 */
const REDUCE_SYSTEM_PROMPT = `You are consolidating several partial analyses of ONE activity source. Each part covers a contiguous stretch of that source's history, in chronological order.

Write a single continuous analysis of the whole source, as if you had read all of it at once. Describe the long arc: what started, what grew, what faded, what recurs, and how the later parts differ from the earlier ones. Prefer concrete, quantified observations over generalities.

Rules:
- Do NOT restate the parts one by one, and do NOT refer to "part 1" or "the first section". The reader never sees the parts.
- Do NOT invent anything absent from the parts.
- Do NOT emit a TIMELINE block or a PEOPLE block. Those are collected separately and your copy would be discarded.
- Output plain text only, no JSON.`

/**
 * Timeline and people entries harvested from chunk analyses, before they are
 * folded into the final structured analysis.
 */
interface HarvestedBlocks {
  timeline: ReturnType<typeof parseTimelineBlock>
  people: ReturnType<typeof parsePeopleBlock>
}

/**
 * Pulls the dated events and named people out of every chunk analysis.
 *
 * This is the harvest-not-re-extract rule the rest of the codebase follows: the
 * blocks are read off the text each chunk already produced, rather than asked
 * for again at a higher level where most of them would be summarized away.
 */
function harvestFromChunks(analyses: string[]): HarvestedBlocks {
  const timeline: HarvestedBlocks['timeline'] = []
  const people: HarvestedBlocks['people'] = []
  const seenTimeline = new Set<string>()
  const seenPeople = new Set<string>()

  for (const text of analyses) {
    for (const entry of parseTimelineBlock(text)) {
      // Same event described in two adjacent chunks is one event.
      const key = `${entry.startDate ?? ''}|${entry.title.toLowerCase().trim()}`
      if (seenTimeline.has(key)) continue
      seenTimeline.add(key)
      timeline.push(entry)
    }
    for (const entry of parsePeopleBlock(text)) {
      const key = personKey(entry.name)
      if (!key || seenPeople.has(key)) continue
      seenPeople.add(key)
      people.push(entry)
    }
  }

  return { timeline, people }
}

/**
 * Cap on how much harvested material is carried into the stored analysis.
 * Generous — the point of the harvest is not to lose things — but bounded, so a
 * pathological run cannot write an unbounded blob into `activity_analysis`.
 */
const MAX_MERGED_TIMELINE = 400
const MAX_MERGED_PEOPLE = 300

/** Synthesis entries win; harvested ones fill the gaps they left. */
function mergeAnalysisTimeline(
  synthesized: AnalysisTimelineEntry[] | undefined,
  harvested: HarvestedBlocks['timeline']
): AnalysisTimelineEntry[] {
  const out: AnalysisTimelineEntry[] = []
  const seen = new Set<string>()
  const key = (date: string, title: string): string => `${date}|${title.toLowerCase().trim()}`

  for (const entry of synthesized ?? []) {
    const k = key(entry.date, entry.title)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(entry)
  }

  for (const entry of harvested) {
    if (out.length >= MAX_MERGED_TIMELINE) break
    const k = key(entry.startDate, entry.title)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({
      date: entry.startDate,
      endDate: entry.endDate ?? undefined,
      precision: entry.precision,
      category: entry.category,
      title: entry.title,
      detail: entry.detail || undefined,
    })
  }

  return out
}

function mergeAnalysisPeople(
  synthesized: AnalysisPersonEntry[] | undefined,
  harvested: HarvestedBlocks['people']
): AnalysisPersonEntry[] {
  const out: AnalysisPersonEntry[] = []
  const seen = new Set<string>()

  for (const entry of synthesized ?? []) {
    const k = personKey(entry.name)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(entry)
  }

  for (const entry of harvested) {
    if (out.length >= MAX_MERGED_PEOPLE) break
    const k = personKey(entry.name)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push({
      name: entry.name,
      relation: entry.relation,
      role: entry.role || undefined,
      aka: entry.aka.length > 0 ? entry.aka : undefined,
      evidence: entry.evidence || undefined,
    })
  }

  return out
}

async function runAnalysisStep(
  step: AnalysisStep,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal
): Promise<SourceAnalysis> {
  if (signal?.aborted) throw new Error('Activity summary generation cancelled')

  try {
    const analysisText = await callLLM(config, model, SOURCE_ANALYSIS_SYSTEM_PROMPT, step.userPrompt, signal)
    return {
      sourceType: step.sourceType,
      provider: step.provider,
      analysis: analysisText.trim() || `No patterns extracted from ${step.label} data.`,
      generatedAt: new Date().toISOString(),
    }
  } catch (err) {
    if (signal?.aborted) throw err
    const msg = err instanceof Error ? err.message : String(err)
    return {
      sourceType: step.sourceType,
      provider: step.provider,
      analysis: `Analysis failed for ${step.label}: ${msg}. Raw event count: ${step.eventCount}.`,
      generatedAt: new Date().toISOString(),
    }
  }
}

/**
 * Which accounts a run will analyze, with their events already fetched.
 *
 * One analysis per connected account that has events, rather than one lumped
 * "account" analysis covering Instagram, Discord and Tinder together. Capped by
 * event count: thirteen registered accounts plus the nine legacy source types
 * would otherwise be twenty-two LLM calls per summary. What was dropped is
 * logged rather than silently omitted.
 */
function selectAccountsToAnalyze(
  projectId: string
): Array<{ provider: ActivityProviderId; events: AccountEvent[] }> {
  // A disabled account is not analyzed, even though its previously imported
  // events are still in the table. The toggle on the Data page says it governs
  // analysis, so it has to — turning an account off is how the user says "stop
  // reading this", not just "stop fetching more of it".
  const enabled = new Set(
    database
      .listActivityAccounts(projectId)
      .filter((account) => account.enabled)
      .map((account) => account.provider)
  )

  // Ranked on the true totals, then each provider is fetched with its own
  // budget. Slicing a single recency-ordered window across all providers
  // starves everything but the busiest: on a real library the shared 2000-event
  // window held 1830 TikTok rows, 133 iMessage and 37 of 94,120 Google
  // searches, so the search analysis was reading a rounding error. Every
  // pre-registry source already gets its own PER_SOURCE_LIMIT; accounts now do
  // too.
  const totals = database.countAccountEventsByProvider(projectId)
  const ranked = Object.entries(totals)
    .filter(([provider, count]) => count > 0 && enabled.has(provider as ActivityProviderId))
    // Providers that keep their events in a pre-registry table are analyzed by
    // that source type instead; counting them here would analyze them twice.
    .filter(([provider]) => activityProviderOrNull(provider)?.eventTable === 'account_events')
    .map(([provider, count]) => [provider as ActivityProviderId, count] as const)
    .sort((a, b) => b[1] - a[1])

  if (ranked.length === 0) return []
  const selected = ranked.slice(0, MAX_ACCOUNT_ANALYSES)
  const dropped = ranked.slice(MAX_ACCOUNT_ANALYSES)
  if (dropped.length > 0) {
    console.warn(
      `Activity summary: analyzing the ${selected.length} busiest accounts; skipped ${dropped
        .map(([provider, count]) => `${provider} (${count} events)`)
        .join(', ')}`
    )
  }

  const out: Array<{ provider: ActivityProviderId; events: AccountEvent[] }> = []
  for (const [provider] of selected) {
    const events = database.listAllAccountEvents(projectId, { limit: PER_SOURCE_LIMIT, provider })
    if (events.length > 0) out.push({ provider, events })
  }
  return out
}

/**
 * Pre-registry source types that a disabled account owns, and which therefore
 * should not be analyzed.
 *
 * Gmail, YouTube and Amazon write into `email_events`, `youtube_events` and
 * `amazon_events` — tables that predate the account registry and are analyzed
 * by source type, not by account. Without this, disabling those accounts
 * stopped them syncing but left their existing data feeding the analysis, which
 * contradicts what the toggle says it does.
 *
 * A table is only suppressed when the account owns *everything* in it. Data
 * imported through the old Email or YouTube source, before accounts existed,
 * keeps being analyzed — the user never opted that into an account and should
 * not lose it because an account row defaults to off.
 */
function suppressedLegacySources(projectId: string): Set<ActivitySourceType> {
  const suppressed = new Set<ActivitySourceType>()
  const accounts = database.listActivityAccounts(projectId)

  const owned: Array<[ActivityProviderId, ActivitySourceType]> = [
    ['gmail', 'email'],
    ['youtube', 'youtube'],
    ['amazon', 'amazon'],
  ]

  for (const [provider, sourceType] of owned) {
    const account = accounts.find((a) => a.provider === provider)
    if (!account || account.enabled) continue
    if (account.eventsCount > 0) suppressed.add(sourceType)
  }

  return suppressed
}

function analysisHeading(sa: SourceAnalysis): string {
  if (sa.sourceType === 'account' && sa.provider) {
    const def = activityProviderOrNull(sa.provider)
    if (def) return accountAnalysisIntro(def.label, def.blurb)
  }
  return SOURCE_ANALYSIS_INTRO[sa.sourceType]
}

function buildSuperContextPrompt(sourceAnalyses: SourceAnalysis[]): string {
  const sections: string[] = []
  let used = 0
  for (const sa of sourceAnalyses) {
    const header = `\n--- ${analysisHeading(sa)} ---\n`
    const block = header + sa.analysis + '\n'
    if (used + block.length > MAX_SUPER_CONTEXT_CHARS) {
      const remaining = MAX_SUPER_CONTEXT_CHARS - used - header.length
      if (remaining > 100) {
        sections.push(header + sa.analysis.slice(0, remaining) + '...[truncated]')
      }
      break
    }
    sections.push(block)
    used += block.length
  }
  return `Below are per-source analyses of the user's activity data, each produced by a focused AI pass on that individual source. Synthesize them into the JSON structure defined by the system prompt:\n${sections.join('\n')}`
}

export async function generateActivitySummary(
  projectId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  origin: 'user' | 'timer' = 'user'
): Promise<ActivityAnalysis> {
  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No System Model configured')

  // The same plan the estimate quotes, executed step by step.
  const priceTable = await getPriceTable(config)
  const steps = planActivityAnalysis(projectId, chunkCharsForModel(priceTable, model))

  // Reading every event is dozens of sequential calls over several minutes, so
  // the run is registered before the first one — otherwise the app looks idle
  // while it spends money, and a background run is invisible entirely.
  const run = beginActivityRun(origin)
  // One call per chunk, one fold per split source, plus the final synthesis.
  const totalCalls =
    steps.length + new Set(steps.filter((s) => s.chunkCount > 1).map((s) => s.label)).size + 1
  let completed = 0
  const report = (label: string, message: string): void => {
    reportActivityRunProgress(run, { current: completed, total: totalCalls, label, message })
  }

  try {
  if (steps.length === 0) {
    const empty = emptyActivityAnalysis('Add activity sources to receive a structured summary.')
    database.updateProjectActivityAnalysis(projectId, empty)
    database.setActivitySummary(projectId, empty, activityInputHash(projectId), [])
    return empty
  }

  // Chunks belonging to one source are analyzed in order, then folded into a
  // single source analysis. Timeline and people entries are harvested off every
  // chunk before folding, so nothing found in an early chunk is summarized away.
  const byLabel = new Map<string, AnalysisStep[]>()
  for (const step of steps) {
    const bucket = byLabel.get(step.label)
    if (bucket) bucket.push(step)
    else byLabel.set(step.label, [step])
  }

  const sourceAnalyses: SourceAnalysis[] = []
  const harvested: HarvestedBlocks = { timeline: [], people: [] }

  for (const [, group] of byLabel) {
    if (signal?.aborted) throw new Error('Activity summary generation cancelled')

    const parts: SourceAnalysis[] = []
    for (const step of group) {
      if (signal?.aborted) throw new Error('Activity summary generation cancelled')
      report(
        step.label,
        step.chunkCount > 1
          ? `${step.label} — part ${step.chunkIndex} of ${step.chunkCount}`
          : step.label
      )
      parts.push(await runAnalysisStep(step, config, model, signal))
      completed += 1
    }

    const chunkTexts = parts.map((part) => part.analysis)
    const blocks = harvestFromChunks(chunkTexts)
    harvested.timeline.push(...blocks.timeline)
    harvested.people.push(...blocks.people)

    if (parts.length === 1) {
      sourceAnalyses.push(parts[0])
      continue
    }

    // The prose the reducer reads carries no blocks — those are already banked.
    const body = chunkTexts
      .map((text, index) => `--- part ${index + 1} of ${chunkTexts.length} ---\n${stripPeopleBlock(stripTimelineBlock(text)).trim()}`)
      .join('\n\n')

    report(group[0].label, `${group[0].label} — consolidating ${parts.length} parts`)
    let consolidated: string
    try {
      consolidated = (await callLLM(config, model, REDUCE_SYSTEM_PROMPT, body, signal)).trim()
    } catch (err) {
      if (signal?.aborted) throw err
      // A failed fold still has the parts; concatenating beats losing them.
      consolidated = chunkTexts.join('\n\n')
    }

    completed += 1
    sourceAnalyses.push({
      sourceType: group[0].sourceType,
      provider: group[0].provider,
      analysis: consolidated || chunkTexts.join('\n\n'),
      generatedAt: new Date().toISOString(),
    })
  }

  if (sourceAnalyses.length === 0) {
    const empty = emptyActivityAnalysis('No source analyses could be generated from the available events.')
    database.updateProjectActivityAnalysis(projectId, empty)
    database.setActivitySummary(projectId, empty, activityInputHash(projectId), [])
    return empty
  }

  if (signal?.aborted) throw new Error('Activity summary generation cancelled')

  report('Super-context', 'Synthesizing the activity super-context')
  const superContextPrompt = buildSuperContextPrompt(sourceAnalyses)
  let analysis: ActivityAnalysis
  try {
    const content = await callLLM(config, model, ACTIVITY_ANALYSIS_SYSTEM_PROMPT, superContextPrompt, signal)
    if (!content.trim()) throw new Error('System Model returned an empty activity summary')
    analysis = parseActivityAnalysisResponse(content)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to generate super-context activity analysis: ${detail}`)
  }

  // The synthesis emits its own timeline and people, but it only ever saw the
  // consolidated prose — anything the model mentioned once in an early chunk is
  // long gone by then. `projects.activity_analysis` is the single thing
  // timeline.ts and people.ts harvest from, so the entries banked off every
  // chunk are merged in here. The synthesis keeps priority; the harvest fills
  // in what the funnel dropped.
  analysis = {
    ...analysis,
    timeline: mergeAnalysisTimeline(analysis.timeline, harvested.timeline),
    people: mergeAnalysisPeople(analysis.people, harvested.people),
  }

  database.updateProjectActivityAnalysis(projectId, analysis)
    const hash = activityInputHash(projectId)
    database.setActivitySummary(projectId, analysis, hash, sourceAnalyses)
    return analysis
  } catch (err) {
    finishActivityRun(run, { failed: true, message: err instanceof Error ? err.message : null })
    throw err
  } finally {
    // Idempotent: a run already closed by the catch above is a no-op here,
    // because finishActivityRun ignores a token that is no longer active.
    finishActivityRun(run)
  }
}

export function getActivitySummary(projectId: string): ActivitySummary | null {
  return database.getActivitySummary(projectId)
}
