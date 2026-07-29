import { type FC, type ReactNode, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBuffer } from '@fortawesome/free-brands-svg-icons'
import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { PillDropdown } from './PillDropdown'
import { ProjectIcon } from './ProjectIcon'
import { MEMORY_CATALOG } from '@shared/memoryCatalog'
import {
  MAX_STACKED_CONTEXTS,
  addContextItem,
  contextItemFromKey,
  contextItemKey,
  flattenContextSelection,
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

  // One selection reads as itself; a stack collapses to a count, with the
  // members' own icons carrying which ones they are.
  const triggerLabel = items.length === 0
    ? 'Context'
    : items.length === 1
      ? selectedOptions[0]?.label || 'Context'
      : `${items.length} Contexts`

  const triggerIcon = (
    <>
      <FontAwesomeIcon icon={faBuffer} className="w-4 h-4" />
      {selectedOptions.length > 0 && (
        <>
          <span className="w-px h-3.5 bg-white/20 mx-1.5" />
          <span className="flex items-center gap-1">
            {selectedOptions.slice(0, 3).map((option) => (
              <span key={option.key} className="flex items-center justify-center w-3.5 h-3.5">{option.icon}</span>
            ))}
          </span>
        </>
      )}
    </>
  )

  const clearSelection = () => onChange({ kind: 'none' })

  const atCapacity = items.length >= MAX_STACKED_CONTEXTS

  // Every row toggles, so a second click on the last remaining context leaves
  // "none" — the same place the None row lands.
  const toggle = (key: string) => {
    if (selectedKeySet.has(key)) {
      onChange(removeContextItem(value, key))
      return
    }
    const item = contextItemFromKey(key)
    if (!item || atCapacity) return
    onChange(addContextItem(value, item))
  }

  // The panel stays open while rows are toggled — picking a second context is
  // the point, so only None (a terminal choice) closes it.
  const renderMainPanel = (close: () => void) => (
    <div className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[10px] uppercase tracking-wide text-white/30">
        <span className="flex-1 truncate">
          {items.length === 0
            ? 'Select one or more'
            : atCapacity
              ? `Stack limit reached (${MAX_STACKED_CONTEXTS})`
              : `${items.length} selected`}
        </span>
        {items.length > 0 && (
          <button
            onClick={clearSelection}
            className="shrink-0 normal-case tracking-normal text-[11px] text-white/40 hover:text-white transition-colors cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>
      <div className="overflow-y-auto flex-1 scrollbar-thin py-1 max-h-72">
        <button
          onClick={() => {
            clearSelection()
            close()
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer text-left ${
            items.length === 0
              ? 'bg-holmes-primary/20 text-holmes-primary-light'
              : 'text-white/70 hover:bg-white/5 hover:text-white'
          }`}
        >
          <span className="w-4 shrink-0" />
          <span className="flex-1 truncate">None</span>
        </button>
        {options.map((option) => {
          const isSelected = selectedKeySet.has(option.key)
          const blocked = !isSelected && atCapacity
          return (
            <button
              key={option.key}
              onClick={() => toggle(option.key)}
              disabled={blocked}
              aria-pressed={isSelected}
              title={blocked ? `Up to ${MAX_STACKED_CONTEXTS} contexts can be stacked` : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors text-left ${
                isSelected
                  ? 'bg-holmes-primary/20 text-holmes-primary-light cursor-pointer'
                  : blocked
                    ? 'text-white/25 cursor-not-allowed'
                    : 'text-white/70 hover:bg-white/5 hover:text-white cursor-pointer'
              }`}
            >
              <span className="flex items-center justify-center w-4 h-4 shrink-0">{option.icon}</span>
              <span className="flex-1 truncate">{option.label}</span>
              {option.hint && <span className="text-[10px] text-white/30 shrink-0">{option.hint}</span>}
              <span className="flex items-center justify-center w-3 shrink-0">
                {isSelected && <FontAwesomeIcon icon={faCheck} className="w-3 h-3" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <PillDropdown
      icon={triggerIcon}
      label={triggerLabel}
      value=""
      options={[]}
      onSelect={toggle}
      disabled={disabled}
      align="right"
      renderPanel={renderMainPanel}
    />
  )
}
