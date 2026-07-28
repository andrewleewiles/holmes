import { type FC, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faEye,
  faEyeSlash,
  faFolder,
  faGripLines,
  faMagnifyingGlassChart,
  faPlay,
  faSpinner,
  faTrash,
} from '@fortawesome/free-solid-svg-icons'
import type { Project, ProjectIndexSummary } from '@shared/types'
import { ProjectIcon } from './ProjectIcon'

export type SourceStatus = 'empty' | 'connected' | 'indexed' | 'error'

const STATUS_COLOR: Record<SourceStatus, string> = {
  // Dim: nothing connected yet. Green: a path is attached but nothing is indexed.
  // Teal (the app's own accent): indexed. Red: something is wrong — expand for it.
  empty: 'rgba(255,255,255,0.16)',
  connected: '#4ade80',
  indexed: '#47a08f',
  error: '#ef4444',
}

const STATUS_TITLE: Record<SourceStatus, string> = {
  empty: 'No path added yet',
  connected: 'Path added, not fully indexed',
  error: 'Something went wrong — expand this source for details',
  indexed: 'Path added and fully indexed',
}

export function sourceStatus(
  project: Project,
  summary: ProjectIndexSummary | undefined,
  errored: boolean
): SourceStatus {
  const hasPath = (project.sources?.length ?? 0) > 0 || Boolean(project.path)
  if (!hasPath) return 'empty'
  if (errored || (summary?.missingSources.length ?? 0) > 0) return 'error'
  // The accent colour is reserved for a source that is completely indexed —
  // a half-finished run stays green, or the dot would claim work that is
  // still outstanding.
  return summary?.fullyIndexed ? 'indexed' : 'connected'
}

interface DataSourceRowProps {
  project: Project
  summary?: ProjectIndexSummary
  status: SourceStatus
  expanded: boolean
  indexing: boolean
  indexDisabledReason: string | null
  /** User-created sources can be deleted outright; the built-ins can only be hidden. */
  personal: boolean
  /** The row being dragged: it follows the pointer and casts a shadow. */
  dragging: boolean
  /** Live transform while a drag is in flight — the dragged row follows the
   *  pointer, the others slide out of its way. */
  offsetY: number
  /** Off while the dragged row tracks the pointer; on for the rows making room. */
  animated: boolean
  /**
   * Replaces the path cell for a source that does not stand for a folder the
   * user picked — the File System source shows its access scope instead, and has
   * no Browse or type-a-path affordance.
   */
  pathOverride?: { label: string; title?: string; statusTitle?: string }
  onToggleExpand: () => void
  onIndex: () => void
  onToggleVisible: () => void
  onDelete: () => void
  onEditIdentity: () => void
  onBrowsePath: () => void
  onSubmitPath: (path: string) => void
  onDragHandleDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  children?: ReactNode
}

const ACTION_BUTTON =
  'flex h-[26px] w-[26px] items-center justify-center rounded-md text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/80 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-white/35 cursor-pointer disabled:cursor-not-allowed'

