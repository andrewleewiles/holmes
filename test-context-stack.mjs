import assert from 'node:assert/strict'
import {
  MAX_STACKED_CONTEXTS,
  addContextItem,
  contextItemFromKey,
  contextItemKey,
  contextSelectionFromItems,
  contextSelectionKeys,
  flattenContextSelection,
  hasContextItem,
  includesLifeContext,
  isStackedContext,
  memoryScopeForContext,
  normalizeContextSelection,
  removeContextItem,
  resolveStackedProjects,
  stackedCategoryKeys,
  stackedProjectIds,
} from './src/shared/contextSelection.ts'

// Backward compatibility: already-stored single-value contexts survive untouched.
assert.deepEqual(normalizeContextSelection({ kind: 'none' }), { kind: 'none' })
assert.deepEqual(normalizeContextSelection({ kind: 'life' }), { kind: 'life' })
assert.deepEqual(normalizeContextSelection({ kind: 'project', projectId: 'p1' }), { kind: 'project', projectId: 'p1' })
assert.deepEqual(normalizeContextSelection({ kind: 'category', categoryKey: 'health' }), { kind: 'category', categoryKey: 'health' })

// Garbage never throws.
assert.deepEqual(normalizeContextSelection(null), { kind: 'none' })
assert.deepEqual(normalizeContextSelection(undefined), { kind: 'none' })
assert.deepEqual(normalizeContextSelection({}), { kind: 'none' })
assert.deepEqual(normalizeContextSelection({ kind: 'bogus' }), { kind: 'none' })
assert.deepEqual(normalizeContextSelection({ kind: 'project' }), { kind: 'none' })
assert.deepEqual(normalizeContextSelection({ kind: 'stack' }), { kind: 'none' })
assert.deepEqual(normalizeContextSelection({ kind: 'stack', items: 'nope' }), { kind: 'none' })

// A single-item stack collapses back to the single-value shape.
assert.deepEqual(normalizeContextSelection({ kind: 'stack', items: [{ kind: 'life' }] }), { kind: 'life' })

// Nested stacks flatten; `none` entries drop out without suppressing the rest.
const nested = {
  kind: 'stack',
  items: [
    { kind: 'none' },
    { kind: 'stack', items: [{ kind: 'project', projectId: 'p1' }, { kind: 'stack', items: [{ kind: 'category', categoryKey: 'health' }] }] },
    { kind: 'life' },
  ],
}
assert.deepEqual(contextSelectionKeys(nested), ['project:p1', 'category:health', 'life'])
assert.deepEqual(normalizeContextSelection(nested), {
  kind: 'stack',
  items: [
    { kind: 'project', projectId: 'p1' },
    { kind: 'category', categoryKey: 'health' },
    { kind: 'life' },
  ],
})

// Dedupe preserves first-seen order.
const duped = contextSelectionFromItems([
  { kind: 'project', projectId: 'p2' },
  { kind: 'category', categoryKey: 'health' },
  { kind: 'project', projectId: 'p2' },
  { kind: 'category', categoryKey: 'health' },
  { kind: 'project', projectId: 'p1' },
])
assert.deepEqual(contextSelectionKeys(duped), ['project:p2', 'category:health', 'project:p1'])
assert.equal(isStackedContext(duped), true)
assert.equal(isStackedContext({ kind: 'life' }), false)
assert.equal(isStackedContext({ kind: 'none' }), false)

// Stack size is capped.
const oversized = contextSelectionFromItems(
  Array.from({ length: MAX_STACKED_CONTEXTS + 5 }, (_, i) => ({ kind: 'project', projectId: `p${i}` }))
)
assert.equal(flattenContextSelection(oversized).length, MAX_STACKED_CONTEXTS)

// Key round-tripping.
for (const key of ['none', 'life', 'project:p1', 'category:health']) {
  assert.equal(contextItemKey(contextItemFromKey(key)), key)
}
assert.equal(contextItemFromKey('project:'), null)
assert.equal(contextItemFromKey('nonsense'), null)

