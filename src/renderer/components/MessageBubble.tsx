import { type FC, useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPen, faCopy, faRotateRight, faCheck, faXmark, faWrench, faSearch, faFolderOpen, faFileLines, faCircleInfo } from '@fortawesome/free-solid-svg-icons'
import type { Message } from '@shared/types'
import { formatAttachmentSize } from '@shared/attachments'
import type { StreamingToolInteraction } from '../store/chatStore'
import { MarkdownRenderer } from './MarkdownRenderer'
import { AnimatedMark, type MarkState } from './AnimatedMark'

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  // True while any turn is streaming. The user bubble for the message being
  // answered still carries its optimistic client-side id at that point — the
  // main process wrote the row under a different one — so Edit/Retry/branch
  // would fire at an id the database has never heard of.
  turnInFlight?: boolean
  toolInteractions?: StreamingToolInteraction[]
  onEdit?: (messageId: string, newContent: string) => void
  onRetry?: (messageId: string) => void
  onSetActiveBranch?: (messageId: string) => void
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export const MessageBubble: FC<MessageBubbleProps> = ({ message, isStreaming, turnInFlight, toolInteractions, onEdit, onRetry, onSetActiveBranch }) => {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isTool = message.role === 'tool'
  const hasContent = message.content.length > 0
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [copied, setCopied] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)

  // Thinking until the first token lands, talking once prose is actually
  // arriving, still once the turn is over.
  const markState: MarkState = !isStreaming ? 'idle' : hasContent ? 'talking' : 'thinking'

  useEffect(() => {
    if (isEditing) {
      editRef.current?.focus()
      editRef.current?.select()
      // Auto-resize
      const el = editRef.current
      if (el) {
        el.style.height = 'auto'
        el.style.height = el.scrollHeight + 'px'
      }
    }
  }, [isEditing])

  const startEdit = () => {
    setEditContent(message.content)
    setIsEditing(true)
  }

  const commitEdit = () => {
    const trimmed = editContent.trim()
    if (trimmed && trimmed !== message.content && onEdit) {
      onEdit(message.id, trimmed)
    }
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setEditContent(message.content)
    setIsEditing(false)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const hasSiblings = (message.siblingCount ?? 0) > 1
  const siblingIndex = message.siblingIndex ?? 0
  const siblingIds = message.siblingIds ?? []

  const goToSibling = (direction: -1 | 1) => {
    if (!onSetActiveBranch || !hasSiblings) return
    const newIndex = siblingIndex + direction
    if (newIndex >= 0 && newIndex < siblingIds.length) {
      onSetActiveBranch(siblingIds[newIndex])
    }
  }

  const Toolbar = () => (
    <div className={`flex items-center gap-1.5 text-xs text-white/30 mt-1 opacity-0 group-hover:opacity-100 transition-opacity ${isUser ? 'justify-end' : 'justify-start pl-4'}`}>
      {/* Timestamp */}
      <span className="mr-1">{formatDate(message.createdAt)}</span>

      {/* Branch navigation */}
      {hasSiblings && !turnInFlight && (
        <div className="flex items-center gap-0.5 mr-1">
          <button
            onClick={() => goToSibling(-1)}
            disabled={siblingIndex === 0}
            className="px-1 hover:text-white/70 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-white/40 tabular-nums">{siblingIndex + 1}/{message.siblingCount}</span>
          <button
            onClick={() => goToSibling(1)}
            disabled={siblingIndex === (message.siblingCount ?? 1) - 1}
            className="px-1 hover:text-white/70 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}

      {/* Copy */}
      <button
        onClick={handleCopy}
        className="px-1.5 py-0.5 rounded hover:text-white/70 hover:bg-white/5 transition-colors cursor-pointer"
        title="Copy"
      >
        <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="w-3 h-3" />
      </button>

      {/* Edit (user messages only) */}
      {isUser && !isStreaming && !turnInFlight && onEdit && (
        <button
          onClick={startEdit}
          className="px-1.5 py-0.5 rounded hover:text-white/70 hover:bg-white/5 transition-colors cursor-pointer"
          title="Edit"
        >
          <FontAwesomeIcon icon={faPen} className="w-3 h-3" />
        </button>
      )}

      {/* Retry */}
      {(isUser || isAssistant) && !isStreaming && !turnInFlight && onRetry && (
        <button
          onClick={() => onRetry(message.id)}
          className="px-1.5 py-0.5 rounded hover:text-white/70 hover:bg-white/5 transition-colors cursor-pointer"
          title={isUser ? 'Retry' : 'Regenerate response'}
        >
          <FontAwesomeIcon icon={faRotateRight} className="w-3 h-3" />
        </button>
      )}
    </div>
  )

  const toolIcon = (name: string) => {
    if (name === 'search_files') return faSearch
    if (name === 'read_file') return faFileLines
    if (name === 'list_directory') return faFolderOpen
    if (name === 'get_file_info') return faCircleInfo
    return faWrench
  }

  const formatToolArgs = (name: string, args: string): string => {
    try {
      const parsed = JSON.parse(args)
      if (name === 'search_files') return parsed.query || ''
      if (name === 'read_file' || name === 'list_directory' || name === 'get_file_info') return parsed.path || ''
      return args
    } catch {
      return args
    }
  }

  const ToolInteractions = () => {
    if (!toolInteractions || toolInteractions.length === 0) return null
    return (
      <div className="mb-2 space-y-1">
        {toolInteractions.map((interaction, idx) => {
          if (interaction.type === 'call' && interaction.toolCall) {
            const tc = interaction.toolCall
            return (
              <div key={idx} className="flex items-center gap-2 rounded-lg border border-holmes-primary/15 bg-holmes-primary/[0.04] px-3 py-1.5 text-[11px] text-white/50">
                <FontAwesomeIcon icon={toolIcon(tc.name)} className="text-holmes-primary/70" />
                <span className="font-mono text-holmes-primary-light/60">{tc.name}</span>
                <span className="truncate text-white/35">{formatToolArgs(tc.name, tc.arguments)}</span>
                <FontAwesomeIcon icon={faCircleInfo} className="ml-auto text-white/20 animate-pulse" />
              </div>
            )
          }
          if (interaction.type === 'result' && interaction.toolResult) {
            const tr = interaction.toolResult
            return (
              <div key={idx} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] ${tr.error ? 'border-red-400/15 bg-red-400/[0.04] text-red-200/40' : 'border-white/[0.07] bg-white/[0.02] text-white/35'}`}>
                <FontAwesomeIcon icon={toolIcon(tr.name)} className={tr.error ? 'text-red-300/50' : 'text-white/30'} />
                <span className="font-mono">{tr.name}</span>
                <span className="text-white/20">{tr.error ? 'failed' : 'result'}</span>
              </div>
            )
          }
          return null
        })}
      </div>
    )
  }

  const Attachments = () => {
    const attachments = message.attachments
    if (!attachments || attachments.length === 0) return null
    return (
      <div className={`flex flex-wrap gap-2 ${hasContent ? 'mb-2' : ''} ${isUser ? 'justify-end' : 'justify-start'}`}>
        {attachments.map((attachment) => (
          <figure key={attachment.id} className="max-w-[260px] overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
            {attachment.kind === 'image' ? (
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className="block max-h-64 w-full object-contain bg-black/20"
              />
            ) : (
              <video
                src={attachment.dataUrl}
                controls
                className="block max-h-64 w-full bg-black/40"
              />
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
    )
  }

  if (isTool) {
    return (
      <div className="group flex flex-col items-start mb-2">
        <div className="max-w-[80%] rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-[11px] text-white/35">
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={toolIcon(message.toolName || '')} className="text-white/30" />
            <span className="font-mono text-white/40">{message.toolName}</span>
            <span className="text-white/20">result</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`group flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4`}>
      {/* Assistant messages get a mark in a left gutter; `contents` keeps user
          messages laid out exactly as they were, with no wrapper of their own. */}
      <div className={isUser ? 'contents' : 'flex w-full items-start gap-2.5'}>
        {/* mt keeps the mark's centre on the first text line: the bubble's py-3
            plus half a 24px line puts that at 24px, so mt = 24 - size/2. */}
        {!isUser && <AnimatedMark state={markState} className="w-10 h-10 shrink-0 mt-1" />}
        <div className={isUser ? 'contents' : 'flex min-w-0 flex-1 flex-col items-start'}>
          <div
            className={`max-w-[80%] rounded-2xl px-4 py-3 ${
              isUser
                ? 'bg-[#151514] text-white rounded-br-md'
                : 'text-white rounded-bl-md'
            }`}
          >
            {message.model && !isUser && (
              <div className="text-xs text-white/40 mb-1 font-mono opacity-0 group-hover:opacity-100 transition-opacity">{message.model}</div>
            )}

            {!isUser && message.reasoning && (
              <div className="mb-2">
                <button
                  onClick={() => setReasoningOpen((v) => !v)}
                  className="flex items-center gap-1 text-xs text-white/50 hover:text-white/80 transition-colors cursor-pointer"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${reasoningOpen ? 'rotate-90' : ''}`}
                    viewBox="0 0 12 12"
                    fill="none"
                  >
                    <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="uppercase tracking-wide">
                    {isStreaming && !hasContent ? 'Thinking…' : 'Thinking'}
                  </span>
                </button>
                {(reasoningOpen || (isStreaming && !hasContent)) && (
                  <div className="mt-1.5 pl-4 border-l border-white/10 text-xs text-white/45 whitespace-pre-wrap font-mono leading-relaxed max-h-72 overflow-y-auto scrollbar-thin">
                    {message.reasoning}
                    {isStreaming && !hasContent && (
                      <span className="inline-block w-1.5 h-3 bg-white/60 ml-0.5 animate-pulse align-middle" />
                    )}
                  </div>
                )}
              </div>
            )}

            {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
              <div className="mb-2 space-y-1">
                {message.toolCalls.map((tc, idx) => (
                  <div key={idx} className="flex items-center gap-2 rounded-lg border border-holmes-primary/15 bg-holmes-primary/[0.04] px-3 py-1.5 text-[11px] text-white/50">
                    <FontAwesomeIcon icon={toolIcon(tc.name)} className="text-holmes-primary/70" />
                    <span className="font-mono text-holmes-primary-light/60">{tc.name}</span>
                    <span className="truncate text-white/35">{formatToolArgs(tc.name, tc.arguments)}</span>
                  </div>
                ))}
              </div>
            )}

            {isStreaming && <ToolInteractions />}

            <Attachments />

            {isStreaming && !hasContent && !message.reasoning && !toolInteractions?.length ? (
              <div className="flex items-center gap-2 text-base text-white/60 font-serif-display">
                {/* No mark here: the gutter avatar is already running the
                    thinking clip a few px away, so a second one just reads
                    as a duplicate. */}
                <span>Thinking…</span>
              </div>
            ) : isEditing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  ref={editRef}
                  value={editContent}
                  onChange={(e) => {
                    setEditContent(e.target.value)
                    const el = e.target
                    el.style.height = 'auto'
                    el.style.height = el.scrollHeight + 'px'
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      commitEdit()
                    }
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  className="bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-base text-white outline-none focus:border-holmes-primary/50 resize-none min-w-[300px] font-serif-display"
                  rows={1}
                />
                <div className="flex items-center gap-2 justify-end">
                  <button
                    onClick={cancelEdit}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    <FontAwesomeIcon icon={faXmark} className="w-3 h-3" />
                    Cancel
                  </button>
                  <button
                    onClick={commitEdit}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs text-holmes-primary-light hover:text-white bg-holmes-primary/20 hover:bg-holmes-primary/30 transition-colors cursor-pointer"
                  >
                    <FontAwesomeIcon icon={faCheck} className="w-3 h-3" />
                    Save
                  </button>
                </div>
              </div>
            ) : isUser ? (
              <div className="whitespace-pre-wrap text-base">{message.content}</div>
            ) : (
              <div className="font-serif-display">
                <MarkdownRenderer content={message.content} className="prose-lg holmes-response" />
              </div>
            )}

            {/* Stays a caret rather than a mark: it sits after the markdown
                block, so a logo here lands on its own line instead of trailing
                the text — and the gutter avatar already shows the talking clip. */}
            {isStreaming && hasContent && (
              <span className="inline-block w-2 h-4 bg-white/60 ml-0.5 animate-pulse" />
            )}
          </div>

          {!isEditing && <Toolbar />}
        </div>
      </div>
    </div>
  )
}
