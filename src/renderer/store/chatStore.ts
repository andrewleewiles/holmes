import { create } from 'zustand'
import type { ChatAttachment, Conversation, Message, StreamChunk, ReasoningEffort, MemoryMode, ContextSelection, ToolCall, ToolResult, SystemPromptEntry } from '@shared/types'
import { normalizeContextSelection } from '@shared/contextSelection'

export type { SystemPromptEntry }

export interface StreamingToolInteraction {
  type: 'call' | 'result'
  toolCall?: ToolCall
  toolResult?: ToolResult
}

interface ChatState {
  conversations: Conversation[]
  currentConversationId: string | null
  messages: Message[]
  isStreaming: boolean
  streamingText: string
  streamingReasoning: string
  streamingToolInteractions: StreamingToolInteraction[]
  error: string | null
  selectedModel: string
  selectedEffort: ReasoningEffort
  memoryMode: MemoryMode
  selectedContext: ContextSelection
  selectedRoleId: string | null
  lastSystemPrompt: SystemPromptEntry[]

  loadConversations: () => Promise<void>
  createConversation: (model?: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection, roleId?: string | null) => Promise<void>
  startDraftConversation: () => void
  deleteConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  updateConversationModel: (id: string, model: string) => Promise<void>
  updateConversationEffort: (id: string, effort: ReasoningEffort) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  sendMessage: (content: string, model: string, effort?: ReasoningEffort, attachments?: ChatAttachment[]) => Promise<void>
  editMessage: (messageId: string, newContent: string, model: string, effort?: ReasoningEffort) => Promise<void>
  retryMessage: (messageId: string, model: string, effort?: ReasoningEffort) => Promise<void>
  setActiveBranch: (messageId: string) => Promise<void>
  abortStream: () => void
  clearError: () => void
  setSelectedModel: (model: string) => void
  setSelectedEffort: (effort: ReasoningEffort) => void
  setMemoryMode: (mode: MemoryMode) => void
  setSelectedContext: (context: ContextSelection) => void
  setSelectedRole: (roleId: string | null) => void
  refreshSystemPromptPreview: () => Promise<void>
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  messages: [],
  isStreaming: false,
  streamingText: '',
  streamingReasoning: '',
  streamingToolInteractions: [],
  error: null,
  selectedModel: '',
  selectedEffort: 'medium',
  memoryMode: 'detailed',
  selectedContext: { kind: 'none' },
  selectedRoleId: null,
  lastSystemPrompt: [],

  loadConversations: async () => {
    const conversations = await window.electronAPI.conversations.list()
    set({ conversations })
  },

  createConversation: async (model?: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection, roleId?: string | null) => {
    const conversation = await window.electronAPI.conversations.create(model, effort, undefined, memoryMode, context, roleId ?? get().selectedRoleId)
    const conversations = await window.electronAPI.conversations.list()
    set({
      conversations,
      currentConversationId: conversation.id,
      messages: [],
      error: null,
      memoryMode: conversation.memoryMode,
      selectedContext: conversation.context,
      selectedRoleId: conversation.roleId,
    })
    await get().refreshSystemPromptPreview()
  },

  // "New Conversation" opens an unsaved draft: the welcome screen with no row
  // in the sidebar. The conversation is only created once the user actually
  // sends something, which is what stops the list filling with empty chats.
  startDraftConversation: () => {
    set({
      currentConversationId: null,
      messages: [],
      streamingText: '',
      streamingReasoning: '',
      streamingToolInteractions: [],
      error: null,
      lastSystemPrompt: [],
    })
  },

  deleteConversation: async (id: string) => {
    await window.electronAPI.conversations.delete(id)
    const conversations = await window.electronAPI.conversations.list()
    const state = get()
    if (state.currentConversationId === id) {
      set({ conversations, currentConversationId: null, messages: [], lastSystemPrompt: [] })
    } else {
      set({ conversations })
    }
  },

