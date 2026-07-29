import { type FC, useEffect, useState } from 'react'
import type {
  Project,
  ModelInfo,
  ReasoningEffort,
  HealthRecord,
  HealthObservation,
  HealthObservationType,
  HealthIngestProgress,
  HealthLiveStatus,
  HealthLiveSyncProgress,
} from '@shared/types'
import { ModelSelector } from './ModelSelector'
import { ProjectIcon } from './ProjectIcon'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { HealthWidget } from './HealthWidget'
import { HealthSourcesPanel } from './HealthSourcesPanel'

interface HealthPageProps {
  project: Project
  healthAnalysisEnabled: boolean
  healthLiveSyncEnabled: boolean
  onAnalyzeHealth: (projectId: string) => Promise<void>
  onChooseDirectory: () => Promise<void>
  onClearDirectory: (projectId: string) => Promise<void>
  onAddFiles: (projectId: string) => Promise<void>
  onRemoveFile: (projectId: string, filePath: string) => Promise<void>
  models: ModelInfo[]
  selectedModel: string
  selectedEffort: ReasoningEffort
  onModelChange: (model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onStartConversation: (prompt: string, model: string, effort: ReasoningEffort) => Promise<void>
}

function fileName(path: string): string {
  return path.split('/').pop() || path.split('\\').pop() || path
}

const OBSERVATION_TYPE_FILTERS: Array<{ value: ''; label: 'All' } | { value: HealthObservationType; label: string }> = [
  { value: '', label: 'All' },
  { value: 'lab', label: 'Lab' },
  { value: 'vital', label: 'Vital' },
  { value: 'workout', label: 'Workout' },
  { value: 'medication', label: 'Medication' },
  { value: 'observation', label: 'Observation' },
  { value: 'condition', label: 'Condition' },
]

export const HealthPage: FC<HealthPageProps> = ({
  project,
  healthAnalysisEnabled,
  healthLiveSyncEnabled,
  onAnalyzeHealth,
  onChooseDirectory,
  onClearDirectory,
  onAddFiles,
  onRemoveFile,
  models,
  selectedModel,
  selectedEffort,
  onModelChange,
  onEffortChange,
  onStartConversation,
}) => {
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [composerError, setComposerError] = useState<string | null>(null)

  const [records, setRecords] = useState<HealthRecord[]>([])
  const [observations, setObservations] = useState<HealthObservation[]>([])
  const [observationsFilter, setObservationsFilter] = useState<string>('')
  const [progress, setProgress] = useState<HealthIngestProgress | null>(null)

  const [liveStatus, setLiveStatus] = useState<HealthLiveStatus | null>(null)
  const [liveProgress, setLiveProgress] = useState<HealthLiveSyncProgress | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveBusy, setLiveBusy] = useState(false)
  const [showConnectHelp, setShowConnectHelp] = useState(false)

  useEffect(() => {
    const unsubscribe = window.electronAPI.health.onProgress((p) => setProgress(p))
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.health.onLiveSyncProgress((p) => {
      setLiveProgress(p)
      if (p.phase === 'complete' || p.phase === 'error') {
        setLiveBusy(false)
        if (p.phase === 'complete') {
          void refreshRecords()
          void refreshObservations()
          void refreshLiveStatus()
        }
      }
    })
    return unsubscribe
  }, [])

  const refreshRecords = async () => {
    try {
      const list = await window.electronAPI.health.listRecords(project.id)
      setRecords(list)
    } catch {
      // ignore — will refresh next time
    }
  }

  const refreshObservations = async () => {
    try {
      const list = await window.electronAPI.health.listObservations(project.id, {
        type: observationsFilter || undefined,
        limit: 500,
      })
      setObservations(list)
    } catch {
      // ignore
    }
  }

  const refreshLiveStatus = async () => {
    try {
      const status = await window.electronAPI.health.liveStatus(project.id)
      setLiveStatus(status)
    } catch {
      // ignore — user can retry
    }
  }

