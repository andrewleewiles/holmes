import type { ActivityAnalysis, ActivitySourceType } from '../shared/types'
import { ANALYSIS_PEOPLE_JSON_FIELD, analysisPeoplePromptRule, coerceAnalysisPeople, peoplePromptSection } from '../shared/people'
import {
  ANALYSIS_TIMELINE_JSON_FIELD,
  analysisTimelinePromptRule,
  coerceAnalysisTimeline,
  timelinePromptSection,
} from '../shared/timeline'

export const ACTIVITY_ANALYSIS_SYSTEM_PROMPT = `You are an activity-synthesis assistant. Analyze the user's locally-ingested personal activity data (browser history, YouTube watch history, Amazon orders, email metadata, macOS KnowledgeC app-usage, Photos library metadata, location history, weather, and recurring subscription charges) and produce a structured overview of their digital behavior, interests, spending, communication, and location patterns.

Synthesize, do not judge. Surface concrete patterns and counts. Flag uncertainties and follow-ups explicitly. Prefer concrete, actionable observations over vague summaries.

Respond with ONLY a valid JSON object (no markdown, no code fences) with this exact structure:
{
  "generatedAt": "<ISO 8601 timestamp>",
  "topInterests": [
    "<short phrase describing a recurring topic or theme, e.g. 'Rust programming', 'marathon training'>"
  ],
  "mediaConsumption": [
    { "topic": "<topic or channel>", "hoursWeekly": <estimated hours per week> }
  ],
  "spendingPatterns": [
    { "category": "<category e.g. 'subscriptions', 'amazon orders', 'media'>", "monthlyCents": <estimated monthly spend in cents> }
  ],
  "communicationPatterns": [
    { "contact": "<sender/recipient domain or address, redacted form OK>", "frequency": "<short phrase e.g. 'daily', 'weekly newsletters', 'occasional'>" }
  ],
  "digitalBehavior": [
    { "app": "<bundle id or app name>", "hoursWeekly": <estimated hours per week>, "mood": "<optional inferred mood or context>" }
  ],
  "locationPatterns": [
    { "place": "<location name or label>", "visitsMonthly": <estimated visits per month> }
  ],
  "weatherMoodCorrelations": [
    "<short statement correlating weather conditions with activity or behavior>"
  ],
  "openThreads": [
    "<short follow-up worth tracking, e.g. 'Review subscriptions > $50/mo', 'Reduce late-night screen time'>"
  ],
${ANALYSIS_TIMELINE_JSON_FIELD}
${ANALYSIS_PEOPLE_JSON_FIELD}
  "summary": "<long-form narrative synthesis of the user's overall activity picture: at least 3 substantial paragraphs when the sources support it>"
}

Rules:
- Omit fields you cannot populate rather than inventing values. Empty arrays are acceptable.
- "topInterests" should be inferred from recurring topics across browser, YouTube, knowledge, and email activity.
- "mediaConsumption" hours are estimates derived from event counts and durations where available.
- "spendingPatterns" totals are in cents (integer). Use subscription cadence to compute monthly equivalents.
- "communicationPatterns" should reflect frequency of contact, not message content.
- "digitalBehavior" reflects app usage from KnowledgeC, screen-on, and notification streams.
- "locationPatterns" should group nearby coordinates into named place clusters where possible.
- "weatherMoodCorrelations" should only be populated when both weather and activity data are present.
- "openThreads" are cross-cutting observations worth raising with the user later.
${analysisTimelinePromptRule(40)}
${analysisPeoplePromptRule(25)}
- The activity timeline is the chronology of the person's digital life: when an interest, platform, app, service or spending pattern started, peaked, changed or stopped, and any dated one-off event worth remembering. Every event carries its own timestamp in the source data — those timestamps are authoritative, so date entries from them rather than estimating.
- "summary" is the long-form part of this analysis. When the source analyses carry enough signal, write AT LEAST three substantial paragraphs (roughly 450-750 words): how the person spends their time and attention; the concrete quantified patterns across interests, media, spending, communication, and location, including how they relate to each other; and what the whole picture suggests about their routines, priorities, and trajectory, plus where sources corroborate or contradict each other. Extra length must buy more behavioral depth and more evidence — never repetition, never a source-by-source inventory, never filler. If the data is thin, a shorter honest summary is correct: do not pad.
- "generatedAt" must be the current time in ISO 8601.`

export const SOURCE_ANALYSIS_SYSTEM_PROMPT = `You are a per-source activity analyst. You will receive events from a single data source (browser history, YouTube, Amazon, email, app usage, photos, location, weather, or subscriptions). Analyze ONLY that source and produce a concise, structured text summary (not JSON) of the patterns you observe.

Focus on:
- Recurring topics, sites, channels, apps, or contacts
- Time patterns (when activity happens, duration trends)
- Spending or subscription patterns where applicable
- Notable or anomalous events worth surfacing
- Quantitative observations (counts, frequencies, estimated durations)

Rules:
- Be concrete: cite specific sites, channels, apps, amounts where relevant (they are already redacted).
- Length: when the events carry enough signal, write AT LEAST three substantial paragraphs (roughly 400-700 words) covering what the person did, the quantified patterns and their time structure, and what the source suggests about their habits, interests, or state — including changes over the period covered. Extra length must buy more behavioral depth and more evidence, never repetition or filler. If the events are sparse or unrevealing, a short honest answer is correct: do not pad.
- Do NOT invent data. If patterns are unclear, say so.
- Do NOT produce JSON. Output plain text only.
- Every event you are given carries its own timestamp. Those timestamps are authoritative: anchor the patterns you describe to the dates and periods they establish, and never estimate a date when the events state one.

${timelinePromptSection(25)}

${peoplePromptSection(25)}`

