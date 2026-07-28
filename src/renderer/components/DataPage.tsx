import { type FC, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight, faDatabase, faMagnifyingGlassChart, faPlus, faRefresh } from '@fortawesome/free-solid-svg-icons'
import type {
  Project,
  ActivityRecord,
  ActivityIngestProgress,
  HealthRecord,
  HealthIngestProgress,
  ActivitySourceType,
  ActivitySummary,
  SourceAnalysis,
  ProjectIndexSummary,
} from '@shared/types'
import {
  FILE_SYSTEM_PROJECT_NAME,
  isDefaultProjectName,
  isLibraryProject,
  isMediaProjectName,
} from '@shared/defaultProjects'
import { FileScopePanel } from './FileScopePanel'
import { BooksSourcePanel } from './BooksSourcePanel'
import { ProjectIcon } from './ProjectIcon'
import { ActivitySourcesPanel } from './ActivitySourcesPanel'
import { ActivityAccountsPanel } from './ActivityAccountsPanel'
import { HealthSourcesPanel } from './HealthSourcesPanel'
import { DocumentContextPanel } from './DocumentContextPanel'
import { DataSourceRow, sourceStatus, type SourceStatus } from './DataSourceRow'
import { ProjectVisibilityMenu } from './ProjectVisibilityMenu'
import { BulkIndexDialog } from './BulkIndexDialog'
import { SourceDialog, PROJECT_COLOR_OPTIONS } from './SourceDialog'
import { useSettings } from '../hooks/useSettings'
import { useDocumentIndexState } from '../hooks/useDocumentIndex'

