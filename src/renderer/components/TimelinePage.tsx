import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRotateRight, faBoxArchive, faFileLines, faPlus, faTimeline, faXmark } from '@fortawesome/free-solid-svg-icons'
import type {
  ContextVersion,
  Project,
  TimelineCategory,
  TimelineEvent,
  TimelineRebuildProgress,
  TimelineSummary,
  TimelineYearContext,
} from '@shared/types'
import {
  TIMELINE_ALL_CATEGORIES,
  TIMELINE_CATEGORIES,
  formatTimelineDate,
  formatTimelineRange,
  groupTimelineByYear,
} from '@shared/timeline'
import { useSettings } from '../hooks/useSettings'

interface TimelinePageProps {
  onBack: () => void
}

const CATEGORY_STYLE: Record<TimelineCategory, { dot: string; chip: string; text: string }> = {
  milestone: { dot: 'bg-amber-300', chip: 'border-amber-400/40 bg-amber-400/10', text: 'text-amber-200/90' },
  health: { dot: 'bg-emerald-400', chip: 'border-emerald-400/40 bg-emerald-400/10', text: 'text-emerald-200/90' },
  training: { dot: 'bg-lime-400', chip: 'border-lime-400/40 bg-lime-400/10', text: 'text-lime-200/90' },
  work: { dot: 'bg-sky-400', chip: 'border-sky-400/40 bg-sky-400/10', text: 'text-sky-200/90' },
  education: { dot: 'bg-indigo-400', chip: 'border-indigo-400/40 bg-indigo-400/10', text: 'text-indigo-200/90' },
  finance: { dot: 'bg-teal-400', chip: 'border-teal-400/40 bg-teal-400/10', text: 'text-teal-200/90' },
  travel: { dot: 'bg-orange-400', chip: 'border-orange-400/40 bg-orange-400/10', text: 'text-orange-200/90' },
  relationships: { dot: 'bg-rose-400', chip: 'border-rose-400/40 bg-rose-400/10', text: 'text-rose-200/90' },
  media: { dot: 'bg-fuchsia-400', chip: 'border-fuchsia-400/40 bg-fuchsia-400/10', text: 'text-fuchsia-200/90' },
  technology: { dot: 'bg-cyan-400', chip: 'border-cyan-400/40 bg-cyan-400/10', text: 'text-cyan-200/90' },
  home: { dot: 'bg-violet-400', chip: 'border-violet-400/40 bg-violet-400/10', text: 'text-violet-200/90' },
  life: { dot: 'bg-white/50', chip: 'border-white/20 bg-white/[0.06]', text: 'text-white/70' },
  other: { dot: 'bg-white/25', chip: 'border-white/15 bg-white/[0.04]', text: 'text-white/50' },
  record: { dot: 'bg-slate-400', chip: 'border-slate-400/30 bg-slate-400/10', text: 'text-slate-300/80' },
}

