import { type FC, useEffect, useRef, useState, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHexagonNodes } from '@fortawesome/free-solid-svg-icons'
import type { ModelInfo } from '@shared/types'

interface ModelSelectorProps {
  models: ModelInfo[]
  selectedModel: string
  onSelect: (modelId: string) => void
  disabled?: boolean
}

export const ModelSelector: FC<ModelSelectorProps> = ({
  models,
  selectedModel,
  onSelect,
  disabled,
}) => {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

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
    if (open) {
      setSearch('')
      setFreeOnly(false)
      setSelectedProvider(null)
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [open])

  const providers = useMemo(() => {
    const set = new Set(models.map((m) => m.provider))
    return Array.from(set).sort()
  }, [models])

  const filtered = useMemo(() => {
    let result = models
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q)
      )
    }
    if (freeOnly) {
      result = result.filter((m) => m.free)
    }
    if (selectedProvider) {
      result = result.filter((m) => m.provider === selectedProvider)
    }
    return result
  }, [models, search, freeOnly, selectedProvider])

  const selected = models.find((m) => m.id === selectedModel)

  const displayName = (name: string) => {
    const idx = name.indexOf(': ')
    return idx >= 0 ? name.slice(idx + 2) : name
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#2e2e2e] border border-[#444] text-sm text-white hover:bg-[#383838] transition-colors cursor-pointer disabled:opacity-50 h-9"
      >
        <FontAwesomeIcon icon={faHexagonNodes} className="w-4 h-4 text-white/80 shrink-0" />
        <span className="max-w-[200px] truncate">{selected ? displayName(selected.name) : selectedModel || 'Select model'}</span>
        {selected?.free && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium shrink-0">
            Free
          </span>
        )}
        <svg className="w-3 h-3 text-white/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 w-80 max-h-96 bg-holmes-surface border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-white/10 space-y-2">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-white/30"
            />
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-white/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={freeOnly}
                  onChange={(e) => setFreeOnly(e.target.checked)}
                  className="rounded border-white/20 bg-white/10 accent-holmes-primary"
                />
                Free only
              </label>
              <div className="flex-1" />
              <div className="flex gap-1 flex-wrap max-w-[180px] justify-end">
                {providers.slice(0, 6).map((p) => (
                  <button
                    key={p}
                    onClick={() =>
                      setSelectedProvider(selectedProvider === p ? null : p)
                    }
                    className={`text-[10px] px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                      selectedProvider === p
                        ? 'bg-holmes-primary/30 text-holmes-primary-light'
                        : 'bg-white/10 text-white/50 hover:bg-white/20'
                    }`}
                  >
                    {p}
                  </button>
                ))}
                {providers.length > 6 && (
                  <span className="text-[10px] text-white/30">+{providers.length - 6}</span>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-y-auto flex-1 scrollbar-thin">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-xs text-white/40 text-center">
                {models.length === 0
                  ? 'No models available. Check your API key in Settings.'
                  : 'No models match your filters.'}
              </div>
            ) : (
              filtered.map((model) => (
                <button
                  key={model.id}
                  onClick={() => {
                    onSelect(model.id)
                    setOpen(false)
                  }}
                  className={`w-full text-left px-4 py-2.5 text-sm transition-colors cursor-pointer border-b border-white/[0.02] last:border-0 ${
                    model.id === selectedModel
                      ? 'bg-holmes-primary/20 text-holmes-primary-light'
                      : 'text-white/70 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{displayName(model.name)}</span>
                    {model.free && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-medium shrink-0">
                        Free
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-xs text-white/40 truncate">{model.id}</span>
                    <span className="text-[10px] px-1 py-0.5 rounded bg-white/10 text-white/40 shrink-0">
                      {model.provider}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
