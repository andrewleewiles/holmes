import { type FC, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faRefresh, faFolder, faFileLines, faComments, faLayerGroup, faPause, faStop, faPlay, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons'
import type { ContextProvenance, DocumentContextTree, DocumentContextProgress, DocumentIndexState, IndexEstimate, ModelTier } from '@shared/types'
import { IndexEstimateBar, formatEstimateCost } from './IndexEstimateBar'
import { ProvenanceExplorer } from './ProvenanceExplorer'
import { ProvenanceText, claimCoverage } from './ProvenanceText'
import { ContextVersionHistory } from './ContextVersionHistory'
import { useDocumentIndexState, useDocumentIndexProgress } from '../hooks/useDocumentIndex'

interface DocumentContextPanelProps {
  projectId: string
  projectName: string
  enabled: boolean
  hasDirectory: boolean
  defaultTier: ModelTier
  onIndexed?: () => void
  reloadKey?: number
  /** Replaces the default layer-group glyph — lets the card wear the project's own icon. */
  icon?: ReactNode
  /** Path editor / connect controls, rendered directly under the header. */
  directoryRow?: ReactNode
  /** This source's domain analysis (activity, health, psychology), rendered at the bottom. */
  footer?: ReactNode
}

const CONTROL_BUTTON =
  'shrink-0 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/55 hover:border-cyan-400/30 hover:text-cyan-200/80 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-white/55 cursor-pointer transition-colors'

// Citations are recorded against the long text only — the SHORT headline is
// explicitly generated without them — so highlighting appears once expanded.
const ReadMore: FC<{ short: string; long: string; provenance?: ContextProvenance | null }> = ({ short, long, provenance }) => {
  const [expanded, setExpanded] = useState(false)
  const hasMore = long.trim().length > short.trim().length + 4
  const coverage = expanded ? claimCoverage(long, provenance ?? null) : null
  return (
    <div>
      <p className="text-[11px] leading-relaxed text-white/55 whitespace-pre-wrap">
        {expanded ? <ProvenanceText text={long} provenance={provenance ?? null} /> : short}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {hasMore && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-cyan-300/70 hover:text-cyan-200 transition-colors cursor-pointer"
          >
            {expanded ? 'Show less' : 'Read more'}
          </button>
        )}
        {coverage !== null && (
          <span className="text-[9px] text-white/25" title="Hover a highlighted passage to see which source it came from. The rest is synthesis the model did not attribute to any single source.">
            {coverage > 0
              ? `${Math.round(coverage * 100)}% of this text is attributed — hover to trace`
              : 'no passages attributed'}
          </span>
        )}
      </div>
    </div>
  )
}

