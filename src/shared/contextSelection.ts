import type { ContextSelection, ContextSelectionItem } from './types'

export const MAX_STACKED_CONTEXTS = 8

const MAX_STACK_DEPTH = 8

export function contextItemKey(item: ContextSelectionItem): string {
  switch (item.kind) {
    case 'project': return `project:${item.projectId}`
    case 'category': return `category:${item.categoryKey}`
    case 'life': return 'life'
    default: return 'none'
  }
}

export function contextItemFromKey(key: string): ContextSelectionItem | null {
  if (key === 'none') return { kind: 'none' }
  if (key === 'life') return { kind: 'life' }
  if (key.startsWith('project:')) {
    const projectId = key.slice(8)
    return projectId ? { kind: 'project', projectId } : null
  }
  if (key.startsWith('category:')) {
    const categoryKey = key.slice(9)
    return categoryKey ? { kind: 'category', categoryKey } : null
  }
  return null
}

function collectItems(value: unknown, out: ContextSelectionItem[], depth: number): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    if (depth >= MAX_STACK_DEPTH) return
    for (const entry of value) collectItems(entry, out, depth + 1)
    return
  }
  const candidate = value as { kind?: unknown; items?: unknown; projectId?: unknown; categoryKey?: unknown }
  if (candidate.kind === 'stack') {
    if (depth >= MAX_STACK_DEPTH) return
    collectItems(candidate.items, out, depth + 1)
    return
  }
  if (candidate.kind === 'project') {
    if (typeof candidate.projectId === 'string' && candidate.projectId) {
      out.push({ kind: 'project', projectId: candidate.projectId })
    }
    return
  }
  if (candidate.kind === 'category') {
    if (typeof candidate.categoryKey === 'string' && candidate.categoryKey) {
      out.push({ kind: 'category', categoryKey: candidate.categoryKey })
    }
    return
  }
  if (candidate.kind === 'life') out.push({ kind: 'life' })
}

export function flattenContextSelection(context: ContextSelection | null | undefined): ContextSelectionItem[] {
  const collected: ContextSelectionItem[] = []
  collectItems(context, collected, 0)

  const seen = new Set<string>()
  const result: ContextSelectionItem[] = []
  for (const item of collected) {
    const key = contextItemKey(item)
    if (key === 'none' || seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= MAX_STACKED_CONTEXTS) break
  }
  return result
}

export function contextSelectionFromItems(items: ContextSelectionItem[]): ContextSelection {
  const flattened = flattenContextSelection({ kind: 'stack', items })
  if (flattened.length === 0) return { kind: 'none' }
  if (flattened.length === 1) return flattened[0]!
  return { kind: 'stack', items: flattened }
}

export function normalizeContextSelection(context: ContextSelection | null | undefined): ContextSelection {
  const items = flattenContextSelection(context)
  if (items.length === 0) return { kind: 'none' }
  if (items.length === 1) return items[0]!
  return { kind: 'stack', items }
}

export function isStackedContext(context: ContextSelection | null | undefined): boolean {
  return flattenContextSelection(context).length > 1
}

export function contextSelectionKeys(context: ContextSelection | null | undefined): string[] {
  return flattenContextSelection(context).map(contextItemKey)
}

export function hasContextItem(context: ContextSelection | null | undefined, key: string): boolean {
  return contextSelectionKeys(context).includes(key)
}

export function addContextItem(context: ContextSelection | null | undefined, item: ContextSelectionItem): ContextSelection {
  return contextSelectionFromItems([...flattenContextSelection(context), item])
}

export function removeContextItem(context: ContextSelection | null | undefined, key: string): ContextSelection {
  return contextSelectionFromItems(flattenContextSelection(context).filter((item) => contextItemKey(item) !== key))
}

export function stackedProjectIds(context: ContextSelection | null | undefined): string[] {
  return flattenContextSelection(context)
    .filter((item): item is { kind: 'project'; projectId: string } => item.kind === 'project')
    .map((item) => item.projectId)
}

export function stackedCategoryKeys(context: ContextSelection | null | undefined): string[] {
  return flattenContextSelection(context)
    .filter((item): item is { kind: 'category'; categoryKey: string } => item.kind === 'category')
    .map((item) => item.categoryKey)
}

export function includesLifeContext(context: ContextSelection | null | undefined): boolean {
  return flattenContextSelection(context).some((item) => item.kind === 'life')
}

export function resolveStackedProjects<T extends { id: string }>(
  context: ContextSelection | null | undefined,
  projects: T[]
): T[] {
  return stackedProjectIds(context)
    .map((projectId) => projects.find((project) => project.id === projectId))
    .filter((project): project is T => Boolean(project))
}

export function memoryScopeForContext(context: ContextSelection | null | undefined): ContextSelection {
  const categories = stackedCategoryKeys(context)
  if (categories.length > 0 && !includesLifeContext(context)) {
    return contextSelectionFromItems(categories.map((categoryKey) => ({ kind: 'category', categoryKey })))
  }
  return { kind: 'life' }
}