// add / remove.
let selection = { kind: 'project', projectId: 'p1' }
selection = addContextItem(selection, { kind: 'project', projectId: 'p2' })
selection = addContextItem(selection, { kind: 'project', projectId: 'p1' })
assert.deepEqual(contextSelectionKeys(selection), ['project:p1', 'project:p2'])
assert.equal(hasContextItem(selection, 'project:p2'), true)
selection = addContextItem(selection, { kind: 'category', categoryKey: 'health' })
selection = removeContextItem(selection, 'project:p2')
assert.deepEqual(contextSelectionKeys(selection), ['project:p1', 'category:health'])
selection = removeContextItem(selection, 'category:health')
assert.deepEqual(selection, { kind: 'project', projectId: 'p1' })
assert.deepEqual(removeContextItem(selection, 'project:p1'), { kind: 'none' })

// Memory scope: the union of stacked categories, life wins when present.
const twoCategories = contextSelectionFromItems([
  { kind: 'category', categoryKey: 'health' },
  { kind: 'category', categoryKey: 'career' },
])
assert.deepEqual(memoryScopeForContext(twoCategories), {
  kind: 'stack',
  items: [
    { kind: 'category', categoryKey: 'health' },
    { kind: 'category', categoryKey: 'career' },
  ],
})
assert.deepEqual(stackedCategoryKeys(twoCategories), ['health', 'career'])
assert.deepEqual(memoryScopeForContext({ kind: 'category', categoryKey: 'health' }), { kind: 'category', categoryKey: 'health' })
assert.deepEqual(memoryScopeForContext({ kind: 'project', projectId: 'p1' }), { kind: 'life' })
assert.deepEqual(memoryScopeForContext({ kind: 'none' }), { kind: 'life' })
assert.deepEqual(
  memoryScopeForContext(contextSelectionFromItems([{ kind: 'category', categoryKey: 'health' }, { kind: 'life' }])),
  { kind: 'life' }
)
assert.equal(includesLifeContext(nested), true)
assert.equal(includesLifeContext(twoCategories), false)

// Project resolution: stack order, deduped, unknown ids dropped.
const projects = [
  { id: 'p1', name: 'Health' },
  { id: 'p2', name: 'Finances' },
  { id: 'p3', name: 'Training' },
]
const stackOfTwoProjectsPlusCategory = contextSelectionFromItems([
  { kind: 'project', projectId: 'p2' },
  { kind: 'project', projectId: 'p1' },
  { kind: 'project', projectId: 'p2' },
  { kind: 'project', projectId: 'ghost' },
  { kind: 'category', categoryKey: 'health' },
])
assert.deepEqual(stackedProjectIds(stackOfTwoProjectsPlusCategory), ['p2', 'p1', 'ghost'])
assert.deepEqual(
  resolveStackedProjects(stackOfTwoProjectsPlusCategory, projects).map((p) => p.name),
  ['Finances', 'Health']
)

// Mirrors the block order buildSystemMessages emits for a stacked selection:
// stack summary, then one block per project (plus its analysis block), then memory.
function planBlockLabels(context, allProjects, memoryMode) {
  const items = flattenContextSelection(context)
  const resolved = resolveStackedProjects(context, allProjects)
  const labels = []
  if (items.length > 1) labels.push('Context stack')
  for (const project of resolved) {
    labels.push(project.name)
    if (project.hasAnalysis) labels.push(`${project.name} Analysis`)
  }
  if (memoryMode !== 'anonymous' && flattenContextSelection(memoryScopeForContext(context)).length > 0) {
    labels.push(memoryMode === 'abridged' ? 'Memory (abridged)' : 'Memory')
  }
  return labels
}

const analysedProjects = [
  { id: 'p1', name: 'Health', hasAnalysis: false },
  { id: 'p2', name: 'Finances', hasAnalysis: true },
  { id: 'p3', name: 'Training', hasAnalysis: false },
]
assert.deepEqual(
  planBlockLabels(stackOfTwoProjectsPlusCategory, analysedProjects, 'detailed'),
  ['Context stack', 'Finances', 'Finances Analysis', 'Health', 'Memory']
)
assert.deepEqual(
  planBlockLabels({ kind: 'project', projectId: 'p1' }, analysedProjects, 'detailed'),
  ['Health', 'Memory']
)
assert.deepEqual(planBlockLabels({ kind: 'none' }, analysedProjects, 'anonymous'), [])
assert.deepEqual(planBlockLabels({ kind: 'none' }, analysedProjects, 'detailed'), ['Memory'])

console.log('context stack tests passed')
