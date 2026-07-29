import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRefresh, faSync } from '@fortawesome/free-solid-svg-icons'
import type {
  Project,
  ActivityRecord,
  ActivityIngestProgress,
  ActivityEventsBySource,
  ActivitySourceType,
  ActivityLiveStatus,
  ActivitySummary,
  ActivityAnalysisEstimate,
  ModelTier,
} from '@shared/types'
import { ProjectIcon } from './ProjectIcon'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { ActivityWidget } from './ActivityWidget'
import { ActivitySourcesPanel } from './ActivitySourcesPanel'
import { AnalysisEstimateBar } from './AnalysisEstimateBar'

interface ActivityPageProps {
  projectId: string
  activityIngestEnabled: boolean
}

const SOURCE_LABEL: Record<ActivitySourceType, string> = {
  browser: 'Browser',
  youtube: 'YouTube',
  amazon: 'Amazon',
  email: 'Email',
  knowledge: 'Knowledge',
  photos: 'Photos',
  location: 'Location',
  weather: 'Weather',
  subscription: 'Subscription',
  account: 'Account',
}

const LIVE_SOURCES: ActivitySourceType[] = ['knowledge', 'amazon', 'photos', 'weather', 'subscription']

function formatCount(n: number | null | undefined): string {
  if (n == null) return ''
  return n.toLocaleString()
}

