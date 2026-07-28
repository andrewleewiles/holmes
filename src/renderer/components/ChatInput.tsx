import { type FC, useState, useRef, useEffect, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPaperclip, faImage, faFilm, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment } from '@shared/types'
import { MAX_ATTACHMENTS_PER_MESSAGE, formatAttachmentSize } from '@shared/attachments'
import { TOKEN_ESTIMATE_DISCLAIMER, estimateBlockTokens, formatTokenEstimate } from '@shared/tokenEstimate'
import type { SystemPromptEntry } from '../store/chatStore'
import { ProvenanceExplorer } from './ProvenanceExplorer'
import { ProvenanceText, useNodeProvenance } from './ProvenanceText'

interface ChatInputProps {
  onSend: (content: string, attachments?: ChatAttachment[]) => void
  onAbort: () => void
  isStreaming: boolean
  disabled: boolean
  lastSystemPrompt: SystemPromptEntry[]
  onWebSearchCommand?: (query: string) => void
}

export const ChatInput: FC<ChatInputProps> = ({ onSend, onAbort, isStreaming, disabled, lastSystemPrompt, onWebSearchCommand }) => {
  const [input, setInput] = useState('')
  const [showSystemPrompt, setShowSystemPrompt] = useState(false)
  const [selectedBlockIdx, setSelectedBlockIdx] = useState(0)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isStreaming])

  const cleanAttachError = (error: unknown): string => {
    if (!(error instanceof Error)) return 'Could not attach that file'
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  }

  const handleAttach = async () => {
    if (attaching || disabled || isStreaming) return
    setAttaching(true)
    setAttachError(null)
    try {
      const picked = await window.electronAPI.app.selectAttachments()
      if (picked.length === 0) return
      setAttachments((current) => {
        const existing = new Set(current.map((attachment) => `${attachment.name}:${attachment.bytes}`))
        const merged = [...current]
        for (const attachment of picked) {
          if (existing.has(`${attachment.name}:${attachment.bytes}`)) continue
          if (merged.length >= MAX_ATTACHMENTS_PER_MESSAGE) break
          merged.push(attachment)
        }
        return merged
      })
    } catch (err) {
      setAttachError(cleanAttachError(err))
    } finally {
      setAttaching(false)
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const handleSubmit = () => {
    const trimmed = input.trim()
    if ((!trimmed && attachments.length === 0) || disabled) return
    const webMatch = /^\/web(?:\s+(.*))?$/.exec(trimmed)
    if (webMatch) {
      const query = webMatch[1]?.trim() ?? ''
      if (!query) {
        setInput('')
        return
      }
      if (onWebSearchCommand) {
        onWebSearchCommand(query)
      }
      setInput('')
      return
    }
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    setInput('')
    setAttachments([])
    setAttachError(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
      setIsOverflowing(el.scrollHeight > 200)
    }
  }, [input])

  // Claim spans are recorded against the stored context; the block wraps it in
  // framing prose, so `textOffset` shifts them onto the text actually shown.
  const selectedRef = lastSystemPrompt[selectedBlockIdx]?.provenanceRef ?? null
  const selectedTextOffset = selectedRef?.textOffset
  const selectedProvenance = useNodeProvenance(selectedRef?.ref ?? null, selectedRef?.projectId ?? null)

  const totalChars = lastSystemPrompt.reduce((sum, m) => sum + m.content.length, 0)
  const blockTokens = useMemo(() => estimateBlockTokens(lastSystemPrompt), [lastSystemPrompt])
  const totalTokens = useMemo(() => blockTokens.reduce((sum, tokens) => sum + tokens, 0), [blockTokens])

  // Keep selected block in range when the prompt changes
  useEffect(() => {
    if (selectedBlockIdx >= lastSystemPrompt.length) {
      setSelectedBlockIdx(Math.max(0, lastSystemPrompt.length - 1))
    }
  }, [lastSystemPrompt.length, selectedBlockIdx])

  return (
    <div className="border-t border-white/10 bg-holmes-bg p-4">
      <div className="max-w-4xl mx-auto">
        <div className="mb-2">
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
            {lastSystemPrompt.length > 0 && (
              <span
                className="text-white/30 font-mono normal-case tracking-normal"
                title={`~${totalTokens.toLocaleString()} tokens · ${totalChars.toLocaleString()} chars — ${TOKEN_ESTIMATE_DISCLAIMER}`}
              >
                · {lastSystemPrompt.length} block{lastSystemPrompt.length === 1 ? '' : 's'} · ~{formatTokenEstimate(totalTokens)} tokens
              </span>
            )}
          </button>
          {showSystemPrompt && (
            <div className="mt-1.5 rounded-xl border border-white/10 bg-white/5 overflow-hidden">
              {lastSystemPrompt.length === 0 ? (
                <div className="px-4 py-3 text-xs text-white/40">
                  No system context configured for this conversation. Set a custom system prompt, select a memory context, or open a project to populate this preview.
                </div>
              ) : (
                <div className="flex flex-col">
                  <div className="flex items-center gap-1 px-2 pt-2 pb-1 border-b border-white/10 overflow-x-auto scrollbar-thin">
                    {lastSystemPrompt.map((entry, idx) => {
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
                  {lastSystemPrompt[selectedBlockIdx]?.provenanceRef && (
                    <div className="px-4 pt-2 pb-1 border-b border-white/[0.06]">
                      <ProvenanceExplorer
                        key={lastSystemPrompt[selectedBlockIdx].provenanceRef!.ref}
                        nodeRef={lastSystemPrompt[selectedBlockIdx].provenanceRef!.ref}
                        projectId={lastSystemPrompt[selectedBlockIdx].provenanceRef!.projectId}
                        label="Evidence chain"
                      />
                    </div>
                  )}
                  <div className="max-h-64 overflow-y-auto scrollbar-thin px-4 py-2">
                    {lastSystemPrompt[selectedBlockIdx] && (
                      <pre className="whitespace-pre-wrap break-words text-xs text-white/75 font-mono leading-relaxed">
                        {selectedTextOffset === undefined ? (
                          lastSystemPrompt[selectedBlockIdx].content
                        ) : (
                          <ProvenanceText
                            text={lastSystemPrompt[selectedBlockIdx].content}
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
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 pl-2 pr-1 py-1 text-xs text-white/70"
              >
                {attachment.kind === 'image' ? (
                  <img
                    src={attachment.dataUrl}
                    alt=""
                    className="w-6 h-6 rounded object-cover border border-white/10"
                  />
                ) : (
                  <span className="flex w-6 h-6 items-center justify-center rounded bg-white/10 text-white/50">
                    <FontAwesomeIcon icon={faFilm} className="w-3 h-3" />
                  </span>
                )}
                <span className="max-w-[180px] truncate">{attachment.name}</span>
                <span className="text-white/30 font-mono text-[10px]">{formatAttachmentSize(attachment.bytes)}</span>
                <button
                  onClick={() => removeAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.name}`}
                  className="px-1 py-0.5 rounded text-white/30 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                >
                  <FontAwesomeIcon icon={faXmark} className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {attachError && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-holmes-error-border bg-holmes-error-bg px-3 py-2 text-xs text-red-300">
            <span className="flex-1">{attachError}</span>
            <button onClick={() => setAttachError(null)} className="text-red-300 hover:text-white cursor-pointer">
              ×
            </button>
          </div>
        )}

        <div className="flex gap-3 items-end">
          <button
            onClick={handleAttach}
            disabled={disabled || isStreaming || attaching || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            aria-label="Attach image or video"
            title={attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments` : 'Attach image or video'}
            className="mb-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FontAwesomeIcon icon={attaching ? faImage : faPaperclip} className="w-4 h-4" />
          </button>
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... or /web <query> to search the web"
              rows={2}
              disabled={disabled || isStreaming}
              className={`w-full bg-white/10 rounded-xl px-4 py-4 pr-14 text-sm text-white placeholder-white/30 outline-none resize-none max-h-[200px] min-h-[56px] border border-white/10 focus:border-white/30 transition-colors disabled:opacity-50 ${
                isOverflowing ? 'scrollbar-thin' : 'no-scrollbar'
              }`}
            />
            {isStreaming ? (
              <button
                onClick={onAbort}
                className="absolute right-3 bottom-3 px-3 py-1.5 bg-holmes-error hover:bg-red-700 text-white rounded-lg text-xs font-medium transition-colors cursor-pointer"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={disabled || (!input.trim() && attachments.length === 0)}
                aria-label="Send"
                className={`absolute right-3 bottom-3 p-2 bg-holmes-primary hover:bg-holmes-primary-dark disabled:bg-holmes-primary/40 disabled:cursor-not-allowed text-white rounded-lg transition-all duration-150 flex items-center justify-center ${
                  input.trim() || attachments.length > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              >
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M10 4v12M10 4l-5 5M10 4l5 5"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