  renameConversation: async (id: string, title: string) => {
    await window.electronAPI.conversations.rename(id, title)
    const conversations = await window.electronAPI.conversations.list()
    set({ conversations })
  },

  updateConversationModel: async (id: string, model: string) => {
    await window.electronAPI.conversations.updateModel(id, model)
  },

  updateConversationEffort: async (id: string, effort: ReasoningEffort) => {
    await window.electronAPI.conversations.updateEffort(id, effort)
  },

  selectConversation: async (id: string) => {
    const messages = await window.electronAPI.conversations.getMessages(id)
    const conversation = get().conversations.find((c) => c.id === id)
    set({
      currentConversationId: id,
      messages,
      streamingText: '',
      streamingReasoning: '',
      streamingToolInteractions: [],
      error: null,
      lastSystemPrompt: [],
      memoryMode: conversation?.memoryMode ?? get().memoryMode,
      selectedContext: conversation?.context ?? get().selectedContext,
      // A conversation with no role reads as "no role", not as whatever the
      // previous conversation was set to.
      selectedRoleId: conversation ? conversation.roleId : get().selectedRoleId,
    })
    await get().refreshSystemPromptPreview()
  },

  sendMessage: async (content: string, model: string, effort?: ReasoningEffort, attachments?: ChatAttachment[]) => {
    const { currentConversationId, messages, memoryMode, selectedContext } = get()
    if (!currentConversationId) return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      conversationId: currentConversationId,
      role: 'user',
      content,
      createdAt: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }

    set({
      messages: [...messages, userMessage],
      isStreaming: true,
      streamingText: '',
      streamingReasoning: '',
      streamingToolInteractions: [],
      error: null,
    })

    const systemPromptCleanup = window.electronAPI.chat.onSystemPrompt((systemMessages) => {
      set({ lastSystemPrompt: systemMessages })
    })

