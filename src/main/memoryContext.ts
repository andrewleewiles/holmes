import type { MemoryField, MemoryMode, ContextSelection, MemoryValue, ProviderConfig } from '../shared/types'
import { MEMORY_CATALOG } from '../shared/memoryCatalog'
import { flattenContextSelection } from '../shared/contextSelection'
import * as database from './database'
import { generateAbridgedSummary, getAbridgedSummary, shouldUpdateAbridgedSummary } from './memorySummary'

function formatValue(value: MemoryValue | null): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function formatFieldDetailed(field: MemoryField): string {
  const value = formatValue(field.value)
  if (!value) return ''
  const confidence = field.confidence !== null ? ` (confidence: ${Math.round(field.confidence * 100)}%)` : ''
  const origin = field.origin ? `, origin: ${field.origin}` : ''
  return `- ${field.label}: ${value}${confidence}${origin}`
}

function filterFields(fields: MemoryField[], categoryKeys?: string[]): MemoryField[] {
  const scope = categoryKeys && categoryKeys.length > 0 ? new Set(categoryKeys) : null
  const filtered = scope ? fields.filter((f) => scope.has(f.category)) : fields
  return filtered.filter((f) => f.value !== null && f.value !== undefined && f.value !== '')
}

function buildDetailedContext(
  allFields: MemoryField[],
  categoryKeys: string[] | undefined,
  contextLabel: string
): { content: string; label: string } | null {
  const fields = filterFields(allFields, categoryKeys)
  if (fields.length === 0) return null

  const byCategory = new Map<string, MemoryField[]>()
  for (const field of fields) {
    const list = byCategory.get(field.category) || []
    list.push(field)
    byCategory.set(field.category, list)
  }

  const lines: string[] = []
  for (const category of MEMORY_CATALOG) {
    const catFields = byCategory.get(category.key)
    if (!catFields || catFields.length === 0) continue
    lines.push(`### ${category.label}`)
    for (const field of catFields) {
      const line = formatFieldDetailed(field)
      if (line) lines.push(line)
    }
    lines.push('')
  }

  const content = `Detailed memory context with values, confidence, and origin. ${fields.length} fields across ${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'}.\n\n${lines.join('\n').trim()}`
  return { content, label: contextLabel }
}

async function buildAbridgedContext(
  providerConfig: ProviderConfig,
  systemModel: string,
  categoryKeys: string[] | undefined,
  contextLabel: string
): Promise<{ content: string; label: string } | null> {
  if (categoryKeys && categoryKeys.length > 0) {
    const allFields = database.listMemoryFields()
    const detailed = buildDetailedContext(allFields, categoryKeys, contextLabel)
    if (detailed) {
      return {
        content: `Abridged memory context (category-scoped, field listing).\n\n${detailed.content}`,
        label: contextLabel,
      }
    }
    return null
  }

  let summary = getAbridgedSummary()
  if (!summary || shouldUpdateAbridgedSummary()) {
    try {
      summary = await generateAbridgedSummary(providerConfig, systemModel, new AbortController().signal)
    } catch {
      if (!summary) return null
    }
  }
  if (!summary.trim()) return null
  return {
    content: `Abridged memory context — a rolling summary of the user's profile, refreshed when memory changes. This is a natural-language overview, not exhaustive field data.\n\n${summary}`,
    label: contextLabel,
  }
}

export async function buildMemoryContext(
  memoryMode: MemoryMode,
  context: ContextSelection,
  providerConfig?: ProviderConfig,
  systemModel?: string
): Promise<{ content: string; label: string } | null> {
  if (memoryMode === 'anonymous') return null

  const items = flattenContextSelection(context)
  const includesLife = items.some((item) => item.kind === 'life')
  const categoryKeys = includesLife
    ? []
    : items.filter((item) => item.kind === 'category').map((item) => (item as { categoryKey: string }).categoryKey)

  let contextLabel = 'Life'

  if (categoryKeys.length > 0) {
    contextLabel = categoryKeys
      .map((key) => MEMORY_CATALOG.find((c) => c.key === key)?.label || key)
      .join(' + ')
  } else if (!includesLife) {
    return null
  }

  const scope = categoryKeys.length > 0 ? categoryKeys : undefined

  if (memoryMode === 'detailed') {
    const allFields = database.listMemoryFields()
    return buildDetailedContext(allFields, scope, contextLabel)
  }

  if (memoryMode === 'abridged') {
    if (!providerConfig || !systemModel) return null
    return buildAbridgedContext(providerConfig, systemModel, scope, contextLabel)
  }

  return null
}
