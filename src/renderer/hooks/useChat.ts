import { useChatStore } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'

export function useChat() {
  const {
    conversations,
    currentConversationId,
    messages,
    isStreaming,
    streamingText,
    streamingReasoning,
    streamingToolInteractions,
    error,
    selectedModel,
    selectedEffort,
    memoryMode,
    selectedContext,
    selectedRoleId,
    lastSystemPrompt,
    loadConversations,
    createConversation,
    startDraftConversation,
    deleteConversation,
    renameConversation,
    updateConversationModel,
    updateConversationEffort,
    selectConversation,
    sendMessage,
    editMessage,
    retryMessage,
    setActiveBranch,
    abortStream,
    clearError,
    setSelectedModel,
    setSelectedEffort,
    setMemoryMode,
    setSelectedContext,
    setSelectedRole,
    refreshSystemPromptPreview,
  } = useChatStore()

  const { models } = useSettingsStore()

  const currentConversation = conversations.find((c) => c.id === currentConversationId)

  const activeModel =
    currentConversation?.model ||
    selectedModel ||
    useSettingsStore.getState().settings?.defaultModel ||
    (models.length > 0 ? models[0].id : '')

  const activeEffort =
    currentConversation?.reasoningEffort || selectedEffort

  return {
    conversations,
    currentConversation,
    currentConversationId,
    messages,
    isStreaming,
    streamingText,
    streamingReasoning,
    streamingToolInteractions,
    error,
    activeModel,
    activeEffort,
    selectedModel,
    selectedEffort,
    memoryMode,
    selectedContext,
    selectedRoleId,
    lastSystemPrompt,
    loadConversations,
    createConversation,
    startDraftConversation,
    deleteConversation,
    renameConversation,
    updateConversationModel,
    updateConversationEffort,
    selectConversation,
    sendMessage,
    editMessage,
    retryMessage,
    setActiveBranch,
    abortStream,
    clearError,
    setSelectedModel,
    setSelectedEffort,
    setMemoryMode,
    setSelectedContext,
    setSelectedRole,
    refreshSystemPromptPreview,
  }
}
