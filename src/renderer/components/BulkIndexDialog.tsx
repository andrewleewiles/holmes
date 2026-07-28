import { type FC, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPause, faPlay, faStop, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { DocumentContextProgress, IndexEstimate, ModelTier, Project } from '@shared/types'
import { IndexEstimateBar } from './IndexEstimateBar'
import { ProjectIcon } from './ProjectIcon'
import { useDocumentIndexState, useDocumentIndexProgress } from '../hooks/useDocumentIndex'

interface BulkIndexDialogProps {
  /** Connected, visible sources — the only ones a batch can run over. */
  projects: Project[]
  enabled: boolean
  defaultTier: ModelTier
  onClose: () => void
  onIndexed: () => void
}

const CONTROL =
  'flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/55 transition-colors hover:border-holmes-primary/30 hover:text-holmes-primary-light disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed'

export const BulkIndexDialog: FC<BulkIndexDialogProps> = ({ projects, enabled, defaultTier, onClose, onIndexed }) => {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)))
  const [tier, setTier] = useState<ModelTier>(defaultTier)
  const [force, setForce] = useState(false)
  const [estimate, setEstimate] = useState<IndexEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [progress, setProgress] = useState<DocumentContextProgress | null>(null)

  const indexState = useDocumentIndexState()
  useDocumentIndexProgress((p) => setProgress(p))

  const status = indexState?.status ?? 'idle'
  const runActive = status === 'running' || status === 'stopping'
  const batchRun = indexState?.scope === 'all'
  const batchActive = runActive && batchRun
  const batchPaused = status === 'paused' && batchRun
  const pausing = batchActive && indexState?.pendingAction === 'pause'
  const stopping = batchActive && indexState?.pendingAction === 'stop'
  const liveProgress = batchActive ? progress ?? indexState?.progress ?? null : null

  const selectedIds = useMemo(() => projects.filter((p) => selected.has(p.id)).map((p) => p.id), [projects, selected])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !batchActive) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, batchActive])

  // A stale estimate is worse than none: drop it whenever the inputs move.
  useEffect(() => {
    setEstimate(null)
    setEstimateError(null)
  }, [tier, force, selectedIds.join(',')])

  const handleEstimate = async () => {
    if (!enabled || selectedIds.length === 0 || estimating) return
    setEstimating(true)
    setEstimateError(null)
    try {
      setEstimate(await window.electronAPI.documents.estimateAll(tier, { projectIds: selectedIds, force }))
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : 'Estimate failed')
    } finally {
      setEstimating(false)
    }
  }

  const handleStart = async (resume = false) => {
    if (!enabled || starting || runActive || selectedIds.length === 0) return
    setStarting(true)
    setProgress(null)
    try {
      await window.electronAPI.documents.generateAll({
        ...(resume ? { resume: true } : {}),
        tier,
        projectIds: selectedIds,
        ...(force ? { force: true } : {}),
      })
      onIndexed()
    } catch {
      // The run state carries the failure; the user can start it again.
    } finally {
      setStarting(false)
      setProgress(null)
    }
  }

  // Results are discarded: every state change is broadcast on the shared
  // documents:state channel, which is what drives indexState here.
  const handlePause = async () => {
    try { await window.electronAPI.documents.pause() } catch { /* may have just finished */ }
  }

  const handleStop = async () => {
    try { await window.electronAPI.documents.abort() } catch { /* may have just finished */ }
  }

  const toggle = (projectId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const allSelected = selectedIds.length === projects.length && projects.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={() => { if (!batchActive) onClose() }}>
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-5 py-3.5">
          <h2 className="flex-1 font-serif-display text-lg text-white/85">Bulk index</h2>
          <button
            onClick={onClose}
            className="text-white/35 transition-colors hover:text-white/70 cursor-pointer"
            aria-label="Close"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 scrollbar-thin">
          {!enabled && (
            <p className="text-[11px] text-amber-200/70">
              Document context is disabled — enable it in Settings before indexing.
            </p>
          )}

          {projects.length === 0 ? (
            <p className="text-[11px] text-white/40">
              No connected sources. Add a path to a source first, then bulk index.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider text-white/35">
                  Sources ({selectedIds.length}/{projects.length})
                </span>
                <button
                  onClick={() => setSelected(allSelected ? new Set() : new Set(projects.map((p) => p.id)))}
                  className="text-[11px] text-white/40 transition-colors hover:text-white/70 cursor-pointer"
                >
                  {allSelected ? 'Select none' : 'Select all'}
                </button>
              </div>

              <div className="max-h-60 divide-y divide-white/[0.05] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/15 scrollbar-thin">
                {projects.map((project) => (
                  <label
                    key={project.id}
                    className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-white/[0.03]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(project.id)}
                      onChange={() => toggle(project.id)}
                      disabled={batchActive}
                      className="accent-[#47a08f] cursor-pointer"
                    />
                    <ProjectIcon icon={project.icon} className="shrink-0 text-[13px]" />
                    <span className="w-40 shrink-0 truncate text-[13px] text-white/70">{project.name}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-[10px] text-white/25" title={project.path ?? ''}>
                      {(project.sources?.length ?? 0) > 1
                        ? `${project.sources.length} paths`
                        : project.path}
                    </span>
                  </label>
                ))}
              </div>

              <IndexEstimateBar
                estimate={estimate}
                loading={estimating}
                tier={tier}
                onTierChange={setTier}
                onEstimate={() => void handleEstimate()}
                disabled={!enabled || runActive || starting || selectedIds.length === 0}
                error={estimateError}
              />

              <label className="flex items-start gap-2 text-[10px] text-white/45 cursor-pointer">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                  disabled={runActive || starting}
                  className="mt-0.5 accent-[#47a08f] cursor-pointer"
                />
                <span>
                  Full re-index — ignore every cached summary and regenerate from scratch.
                  {force && (
                    <span className="text-amber-200/70"> Nothing is reused, so this re-spends the full cost of every file and photo.</span>
                  )}
                </span>
              </label>

              {batchActive && liveProgress && (
                <div className="rounded-lg border border-holmes-primary/20 bg-holmes-primary/[0.06] px-3 py-2 text-[11px] text-holmes-primary-light">
                  {liveProgress.batchLabel ? `${liveProgress.batchLabel} — ` : ''}{liveProgress.message}
                  {liveProgress.total ? ` (${liveProgress.current ?? 0}/${liveProgress.total})` : ''}
                </div>
              )}
              {pausing && (
                <p className="text-[11px] text-amber-200/70">
                  Pausing — finishing the documents already in flight, then stopping. Nothing indexed so far is lost.
                </p>
              )}
              {stopping && <p className="text-[11px] text-amber-200/70">Stopping…</p>}
              {batchPaused && (
                <p className="text-[11px] text-amber-200/70">
                  {indexState?.message ?? 'Indexing paused.'} Resume picks up where it stopped and skips everything already finished.
                </p>
              )}
              {!runActive && !batchPaused && batchRun && indexState?.message && (
                <p className="text-[11px] text-white/45">{indexState.message}</p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.07] px-5 py-3">
          {batchActive ? (
            <>
              <button onClick={() => void handlePause()} disabled={Boolean(indexState?.pendingAction)} className={CONTROL}>
                <FontAwesomeIcon icon={faPause} className="text-[10px]" />
                Pause
              </button>
              <button onClick={() => void handleStop()} disabled={stopping} className={CONTROL}>
                <FontAwesomeIcon icon={faStop} className="text-[10px]" />
                Stop
              </button>
              <span className="ml-auto text-[10px] text-white/30">Indexing — this dialog can stay open.</span>
            </>
          ) : (
            <>
              <button
                onClick={() => void handleStart(batchPaused)}
                disabled={!enabled || starting || runActive || selectedIds.length === 0}
                title={
                  !enabled
                    ? 'Enable Document context in Settings'
                    : runActive
                      ? 'Another index run is in progress — only one can run at a time'
                      : batchPaused
                        ? 'Resume the paused batch, skipping every document already finished'
                        : 'Index the selected sources, one at a time'
                }
                className="flex items-center gap-1.5 rounded-lg border border-holmes-primary/40 bg-holmes-primary/[0.12] px-3 py-1.5 text-[12px] text-holmes-primary-light transition-colors hover:border-holmes-primary/60 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                <FontAwesomeIcon icon={faPlay} className="text-[10px]" />
                {batchPaused ? 'Resume indexing' : 'Start indexing'}
              </button>
              {batchPaused && (
                <button onClick={() => void handleStop()} className={CONTROL}>
                  <FontAwesomeIcon icon={faStop} className="text-[10px]" />
                  Discard
                </button>
              )}
              <button
                onClick={onClose}
                className="ml-auto rounded-md px-3 py-1.5 text-xs text-white/50 transition-colors hover:text-white/80 cursor-pointer"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
