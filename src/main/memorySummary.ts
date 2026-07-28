import type { ProviderConfig } from '../shared/types'
import * as database from './database'
import { MEMORY_CATALOG } from '../shared/memoryCatalog'
import { peoplePromptSection } from '../shared/people'
import { timelinePromptSection } from '../shared/timeline'
import { getBaseUrl, getHeaders, hasProviderCredentials, missingCredentialsError } from './providerEndpoint'

const SUMMARY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_SUMMARY_CHARS = 12000

// Bump when the summary prompts change so stored summaries are regenerated.
const PROMPT_VERSION = 'v4-timeline-people'

function memorySummaryInputHash(): string {
  return `${PROMPT_VERSION}:${database.computeMemoryFieldHash()}`
}

function formatFieldsForSummary(): string {
  const fields = database.listMemoryFields().filter((f) => f.value !== null && f.value !== undefined)
  const byCategory = new Map<string, Array<{ label: string; value: string }>>()
  for (const field of fields) {
    const value = Array.isArray(field.value)
      ? field.value.join(', ')
      : typeof field.value === 'boolean'
        ? field.value ? 'Yes' : 'No'
        : String(field.value)
    if (!value.trim()) continue
    const list = byCategory.get(field.category) || []
    list.push({ label: field.label, value })
    byCategory.set(field.category, list)
  }
  const lines: string[] = []
  for (const category of MEMORY_CATALOG) {
    const catFields = byCategory.get(category.key)
    if (!catFields || catFields.length === 0) continue
    lines.push(`## ${category.label}`)
    for (const f of catFields) {
      lines.push(`- ${f.label}: ${f.value}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

export function shouldUpdateAbridgedSummary(): boolean {
  const { updatedAt, fieldHash } = database.getMemorySummary()
  if (!updatedAt || !fieldHash) return true
  const currentHash = memorySummaryInputHash()
  if (currentHash !== fieldHash) return true
  return Date.now() - updatedAt > SUMMARY_REFRESH_INTERVAL_MS
}

export async function generateAbridgedSummary(
  config: ProviderConfig,
  model: string,
  signal: AbortSignal
): Promise<string> {
  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No System Model configured')

  const { summary: existingSummary } = database.getMemorySummary()
  const currentFields = formatFieldsForSummary()
  if (!currentFields.trim()) return ''

  const isNewSummary = !existingSummary.trim()
  const systemPrompt = isNewSummary
    ? `You generate a rich, natural-language summary of a person based on their structured memory database. Cover who they are, their context, what's on their mind, their routines and relationships, and their key preferences. Use natural prose, not bullet points.

Length: when the fields carry enough information, write AT LEAST three substantial paragraphs, and use four to seven where the material supports it. Extra length must buy more substance about the person — never repetition, never a field-by-field recital, never filler. If only a handful of fields are filled, a shorter honest summary is correct: do not pad.

Do not invent information that isn't in the provided fields. If a category has no data, skip it. Never include sensitive data like passwords, API keys, or financial account numbers.

Return the summary prose, then the timeline section described below.

${timelinePromptSection(25)}

${peoplePromptSection(20)}

Timeline sourcing for this summary: date entries only from what the fields themselves state (a date field, a date inside a value, or a period a value names). Memory fields are often undated — that is expected, and an entry you cannot date belongs in the prose, not the timeline.`
    : `You update an existing user summary based on changes to their structured memory database. You receive the current summary and the current memory fields. Your job is to update the summary to incorporate new or changed information and remove anything that is no longer accurate. If the changes are minor or irrelevant to a user summary, return the summary with minimal or no edits.

Keep the same natural prose style. The summary should run AT LEAST three substantial paragraphs, and four to seven where the fields support it — but only where there is real material: never pad, never repeat, never recite fields one by one. If the fields are sparse, a shorter summary is correct.

Do not invent information. Never include sensitive data.

Return the updated summary prose, then the timeline section described below — carrying forward the entries from the existing summary's timeline that the fields still support, and adding or correcting entries where the fields have changed.

${timelinePromptSection(25)}

${peoplePromptSection(20)}

Timeline sourcing for this summary: date entries only from what the fields themselves state. Memory fields are often undated — that is expected, and an entry you cannot date belongs in the prose, not the timeline.`

  const userContent = isNewSummary
    ? `Current memory fields:\n\n${currentFields}`
    : `Current summary:\n\n${existingSummary}\n\n---\n\nCurrent memory fields (updated since the summary was written):\n\n${currentFields}`

  const response = await fetch(`${getBaseUrl(config)}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(config),
    signal,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: 8000,
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
    throw new Error(`Summary generation failed: ${detail}`)
  }

  const data = await response.json()
  const content: string = data.choices?.[0]?.message?.content || ''
  if (!content.trim()) throw new Error('System Model returned an empty summary')

  const trimmed = content.trim().slice(0, MAX_SUMMARY_CHARS)
  const fieldHash = memorySummaryInputHash()
  database.setMemorySummary(trimmed, fieldHash)
  return trimmed
}

export function getAbridgedSummary(): string {
  return database.getMemorySummary().summary
}
