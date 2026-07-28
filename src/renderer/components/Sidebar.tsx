import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBagShopping, faBookOpen, faBriefcase, faCaretDown, faCirclePlus, faDatabase, faDiagramProject, faFloppyDisk, faGavel, faLightbulb, faMagnifyingGlass, faPause, faReceipt, faRefresh, faSpa, faStop, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { Conversation, DocumentIndexState, Project } from '@shared/types'
import lifeIcon from '../../../assets/lifeIcon.svg'
import { ProjectIcon } from './ProjectIcon'
import { useDocumentIndexState } from '../hooks/useDocumentIndex'
import { useTimelineRunState } from '../hooks/useTimelineRun'
import { usePeopleRunState } from '../hooks/usePeopleRun'
import { useActivityRunState } from '../hooks/useActivityRun'
import { useLibraryRun } from '../hooks/useLibraryRun'

type SidebarSection = 'recall' | 'projects' | 'dashboard' | 'data' | 'product-search' | 'mental-coach' | 'memory' | 'timeline' | 'library' | 'call-history' | null

interface SidebarProps {
  conversations: Conversation[]
  projects: Project[]
  currentConversationId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onRecall: () => void
  onProjects: () => void
  onDashboard: () => void
  onData: () => void
  onProductSearch: () => void
  onMentalCoach: () => void
  onMemory: () => void
  onTimeline: () => void
  onLibrary: () => void
  onCallHistory: () => void
  onOpenIndexRun: (projectId: string | null) => void
  activeSection: SidebarSection
}

