import { type FC, useEffect, useMemo, useState } from 'react'
import type { ContextProvenance, ProvenanceClaim, SourceExcerpt } from '@shared/types'
import { buildSpanSegments } from '@shared/textSpans'

/**
 * Shows the exact source lines behind a claim, read from the file at hover time.
 * Nothing here is model-generated: the model supplied only the line numbers, and
 * those were validated against the file it was actually shown.
 */
const ExcerptView: FC<{ filePath: string; lines: { start: number; end: number }; projectId: string | null }> = ({
  filePath,
  lines,
  projectId,
}) => {
  const [excerpt, setExcerpt] = useState<SourceExcerpt | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setExcerpt(null)
    setFailed(false)
    void window.electronAPI.documents
      .getSourceExcerpt(filePath, lines.start, lines.end, projectId)
      .then((result) => { if (!cancelled) setExcerpt(result) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [filePath, lines.start, lines.end, projectId])

  if (failed) return <span className="block text-[9px] text-amber-200/60">This file is outside the current file-access scope.</span>
  if (!excerpt) return <span className="block text-[9px] text-white/30">Reading the source…</span>
  if (excerpt.unavailable) return <span className="block text-[9px] text-amber-200/60">{excerpt.unavailable}</span>

  if (excerpt.imageDataUrl) {
    return (
      <img
        src={excerpt.imageDataUrl}
        alt={`Source image ${filePath}`}
        className="mt-1 max-h-40 w-auto rounded border border-white/10"
      />
    )
  }

  return (
    <span className="mt-1 block max-h-40 overflow-y-auto scrollbar-thin rounded border border-white/10 bg-black/40">
      {(excerpt.lines ?? []).map((line) => (
        <span
          key={line.number}
          className={`flex gap-2 px-1.5 py-[1px] font-mono text-[9px] leading-snug ${
            line.cited ? 'bg-cyan-400/10 text-cyan-100/90' : 'text-white/35'
          }`}
        >
          <span className="shrink-0 select-none text-white/20 tabular-nums">{line.number}</span>
          <span className="whitespace-pre-wrap break-all">{line.text || ' '}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * Reads one node's own provenance without walking its children — used where the
 * text is on screen but the source tree is not (the system-prompt popup).
 */
export function useNodeProvenance(ref: string | null, projectId: string | null): ContextProvenance | null {
  const [provenance, setProvenance] = useState<ContextProvenance | null>(null)
  useEffect(() => {
    let cancelled = false
    setProvenance(null)
    if (!ref) return
    void window.electronAPI.documents
      .getProvenance(ref, projectId, { maxDepth: 0 })
      .then((chain) => {
        if (!cancelled) setProvenance(chain.nodes[0]?.provenance ?? null)
      })
      .catch(() => { /* No chain is a rendering fallback, not an error to surface here. */ })
    return () => { cancelled = true }
  }, [ref, projectId])
  return provenance
}

interface ProvenanceTextProps {
  text: string
  provenance: ContextProvenance | null
  className?: string
  /** Scopes the source-excerpt lookup, so an excerpt only ever comes from a file this project indexed. */
  projectId?: string | null
  /**
   * Added to every recorded claim offset. Claims index the stored context; the
   * system-prompt popup renders that context with framing prose in front of it,
   * so it passes the length of that prefix to keep the spans anchored.
   */
  shift?: number
}

interface Segment {
  text: string
  claim: ProvenanceClaim | null
  key: string
}

/**
 * Splits text into cited and uncited runs. Claims are non-overlapping and
 * ordered by construction, so the shared sweep — which also handles the reader's
 * overlapping annotations — collapses to at most one claim per segment here.
 */
function buildSegments(text: string, claims: ProvenanceClaim[], shift: number): Segment[] {
  const byId = new Map(claims.map((claim, index) => [String(index), claim]))
  return buildSpanSegments(
    text,
    claims.map((claim, index) => ({ id: String(index), start: claim.start, end: claim.end })),
    shift
  ).map((segment) => ({
    text: segment.text,
    claim: segment.spanIds.length > 0 ? byId.get(segment.spanIds[0]) ?? null : null,
    key: segment.key,
  }))
}

/**
 * Renders a synthesis with its cited spans hoverable. Source labels come from
 * the node's own recorded edges — no lookup, no fetch, and no way to display a
 * source the synthesis was not actually built from.
 */
export const ProvenanceText: FC<ProvenanceTextProps> = ({ text, provenance, className, projectId = null, shift = 0 }) => {
  const [hovered, setHovered] = useState<number | null>(null)

  const labelFor = useMemo(() => {
    const map = new Map<string, string>()
    for (const source of provenance?.sources ?? []) map.set(source.ref, source.label)
    return map
  }, [provenance])

  const claims = provenance?.claims ?? []
  const segments = useMemo(
    () => (claims.length === 0 ? [{ text, claim: null, key: 'all' }] : buildSegments(text, claims, shift)),
    [text, claims, shift]
  )

  if (claims.length === 0) return <span className={className}>{text}</span>

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.claim === null ? (
          <span key={segment.key}>{segment.text}</span>
        ) : (
          <span
            key={segment.key}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered((v) => (v === index ? null : v))}
            className="relative cursor-help rounded-[2px] bg-cyan-400/[0.07] underline decoration-dotted decoration-cyan-300/30 underline-offset-2 hover:bg-cyan-400/15 hover:decoration-cyan-300/70 transition-colors"
          >
            {segment.text}
            {hovered === index && (
              <span className="absolute left-0 bottom-full z-20 mb-1 w-max max-w-[30rem] rounded-lg border border-cyan-400/25 bg-holmes-bg/95 px-2.5 py-1.5 shadow-lg backdrop-blur-sm">
                <span className="block text-[9px] uppercase tracking-wider text-cyan-200/50 mb-1">
                  {segment.claim.sourceLines
                    ? segment.claim.sourceLines.start === segment.claim.sourceLines.end
                      ? `Source · line ${segment.claim.sourceLines.start}`
                      : `Source · lines ${segment.claim.sourceLines.start}–${segment.claim.sourceLines.end}`
                    : segment.claim.sourceRefs.length === 1
                      ? 'Source'
                      : `${segment.claim.sourceRefs.length} sources`}
                </span>
                {segment.claim.sourceRefs.map((ref) => (
                  <span key={ref} className="block text-[10px] text-white/70 font-mono break-all leading-snug">
                    {labelFor.get(ref) ?? ref}
                    {labelFor.has(ref) && ref !== labelFor.get(ref) && (
                      <span className="block text-[9px] text-white/30 break-all">{ref}</span>
                    )}
                  </span>
                ))}
                {segment.claim.sourceLines && segment.claim.sourceRefs[0] && (
                  <ExcerptView
                    filePath={segment.claim.sourceRefs[0]}
                    lines={segment.claim.sourceLines}
                    projectId={projectId}
                  />
                )}
              </span>
            )}
          </span>
        )
      )}
    </span>
  )
}

/** How much of a synthesis carries a citation — shown so partial coverage is never mistaken for full. */
export function claimCoverage(text: string, provenance: ContextProvenance | null): number | null {
  if (!provenance?.claims) return null
  if (text.length === 0) return 0
  const cited = provenance.claims.reduce((sum, claim) => sum + Math.max(0, claim.end - claim.start), 0)
  return Math.min(1, cited / text.length)
}
