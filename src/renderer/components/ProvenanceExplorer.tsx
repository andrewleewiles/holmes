import { type FC, useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFolder, faFileLines, faBookOpen, faImage, faDatabase, faBrain, faComments, faSitemap } from '@fortawesome/free-solid-svg-icons'
import type { ContextProvenance, ProvenanceChainNode, ProvenanceSourceKind } from '@shared/types'

interface ProvenanceExplorerProps {
  nodeRef: string
  projectId: string | null
  /** Text on the collapsed toggle. Defaults to "Sources". */
  label?: string
  /** Nesting level, used only to stop the recursion from running away. */
  depth?: number
}

// Deep trees are walked one layer per click, so this only guards against a
// cycle that somehow survived the resolver's visited set.
const MAX_UI_DEPTH = 12

const KIND_ICON: Record<ProvenanceSourceKind | 'user', typeof faFolder> = {
  file: faFileLines,
  folder: faFolder,
  'project-root': faDatabase,
  memory: faBrain,
  conversation: faComments,
  book: faBookOpen,
  user: faSitemap,
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

function summarize(provenance: ContextProvenance | null): string {
  if (!provenance) return 'no recorded chain'
  const parts = [`${formatCount(provenance.leafCount)} file${provenance.leafCount === 1 ? '' : 's'}`]
  const read = provenance.sources.filter((s) => s.included).length
  if (provenance.sources.length > 0) {
    parts.push(`${formatCount(read)} of ${formatCount(provenance.sources.length + provenance.unrecordedCount)} direct source${provenance.sources.length + provenance.unrecordedCount === 1 ? '' : 's'} read`)
  }
  return parts.join(' · ')
}

const Chevron: FC<{ open: boolean }> = ({ open }) => (
  <svg className={`w-2.5 h-2.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 12 12" fill="none">
    <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * Shows what a derived context was built from, one layer at a time. Each layer
 * is fetched on expand rather than up front: a data-source root can sit above
 * tens of thousands of photo nodes, and resolving all of them to render a list
 * of three folders would stall the page.
 */
export const ProvenanceExplorer: FC<ProvenanceExplorerProps> = ({ nodeRef, projectId, label = 'Sources', depth = 0 }) => {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [self, setSelf] = useState<ProvenanceChainNode | null>(null)
  const [children, setChildren] = useState<ProvenanceChainNode[]>([])
  const [capped, setCapped] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const chain = await window.electronAPI.documents.getProvenance(nodeRef, projectId, { maxDepth: 1, maxNodes: 200 })
      if (!chain.found) {
        setError('This context is no longer in the index.')
        return
      }
      setSelf(chain.nodes[0] ?? null)
      setChildren(chain.nodes.slice(1))
      setCapped(chain.truncated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the source chain')
    } finally {
      setLoading(false)
    }
  }, [nodeRef, projectId])

  // Point this at a different node and everything cached here is about the old
  // one — showing a stale chain under a new context is the exact failure this
  // component exists to prevent.
  useEffect(() => {
    setSelf(null)
    setChildren([])
    setCapped(false)
    setError(null)
  }, [nodeRef, projectId])

  useEffect(() => {
    if (open && !self && !loading && !error) void load()
  }, [open, self, loading, error, load])

  const provenance = self?.provenance ?? null
  const unrecorded = provenance?.unrecordedCount ?? 0

  return (
    <div className={depth > 0 ? 'border-l border-white/[0.07] pl-2.5 ml-1' : ''}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[10px] text-white/40 hover:text-cyan-200/80 transition-colors cursor-pointer w-full text-left"
      >
        <Chevron open={open} />
        <span className="uppercase tracking-wider">{label}</span>
        {self && <span className="text-white/25 normal-case tracking-normal">· {summarize(provenance)}</span>}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1">
          {loading && <p className="text-[10px] text-white/30">Reading the chain…</p>}
          {error && <p className="text-[10px] text-amber-200/60">{error}</p>}

          {provenance === null && !loading && !error && (
            <p className="text-[10px] text-amber-200/60">
              No source chain was recorded for this context — it predates provenance tracking. Refresh this index to record one; it costs no model calls.
            </p>
          )}

          {provenance && (
            <>
              <p className="text-[9px] text-white/25 font-mono">
                {provenance.model || 'model unknown'} · {provenance.promptVersion} ·{' '}
                {new Date(provenance.generatedAt).toLocaleDateString()}
                {provenance.inputChars > 0 ? ` · ${formatCount(provenance.inputChars)} chars in` : ''}
              </p>

              {provenance.omittedCount > 0 && (
                <p className="text-[10px] text-amber-200/60">
                  {formatCount(provenance.omittedCount)} source{provenance.omittedCount === 1 ? '' : 's'} below did not fit the input budget and were not read into this summary.
                </p>
              )}

              {children.length === 0 && self?.kind === 'file' && (
                <p className="text-[10px] text-white/30">This is a source file — the chain ends here.</p>
              )}

              {children.map((child) => {
                const expandable = child.kind !== 'file' && child.kind !== 'memory' && depth < MAX_UI_DEPTH
                const icon = child.kind === 'file' && child.ref.match(/\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i)
                  ? faImage
                  : KIND_ICON[child.kind]
                return (
                  <div key={`${child.ref}:${child.kind}`} className="text-[10px]">
                    <div className={`flex items-center gap-1.5 ${child.included ? 'text-white/50' : 'text-white/25'}`}>
                      <FontAwesomeIcon icon={icon} className="text-[9px] shrink-0 opacity-60" />
                      <span className="truncate" title={child.ref}>{child.label}</span>
                      {child.provenance && child.provenance.leafCount > 1 && (
                        <span className="text-white/20 shrink-0">{formatCount(child.provenance.leafCount)} files</span>
                      )}
                      {!child.included && (
                        <span
                          className="shrink-0 rounded bg-amber-400/10 px-1 text-[9px] text-amber-200/60"
                          title="This child exists in the tree but its summary did not fit the parent's input budget, so nothing above it was built from it."
                        >
                          not read
                        </span>
                      )}
                    </div>
                    {expandable && (
                      <div className="mt-1 mb-1.5">
                        <ProvenanceExplorer
                          nodeRef={child.ref}
                          projectId={child.projectId}
                          label="Built from"
                          depth={depth + 1}
                        />
                      </div>
                    )}
                  </div>
                )
              })}

              {unrecorded > 0 && (
                <p className="text-[10px] text-white/30">
                  + {formatCount(unrecorded)} more direct source{unrecorded === 1 ? '' : 's'} not individually recorded (per-node cap).
                </p>
              )}
              {capped && (
                <p className="text-[10px] text-white/30">Listing was cut short — this node has more sources than one view shows.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
