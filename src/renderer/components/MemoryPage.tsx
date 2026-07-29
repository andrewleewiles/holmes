import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCheck,
  faDatabase,
  faHardDrive,
  faLock,
  faLockOpen,
  faMagnifyingGlass,
  faPen,
  faPlus,
  faShieldHalved,
  faSpinner,
  faTrash,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import type {
  MemoryExtractionRequest,
  MemoryField,
  MemorySuggestion,
  MemoryUpdateRequest,
  MemoryValue,
  MemoryValueType,
} from '@shared/types'
import { MEMORY_CATALOG, MEMORY_CATEGORY_KEYS } from '@shared/memoryCatalog'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'

type FieldFilter = 'all' | 'filled' | 'empty' | 'locked'
const ALL_FIELDS_CATEGORY = '__all_fields__'

const MISSING_MEMORY_BRIDGE =
  'Memory is not loaded in the current Electron session. Fully quit and reopen Holmes to load the updated preload bridge.'

function formatValue(value: MemoryValue | null): string {
  if (value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function valueForEditor(value: MemoryValue | null, type: MemoryValueType): string {
  if (type === 'boolean') return value === null ? '' : value === true ? 'true' : 'false'
  if (value === null) return ''
  if (type === 'list' && Array.isArray(value)) return value.join('\n')
  return String(value)
}

function valueFromEditor(value: string, type: MemoryValueType): MemoryValue | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (type === 'number') {
    const number = Number(trimmed)
    if (!Number.isFinite(number)) throw new Error('Enter a valid number')
    return number
  }
  if (type === 'boolean') return trimmed === 'true'
  if (type === 'list') {
    return [...new Set(trimmed.split('\n').map((item) => item.trim()).filter(Boolean))]
  }
  return trimmed
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Memory operation failed'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

interface MemoryFieldCardProps {
  field: MemoryField
  onUpdate: (request: MemoryUpdateRequest) => Promise<void>
  onDelete: (fieldId: string) => Promise<void>
}

const MemoryFieldCard: FC<MemoryFieldCardProps> = ({ field, onUpdate, onDelete }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(valueForEditor(field.value, field.valueType))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) setDraft(valueForEditor(field.value, field.valueType))
  }, [field.value, field.valueType, editing])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onUpdate({
        fieldId: field.id,
        value: valueFromEditor(draft, field.valueType),
        locked: field.locked,
        expectedRevision: field.revision,
      })
      setEditing(false)
    } catch (saveError) {
      setError(cleanError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const toggleLock = async () => {
    setSaving(true)
    setError(null)
    try {
      await onUpdate({
        fieldId: field.id,
        value: field.value,
        locked: !field.locked,
        expectedRevision: field.revision,
      })
    } catch (lockError) {
      setError(cleanError(lockError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className={`rounded-xl border bg-holmes-surface p-4 transition-colors ${
      field.locked ? 'border-holmes-primary/25' : 'border-white/[0.08]'
    }`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-xs font-medium text-white/65">{field.label}</h3>
            {field.sensitive && (
              <span title="Sensitive field" className="text-[9px] text-amber-200/45">
                <FontAwesomeIcon icon={faShieldHalved} />
              </span>
            )}
            {field.custom && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-white/25">Custom</span>
            )}
          </div>

          {editing ? (
            <div className="mt-2">
              {field.valueType === 'boolean' ? (
                <select
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={saving}
                  className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none focus:border-holmes-primary/40"
                >
                  <option value="">Not set</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : field.valueType === 'multiline' || field.valueType === 'list' ? (
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={field.valueType === 'multiline' ? 4 : 3}
                  disabled={saving}
                  placeholder={field.valueType === 'list' ? 'One item per line' : 'Enter a value'}
                  className="w-full resize-none rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs leading-relaxed text-white/70 outline-none placeholder:text-white/20 focus:border-holmes-primary/40"
                />
              ) : (
                <input
                  type={field.valueType === 'date' ? 'date' : field.valueType === 'number' ? 'number' : 'text'}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={saving}
                  className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20 focus:border-holmes-primary/40"
                />
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="rounded-md bg-holmes-primary px-3 py-1.5 text-[10px] font-medium text-white disabled:opacity-50 cursor-pointer"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false)
                    setError(null)
                    setDraft(valueForEditor(field.value, field.valueType))
                  }}
                  disabled={saving}
                  className="px-2 py-1.5 text-[10px] text-white/35 hover:text-white/60 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2">
              {field.value === null ? (
                <button
                  onClick={() => setEditing(true)}
                  className="text-left text-xs italic text-white/20 hover:text-holmes-primary-light/70 cursor-pointer"
                >
                  Add information
                </button>
              ) : (
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-white/55">{formatValue(field.value)}</p>
              )}
            </div>
          )}
        </div>

        {!editing && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => setEditing(true)}
              disabled={saving}
              title="Edit field"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] text-white/25 hover:bg-white/5 hover:text-white/60 cursor-pointer"
            >
              <FontAwesomeIcon icon={faPen} />
            </button>
            <button
              onClick={() => void toggleLock()}
              disabled={saving}
              title={field.locked ? 'Unlock field' : 'Lock against auto-fill'}
              className={`flex h-7 w-7 items-center justify-center rounded-md text-[10px] hover:bg-white/5 cursor-pointer ${
                field.locked ? 'text-holmes-primary-light' : 'text-white/25 hover:text-white/60'
              }`}
            >
              <FontAwesomeIcon icon={field.locked ? faLock : faLockOpen} />
            </button>
            {field.custom && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete the custom field "${field.label}"?`)) void onDelete(field.id)
                }}
                disabled={saving}
                title="Delete custom field"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] text-white/20 hover:bg-red-400/10 hover:text-red-300 cursor-pointer"
              >
                <FontAwesomeIcon icon={faTrash} />
              </button>
            )}
          </div>
        )}
      </div>

      {field.value !== null && !editing && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/[0.05] pt-2.5 text-[9px] text-white/20">
          <span>{field.origin === 'manual' ? 'Entered by you' : 'Auto-filled'}</span>
          {field.confidence !== null && <span>{Math.round(field.confidence * 100)}% confidence</span>}
          {field.sources.slice(0, 2).map((source) => (
            <span key={`${source.type}-${source.reference}`} title={source.label} className="max-w-36 truncate rounded-full bg-white/[0.04] px-2 py-0.5 text-white/25">
              {source.label}
            </span>
          ))}
          {field.sources.length > 2 && <span>+{field.sources.length - 2} sources</span>}
        </div>
      )}
      {error && <p className="mt-2 text-[10px] text-red-300/75">{error}</p>}
    </article>
  )
}

export const MemoryPage: FC = () => {
  const { name: assistantName } = useAssistantIdentity()
  const [fields, setFields] = useState<MemoryField[]>([])
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([])
  const [activeCategory, setActiveCategory] = useState(MEMORY_CATALOG[0].key)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FieldFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAutoFill, setShowAutoFill] = useState(false)
  const [showAddField, setShowAddField] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const extractingRef = useRef(false)

  const [selectedCategories, setSelectedCategories] = useState<string[]>([...MEMORY_CATEGORY_KEYS])
  const [includeConversations, setIncludeConversations] = useState(true)
  const [includeProjects, setIncludeProjects] = useState(true)
  const [includeRecallFiles, setIncludeRecallFiles] = useState(false)
  const [includeIMessages, setIncludeIMessages] = useState(true)
  const [includeSettings, setIncludeSettings] = useState(true)
  const [includeSensitive, setIncludeSensitive] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  const [newLabel, setNewLabel] = useState('')
  const [newCategory, setNewCategory] = useState(MEMORY_CATALOG[0].key)
  const [newType, setNewType] = useState<MemoryValueType>('text')
  const [newSensitive, setNewSensitive] = useState(false)

  useEffect(() => {
    const memory = window.electronAPI.memory
    if (!memory) {
      setError(MISSING_MEMORY_BRIDGE)
      setLoading(false)
      return
    }
    Promise.all([memory.list(), memory.suggestions()])
      .then(([loadedFields, loadedSuggestions]) => {
        setFields(loadedFields)
        setSuggestions(loadedSuggestions)
      })
      .catch((loadError) => setError(cleanError(loadError)))
      .finally(() => setLoading(false))
    return () => {
      if (extractingRef.current) void memory.abort()
    }
  }, [])

  const updateField = async (request: MemoryUpdateRequest) => {
    const updated = await window.electronAPI.memory.update(request)
    setFields(updated)
    try {
      setSuggestions(await window.electronAPI.memory.suggestions())
    } catch {
      setError('Memory field saved, but the suggestion list could not be refreshed.')
    }
  }

  const deleteField = async (fieldId: string) => {
    try {
      setFields(await window.electronAPI.memory.deleteField(fieldId))
      try {
        setSuggestions(await window.electronAPI.memory.suggestions())
      } catch {
        setError('Custom field deleted, but the suggestion list could not be refreshed.')
      }
    } catch (deleteError) {
      setError(cleanError(deleteError))
    }
  }

  const runAutoFill = async () => {
    if (!confirmed || selectedCategories.length === 0) return
    setExtracting(true)
    extractingRef.current = true
    setError(null)
    setNotice(null)
    try {
      const request: MemoryExtractionRequest = {
        categories: selectedCategories,
        includeConversations,
        includeProjects,
        includeRecallFiles,
        includeIMessages,
        includeSettings,
        includeSensitive,
        confirmExternalProcessing: true,
      }
      const result = await window.electronAPI.memory.extract(request)
      const previousValues = new Map(fields.map((field) => [field.id, field.value]))
      const newlyFilled = result.fields.filter((field) => (
        field.value !== null && previousValues.get(field.id) === null
      ))
      setFields(result.fields)
      setSuggestions(result.suggestions)
      if (newlyFilled.length > 0) {
        setActiveCategory(ALL_FIELDS_CATEGORY)
        setFilter('filled')
        setQuery('')
      }
      const filledLabels = newlyFilled.slice(0, 5).map((field) => field.label).join(', ')
      const additionalLabelCount = Math.max(0, newlyFilled.length - 5)
      const sourceCount = Object.values(result.sourceCounts).reduce((sum, count) => sum + (count || 0), 0)
      setNotice(
        `Analyzed ${sourceCount} source excerpts and found ${result.candidatesFound} supported facts. Auto-filled ${result.autoFilled} fields and created ${result.suggestionsCreated} review suggestions${
          filledLabels ? `: ${filledLabels}${additionalLabelCount ? `, and ${additionalLabelCount} more` : ''}` : ''
        }${result.contextTruncated ? '. Some source content was truncated to fit the context limit.' : '.'}`
      )
      setShowAutoFill(false)
      setConfirmed(false)
    } catch (extractionError) {
      setError(cleanError(extractionError))
    } finally {
      extractingRef.current = false
      setExtracting(false)
    }
  }

  const reviewSuggestion = async (
    suggestion: MemorySuggestion,
    decision: 'accept' | 'reject',
    applyAsMerge?: boolean
  ) => {
    const field = fields.find((candidate) => candidate.id === suggestion.fieldId)
    if (!field) return
    const confirmOverwriteManual = decision === 'accept' && field.origin === 'manual'
      ? window.confirm(`Replace the value you entered for "${field.label}" with the suggested value?`)
      : false
    if (decision === 'accept' && field.origin === 'manual' && !confirmOverwriteManual) return
    try {
      const result = await window.electronAPI.memory.reviewSuggestion({
        suggestionId: suggestion.id,
        decision,
        expectedRevision: field.revision,
        ...(confirmOverwriteManual ? { confirmOverwriteManual: true } : {}),
        ...(applyAsMerge ? { applyAsMerge: true } : {}),
      })
      setFields(result.fields)
      setSuggestions(result.suggestions)
    } catch (reviewError) {
      setError(cleanError(reviewError))
    }
  }

  const createField = async () => {
    if (!newLabel.trim()) return
    try {
      setFields(await window.electronAPI.memory.createField({
        category: newCategory,
        label: newLabel.trim(),
        valueType: newType,
        sensitive: newSensitive,
      }))
      setNewLabel('')
      setNewType('text')
      setNewSensitive(false)
      setShowAddField(false)
    } catch (createError) {
      setError(cleanError(createError))
    }
  }

  const closeAutoFill = () => {
    setShowAutoFill(false)
    setConfirmed(false)
  }

  const filledCount = fields.filter((field) => field.value !== null).length
  const lockedCount = fields.filter((field) => field.locked).length
  const showingAllFields = activeCategory === ALL_FIELDS_CATEGORY
  const category = showingAllFields
    ? { key: ALL_FIELDS_CATEGORY, label: 'All fields', description: 'Review Memory across every category.' }
    : MEMORY_CATALOG.find((candidate) => candidate.key === activeCategory) || MEMORY_CATALOG[0]
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleFields = fields.filter((field) => {
    if (!showingAllFields && field.category !== activeCategory) return false
    if (filter === 'filled' && field.value === null) return false
    if (filter === 'empty' && field.value !== null) return false
    if (filter === 'locked' && !field.locked) return false
    if (!normalizedQuery) return true
    return field.label.toLocaleLowerCase().includes(normalizedQuery) ||
      formatValue(field.value).toLocaleLowerCase().includes(normalizedQuery)
  })

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faHardDrive} className={PAGE_HEADER_ICON} />}
        title="Memory"
        actions={
          <>
            <button
              onClick={() => {
                setNewCategory(showingAllFields ? MEMORY_CATALOG[0].key : category.key)
                setShowAddField(true)
              }}
              className="flex h-[30px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 cursor-pointer"
            >
              <FontAwesomeIcon icon={faPlus} className="text-[13px]" /> Add field
            </button>
            <button
              onClick={() => {
                setConfirmed(false)
                setShowAutoFill(true)
              }}
              className="flex h-[30px] items-center gap-2 rounded-md bg-holmes-primary px-3 text-[13px] font-medium text-white transition-colors hover:bg-holmes-primary-light cursor-pointer"
            >
              <FontAwesomeIcon icon={faWandMagicSparkles} className="text-[13px]" /> Auto-fill Memory
            </button>
          </>
        }
      />

      <div className="mx-auto w-full max-w-7xl p-6 sm:p-8">
        <p className="max-w-2xl text-xs leading-relaxed text-white/40">
          A modifiable hub for the facts, preferences, routines, relationships, and context {assistantName} knows about you.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['Fields', fields.length],
            ['Filled', filledCount],
            ['Locked', lockedCount],
            ['Needs review', suggestions.length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/[0.07] bg-holmes-surface px-4 py-3">
              <div className="text-lg font-medium tabular-nums text-white/70">{value}</div>
              <div className="text-[9px] uppercase tracking-wider text-white/25">{label}</div>
            </div>
          ))}
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-xs text-red-100/70">
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-100/35 hover:text-red-100 cursor-pointer">Dismiss</button>
          </div>
        )}
        {notice && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-holmes-primary/20 bg-holmes-primary/[0.07] p-3 text-xs text-holmes-primary-light/70">
            <FontAwesomeIcon icon={faCheck} className="mt-0.5" />
            <span className="min-w-0 flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="text-white/30 hover:text-white/60 cursor-pointer">Dismiss</button>
          </div>
        )}

        {suggestions.length > 0 && (
          <section className="mt-5 rounded-2xl border border-amber-300/15 bg-amber-300/[0.04] p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium text-amber-100/70 font-serif-display">Review Memory suggestions</h2>
                <p className="mt-0.5 text-[10px] text-white/30">Auto-fill found values that differ from existing information.</p>
              </div>
              <span className="rounded-full bg-amber-300/10 px-2 py-1 text-[10px] text-amber-100/60">{suggestions.length}</span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
              {suggestions.map((suggestion) => {
                const field = fields.find((candidate) => candidate.id === suggestion.fieldId)
                const canMerge = suggestion.mergeStrategy === 'merge' || suggestion.mergeStrategy === 'supplement'
                const strategyLabel = suggestion.mergeStrategy === 'merge'
                  ? 'Merge with existing'
                  : suggestion.mergeStrategy === 'supplement'
                    ? 'Add to existing'
                    : 'Replace existing'
                return (
                  <div key={suggestion.id} className="rounded-xl border border-white/[0.07] bg-black/10 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wider text-white/25">{suggestion.fieldLabel}</span>
                          <span className={`rounded-full px-1.5 py-0.5 text-[8px] uppercase tracking-wider ${
                            suggestion.mergeStrategy === 'replace'
                              ? 'bg-amber-300/10 text-amber-100/50'
                              : 'bg-holmes-primary/10 text-holmes-primary-light/60'
                          }`}>{strategyLabel}</span>
                        </div>
                        <div className="mt-1 text-xs text-white/65">{formatValue(suggestion.value)}</div>
                        {field?.value !== null && field?.value !== undefined && (
                          <div className="mt-1 truncate text-[10px] text-white/25">Current: {formatValue(field.value)}</div>
                        )}
                      </div>
                      <div className="text-[10px] text-amber-100/50">{Math.round(suggestion.confidence * 100)}%</div>
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-white/30">{suggestion.rationale}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {suggestion.sources.slice(0, 3).map((source) => (
                        <span key={`${suggestion.id}-${source.reference}`} className="max-w-40 truncate rounded-full bg-white/[0.04] px-2 py-0.5 text-[9px] text-white/25" title={source.label}>
                          {source.label}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {canMerge ? (
                        <>
                          <button
                            onClick={() => void reviewSuggestion(suggestion, 'accept', true)}
                            disabled={field?.locked}
                            className="rounded-md bg-holmes-primary/15 px-2.5 py-1.5 text-[10px] text-holmes-primary-light hover:bg-holmes-primary/25 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                          >
                            Merge
                          </button>
                          <button
                            onClick={() => void reviewSuggestion(suggestion, 'accept', false)}
                            disabled={field?.locked}
                            className="rounded-md bg-white/5 px-2.5 py-1.5 text-[10px] text-white/40 hover:bg-white/10 hover:text-white/60 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                          >
                            Replace
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => void reviewSuggestion(suggestion, 'accept')}
                          disabled={field?.locked}
                          className="rounded-md bg-holmes-primary/15 px-2.5 py-1.5 text-[10px] text-holmes-primary-light hover:bg-holmes-primary/25 disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                        >
                          Accept
                        </button>
                      )}
                      <button
                        onClick={() => void reviewSuggestion(suggestion, 'reject')}
                        className="px-2.5 py-1.5 text-[10px] text-white/30 hover:text-white/60 cursor-pointer"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-2.5 text-[10px] text-white/25" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Memory fields..."
              className="w-full rounded-lg border border-white/10 bg-holmes-surface py-2 pl-8 pr-3 text-xs text-white/65 outline-none placeholder:text-white/20 focus:border-holmes-primary/35"
            />
          </div>
          <div className="flex rounded-lg border border-white/10 bg-holmes-surface p-0.5">
            {(['all', 'filled', 'empty', 'locked'] as FieldFilter[]).map((value) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`rounded-md px-2.5 py-1.5 text-[10px] capitalize transition-colors cursor-pointer ${
                  filter === value ? 'bg-white/10 text-white/65' : 'text-white/25 hover:text-white/45'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-[190px_minmax(0,1fr)]">
          <nav className="flex gap-1 overflow-x-auto md:block md:space-y-0.5" aria-label="Memory categories">
            <button
              onClick={() => setActiveCategory(ALL_FIELDS_CATEGORY)}
              className={`flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors cursor-pointer md:w-full ${
                showingAllFields
                  ? 'bg-holmes-primary/10 text-holmes-primary-light'
                  : 'text-white/35 hover:bg-white/[0.04] hover:text-white/60'
              }`}
            >
              <span>All fields</span>
              <span className="text-[9px] tabular-nums opacity-50">{filledCount}/{fields.length}</span>
            </button>
            {MEMORY_CATALOG.map((item) => {
              const categoryFields = fields.filter((field) => field.category === item.key)
              const categoryFilled = categoryFields.filter((field) => field.value !== null).length
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveCategory(item.key)}
                  className={`flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition-colors cursor-pointer md:w-full ${
                    activeCategory === item.key
                      ? 'bg-holmes-primary/10 text-holmes-primary-light'
                      : 'text-white/35 hover:bg-white/[0.04] hover:text-white/60'
                  }`}
                >
                  <span>{item.label}</span>
                  <span className="text-[9px] tabular-nums opacity-50">{categoryFilled}/{categoryFields.length}</span>
                </button>
              )
            })}
          </nav>

          <main className="min-w-0">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium text-white/70 font-serif-display">{category.label}</h2>
                <p className="mt-0.5 text-[10px] text-white/25">{category.description}</p>
              </div>
              <button
                onClick={() => {
                  setNewCategory(showingAllFields ? MEMORY_CATALOG[0].key : category.key)
                  setShowAddField(true)
                }}
                className="text-[10px] text-white/25 hover:text-holmes-primary-light cursor-pointer"
              >
                + Custom field
              </button>
            </div>

            {loading ? (
              <div className="rounded-xl border border-white/[0.07] bg-holmes-surface p-8 text-center text-xs text-white/30">
                <FontAwesomeIcon icon={faSpinner} spin className="mr-2" /> Loading Memory...
              </div>
            ) : visibleFields.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-xs text-white/25">No fields match this view.</div>
            ) : (
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                {visibleFields.map((field) => (
                  <MemoryFieldCard key={field.id} field={field} onUpdate={updateField} onDelete={deleteField} />
                ))}
              </div>
            )}
          </main>
        </div>

        <p className="mt-8 border-t border-white/[0.05] pt-4 text-[9px] leading-relaxed text-white/20">
          Memory values and suggestions are stored locally in the Holmes SQLite database, which is not encrypted. Do not store passwords, API keys, authentication tokens, payment security codes, bank account numbers, or government identification numbers.
        </p>
      </div>

      {showAutoFill && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] p-5">
              <div>
                <h2 className="flex items-center gap-2 text-base font-medium text-white/80 font-serif-display">
                  <FontAwesomeIcon icon={faWandMagicSparkles} className="text-holmes-primary" /> Auto-fill Memory
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/35">Choose the local sources and categories Holmes may analyze.</p>
              </div>
              {!extracting && <button onClick={closeAutoFill} className="text-white/30 hover:text-white/60 cursor-pointer"><FontAwesomeIcon icon={faXmark} /></button>}
            </div>

            <div className="space-y-5 p-5">
              <div>
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35">Data sources</h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {[
                    ['Conversations', 'Recall-ranked matches across your messages only', includeConversations, setIncludeConversations],
                    ['Projects', 'Recall-ranked excerpts from selected project documents and analyses', includeProjects, setIncludeProjects],
                    ['Entire filesystem', 'Spotlight-ranked excerpts from files anywhere on this Mac', includeRecallFiles, setIncludeRecallFiles],
                    ['iMessage metadata', 'Contact names and aggregate activity, not message bodies', includeIMessages, setIncludeIMessages],
                    ['Account and settings', 'OS account, timezone, models, and non-secret preferences', includeSettings, setIncludeSettings],
                  ].map(([label, description, checked, setter]) => (
                    <label key={String(label)} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-black/10 p-3">
                      <input
                        type="checkbox"
                        checked={checked as boolean}
                        onChange={(event) => {
                          (setter as (value: boolean) => void)(event.target.checked)
                          setConfirmed(false)
                        }}
                        disabled={extracting}
                        className="mt-0.5 accent-holmes-primary"
                      />
                      <span>
                        <span className="block text-xs text-white/60">{label as string}</span>
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-white/25">{description as string}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35">Categories</h3>
                  <button
                    onClick={() => {
                      setSelectedCategories(
                        selectedCategories.length === MEMORY_CATEGORY_KEYS.length ? [] : [...MEMORY_CATEGORY_KEYS]
                      )
                      setConfirmed(false)
                    }}
                    disabled={extracting}
                    className="text-[10px] text-holmes-primary-light/60 hover:text-holmes-primary-light cursor-pointer"
                  >
                    {selectedCategories.length === MEMORY_CATEGORY_KEYS.length ? 'Clear all' : 'Select all'}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {MEMORY_CATALOG.map((item) => {
                    const selected = selectedCategories.includes(item.key)
                    return (
                      <button
                        key={item.key}
                        onClick={() => {
                          setSelectedCategories((current) => selected
                            ? current.filter((key) => key !== item.key)
                            : [...current, item.key])
                          setConfirmed(false)
                        }}
                        disabled={extracting}
                        className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors cursor-pointer ${
                          selected
                            ? 'border-holmes-primary/30 bg-holmes-primary/10 text-holmes-primary-light'
                            : 'border-white/[0.07] text-white/25'
                        }`}
                      >
                        {item.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3">
                <input
                  type="checkbox"
                  checked={includeSensitive}
                  onChange={(event) => {
                    setIncludeSensitive(event.target.checked)
                    setConfirmed(false)
                  }}
                  disabled={extracting}
                  className="mt-0.5 accent-holmes-primary"
                />
                <span>
                  <span className="block text-xs text-amber-100/65">Include sensitive fields</span>
                  <span className="mt-0.5 block text-[10px] leading-relaxed text-white/30">Allows extraction into health, financial, contact, location, and third-party relationship fields.</span>
                </span>
              </label>

              <div className="rounded-xl border border-white/[0.07] bg-black/10 p-4 text-[10px] leading-relaxed text-white/35">
                <div className="mb-2 flex items-center gap-2 text-white/55"><FontAwesomeIcon icon={faDatabase} className="text-holmes-primary" /> Processing disclosure</div>
                Holmes will locally redact common credentials and payment identifiers, then send bounded excerpts from the selected sources, field descriptions, and source labels to your configured AI provider. Entire filesystem uses macOS Spotlight and may search files outside Holmes projects. This may still include personal, contact, health, financial, relationship, and file information. iMessage supplies contact names, handles, and aggregate activity, not message bodies. Nothing replaces an existing value without review.
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-white/45">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={extracting}
                  className="mt-0.5 accent-holmes-primary"
                />
                I understand the selected excerpts will be sent to my configured AI provider and Memory is stored locally in an unencrypted database.
              </label>

              <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4">
                {extracting ? (
                  <>
                     <span className="mr-auto flex items-center gap-2 text-xs text-white/40"><FontAwesomeIcon icon={faSpinner} spin /> Searching selected sources and extracting facts...</span>
                    <button onClick={() => void window.electronAPI.memory.abort()} className="rounded-lg border border-red-300/15 px-3 py-2 text-xs text-red-200/60 cursor-pointer">Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={closeAutoFill} className="px-3 py-2 text-xs text-white/35 hover:text-white/60 cursor-pointer">Cancel</button>
                    <button
                      onClick={() => void runAutoFill()}
                      disabled={!confirmed || selectedCategories.length === 0 || !(includeConversations || includeProjects || includeRecallFiles || includeIMessages || includeSettings)}
                      className="rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                    >
                      Start auto-fill
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showAddField && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-holmes-surface p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-white/75 font-serif-display">Add custom field</h2>
              <button onClick={() => setShowAddField(false)} className="text-white/30 hover:text-white/60 cursor-pointer"><FontAwesomeIcon icon={faXmark} /></button>
            </div>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/30">Label</span>
              <input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} maxLength={100} autoFocus className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none focus:border-holmes-primary/40" />
            </label>
            <label className="mt-3 block">
              <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/30">Category</span>
              <select value={newCategory} onChange={(event) => setNewCategory(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/60 outline-none">
                {MEMORY_CATALOG.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
            <label className="mt-3 block">
              <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-white/30">Value type</span>
              <select value={newType} onChange={(event) => setNewType(event.target.value as MemoryValueType)} className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/60 outline-none">
                <option value="text">Short text</option>
                <option value="multiline">Long text</option>
                <option value="list">List</option>
                <option value="date">Date</option>
                <option value="number">Number</option>
                <option value="boolean">Yes or no</option>
              </select>
            </label>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-white/45">
              <input type="checkbox" checked={newSensitive} onChange={(event) => setNewSensitive(event.target.checked)} className="accent-holmes-primary" />
              Treat this field as sensitive
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowAddField(false)} className="px-3 py-2 text-xs text-white/35 cursor-pointer">Cancel</button>
              <button onClick={() => void createField()} disabled={!newLabel.trim()} className="rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-35 cursor-pointer">Add field</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
