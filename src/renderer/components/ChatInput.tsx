import { type FC, useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faPaperclip, faImage } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment } from '@shared/types'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@shared/attachments'
import type { SystemPromptEntry } from '../store/chatStore'
import { useAttachmentDraft } from '../hooks/useAttachmentDraft'
import { AttachmentTray } from './AttachmentTray'
import { SystemPromptPanel } from './SystemPromptPanel'

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
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const {
    attachments,
    error: attachError,
    setError: setAttachError,
    add: addAttachments,
    remove: removeAttachment,
    clear: clearAttachments,
    handlePaste,
  } = useAttachmentDraft()
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
      addAttachments(picked)
    } catch (err) {
      setAttachError(cleanAttachError(err))
    } finally {
      setAttaching(false)
    }
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
    clearAttachments()
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

  return (
    <div className="bg-holmes-bg p-4">
      <div className="max-w-4xl mx-auto">
        <SystemPromptPanel entries={lastSystemPrompt} className="mb-2" />
        <AttachmentTray
          attachments={attachments}
          error={attachError}
          onRemove={removeAttachment}
          onDismissError={() => setAttachError(null)}
        />

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
              onPaste={handlePaste}
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
