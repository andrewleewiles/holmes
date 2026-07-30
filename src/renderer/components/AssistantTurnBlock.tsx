import { type FC } from 'react'
import { formatAttachmentSize } from '@shared/attachments'
import type { AssistantTurn } from './turnGrouping'
import { MarkdownRenderer } from './MarkdownRenderer'
import { AnimatedMark, type MarkState } from './AnimatedMark'
import { ThinkingDisclosure } from './ThinkingDisclosure'
import { ToolStepRow } from './ToolStepRow'
import { MessageToolbar } from './MessageToolbar'

interface AssistantTurnBlockProps {
  turn: AssistantTurn
  isStreaming?: boolean
  turnInFlight?: boolean
  /**
   * Whether this turn draws the mark. Exactly one turn on screen may — see the
   * note in ChatView about why the transcript shows a single symbol.
   */
  showMark?: boolean
  onRetry?: (messageId: string) => void
  onSetActiveBranch?: (messageId: string) => void
}

/** Matches the mark's box, so hiding the mark never shifts the prose sideways. */
const MARK_SIZE = 'h-10 w-10'

/**
 * One assistant turn: its thinking, the tools it used, and what it said — in the
 * order it happened, under a single mark.
 *
 * This is a turn rather than a message because the transcript stores a tool-using
 * answer as several rows, and rendering them separately broke one reply into
 * several bubbles that each repeated the furniture.
 */
export const AssistantTurnBlock: FC<AssistantTurnBlockProps> = ({
  turn, isStreaming, turnInFlight, showMark, onRetry, onSetActiveBranch,
}) => {
  const hasProse = turn.segments.some((segment) => segment.content.length > 0)
  const runningTool = turn.segments.some((segment) => segment.steps.some((step) => step.status === 'running'))

  // Thinking until the first token lands, talking once prose is arriving, still
  // once the turn is over.
  const markState: MarkState = !isStreaming ? 'idle' : hasProse ? 'talking' : 'thinking'

  // Nothing at all yet: no thinking, no tool, no prose. The mark alone would read
  // as a stall, so the turn says what it is doing.
  const waiting = isStreaming && !hasProse && !turn.reasoning && !runningTool
    && turn.segments.every((segment) => segment.steps.length === 0)

  return (
    <div className="group mb-4 flex w-full items-start gap-2.5">
      {/* mt keeps the mark's centre on the first text line: the bubble's py-3 plus
          half a 24px line puts that at 24px, so mt = 24 - size/2. */}
      {showMark
        ? <AnimatedMark state={markState} className={`${MARK_SIZE} mt-1 shrink-0`} />
        : <div className={`${MARK_SIZE} mt-1 shrink-0`} aria-hidden="true" />}

      <div className="flex min-w-0 flex-1 flex-col items-start">
        <div className="max-w-[80%] rounded-2xl rounded-bl-md px-4 py-3 text-white">
          {turn.model && (
            <div className="mb-1 font-mono text-xs text-white/40 opacity-0 transition-opacity group-hover:opacity-100">
              {turn.model}
            </div>
          )}

          {turn.reasoning && (
            <ThinkingDisclosure
              reasoning={turn.reasoning}
              isStreaming={isStreaming}
              hasContent={hasProse}
            />
          )}

          {turn.segments.map((segment) => (
            <div key={segment.id}>
              {segment.content && (
                <div className="font-serif-display">
                  <MarkdownRenderer
                    content={segment.content}
                    className="prose-lg holmes-response"
                    sources={segment.sources}
                    isStreaming={isStreaming}
                  />
                </div>
              )}
              {segment.steps.length > 0 && (
                <div className={`space-y-1 ${segment.content ? 'mt-2' : ''} mb-2`}>
                  {segment.steps.map((step) => <ToolStepRow key={step.id} step={step} />)}
                </div>
              )}
            </div>
          ))}

          {turn.attachments && turn.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {turn.attachments.map((attachment) => (
                <figure key={attachment.id} className="max-w-[260px] overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
                  {attachment.kind === 'image' ? (
                    <img src={attachment.dataUrl} alt={attachment.name} className="block max-h-64 w-full bg-black/20 object-contain" />
                  ) : (
                    <video src={attachment.dataUrl} controls className="block max-h-64 w-full bg-black/40" />
                  )}
                  <figcaption className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-white/40">
                    <span className="flex-1 truncate">{attachment.name}</span>
                    {attachment.origin === 'generated' && (
                      <span className="shrink-0 rounded bg-holmes-primary/20 px-1.5 py-0.5 text-[10px] text-holmes-primary-light">Generated</span>
                    )}
                    <span className="shrink-0 font-mono text-white/25">{formatAttachmentSize(attachment.bytes)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {waiting && (
            <div className="text-base font-serif-display text-white/60">
              {/* No mark here: the gutter is already running the thinking clip a
                  few px away, so a second one just reads as a duplicate. */}
              <span className="holmes-shimmer">Thinking</span>
            </div>
          )}

          {/* Stays a caret rather than a mark: it sits after the markdown block, so
              a logo here lands on its own line instead of trailing the text. */}
          {isStreaming && hasProse && (
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-white/60" />
          )}
        </div>

        {!isStreaming && (
          <MessageToolbar
            copyText={turn.copyText}
            createdAt={turn.createdAt}
            align="left"
            target={turn.branchMessage}
            turnInFlight={turnInFlight}
            onRetry={onRetry}
            onSetActiveBranch={onSetActiveBranch}
          />
        )}
      </div>
    </div>
  )
}
