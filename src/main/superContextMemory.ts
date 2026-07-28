import type { ProviderConfig, MemoryCandidate } from '../shared/types'
import * as database from './database'
import * as settings from './settings'
import { extractMemoryCandidates } from './provider'
import { hasProviderCredentials } from './providerEndpoint'
import type { MemoryEvidenceSource } from './memory'
import { redactMemoryContent } from './memory'

const MAX_SUPER_CONTEXT_MEMORY_CHARS = 24_000

// Mirrors the sensitive-category gating applied to MemoryExtractionRequest.includeSensitive.
// Individual fields carry their own `sensitive` flag; this set gates model-proposed NEW fields,
// which are created without one.
export const SENSITIVE_MEMORY_CATEGORIES = new Set([
  'contact',
  'health',
  'finances',
  'relationships',
  'household',
])

export interface SuperContextMemoryResult {
  autoFilled: number
  suggestionsCreated: number
  candidatesFound: number
  newFieldsCreated: number
  model: string | null
  skipped: boolean
  error: string | null
}

function emptyResult(overrides?: Partial<SuperContextMemoryResult>): SuperContextMemoryResult {
  return {
    autoFilled: 0,
    suggestionsCreated: 0,
    candidatesFound: 0,
    newFieldsCreated: 0,
    model: null,
    skipped: false,
    error: null,
    ...overrides,
  }
}

export function isSuperContextMemoryEnabled(): boolean {
  try {
    return settings.getSettings().superContextMemoryEnabled === true
  } catch {
    return false
  }
}

export interface SuperContextMemoryOptions {
  contextText: string
  sourceLabel: string
  sourceReference: string
  config: ProviderConfig
  model: string
  signal?: AbortSignal
  includeSensitive?: boolean
}

// Analyzes a freshly generated super-context and populates Memory from it, creating
// new custom fields where the synthesis contains facts no existing field covers.
// Never throws: super-context generation must not fail because Memory extraction did.
export async function extractSuperContextMemory(
  options: SuperContextMemoryOptions
): Promise<SuperContextMemoryResult> {
  const { contextText, sourceLabel, sourceReference, config, model, signal } = options
  const includeSensitive = options.includeSensitive === true

  try {
    if (!isSuperContextMemoryEnabled()) return emptyResult({ skipped: true })

    if (!hasProviderCredentials(config) || !model.trim()) return emptyResult({ skipped: true })

    const redacted = redactMemoryContent(contextText).trim().slice(0, MAX_SUPER_CONTEXT_MEMORY_CHARS)
    if (redacted.length < 200) return emptyResult({ skipped: true })

    const fields = database.listMemoryFields().filter((field) => (
      !field.locked && (includeSensitive || !field.sensitive)
    ))
    if (fields.length === 0) return emptyResult({ skipped: true })

    const sources: MemoryEvidenceSource[] = [{
      id: 'source-1',
      type: 'super-context',
      reference: sourceReference,
      label: sourceLabel,
      capturedAt: Date.now(),
      content: redacted,
    }]

    const extraction = await extractMemoryCandidates(
      config,
      model,
      fields,
      sources,
      signal ?? new AbortController().signal,
      { allowCustomFields: true }
    )

    if (signal?.aborted) return emptyResult({ skipped: true })

    const allCandidates: MemoryCandidate[] = [...extraction.candidates]

    let newFieldsCreated = 0
    for (const newField of extraction.newFields) {
      if (signal?.aborted) break
      if (!includeSensitive && SENSITIVE_MEMORY_CATEGORIES.has(newField.category)) continue
      try {
        const created = database.createMemoryField({
          category: newField.category,
          label: newField.label,
          valueType: newField.valueType,
          sensitive: false,
        })
        const createdField = created.find((f) => f.label === newField.label && f.category === newField.category)
        if (createdField) {
          allCandidates.push({
            fieldKey: createdField.fieldKey,
            value: newField.value,
            confidence: newField.confidence,
            rationale: newField.rationale,
            sources: newField.sources,
            mergeStrategy: 'replace',
          })
          newFieldsCreated += 1
        }
      } catch {
        // Skip fields that fail to create (e.g., duplicate label).
      }
    }

    const applied = database.applyMemoryCandidates(allCandidates)

    return {
      autoFilled: applied.autoFilled,
      suggestionsCreated: applied.suggestionsCreated,
      candidatesFound: allCandidates.length,
      newFieldsCreated,
      model: extraction.model,
      skipped: false,
      error: null,
    }
  } catch (error) {
    return emptyResult({
      error: error instanceof Error ? error.message : 'Super-context Memory extraction failed',
    })
  }
}
