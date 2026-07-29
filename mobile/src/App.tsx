import { useEffect, useState } from 'react'
import type { Conversation, LibraryBook } from '@shared/types'
import { remoteClient, type ConnectionState } from './transport/client'
import { api } from './transport/api'
import { PairScreen } from './screens/PairScreen'
import { LibraryScreen } from './screens/LibraryScreen'
import { ReaderScreen } from './screens/ReaderScreen'
import { ConversationsScreen } from './screens/ConversationsScreen'
import { ChatScreen } from './screens/ChatScreen'
import { DataScreen } from './screens/DataScreen'

type Tab = 'chats' | 'data'

export function App(): React.ReactElement {
  const [state, setState] = useState<ConnectionState>('offline')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('chats')
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [book, setBook] = useState<LibraryBook | null>(null)
  const [model, setModel] = useState('')
  const scope = remoteClient.getScope()

  useEffect(() => {
    const unsubscribe = remoteClient.onState((next, nextError) => {
      setState(next)
      setError(nextError)
    })
    void remoteClient.start()
    return unsubscribe
  }, [])

  // The desktop decides which model a new chat starts on; the phone should not
  // invent its own default. A guest has no chat, and no right to read settings.
  useEffect(() => {
    if (state !== 'connected' || model || scope !== 'owner') return
    void api.clientSettings()
      .then((settings) => setModel(settings.defaultModel))
      .catch(() => { /* The chat screen surfaces the failure when sending. */ })
  }, [state, model])

  if (state === 'unpaired' || state === 'revoked') {
    return (
      <div className="h-full overflow-y-auto bg-holmes-bg">
        {state === 'revoked' && (
          <div className="bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200/80">{error}</div>
        )}
        <PairScreen onPaired={() => setTab('chats')} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-holmes-bg pt-[env(safe-area-inset-top)]">
      {state !== 'connected' && (
        <div className="bg-white/[0.06] px-4 py-1.5 text-center text-[11px] text-white/45">
          {state === 'connecting' ? `Connecting to ${remoteClient.getHost() ?? 'your Mac'}…` : 'Offline'}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {scope === 'media' ? (
          book
            ? <ReaderScreen entry={book} onBack={() => setBook(null)} />
            : <LibraryScreen onOpen={setBook} />
        ) : conversation ? (
          <ChatScreen conversation={conversation} model={model} onBack={() => setConversation(null)} />
        ) : tab === 'chats' ? (
          <ConversationsScreen model={model} onOpen={setConversation} />
        ) : (
          <DataScreen />
        )}
      </div>

      {scope === 'owner' && !conversation && (
        <nav className="flex border-t border-white/[0.07] pb-[env(safe-area-inset-bottom)]">
          {(['chats', 'data'] as Tab[]).map((entry) => (
            <button
              key={entry}
              onClick={() => setTab(entry)}
              className={`flex-1 py-3 text-sm capitalize transition-colors ${
                tab === entry ? 'text-sky-400' : 'text-white/35'
              }`}
            >
              {entry}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