const PRECISION_LABEL: Record<string, string> = {
  day: 'exact date',
  month: 'month only',
  year: 'year only',
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export const TimelinePage: FC<TimelinePageProps> = ({ onBack }) => {
  const { settings } = useSettings()
  const enabled = settings?.timelineEnabled ?? true

  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [summary, setSummary] = useState<TimelineSummary | null>(null)
  // null = the life timeline. A separate-context project keeps its own, which is
  // the only way its dated record is ever shown.
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null)
  const [separateProjects, setSeparateProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [rebuilding, setRebuilding] = useState(false)
  const [progress, setProgress] = useState<TimelineRebuildProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [activeCategories, setActiveCategories] = useState<TimelineCategory[]>([])
  const [narrativeExpanded, setNarrativeExpanded] = useState(false)
  const [years, setYears] = useState<TimelineYearContext[]>([])
  const [birthYear, setBirthYear] = useState<number | null>(null)
  const [openYear, setOpenYear] = useState<number | null>(null)
  const [showPreBirthYears, setShowPreBirthYears] = useState(false)

  const [showRecord, setShowRecord] = useState(false)
  const [showArchived, setShowArchived] = useState(true)
  const [openVersionId, setOpenVersionId] = useState<string | null>(null)
  const [openVersion, setOpenVersion] = useState<ContextVersion | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [draftDate, setDraftDate] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftDetail, setDraftDetail] = useState('')
  const [draftCategory, setDraftCategory] = useState<TimelineCategory>('milestone')

  const load = useCallback(async () => {
    try {
      // Scope: "life" is everything except the projects kept separate; a separate
      // project asks for itself by id and gets its own timeline.
      const [list, stored] = await Promise.all([
        window.electronAPI.timeline.list(scopeProjectId ? { projectIds: [scopeProjectId] } : undefined),
        window.electronAPI.timeline.getSummary(),
      ])
      setEvents(list)
      // Eras, the narrative and the year super-contexts are the life story and
      // are built without the separate projects — showing them next to one
      // project's record would misattribute them.
      setSummary(scopeProjectId ? null : stored)
      if (scopeProjectId) {
        setYears([])
        setBirthYear(null)
        setLoading(false)
        return
      }
      // Deliberately not in the Promise.all above: the year syntheses are an
      // enrichment, and a main process without the handler (an app running older
      // code than this window) must not take the whole page down with it.
      try {
        const view = await window.electronAPI.timeline.getYears()
        setYears(view.years)
        setBirthYear(view.birthYear)
      } catch {
        setYears([])
      }
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setLoading(false)
    }
  }, [scopeProjectId])

  useEffect(() => {
    void load()
  }, [load])

  // Only separate-context projects get their own scope: a life-scoped project's
  // events are already part of the life timeline.
  useEffect(() => {
    window.electronAPI.projects
      .list()
      .then((list) => setSeparateProjects(list.filter((project) => project.contextScope === 'separate')))
      .catch(() => setSeparateProjects([]))
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.timeline.onProgress((update) => setProgress(update))
    return unsubscribe
  }, [])

  const handleRebuild = async () => {
    if (!enabled || rebuilding) return
    setRebuilding(true)
    setError(null)
    setNotice(null)
    setProgress(null)
    try {
      const result = await window.electronAPI.timeline.rebuild()
      await load()
      setNotice(
        `${result.eventsStored} new, ${result.eventsUpdated} refreshed from ${result.sourcesScanned} source${result.sourcesScanned === 1 ? '' : 's'}` +
          (result.duplicatesMerged > 0 ? `, ${result.duplicatesMerged} duplicate${result.duplicatesMerged === 1 ? '' : 's'} merged` : '') +
          (result.eventsArchived > 0 ? `, ${result.eventsArchived} kept as history` : '') +
          (result.contextVersionsSeen > 0 ? `, ${result.contextVersionsSeen} archived context version${result.contextVersionsSeen === 1 ? '' : 's'}` : '') +
          (result.narrativeGenerated ? ', eras rewritten' : '') +
          (result.yearsGenerated > 0
            ? `, ${result.yearsGenerated} year${result.yearsGenerated === 1 ? '' : 's'} compressed`
            : '')
      )
      // A rebuild where every year synthesis failed still "succeeds" — the events
      // are harvested and stored — so the failure has to be said out loud or it
      // reads as a rebuild that simply had nothing to do.
      if (result.yearsFailed > 0) {
        setError(
          `${result.yearsFailed} year${result.yearsFailed === 1 ? '' : 's'} could not be compressed: ${
            result.yearsError ?? 'unknown error'
          }`
        )
      }
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setRebuilding(false)
      setProgress(null)
    }
  }

  const handleAdd = async () => {
    if (!draftTitle.trim() || !draftDate.trim()) return
    setError(null)
    try {
      await window.electronAPI.timeline.createEvent({
        sourceType: 'manual',
        sourceRef: '',
        sourceLabel: '',
        projectId: null,
        category: draftCategory,
        title: draftTitle.trim(),
        detail: draftDetail.trim(),
        startDate: draftDate.trim(),
        endDate: null,
        precision: 'day',
        confidence: 1,
      })
      setDraftDate('')
      setDraftTitle('')
      setDraftDetail('')
      setShowAdd(false)
      await load()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const handleOpenVersion = async (event: TimelineEvent) => {
    if (!event.contextVersionId) return
    if (openVersionId === event.contextVersionId) {
      setOpenVersionId(null)
      setOpenVersion(null)
      return
    }
    setOpenVersionId(event.contextVersionId)
    setOpenVersion(null)
    setVersionLoading(true)
    try {
      setOpenVersion(await window.electronAPI.contextVersions.get(event.contextVersionId))
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setVersionLoading(false)
    }
  }

  const handleDelete = async (event: TimelineEvent) => {
    try {
      await window.electronAPI.timeline.deleteEvent(event.id)
      setEvents((current) => current.filter((item) => item.id !== event.id))
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const presentCategories = useMemo(() => {
    const present = new Set(events.map((event) => event.category))
    return TIMELINE_ALL_CATEGORIES.filter((category) => present.has(category))
  }, [events])

  const recordCount = useMemo(() => events.filter((event) => event.category === 'record').length, [events])
  const archivedCount = useMemo(() => events.filter((event) => event.archivedAt).length, [events])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return events.filter((event) => {
      const isRecord = event.category === 'record'
      if (isRecord && !showRecord && !activeCategories.includes('record')) return false
      if (event.archivedAt && !showArchived) return false
      if (activeCategories.length > 0 && !activeCategories.includes(event.category)) return false
      if (!query) return true
      return (
        event.title.toLowerCase().includes(query) ||
        event.detail.toLowerCase().includes(query) ||
        event.sourceLabel.toLowerCase().includes(query)
      )
    })
  }, [events, search, activeCategories, showRecord, showArchived])

  const byYear = useMemo(() => groupTimelineByYear(filtered), [filtered])

  // A timeline of a person's life should open on the year they were born. Records
  // that predate them are real, but they are provenance rather than biography, so
  // they fold away behind a control instead of heading the list. With no birth
  // date in Memory there is nothing to split on and every year is shown.
  const preBirthYears = useMemo(
    () => (birthYear === null ? [] : years.filter((year) => year.year < birthYear)),
    [years, birthYear]
  )
  const lifeYears = useMemo(
    () => (birthYear === null ? years : years.filter((year) => year.year >= birthYear)),
    [years, birthYear]
  )
  const lifeEvents = useMemo(() => events.filter((event) => event.category !== 'record'), [events])
  const span = lifeEvents.length > 0
    ? `${lifeEvents[0].startDate.slice(0, 4)}–${lifeEvents[lifeEvents.length - 1].startDate.slice(0, 4)}`
    : null

  const toggleCategory = (category: TimelineCategory) => {
    setActiveCategories((current) =>
      current.includes(category) ? current.filter((item) => item !== category) : [...current, category]
    )
  }

  const narrative = summary?.narrative?.trim() ?? ''
  const narrativeIsLong = narrative.length > 420

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-holmes-bg/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-sm text-white/40 hover:text-white/80 transition-colors cursor-pointer"
          >
            ← Back
          </button>
          <span className="text-white/15">/</span>
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faTimeline} className="text-sky-400 text-sm" />
            <h1 className="text-xl font-medium text-white/85 font-serif-display">Timeline</h1>
          </div>
          {separateProjects.length > 0 && (
            <select
              value={scopeProjectId ?? 'life'}
              onChange={(event) => setScopeProjectId(event.target.value === 'life' ? null : event.target.value)}
              title="Projects kept separate from the life context keep their own timeline"
              className="ml-2 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/60 outline-none hover:border-white/20 cursor-pointer"
            >
              <option value="life">Life</option>
              {separateProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-white/30">
            {lifeEvents.length} event{lifeEvents.length === 1 ? '' : 's'}
            {span ? ` · ${span}` : ''}
            {summary?.eras.length ? ` · ${summary.eras.length} era${summary.eras.length === 1 ? '' : 's'}` : ''}
          </span>
          <button
            onClick={() => void handleRebuild()}
            disabled={!enabled || rebuilding}
            title={enabled ? 'Re-read every generated context and rebuild the timeline' : 'Enable Timeline in Settings'}
            className="flex items-center gap-1.5 rounded-lg border border-sky-400/25 bg-sky-400/[0.07] px-2.5 py-1 text-[11px] text-sky-100/85 hover:border-sky-400/45 disabled:opacity-40 cursor-pointer transition-colors"
          >
            <FontAwesomeIcon icon={faArrowRotateRight} className={`text-[10px] ${rebuilding ? 'animate-spin' : ''}`} />
            {rebuilding ? 'Rebuilding…' : 'Rebuild'}
          </button>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto w-full">
        {!enabled && (
          <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs text-amber-200/80">
            Timeline is switched off in Settings. Existing events are still shown, but nothing will be rebuilt and the assistant is not given the timeline as context.
          </div>
        )}

        {rebuilding && progress && (
          <div className="mb-4 rounded-lg border border-sky-400/15 bg-sky-400/[0.05] px-3 py-2 text-[11px] text-sky-100/75">
            {progress.message}
            {progress.total ? ` (${progress.current ?? 0}/${progress.total})` : ''}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11px] text-red-200/80">{error}</div>
        )}
        {notice && !rebuilding && (
          <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/50">{notice}</div>
        )}

        {(summary?.eras.length || narrative) && (
          <section className="mb-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-white/75 font-serif-display">
              <span className="h-2 w-2 rounded-full bg-sky-400" />
              Eras
            </h2>
            {summary && summary.eras.length > 0 && (
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                {summary.eras.map((era, index) => (
                  <div key={`${era.label}-${index}`} className="rounded-xl border border-white/[0.07] bg-holmes-surface p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-white/80 font-serif-display">{era.label}</span>
                      <span className="shrink-0 text-[10px] text-white/30">
                        {era.startDate}{era.endDate ? ` – ${era.endDate}` : ' – present'}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-white/50">{era.summary}</p>
                  </div>
                ))}
              </div>
            )}
            {narrative && (
              <div className="rounded-xl border border-white/[0.07] bg-holmes-surface p-4">
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-white/60">
                  {narrativeExpanded || !narrativeIsLong ? narrative : `${narrative.slice(0, 420).trimEnd()}…`}
                </p>
                {narrativeIsLong && (
                  <button
                    onClick={() => setNarrativeExpanded((value) => !value)}
                    className="mt-1 cursor-pointer text-[10px] text-sky-300/70 transition-colors hover:text-sky-200"
                  >
                    {narrativeExpanded ? 'Show less' : 'Read more'}
                  </button>
                )}
                {summary?.updatedAt && (
                  <div className="mt-2 text-[10px] text-white/25">
                    Synthesized {new Date(summary.updatedAt).toLocaleString()} from {summary.eventCount} event{summary.eventCount === 1 ? '' : 's'}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {events.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-white/75 font-serif-display">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              Years
              {lifeYears.length > 0 && (
                <span className="text-[10px] font-normal text-white/30">
                  {lifeYears[0].year}–{lifeYears[lifeYears.length - 1].year} · {lifeYears.length} year
                  {lifeYears.length === 1 ? '' : 's'}
                </span>
              )}
            </h2>
            <p className="mb-3 text-[10px] leading-relaxed text-white/30">
              Each year of the record compressed into prose. The dated record is far larger than any chat context can
              hold, so these are what carry the whole span into conversations.
            </p>
            {years.length === 0 && (
              <div className="rounded-xl border border-dashed border-white/[0.09] bg-holmes-surface px-4 py-3 text-[11px] leading-relaxed text-white/40">
                No years compressed yet — “Rebuild” builds one per calendar year, then only rewrites the years whose
                events changed. Years with just a few entries are kept verbatim and cost nothing to build.
              </div>
            )}
            <div className="grid gap-1.5">
              {preBirthYears.length > 0 && (
                <>
                  <button
                    onClick={() => setShowPreBirthYears((value) => !value)}
                    className="cursor-pointer rounded-xl border border-dashed border-white/[0.09] px-3 py-1.5 text-left text-[10px] text-white/35 transition-colors hover:border-white/20 hover:text-white/55"
                  >
                    {showPreBirthYears ? 'Hide' : 'Show'} {preBirthYears.length} year
                    {preBirthYears.length === 1 ? '' : 's'} before {birthYear} ({preBirthYears[0].year}–
                    {preBirthYears[preBirthYears.length - 1].year}) — inherited items, family papers and other records
                    predating you
                  </button>
                  {showPreBirthYears &&
                    preBirthYears.map((year) => {
                      const open = openYear === year.year
                      return (
                        <div key={year.year} className="rounded-xl border border-white/[0.05] bg-holmes-surface/60">
                          <button
                            onClick={() => setOpenYear(open ? null : year.year)}
                            className="flex w-full cursor-pointer items-baseline gap-3 px-3 py-2 text-left"
                          >
                            <span className="shrink-0 text-xs font-medium text-white/50 tabular-nums font-serif-display">{year.year}</span>
                            <span className={`flex-1 text-[11px] leading-relaxed text-white/35 ${open ? '' : 'truncate'}`}>
                              {year.contextShort || `${year.eventCount} recorded entries`}
                            </span>
                            <span className="shrink-0 text-[10px] text-white/20">
                              {year.eventCount}
                              {year.synthesized ? '' : ' · verbatim'}
                            </span>
                          </button>
                          {open && year.context.trim() && (
                            <p className="whitespace-pre-wrap border-t border-white/[0.05] px-3 py-2.5 text-[11px] leading-relaxed text-white/45">
                              {year.context.trim()}
                            </p>
                          )}
                        </div>
                      )
                    })}
                </>
              )}
              {lifeYears.map((year) => {
                const open = openYear === year.year
                return (
                  <div key={year.year} className="rounded-xl border border-white/[0.07] bg-holmes-surface">
                    <button
                      onClick={() => setOpenYear(open ? null : year.year)}
                      className="flex w-full cursor-pointer items-baseline gap-3 px-3 py-2 text-left"
                    >
                      <span className="shrink-0 text-xs font-medium text-white/80 tabular-nums font-serif-display">{year.year}</span>
                      <span className={`flex-1 text-[11px] leading-relaxed text-white/50 ${open ? '' : 'truncate'}`}>
                        {year.contextShort || `${year.eventCount} recorded entries`}
                      </span>
                      <span className="shrink-0 text-[10px] text-white/25">
                        {year.eventCount}
                        {year.synthesized ? '' : ' · verbatim'}
                      </span>
                    </button>
                    {open && year.context.trim() && (
                      <p className="whitespace-pre-wrap border-t border-white/[0.05] px-3 py-2.5 text-[11px] leading-relaxed text-white/60">
                        {year.context.trim()}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-medium text-white/75 font-serif-display">
              <span className="h-2 w-2 rounded-full bg-white/40" />
              Dated record
              {filtered.length !== events.length && (
                <span className="text-[10px] font-normal text-white/30">{filtered.length} of {events.length} shown</span>
              )}
            </h2>
            <div className="flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search events"
                className="w-44 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/70 outline-none transition-colors placeholder:text-white/25 focus:border-white/25"
              />
              <button
                onClick={() => setShowAdd((value) => !value)}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/60 transition-colors hover:border-white/25 hover:text-white/80 cursor-pointer"
              >
                <FontAwesomeIcon icon={faPlus} className="text-[9px]" />
                Add event
              </button>
            </div>
          </div>

          {presentCategories.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {presentCategories.map((category) => {
                const active = activeCategories.includes(category)
                const style = CATEGORY_STYLE[category]
                return (
                  <button
                    key={category}
                    onClick={() => toggleCategory(category)}
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors cursor-pointer ${
                      active ? `${style.chip} ${style.text}` : 'border-white/10 bg-white/[0.02] text-white/35 hover:text-white/60'
                    }`}
                  >
                    {category}
                  </button>
                )
              })}
              {activeCategories.length > 0 && (
                <button
                  onClick={() => setActiveCategories([])}
                  className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/35 transition-colors hover:text-white/70 cursor-pointer"
                >
                  clear
                </button>
              )}
            </div>
          )}

          {(recordCount > 0 || archivedCount > 0) && (
            <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] text-white/30">
              {recordCount > 0 && (
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showRecord}
                    onChange={(e) => setShowRecord(e.target.checked)}
                    className="h-3 w-3 cursor-pointer accent-slate-400"
                  />
                  Show when contexts were generated ({recordCount} archived version{recordCount === 1 ? '' : 's'})
                </label>
              )}
              {archivedCount > 0 && (
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.target.checked)}
                    className="h-3 w-3 cursor-pointer accent-amber-400"
                  />
                  Show events whose source has since changed ({archivedCount})
                </label>
              )}
            </div>
          )}

          {showAdd && (
            <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex flex-wrap gap-2">
                <input
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  placeholder="2019-06-14, 2019-06, or 2019"
                  className="w-52 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/70 outline-none placeholder:text-white/25 focus:border-white/25"
                />
                <select
                  value={draftCategory}
                  onChange={(e) => setDraftCategory(e.target.value as TimelineCategory)}
                  className="rounded-lg border border-white/10 bg-holmes-surface px-2 py-1 text-[11px] text-white/70 outline-none focus:border-white/25 cursor-pointer"
                >
                  {TIMELINE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="What happened"
                  className="min-w-[12rem] flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/70 outline-none placeholder:text-white/25 focus:border-white/25"
                />
              </div>
              <input
                value={draftDetail}
                onChange={(e) => setDraftDetail(e.target.value)}
                placeholder="Optional detail"
                className="mt-2 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/70 outline-none placeholder:text-white/25 focus:border-white/25"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[10px] text-white/25">
                  Events you add are kept through every rebuild. The precision is read from the date you type.
                </span>
                <button
                  onClick={() => void handleAdd()}
                  disabled={!draftTitle.trim() || !draftDate.trim()}
                  className="rounded-lg border border-sky-400/25 bg-sky-400/[0.07] px-2.5 py-1 text-[11px] text-sky-100/85 transition-colors hover:border-sky-400/45 disabled:opacity-40 cursor-pointer"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="rounded-2xl border border-white/10 bg-holmes-surface p-6 text-xs text-white/40">Loading timeline…</div>
          ) : events.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-holmes-surface p-6 text-xs leading-relaxed text-white/40">
              No events yet. The timeline is assembled from the dated entries every generated context produces, so index a data source on the Data page (or let the hourly background pass run), then hit Rebuild. You can also add events by hand above.
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-holmes-surface p-6 text-xs text-white/40">No events match the current filters.</div>
          ) : (
            <div className="space-y-6">
              {byYear.map(({ year, events: yearEvents }) => (
                <div key={year}>
                  <div className="mb-2 flex items-center gap-3">
                    <span className="text-sm font-medium text-white/70 tabular-nums">{year}</span>
                    <span className="h-px flex-1 bg-white/[0.07]" />
                    <span className="text-[10px] text-white/25">{yearEvents.length}</span>
                  </div>
                  <div className="relative pl-4">
                    <span className="absolute left-[3px] top-1 bottom-1 w-px bg-white/[0.08]" />
                    <div className="space-y-2">
                      {yearEvents.map((event) => {
                        const style = CATEGORY_STYLE[event.category] ?? CATEGORY_STYLE.other
                        const isArchived = Boolean(event.archivedAt)
                        const isVersionOpen = openVersionId && event.contextVersionId === openVersionId
                        return (
                          <div
                            key={event.id}
                            className={`group relative rounded-xl border p-3 ${
                              isArchived
                                ? 'border-white/[0.05] bg-holmes-surface/40'
                                : 'border-white/[0.07] bg-holmes-surface'
                            }`}
                          >
                            <span className={`absolute -left-4 top-4 h-[7px] w-[7px] rounded-full ${style.dot} ${isArchived ? 'opacity-40' : ''}`} />
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-baseline gap-2">
                                  <span className={`text-xs ${isArchived ? 'text-white/45' : 'text-white/80'}`}>{event.title}</span>
                                  <span className={`rounded-full border px-1.5 py-px text-[9px] ${style.chip} ${style.text}`}>
                                    {event.category}
                                  </span>
                                  {isArchived && (
                                    <span
                                      className="flex items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/[0.07] px-1.5 py-px text-[9px] text-amber-200/70"
                                      title={`Kept as history. The context this came from no longer reports it (since ${new Date(event.archivedAt!).toLocaleDateString()}).`}
                                    >
                                      <FontAwesomeIcon icon={faBoxArchive} className="text-[8px]" />
                                      superseded
                                    </span>
                                  )}
                                </div>
                                {event.detail && (
                                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">{event.detail}</p>
                                )}
                                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-white/25">
                                  <span title={PRECISION_LABEL[event.precision]}>
                                    {formatTimelineRange(event)}
                                    {event.precision !== 'day' ? ` (${PRECISION_LABEL[event.precision]})` : ''}
                                  </span>
                                  <span className="text-white/10">·</span>
                                  <span className="truncate">{event.sourceLabel}</span>
                                  {event.contextVersionId && (
                                    <>
                                      <span className="text-white/10">·</span>
                                      <button
                                        onClick={() => void handleOpenVersion(event)}
                                        className="flex items-center gap-1 text-slate-300/60 transition-colors hover:text-slate-200 cursor-pointer"
                                      >
                                        <FontAwesomeIcon icon={faFileLines} className="text-[9px]" />
                                        {isVersionOpen ? 'Hide this version' : 'Read this version'}
                                      </button>
                                    </>
                                  )}
                                </div>
                                {isVersionOpen && (
                                  <div className="mt-2 rounded-lg border border-white/[0.07] bg-black/20 p-2">
                                    {versionLoading ? (
                                      <span className="text-[10px] text-white/30">Loading the archived context…</span>
                                    ) : openVersion ? (
                                      <>
                                        <div className="mb-1 text-[10px] text-white/30">
                                          v{openVersion.version} · generated {new Date(openVersion.generatedAt).toLocaleString()}
                                          {openVersion.supersededAt
                                            ? ` · superseded ${new Date(openVersion.supersededAt).toLocaleString()}`
                                            : ' · current version'}
                                        </div>
                                        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-white/55">
                                          {openVersion.context}
                                        </p>
                                      </>
                                    ) : (
                                      <span className="text-[10px] text-white/30">This version could not be loaded.</span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <span className="text-[10px] tabular-nums text-white/30">
                                  {formatTimelineDate(event.startDate, event.precision)}
                                </span>
                                {(event.sourceType === 'manual' || isArchived) && (
                                  <button
                                    onClick={() => void handleDelete(event)}
                                    className="opacity-0 text-white/30 transition-all hover:text-red-300 group-hover:opacity-100 cursor-pointer"
                                    aria-label={`Delete ${event.title}`}
                                    title="Delete this event"
                                  >
                                    <FontAwesomeIcon icon={faXmark} className="text-[10px]" />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
