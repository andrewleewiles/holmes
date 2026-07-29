import { type FC, useState, useEffect } from 'react'
import type { ChatAttachment, ModelInfo, ReasoningEffort, MemoryMode, ContextSelection } from '@shared/types'
import { NewConversationScreen } from './NewConversationScreen'

interface WelcomeScreenProps {
  onSend: (message: string, attachments?: ChatAttachment[]) => void
  models: ModelInfo[]
  selectedModel: string
  onModelChange: (model: string) => void
  selectedEffort: ReasoningEffort
  onEffortChange: (effort: ReasoningEffort) => void
  memoryMode: MemoryMode
  onMemoryModeChange: (mode: MemoryMode) => void
  selectedContext: ContextSelection
  onContextChange: (context: ContextSelection) => void
  selectedRoleId: string | null
  onRoleChange: (roleId: string | null) => void
}

/**
 * The home screen: a new conversation plus the profile-generated ideas. The
 * screen itself is NewConversationScreen — everything here is about sourcing
 * the ideas, which is the only thing the home screen adds.
 */
export const WelcomeScreen: FC<WelcomeScreenProps> = (props) => {
  const [ideas, setIdeas] = useState<string[]>([])

  // The stored set paints immediately; a refresh only costs a call when the
  // profile behind the ideas has actually moved on, and swaps them in quietly
  // when it lands.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.ideas.get().then((result) => {
      if (cancelled) return
      setIdeas(result.ideas)
      if (!result.stale) return
      void window.electronAPI.ideas.refresh().then((refreshed) => {
        if (!cancelled) setIdeas(refreshed.ideas)
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  return <NewConversationScreen {...props} ideas={ideas} />
}
