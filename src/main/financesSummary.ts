import type { ProviderConfig, FinancesSummary, SubscriptionEvent } from '../shared/types'
import { ANALYSIS_TIMELINE_JSON_FIELD, analysisTimelinePromptRule, coerceAnalysisTimeline } from '../shared/timeline'
import * as database from './database'
import { redactActivityContent } from './activity'
import { getBaseUrl, getHeaders, hasProviderCredentials, missingCredentialsError } from './providerEndpoint'

const MAX_EVENT_CHARS = 80_000

const FINANCES_SUMMARY_SYSTEM_PROMPT = `You are a personal-finance synthesis assistant focused on recurring subscriptions and digital spending. Analyze the user's detected subscription events (provider, plan name, amount, cadence, and occurrence dates) and produce a structured summary of their monthly recurring outflows.

Synthesize, do not judge. Surface concrete totals and patterns. Flag subscriptions that look duplicated, recently added, recently cancelled, or unusually priced.

Respond with ONLY a valid JSON object (no markdown, no code fences) with this exact structure:
{
  "generatedAt": "<ISO 8601 timestamp>",
  "totalMonthlyCents": <integer, sum of all monthly-equivalent recurring charges in cents>,
  "activeSubscriptions": [
    { "provider": "<provider name>", "planName": "<plan name>", "amountCents": <per-cycle amount in cents>, "cadence": "<weekly|monthly|yearly|unknown>" }
  ],
  "recentChanges": [
    "<short statement about a recent change: new, cancelled, price change, duplicate>"
  ],
${ANALYSIS_TIMELINE_JSON_FIELD}
  "summary": "<long-form narrative synthesis of the subscription and recurring spending picture: at least 3 substantial paragraphs when the events support it>"
}

Rules:
- Convert weekly amounts to monthly by multiplying by 4.33, yearly amounts to monthly by dividing by 12. Round to whole cents.
- "totalMonthlyCents" is the sum of monthly-equivalent amounts across all active subscriptions.
- "activeSubscriptions" should list each unique (provider, planName) pair once, using the most recent event's amount and cadence.
- "recentChanges" should reflect observations from the most recent 90 days of events.
${analysisTimelinePromptRule(30)}
- The finances timeline is the chronology of recurring spend: when each subscription first appears, when its price changes, when it lapses, and when the overall monthly load steps up or down. Each event carries its own occurrence date — those dates are authoritative.
- "summary" is the long-form part of this analysis. When the events carry enough signal, write AT LEAST three substantial paragraphs (roughly 400-700 words): what the person is actually paying for and what that spend says about how they live and what they value; the concrete totals, cadences, and how the recurring load has moved over the period covered; and what deserves attention — duplicates, drift, unusual pricing, dormant services, and concentration risk. Extra length must buy more concrete financial detail and more evidence — never repetition, never a restatement of the subscription list above, never filler. If the events are thin, a shorter honest summary is correct: do not pad.
- "generatedAt" must be the current time in ISO 8601.`

function r(value: string | null | undefined): string {
  if (value == null) return ''
  return redactActivityContent(String(value))
}

function formatSubscriptions(events: SubscriptionEvent[]): string {
  const lines: string[] = []
  let used = 0
  for (const e of events) {
    const line = `- [${e.occurredAt}] provider=${r(e.provider)} plan=${r(e.planName)} amount=${e.amountCents ?? 0}c ${e.cadence}`
    if (used + line.length + 1 > MAX_EVENT_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

function coerceNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : 0
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function parseFinancesSummaryResponse(text: string): FinancesSummary {
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

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    const snippet = text.length > 300 ? text.slice(0, 300) + '...' : text
    throw new Error(
      `Finances summary response is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
      `Response starts with: ${JSON.stringify(snippet)}`
    )
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Finances summary response is not an object')
  }
  const obj = parsed as Partial<FinancesSummary>

  const activeSubscriptions = Array.isArray(obj.activeSubscriptions)
    ? (obj.activeSubscriptions as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          provider: typeof item.provider === 'string' ? item.provider : '',
          planName: typeof item.planName === 'string' ? item.planName : '',
          amountCents: Math.round(coerceNumber(item.amountCents)),
          cadence: typeof item.cadence === 'string' ? item.cadence : 'unknown',
        }))
    : []

  const generatedAt =
    typeof obj.generatedAt === 'string' && obj.generatedAt.trim() ? obj.generatedAt : new Date().toISOString()
  const summary = typeof obj.summary === 'string' ? obj.summary : ''
  const recentChanges = coerceStringArray(obj.recentChanges)
  const timeline = coerceAnalysisTimeline((parsed as Record<string, unknown>).timeline)

  return {
    generatedAt,
    totalMonthlyCents: Math.round(coerceNumber(obj.totalMonthlyCents)),
    activeSubscriptions,
    recentChanges,
    timeline,
    summary,
  }
}

export async function generateFinancesSummary(
  projectId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  eventsProjectId: string = projectId
): Promise<FinancesSummary> {
  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No System Model configured')

  const events = database.listAllSubscriptionEvents(eventsProjectId, { limit: 5000 })
  if (events.length === 0) {
    const empty: FinancesSummary = {
      generatedAt: new Date().toISOString(),
      totalMonthlyCents: 0,
      activeSubscriptions: [],
      recentChanges: [],
      timeline: [],
      summary: 'No subscription events detected. Import email or an Apple subscriptions ledger to populate a finances summary.',
    }
    database.updateProjectFinancesSummary(projectId, empty)
    return empty
  }

  const formatted = formatSubscriptions(events)
  const userPrompt = `Synthesize the following detected subscription events into the JSON structure defined by the system prompt:\n\n${formatted}`

  const response = await fetch(`${getBaseUrl(config)}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(config),
    signal: signal as never,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: FINANCES_SUMMARY_SYSTEM_PROMPT },
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
    throw new Error(`Finances summary generation failed: ${detail}`)
  }

  const data = await response.json()
  const content: string = data?.choices?.[0]?.message?.content || ''
  if (!content.trim()) throw new Error('System Model returned an empty finances summary')
  const finishReason = data?.choices?.[0]?.finish_reason

  let summary: FinancesSummary
  try {
    summary = parseFinancesSummaryResponse(content)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const truncated = finishReason === 'length' ? ' (response was truncated due to token limit)' : ''
    throw new Error(`Failed to parse finances summary response from AI${truncated}: ${detail}`)
  }

  database.updateProjectFinancesSummary(projectId, summary)
  return summary
}
