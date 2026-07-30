import { type FC, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPen, faCopy, faRotateRight, faCheck } from '@fortawesome/free-solid-svg-icons'
import type { Message } from '@shared/types'

interface MessageToolbarProps {
  /** What the copy button puts on the clipboard — a whole turn, not one row. */
  copyText: string
  createdAt: number
  align: 'left' | 'right'
  /**
   * The message branch navigation and retry act on. For an assistant turn that is
   * its first row, since retrying regenerates the answer from the question.
   */
  target: Message
  /**
   * True while any turn is streaming. The user row for the message being answered
   * still carries its optimistic client-side id at that point — the main process
   * wrote the row under a different one — so Edit/Retry/branch would fire at an id
   * the database has never heard of.
   */
  turnInFlight?: boolean
  isStreaming?: boolean
  onEdit?: () => void
  onRetry?: (messageId: string) => void
  onSetActiveBranch?: (messageId: string) => void
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Shared by the user row and the assistant turn so the two cannot drift apart. */
export const MessageToolbar: FC<MessageToolbarProps> = ({
  copyText, createdAt, align, target, turnInFlight, isStreaming, onEdit, onRetry, onSetActiveBranch,
}) => {
  const [copied, setCopied] = useState(false)

  const siblingCount = target.siblingCount ?? 0
  const siblingIndex = target.siblingIndex ?? 0
  const siblingIds = target.siblingIds ?? []
  const hasSiblings = siblingCount > 1

  const handleCopy = async () => {
    await navigator.clipboard.writeText(copyText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const goToSibling = (direction: -1 | 1) => {
    if (!onSetActiveBranch || !hasSiblings) return
    const next = siblingIndex + direction
    if (next >= 0 && next < siblingIds.length) onSetActiveBranch(siblingIds[next])
  }

  return (
    <div className={`mt-1 flex items-center gap-1.5 text-xs text-white/30 opacity-0 transition-opacity group-hover:opacity-100 ${
      align === 'right' ? 'justify-end' : 'justify-start'
    }`}>
      <span className="mr-1">{formatDate(createdAt)}</span>

      {hasSiblings && !turnInFlight && (
        <div className="mr-1 flex items-center gap-0.5">
          <button
            onClick={() => goToSibling(-1)}
            disabled={siblingIndex === 0}
            className="cursor-pointer px-1 transition-colors hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="tabular-nums text-white/40">{siblingIndex + 1}/{siblingCount}</span>
          <button
            onClick={() => goToSibling(1)}
            disabled={siblingIndex === siblingCount - 1}
            className="cursor-pointer px-1 transition-colors hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}

      {copyText && (
        <button
          onClick={handleCopy}
          className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-white/5 hover:text-white/70"
          title="Copy"
        >
          <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="h-3 w-3" />
        </button>
      )}

      {onEdit && !isStreaming && !turnInFlight && (
        <button
          onClick={onEdit}
          className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-white/5 hover:text-white/70"
          title="Edit"
        >
          <FontAwesomeIcon icon={faPen} className="h-3 w-3" />
        </button>
      )}

      {onRetry && !isStreaming && !turnInFlight && (
        <button
          onClick={() => onRetry(target.id)}
          className="cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-white/5 hover:text-white/70"
          title={target.role === 'user' ? 'Retry' : 'Regenerate response'}
        >
          <FontAwesomeIcon icon={faRotateRight} className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
