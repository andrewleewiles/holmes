import {
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHexagonNodes, faMagnifyingGlass, faXmark, faCheck, faImage } from '@fortawesome/free-solid-svg-icons'
import { modelAcceptsImages, type ModelInfo } from '@shared/types'
import { PILL_TRIGGER_CLASS, PillCaret } from './PillDropdown'

interface ModelSelectorProps {
  models: ModelInfo[]
  selectedModel: string
  onSelect: (modelId: string) => void
  disabled?: boolean
}

/**
 * Recently picked models, newest first. Shared by every selector in the app and
 * always intersected with the list the selector was handed, so the vision-only
 * pickers in Settings never surface a text model they can't offer.
 */
const RECENTS_KEY = 'holmes.recentModels'
const RECENTS_SHOWN = 4
const PANEL_HEIGHT = 420

function readRecents(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENTS_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rememberRecent(id: string) {
  try {
    const next = [id, ...readRecents().filter((v) => v !== id)].slice(0, 12)
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Private-mode / quota failures cost us the history, nothing more.
  }
}

/** Strips the "Anthropic: " style prefix OpenRouter puts on display names. */
function displayName(name: string): string {
  const idx = name.indexOf(': ')
  return idx >= 0 ? name.slice(idx + 2) : name
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M ctx`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`
  return `${tokens} ctx`
}

/** Prices arrive as USD per token; humans read them per million. */
function formatPrice(perToken: number): string {
  const perMillion = perToken * 1_000_000
  if (perMillion === 0) return '0'
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`
  return `$${perMillion.toFixed(2)}`
}

function priceLabel(model: ModelInfo): string | null {
  if (model.free) return null
  const { promptPrice, completionPrice } = model
  if (promptPrice === undefined && completionPrice === undefined) return null
  const inPrice = promptPrice === undefined ? '?' : formatPrice(promptPrice)
  const outPrice = completionPrice === undefined ? '?' : formatPrice(completionPrice)
  return `${inPrice} / ${outPrice} per M`
}

/**
 * Every search term has to land somewhere, so "claude sonnet" and "sonnet
 * claude" both work. Returns -1 when a term misses entirely.
 */
function scoreModel(model: ModelInfo, terms: string[]): number {
  const name = model.name.toLowerCase()
  const id = model.id.toLowerCase()
  const provider = model.provider.toLowerCase()
  let total = 0
  for (const term of terms) {
    if (name.startsWith(term) || id.startsWith(term)) total += 4
    else if (name.includes(term)) total += 3
    else if (id.includes(term)) total += 2
    else if (provider.includes(term)) total += 1
    else return -1
  }
  return total
}

type Row =
  | { kind: 'header'; key: string; label: string; count?: number }
  | { kind: 'model'; key: string; model: ModelInfo }

export const ModelSelector: FC<ModelSelectorProps> = ({
  models,
  selectedModel,
  onSelect,
  disabled,
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [visionOnly, setVisionOnly] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [activeRow, setActiveRow] = useState(-1)
  const [placement, setPlacement] = useState<{ up: boolean; right: boolean }>({ up: false, right: false })
  const [recentIds, setRecentIds] = useState<string[]>([])

  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!open) return
    setSearch('')
    setFreeOnly(false)
    setVisionOnly(false)
    setSelectedProvider(null)
    setRecentIds(readRecents())
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  // Flip the panel above the pill when the composer sits near the bottom of the
  // window, and right-align it when it would run off the edge.
  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const below = window.innerHeight - rect.bottom
    setPlacement({
      up: below < PANEL_HEIGHT && rect.top > below,
      right: rect.left + 384 > window.innerWidth - 8,
    })
  }, [open])

  const anyVision = useMemo(() => models.some(modelAcceptsImages), [models])

  const providers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1)
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([provider]) => provider)
  }, [models])

  const terms = useMemo(
    () => search.toLowerCase().split(/\s+/).filter(Boolean),
    [search]
  )
  const filtering = terms.length > 0 || freeOnly || visionOnly || selectedProvider !== null

  const filtered = useMemo(() => {
    let result = models
    if (freeOnly) result = result.filter((m) => m.free)
    if (visionOnly) result = result.filter(modelAcceptsImages)
    if (selectedProvider) result = result.filter((m) => m.provider === selectedProvider)
    if (terms.length === 0) return result
    return result
      .map((model) => ({ model, score: scoreModel(model, terms) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.model)
  }, [models, terms, freeOnly, visionOnly, selectedProvider])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    if (!filtering) {
      const byId = new Map(models.map((m) => [m.id, m]))
      const recent = recentIds
        .map((id) => byId.get(id))
        .filter((m): m is ModelInfo => Boolean(m))
        .slice(0, RECENTS_SHOWN)
      if (recent.length > 0) {
        out.push({ kind: 'header', key: 'h:recent', label: 'Recent' })
        for (const model of recent) out.push({ kind: 'model', key: `recent:${model.id}`, model })
      }
      const grouped = new Map<string, ModelInfo[]>()
      for (const model of filtered) {
        const bucket = grouped.get(model.provider)
        if (bucket) bucket.push(model)
        else grouped.set(model.provider, [model])
      }
      for (const provider of providers) {
        const bucket = grouped.get(provider)
        if (!bucket) continue
        out.push({ kind: 'header', key: `h:${provider}`, label: provider, count: bucket.length })
        for (const model of bucket) out.push({ kind: 'model', key: model.id, model })
      }
      return out
    }
    for (const model of filtered) out.push({ kind: 'model', key: model.id, model })
    return out
  }, [filtering, filtered, models, providers, recentIds])

  const modelRowIndices = useMemo(() => {
    const indices: number[] = []
    rows.forEach((row, i) => {
      if (row.kind === 'model') indices.push(i)
    })
    return indices
  }, [rows])

  // Open on the current model; every filter change re-anchors to the top hit.
  useEffect(() => {
    if (!open) {
      setActiveRow(-1)
      return
    }
    const current = rows.findIndex((row) => row.kind === 'model' && row.model.id === selectedModel)
    setActiveRow(filtering ? (modelRowIndices[0] ?? -1) : current >= 0 ? current : (modelRowIndices[0] ?? -1))
  }, [open, filtering, rows, modelRowIndices, selectedModel])

  useEffect(() => {
    if (!open || activeRow < 0) return
    listRef.current
      ?.querySelector(`[data-row="${activeRow}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeRow])

  const commit = useCallback(
    (modelId: string) => {
      rememberRecent(modelId)
      onSelect(modelId)
      setOpen(false)
      triggerRef.current?.focus()
    },
    [onSelect]
  )

  // Functional update so a held-down arrow key can't act on a stale row.
  const moveActive = (delta: number) => {
    if (modelRowIndices.length === 0) return
    setActiveRow((current) => {
      const pos = modelRowIndices.indexOf(current)
      const next = pos < 0 ? (delta > 0 ? 0 : modelRowIndices.length - 1) : pos + delta
      return modelRowIndices[(next + modelRowIndices.length) % modelRowIndices.length]
    })
  }

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveRow(modelRowIndices[0] ?? -1)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveRow(modelRowIndices[modelRowIndices.length - 1] ?? -1)
    } else if (e.key === 'Enter') {
      const row = rows[activeRow]
      if (row?.kind === 'model') {
        e.preventDefault()
        commit(row.model.id)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const selected = models.find((m) => m.id === selectedModel)

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={PILL_TRIGGER_CLASS}
        title={selected ? `${selected.name} — ${selected.id}` : selectedModel || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FontAwesomeIcon icon={faHexagonNodes} className="w-4 h-4 text-white/90 shrink-0" />
        <span className="max-w-[200px] truncate">
          {selected ? displayName(selected.name) : selectedModel || 'Select model'}
        </span>
        {selected?.free && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium shrink-0">
            Free
          </span>
        )}
        <PillCaret />
      </button>

      {open && (
        <div
          onKeyDown={handleKeyDown}
          className={`absolute ${placement.up ? 'bottom-full mb-1' : 'top-full mt-1'} ${
            placement.right ? 'right-0' : 'left-0'
          } w-96 max-w-[calc(100vw-2rem)] bg-holmes-surface border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden`}
          style={{ maxHeight: PANEL_HEIGHT }}
        >
          <div className="p-2.5 border-b border-white/10 space-y-2">
            <div className="relative">
              <FontAwesomeIcon
                icon={faMagnifyingGlass}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-white/30"
              />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, id or provider..."
                className="w-full bg-white/10 border border-white/10 rounded-lg pl-7 pr-7 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-white/30"
              />
              {search && (
                <button
                  onClick={() => {
                    setSearch('')
                    searchRef.current?.focus()
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  aria-label="Clear search"
                >
                  <FontAwesomeIcon icon={faXmark} className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="relative">
              <div className="flex items-center gap-1 overflow-x-auto scrollbar-thin pb-0.5">
                <FilterChip active={freeOnly} onClick={() => setFreeOnly(!freeOnly)}>
                  Free
                </FilterChip>
                {anyVision && (
                  <FilterChip active={visionOnly} onClick={() => setVisionOnly(!visionOnly)}>
                    Vision
                  </FilterChip>
                )}
                {providers.length > 1 && <div className="w-px self-stretch bg-white/10 shrink-0 mx-0.5" />}
                {providers.length > 1 &&
                  providers.map((p) => (
                    <FilterChip
                      key={p}
                      active={selectedProvider === p}
                      onClick={() => setSelectedProvider(selectedProvider === p ? null : p)}
                    >
                      {p}
                    </FilterChip>
                  ))}
              </div>
              {/* The chip row scrolls sideways; the fade is the only hint it does. */}
              {providers.length > 4 && (
                <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-holmes-surface to-transparent" />
              )}
            </div>
          </div>

          <div ref={listRef} className="overflow-y-auto flex-1 scrollbar-thin" role="listbox">
            {rows.length === 0 ? (
              <div className="px-4 py-6 text-xs text-white/40 text-center">
                {models.length === 0
                  ? 'No models available. Check your API key in Settings.'
                  : 'No models match your filters.'}
              </div>
            ) : (
              rows.map((row, index) =>
                row.kind === 'header' ? (
                  <div
                    key={row.key}
                    className="sticky top-0 z-10 flex items-center gap-2 bg-holmes-surface/95 backdrop-blur px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-white/35"
                  >
                    <span className="truncate">{row.label}</span>
                    {row.count !== undefined && <span className="text-white/20">{row.count}</span>}
                  </div>
                ) : (
                  <ModelRow
                    key={row.key}
                    index={index}
                    model={row.model}
                    selected={row.model.id === selectedModel}
                    active={index === activeRow}
                    onHover={() => setActiveRow(index)}
                    onClick={() => commit(row.model.id)}
                  />
                )
              )
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-1.5 text-[10px] text-white/30">
            <span>
              {filtering ? `${filtered.length} of ${models.length}` : `${models.length}`} model
              {models.length === 1 ? '' : 's'}
            </span>
            <span className="shrink-0">↑↓ navigate · ↵ select · esc close</span>
          </div>
        </div>
      )}
    </div>
  )
}

const FilterChip: FC<{ active: boolean; onClick: () => void; children: ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    onClick={onClick}
    className={`shrink-0 text-[10px] px-2 py-1 rounded-full transition-colors cursor-pointer whitespace-nowrap ${
      active
        ? 'bg-holmes-primary/30 text-holmes-primary-light'
        : 'bg-white/10 text-white/50 hover:bg-white/20 hover:text-white/80'
    }`}
  >
    {children}
  </button>
)

const ModelRow: FC<{
  index: number
  model: ModelInfo
  selected: boolean
  active: boolean
  onHover: () => void
  onClick: () => void
}> = ({ index, model, selected, active, onHover, onClick }) => {
  const price = priceLabel(model)
  return (
    <button
      data-row={index}
      role="option"
      aria-selected={selected}
      onMouseMove={onHover}
      onClick={onClick}
      className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer ${
        active ? 'bg-white/[0.07]' : ''
      } ${selected ? 'text-holmes-primary-light' : 'text-white/75'}`}
    >
      <div className="flex items-center gap-2">
        {selected ? (
          <FontAwesomeIcon icon={faCheck} className="w-3 h-3 shrink-0 text-holmes-primary-light" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="font-medium truncate">{displayName(model.name)}</span>
        {modelAcceptsImages(model) && (
          <FontAwesomeIcon
            icon={faImage}
            className="w-2.5 h-2.5 shrink-0 text-white/30"
            title="Accepts image input"
          />
        )}
        {model.free && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium shrink-0">
            Free
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-5 text-[11px] text-white/35">
        <span className="truncate">{model.id}</span>
        <span className="flex-1" />
        {model.contextLength !== undefined && (
          <span className="shrink-0">{formatContext(model.contextLength)}</span>
        )}
        {price && <span className="shrink-0 tabular-nums">{price}</span>}
      </div>
    </button>
  )
}
