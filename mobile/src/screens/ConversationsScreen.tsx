import { useEffect, useState } from 'react'
import type { Conversation } from '@shared/types'
import { api, onConversationsUpdated } from '../transport/api'

interface Props {
  model: string
  onOpen: (conversation: Conversation) => void
}

function formatWhen(updatedAt: number): string {
  const minutes = Math.floor((Date.now() - updatedAt) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function ConversationsScreen({ model, onOpen }: Props): React.ReactElement {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = async (): Promise<void> => {
    try {
      setConversations(await api.conversations.list())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load chats')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // The Mac renames a conversation once the model produces a title.
    return onConversationsUpdated(() => void reload())
  }, [])

  const startNew = async (): Promise<void> => {
    try {
      const conversation = await api.conversations.create(model)
      onOpen(conversation)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a chat')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <h1 className="font-serif-display text-lg text-white">Chats</h1>
        <button onClick={() => void startNew()} className="text-sm text-sky-400">New</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <div className="m-4 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-sm text-red-100/75">{error}</div>}
        {loading && <div className="p-4 text-sm text-white/30">Loading…</div>}
        {!loading && conversations.length === 0 && !error && (
          <div className="p-4 text-sm text-white/30">No chats yet.</div>
        )}

        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                onClick={() => onOpen(conversation)}
                className="flex w-full items-center gap-3 border-b border-white/[0.04] px-4 py-3.5 text-left active:bg-white/[0.04]"
              >
                <span className="min-w-0 flex-1 truncate text-[15px] text-white/80">{conversation.title}</span>
                <span className="shrink-0 text-[11px] text-white/25">{formatWhen(conversation.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
