import type { ProviderConfig, HealthAnalysis, HealthObservation } from '../shared/types'
import * as database from './database'
import {
  HEALTH_ANALYSIS_SYSTEM_PROMPT,
  parseHealthAnalysisResponse,
} from './healthAnalysis'
import { redactHealthContent } from './health'
import { getBaseUrl, getHeaders, hasProviderCredentials, missingCredentialsError } from './providerEndpoint'

const SUMMARY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_OBSERVATION_CHARS = 80_000

// Bump when HEALTH_ANALYSIS_SYSTEM_PROMPT changes so stored summaries regenerate.
const PROMPT_VERSION = 'v4-timeline-people'

export function healthInputHash(projectId: string): string {
  return `${PROMPT_VERSION}:${database.getHealthObservationsHash(projectId)}`
}

export function shouldUpdateHealthSummary(projectId: string): boolean {
  const current = database.getHealthSummary(projectId)
  const hash = healthInputHash(projectId)
  if (!current || !current.updatedAt) return true
  if (current.fieldHash !== hash) return true
  if (Date.now() - current.updatedAt > SUMMARY_REFRESH_INTERVAL_MS) return true
  return false
}

function formatObservations(observations: HealthObservation[]): string {
  const lines: string[] = []
  let used = 0
  for (const obs of observations) {
    const line = formatObservation(obs)
    if (used + line.length > MAX_OBSERVATION_CHARS) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

function formatObservation(obs: HealthObservation): string {
  const parts: string[] = [`[${obs.type}]`, redactHealthContent(obs.displayName)]
  const value = obs.valueText ?? (obs.valueReal != null ? String(obs.valueReal) : '')
  if (value) parts.push(`${value}${obs.unit ? ` ${obs.unit}` : ''}`)
  if (obs.refLow != null || obs.refHigh != null) {
    const ref = obs.refLow != null && obs.refHigh != null
      ? `${obs.refLow}-${obs.refHigh}`
      : obs.refLow != null
        ? `>= ${obs.refLow}`
        : `<= ${obs.refHigh}`
    parts.push(`(ref ${ref})`)
  }
  if (obs.effectiveDate) parts.push(`@ ${obs.effectiveDate}`)
  return parts.join(' ')
}

export async function generateHealthSummary(
  projectId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal
): Promise<HealthAnalysis> {
  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No System Model configured')

  const observations = database.listAllHealthObservations(projectId, { limit: 2000 })
  if (observations.length === 0) {
    const empty = {
      generatedAt: new Date().toISOString(),
      domainScores: [],
      regimen: { medications: [], supplements: [], notes: 'No observations yet.' },
      interactions: [],
      openThreads: [],
      recommendedLabs: [],
      recentObservations: [],
      summary: 'Add health documents to receive a structured summary.',
    } as HealthAnalysis
    database.updateProjectHealthAnalysis(projectId, empty)
    database.setHealthSummary(projectId, JSON.stringify(empty), healthInputHash(projectId))
    return empty
  }

  const formatted = formatObservations(observations)
  const userPrompt = `Synthesize the following structured health observations (extracted locally from imported documents) into the JSON structure defined by the system prompt:\n\n${formatted}`

  const response = await fetch(`${getBaseUrl(config)}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(config),
    signal: signal as never,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: HEALTH_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 14000,
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
    throw new Error(`Health summary generation failed: ${detail}`)
  }

  const data = await response.json()
  const content: string = data?.choices?.[0]?.message?.content || ''
  if (!content.trim()) throw new Error('System Model returned an empty health summary')
  const finishReason = data?.choices?.[0]?.finish_reason

  let analysis: HealthAnalysis
  try {
    analysis = parseHealthAnalysisResponse(content)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const truncated = finishReason === 'length' ? ' (response was truncated due to token limit)' : ''
    throw new Error(`Failed to parse health summary response from AI${truncated}: ${detail}`)
  }

  database.updateProjectHealthAnalysis(projectId, analysis)
  const hash = healthInputHash(projectId)
  database.setHealthSummary(projectId, JSON.stringify(analysis), hash)
  return analysis
}

export function getHealthSummary(projectId: string): HealthAnalysis | null {
  const summary = database.getHealthSummary(projectId)
  if (!summary || !summary.summary) return null
  try {
    return JSON.parse(summary.summary) as HealthAnalysis
  } catch {
    return null
  }
}