export const DataSourceRow: FC<DataSourceRowProps> = ({
  project,
  summary,
  status,
  expanded,
  indexing,
  indexDisabledReason,
  personal,
  dragging,
  offsetY,
  animated,
  pathOverride,
  onToggleExpand,
  onIndex,
  onToggleVisible,
  onDelete,
  onEditIdentity,
  onBrowsePath,
  onSubmitPath,
  onDragHandleDown,
  children,
}) => {
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (typing) inputRef.current?.focus()
  }, [typing])

  const sources = project.sources ?? []
  const primaryPath = sources[0]?.path ?? project.path
  const fileCount = summary?.fileCount ?? 0
  const folderCount = summary?.folderCount ?? 0
  const meta: string[] = []
  if (sources.length > 1) meta.push(`${sources.length} paths`)
  if (fileCount > 0) meta.push(`${fileCount.toLocaleString()} file${fileCount === 1 ? '' : 's'}`)
  if (folderCount > 0) meta.push(`${folderCount.toLocaleString()} folder${folderCount === 1 ? '' : 's'}`)

  const idle = status === 'empty'

  const commitDraft = () => {
    const trimmed = draft.trim()
    setTyping(false)
    setDraft('')
    if (trimmed) onSubmitPath(trimmed)
  }

  return (
    <div
      className="relative rounded-[10px]"
      style={{
        transform: `translateY(${offsetY}px)`,
        // The dragged row must track the pointer exactly; everything else eases
        // out of its way, which is what makes the list feel like it is settling
        // rather than snapping.
        transition: animated ? 'transform 180ms cubic-bezier(0.2, 0, 0, 1)' : 'none',
        zIndex: dragging ? 30 : undefined,
        position: dragging ? 'relative' : undefined,
      }}
    >
      <div
        className={`flex h-[46px] items-stretch overflow-hidden rounded-[10px] border bg-holmes-surface transition-[border-color,box-shadow] ${
          status === 'error'
            ? 'border-red-500/60 ring-1 ring-red-500/40'
            : expanded
              ? 'border-holmes-primary/40'
              : 'border-white/[0.06] hover:border-white/[0.12]'
        } ${dragging ? 'border-holmes-primary/40 shadow-[0_10px_28px_rgba(0,0,0,0.55)]' : ''} ${project.visible ? '' : 'opacity-50'}`}
      >
        <div
          className={`flex w-[196px] shrink-0 items-center gap-2.5 border-r border-black/40 px-3 ${
            idle ? 'bg-white/[0.01]' : 'bg-white/[0.025]'
          }`}
        >
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ backgroundColor: STATUS_COLOR[status] }}
            title={pathOverride?.statusTitle ?? STATUS_TITLE[status]}
          />
          <button
            onClick={personal ? onEditIdentity : onToggleExpand}
            title={personal ? 'Rename this source or change its icon' : project.name}
            className={`flex min-w-0 flex-1 items-center gap-2.5 text-left transition-opacity cursor-pointer ${
              idle ? 'opacity-45' : 'hover:opacity-80'
            }`}
          >
            <ProjectIcon icon={project.icon} className="shrink-0 text-[15px]" />
            <span className="truncate font-serif-display text-[15px] text-white/85">{project.name}</span>
          </button>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3">
          {pathOverride ? (
            <FontAwesomeIcon icon={faFolder} className="shrink-0 text-[12px] text-white/25" />
          ) : (
            <button
              onClick={onBrowsePath}
              title={sources.length > 0 ? 'Add another directory' : 'Choose a directory'}
              className="shrink-0 text-white/25 transition-colors hover:text-white/60 cursor-pointer"
            >
              <FontAwesomeIcon icon={faFolder} className="text-[12px]" />
            </button>
          )}

          {pathOverride ? (
            <button
              onClick={onToggleExpand}
              title={pathOverride.title ?? pathOverride.label}
              className="min-w-0 flex-1 truncate text-left text-[13px] text-white/45 transition-colors hover:text-white/70 cursor-pointer"
            >
              {pathOverride.label}
            </button>
          ) : typing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitDraft() }
                if (e.key === 'Escape') { e.preventDefault(); setTyping(false); setDraft('') }
              }}
              placeholder="/path/to/directory"
              className="min-w-0 flex-1 rounded border border-white/15 bg-black/25 px-2 py-1 text-[13px] text-white/80 outline-none focus:border-holmes-primary/50 placeholder:text-white/20"
            />
          ) : primaryPath ? (
            <button
              onClick={onToggleExpand}
              title={sources.map((s) => s.path).join('\n') || primaryPath}
              className="min-w-0 flex-1 truncate text-left text-[13px] text-white/45 transition-colors hover:text-white/70 cursor-pointer"
            >
              {primaryPath}
            </button>
          ) : (
            <button
              onClick={() => setTyping(true)}
              className="min-w-0 flex-1 truncate text-left text-[13px] text-white/25 transition-colors hover:text-white/45 cursor-pointer"
            >
              Add a path…
            </button>
          )}

          {project.contextScope === 'separate' && (
            <span
              className="shrink-0 rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/35"
              title="Kept out of the life super-context, memory and the life timeline"
            >
              separate
            </span>
          )}
          {project.indexStyle !== 'behavioral' && (
            <span
              className="shrink-0 rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/35"
              title={`Indexed in the ${project.indexStyle} style`}
            >
              {project.indexStyle}
            </span>
          )}
          {meta.length > 0 && (
            <span className="shrink-0 text-[10px] text-white/30 tabular-nums">{meta.join(' · ')}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 border-l border-black/40 px-2">
          <button
            onClick={onToggleExpand}
            title={expanded ? 'Collapse this source' : 'Expand this source for full options'}
            className={`${ACTION_BUTTON} ${expanded ? 'bg-white/[0.07] text-holmes-primary-light' : ''}`}
            aria-expanded={expanded}
            aria-label={`Expand ${project.name}`}
          >
            <FontAwesomeIcon icon={faPlay} className="text-[12px]" />
          </button>
          <button
            onClick={onIndex}
            disabled={Boolean(indexDisabledReason) || indexing}
            title={indexDisabledReason ?? 'Index this source'}
            className={ACTION_BUTTON}
            aria-label={`Index ${project.name}`}
          >
            <FontAwesomeIcon
              icon={indexing ? faSpinner : faMagnifyingGlassChart}
              className={`text-[13px] ${indexing ? 'animate-spin' : ''}`}
            />
          </button>
          {personal ? (
            <button
              onClick={onDelete}
              title="Delete this source"
              className={`${ACTION_BUTTON} hover:text-red-400`}
              aria-label={`Delete ${project.name}`}
            >
              <FontAwesomeIcon icon={faTrash} className="text-[12px]" />
            </button>
          ) : (
            <button
              onClick={onToggleVisible}
              title={project.visible ? 'Hide this source — it stops being indexed or offered as context' : 'Show this source'}
              className={ACTION_BUTTON}
              aria-pressed={!project.visible}
              aria-label={`${project.visible ? 'Hide' : 'Show'} ${project.name}`}
            >
              <FontAwesomeIcon icon={project.visible ? faEye : faEyeSlash} className="text-[13px]" />
            </button>
          )}
        </div>

        <div
          onPointerDown={onDragHandleDown}
          title="Drag to rearrange"
          className={`flex w-[46px] shrink-0 touch-none select-none items-center justify-center border-l border-black/40 transition-colors ${
            dragging ? 'cursor-grabbing text-white/70' : 'cursor-grab text-white/25 hover:text-white/55'
          }`}
        >
          <FontAwesomeIcon icon={faGripLines} className="text-[14px]" />
        </div>
      </div>

      {expanded && children && <div className="mt-2 mb-1">{children}</div>}
    </div>
  )
}
