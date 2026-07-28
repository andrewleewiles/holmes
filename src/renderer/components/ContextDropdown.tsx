import { type FC, type ReactNode, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBuffer } from '@fortawesome/free-brands-svg-icons'
import { faPlus, faXmark } from '@fortawesome/free-solid-svg-icons'
import { PillDropdown } from './PillDropdown'
import { ProjectIcon } from './ProjectIcon'
import { MEMORY_CATALOG } from '@shared/memoryCatalog'
import {
  MAX_STACKED_CONTEXTS,
  addContextItem,
  contextItemFromKey,
  contextItemKey,
  flattenContextSelection,
  normalizeContextSelection,
  removeContextItem,
} from '@shared/contextSelection'
import type { ContextSelection, Project } from '@shared/types'
import lifeIcon from '../../../assets/lifeIcon.svg'

interface ContextDropdownProps {
  value: ContextSelection
  onChange: (context: ContextSelection) => void
  disabled?: boolean
}

interface ContextOption {
  key: string
  label: string
  hint?: string
  icon: ReactNode
}

export const ContextDropdown: FC<ContextDropdownProps> = ({ value, onChange, disabled }) => {
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    // Hidden sources are offered nowhere: a project the user switched off on the
    // Data page should not turn up as selectable context here.
    window.electronAPI.projects
      .list()
      .then((list) => setProjects(list.filter((project) => project.visible)))
      .catch(() => setProjects([]))
  }, [])

  const items = flattenContextSelection(value)
  const selectedKeys = items.map(contextItemKey)
  const selectedKeySet = new Set(selectedKeys)

  const lifeGlyph = <img src={lifeIcon} alt="" className="w-3.5 h-3.5" />

  const options: ContextOption[] = []
  for (const project of projects) {
    options.push({
      key: `project:${project.id}`,
      label: project.name,
      hint: 'project',
      icon: <ProjectIcon icon={project.icon} className="text-[0.875rem]" style={{ color: 'rgba(255,255,255,0.8)' }} />,
    })
  }
  options.push({ key: 'life', label: 'Life', hint: 'all categories', icon: lifeGlyph })
  for (const category of MEMORY_CATALOG) {
    options.push({ key: `category:${category.key}`, label: category.label, hint: 'category', icon: lifeGlyph })
  }

  const optionByKey = new Map(options.map((option) => [option.key, option]))
  const selectedOptions = selectedKeys
    .map((key) => optionByKey.get(key))
    .filter((option): option is ContextOption => Boolean(option))

  const triggerLabel = items.length === 0
    ? 'Context'
    : items.length === 1
      ? selectedOptions[0]?.label || 'Context'
      : `${items.length} contexts`

  const triggerIcon = (
    <>
      <FontAwesomeIcon icon={faBuffer} className="w-4 h-4" />
      {selectedOptions.length > 0 && (
        <>
          <span className="w-px h-3.5 bg-white/20 mx-1.5" />
          <span className="flex items-center gap-1">
            {selectedOptions.slice(0, 2).map((option) => (
              <span key={option.key} className="flex items-center justify-center w-3.5 h-3.5">{option.icon}</span>
            ))}
            {selectedOptions.length > 2 && (
              <span className="text-[10px] text-white/40 leading-none">+{selectedOptions.length - 2}</span>
            )}
          </span>
        </>
      )}
    </>
  )

  const replaceWith = (key: string) => {
    const item = contextItemFromKey(key)
    onChange(item ? normalizeContextSelection(item) : { kind: 'none' })
  }

  const addToStack = (key: string) => {
    const item = contextItemFromKey(key)
    if (!item) return
    onChange(addContextItem(value, item))
  }

  const removeFromStack = (key: string) => {
    onChange(removeContextItem(value, key))
  }

  const atCapacity = items.length >= MAX_STACKED_CONTEXTS
  const addableOptions = options.filter((option) => !selectedKeySet.has(option.key))

  const renderMainPanel = (close: () => void) => (
    <div className="flex flex-col overflow-hidden">
      {selectedOptions.length > 0 && (
        <div className="border-b border-white/10 py-1.5 px-1.5">
          <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-white/30">
            {selectedOptions.length === 1 ? 'Active context' : `Stacked contexts (${selectedOptions.length})`}
          </div>
          <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto scrollbar-thin">
            {selectedOptions.map((option) => (
              <div
                key={option.key}
                className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-lg text-sm text-white/80 bg-white/5"
              >
                <span className="flex items-center justify-center w-4 h-4 shrink-0">{option.icon}</span>
                <span className="flex-1 truncate">{option.label}</span>
                <button
                  onClick={() => removeFromStack(option.key)}
                  aria-label={`Remove ${option.label} context`}
                  className="flex items-center justify-center w-5 h-5 rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
                >
                  <FontAwesomeIcon icon={faXmark} className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="overflow-y-auto flex-1 scrollbar-thin py-1 max-h-72">
        <button
          onClick={() => {
            replaceWith('none')
            close()
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer text-left ${
            items.length === 0
              ? 'bg-holmes-primary/20 text-holmes-primary-light'
              : 'text-white/70 hover:bg-white/5 hover:text-white'
          }`}
        >
          <span className="flex-1 truncate">None</span>
        </button>
        {options.map((option) => (
          <button
            key={option.key}
            onClick={() => {
              replaceWith(option.key)
              close()
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer text-left ${
              selectedKeySet.has(option.key)
                ? 'bg-holmes-primary/20 text-holmes-primary-light'
                : 'text-white/70 hover:bg-white/5 hover:text-white'
            }`}
          >
            <span className="flex items-center justify-center w-4 h-4 shrink-0">{option.icon}</span>
            <span className="flex-1 truncate">{option.label}</span>
            {option.hint && <span className="text-[10px] text-white/30 shrink-0">{option.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  )

  const renderAddPanel = (close: () => void) => (
    <div className="flex flex-col overflow-hidden">
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-white/30">
        {atCapacity ? `Stack limit reached (${MAX_STACKED_CONTEXTS})` : 'Add another context'}
      </div>
      <div className="overflow-y-auto flex-1 scrollbar-thin py-1 max-h-72">
        {addableOptions.length === 0 || atCapacity ? (
          <div className="px-3 py-2 text-sm text-white/40">Nothing left to add.</div>
        ) : (
          addableOptions.map((option) => (
            <button
              key={option.key}
              onClick={() => {
                addToStack(option.key)
                close()
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white/70 hover:bg-white/5 hover:text-white transition-colors cursor-pointer text-left"
            >
              <span className="flex items-center justify-center w-4 h-4 shrink-0">{option.icon}</span>
              <span className="flex-1 truncate">{option.label}</span>
              {option.hint && <span className="text-[10px] text-white/30 shrink-0">{option.hint}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  )

  return (
    <div className="flex items-center gap-1.5">
      <PillDropdown
        icon={triggerIcon}
        label={triggerLabel}
        value=""
        options={[]}
        onSelect={replaceWith}
        disabled={disabled}
        align="right"
        renderPanel={renderMainPanel}
      />
      <PillDropdown
        icon={<FontAwesomeIcon icon={faPlus} className="w-3.5 h-3.5" />}
        label="Add context"
        value=""
        options={[]}
        onSelect={addToStack}
        disabled={disabled}
        align="right"
        iconOnly
        renderPanel={renderAddPanel}
      />
    </div>
  )
}