    const cleanup = window.electronAPI.chat.onChunk((chunk: StreamChunk) => {
      if (chunk.error) {
        set({ isStreaming: false, streamingText: '', streamingReasoning: '', streamingToolInteractions: [], error: chunk.error })
        cleanup()
        systemPromptCleanup()
        return
      }

      if (chunk.done) {
        window.electronAPI.conversations.getMessages(currentConversationId).then((msgs) => {
          set({ messages: msgs, isStreaming: false, streamingText: '', streamingReasoning: '', streamingToolInteractions: [] })
        })
        cleanup()
        systemPromptCleanup()
      } else if (chunk.toolCalls || chunk.toolResults) {
        set((state) => {
          const newInteractions = [...state.streamingToolInteractions]
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls) {
              newInteractions.push({ type: 'call', toolCall: tc })
            }
          }
          if (chunk.toolResults) {
            for (const tr of chunk.toolResults) {
              newInteractions.push({ type: 'result', toolResult: tr })
            }
          }
          return {
            streamingText: state.streamingText + (chunk.text || ''),
            streamingReasoning: state.streamingReasoning + (chunk.reasoning || ''),
            streamingToolInteractions: newInteractions,
          }
        })
      } else {
        set((state) => ({
          streamingText: state.streamingText + (chunk.text || ''),
          streamingReasoning: state.streamingReasoning + (chunk.reasoning || ''),
        }))
      }
    })

    try {
      await window.electronAPI.chat.send(currentConversationId, content, model, effort, memoryMode, selectedContext, attachments)
    } catch (err) {
      set({
        isStreaming: false,
        streamingText: '',
        streamingReasoning: '',
        error: err instanceof Error ? err.message : 'Failed to send message',
      })
      cleanup()
      systemPromptCleanup()
    }
  },

  editMessage: async (messageId: string, newContent: string, model: string, effort?: ReasoningEffort) => {
    const { currentConversationId, messages, memoryMode, selectedContext } = get()
    if (!currentConversationId) return

    // Optimistic update: replace message content, truncate subsequent messages
    const msgIndex = messages.findIndex((m) => m.id === messageId)
    if (msgIndex === -1) return

    const updatedMessages = messages.slice(0, msgIndex)
    updatedMessages.push({ ...messages[msgIndex], content: newContent })

    set({ messages: updatedMessages, isStreaming: true, streamingText: '', streamingReasoning: '', streamingToolInteractions: [], error: null })

    const systemPromptCleanup = window.electronAPI.chat.onSystemPrompt((systemMessages) => {
      set({ lastSystemPrompt: systemMessages })
    })

    const cleanup = window.electronAPI.chat.onChunk((chunk: StreamChunk) => {
      if (chunk.error) {
        set({ isStreaming: false, streamingText: '', streamingReasoning: '', streamingToolInteractions: [], error: chunk.error })
        cleanup()
        systemPromptCleanup()
        return
      }

      if (chunk.done) {
        window.electronAPI.conversations.getMessages(currentConversationId).then((msgs) => {
          set({ messages: msgs, isStreaming: false, streamingText: '', streamingReasoning: '', streamingToolInteractions: [] })
        })
        cleanup()
        systemPromptCleanup()
      } else if (chunk.toolCalls || chunk.toolResults) {
        set((state) => {
          const newInteractions = [...state.streamingToolInteractions]
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls) {
              newInteractions.push({ type: 'call', toolCall: tc })
            }
          }
          if (chunk.toolResults) {
            for (const tr of chunk.toolResults) {
              newInteractions.push({ type: 'result', toolResult: tr })
            }
          }
          return {
            streamingText: state.streamingText + (chunk.text || ''),
            streamingReasoning: state.streamingReasoning + (chunk.reasoning || ''),
            streamingToolInteractions: newInteractions,
          }
        })
      } else {
        set((state) => ({
          streamingText: state.streamingText + (chunk.text || ''),
          streamingReasoning: state.streamingReasoning + (chunk.reasoning || ''),
        }))
      }
    })

    try {
      await window.electronAPI.chat.editMessage(messageId, newContent, model, effort, memoryMode, selectedContext)
    } catch (err) {
      set({
        isStreaming: false,
        streamingText: '',
        streamingReasoning: '',
        streamingToolInteractions: [],
        error: err instanceof Error ? err.message : 'Failed to edit message',
      })
      cleanup()
      systemPromptCleanup()
    }
  },

  retryMessage: async (messageId: string, model: string, effort?: ReasoningEffort) => {
    const { currentConversationId, messages, memoryMode, selectedContext } = get()
    if (!currentConversationId) return

    // Optimistic update: truncate messages after the originating user message
    const msgIndex = messages.findIndex((m) => m.id === messageId)
    if (msgIndex === -1) return

    let userIndex = msgIndex
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex -= 1
    if (userIndex < 0) {
      set({ error: 'Nothing to retry: this message has no originating user message to regenerate from. Send a new message instead.' })
      return
    }

    const updatedMessages = messages.slice(0, userIndex + 1)

    set({ messages: updatedMessages, isStreaming: true, streamingText: '', streamingReasoning: '', streamingToolInteractions: [], error: null })

    const systemPromptCleanup = window.electronAPI.chat.onSystemPrompt((systemMessages) => {
      set({ lastSystemPrompt: systemMessages })
    })

    const cleanup = window.electronAPI.chat.onChunk((chunk: StreamChunk) => {
      if (chunk.error) {
        set({ isStreaming: false, streamingText: '', streamingReasoning: '', streamingToolInteractions: [], error: chunk.error })
        cleanup()
        systemPromptCleanup()
        return
      }

      if (chunk.done) {
        window.electronAPI.conversations.getMessages(currentConversationId).then((msgs) => {
          set({ messages: msgs, isStreaming: false, streamingText: '', streamingReasoning: '', streamingToolInteractions: [] })
        })
        cleanup()
        systemPromptCleanup()
      } else if (chunk.toolCalls || chunk.toolResults) {
        set((state) => {
          const newInteractions = [...state.streamingToolInteractions]
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls) {
              newInteractions.push({ type: 'call', toolCall: tc })
            }
          }
          if (chunk.toolResults) {
            for (const tr of chunk.toolResults) {
              newInteractions.push({ type: 'result', toolResult: tr })
            }
          }
          return {
            streamingText: state.streamingText + (chunk.text || ''),
            streamingReasoning: state.streamingReasoning + (chunk.reasoning || ''),
            streamingToolInteractions: newInteractions,
          }
        })
      } else {
        set((state) => ({
          streamingText: state.streamingText + (chunk.text || ''),
          streamingReasoning: state.streamingReasoning + (chunk.reasoning || ''),
        }))
      }
    })

    try {
      await window.electronAPI.chat.retryMessage(messageId, model, effort, memoryMode, selectedContext)
    } catch (err) {
      set({
        isStreaming: false,
        streamingText: '',
        streamingReasoning: '',
        streamingToolInteractions: [],
        error: err instanceof Error ? err.message : 'Failed to retry message',
      })
      cleanup()
      systemPromptCleanup()
    }
  },

  setActiveBranch: async (messageId: string) => {
    const { currentConversationId } = get()
    if (!currentConversationId) return

    await window.electronAPI.chat.setActiveBranch(messageId)
    const msgs = await window.electronAPI.conversations.getMessages(currentConversationId)
    set({ messages: msgs })
  },

  abortStream: () => {
    window.electronAPI.chat.abort()
    set({ isStreaming: false, streamingText: '', streamingReasoning: '' })
  },

  clearError: () => set({ error: null }),

  setSelectedModel: (model: string) => set({ selectedModel: model }),

  setSelectedEffort: (effort: ReasoningEffort) => set({ selectedEffort: effort }),

  setMemoryMode: (mode: MemoryMode) => {
    const { currentConversationId } = get()
    set({ memoryMode: mode })
    if (currentConversationId) {
      void window.electronAPI.conversations.updateMemoryMode(currentConversationId, mode)
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === currentConversationId ? { ...c, memoryMode: mode } : c
        ),
      }))
    }
    void get().refreshSystemPromptPreview()
  },

  setSelectedContext: (rawContext: ContextSelection) => {
    const { currentConversationId } = get()
    const context = normalizeContextSelection(rawContext)
    set({ selectedContext: context })
    if (currentConversationId) {
      // Pointing a conversation at a project also files it there, so the list has
      // to come back from the main process rather than being patched in place.
      void window.electronAPI.conversations
        .updateContext(currentConversationId, context)
        .then(() => window.electronAPI.conversations.list())
        .then((conversations) => set({ conversations }))
        .catch(() => {
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === currentConversationId ? { ...c, context } : c
            ),
          }))
        })
    }
    void get().refreshSystemPromptPreview()
  },

  setSelectedRole: (roleId: string | null) => {
    const { currentConversationId } = get()
    set({ selectedRoleId: roleId })
    if (!currentConversationId) {
      // A draft conversation carries the selection until it is created.
      void get().refreshSystemPromptPreview()
      return
    }
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === currentConversationId ? { ...c, roleId } : c
      ),
    }))
    // The preview reads the role off the conversation row, so it has to wait for
    // the write — otherwise switching role renders the previous role's block.
    void window.electronAPI.conversations
      .updateRole(currentConversationId, roleId)
      .catch(() => { /* The selection still applies to the next send. */ })
      .then(() => get().refreshSystemPromptPreview())
  },

  refreshSystemPromptPreview: async () => {
    const { currentConversationId, memoryMode, selectedContext } = get()
    if (!currentConversationId) {
      set({ lastSystemPrompt: [] })
      return
    }
    try {
      const systemMessages = await window.electronAPI.chat.previewSystemPrompt(currentConversationId, memoryMode, selectedContext)
      // Only update if still relevant (conversation hasn't changed)
      if (get().currentConversationId === currentConversationId) {
        set({ lastSystemPrompt: systemMessages })
      }
    } catch {
      // Preview is best-effort; leave existing state on failure
    }
  },
}))
