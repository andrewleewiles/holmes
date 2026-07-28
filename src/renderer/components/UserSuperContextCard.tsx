import { type FC, useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faUserGear, faRefresh, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons'
import type { UserSuperContext } from '@shared/types'
import { ProvenanceExplorer } from './ProvenanceExplorer'
import { ProvenanceText, claimCoverage } from './ProvenanceText'
import { ContextVersionHistory } from './ContextVersionHistory'

interface UserSuperContextCardProps {
  enabled: boolean
  /** Bump to reload after an index run. Optional: the Dashboard just mounts it. */
  refreshKey?: number
}

export const UserSuperContextCard: FC<UserSuperContextCardProps> = ({ enabled, refreshKey }) => {
  const [ctx, setCtx] = useState<UserSuperContext | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setCtx(await window.electronAPI.documents.getUserContext())
    } catch {
      setCtx(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const rebuild = async () => {
    if (!enabled || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.documents.refreshUserContext()
      setCtx(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rebuild failed')
    } finally {
      setBusy(false)
    }
  }

  const coverage = ctx ? claimCoverage(ctx.context, ctx.provenance) : null
  const hasContent = Boolean(ctx?.context?.trim())
  const hasMore = hasContent && (ctx!.context.trim().length > (ctx!.contextShort?.trim().length ?? 0) + 4)

  return (
    <div className="rounded-xl border border-cyan-400/25 bg-gradient-to-b from-cyan-400/[0.07] to-cyan-400/[0.02] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-cyan-400/10">
        <FontAwesomeIcon icon={faUserGear} className="text-cyan-300/80 text-xs shrink-0" />
        <span className="text-sm text-white/80 flex-1 font-serif-display">User super-context</span>
        {hasContent && (
          <span className="text-[10px] text-white/30 shrink-0">
            {ctx!.projectCount} source{ctx!.projectCount === 1 ? '' : 's'}
            {ctx!.updatedAt ? ` · ${new Date(ctx!.updatedAt).toLocaleDateString()}` : ''}
          </span>
        )}
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          title="Every archived version of the user super-context, newest first"
          className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] cursor-pointer transition-colors ${
            historyOpen
              ? 'border-cyan-400/40 bg-cyan-400/[0.06] text-cyan-100/80'
              : 'border-white/10 bg-white/[0.04] text-white/55 hover:border-cyan-400/30 hover:text-cyan-200/80'
          }`}
        >
          <FontAwesomeIcon icon={faClockRotateLeft} className="text-[10px]" />
          History
        </button>
        <button
          onClick={() => void rebuild()}
          disabled={!enabled || busy}
          title={!enabled ? 'Enable Document context in Settings' : 'Rebuild the unified user super-context from all project indexes'}
          className="shrink-0 flex items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06] px-2.5 py-1 text-[10px] text-cyan-100/80 hover:border-cyan-400/40 disabled:opacity-40 cursor-pointer transition-colors"
        >
          <FontAwesomeIcon icon={faRefresh} className={`text-[10px] ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'Combining…' : hasContent ? 'Rebuild' : 'Build'}
        </button>
      </div>
      <div className="px-4 py-3">
        {error && <p className="text-[11px] text-red-300/80 mb-2">{error}</p>}
        {historyOpen && (
          <div className="mb-3">
            <ContextVersionHistory projectId={null} sourceRef="user:super-context" reloadKey={refreshKey} />
          </div>
        )}
        {hasContent ? (
          <>
            <p className="text-[11px] leading-relaxed text-white/60 whitespace-pre-wrap">
              {expanded
                ? <ProvenanceText text={ctx!.context} provenance={ctx!.provenance} />
                : ctx!.contextShort || ctx!.context}
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
              {expanded && coverage !== null && (
                <span className="text-[9px] text-white/25" title="Hover a highlighted passage to see which data source it came from.">
                  {coverage > 0
                    ? `${Math.round(coverage * 100)}% attributed — hover to trace`
                    : 'no passages attributed'}
                </span>
              )}
            </div>
            <div className="mt-2 pt-2 border-t border-cyan-400/10">
              <ProvenanceExplorer nodeRef="user:super-context" projectId={null} label="Built from" />
            </div>
          </>
        ) : (
          <p className="text-[11px] text-white/35">
            A unified model of you, synthesized from every project's document index. Build at least one project index below to generate it.
          </p>
        )}
      </div>
    </div>
  )
}