export const DocumentContextPanel: FC<DocumentContextPanelProps> = ({ projectId, projectName, enabled, hasDirectory, defaultTier, onIndexed, reloadKey, icon, directoryRow, footer }) => {
  const [tree, setTree] = useState<DocumentContextTree | null>(null)
  const [progress, setProgress] = useState<DocumentContextProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resultStatus, setResultStatus] = useState<string | null>(null)
  const [invoking, setInvoking] = useState(false)
  const [tier, setTier] = useState<ModelTier>(defaultTier)
  const [estimate, setEstimate] = useState<IndexEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const [forceReindex, setForceReindex] = useState(false)
  const [activeSource, setActiveSource] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyReloadKey, setHistoryReloadKey] = useState(0)
  const previousStatusRef = useRef<DocumentIndexState['status']>('idle')
  const busyHereRef = useRef(false)

  const loadTree = useCallback(async () => {
    try {
      const data = await window.electronAPI.documents.getTree(projectId)
      setTree(data)
    } catch {
      setTree(null)
    }
  }, [projectId])

  useEffect(() => {
    void loadTree()
  }, [loadTree, reloadKey])

  useEffect(() => {
    setTier(defaultTier)
  }, [defaultTier])

  // Explicitly triggered: estimating walks the whole directory, which for a
  // photo tree is tens of thousands of entries on possibly external storage.
  // Never run it on mount — a Data page with nine panels would fire nine
  // full-tree scans at once.
  const handleEstimate = async (sourcePath?: string | null) => {
    if (!enabled || !hasDirectory || estimating) return
    setEstimating(true)
    setEstimateError(null)
    try {
      setEstimate(await window.electronAPI.documents.estimate(projectId, tier, { sourcePath: sourcePath ?? undefined, force: forceReindex }))
    } catch (err) {
      setEstimateError(err instanceof Error ? err.message : 'Estimate failed')
    } finally {
      setEstimating(false)
    }
  }

  // A stale estimate is worse than none: drop it when the inputs change.
  useEffect(() => {
    setEstimate(null)
    setEstimateError(null)
  }, [projectId, tier, enabled, hasDirectory, reloadKey, forceReindex])

  const indexState = useDocumentIndexState()
  useDocumentIndexProgress((p) => {
    if (busyHereRef.current) setProgress(p)
  })

  const status = indexState?.status ?? 'idle'
  const runActive = status === 'running' || status === 'stopping'
  const isThisProject =
    indexState?.scope === 'project' && indexState.projectId === projectId
  const busyHere = runActive && isThisProject
  const busyElsewhere = runActive && !isThisProject
  const pausedHere = status === 'paused' && isThisProject
  const pausing = busyHere && indexState?.pendingAction === 'pause'
  const stopping = busyHere && indexState?.pendingAction === 'stop'
  const liveProgress = busyHere ? progress ?? indexState?.progress ?? null : null
  const terminalMessage = !runActive && isThisProject ? indexState?.message ?? null : null

  useEffect(() => {
    busyHereRef.current = busyHere
  }, [busyHere])

  // Reload the tree whenever a run that touched this project ends — including runs
  // started elsewhere (the Data page batch, or the hourly background timer).
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = status
    if ((previous === 'running' || previous === 'stopping') && !runActive && isThisProject) {
      void loadTree()
      // A finished run is exactly when new versions land.
      setHistoryReloadKey((k) => k + 1)
    }
  }, [status, runActive, isThisProject, loadTree])

  const handleGenerate = async (sourcePath?: string | null) => {
    if (!enabled || !hasDirectory || runActive || invoking) return
    setActiveSource(sourcePath ?? null)
    setInvoking(true)
    setError(null)
    setResultStatus(null)
    setProgress(null)
    try {
      const result = await window.electronAPI.documents.generate(projectId, tier, { sourcePath: sourcePath ?? undefined, force: forceReindex })
      await loadTree()
      setHistoryReloadKey((k) => k + 1)
      if (result.outcome === 'paused' || result.outcome === 'stopped') {
        // The terminal message comes from the run state — it carries the honest counts.
        return
      }
      if (result.filesProcessed === 0) {
        setResultStatus('No supported files found in this directory. Supported formats: text (.txt, .md, .csv, .json, .xml…), PDF, Word (.docx), Excel (.xlsx), and images (.jpg, .png, .heic, .webp…).')
      } else {
        const spent = result.spent && result.spent.callsMade > 0
          ? ` Spent ${formatEstimateCost(result.spent.costUsd)} across ${result.spent.callsMade.toLocaleString()} calls.`
          : ''
        setResultStatus(`Indexed ${result.filesProcessed} item${result.filesProcessed === 1 ? '' : 's'} — ${result.filesGenerated} new, ${result.filesCached} cached.${spent}`)
        onIndexed?.()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Index build failed')
    } finally {
      setInvoking(false)
      setProgress(null)
      setActiveSource(null)
    }
  }

  // The result is discarded: the main process broadcasts every state change on
  // the shared documents:state channel, which is what drives indexState here.
  const handlePause = async () => {
    try {
      await window.electronAPI.documents.pause()
    } catch { /* The run may have just finished. */ }
  }

  const handleStop = async () => {
    try {
      await window.electronAPI.documents.abort()
    } catch { /* The run may have just finished. */ }
  }

  const fileCount = tree?.fileCount ?? 0
  const folderCount = tree?.folderCount ?? 0
  const nonRootFolders = (tree?.folders ?? []).filter((f) => f.relativePath !== '.')

  const mainLabel = busyHere
    ? pausing
      ? 'Pausing…'
      : stopping
        ? 'Stopping…'
        : 'Indexing…'
    : pausedHere
      ? 'Resume index'
      : tree?.rootContext
        ? 'Refresh index'
        : 'Build index'

  return (
    <div className="rounded-xl border border-white/[0.07] bg-holmes-surface overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.05]">
        {icon ?? <FontAwesomeIcon icon={faLayerGroup} className="text-cyan-400/70 text-xs shrink-0" />}
        <span className="text-sm text-white/70 flex-1 truncate font-serif-display">{projectName}</span>
        {tree && (fileCount > 0 || tree.rootContext) && (
          <span className="text-[10px] text-white/25 shrink-0">
            {fileCount} file{fileCount === 1 ? '' : 's'} · {folderCount} folder{folderCount === 1 ? '' : 's'}
            {tree.updatedAt ? ` · ${new Date(tree.updatedAt).toLocaleDateString()}` : ''}
          </span>
        )}
        {busyHere && (
          <>
            <button
              onClick={() => void handlePause()}
              disabled={Boolean(indexState?.pendingAction)}
              title="Stop cleanly at the next document. Finished documents stay saved and resuming skips them."
              className={CONTROL_BUTTON}
            >
              <FontAwesomeIcon icon={faPause} className="text-[10px]" />
              Pause
            </button>
            <button
              onClick={() => void handleStop()}
              disabled={stopping}
              title="Stop this run now. Finished documents stay saved."
              className={CONTROL_BUTTON}
            >
              <FontAwesomeIcon icon={faStop} className="text-[10px]" />
              Stop
            </button>
          </>
        )}
        {pausedHere && (
          <button
            onClick={() => void handleStop()}
            title="Discard the paused run. Finished documents stay saved."
            className={CONTROL_BUTTON}
          >
            <FontAwesomeIcon icon={faStop} className="text-[10px]" />
            Stop
          </button>
        )}
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          title="Every archived version of this source's contexts, newest first"
          className={`${CONTROL_BUTTON} ${historyOpen ? 'border-cyan-400/30 text-cyan-200/80' : ''}`}
        >
          <FontAwesomeIcon icon={faClockRotateLeft} className="text-[10px]" />
          History
        </button>
        <button
          onClick={() => void handleGenerate()}
          disabled={!enabled || !hasDirectory || runActive || invoking}
          title={
            !enabled
              ? 'Enable Document context in Settings'
              : !hasDirectory
                ? 'Connect a directory first'
                : busyElsewhere
                  ? 'Another index run is in progress — only one can run at a time'
                  : pausedHere
                    ? 'Resume: re-runs the index and skips every document already finished'
                    : 'Build or refresh the index'
          }
          className={CONTROL_BUTTON}
        >
          <FontAwesomeIcon icon={pausedHere ? faPlay : faRefresh} className={`text-[10px] ${busyHere && !pausing && !stopping ? 'animate-spin' : ''}`} />
          {mainLabel}
        </button>
      </div>

      {directoryRow && (
        <div className="px-4 py-2 border-b border-white/[0.05] bg-black/10">{directoryRow}</div>
      )}

      <div className="px-4 py-3 space-y-3">
        {historyOpen && (
          <ContextVersionHistory projectId={projectId} reloadKey={historyReloadKey} />
        )}
        {!enabled && (
          <p className="text-[11px] text-amber-200/60">Document context is disabled — enable it in Settings to build the index.</p>
        )}
        {enabled && !hasDirectory && (
          <p className="text-[11px] text-white/35">Connect a directory above to index this source's documents.</p>
        )}
        {enabled && hasDirectory && (
          <>
            <IndexEstimateBar
              estimate={estimate}
              loading={estimating}
              tier={tier}
              onTierChange={setTier}
              onEstimate={() => void handleEstimate()}
              disabled={runActive || invoking}
              error={estimateError}
            />

            <label className="flex items-start gap-2 text-[10px] text-white/45 cursor-pointer">
              <input
                type="checkbox"
                checked={forceReindex}
                onChange={(e) => setForceReindex(e.target.checked)}
                disabled={runActive || invoking}
                className="mt-0.5 accent-cyan-400 cursor-pointer"
              />
              <span>
                Full re-index — ignore every cached summary and regenerate from scratch.
                {forceReindex && (
                  <span className="text-amber-200/70"> Nothing is reused, so this re-spends the full cost of every file and photo.</span>
                )}
              </span>
            </label>

            {(tree?.sources.length ?? 0) > 1 && (
              <div className="rounded-lg border border-white/[0.06] bg-black/10 divide-y divide-white/[0.05]">
                {tree?.sources.map((source) => (
                  <div key={source.path} className="flex items-center gap-2 px-3 py-2">
                    <FontAwesomeIcon icon={faFolder} className="text-[10px] text-white/25 shrink-0" />
                    <span className="flex-1 truncate text-[11px] text-white/55" title={source.path}>{source.path}</span>
                    <span className="shrink-0 text-[9px] text-white/25">
                      {source.rootContext ? `${source.fileCount} indexed` : 'not indexed'}
                    </span>
                    <button
                      onClick={() => void handleEstimate(source.path)}
                      disabled={runActive || invoking || estimating}
                      title="Estimate just this source"
                      className={CONTROL_BUTTON}
                    >
                      Estimate
                    </button>
                    <button
                      onClick={() => void handleGenerate(source.path)}
                      disabled={runActive || invoking}
                      title={forceReindex ? 'Re-index this source from scratch' : 'Index only this source'}
                      className={CONTROL_BUTTON}
                    >
                      <FontAwesomeIcon
                        icon={faRefresh}
                        className={`text-[10px] ${busyHere && activeSource === source.path ? 'animate-spin' : ''}`}
                      />
                      Index
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {error && <p className="text-[11px] text-red-300/80">{error}</p>}
        {busyHere && liveProgress && (
          <div className="text-[11px] text-cyan-200/70">
            {liveProgress.message}
            {liveProgress.total ? ` (${liveProgress.current ?? 0}/${liveProgress.total})` : ''}
          </div>
        )}
        {pausing && (
          <p className="text-[11px] text-amber-200/60">Pausing — finishing the documents already in flight, then stopping.</p>
        )}
        {stopping && <p className="text-[11px] text-amber-200/60">Stopping…</p>}
        {pausedHere && (
          <p className="text-[11px] text-amber-200/70">
            {terminalMessage ?? 'Indexing paused.'} Click “Resume index” to carry on.
          </p>
        )}
        {!runActive && !pausedHere && terminalMessage && <p className="text-[11px] text-white/45">{terminalMessage}</p>}
        {!runActive && resultStatus && <p className="text-[11px] text-white/45">{resultStatus}</p>}

        {tree?.rootContextShort ? (
          <div className="rounded-lg border border-cyan-400/15 bg-cyan-400/[0.04] p-3">
            <div className="text-[10px] uppercase tracking-wider text-cyan-200/50 mb-1.5">Root super-context</div>
            <ReadMore
              short={tree.rootContextShort}
              long={tree.rootContext ?? tree.rootContextShort}
              provenance={tree.folders.find((f) => f.relativePath === '.')?.provenance ?? null}
            />
            <div className="mt-2 pt-2 border-t border-cyan-400/10">
              <ProvenanceExplorer nodeRef={`project:${projectId}`} projectId={projectId} label="Built from" />
            </div>
          </div>
        ) : (
          !runActive && !resultStatus && !terminalMessage && enabled && hasDirectory && (
            <p className="text-[11px] text-white/35">No index yet. Click “Build index” to summarize this directory.</p>
          )
        )}

        {nonRootFolders.length > 0 && (
          <details className="group rounded-lg border border-white/[0.06] bg-black/10">
            <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 text-[11px] text-white/55 hover:text-white/75 transition-colors">
              <FontAwesomeIcon icon={faFolder} className="text-[10px] text-white/30" />
              Folder super-contexts ({nonRootFolders.length})
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-white/[0.05]">
              {nonRootFolders.map((folder) => (
                <div key={folder.folderPath} className="rounded border border-white/[0.05] bg-white/[0.02] p-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] text-white/60 truncate flex-1" title={folder.folderPath}>{folder.relativePath}/</span>
                    <span className="text-[9px] text-white/25 shrink-0">{folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}</span>
                  </div>
                  <ReadMore short={folder.contextShort || folder.context} long={folder.context} provenance={folder.provenance} />
                  <div className="mt-2 pt-2 border-t border-white/[0.05]">
                    <ProvenanceExplorer nodeRef={folder.folderPath} projectId={projectId} label="Built from" />
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}

        {(tree?.conversations.length ?? 0) > 0 && (
          <details className="group rounded-lg border border-white/[0.06] bg-black/10">
            <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 text-[11px] text-white/55 hover:text-white/75 transition-colors">
              <FontAwesomeIcon icon={faComments} className="text-[10px] text-white/30" />
              Conversation contexts ({tree?.conversations.length ?? 0})
              <span className="ml-auto text-[9px] text-white/25">summarized with this source and folded into its super-context</span>
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-white/[0.05]">
              {tree?.conversations.map((conversation) => (
                <details key={conversation.conversationId} className="rounded border border-white/[0.05] bg-white/[0.02]">
                  <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white/55 hover:text-white/75 transition-colors flex items-center gap-2">
                    <span className="truncate flex-1">{conversation.title}</span>
                    <span className="shrink-0 text-[9px] text-white/25">{conversation.updatedAt.slice(0, 10)}</span>
                  </summary>
                  <div className="px-2.5 pb-2.5 pt-1 border-t border-white/[0.04]">
                    <p className="text-[11px] leading-relaxed text-white/50 whitespace-pre-wrap">{conversation.context}</p>
                  </div>
                </details>
              ))}
            </div>
          </details>
        )}

        {(tree?.files.length ?? 0) > 0 && (
          <details className="group rounded-lg border border-white/[0.06] bg-black/10">
            <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 text-[11px] text-white/55 hover:text-white/75 transition-colors">
              <FontAwesomeIcon icon={faFileLines} className="text-[10px] text-white/30" />
              File contexts ({tree?.files.length ?? 0})
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-1 border-t border-white/[0.05]">
              {tree?.files.map((file) => (
                <details key={file.filePath} className="rounded border border-white/[0.05] bg-white/[0.02]">
                  <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white/55 hover:text-white/75 transition-colors flex items-center gap-2" title={file.filePath}>
                    <span className="truncate flex-1">{file.relativePath}</span>
                    {file.kind === 'image' && (
                      <span className="shrink-0 rounded bg-cyan-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cyan-200/60">Photo</span>
                    )}
                  </summary>
                  <div className="px-2.5 pb-2.5 pt-1 border-t border-white/[0.04]">
                    {/* The file level is the only one whose model read source
                        text, so it is the only place a claim can point at an
                        exact line. Hovering one shows those lines verbatim. */}
                    <p className="text-[11px] leading-relaxed text-white/50 whitespace-pre-wrap">
                      <ProvenanceText text={file.context} provenance={file.provenance} projectId={projectId} />
                    </p>
                    <p className="mt-1.5 text-[9px] text-white/25 font-mono truncate" title={file.filePath}>
                      {file.provenance
                        ? `source: ${file.filePath} · ${file.provenance.model || 'model unknown'} · ${file.provenance.promptVersion}${
                            file.provenance.truncated ? ' · file truncated to fit the input budget' : ''
                          }${
                            file.provenance.claims?.length
                              ? ` · ${file.provenance.claims.length} line citation${file.provenance.claims.length === 1 ? '' : 's'} — hover to read the source`
                              : ''
                          }`
                        : `source: ${file.filePath} · no recorded chain (refresh the index to record one)`}
                    </p>
                  </div>
                </details>
              ))}
            </div>
          </details>
        )}

        {footer}
      </div>
    </div>
  )
}
