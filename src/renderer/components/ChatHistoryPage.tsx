import { type FC, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCirclePlus, faClockRotateLeft, faMagnifyingGlass, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { Conversation, Project } from '@shared/types'
import { ProjectIcon } from './ProjectIcon'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'

interface ChatHistoryPageProps {
  conversations: Conversation[]
  projects: Project[]
  currentConversationId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

/** null is the "General" bucket — conversations filed under no project. */
type ProjectFilter = string | null | 'all'

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayHeading(dayStart: number): string {
  const today = new Date()
  const todayStart = startOfDay(today.getTime())
  if (dayStart === todayStart) return 'Today'
  if (dayStart === todayStart - 86_400_000) return 'Yesterday'
  return new Date(dayStart).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: new Date(dayStart).getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

/**
 * Every conversation, newest first and grouped by day.
 *
 * The sidebar only shows as many recent chats as fit without scrolling; this is
 * where the rest of them live. Selecting, renaming and deleting all go through
 * the same handlers the sidebar uses, so the two views never disagree.
 */
export const ChatHistoryPage: FC<ChatHistoryPageProps> = ({
  conversations,
  projects,
  currentConversationId,
  onSelect,
  onNew,
  onDelete,
  onRename,
}) => {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ProjectFilter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const conversationProjectIds = (conv: Conversation): string[] =>
    conv.projectIds?.length ? conv.projectIds : conv.projectId ? [conv.projectId] : []

  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  )

  const days = useMemo(() => {
    const query = search.trim().toLowerCase()
    const matching = conversations
      .filter((conv) => {
        if (query && !conv.title.toLowerCase().includes(query)) return false
        if (filter === 'all') return true
        const ids = conversationProjectIds(conv)
        return filter === null ? ids.length === 0 : ids.includes(filter)
      })
      .sort((a, b) => b.createdAt - a.createdAt)

    const grouped: Array<{ dayStart: number; conversations: Conversation[] }> = []
    for (const conv of matching) {
      const dayStart = startOfDay(conv.createdAt)
      const last = grouped[grouped.length - 1]
      if (last && last.dayStart === dayStart) last.conversations.push(conv)
      else grouped.push({ dayStart, conversations: [conv] })
    }
    return grouped
  }, [conversations, projects, search, filter])

  const total = days.reduce((count, day) => count + day.conversations.length, 0)

  const handleRenameConfirm = () => {
    if (editingId && editTitle.trim()) onRename(editingId, editTitle.trim())
    setEditingId(null)
  }

  const filterChipClass = (active: boolean): string =>
    `flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors cursor-pointer ${
      active
        ? 'border-holmes-primary/40 bg-holmes-primary/10 text-holmes-primary-light'
        : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/70'
    }`

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faClockRotateLeft} className={PAGE_HEADER_ICON} />}
        title="Chat History"
        aside={
          <span className="text-[11px] tabular-nums text-white/30">
            {total} {total === 1 ? 'conversation' : 'conversations'}
          </span>
        }
        actions={
          <button
            onClick={onNew}
            className="flex h-7 items-center gap-2 rounded-md border border-white/10 px-2.5 text-[11px] text-white/40 transition-colors hover:border-white/25 hover:text-white/70 cursor-pointer"
          >
            <FontAwesomeIcon icon={faCirclePlus} className="text-[10px]" />
            New Conversation
          </button>
        }
        below={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <FontAwesomeIcon
                icon={faMagnifyingGlass}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-white/25"
              />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearch('')
                }}
                placeholder="Filter by title…"
                className="h-6 w-64 rounded-md border border-white/10 bg-white/[0.03] pl-7 pr-2 text-[12px] text-white/75 outline-none transition-colors placeholder:text-white/25 focus:border-white/25"
              />
            </div>
            <button onClick={() => setFilter('all')} className={filterChipClass(filter === 'all')}>
              All
            </button>
            <button onClick={() => setFilter(null)} className={filterChipClass(filter === null)}>
              General
            </button>
            {projects
              .filter((project) => project.visible)
              .map((project) => (
                <button
                  key={project.id}
                  onClick={() => setFilter(project.id)}
                  className={filterChipClass(filter === project.id)}
                >
                  <ProjectIcon icon={project.icon} className="text-[10px]" />
                  <span className="max-w-32 truncate">{project.name}</span>
                </button>
              ))}
          </div>
        }
      />

      <div className="mx-auto w-full max-w-3xl px-6 py-5">
        {total === 0 ? (
          <div className="py-16 text-center text-sm text-white/30">
            {conversations.length === 0 ? 'No conversations yet' : 'No conversations match this filter'}
          </div>
        ) : (
          days.map((day) => (
            <div key={day.dayStart} className="mb-6">
              <div className="mb-2 px-2 text-[11px] uppercase tracking-wide text-white/30">
                {dayHeading(day.dayStart)}
              </div>
              <div className="rounded-md border border-white/[0.06] bg-white/[0.02]">
                {day.conversations.map((conv, index) => {
                  const projectChips = conversationProjectIds(conv)
                    .map((id) => projectsById.get(id))
                    .filter((project): project is Project => Boolean(project))
                  return (
                    <div
                      key={conv.id}
                      onClick={() => onSelect(conv.id)}
                      className={`group flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-white/[0.04] ${
                        index > 0 ? 'border-t border-white/[0.05]' : ''
                      } ${conv.id === currentConversationId ? 'text-white' : 'text-white/60'}`}
                    >
                      <span className="w-14 shrink-0 text-[10px] tabular-nums text-white/25">
                        {new Date(conv.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                      {editingId === conv.id ? (
                        <input
                          autoFocus
                          value={editTitle}
                          onChange={(event) => setEditTitle(event.target.value)}
                          onBlur={handleRenameConfirm}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') handleRenameConfirm()
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="min-w-0 flex-1 rounded border border-white/30 bg-transparent px-1 py-0.5 text-sm text-white outline-none"
                        />
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate"
                          title="Double-click to rename"
                          onDoubleClick={(event) => {
                            event.stopPropagation()
                            setEditingId(conv.id)
                            setEditTitle(conv.title)
                          }}
                        >
                          {conv.title}
                        </span>
                      )}
                      {projectChips.map((project) => (
                        <span
                          key={project.id}
                          className="flex h-5 shrink-0 items-center gap-1 rounded bg-white/[0.06] px-1.5 text-[10px] text-white/40"
                          title={project.name}
                        >
                          <ProjectIcon icon={project.icon} className="text-[9px]" />
                          <span className="max-w-24 truncate">{project.name}</span>
                        </span>
                      ))}
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          if (window.confirm(`Delete the conversation "${conv.title}"? This cannot be undone.`)) {
                            onDelete(conv.id)
                          }
                        }}
                        className="shrink-0 opacity-0 text-white/35 transition-all hover:text-red-300 group-hover:opacity-100 cursor-pointer"
                        aria-label={`Delete ${conv.title}`}
                        title="Delete conversation"
                      >
                        <FontAwesomeIcon icon={faXmark} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