export const ActivityPage: FC<ActivityPageProps> = ({
  projectId,
  activityIngestEnabled,
}) => {
  const [project, setProject] = useState<Project | null>(null)
  const [records, setRecords] = useState<ActivityRecord[]>([])
  const [events, setEvents] = useState<ActivityEventsBySource | null>(null)
  const [summary, setSummary] = useState<ActivitySummary | null>(null)
  const [liveStatus, setLiveStatus] = useState<ActivityLiveStatus | null>(null)
  const [progress, setProgress] = useState<ActivityIngestProgress | null>(null)
  const [liveProgress, setLiveProgress] = useState<ActivityIngestProgress | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  // Tier + cost projection for the analysis, the same pre-flight the document
  // indexer offers. Defaults to the configured tier until the user picks one.
  const [analysisTier, setAnalysisTier] = useState<ModelTier>('mid')
  const [estimate, setEstimate] = useState<ActivityAnalysisEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const [liveBusy, setLiveBusy] = useState(false)

  const refreshProject = async () => {
    try {
      const list = await window.electronAPI.projects.list()
      const found = list.find((p) => p.id === projectId) || null
      setProject(found)
    } catch {
      setProject(null)
    }
  }

  const refreshRecords = async () => {
    try {
      const list = await window.electronAPI.activity.listRecords(projectId)
      setRecords(list)
    } catch {
      setRecords([])
    }
  }

  const refreshEvents = async () => {
    try {
      const data = await window.electronAPI.activity.listEvents(projectId, undefined, 500)
      setEvents(data)
    } catch {
      setEvents(null)
    }
  }

  const refreshSummary = async () => {
    try {
      const data = await window.electronAPI.activity.getSummary(projectId)
      setSummary(data)
    } catch {
      setSummary(null)
    }
  }

  const refreshLiveStatus = async () => {
    try {
      const status = await window.electronAPI.activity.liveStatus(projectId)
      setLiveStatus(status)
    } catch {
      setLiveStatus(null)
    }
  }

  useEffect(() => {
    void refreshProject()
    void refreshRecords()
    void refreshEvents()
    void refreshSummary()
    void refreshLiveStatus()
  }, [projectId])

  useEffect(() => {
    const unsubscribe = window.electronAPI.activity.onProgress((p) => {
      setProgress(p)
      if (p.phase === 'complete' || p.phase === 'permission' || p.phase === 'reauth') {
        void refreshRecords()
        void refreshEvents()
        if (p.phase === 'complete') void refreshSummary()
      }
    })
    return unsubscribe
  }, [projectId])

  useEffect(() => {
    const unsubscribe = window.electronAPI.activity.onLiveSyncProgress((p) => {
      setLiveProgress(p)
      if (p.phase === 'complete' || p.phase === 'permission' || p.phase === 'reauth') {
        setLiveBusy(false)
        if (p.phase === 'complete') {
          void refreshRecords()
          void refreshEvents()
          void refreshSummary()
          void refreshLiveStatus()
        }
      }
    })
    return unsubscribe
  }, [projectId])

  const handleIngest = async (filePath: string, source: ActivitySourceType) => {
    setProgress({ phase: 'reading', message: `Starting ${filePath.split('/').pop()}`, current: 0, total: 0, recordId: null, sourceType: source })
    await window.electronAPI.activity.ingest(projectId, filePath, source)
  }

  const handleAbort = async () => {
    await window.electronAPI.activity.abort()
    setProgress(null)
  }

  const handleDeleteRecord = async (recordId: string) => {
    await window.electronAPI.activity.deleteRecord(recordId)
    await refreshRecords()
    await refreshEvents()
  }

  const handleEstimate = async (tier: ModelTier = analysisTier) => {
    setEstimating(true)
    setEstimateError(null)
    try {
      setEstimate(await window.electronAPI.activity.estimateAnalysis(projectId, tier))
    } catch (err) {
      setEstimate(null)
      setEstimateError(err instanceof Error ? err.message : 'Estimate failed')
    }
    setEstimating(false)
  }

  const handleTierChange = (tier: ModelTier) => {
    setAnalysisTier(tier)
    // A tier change makes any existing quote wrong, so re-price immediately
    // rather than leaving a stale number next to the new selection.
    if (estimate) void handleEstimate(tier)
  }

  const handleAnalyze = async () => {
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      await window.electronAPI.activity.refreshSummary(projectId, analysisTier)
      await refreshSummary()
      await refreshProject()
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Activity analysis failed')
    }
    setAnalyzing(false)
  }

  const handleLiveSync = async (sourceTypes?: ActivitySourceType[]) => {
    setLiveBusy(true)
    setLiveProgress({ phase: 'reading', message: 'Starting live sync…', current: 0, total: 0, recordId: null, sourceType: null })
    try {
      await window.electronAPI.activity.liveSync(projectId, sourceTypes)
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Live sync failed')
      setLiveBusy(false)
      setLiveProgress(null)
    }
  }

  const handleLiveAbort = async () => {
    try {
      await window.electronAPI.activity.liveAbort()
    } catch {
      // ignore
    }
  }

  const analysis = project?.activityAnalysis ?? summary?.summary ?? null

  const liveAvailable = (liveStatus?.sources ?? []).some((s) => s.status !== 'error')
  const lastSyncAt = (liveStatus?.sources ?? [])
    .map((s) => s.lastSyncAt)
    .filter(Boolean)
    .sort()
    .pop()

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={project ? <ProjectIcon icon={project.icon} className={PAGE_HEADER_ICON} /> : undefined}
        title={project?.name ?? 'Activity'}
      />

      <div className="max-w-4xl w-full mx-auto px-8 py-6">
        <p className="text-xs text-white/40 mb-6">
          Your digital activity — browser, email, app usage, and more.
        </p>

        {!activityIngestEnabled && (
          <div className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3">
            <p className="text-xs leading-relaxed text-amber-100/65">
              Activity AI analysis is disabled. You can still import sources, but structured analysis requires enabling Activity analysis in Settings so activity events can be sent to your configured AI provider.
            </p>
          </div>
        )}

        {/* Live sources */}
        <section className="mb-6 rounded-2xl border border-amber-400/20 bg-gradient-to-br from-amber-500/[0.07] to-amber-400/[0.02] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-white/80 font-serif-display">Live activity sources</h2>
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                    liveAvailable
                      ? 'border-amber-400/30 bg-amber-400/10 text-amber-200/80'
                      : 'border-white/10 bg-white/[0.04] text-white/40'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      liveAvailable ? 'animate-pulse bg-amber-300' : 'bg-white/30'
                    }`}
                  />
                  {liveAvailable ? 'Connected' : 'Not configured'}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/45">
                Reads knowledge (app usage), Amazon orders, photos, weather, and subscriptions. Data stays on your Mac.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                onClick={() => void handleLiveSync()}
                disabled={liveBusy}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <FontAwesomeIcon icon={faSync} className={liveBusy ? 'animate-spin mr-1' : 'mr-1'} />
                {liveBusy ? 'Syncing…' : 'Sync now'}
              </button>
              {liveBusy && (
                <button
                  onClick={() => void handleLiveAbort()}
                  className="rounded-lg border border-red-300/15 px-2.5 py-1.5 text-xs text-red-200/60 hover:text-red-100 transition-colors cursor-pointer"
                >
                  Abort
                </button>
              )}
            </div>
          </div>

          {lastSyncAt && (
            <p className="mt-3 text-[10px] text-white/40">
              Last sync: {new Date(lastSyncAt).toLocaleString()}
            </p>
          )}

          {liveProgress && (
            <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3">
              <div className="flex items-center gap-2 text-xs text-white/55">
                <span className="capitalize text-amber-300/80">{liveProgress.phase}</span>
                <span className="text-white/35">— {liveProgress.message}</span>
                {liveProgress.sourceType && (
                  <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/40">
                    {SOURCE_LABEL[liveProgress.sourceType]}
                  </span>
                )}
              </div>
            </div>
          )}
        </section>

        <ActivitySourcesPanel
          projectId={projectId}
          records={records}
          progress={progress}
          onIngest={handleIngest}
          onAbort={handleAbort}
          onDelete={handleDeleteRecord}
          onRefresh={() => { void refreshRecords(); void refreshEvents() }}
          onLiveSync={handleLiveSync}
          liveBusy={liveBusy}
          onScanDirectory={async () => {
            await window.electronAPI.activity.scanDirectory(projectId)
            await refreshRecords()
            await refreshEvents()
            await refreshSummary()
          }}
          scanning={progress?.phase === 'reading' && progress.message.startsWith('Scanning')}
          hasDirectory={Boolean(project?.path)}
        />

        {/* Events table */}
        {records.length > 0 && events && (
          <section className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
            <h2 className="text-sm font-medium text-white/75 mb-3 font-serif-display">Events</h2>
            <div className="space-y-5">
              {(Object.keys(SOURCE_LABEL) as ActivitySourceType[]).map((sourceType) => {
                const rows = events[sourceType] ?? []
                if (rows.length === 0) return null
                return (
                  <div key={sourceType}>
                    <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35 mb-2">
                      {SOURCE_LABEL[sourceType]} · {formatCount(rows.length)}
                    </h3>
                    <div className="max-h-64 overflow-y-auto scrollbar-thin rounded-xl border border-white/[0.07]">
                      <table className="w-full text-[11px] text-white/60">
                        <thead className="sticky top-0 bg-holmes-surface text-[10px] uppercase tracking-wider text-white/35">
                          <tr>
                            <th className="px-2 py-1 text-left font-normal">When</th>
                            <th className="px-2 py-1 text-left font-normal">Title</th>
                            <th className="px-2 py-1 text-left font-normal">Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((event) => {
                            const row = event as unknown as Record<string, unknown>
                            let detail = ''
                            if (sourceType === 'browser') detail = (row.url as string) || ''
                            else if (sourceType === 'youtube') detail = (row.channel as string) || ''
                            else if (sourceType === 'amazon') detail = (row.orderId as string) || ''
                            else if (sourceType === 'email') detail = (row.fromAddress as string) || ''
                            else if (sourceType === 'knowledge') detail = (row.appName as string) || ''
                            else if (sourceType === 'photos') detail = (row.locationName as string) || ''
                            else if (sourceType === 'location') {
                              const lat = row.lat as number | null
                              const lng = row.lng as number | null
                              detail = lat != null && lng != null ? `${lat.toFixed(3)}, ${lng.toFixed(3)}` : ''
                            } else if (sourceType === 'weather') detail = (row.conditions as string) || ''
                            else if (sourceType === 'subscription') detail = (row.provider as string) || ''
                            const title = (row.title as string) || (row.subject as string) || ''
                            return (
                              <tr key={row.id as string} className="border-t border-white/[0.04]">
                                <td className="px-2 py-1.5 text-white/40 whitespace-nowrap">{row.occurredAt as string}</td>
                                <td className="px-2 py-1.5 truncate max-w-48" title={title}>{title}</td>
                                <td className="px-2 py-1.5 text-white/40 truncate max-w-48" title={detail}>{detail}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Analyze with AI */}
        <section className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <h2 className="text-sm font-medium text-white/75 font-serif-display">Activity overview</h2>
              <p className="text-xs text-white/35 mt-0.5">
                {analysis
                  ? `Generated ${new Date(analysis.generatedAt).toLocaleString()}`
                  : 'No analysis yet. Import sources above and click Analyze with AI.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleAnalyze()}
                disabled={analyzing || !activityIngestEnabled || records.length === 0}
                title={
                  !activityIngestEnabled
                    ? 'Enable Activity analysis in Settings to run structured analysis'
                    : records.length === 0
                      ? 'Import at least one source first'
                      : 'Sends activity events to your configured AI provider'
                }
                className="flex items-center gap-1.5 text-xs text-amber-300/80 hover:text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                {analyzing ? (
                  <>Analyzing…</>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                    </svg>
                    Analyze with AI
                  </>
                )}
              </button>
              {records.length > 0 && activityIngestEnabled && (
                <button
                  onClick={() => void refreshSummary()}
                  title="Reload cached summary"
                  className="text-[10px] text-white/30 hover:text-white/60 cursor-pointer"
                >
                  <FontAwesomeIcon icon={faRefresh} />
                </button>
              )}
            </div>
          </div>

          <div className="mb-4">
            <AnalysisEstimateBar
              estimate={estimate}
              loading={estimating}
              tier={analysisTier}
              onTierChange={handleTierChange}
              onEstimate={() => void handleEstimate()}
              disabled={analyzing || !activityIngestEnabled}
              error={estimateError}
            />
          </div>

          {analyzeError && (
            <p className="text-xs text-red-400 mb-3">{analyzeError}</p>
          )}

          {analysis ? (
            <div className="border-t border-white/5 pt-4">
              <ActivityWidget analysis={analysis} />
            </div>
          ) : !activityIngestEnabled ? (
            <div className="border-t border-white/5 pt-4 text-center">
              <p className="text-xs text-white/30">Enable Activity analysis in Settings to run structured analysis</p>
            </div>
          ) : null}

          {summary?.sourceAnalyses && summary.sourceAnalyses.length > 0 && (
            <div className="border-t border-white/5 pt-4 mt-4">
              <h3 className="text-xs font-medium text-white/50 mb-3 font-serif-display">Per-source analyses</h3>
              <div className="space-y-3">
                {summary.sourceAnalyses.map((sa) => (
                  <details key={sa.sourceType} className="rounded-lg border border-white/[0.07] bg-black/10">
                    <summary className="cursor-pointer px-3 py-2 text-xs text-white/60 hover:text-white/80 transition-colors flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
                      {sa.sourceType}
                      <span className="text-[10px] text-white/30 ml-auto">{new Date(sa.generatedAt).toLocaleString()}</span>
                    </summary>
                    <div className="px-3 pb-3 pt-1 text-[11px] leading-relaxed text-white/45 whitespace-pre-wrap">
                      {sa.analysis}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}
        </section>

        <p className="mt-6 text-[10px] leading-relaxed text-white/25">
          Activity events and analysis are stored locally in an unencrypted database. Email bodies, Amazon order details, and location data are redacted before any AI summary generation.
        </p>
      </div>
    </div>
  )
}
