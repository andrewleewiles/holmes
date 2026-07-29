import { useEffect, useState } from 'react'
import type { ContextSelection, MemoryMode, SystemPromptEntry } from '@shared/types'

/**
 * The system prompt a not-yet-created conversation would be sent, previewed with
 * the pills currently selected on the new-conversation screen. Nothing is
 * fetched until `enabled` — building the preview reads every context source, so
 * it waits for a sign the user is actually composing a message.
 */
export function useDraftSystemPrompt(
  enabled: boolean,
  memoryMode: MemoryMode,
  context: ContextSelection,
  roleId: string | null
): { entries: SystemPromptEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<SystemPromptEntry[]>([])
  const [loading, setLoading] = useState(false)
  // A stacked selection is a fresh object on every change but not on every
  // render, and the effect should follow the value rather than the identity.
  const contextKey = JSON.stringify(context)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    // No conversation exists yet, so there is no row to read a custom prompt or
    // a role off — the empty id yields exactly the blocks a first turn gets.
    window.electronAPI.chat
      .previewSystemPrompt('', memoryMode, JSON.parse(contextKey) as ContextSelection, roleId)
      .then((messages) => {
        if (!cancelled) setEntries(messages)
      })
      .catch(() => { /* Preview is best-effort; leave the previous blocks up. */ })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, memoryMode, contextKey, roleId])

  return { entries, loading }
}