  useEffect(() => {
    void refreshRecords()
    void refreshObservations()
    void refreshLiveStatus()
  }, [project.id])

  useEffect(() => {
    void refreshObservations()
  }, [project.id, observationsFilter])

  useEffect(() => {
    if (progress?.phase === 'complete' || progress?.phase === 'error') {
      void refreshRecords()
      void refreshObservations()
      if (progress.phase === 'complete' && healthAnalysisEnabled) {
        void onAnalyzeHealth(project.id).catch(() => {})
      }
    }
  }, [progress?.phase])

  const handleIngest = async (filePath: string) => {
    setProgress({ phase: 'reading', message: `Starting ${filePath.split('/').pop()}`, current: 0, total: 0 })
    await window.electronAPI.health.ingest(project.id, filePath)
  }

  const handleAbort = async () => {
    await window.electronAPI.health.abort()
    setProgress(null)
  }

  const handleDeleteRecord = async (recordId: string) => {
    await window.electronAPI.health.deleteRecord(recordId)
    await refreshRecords()
    await refreshObservations()
  }

  const handleRefreshSummary = async () => {
    try {
      await window.electronAPI.health.refreshSummary(project.id)
      await onAnalyzeHealth(project.id)
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Summary refresh failed')
    }
  }

  const handleLiveSync = async () => {
    setLiveBusy(true)
    setLiveError(null)
    setLiveProgress({ phase: 'querying', message: 'Starting live sync…', typesQueried: ['all'], observationsInserted: 0 })
    try {
      await window.electronAPI.health.liveSync(project.id)
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : 'Live sync failed')
      setLiveBusy(false)
      setLiveProgress(null)
    }
  }

  const handleLiveAbort = async () => {
    try {
      await window.electronAPI.health.liveAbort()
    } catch {
      // ignore
    }
  }

  const handleConnectHelp = () => {
    setShowConnectHelp((prev) => !prev)
  }

  const handleAnalyze = async () => {
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      await onAnalyzeHealth(project.id)
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Health analysis failed')
    }
    setAnalyzing(false)
  }

  const submit = async () => {
    const content = prompt.trim()
    if (!content || !selectedModel || submitting) return
    setSubmitting(true)
    setComposerError(null)
    try {
      await onStartConversation(content, selectedModel, selectedEffort)
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'Could not start the conversation')
      setSubmitting(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<ProjectIcon icon={project.icon} className={PAGE_HEADER_ICON} />}
        title={project.name}
      />

      <div className="max-w-4xl w-full mx-auto px-8 py-6">
        <p className="text-xs text-white/40 mb-6">
          Structured health overview synthesized from your documents
        </p>

        {!healthAnalysisEnabled && (
          <div className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3">
            <p className="text-xs leading-relaxed text-amber-100/65">
              Health AI analysis is disabled. You can still import sources and add documents, but structured analysis requires enabling it in Settings so health documents can be sent to your configured AI provider.
            </p>
          </div>
        )}

        {/* Live Apple Health */}
        <section className="mb-6 rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/[0.07] to-emerald-400/[0.02] p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-white/80 font-serif-display">Live Apple Health</h2>
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                    liveStatus?.available && liveStatus?.authorized === 'authorized'
                      ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200/80'
                      : 'border-white/10 bg-white/[0.04] text-white/40'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      liveStatus?.available && liveStatus?.authorized === 'authorized'
                        ? 'animate-pulse bg-emerald-300'
                        : 'bg-white/30'
                    }`}
                  />
                  {liveStatus?.available
                    ? liveStatus?.authorized === 'authorized'
                      ? 'Connected'
                      : liveStatus?.authorized === 'denied'
                        ? 'Not authorized'
                        : liveStatus?.authorized === 'unavailable'
                          ? 'HealthKit unavailable'
                          : 'Pending'
                    : 'Sidecar not built'}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/45">
                Reads live Apple Health data via a local Swift sidecar and stores it as observations. Data stays on your Mac.
              </p>
              {liveStatus?.available && liveStatus?.authorized === 'unavailable' && (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-200/55">
                  The sidecar is built, but HealthKit access requires an Apple Developer signing certificate. Without Xcode and a Developer ID, macOS blocks HealthKit access for ad-hoc signed binaries. As an alternative, use Apple Health XML export (Phase 2 ingestion) — export from the Health app on iPhone, add the file to this project's directory.
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {!liveStatus?.available && (
                <button
                  onClick={() => void handleConnectHelp()}
                  className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-200/80 hover:border-emerald-400/50 transition-colors cursor-pointer"
                  title="Show build instructions for the HealthKit sidecar"
                >
                  Build
                </button>
              )}
              {liveStatus?.available && liveStatus?.authorized !== 'authorized' && (
                <button
                  onClick={() => void handleLiveSync()}
                  disabled={liveBusy}
                  title="Authorize Holmes HealthKit Sidecar in System Settings → Privacy & Security → Health"
                  className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-200/80 hover:border-emerald-400/50 disabled:opacity-40 cursor-pointer"
                >
                  Connect
                </button>
              )}
              {liveStatus?.available && liveStatus?.authorized === 'authorized' && (
                <button
                  onClick={() => void handleLiveSync()}
                  disabled={liveBusy}
                  className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {liveBusy ? 'Syncing…' : 'Sync now'}
                </button>
              )}
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

          {showConnectHelp && !liveStatus?.available && (
            <div className="mt-3 rounded-xl border border-emerald-400/15 bg-black/20 p-3 text-[11px] leading-relaxed text-white/55">
              <p className="font-medium text-white/70">To enable live Apple Health sync:</p>
              <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
                <li>Run <code className="rounded bg-black/40 px-1 py-0.5 text-emerald-200/80">pnpm build:sidecar</code> in the project root.</li>
                <li>Click <span className="text-emerald-200/80">Connect</span> here.</li>
                <li>Open System Settings → Privacy &amp; Security → Health, then grant access to <span className="text-emerald-200/80">Holmes HealthKit Sidecar</span>.</li>
                <li>Click <span className="text-emerald-200/80">Sync now</span> to import the last 7 days.</li>
              </ol>
            </div>
          )}

          {liveStatus?.lastSyncAt && (
            <p className="mt-3 text-[10px] text-white/40">
              Last sync: {new Date(liveStatus.lastSyncAt).toLocaleString()}
              {healthLiveSyncEnabled ? ' · auto-sync hourly' : ''}
            </p>
          )}

          {liveProgress && (
            <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3">
              <div className="flex items-center gap-2 text-xs text-white/55">
                <span className="capitalize text-emerald-300/80">{liveProgress.phase}</span>
                <span className="text-white/35">— {liveProgress.message}</span>
              </div>
              {liveProgress.typesQueried.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 text-[9px] text-white/35">
                  {liveProgress.typesQueried.map((t) => (
                    <span key={t} className="rounded-full bg-white/[0.04] px-1.5 py-0.5">{t}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {liveError && (
            <p className="mt-2 text-xs text-red-300">{liveError}</p>
          )}
        </section>

        {/* Documents */}
        <section className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-sm font-medium text-white/75 font-serif-display">Health documents</h2>
              <p className="text-xs text-white/35 mt-0.5">
                Bloodwork, MyChart exports, clinical notes, or personal health reference documents.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] uppercase tracking-wider text-white/25">Storage</div>
              <div className="mt-0.5 max-w-56 truncate text-[11px] text-white/45" title={project.path || undefined}>
                {project.path || 'No directory selected'}
              </div>
            </div>
          </div>

          {project.path ? (
            <div className="flex items-center gap-1.5 mb-3">
              <svg className="w-3.5 h-3.5 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="text-xs text-white/40 truncate flex-1">{project.path}</span>
              <button
                onClick={() => void onClearDirectory(project.id)}
                className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer shrink-0"
                title="Remove directory"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              onClick={() => void onChooseDirectory()}
              className="mb-3 text-xs text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              Set directory...
            </button>
          )}

          <div className="space-y-1 mb-3 max-h-32 overflow-y-auto scrollbar-thin">
            {project.files.map((f) => (
              <div key={f} className="flex items-center gap-1.5 group/file">
                <svg className="w-3 h-3 shrink-0 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-[11px] text-white/50 truncate flex-1" title={f}>{fileName(f)}</span>
                <button
                  onClick={() => void onRemoveFile(project.id, f)}
                  className="opacity-0 group-hover/file:opacity-100 text-[10px] text-white/30 hover:text-red-400 transition-all cursor-pointer shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => void onAddFiles(project.id)}
              className="text-xs text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add files
            </button>
            {(project.files.length > 0 || project.path || records.length > 0) && (
              <button
                onClick={() => void handleAnalyze()}
                disabled={analyzing || !healthAnalysisEnabled}
                title={
                  !healthAnalysisEnabled
                    ? 'Enable Health AI analysis in Settings to run structured analysis'
                    : 'Sends Health project documents to your configured AI provider'
                }
                className="text-xs text-holmes-primary hover:text-holmes-primary-light transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {analyzing ? (
                  <>Analyzing...</>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                    </svg>
                    Analyze with AI
                  </>
                )}
              </button>
            )}
            {records.length > 0 && healthAnalysisEnabled && (
              <button
                onClick={() => void handleRefreshSummary()}
                disabled={analyzing}
                className="text-xs text-white/40 hover:text-holmes-primary-light transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1"
              >
                Refresh summary
              </button>
            )}
          </div>

          {analyzeError && (
            <p className="text-xs text-red-400 mt-3">{analyzeError}</p>
          )}
        </section>

        <HealthSourcesPanel
          records={records}
          progress={progress}
          onIngest={handleIngest}
          onAbort={handleAbort}
          onDelete={handleDeleteRecord}
          onRefresh={() => { void refreshRecords(); void refreshObservations() }}
          onLiveSync={handleLiveSync}
          liveBusy={liveBusy}
          onScanDirectory={async () => {
            await window.electronAPI.health.scanDirectory(project.id)
            await refreshRecords()
            await refreshObservations()
          }}
          scanning={progress?.phase === 'reading' && progress.message.startsWith('Scanning')}
          hasDirectory={Boolean(project.path)}
        />

        {/* Observations */}
        {records.length > 0 && (
          <section className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
            <div className="flex items-center justify-between gap-4 mb-3">
              <h2 className="text-sm font-medium text-white/75 font-serif-display">Observations</h2>
              <select
                value={observationsFilter}
                onChange={(event) => setObservationsFilter(event.target.value)}
                className="rounded-lg border border-white/10 bg-black/15 px-2 py-1 text-[11px] text-white/65 outline-none"
              >
                {OBSERVATION_TYPE_FILTERS.map((opt) => (
                  <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="max-h-72 overflow-y-auto scrollbar-thin">
              {observations.length === 0 ? (
                <p className="text-center text-xs text-white/30 py-6">No observations of this type yet.</p>
              ) : (
                <table className="w-full text-[11px] text-white/60">
                  <thead className="sticky top-0 bg-holmes-surface text-[10px] uppercase tracking-wider text-white/35">
                    <tr>
                      <th className="px-2 py-1 text-left font-normal">Name</th>
                      <th className="px-2 py-1 text-left font-normal">Value</th>
                      <th className="px-2 py-1 text-left font-normal">Unit</th>
                      <th className="px-2 py-1 text-left font-normal">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observations.map((obs) => (
                      <tr key={obs.id} className="border-t border-white/[0.04]">
                        <td className="px-2 py-1.5 truncate max-w-48" title={obs.displayName}>{obs.displayName}</td>
                        <td className="px-2 py-1.5">
                          {obs.valueText ?? (obs.valueReal != null ? String(obs.valueReal) : '')}
                        </td>
                        <td className="px-2 py-1.5 text-white/40">{obs.unit ?? ''}</td>
                        <td className="px-2 py-1.5 text-white/40">{obs.effectiveDate ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        )}

        {/* Analysis */}
        {project.healthAnalysis ? (
          <div className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-white/75 font-serif-display">Health overview</h2>
              <span className="text-[10px] text-white/30">
                Generated {new Date(project.healthAnalysis.generatedAt).toLocaleString()}
              </span>
            </div>
            <HealthWidget analysis={project.healthAnalysis} />
          </div>
        ) : (
          <div className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6 text-center">
            <p className="text-sm text-white/40">
              {healthAnalysisEnabled
                ? 'No analysis yet. Import sources above and click Analyze with AI.'
                : 'No analysis yet. Enable Health AI analysis in Settings to run structured analysis.'}
            </p>
          </div>
        )}

        {/* Conversation composer */}
        <section className="overflow-hidden rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/[0.07] to-emerald-400/[0.03]">
          <div className="border-b border-white/[0.06] px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-400/15 text-emerald-300">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <div>
                  <h2 className="text-sm font-medium text-white/80 font-serif-display">Ask Holmes about your Health project</h2>
                  <p className="mt-0.5 text-[11px] text-white/35">Starts a conversation with live project context on every turn.</p>
                </div>
              </div>
              <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[9px] font-semibold tracking-[0.13em] text-emerald-200/80">
                LIVE CONTEXT
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
              <span className={`rounded-full px-2 py-1 ${project.healthAnalysis ? 'bg-emerald-400/10 text-emerald-200/70' : 'bg-white/[0.05] text-white/25'}`}>
                {project.healthAnalysis ? 'Health analysis included' : 'No health analysis yet'}
              </span>
              <span className={`rounded-full px-2 py-1 ${project.path || project.files.length ? 'bg-emerald-400/10 text-emerald-200/70' : 'bg-white/[0.05] text-white/25'}`}>
                {project.path ? 'Project directory included' : `${project.files.length} explicit files`}
              </span>
              <span className={`rounded-full px-2 py-1 ${records.length > 0 ? 'bg-emerald-400/10 text-emerald-200/70' : 'bg-white/[0.05] text-white/25'}`}>
                {records.length > 0 ? `${records.length} ingested sources` : 'No ingested sources'}
              </span>
            </div>
          </div>

          <div className="p-4">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              rows={3}
              disabled={submitting}
              placeholder="Ask about patterns across your health documents, regimen, lab results, or open threads..."
              className="w-full resize-none rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm leading-relaxed text-white/80 outline-none placeholder:text-white/25 focus:border-emerald-400/40 disabled:opacity-50"
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="min-w-56 flex-1">
                <ModelSelector models={models} selectedModel={selectedModel} onSelect={onModelChange} disabled={submitting} />
              </div>
              <select
                value={selectedEffort}
                onChange={(event) => onEffortChange(event.target.value as ReasoningEffort)}
                disabled={submitting}
                className="rounded-lg border border-white/10 bg-holmes-surface px-3 py-2 text-xs text-white/65 outline-none disabled:opacity-50"
              >
                <option value="low">Low effort</option>
                <option value="medium">Medium effort</option>
                <option value="high">High effort</option>
              </select>
              <button
                onClick={() => void submit()}
                disabled={!prompt.trim() || !selectedModel || submitting}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40 transition-colors cursor-pointer"
              >
                {submitting ? 'Starting...' : 'Start conversation'}
              </button>
            </div>

            <p className="mt-3 text-[10px] leading-relaxed text-white/25">
              Your saved health analysis and supported project documents are sent to the configured AI provider, up to an 80,000-character context budget.
            </p>
            {composerError && <p className="mt-2 text-xs text-red-300">{composerError}</p>}
          </div>
        </section>

        <p className="mt-6 text-[10px] leading-relaxed text-white/25">
          Health documents and any analysis are stored locally in an unencrypted database. The analysis is a synthesis of self-reported information, not a diagnosis or medical advice.
        </p>
      </div>
    </div>
  )
}

