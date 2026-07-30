import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faDatabase } from '@fortawesome/free-solid-svg-icons'
import type { Project, HealthRecord, HealthLiveStatus, ActivityRecord, ActivitySummary } from '@shared/types'
import lifeIconGreen from '../../../assets/lifeIconGreen.svg'
import { isDashboardProject } from '@shared/defaultProjects'
import { ProjectIcon } from './ProjectIcon'
import { PageHeader } from './PageHeader'
import { UserSuperContextCard } from './UserSuperContextCard'
import { PeopleWidget } from './PeopleWidget'
import { useSettings } from '../hooks/useSettings'

interface DashboardProps {
  projects: Project[]
  onUpdate: (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSelectDirectory: () => Promise<string | null>
  onAddFile: (projectId: string, filePath: string) => Promise<void>
  onRemoveFile: (projectId: string, filePath: string) => Promise<void>
  onSelectFiles: () => Promise<string[]>
  onAnalyzePsychology: (projectId: string) => Promise<void>
  onAnalyzeHealth: (projectId: string) => Promise<void>
  onAnalyzeActivity: (projectId: string) => Promise<void>
  healthAnalysisEnabled: boolean
  activityIngestEnabled: boolean
  onRestoreDefaults: () => Promise<void>
  onOpenPsychology: (projectId: string) => void
  onOpenHealth: (projectId: string) => void
  onOpenActivity: (projectId: string) => void
  onOpenData: () => void
  onOpenPeople: () => void
}

const CARD_CLASS =
  'group relative flex flex-col h-[190px] overflow-hidden bg-holmes-surface rounded-2xl border border-white/10 p-4 hover:border-white/20 transition-colors'

export const Dashboard: FC<DashboardProps> = ({
  projects,
  onUpdate,
  onDelete,
  onSelectDirectory,
  onAddFile,
  onRemoveFile,
  onSelectFiles,
  onAnalyzePsychology,
  onAnalyzeHealth,
  onAnalyzeActivity,
  healthAnalysisEnabled,
  activityIngestEnabled,
  onRestoreDefaults,
  onOpenPsychology,
  onOpenHealth,
  onOpenActivity,
  onOpenData,
  onOpenPeople,
}) => {
  const { settings } = useSettings()
  const documentContextEnabled = settings?.documentContextEnabled ?? false
  const peopleEnabled = settings?.peopleEnabled ?? true
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [healthRecords, setHealthRecords] = useState<HealthRecord[]>([])
  const [healthLiveStatus, setHealthLiveStatus] = useState<HealthLiveStatus | null>(null)
  const [activityRecords, setActivityRecords] = useState<ActivityRecord[]>([])
  const [activitySummary, setActivitySummary] = useState<ActivitySummary | null>(null)

  useEffect(() => {
    let cancelled = false
    let cancelledActivity = false
    const healthProject = projects.find((p) => p.name === 'Health')
    if (!healthProject) {
      setHealthRecords([])
      setHealthLiveStatus(null)
    } else {
      window.electronAPI.health
        .listRecords(healthProject.id)
        .then((list) => {
          if (!cancelled) setHealthRecords(list)
        })
        .catch(() => {
          if (!cancelled) setHealthRecords([])
        })
      window.electronAPI.health
        .liveStatus(healthProject.id)
        .then((status) => {
          if (!cancelled) setHealthLiveStatus(status)
        })
        .catch(() => {
          if (!cancelled) setHealthLiveStatus(null)
        })
    }
    const activityProject = projects.find((p) => p.name === 'Activity')
    if (!activityProject) {
      setActivityRecords([])
      setActivitySummary(null)
    } else {
      window.electronAPI.activity
        .listRecords(activityProject.id)
        .then((list) => {
          if (!cancelledActivity) setActivityRecords(list)
        })
        .catch(() => {
          if (!cancelledActivity) setActivityRecords([])
        })
      window.electronAPI.activity
        .getSummary(activityProject.id)
        .then((summary) => {
          if (!cancelledActivity) setActivitySummary(summary)
        })
        .catch(() => {
          if (!cancelledActivity) setActivitySummary(null)
        })
    }
    return () => {
      cancelled = true
      cancelledActivity = true
    }
  }, [projects])

  const handleAnalyze = async (projectId: string, fn: (id: string) => Promise<void>) => {
    setAnalyzingId(projectId)
    setAnalyzeError(null)
    try {
      await fn(projectId)
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed')
    }
    setAnalyzingId(null)
  }
  const handleBrowse = async (project: Project) => {
    const dir = await onSelectDirectory()
    if (dir) {
      await onUpdate(project.id, { path: dir })
    }
  }

  const handleClearPath = async (id: string) => {
    await onUpdate(id, { path: null })
  }

  const handleAddFiles = async (projectId: string) => {
    const files = await onSelectFiles()
    for (const file of files) {
      await onAddFile(projectId, file)
    }
  }

  function fileName(path: string): string {
    return path.split('/').pop() || path.split('\\').pop() || path
  }

  function money(cents: number): string {
    return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
  }

  // What the Data card reports: how many sources actually have something behind
  // them, and whether any ingest source is stuck. File System is an access
  // scope, not a source, and media sources have their own page, so neither is
  // in either half of the count.
  const countableSources = projects.filter((project) => isDashboardProject(project.name))
  const connectedSourceCount = countableSources.filter((project) => project.path).length
  const activityNeedsAttention = activityRecords.filter(
    (record) => record.status === 'needs_permission' || record.status === 'failed'
  ).length

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-holmes-bg">
      <PageHeader
        icon={<img src={lifeIconGreen} alt="" className="h-[25px] w-[25px]" />}
        title="Life Dashboard"
        actions={
          <button
            onClick={onRestoreDefaults}
            className="flex h-[30px] items-center rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 cursor-pointer"
            title="Restore missing default projects"
          >
            Restore defaults
          </button>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-8 pt-6 pb-8">
        {/* Everything below is one domain at a time; the unified profile that
            combines them belongs at the top of the page that shows the life. */}
        <div className="max-w-5xl w-full mx-auto mb-5">
          <UserSuperContextCard enabled={documentContextEnabled} />
        </div>

        {/* Who the profile above is about. */}
        <div className="max-w-5xl w-full mx-auto mb-5">
          <PeopleWidget enabled={peopleEnabled} onOpenPeople={onOpenPeople} />
        </div>

        <div className="max-w-5xl w-full mx-auto grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Data is a view of every source, not a source itself, so its card is
              part of the dashboard rather than a project in the list. */}
          <div className={CARD_CLASS}>
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2.5">
                <FontAwesomeIcon icon={faDatabase} className="text-[22px] text-holmes-primary" />
                <h2 className="text-base font-medium text-white/80 font-serif-display">Data</h2>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              <p className="text-[11px] text-white/45">
                <span className="text-white/80 font-medium tabular-nums">{connectedSourceCount}</span> of{' '}
                <span className="tabular-nums">{countableSources.length}</span> sources feeding context
              </p>
              {activityNeedsAttention > 0 && (
                <p className="mt-1 text-[10px] text-amber-300/80">
                  {activityNeedsAttention} source{activityNeedsAttention === 1 ? '' : 's'} need{activityNeedsAttention === 1 ? 's' : ''} attention
                </p>
              )}
            </div>

            <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
              <span className="text-[10px] text-white/30 uppercase tracking-wider">Data dashboard</span>
              <button
                onClick={onOpenData}
                className="text-[11px] text-holmes-primary-light/80 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
              >
                Open Data
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          </div>

          {/* File System is Holmes' access scope, not a life domain — it is
              managed on the Data page and would only offer a misleading
              "Set directory…" here. Media sources have the Library instead. */}
          {projects.filter((project) => isDashboardProject(project.name)).map((project) => {
            const isPsychology = project.name === 'Psychology'
            const isHealth = project.name === 'Health'
            const isActivity = project.name === 'Activity'
            const isFinances = project.name === 'Finances'

            if (isPsychology) {
              return (
                <div
                  key={project.id}
                  className={CARD_CLASS}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <ProjectIcon icon={project.icon} className="text-2xl" />
                      <h2 className="text-base font-medium text-white/80 font-serif-display">{project.name}</h2>
                    </div>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete the project "${project.name}"? This removes its files and cannot be undone.`)) {
                          void onDelete(project.id)
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all cursor-pointer text-sm"
                      title="Delete project"
                    >
                      ×
                    </button>
                  </div>

                  {project.path ? (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <span className="text-[11px] text-white/40 truncate flex-1">{project.path}</span>
                      <button
                        onClick={() => handleClearPath(project.id)}
                        className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer shrink-0"
                        title="Remove directory"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleBrowse(project)}
                      className="mb-1.5 text-[11px] text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      Set directory...
                    </button>
                  )}

                  <div className="flex-1 min-h-0 space-y-1 overflow-y-auto scrollbar-thin">
                    {project.files.map((f) => (
                      <div key={f} className="flex items-center gap-1.5 group/file">
                        <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span className="text-[11px] text-white/50 truncate flex-1" title={f}>{fileName(f)}</span>
                        <button
                          onClick={() => onRemoveFile(project.id, f)}
                          className="opacity-0 group-hover/file:opacity-100 text-[10px] text-white/30 hover:text-red-400 transition-all cursor-pointer shrink-0"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>

                  {analyzeError && analyzingId === project.id && (
                    <p className="text-[10px] text-red-400 truncate">{analyzeError}</p>
                  )}

                  <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/5">
                    <button
                      onClick={() => handleAddFiles(project.id)}
                      className="text-[11px] text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Add files
                    </button>
                    <button
                      onClick={() => onOpenPsychology(project.id)}
                      className="text-[11px] text-violet-300/70 hover:text-violet-200 transition-colors cursor-pointer flex items-center gap-1"
                    >
                      Assessments &amp; insights
                    </button>
                    {(project.files.length > 0 || project.path) && (
                      <button
                        onClick={() => handleAnalyze(project.id, onAnalyzePsychology)}
                        disabled={analyzingId === project.id}
                        title="Sends Psychology project documents to your configured AI provider"
                        className="ml-auto text-[11px] text-holmes-primary hover:text-holmes-primary-light transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {analyzingId === project.id ? 'Analyzing...' : 'Analyze'}
                      </button>
                    )}
                  </div>
                </div>
              )
            }

            if (isHealth) {
              return (
                <div
                  key={project.id}
                  className={CARD_CLASS}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <ProjectIcon icon={project.icon} className="text-2xl" />
                      <h2 className="text-base font-medium text-white/80 font-serif-display">{project.name}</h2>
                      {healthLiveStatus?.available && healthLiveStatus?.authorized === 'authorized' && (
                        <span
                          className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400"
                          title="Live Apple Health connected"
                        />
                      )}
                    </div>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete the project "${project.name}"? This removes its files and cannot be undone.`)) {
                          void onDelete(project.id)
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all cursor-pointer text-sm"
                      title="Delete project"
                    >
                      ×
                    </button>
                  </div>

                  {project.path ? (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <span className="text-[11px] text-white/40 truncate flex-1">{project.path}</span>
                      <button
                        onClick={() => handleClearPath(project.id)}
                        className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer shrink-0"
                        title="Remove directory"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleBrowse(project)}
                      className="mb-1.5 text-[11px] text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      Set directory...
                    </button>
                  )}

                  <div className="flex-1 min-h-0 space-y-1 overflow-y-auto scrollbar-thin">
                    {project.files.map((f) => (
                      <div key={f} className="flex items-center gap-1.5 group/file">
                        <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span className="text-[11px] text-white/50 truncate flex-1" title={f}>{fileName(f)}</span>
                        <button
                          onClick={() => onRemoveFile(project.id, f)}
                          className="opacity-0 group-hover/file:opacity-100 text-[10px] text-white/30 hover:text-red-400 transition-all cursor-pointer shrink-0"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>

                  {analyzeError && analyzingId === project.id ? (
                    <p className="text-[10px] text-red-400 truncate">{analyzeError}</p>
                  ) : healthRecords.length > 0 ? (
                    <p className="text-[10px] text-white/35 truncate">
                      {healthRecords.length} source{healthRecords.length === 1 ? '' : 's'} · {healthRecords.reduce((sum, r) => sum + r.observationsCount, 0)} observations
                    </p>
                  ) : null}

                  <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/5">
                    <button
                      onClick={() => handleAddFiles(project.id)}
                      className="text-[11px] text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      Add files
                    </button>
                    <button
                      onClick={() => onOpenHealth(project.id)}
                      className="text-[11px] text-emerald-300/70 hover:text-emerald-200 transition-colors cursor-pointer flex items-center gap-1"
                    >
                      Overview &amp; insights
                    </button>
                    {(project.files.length > 0 || project.path) && (
                      <button
                        onClick={() => handleAnalyze(project.id, onAnalyzeHealth)}
                        disabled={analyzingId === project.id || !healthAnalysisEnabled}
                        title={
                          !healthAnalysisEnabled
                            ? 'Enable Health AI analysis in Settings to run structured analysis'
                            : 'Sends Health project documents to your configured AI provider'
                        }
                        className="ml-auto text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {analyzingId === project.id ? 'Analyzing...' : 'Analyze'}
                      </button>
                    )}
                  </div>
                </div>
              )
            }

            if (isActivity) {
              return (
                <div
                  key={project.id}
                  className={CARD_CLASS}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <ProjectIcon icon={project.icon} className="text-2xl" />
                      <h2 className="text-base font-medium text-white/80 font-serif-display">{project.name}</h2>
                    </div>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete the project "${project.name}"? This removes its files and cannot be undone.`)) {
                          void onDelete(project.id)
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all cursor-pointer text-sm"
                      title="Delete project"
                    >
                      ×
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 overflow-hidden">
                    {analyzeError && analyzingId === project.id ? (
                      <p className="text-[10px] text-red-400 truncate">{analyzeError}</p>
                    ) : activityRecords.length > 0 ? (
                      <p className="text-[11px] text-white/40">
                        {activityRecords.length} source{activityRecords.length === 1 ? '' : 's'} · {activityRecords.reduce((sum, r) => sum + r.eventsCount, 0)} events
                      </p>
                    ) : (
                      <p className="text-[11px] text-white/30">Open Sources &amp; insights to import your activity</p>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/5">
                    <button
                      onClick={() => onOpenActivity(project.id)}
                      className="text-[11px] text-amber-300/70 hover:text-amber-200 transition-colors cursor-pointer flex items-center gap-1"
                    >
                      Sources &amp; insights
                    </button>
                    {activityRecords.length > 0 && (
                      <button
                        onClick={() => handleAnalyze(project.id, onAnalyzeActivity)}
                        disabled={analyzingId === project.id || !activityIngestEnabled}
                        title={
                          !activityIngestEnabled
                            ? 'Enable Activity analysis in Settings to run structured analysis'
                            : 'Sends activity events to your configured AI provider'
                        }
                        className="ml-auto text-[11px] text-amber-400 hover:text-amber-300 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {analyzingId === project.id ? 'Analyzing...' : 'Analyze'}
                      </button>
                    )}
                  </div>
                </div>
              )
            }

            if (isFinances) {
              return (
                <div
                  key={project.id}
                  className={CARD_CLASS}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <ProjectIcon icon={project.icon} className="text-2xl" />
                      <h2 className="text-base font-medium text-white/80 font-serif-display">{project.name}</h2>
                    </div>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete the project "${project.name}"? This removes its files and cannot be undone.`)) {
                          void onDelete(project.id)
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all cursor-pointer text-sm"
                      title="Delete project"
                    >
                      ×
                    </button>
                  </div>

                  <div className="flex-1 min-h-0 overflow-hidden">
                    {project.financesSummary ? (
                      <>
                        <div className="text-[10px] text-white/40 uppercase tracking-wider">Recurring spend</div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-semibold text-white/90">
                            {money(project.financesSummary.totalMonthlyCents)}
                          </span>
                          <span className="text-xs text-white/40">/mo</span>
                        </div>
                      </>
                    ) : (
                      <p className="text-[11px] text-white/30">Subscription and recurring spend summary.</p>
                    )}
                  </div>

                  {project.financesSummary && (
                    <div className="mt-2 pt-2 border-t border-white/5">
                      <span className="text-[10px] text-white/30 uppercase tracking-wider">
                        {project.financesSummary.activeSubscriptions.length} active subscription
                        {project.financesSummary.activeSubscriptions.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  )}
                </div>
              )
            }

            return (
              <div
                key={project.id}
                className={CARD_CLASS}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <ProjectIcon icon={project.icon} className="text-2xl" />
                    <h2 className="text-base font-medium text-white/80 font-serif-display">{project.name}</h2>
                  </div>
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete the project "${project.name}"? This removes its files and cannot be undone.`)) {
                        void onDelete(project.id)
                      }
                    }}
                    className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all cursor-pointer text-sm"
                    title="Delete project"
                  >
                    ×
                  </button>
                </div>

                {project.path ? (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span className="text-[11px] text-white/40 truncate flex-1">{project.path}</span>
                    <button
                      onClick={() => handleClearPath(project.id)}
                      className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer shrink-0"
                      title="Remove directory"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handleBrowse(project)}
                    className="mb-1.5 text-[11px] text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    Set directory...
                  </button>
                )}

                <div className="flex-1 min-h-0 space-y-1 overflow-y-auto scrollbar-thin">
                  {project.files.map((f) => (
                    <div key={f} className="flex items-center gap-1.5 group/file">
                      <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span className="text-[11px] text-white/50 truncate flex-1" title={f}>{fileName(f)}</span>
                      <button
                        onClick={() => onRemoveFile(project.id, f)}
                        className="opacity-0 group-hover/file:opacity-100 text-[10px] text-white/30 hover:text-red-400 transition-all cursor-pointer shrink-0"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: project.color }}
                  />
                  <span className="text-[10px] text-white/30 uppercase tracking-wider truncate">{project.name}</span>
                  <button
                    onClick={() => handleAddFiles(project.id)}
                    className="ml-auto text-[11px] text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add files
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
