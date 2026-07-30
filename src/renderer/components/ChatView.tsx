import { type FC, useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBolt, faArrowDown } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment, CitedSource, Message, ModelInfo, ReasoningEffort, MemoryMode, ContextSelection } from '@shared/types'
import type { SystemPromptEntry, StreamingToolInteraction } from '../store/chatStore'
import { MessageBubble } from './MessageBubble'
import { AssistantTurnBlock } from './AssistantTurnBlock'
import { groupTurns, streamingSegments, toolStepsFromInteractions } from './turnGrouping'
import { ChatInput } from './ChatInput'
import { ModelSelector } from './ModelSelector'
import { PillDropdown } from './PillDropdown'
import { MemoryDropdown } from './MemoryDropdown'
import { ContextDropdown } from './ContextDropdown'
import { RoleDropdown } from './RoleDropdown'
import { AssistantMark } from './AssistantMark'

interface ChatViewProps {
  messages: Message[]
  isStreaming: boolean
  streamingText: string
  streamingReasoning: string
  streamingToolInteractions: StreamingToolInteraction[]
  streamingSources: CitedSource[]
  error: string | null
  models: ModelInfo[]
  selectedModel: string
  selectedEffort: ReasoningEffort
  memoryMode: MemoryMode
  selectedContext: ContextSelection
  selectedRoleId: string | null
  lastSystemPrompt: SystemPromptEntry[]
  title: string
  onSend: (content: string, attachments?: ChatAttachment[]) => void
  onAbort: () => void
  onModelChange: (modelId: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onMemoryModeChange: (mode: MemoryMode) => void
  onContextChange: (context: ContextSelection) => void
  onRoleChange: (roleId: string | null) => void
  onRename: (title: string) => void
  onEditMessage: (messageId: string, newContent: string) => void
  onRetryMessage: (messageId: string) => void
  onSetActiveBranch: (messageId: string) => void
  onClearError: () => void
  onWebSearchCommand: (query: string) => void
}

export const ChatView: FC<ChatViewProps> = ({
  messages,
  isStreaming,
  streamingText,
  streamingReasoning,
  streamingToolInteractions,
  streamingSources,
  error,
  models,
  selectedModel,
  selectedEffort,
  memoryMode,
  selectedContext,
  selectedRoleId,
  lastSystemPrompt,
  title,
  onSend,
  onAbort,
  onModelChange,
  onEffortChange,
  onMemoryModeChange,
  onContextChange,
  onRoleChange,
  onRename,
  onEditMessage,
  onRetryMessage,
  onSetActiveBranch,
  onClearError,
  onWebSearchCommand,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  // A tool-using answer is stored as several rows; grouped back into turns so it
  // renders as the one reply it is.
  const turns = useMemo(() => groupTurns(messages), [messages])
  const streamingSteps = useMemo(() => toolStepsFromInteractions(streamingToolInteractions), [streamingToolInteractions])

  /**
   * At most ONE Holmes mark is ever on screen: the newest assistant turn wears it,
   * every earlier turn leaves an empty gutter of the same width. The mark is the
   * assistant's presence, and repeating it down the transcript turned a signal into
   * wallpaper. While a turn is streaming the live block takes it instead, so the
   * animating mark is always the one doing the work.
   */
  const markedTurnIndex = useMemo(() => {
    if (isStreaming) return -1
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].kind === 'assistant') return index
    }
    return -1
  }, [turns, isStreaming])

  const isNearBottom = () => {
    const el = scrollContainerRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const handleScroll = () => {
    const el = scrollContainerRef.current
    if (!el) return
    const prev = lastScrollTopRef.current
    const curr = el.scrollTop
    lastScrollTopRef.current = curr
    const near = isNearBottom()
    if (curr < prev && !near) {
      stickToBottomRef.current = false
    } else if (near) {
      stickToBottomRef.current = true
    }
    setShowJumpToBottom(!stickToBottomRef.current)
  }

  const jumpToBottom = () => {
    const el = scrollContainerRef.current
    stickToBottomRef.current = true
    lastScrollTopRef.current = el?.scrollTop ?? 0
    setShowJumpToBottom(false)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    if (!stickToBottomRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [messages, streamingText, streamingReasoning])

  useEffect(() => {
    if (isStreaming) {
      stickToBottomRef.current = true
      const el = scrollContainerRef.current
      if (el) lastScrollTopRef.current = el.scrollTop
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    } else if (stickToBottomRef.current) {
      setShowJumpToBottom(false)
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [isStreaming])

  useEffect(() => {
    if (!editingTitle) setTitleDraft(title)
  }, [title, editingTitle])

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [editingTitle])

  const commitTitle = () => {
    const trimmed = titleDraft.trim()
    if (trimmed && trimmed !== title) onRename(trimmed)
    setEditingTitle(false)
  }

  const effortOptions = [
    { value: 'low', label: 'Low effort' },
    { value: 'medium', label: 'Medium effort' },
    { value: 'high', label: 'High effort' },
  ]

  return (
    <div className="flex flex-col h-full bg-holmes-bg">
      <div className="px-6 pt-3 pb-2 border-b border-white/10">
        <div className="flex items-center justify-start mb-2">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') {
                  setTitleDraft(title)
                  setEditingTitle(false)
                }
              }}
              className="bg-white/10 border border-white/20 rounded-md px-2 py-0.5 text-lg font-medium text-white outline-none focus:border-holmes-primary/50 max-w-md font-serif-display"
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="group flex items-center gap-2 text-lg font-medium text-white/90 hover:text-white transition-colors cursor-pointer truncate max-w-md font-serif-display"
              title="Click to rename"
            >
              <span className="truncate">{title}</span>
              <svg className="w-3.5 h-3.5 text-white/30 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center justify-start">
          <div className="flex items-center gap-3 flex-wrap">
          <ModelSelector
            models={models}
            selectedModel={selectedModel}
            onSelect={onModelChange}
            disabled={isStreaming}
          />
          <PillDropdown
            icon={<FontAwesomeIcon icon={faBolt} className="w-4 h-4" />}
            label="Effort"
            value={selectedEffort}
            options={effortOptions}
            onSelect={(v) => onEffortChange(v as ReasoningEffort)}
            disabled={isStreaming}
          />
          <MemoryDropdown
            value={memoryMode}
            onChange={onMemoryModeChange}
            disabled={isStreaming}
          />
          <ContextDropdown
            value={selectedContext}
            onChange={onContextChange}
            disabled={isStreaming}
          />
          <RoleDropdown
            value={selectedRoleId}
            onChange={onRoleChange}
            disabled={isStreaming}
          />
        </div>
      </div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4 relative"
      >
        <div className="max-w-4xl mx-auto">
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-white/30 mt-24">
              <AssistantMark className="w-16 h-16 mb-4 opacity-50" />
              <svg className="hidden" viewBox="0 0 213.6 235.59">
                <path fill="currentColor" d="M112.74,186.19c.35,4.26,2.56,16.89-.5,19.07-2.44,1.74-6.2-1.19-8.32-3.13-3.21-2.94-6.16-5.82-9.17-9-.67-.7-1.92-1.33-2.56-1.93-5.94-5.56-11.75-10.78-18.76-15.03-11.88-7.21-24.95-11.11-38.83-12.18l-4.15-1.8c-2.34.45-4.78,1.41-7.17,2.17-2.43-.86-7.41-5.33-5.67-8.83,1.99-4.02,3.89-7.75,5.44-11.95.64-1.72-1.71-3.6-3.19-3.91-6.72-1.38-10.2.86-15.53-1.32-3.99-1.63-5.56-6.28-3.2-9.94l5.74-8.91,16.4-24.85c1.69-2.56,1.29-5.41-1.15-7.37-3.18-2.56-4.43-6.68-2.36-10.46,3.43-6.26,6.53-8.01,7.57-14.64,1.41-8.94,5.12-16.97,10.82-23.59-1.31,15.53,5.92,26.86,19.93,31.97,12.18,4.44,22.77,2.21,35.29,7.31,4.05,1.65,7.61,3.92,10.37,7.21,3.62,4.32,3.88,9.97.9,14.73-5.12,8.21-13.88,10.03-20.7,17.7-5.75,6.47-5.3,15.28,1.01,21.15,11.24,10.46,29.61,10.57,39.96,19.43,3.49,2.99,4.82,7.51,2.59,11.49-1.74,3.12-4.53,4.79-7.86,6.91,3.57.18,7.84.53,11.21-1.31s5.42-5.88,6.13-9.45c1.39-7-6.33-12.52-11.74-15.15l-14.04-6.81c-3.99-1.93-7.38-4.56-10.31-7.78-4.54-4.99-4.78-11.99-.78-17.45,6-8.2,14.97-9.96,22.88-18.65,5.22-5.74,5.44-13.85.2-19.57-3.32-3.62-7.4-6.12-12.01-7.97-18.63-7.48-37.53-2.57-53.16-15.2-7.04-5.68-10.78-14.09-10.05-23.16.67-8.35,5.37-15.85,12.98-20.67,11.37-7.19,24.69-11.07,38.32-11.68-10.65,11.24-19.21,28.27-10.74,42.72,12.34,19.23,39.94,15.66,52.75,33.36,4.26,5.88,3.8,13.2-.73,18.86-7.93,9.92-18.39,12.65-24.56,21.52-3.57,5.14-3.71,11.74.62,16.36-2.84-11.26,7.08-18.92,15.63-23.5s16.78-8.23,22.96-15.76c5.51-6.72,5.18-15.82-.73-22.12-13.62-14.52-35.53-12.09-48.7-27.16-5.51-6.3-6.2-14.69-2.12-22C109.81,12.87,122.21,10.51,120.59.03c5.13-.12,10.09.1,14.97.56,6.81.64,12.06,3.64,17.7,7.16,6.46,4.04,13.25,7.25,19.41,12.08-5.29.43-10.31,1.22-15.53,2.13-6.28,1.09-12.34,2.09-18.48,3.73-3.84,1.03-7.47,2.66-10.38,5.19-3.85,3.35-4.14,8.58-.79,12.38,8.8,9.99,28.07,9.25,44.34,19.99,4.06,2.68,7.42,5.86,9.95,9.94,4.45,7.19,3.59,15.85-1.95,22.26-13.79,15.95-40,13.98-49.91,29.07-2.88,4.38-2.84,9.57-.18,14.03,3.53,5.94,9.13,7.7,14.01,13.5,3.69,4.38,3.91,10.27.59,14.93" />
              </svg>
              <p className="text-lg font-serif-display">Start a conversation</p>
              <p className="text-sm mt-1">Type a message below to begin</p>
            </div>
          )}

          {turns.map((turn, idx) => (
            <div key={turn.key}>
              {idx > 0 && turns[idx - 1]?.kind === 'assistant' && turn.kind === 'user' && (
                <hr className="my-2 border-white/5" />
              )}
              {turn.kind === 'user' ? (
                <MessageBubble
                  message={turn.message}
                  turnInFlight={isStreaming}
                  onEdit={onEditMessage}
                  onRetry={onRetryMessage}
                  onSetActiveBranch={onSetActiveBranch}
                />
              ) : (
                <AssistantTurnBlock
                  turn={turn}
                  turnInFlight={isStreaming}
                  showMark={idx === markedTurnIndex}
                  onRetry={onRetryMessage}
                  onSetActiveBranch={onSetActiveBranch}
                />
              )}
            </div>
          ))}

          {isStreaming && (
            <AssistantTurnBlock
              turn={{
                kind: 'assistant',
                key: 'streaming',
                segments: streamingSegments(streamingText, streamingSteps, streamingSources),
                reasoning: streamingReasoning || undefined,
                createdAt: Date.now(),
                branchMessage: { id: 'streaming', conversationId: '', role: 'assistant', content: '', createdAt: Date.now() },
                copyText: streamingText,
              }}
              isStreaming
              showMark
            />
          )}

          {error && (
            <div               className="flex items-center gap-2 p-3 rounded-lg bg-holmes-error-bg border border-holmes-error-border text-red-300 text-sm mb-2">
              <span className="flex-1">{error}</span>
              <button onClick={onClearError} className="text-red-300 hover:text-white cursor-pointer">
                ×
              </button>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
        {showJumpToBottom && (
          <button
            onClick={jumpToBottom}
            className="fixed bottom-28 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-holmes-surface border border-white/15 text-white/80 text-xs hover:text-white hover:border-holmes-primary/50 transition-colors shadow-lg cursor-pointer"
          >
            <FontAwesomeIcon icon={faArrowDown} className="w-3 h-3" />
            Jump to latest
          </button>
        )}
      </div>

      <ChatInput
        onSend={onSend}
        onAbort={onAbort}
        isStreaming={isStreaming}
        disabled={messages.length === 0 && isStreaming}
        lastSystemPrompt={lastSystemPrompt}
        onWebSearchCommand={onWebSearchCommand}
      />
    </div>
  )
}