interface DataPageProps {
  projects: Project[]
  onBack: () => void
  onOpenPsychology: (projectId: string) => void
  onOpenHealth: (projectId: string) => void
  onOpenActivity: (projectId: string) => void
  onUpdate: (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  onCreateProject: (data: { name: string; icon: string; color: string }) => Promise<Project | void>
  onDeleteProject: (id: string) => Promise<void>
  onReorder: (orderedIds: string[]) => Promise<void>
  onSelectImage: () => Promise<string | null>
  onAddSource: (projectId: string, sourcePath: string) => Promise<void>
  onRemoveSource: (projectId: string, sourcePath: string) => Promise<void>
  onSelectDirectory: () => Promise<string | null>
  /** Media sources are read on their own page, so their row links to it. */
  onOpenLibrary: () => void
  focusProjectId?: string | null
  onFocusHandled?: () => void
}

const LIVE_SOURCES: ActivitySourceType[] = ['knowledge', 'amazon', 'photos', 'weather', 'subscription']

/** What a library row's dot and subtitle need — counts, never contexts. */
export interface LibraryRowStats {
  books: number
  read: number
  unreachable: boolean
}

type SourceGroup = 'life' | 'media' | 'personal'

interface DragState {
  id: string
  group: SourceGroup
  fromIndex: number
  toIndex: number
  /** Live pointer delta for the dragged row. */
  deltaY: number
  /** Row height plus the gap — how far a displaced row steps aside. */
  step: number
}

export const DataPage: FC<DataPageProps> = ({
  projects,
  onBack,
  onOpenPsychology,
  onOpenHealth,
  onOpenActivity,
  onUpdate,
  onCreateProject,
  onDeleteProject,
  onReorder,
  onSelectImage,
  onAddSource,
  onRemoveSource,
  onSelectDirectory,
  onOpenLibrary,
  focusProjectId,
  onFocusHandled,
}) => {
  const { settings } = useSettings()
  const documentContextEnabled = settings?.documentContextEnabled ?? false

  const healthProject = projects.find((p) => p.name === 'Health')
  const activityProject = projects.find((p) => p.name === 'Activity')

  // The File System source is not a folder the user picked: it stands for where
  // Holmes is allowed to read at all, so its row reports the access scope.
  const scope = settings?.fileAccessScope
  const isFileSystem = (project: Project) => project.name === FILE_SYSTEM_PROJECT_NAME
  const fileSystemPath = (): { label: string; title?: string; statusTitle?: string } => {
    if (!scope || scope.mode === 'everywhere') {
      return {
        label: '/',
        title: 'Entire filesystem — Holmes may read anywhere macOS allows',
        statusTitle: 'Holmes may read the whole filesystem',
      }
    }
    if (scope.roots.length === 0) {
      return {
        label: 'No folders allowed yet…',
        title: 'Add a folder in this source to let Holmes read anything',
        statusTitle: 'Holmes cannot read any files yet',
      }
    }
    const [first, ...rest] = scope.roots
    return {
      label: rest.length > 0 ? `${first}  +${rest.length} more` : first,
      title: scope.roots.join('\n'),
      statusTitle: `Holmes may read ${scope.roots.length} folder${scope.roots.length === 1 ? '' : 's'}`,
    }
  }

  const [activityRecords, setActivityRecords] = useState<ActivityRecord[]>([])
  const [activityProgress, setActivityProgress] = useState<ActivityIngestProgress | null>(null)
  const [activityLiveBusy, setActivityLiveBusy] = useState(false)
  const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([])
  const [healthProgress, setHealthProgress] = useState<HealthIngestProgress | null>(null)
  const [healthLiveBusy, setHealthLiveBusy] = useState(false)
  const [activitySummary, setActivitySummary] = useState<ActivitySummary | null>(null)
  const [panelsReloadKey, setPanelsReloadKey] = useState(0)
  const [summaries, setSummaries] = useState<ProjectIndexSummary[]>([])
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  const [indexingProjectId, setIndexingProjectId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [bulkOpen, setBulkOpen] = useState(false)
  const [creatingSource, setCreatingSource] = useState(false)
  const [creatingBusy, setCreatingBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [highlightProjectId, setHighlightProjectId] = useState<string | null>(null)
  // Cheap shelf counts for the library row's dot and subtitle — books, not
  // document contexts. Filled by BooksSourcePanel as it loads.
  const [libraryStats, setLibraryStats] = useState<Record<string, LibraryRowStats>>({})
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const highlightTimerRef = useRef<number | null>(null)

  const indexState = useDocumentIndexState()
  const indexStatus = indexState?.status ?? 'idle'
  const indexRunActive = indexStatus === 'running' || indexStatus === 'stopping'
  const batchPaused = indexStatus === 'paused' && indexState?.scope === 'all'

  // The built-in sources the life picture is made of come first, then media
  // sources — built in, but read into their own page rather than into the
  // profile — then the user's own. Each group is arranged independently.
  const rows = projects.filter((project) => project.visible)
  const lifeRows = rows.filter((project) => isDefaultProjectName(project.name) && !isMediaProjectName(project.name))
  const mediaRows = rows.filter((project) => isMediaProjectName(project.name))
  const personalRows = rows.filter((project) => !isDefaultProjectName(project.name))
  // A library source is never a bulk-index candidate: its folders hold books,
  // which the Library scans and the document indexer must not touch.
  const connectedRows = rows.filter((project) => project.path && !isLibraryProject(project))
  const rowsForGroup = (group: SourceGroup): Project[] =>
    group === 'life' ? lifeRows : group === 'media' ? mediaRows : personalRows
  const summaryFor = (projectId: string) => summaries.find((s) => s.projectId === projectId)

  /**
   * A library source has no document contexts and never will, so the generic
   * `fullyIndexed` test — which requires at least one indexed file — would leave
   * its dot green forever, claiming work that is not outstanding. Its dot
   * reports the shelf instead.
   */
  const libraryStatus = (project: Project): SourceStatus => {
    const hasPath = (project.sources?.length ?? 0) > 0 || Boolean(project.path)
    if (!hasPath) return 'empty'
    const stats = libraryStats[project.id]
    if (rowErrors[project.id] || stats?.unreachable) return 'error'
    return stats && stats.books > 0 ? 'indexed' : 'connected'
  }

  useEffect(() => () => {
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
  }, [])

  const refreshSummaries = async () => {
    try {
      setSummaries(await window.electronAPI.documents.getSummaries())
    } catch {
      setSummaries([])
    }
  }

  useEffect(() => {
    void refreshSummaries()
  }, [projects.length, panelsReloadKey])

  // Counts change when a run finishes, whoever started it — including the hourly
  // background pass.
  const previousStatusRef = useRef(indexStatus)
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = indexStatus
    if ((previous === 'running' || previous === 'stopping') && !indexRunActive) {
      void refreshSummaries()
    }
  }, [indexStatus, indexRunActive])

  useEffect(() => {
    if (!focusProjectId) return
    const targetId = focusProjectId
    setExpandedProjectId(targetId)
    setHighlightProjectId(targetId)
    onFocusHandled?.()
    window.requestAnimationFrame(() => {
      rowRefs.current.get(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = window.setTimeout(() => setHighlightProjectId(null), 4000)
  }, [focusProjectId])

  // The page has no back button of its own — Escape and the title-bar home
  // button are the way out.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (bulkOpen || creatingSource || editingProject) return
      onBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onBack, bulkOpen, creatingSource, editingProject])

  const refreshActivityRecords = async () => {
    if (!activityProject) {
      setActivityRecords([])
      return
    }
    try {
      setActivityRecords(await window.electronAPI.activity.listRecords(activityProject.id))
    } catch {
      setActivityRecords([])
    }
  }

  const refreshActivitySummary = async () => {
    if (!activityProject) {
      setActivitySummary(null)
      return
    }
    try {
      setActivitySummary(await window.electronAPI.activity.getSummary(activityProject.id))
    } catch {
      setActivitySummary(null)
    }
  }

  const refreshHealthRecords = async () => {
    if (!healthProject) {
      setHealthRecords([])
      return
    }
    try {
      setHealthRecords(await window.electronAPI.health.listRecords(healthProject.id))
    } catch {
      setHealthRecords([])
    }
  }

  useEffect(() => {
    void refreshActivityRecords()
    void refreshActivitySummary()
    void refreshHealthRecords()
  }, [activityProject?.id, healthProject?.id])

  useEffect(() => {
    const unsubscribe = window.electronAPI.activity.onProgress((p) => {
      setActivityProgress(p)
      if (p.phase === 'complete' || p.phase === 'permission' || p.phase === 'reauth') {
        void refreshActivityRecords()
        void refreshActivitySummary()
      }
    })
    return unsubscribe
  }, [activityProject?.id])

  useEffect(() => {
    const unsubscribe = window.electronAPI.health.onProgress((p) => {
      setHealthProgress(p)
      if (p.phase === 'complete' || p.phase === 'error') {
        void refreshHealthRecords()
      }
    })
    return unsubscribe
  }, [healthProject?.id])

  const handleActivityIngest = async (filePath: string, source: ActivitySourceType) => {
    if (!activityProject) throw new Error('Activity project not found')
    await window.electronAPI.activity.ingest(activityProject.id, filePath, source)
  }

  const handleActivityAbort = async () => {
    await window.electronAPI.activity.abort()
  }

  const handleActivityDelete = async (recordId: string) => {
    await window.electronAPI.activity.deleteRecord(recordId)
    await refreshActivityRecords()
  }

  const handleActivityLiveSync = async (_sourceTypes?: ActivitySourceType[]) => {
    if (!activityProject) return
    setActivityLiveBusy(true)
    try {
      await window.electronAPI.activity.liveSync(activityProject.id, LIVE_SOURCES)
      await refreshActivityRecords()
    } catch {
      // ignore — user can retry
    } finally {
      setActivityLiveBusy(false)
    }
  }

  const handleHealthIngest = async (filePath: string) => {
    if (!healthProject) throw new Error('Health project not found')
    await window.electronAPI.health.ingest(healthProject.id, filePath)
  }

  const handleHealthAbort = async () => {
    await window.electronAPI.health.abort()
  }

  const handleHealthDelete = async (recordId: string) => {
    await window.electronAPI.health.deleteRecord(recordId)
    await refreshHealthRecords()
  }

  const handleHealthLiveSync = async () => {
    if (!healthProject) return
    setHealthLiveBusy(true)
    try {
      await window.electronAPI.health.liveSync(healthProject.id)
      await refreshHealthRecords()
    } catch {
      // ignore
    } finally {
      setHealthLiveBusy(false)
    }
  }

  const [scanningProjectId, setScanningProjectId] = useState<string | null>(null)

  const triggerDirectoryScan = async (project: Project) => {
    if (project.name === 'Health') {
      setScanningProjectId(project.id)
      try {
        await window.electronAPI.health.scanDirectory(project.id)
        await refreshHealthRecords()
      } catch {
        // ignore — user can retry
      } finally {
        setScanningProjectId(null)
      }
    } else if (project.name === 'Activity') {
      setScanningProjectId(project.id)
      try {
        await window.electronAPI.activity.scanDirectory(project.id)
        await refreshActivityRecords()
        await refreshActivitySummary()
      } catch {
        // ignore — user can retry
      } finally {
        setScanningProjectId(null)
      }
    }
  }

  const handleAddPath = async (project: Project, sourcePath: string) => {
    await onAddSource(project.id, sourcePath)
    void triggerDirectoryScan(project)
    void refreshSummaries()
  }

  const handleBrowsePath = async (project: Project) => {
    const directory = await onSelectDirectory()
    if (directory) await handleAddPath(project, directory)
  }

  const handleRemoveDirectory = async (projectId: string, sourcePath: string) => {
    await onRemoveSource(projectId, sourcePath)
    void refreshSummaries()
  }

  // The row's play button: one source, the default tier, no dialog.
  const handleIndexProject = async (project: Project) => {
    // Belt and braces: the button is already disabled for a library source, and
    // main refuses the call outright. Books are scanned, never indexed.
    if (isLibraryProject(project)) return
    if (!documentContextEnabled || indexRunActive || indexingProjectId) return
    setIndexingProjectId(project.id)
    setRowErrors((current) => {
      const next = { ...current }
      delete next[project.id]
      return next
    })
    try {
      await window.electronAPI.documents.generate(project.id, settings?.defaultTier ?? 'mid')
      setPanelsReloadKey((k) => k + 1)
      await refreshSummaries()
    } catch (err) {
      setRowErrors((current) => ({
        ...current,
        [project.id]: err instanceof Error ? err.message : 'Index build failed',
      }))
      setExpandedProjectId(project.id)
    } finally {
      setIndexingProjectId(null)
    }
  }

  const handleCreateSource = async (value: { name: string; icon: string; color: string }) => {
    setCreatingBusy(true)
    setCreateError(null)
    try {
      const created = await onCreateProject(value)
      setCreatingSource(false)
      // A new source lands at the bottom of the list — say where it went.
      if (created && typeof created === 'object' && 'id' in created) {
        const newId = created.id
        setHighlightProjectId(newId)
        window.requestAnimationFrame(() => {
          rowRefs.current.get(newId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
        if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current)
        highlightTimerRef.current = window.setTimeout(() => setHighlightProjectId(null), 4000)
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the source')
    } finally {
      setCreatingBusy(false)
    }
  }

  const handleEditSource = async (value: { name: string; icon: string; color: string }) => {
    if (!editingProject) return
    await onUpdate(editingProject.id, value)
    setEditingProject(null)
  }

  const handleDeleteSource = async (project: Project) => {
    const confirmed = window.confirm(
      `Delete the source “${project.name}”? Its connected directories are left untouched on disk, but every context Holmes derived from them is removed.`
    )
    if (!confirmed) return
    await onDeleteProject(project.id)
    if (expandedProjectId === project.id) setExpandedProjectId(null)
    void refreshSummaries()
  }

  // Dragging reorders within a group. The stored order is always life sources,
  // then media, then personal ones, then whatever is hidden — hidden sources
  // have no row to be dropped next to, so they keep their place at the end.
  const persistOrder = (group: SourceGroup, orderedIds: string[]) => {
    const idsFor = (candidate: SourceGroup) =>
      group === candidate ? orderedIds : rowsForGroup(candidate).map((project) => project.id)
    const hidden = projects.filter((project) => !project.visible).map((project) => project.id)
    void onReorder([...idsFor('life'), ...idsFor('media'), ...idsFor('personal'), ...hidden])
  }

  // Pointer-driven rather than HTML5 drag-and-drop: the browser's drag gives a
  // ghost image and no way to animate the rows underneath it. Here the dragged
  // row tracks the pointer and every row it passes eases out of its way by
  // exactly the dragged row's height — the iOS list-reorder feel.
  const handleDragHandleDown = (project: Project, group: SourceGroup, index: number) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const groupRows = rowsForGroup(group)
      const rects = groupRows.map((row) => rowRefs.current.get(row.id)?.getBoundingClientRect() ?? null)
      const self = rects[index]
      if (!self) return

      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture?.(event.pointerId)

      const startY = event.clientY
      // Row height plus the 8px gap between rows: what every row it passes moves by.
      const step = self.height + 8
      const centers = rects.map((rect) => (rect ? rect.top + rect.height / 2 : Number.POSITIVE_INFINITY))

      setDrag({ id: project.id, group, fromIndex: index, toIndex: index, deltaY: 0, step })

      // One state update per frame: a pointer stream at 120Hz would otherwise
      // re-render the whole list several times between paints.
      let pendingY: number | null = null
      let frame: number | null = null
      const apply = () => {
        frame = null
        if (pendingY === null) return
        const deltaY = pendingY - startY
        const draggedCenter = centers[index] + deltaY
        let toIndex = 0
        for (let i = 0; i < centers.length; i += 1) {
          if (i !== index && centers[i] < draggedCenter) toIndex += 1
        }
        setDrag((current) => (current ? { ...current, deltaY, toIndex } : current))
      }

      const move = (moveEvent: PointerEvent) => {
        pendingY = moveEvent.clientY
        if (frame === null) frame = window.requestAnimationFrame(apply)
      }

      const end = () => {
        if (frame !== null) window.cancelAnimationFrame(frame)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        handle.releasePointerCapture?.(event.pointerId)
        setDrag((current) => {
          if (current && current.toIndex !== current.fromIndex) {
            const ids = groupRows.map((row) => row.id)
            const [moved] = ids.splice(current.fromIndex, 1)
            ids.splice(current.toIndex, 0, moved)
            persistOrder(group, ids)
          }
          return null
        })
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    }

  // How far a row has to move while a drag is in flight: the dragged one follows
  // the pointer, the ones between its old and new home step aside by one row.
  const dragOffset = (group: SourceGroup, index: number): { offsetY: number; animated: boolean; dragging: boolean } => {
    if (!drag || drag.group !== group) return { offsetY: 0, animated: true, dragging: false }
    if (index === drag.fromIndex) return { offsetY: drag.deltaY, animated: false, dragging: true }
    if (drag.fromIndex < drag.toIndex && index > drag.fromIndex && index <= drag.toIndex) {
      return { offsetY: -drag.step, animated: true, dragging: false }
    }
    if (drag.fromIndex > drag.toIndex && index >= drag.toIndex && index < drag.fromIndex) {
      return { offsetY: drag.step, animated: true, dragging: false }
    }
    return { offsetY: 0, animated: true, dragging: false }
  }

  const activityNeedsAttention = activityRecords.filter(
    (r) => r.status === 'needs_permission' || r.status === 'failed' || r.status === 'needs_reauth' as never
  ).length

  const openLink = (label: string, onClick: () => void, color: string) => (
    <button
      onClick={onClick}
      className={`ml-auto flex items-center gap-1 text-[11px] text-white/40 ${color} transition-colors cursor-pointer`}
    >
      {label}
      <FontAwesomeIcon icon={faArrowRight} className="text-[9px]" />
    </button>
  )

  // The directory list lives inside the expanded panel: the row shows one path,
  // but a source may connect several and each is indexable on its own.
  const renderDirectoryRow = (project: Project) => {
    const sources = project.sources ?? []
    return (
      <div className="space-y-1.5">
        {sources.map((source) => (
          <div key={source.id} className="flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-white/30">↳</span>
            <span className="min-w-0 flex-1 truncate text-xs text-white/50" title={source.path}>{source.path}</span>
            {(project.name === 'Health' || project.name === 'Activity') && source.sortOrder === 0 && (
              <button
                onClick={() => void triggerDirectoryScan(project)}
                disabled={scanningProjectId === project.id}
                className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/50 transition-colors hover:border-white/20 hover:text-white/70 disabled:opacity-40 cursor-pointer"
              >
                <FontAwesomeIcon icon={faRefresh} className={`mr-1.5 text-[10px] ${scanningProjectId === project.id ? 'animate-spin' : ''}`} />
                {scanningProjectId === project.id ? 'Scanning…' : 'Scan'}
              </button>
            )}
            <button
              onClick={() => void handleRemoveDirectory(project.id, source.path)}
              className="shrink-0 text-[11px] text-white/25 transition-colors hover:text-red-400 cursor-pointer"
              title="Disconnect this directory and delete the contexts derived from it"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          onClick={() => void handleBrowsePath(project)}
          className="flex items-center gap-1.5 text-[11px] text-white/35 transition-colors hover:text-holmes-primary-light cursor-pointer"
        >
          <FontAwesomeIcon icon={faPlus} className="text-[9px]" />
          Add directory
        </button>
      </div>
    )
  }

  // Both settings are chosen BEFORE an index run: the style is baked into every
  // prompt version, so changing it is what makes the next run regenerate this
  // project's contexts.
  const renderSourceSettings = (project: Project) => {
    const scope = project.contextScope
    const style = project.indexStyle
    const segment = (active: boolean) =>
      `rounded-md px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
        active ? 'bg-holmes-primary/20 text-holmes-primary-light' : 'text-white/45 hover:bg-white/[0.06] hover:text-white/70'
      }`

    return (
      <div className="rounded-xl border border-white/[0.07] bg-holmes-surface p-3.5">
        <div className="mb-3 text-[10px] uppercase tracking-wider text-white/35">Source settings</div>

        <div className="mb-1.5 flex items-center gap-3">
          <span className="w-24 shrink-0 text-[11px] text-white/50">Context</span>
          <div className="flex gap-1 rounded-lg border border-white/[0.07] bg-black/20 p-0.5">
            <button className={segment(scope === 'life')} onClick={() => void onUpdate(project.id, { contextScope: 'life' })}>
              Part of life
            </button>
            <button className={segment(scope === 'separate')} onClick={() => void onUpdate(project.id, { contextScope: 'separate' })}>
              Separate
            </button>
          </div>
        </div>
        <p className="mb-3 pl-[7.5rem] text-[10px] leading-relaxed text-white/30">
          {scope === 'separate'
            ? 'Kept out of the user super-context, memory and the life timeline. It keeps its own timeline and is only used when you select it as context.'
            : 'Folded into the unified user super-context, memory extraction and the life timeline.'}
        </p>

        <div className="mb-1.5 flex items-center gap-3">
          <span className="w-24 shrink-0 text-[11px] text-white/50">Index style</span>
          <div className="flex gap-1 rounded-lg border border-white/[0.07] bg-black/20 p-0.5">
            <button className={segment(style === 'behavioral')} onClick={() => void onUpdate(project.id, { indexStyle: 'behavioral' })}>
              Behavioural
            </button>
            <button className={segment(style === 'work')} onClick={() => void onUpdate(project.id, { indexStyle: 'work' })}>
              Work
            </button>
            <button className={segment(style === 'reference')} onClick={() => void onUpdate(project.id, { indexStyle: 'reference' })}>
              Reference
            </button>
          </div>
        </div>
        <p className="pl-[7.5rem] text-[10px] leading-relaxed text-white/30">
          {style === 'work'
            ? 'Read as a body of work: what the material is, how it is built, what state it is in and what is unresolved.'
            : style === 'reference'
              ? 'Described and organised with no interpretation — content, entities and dates only.'
              : 'Read as evidence about you: behaviours, routines, interests and how they change over time.'}
          {(summaryFor(project.id)?.fileCount ?? 0) > 0 && (
            <span className="text-amber-200/60"> Changing the style re-indexes this source on its next run.</span>
          )}
        </p>
      </div>
    )
  }

  // A source's own analysis lives on that source's card — nowhere else.
  const renderSourceAnalysis = (project: Project) => {
    if (project.name === 'Activity') {
      const analyses = activitySummary?.sourceAnalyses ?? []
      return (
        <div className="space-y-3">
          {analyses.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {analyses.map((sa: SourceAnalysis) => (
                <details key={sa.sourceType} className="group overflow-hidden rounded-lg border border-white/[0.06] bg-black/10">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-white/[0.03]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/60" />
                    <span className="flex-1 text-[11px] capitalize text-white/65">{sa.sourceType}</span>
                    <span className="text-[9px] text-white/25">{new Date(sa.generatedAt).toLocaleDateString()}</span>
                  </summary>
                  <div className="whitespace-pre-wrap border-t border-white/[0.05] px-3 pb-3 pt-1 text-[11px] leading-relaxed text-white/45">
                    {sa.analysis}
                  </div>
                </details>
              ))}
            </div>
          )}
          {activitySummary?.summary && (
            <div className="rounded-lg border border-amber-400/15 bg-amber-400/[0.04] p-3">
              <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-amber-200/50">
                Activity super-context
                <span className="ml-auto text-[9px] normal-case tracking-normal text-white/25">
                  {new Date(activitySummary.summary.generatedAt).toLocaleString()}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-white/50">{activitySummary.summary.summary}</p>
            </div>
          )}
          <div className="flex">{openLink('Open Activity', () => onOpenActivity(project.id), 'hover:text-amber-300')}</div>
        </div>
      )
    }

    if (project.name === 'Health') {
      return (
        <div className="space-y-3">
          {project.healthAnalysis?.summary && (
            <div className="rounded-lg border border-emerald-400/15 bg-emerald-400/[0.04] p-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-emerald-200/50">Health analysis</div>
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-white/50">{project.healthAnalysis.summary}</p>
            </div>
          )}
          <div className="flex">{openLink('Open Health', () => onOpenHealth(project.id), 'hover:text-emerald-300')}</div>
        </div>
      )
    }

    if (project.name === 'Psychology') {
      return (
        <div className="space-y-3">
          {project.analysis?.summary ? (
            <div className="rounded-lg border border-violet-400/15 bg-violet-400/[0.04] p-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-violet-200/50">Psychology analysis</div>
              <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-white/50">{project.analysis.summary}</p>
            </div>
          ) : (
            <p className="text-[11px] text-white/35">
              Take psychological tests in the Psychology project to generate an analysis.
            </p>
          )}
          <div className="flex">{openLink('Open Psychology', () => onOpenPsychology(project.id), 'hover:text-violet-300')}</div>
        </div>
      )
    }

    return null
  }

  const renderGroup = (group: SourceGroup, groupRows: Project[]) => (
    <div className="space-y-2">
      {groupRows.map((project, index) => {
        const { offsetY, animated, dragging } = dragOffset(group, index)
        return (
          <div
            key={project.id}
            ref={(node) => {
              if (node) rowRefs.current.set(project.id, node)
              else rowRefs.current.delete(project.id)
            }}
            className={`rounded-[10px] ${highlightProjectId === project.id ? 'ring-1 ring-holmes-primary/50' : ''}`}
          >
            <DataSourceRow
              project={project}
              summary={summaryFor(project.id)}
              status={
                // File System is never "indexed" — it grants access rather than
                // being a corpus — so its dot reports whether that access exists.
                isFileSystem(project)
                  ? (!scope || scope.mode === 'everywhere' || scope.roots.length > 0 ? 'connected' : 'empty')
                  : isLibraryProject(project)
                    ? libraryStatus(project)
                    : sourceStatus(project, summaryFor(project.id), Boolean(rowErrors[project.id]))
              }
              expanded={expandedProjectId === project.id}
              indexing={indexingProjectId === project.id}
              indexDisabledReason={
                isFileSystem(project)
                  ? 'This source sets where Holmes may read — index a specific source instead'
                  : isLibraryProject(project)
                  ? 'Books are read into the Library, not indexed as documents — use Scan library'
                  : !documentContextEnabled
                    ? 'Enable Document context in Settings'
                    : !project.path
                      ? 'Add a path first'
                      : indexRunActive
                        ? 'Another index run is in progress — only one can run at a time'
                        : null
              }
              pathOverride={isFileSystem(project) ? fileSystemPath() : undefined}
              personal={group === 'personal'}
              dragging={dragging}
              offsetY={offsetY}
              animated={animated}
              onToggleExpand={() => setExpandedProjectId((current) => (current === project.id ? null : project.id))}
              onIndex={() => void handleIndexProject(project)}
              onToggleVisible={() => void onUpdate(project.id, { visible: !project.visible })}
              onDelete={() => void handleDeleteSource(project)}
              onEditIdentity={() => setEditingProject(project)}
              onBrowsePath={() => void handleBrowsePath(project)}
              onSubmitPath={(value) => void handleAddPath(project, value)}
              onDragHandleDown={handleDragHandleDown(project, group, index)}
            >
              {renderExpansion(project)}
            </DataSourceRow>
          </div>
        )
      })}
    </div>
  )

  const renderExpansion = (project: Project) => {
    const summary = summaryFor(project.id)
    const rowError = rowErrors[project.id]
    // Scope and style are the user's own sources to decide about: the built-in
    // ones are what the life picture is made of.
    const personal = !isDefaultProjectName(project.name)
    if (isFileSystem(project)) {
      return (
        <div className="space-y-3 pl-4">
          <FileScopePanel />
        </div>
      )
    }

    // A library source gets no DocumentContextPanel: there is nothing to index,
    // and offering the control would misdescribe what the source does.
    if (isLibraryProject(project)) {
      return (
        <div className="space-y-3 pl-4">
          {rowError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-200/85">
              {rowError}
            </div>
          )}
          <BooksSourcePanel
            projectId={project.id}
            directoryRow={renderDirectoryRow(project)}
            icon={<ProjectIcon icon={project.icon} className="shrink-0 text-base" />}
            reloadKey={panelsReloadKey}
            onStats={(stats) => setLibraryStats((current) => ({ ...current, [project.id]: stats }))}
            onOpenLibrary={onOpenLibrary}
          />
        </div>
      )
    }

    return (
      <div className="space-y-3 pl-4">
        {personal && renderSourceSettings(project)}
        {rowError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-200/85">
            {rowError}
          </div>
        )}
        {(summary?.missingSources.length ?? 0) > 0 && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-200/85">
            {summary?.missingSources.length === 1 ? 'This directory is' : 'These directories are'} unreachable — the
            drive may be unplugged or the folder moved:
            <ul className="mt-1 space-y-0.5">
              {summary?.missingSources.map((path) => (
                <li key={path} className="truncate font-mono text-[10px] text-red-200/70">{path}</li>
              ))}
            </ul>
          </div>
        )}

        <DocumentContextPanel
          projectId={project.id}
          projectName={project.name}
          enabled={documentContextEnabled}
          hasDirectory={Boolean(project.path)}
          defaultTier={settings?.defaultTier ?? 'mid'}
          onIndexed={() => void refreshSummaries()}
          reloadKey={panelsReloadKey}
          icon={<ProjectIcon icon={project.icon} className="shrink-0 text-base" />}
          directoryRow={renderDirectoryRow(project)}
          footer={renderSourceAnalysis(project)}
        />

        {project.name === 'Activity' && activityProject && (
          <ActivityAccountsPanel
            projectId={activityProject.id}
            progress={activityProgress}
            onChanged={() => {
              void refreshActivityRecords()
            }}
          />
        )}

        {project.name === 'Activity' && activityProject && (
          <ActivitySourcesPanel
            projectId={activityProject.id}
            records={activityRecords}
            progress={activityProgress}
            onIngest={handleActivityIngest}
            onAbort={handleActivityAbort}
            onDelete={handleActivityDelete}
            onRefresh={() => void refreshActivityRecords()}
            onLiveSync={handleActivityLiveSync}
            liveBusy={activityLiveBusy}
            onScanDirectory={async () => {
              await window.electronAPI.activity.scanDirectory(activityProject.id)
              await refreshActivityRecords()
              await refreshActivitySummary()
            }}
            scanning={scanningProjectId === activityProject.id}
            hasDirectory={Boolean(activityProject.path)}
          />
        )}

        {project.name === 'Health' && healthProject && (
          <HealthSourcesPanel
            records={healthRecords}
            progress={healthProgress}
            onIngest={handleHealthIngest}
            onAbort={handleHealthAbort}
            onDelete={handleHealthDelete}
            onRefresh={() => void refreshHealthRecords()}
            onLiveSync={handleHealthLiveSync}
            liveBusy={healthLiveBusy}
            onScanDirectory={async () => {
              await window.electronAPI.health.scanDirectory(healthProject.id)
              await refreshHealthRecords()
            }}
            scanning={scanningProjectId === healthProject.id}
            hasDirectory={Boolean(healthProject.path)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-holmes-bg">
      <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-white/[0.06] bg-holmes-bg/95 px-6 py-3.5 backdrop-blur">
        <FontAwesomeIcon icon={faDatabase} className="text-[25px] text-holmes-primary" />
        <h1 className="font-serif-display text-[27px] leading-none text-white/85">Data</h1>
        <div className="ml-auto flex items-center gap-2">
          <ProjectVisibilityMenu
            projects={projects}
            onToggle={(projectId, visible) => void onUpdate(projectId, { visible })}
          />
          <button
            onClick={() => setBulkOpen(true)}
            title="Index several sources in one run"
            className="flex h-[30px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 cursor-pointer"
          >
            <FontAwesomeIcon icon={faMagnifyingGlassChart} className="text-[13px]" />
            Bulk Index
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-6 py-5">
        {activityNeedsAttention > 0 && (
          <div className="mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs text-amber-200/80">
            {activityNeedsAttention} activity source{activityNeedsAttention === 1 ? ' needs' : 's need'} attention —
            expand the Activity source below.
          </div>
        )}

        {(indexRunActive || batchPaused) && (
          <button
            onClick={() => setBulkOpen(true)}
            className="mb-3 flex w-full items-center gap-2 rounded-xl border border-holmes-primary/20 bg-holmes-primary/[0.06] px-3 py-2 text-left text-[11px] text-holmes-primary-light transition-colors hover:border-holmes-primary/40 cursor-pointer"
          >
            <FontAwesomeIcon icon={faRefresh} className={`text-[10px] ${indexRunActive ? 'animate-spin' : ''}`} />
            <span className="min-w-0 flex-1 truncate">
              {batchPaused
                ? indexState?.message ?? 'Indexing paused.'
                : `${indexState?.projectName ?? 'Indexing'} — ${indexState?.progress?.message ?? 'working…'}`}
            </span>
            <span className="shrink-0 text-white/35">Open</span>
          </button>
        )}

        {!documentContextEnabled && (
          <div className="mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-200/75">
            Document context is off — paths can be connected, but nothing will be indexed until it is enabled in Settings.
          </div>
        )}

        {renderGroup('life', lifeRows)}
        {mediaRows.length > 0 && (
          <>
            <div className="mb-2 mt-6 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-white/25">Media sources</span>
              <span className="h-px flex-1 bg-white/[0.06]" />
            </div>
            {renderGroup('media', mediaRows)}
          </>
        )}
        {(personalRows.length > 0 || lifeRows.length > 0) && (
          <div className="mb-2 mt-6 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-white/25">Personal projects</span>
            <span className="h-px flex-1 bg-white/[0.06]" />
          </div>
        )}
        {personalRows.length > 0 ? (
          renderGroup('personal', personalRows)
        ) : (
          <p className="px-1 text-[11px] text-white/25">
            None yet — add one below and it stays out of the life sources above.
          </p>
        )}

        <div className="flex justify-center pb-2 pt-6">
          <button
            onClick={() => { setCreatingSource(true); setCreateError(null) }}
            className="group flex flex-col items-center gap-1.5 cursor-pointer"
            title="Add a new data source"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.06] text-white/40 transition-colors group-hover:bg-white/[0.1] group-hover:text-white/70">
              <FontAwesomeIcon icon={faPlus} className="text-[18px]" />
            </span>
            <span className="text-[11px] text-white/30 transition-colors group-hover:text-white/55">Add New Source</span>
          </button>
        </div>

      </div>

      {bulkOpen && (
        <BulkIndexDialog
          projects={connectedRows}
          enabled={documentContextEnabled}
          defaultTier={settings?.defaultTier ?? 'mid'}
          onClose={() => setBulkOpen(false)}
          onIndexed={() => {
            setPanelsReloadKey((k) => k + 1)
            void refreshSummaries()
          }}
        />
      )}

      {creatingSource && (
        <SourceDialog
          mode="create"
          initialColor={PROJECT_COLOR_OPTIONS[0]}
          busy={creatingBusy}
          error={createError}
          onSelectImage={onSelectImage}
          onSubmit={(value) => void handleCreateSource(value)}
          onClose={() => { setCreatingSource(false); setCreateError(null) }}
        />
      )}

      {editingProject && (
        <SourceDialog
          mode="edit"
          initialName={editingProject.name}
          initialIcon={editingProject.icon}
          initialColor={editingProject.color}
          onSelectImage={onSelectImage}
          onSubmit={(value) => void handleEditSource(value)}
          onClose={() => setEditingProject(null)}
        />
      )}
    </div>
  )
}
