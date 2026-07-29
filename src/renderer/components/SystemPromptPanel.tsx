import { type FC, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { TOKEN_ESTIMATE_DISCLAIMER, estimateBlockTokens, formatTokenEstimate } from '@shared/tokenEstimate'
import type { SystemPromptEntry } from '../store/chatStore'
import { ProvenanceExplorer } from './ProvenanceExplorer'
import { ProvenanceText, useNodeProvenance } from './ProvenanceText'

interface SystemPromptPanelProps {
  entries: SystemPromptEntry[]
  /** Distinguishes "nothing is configured" from "the preview hasn't landed yet". */
  loading?: boolean
  className?: string
}

/**
 * How tall the block text is allowed to get, and how much of the window is left
 * below it. The panel can open anywhere on the screen, so the text pane is
 * measured against the window rather than trusted to fit: whatever room is left
 * under it, minus the gutter, is its ceiling.
 */
const MAX_TEXT_PANE_PX = 256
const MIN_TEXT_PANE_PX = 80
const WINDOW_BOTTOM_GUTTER_PX = 16

/**
 * The collapsed "System prompt" disclosure and its block browser. Rendered above
 * the composer in a conversation and below it on the new-conversation screen,
 * where the blocks are a preview of what the first turn will be sent.
 */
export const SystemPromptPanel: FC<SystemPromptPanelProps> = ({ entries, loading = false, className }) => {
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [selectedBlockIdx, setSelectedBlockIdx] = useState(0)
  const [textPaneMaxHeight, setTextPaneMaxHeight] = useState(MAX_TEXT_PANE_PX)
  const panelRef = useRef<HTMLDivElement>(null)
  const textPaneRef = useRef<HTMLDivElement>(null)

  // Claim spans are recorded against the stored context; the block wraps it in
  // framing prose, so `textOffset` shifts them onto the text actually shown.
  const selectedRef = entries[selectedBlockIdx]?.provenanceRef ?? null
  const selectedTextOffset = selectedRef?.textOffset
  const selectedProvenance = useNodeProvenance(selectedRef?.ref ?? null, selectedRef?.projectId ?? null)

  const totalChars = entries.reduce((sum, m) => sum + m.content.length, 0)
  const blockTokens = useMemo(() => estimateBlockTokens(entries), [entries])
  const totalTokens = useMemo(() => blockTokens.reduce((sum, tokens) => sum + tokens, 0), [blockTokens])

  // Keep selected block in range when the prompt changes
  useEffect(() => {
    if (selectedBlockIdx >= entries.length) {
      setSelectedBlockIdx(Math.max(0, entries.length - 1))
    }
  }, [entries.length, selectedBlockIdx])

  // The pane's own top already accounts for the tabs and the evidence chain
  // above it, so the room below it is the only measurement needed. Re-measured
  // whenever the panel resizes, which covers the composer growing under it and
  // the evidence chain opening inside it.
  useLayoutEffect(() => {
    if (!showSystemPrompt) return
    const pane = textPaneRef.current
    const panel = panelRef.current
    if (!pane || !panel) return

    const measure = () => {
      const room = window.innerHeight - pane.getBoundingClientRect().top - WINDOW_BOTTOM_GUTTER_PX
      const next = Math.max(MIN_TEXT_PANE_PX, Math.min(MAX_TEXT_PANE_PX, Math.floor(room)))
      setTextPaneMaxHeight((current) => (current === next ? current : next))
    }

    measure()
    window.addEventListener('resize', measure)
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    return () => {
      window.removeEventListener('resize', measure)
      observer.disconnect()
    }
  }, [showSystemPrompt, entries, selectedBlockIdx])

  return (
    <div className={className}>
      <button
        onClick={() => setShowSystemPrompt((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors cursor-pointer"
      >
        <svg
          className={`w-3 h-3 transition-transform ${showSystemPrompt ? 'rotate-90' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="uppercase tracking-wide">
          System prompt
        </span>
        {entries.length > 0 && (
          <span
            className="text-white/30 font-mono normal-case tracking-normal"
            title={`~${totalTokens.toLocaleString()} tokens · ${totalChars.toLocaleString()} chars — ${TOKEN_ESTIMATE_DISCLAIMER}`}
          >
            · {entries.length} block{entries.length === 1 ? '' : 's'} · ~{formatTokenEstimate(totalTokens)} tokens
          </span>
        )}
      </button>
      {showSystemPrompt && (
        <div ref={panelRef} className="mt-1.5 rounded-xl border border-white/10 bg-white/5 overflow-hidden">
          {entries.length === 0 ? (
            <div className="px-4 py-3 text-xs text-white/40">
              {loading
                ? 'Building the system prompt preview…'
                : 'No system context configured for this conversation. Set a custom system prompt, select a memory context, or open a project to populate this preview.'}
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex items-center gap-1 px-2 pt-2 pb-1 border-b border-white/10 overflow-x-auto scrollbar-thin">
                {entries.map((entry, idx) => {
                  const label = entry.label || `Block ${idx + 1}`
                  const active = idx === selectedBlockIdx
                  const tokens = blockTokens[idx] ?? 0
                  return (
                    <button
                      key={idx}
                      onClick={() => setSelectedBlockIdx(idx)}
                      title={`~${tokens.toLocaleString()} tokens · ${entry.content.length.toLocaleString()} chars — ${TOKEN_ESTIMATE_DISCLAIMER}`}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        active
                          ? 'bg-holmes-primary/20 text-holmes-primary-light'
                          : 'text-white/55 hover:text-white/80 hover:bg-white/5'
                      }`}
                    >
                      <span>{label}</span>
                      <span className="text-[10px] text-white/30 font-mono">~{formatTokenEstimate(tokens)}</span>
                    </button>
                  )
                })}
              </div>
              {/* A context block is a summary of summaries. Showing the
                  evidence chain beside the text is what keeps the user able
                  to check what the model is actually being told from. */}
              {entries[selectedBlockIdx]?.provenanceRef && (
                <div className="px-4 pt-2 pb-1 border-b border-white/[0.06]">
                  <ProvenanceExplorer
                    key={entries[selectedBlockIdx].provenanceRef!.ref}
                    nodeRef={entries[selectedBlockIdx].provenanceRef!.ref}
                    projectId={entries[selectedBlockIdx].provenanceRef!.projectId}
                    label="Evidence chain"
                  />
                </div>
              )}
              <div
                ref={textPaneRef}
                style={{ maxHeight: textPaneMaxHeight }}
                className="overflow-y-auto scrollbar-thin px-4 py-2"
              >
                {entries[selectedBlockIdx] && (
                  <pre className="whitespace-pre-wrap break-words text-xs text-white/75 font-mono leading-relaxed">
                    {selectedTextOffset === undefined ? (
                      entries[selectedBlockIdx].content
                    ) : (
                      <ProvenanceText
                        text={entries[selectedBlockIdx].content}
                        provenance={selectedProvenance}
                        shift={selectedTextOffset}
                      />
                    )}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