export const SOURCE_ANALYSIS_INTRO: Record<ActivitySourceType, string> = {
  browser: 'BROWSER HISTORY — site visits, bookmarks, and downloads from Chrome/Safari/Edge/Firefox.',
  youtube: 'YOUTUBE WATCH HISTORY — videos watched, channels, and watch durations from Google Takeout.',
  amazon: 'AMAZON ORDERS — purchases, line items, and spending totals from order history reports or GraphQL sync.',
  email: 'EMAIL METADATA — senders, subjects, body excerpts, and frequency from macOS Mail or .mbox imports. Bodies are truncated.',
  knowledge: 'macOS KNOWLEDGEC — app usage durations, screen-on time, and notification events from the system Knowledge database.',
  photos: 'PHOTOS METADATA — creation dates, locations, and faces from the Photos library (via PhotoKit sidecar).',
  location: 'GOOGLE LOCATION HISTORY — timestamped GPS coordinates from Google Takeout.',
  weather: 'WEATHER HISTORY — hourly temperature, humidity, precipitation, wind, and conditions from open-meteo.',
  subscription: 'SUBSCRIPTIONS — recurring charges, providers, plans, cadences, and amounts detected from email receipts and Apple ledger.',
  account: 'CONNECTED ACCOUNT — activity from an external service, either synced live or parsed from the data export the service provides.',
}

/**
 * The per-account intro replaces the generic one above whenever the events
 * belong to a known provider, so the model is told which service it is reading
 * rather than "a connected account".
 */
export function accountAnalysisIntro(providerLabel: string, blurb: string): string {
  return `${providerLabel.toUpperCase()} — ${blurb}`
}

export function emptySourceAnalysis(sourceType: ActivitySourceType): string {
  return `No ${sourceType} events available for analysis.`
}

export function emptyActivityAnalysis(reason: string): ActivityAnalysis {
  return {
    generatedAt: new Date().toISOString(),
    topInterests: [],
    mediaConsumption: [],
    spendingPatterns: [],
    communicationPatterns: [],
    digitalBehavior: [],
    locationPatterns: [],
    weatherMoodCorrelations: [],
    openThreads: [],
    timeline: [],
    summary: reason,
  }
}

function extractJsonObject(text: string): string {
  let trimmed = text.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim()
  }
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    trimmed = trimmed.slice(firstBrace, lastBrace + 1)
  }
  return trimmed
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function coerceNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : 0
}

export function parseActivityAnalysisResponse(text: string): ActivityAnalysis {
  const jsonText = extractJsonObject(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    const snippet = text.length > 300 ? text.slice(0, 300) + '...' : text
    throw new Error(
      `Activity analysis response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `Response starts with: ${JSON.stringify(snippet)}`
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Activity analysis response is not an object')
  }
  const obj = parsed as Partial<ActivityAnalysis>

  const topInterests = coerceStringArray(obj.topInterests)
  const weatherMoodCorrelations = coerceStringArray(obj.weatherMoodCorrelations)
  const openThreads = coerceStringArray(obj.openThreads)

  const mediaConsumption = Array.isArray(obj.mediaConsumption)
    ? (obj.mediaConsumption as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          topic: typeof item.topic === 'string' ? item.topic : '',
          hoursWeekly: coerceNumber(item.hoursWeekly),
        }))
    : []

  const spendingPatterns = Array.isArray(obj.spendingPatterns)
    ? (obj.spendingPatterns as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          category: typeof item.category === 'string' ? item.category : '',
          monthlyCents: Math.round(coerceNumber(item.monthlyCents)),
        }))
    : []

  const communicationPatterns = Array.isArray(obj.communicationPatterns)
    ? (obj.communicationPatterns as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          contact: typeof item.contact === 'string' ? item.contact : '',
          frequency: typeof item.frequency === 'string' ? item.frequency : '',
        }))
    : []

  const digitalBehavior = Array.isArray(obj.digitalBehavior)
    ? (obj.digitalBehavior as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          app: typeof item.app === 'string' ? item.app : '',
          hoursWeekly: coerceNumber(item.hoursWeekly),
          ...(typeof item.mood === 'string' ? { mood: item.mood } : {}),
        }))
    : []

  const locationPatterns = Array.isArray(obj.locationPatterns)
    ? (obj.locationPatterns as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          place: typeof item.place === 'string' ? item.place : '',
          visitsMonthly: coerceNumber(item.visitsMonthly),
        }))
    : []

  const summary = typeof obj.summary === 'string' ? obj.summary : ''

  const generatedAt =
    typeof obj.generatedAt === 'string' && obj.generatedAt.trim() ? obj.generatedAt : new Date().toISOString()

  const timeline = coerceAnalysisTimeline((parsed as Record<string, unknown>).timeline)
  const people = coerceAnalysisPeople((parsed as Record<string, unknown>).people)

  return {
    generatedAt,
    topInterests,
    mediaConsumption,
    spendingPatterns,
    communicationPatterns,
    digitalBehavior,
    locationPatterns,
    weatherMoodCorrelations,
    openThreads,
    timeline,
    people,
    summary,
  }
}