export const Sidebar: FC<SidebarProps> = ({
  conversations,
  projects,
  currentConversationId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onRecall,
  onProjects,
  onDashboard,
  onData,
  onProductSearch,
  onMentalCoach,
  onMemory,
  onTimeline,
  onLibrary,
  onCallHistory,
  onOpenIndexRun,
  activeSection,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  // The conversation list is filtered by project: "General" is everything not
  // tied to one, which is where a plain new chat lands.
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const indexState = useDocumentIndexState()
  const timelineState = useTimelineRunState()
  const peopleState = usePeopleRunState()
  const activityState = useActivityRunState()
  const libraryState = useLibraryRun()

  useEffect(() => {
    if (!filterOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [filterOpen])

  // A project that has been hidden on the Data page is not a filter option.
  const filterProjects = projects.filter((project) => project.visible)
  const activeFilter = filterProjects.find((project) => project.id === filterProjectId) ?? null

  useEffect(() => {
    if (filterProjectId && !activeFilter) setFilterProjectId(null)
  }, [filterProjectId, activeFilter])

  const handleDoubleClick = (conv: Conversation) => {
    setEditingId(conv.id)
    setEditTitle(conv.title)
  }

  const sortedConv = [...conversations].sort((a, b) => b.createdAt - a.createdAt)

  // A conversation whose context stacks several projects is filed under each of
  // them, so it shows in every one of those lists.
  const conversationProjectIds = (conv: Conversation): string[] =>
    conv.projectIds?.length ? conv.projectIds : conv.projectId ? [conv.projectId] : []
  const selectedConv = sortedConv.filter((conv) => {
    const ids = conversationProjectIds(conv)
    return filterProjectId ? ids.includes(filterProjectId) : ids.length === 0
  })

  const handleRenameConfirm = () => {
    if (editingId && editTitle.trim()) {
      onRename(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  const toolButtonClass =
    'flex h-[30px] w-full items-center gap-3 rounded-md px-2 text-sm text-[#9b948f] transition-colors'

  const indexStatus = indexState?.status ?? 'idle'
  const indexRunning = indexStatus === 'running'
  const indexStopping = indexStatus === 'stopping'
  const indexPaused = indexStatus === 'paused'
  const indexVisible = indexRunning || indexStopping || indexPaused
  const indexProgress = indexRunning || indexStopping ? indexState?.progress ?? null : null
  const indexTarget =
    indexState?.scope === 'user'
      ? 'User context'
      : indexState?.projectName ?? (indexState?.scope === 'all' ? 'All projects' : 'Documents')
  const indexBatchPosition =
    indexProgress?.batchLabel && indexProgress.batchLabel !== 'Done'
      ? indexProgress.batchLabel.split(':')[0].trim()
      : null
  const indexCounts =
    indexProgress?.total != null && indexProgress.total > 0
      ? `${indexProgress.current ?? 0}/${indexProgress.total}`
      : null
  const indexFraction =
    indexProgress?.total != null && indexProgress.total > 0
      ? Math.min(1, Math.max(0, (indexProgress.current ?? 0) / indexProgress.total))
      : null
  const indexHeadline = indexPaused
    ? 'Indexing paused'
    : indexStopping
      ? indexState?.pendingAction === 'pause'
        ? 'Pausing index'
        : 'Stopping index'
      : indexState?.origin === 'timer'
        ? 'Indexing in background'
        : 'Indexing'
  const indexDetail = indexPaused
    ? indexState?.message ?? 'Paused — open Data to resume.'
    : indexProgress?.message ?? 'Preparing…'
  const indexIcon = indexPaused ? faPause : indexStopping ? faStop : faRefresh
  const indexAriaLabel = `${indexHeadline}: ${indexTarget}${indexBatchPosition ? ` (${indexBatchPosition})` : ''}${
    indexCounts ? ` — ${indexCounts}` : ''
  }. Open this folder on the Data page.`

  // The timeline rebuild is a separate subsystem and can run alongside indexing,
  // so it gets its own row rather than competing for one.
  // Narration, annotation and lesson runs all report through the library run
  // registry, so one strip covers them — the message says which.
  const libraryRunning = libraryState?.status === 'scanning' || libraryState?.status === 'generating'
  const libraryProgress = libraryRunning ? libraryState?.progress ?? null : null
  const libraryHeadline =
    libraryState?.status === 'scanning'
      ? libraryState.origin === 'timer' ? 'Scanning library in background' : 'Scanning library'
      : 'Working on a book'
  const libraryDetail = libraryProgress?.message ?? 'Working…'
  const libraryCounts =
    libraryProgress && libraryProgress.total !== null && libraryProgress.total > 0
      ? `${libraryProgress.current}/${libraryProgress.total}`
      : null
  const libraryFraction =
    libraryProgress && libraryProgress.total !== null && libraryProgress.total > 0
      ? Math.min(1, libraryProgress.current / libraryProgress.total)
      : null
  const libraryAriaLabel = `${libraryHeadline}. ${libraryDetail}`

  // Reading every activity event is dozens of sequential calls over minutes, so
  // the run needs to be visible even when nobody is on the Activity page.
  const activityRunning = activityState?.status === 'running'
  const activityProgress = activityRunning ? activityState?.progress ?? null : null
  const activityHeadline =
    activityState?.origin === 'timer' ? 'Analyzing activity in background' : 'Analyzing activity'
  const activityCounts =
    activityProgress?.total != null && activityProgress.total > 0
      ? `${activityProgress.current}/${activityProgress.total}`
      : null
  const activityFraction =
    activityProgress?.total != null && activityProgress.total > 0
      ? Math.min(1, Math.max(0, activityProgress.current / activityProgress.total))
      : null
  const activityDetail = activityProgress?.message ?? 'Preparing…'
  const activityAriaLabel = `${activityHeadline}${activityCounts ? ` (${activityCounts})` : ''}`

  const timelineRunning = timelineState?.status === 'running'
  const timelineProgress = timelineRunning ? timelineState?.progress ?? null : null
  const timelineCounts =
    timelineProgress?.total != null && timelineProgress.total > 0
      ? `${timelineProgress.current ?? 0}/${timelineProgress.total}`
      : null
  const timelineFraction =
    timelineProgress?.total != null && timelineProgress.total > 0
      ? Math.min(1, Math.max(0, (timelineProgress.current ?? 0) / timelineProgress.total))
      : null
  const timelineHeadline = timelineState?.origin === 'timer' ? 'Rebuilding timeline in background' : 'Rebuilding timeline'
  const timelineDetail = timelineProgress?.message ?? 'Preparing…'
  const timelineAriaLabel = `${timelineHeadline}${timelineCounts ? ` — ${timelineCounts}` : ''}. ${timelineDetail}`

  // People rebuilds alongside both of the above and, like document indexing, can
  // be paused — so it shows the same paused and stopping states rather than only
  // appearing while it happens to be running.
  const peopleStatus = peopleState?.status ?? 'idle'
  const peopleRunning = peopleStatus === 'running'
  const peopleStopping = peopleStatus === 'stopping'
  const peoplePaused = peopleStatus === 'paused'
  const peopleVisible = peopleRunning || peopleStopping || peoplePaused
  const peopleProgress = peopleRunning || peopleStopping ? peopleState?.progress ?? null : null
  const peopleCounts =
    peopleProgress?.total != null && peopleProgress.total > 0
      ? `${peopleProgress.current ?? 0}/${peopleProgress.total}`
      : null
  const peopleFraction =
    peopleProgress?.total != null && peopleProgress.total > 0
      ? Math.min(1, Math.max(0, (peopleProgress.current ?? 0) / peopleProgress.total))
      : null
  const peopleHeadline = peoplePaused
    ? 'People index paused'
    : peopleStopping
      ? peopleState?.pendingAction === 'pause'
        ? 'Pausing People'
        : 'Stopping People'
      : peopleState?.origin === 'timer'
        ? 'Indexing people in background'
        : 'Indexing people'
  const peopleDetail = peoplePaused
    ? peopleState?.message ?? 'Paused — open the Dashboard to resume.'
    : peopleProgress?.message ?? 'Preparing…'
  const peopleIcon = peoplePaused ? faPause : peopleStopping ? faStop : faRefresh
  const peopleAriaLabel = `${peopleHeadline}${peopleCounts ? ` — ${peopleCounts}` : ''}. ${peopleDetail} Open the Dashboard.`

  return (
    <aside className="relative z-10 -mt-7 ml-1 flex h-[calc(100%+28px)] w-60 shrink-0 flex-col overflow-hidden rounded-t-[26px] border border-[#56554f] bg-[#252321] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      <div className="h-9 shrink-0" />

      <div className="mx-3 grid h-[26px] shrink-0 grid-cols-3 overflow-hidden rounded-md bg-[#322f2d] text-[13px]">
        <button
          className="flex items-center justify-center gap-1.5 rounded-[5px] border border-[#918b86] bg-[#69645f] text-white shadow-sm"
          aria-pressed="true"
        >
          <FontAwesomeIcon icon={faLightbulb} className="text-[11px]" />
          Think
        </button>
        <button
          disabled
          title="Work mode coming soon"
          className="border-l border-black/15 text-[#77716d] cursor-not-allowed"
        >
          Work
        </button>
        <button
          disabled
          title="Code mode coming soon"
          className="border-l border-black/15 text-[#77716d] cursor-not-allowed"
        >
          Code
        </button>
      </div>

      <nav className="mt-2 shrink-0 px-3" aria-label="Primary navigation">
        <button
          onClick={onNew}
          className={`${toolButtonClass} hover:bg-white/[0.04] hover:text-[#c7c0bb] cursor-pointer`}
        >
          <FontAwesomeIcon icon={faCirclePlus} className="w-4 shrink-0" />
          New Conversation
        </button>
        <button
          onClick={onRecall}
          className={`${toolButtonClass} ${
            activeSection === 'recall'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faMagnifyingGlass} className="w-4 shrink-0" />
          Recall
        </button>
        <button
          onClick={onDashboard}
          className={`${toolButtonClass} ${
            activeSection === 'dashboard'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <img src={lifeIcon} alt="" className="h-4 w-4 shrink-0" />
          Life Dashboard
        </button>
        <button
          onClick={onData}
          className={`${toolButtonClass} ${
            activeSection === 'data'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faDatabase} className="w-4 shrink-0" />
          Data Sources
        </button>
        <button
          onClick={onTimeline}
          className={`${toolButtonClass} ${
            activeSection === 'timeline'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faDiagramProject} className="w-4 shrink-0" />
          Timeline
        </button>
        <button
          onClick={onLibrary}
          className={`${toolButtonClass} ${
            activeSection === 'library'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faBookOpen} className="w-4 shrink-0" />
          Library
        </button>
        <button
          onClick={onProductSearch}
          className={`${toolButtonClass} ${
            activeSection === 'product-search'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faBagShopping} className="w-4 shrink-0" />
          Product Search
        </button>
        <button
          onClick={onMentalCoach}
          className={`${toolButtonClass} ${
            activeSection === 'mental-coach'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faSpa} className="w-4 shrink-0" />
          Mental Coach
        </button>
        <button
          disabled
          title="Casebook coming soon"
          className={`${toolButtonClass} cursor-not-allowed`}
        >
          <FontAwesomeIcon icon={faBriefcase} className="w-4 shrink-0" />
          Casebook
        </button>
        <button
          disabled
          title="Decision Room coming soon"
          className={`${toolButtonClass} cursor-not-allowed`}
        >
          <FontAwesomeIcon icon={faGavel} className="w-4 shrink-0" />
          Decision Room
        </button>
        <button
          onClick={onMemory}
          className={`${toolButtonClass} ${
            activeSection === 'memory'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faFloppyDisk} className="w-4 shrink-0" />
          Memory
        </button>
        <button
          onClick={onCallHistory}
          className={`${toolButtonClass} ${
            activeSection === 'call-history'
              ? 'bg-holmes-primary/10 text-holmes-primary-light'
              : 'hover:bg-white/[0.04] hover:text-[#c7c0bb]'
          } cursor-pointer`}
        >
          <FontAwesomeIcon icon={faReceipt} className="w-4 shrink-0" />
          Call History
        </button>
      </nav>

      <div className="mx-5 my-3 shrink-0 border-t border-[#3d3d39]" />

      <div ref={filterRef} className="relative mx-3 mb-2 shrink-0">
        <button
          onClick={() => setFilterOpen((open) => !open)}
          aria-expanded={filterOpen}
          title="Filter conversations by project"
          className="flex h-[26px] w-full items-center gap-2 rounded-md border border-[#56544f] bg-[#3a3733] px-2.5 text-[13px] text-[#b3aca7] transition-colors hover:border-[#6b6862] cursor-pointer"
        >
          {activeFilter && <ProjectIcon icon={activeFilter.icon} className="shrink-0 text-[12px]" />}
          <span className="min-w-0 flex-1 truncate text-left">{activeFilter?.name ?? 'General'}</span>
          <FontAwesomeIcon icon={faCaretDown} className="shrink-0 text-[11px] text-[#8b857f]" />
        </button>

        {filterOpen && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-white/10 bg-holmes-surface py-1 shadow-2xl scrollbar-thin">
            <button
              onClick={() => { setFilterProjectId(null); setFilterOpen(false) }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors cursor-pointer ${
                filterProjectId === null ? 'bg-holmes-primary/15 text-holmes-primary-light' : 'text-white/70 hover:bg-white/5'
              }`}
            >
              General
            </button>
            {filterProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => { setFilterProjectId(project.id); setFilterOpen(false) }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors cursor-pointer ${
                  filterProjectId === project.id ? 'bg-holmes-primary/15 text-holmes-primary-light' : 'text-white/70 hover:bg-white/5'
                }`}
              >
                <ProjectIcon icon={project.icon} className="shrink-0 text-[12px]" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </button>
            ))}
            <div className="my-1 border-t border-white/[0.07]" />
            <button
              onClick={() => { setFilterOpen(false); onProjects() }}
              className="w-full px-2.5 py-1.5 text-left text-[12px] text-white/40 transition-colors hover:bg-white/5 hover:text-white/70 cursor-pointer"
            >
              Manage projects…
            </button>
          </div>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {selectedConv.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-white/30">
            {filterProjectId ? 'No conversations in this project' : 'No conversations yet'}
          </div>
        ) : (
          selectedConv.map((conv) => (
            <div
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`group mb-0.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors cursor-pointer ${
                activeSection === null && conv.id === currentConversationId
                  ? 'bg-white/10 text-white'
                  : 'text-white/55 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              {editingId === conv.id ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={handleRenameConfirm}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameConfirm()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="flex-1 rounded border border-white/30 bg-transparent px-1 py-0.5 text-sm text-white outline-none"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  {conv.projectId && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" title="Project context conversation" />
                  )}
                  <span
                    className="flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      handleDoubleClick(conv)
                    }}
                  >
                    {conv.title}
                  </span>
                </div>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`Delete the conversation "${conv.title}"? This cannot be undone.`)) {
                    onDelete(conv.id)
                  }
                }}
                className="opacity-0 text-white/35 transition-all hover:text-red-300 group-hover:opacity-100 cursor-pointer"
                aria-label={`Delete ${conv.title}`}
                title="Delete conversation"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
          ))
        )}
      </div>

      {indexVisible && (
        <div className="shrink-0 border-t border-white/10 bg-holmes-surface px-2 py-2">
          <button
            onClick={() => onOpenIndexRun(indexState?.projectId ?? null)}
            title={indexAriaLabel}
            aria-label={indexAriaLabel}
            className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
          >
            <div className="flex w-full items-center gap-2">
              <FontAwesomeIcon
                icon={indexIcon}
                className={`w-3 shrink-0 text-[10px] ${
                  indexPaused ? 'text-amber-300/70' : indexStopping ? 'text-amber-300/70' : 'text-cyan-300/70 animate-spin'
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">{indexHeadline}</span>
              {indexCounts && <span className="shrink-0 text-[10px] tabular-nums text-white/40">{indexCounts}</span>}
            </div>
            <div className="flex w-full items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[10px] text-white/40" title={indexTarget}>
                {indexTarget}
              </span>
              {indexBatchPosition && (
                <span className="shrink-0 text-[10px] text-white/30">{indexBatchPosition}</span>
              )}
            </div>
            {indexFraction !== null && (
              <div className="h-[2px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-all ${indexPaused || indexStopping ? 'bg-amber-300/50' : 'bg-cyan-300/60'}`}
                  style={{ width: `${Math.round(indexFraction * 100)}%` }}
                />
              </div>
            )}
            <span className="w-full truncate text-[10px] text-white/30" title={indexDetail}>
              {indexDetail}
            </span>
          </button>
        </div>
      )}

      {activityRunning && (
        <div className={`shrink-0 bg-holmes-surface px-2 py-2 ${indexVisible ? 'border-t border-white/[0.06]' : 'border-t border-white/10'}`}>
          <button
            onClick={onDashboard}
            title={activityAriaLabel}
            aria-label={activityAriaLabel}
            className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
          >
            <div className="flex w-full items-center gap-2">
              <FontAwesomeIcon icon={faRefresh} className="w-3 shrink-0 animate-spin text-[10px] text-amber-300/70" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">{activityHeadline}</span>
              {activityCounts && (
                <span className="shrink-0 text-[10px] tabular-nums text-white/40">{activityCounts}</span>
              )}
            </div>
            {activityFraction !== null && (
              <div className="h-[2px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-amber-300/60 transition-all"
                  style={{ width: `${Math.round(activityFraction * 100)}%` }}
                />
              </div>
            )}
            <span className="w-full truncate text-[10px] text-white/30" title={activityDetail}>
              {activityDetail}
            </span>
          </button>
        </div>
      )}

      {timelineRunning && (
        <div className={`shrink-0 bg-holmes-surface px-2 py-2 ${indexVisible ? 'border-t border-white/[0.06]' : 'border-t border-white/10'}`}>
          <button
            onClick={onTimeline}
            title={timelineAriaLabel}
            aria-label={timelineAriaLabel}
            className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
          >
            <div className="flex w-full items-center gap-2">
              <FontAwesomeIcon icon={faRefresh} className="w-3 shrink-0 animate-spin text-[10px] text-amber-300/70" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">{timelineHeadline}</span>
              {timelineCounts && (
                <span className="shrink-0 text-[10px] tabular-nums text-white/40">{timelineCounts}</span>
              )}
            </div>
            {timelineFraction !== null && (
              <div className="h-[2px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-amber-300/60 transition-all"
                  style={{ width: `${Math.round(timelineFraction * 100)}%` }}
                />
              </div>
            )}
            <span className="w-full truncate text-[10px] text-white/30" title={timelineDetail}>
              {timelineDetail}
            </span>
          </button>
        </div>
      )}

      {libraryRunning && (
        <div className={`shrink-0 bg-holmes-surface px-2 py-2 ${indexVisible || timelineRunning ? 'border-t border-white/[0.06]' : 'border-t border-white/10'}`}>
          <button
            onClick={onLibrary}
            title={libraryAriaLabel}
            aria-label={libraryAriaLabel}
            className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
          >
            <div className="flex w-full items-center gap-2">
              <FontAwesomeIcon icon={faRefresh} className="w-3 shrink-0 animate-spin text-[10px] text-violet-300/70" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">{libraryHeadline}</span>
              {libraryCounts && (
                <span className="shrink-0 text-[10px] tabular-nums text-white/40">{libraryCounts}</span>
              )}
            </div>
            {libraryFraction !== null && (
              <div className="h-[2px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-violet-300/60 transition-all"
                  style={{ width: `${Math.round(libraryFraction * 100)}%` }}
                />
              </div>
            )}
            <span className="w-full truncate text-[10px] text-white/30" title={libraryDetail}>
              {libraryDetail}
            </span>
          </button>
        </div>
      )}

      {peopleVisible && (
        <div className={`shrink-0 bg-holmes-surface px-2 py-2 ${indexVisible || timelineRunning ? 'border-t border-white/[0.06]' : 'border-t border-white/10'}`}>
          <button
            onClick={onDashboard}
            title={peopleAriaLabel}
            aria-label={peopleAriaLabel}
            className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
          >
            <div className="flex w-full items-center gap-2">
              <FontAwesomeIcon
                icon={peopleIcon}
                className={`w-3 shrink-0 text-[10px] ${
                  peoplePaused || peopleStopping ? 'text-amber-300/70' : 'text-rose-300/70 animate-spin'
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/55">{peopleHeadline}</span>
              {peopleCounts && (
                <span className="shrink-0 text-[10px] tabular-nums text-white/40">{peopleCounts}</span>
              )}
            </div>
            {peopleFraction !== null && (
              <div className="h-[2px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className={`h-full rounded-full transition-all ${peoplePaused || peopleStopping ? 'bg-amber-300/50' : 'bg-rose-300/60'}`}
                  style={{ width: `${Math.round(peopleFraction * 100)}%` }}
                />
              </div>
            )}
            <span className="w-full truncate text-[10px] text-white/30" title={peopleDetail}>
              {peopleDetail}
            </span>
          </button>
        </div>
      )}
    </aside>
  )
}
