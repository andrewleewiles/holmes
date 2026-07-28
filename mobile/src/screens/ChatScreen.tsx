import { useEffect, useRef, useState } from 'react'
import type { Conversation, Message, StreamChunk } from '@shared/types'
import { api, onStreamChunk } from '../transport/api'

interface Props {
  conversation: Conversation
  model: string
  onBack: () => void
}

export function ChatScreen({ conversation, model, onBack }: Props): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const reload = async (): Promise<void> => {
    setMessages(await api.conversations.getMessages(conversation.id))
  }

  useEffect(() => {
    void reload()
  }, [conversation.id])

  // The desktop holds a single global stream, so these chunks are the same ones
  // the Mac's own window is rendering. Both ends follow the same turn.
  useEffect(() => {
    return onStreamChunk((chunk: StreamChunk) => {
      if (chunk.error) {
        setError(chunk.error)
        setStreaming(false)
        setStreamText('')
        void reload()
        return
      }
      if (chunk.done) {
        setStreaming(false)
        setStreamText('')
        void reload()
        return
      }
      if (chunk.text) {
        setStreaming(true)
        setStreamText((current) => current + chunk.text)
      }
    })
  }, [conversation.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streamText])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || streaming) return
    setDraft('')
    setError(null)
    setStreaming(true)
    setStreamText('')
    try {
      await api.chat.send(conversation.id, text, model)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send')
      setStreaming(false)
    }
    void reload()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <button onClick={onBack} className="text-sm text-sky-400">Chats</button>
        <span className="min-w-0 flex-1 truncate text-sm text-white/70">{conversation.title}</span>
        {streaming && (
          <button onClick={() => void api.chat.abort()} className="text-xs text-white/40">Stop</button>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => (
            <div
              key={message.id}
              className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={
                  message.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-md bg-sky-500/90 px-3.5 py-2.5 text-[15px] leading-relaxed text-white'
                    : 'max-w-[92%] whitespace-pre-wrap text-[15px] leading-relaxed text-white/85'
                }
              >
                {message.content}
              </div>
            </div>
          ))}

        {streamText && (
          <div className="max-w-[92%] whitespace-pre-wrap text-[15px] leading-relaxed text-white/85">
            {streamText}
          </div>
        )}

        {streaming && !streamText && <div className="text-sm text-white/30">Thinking…</div>}

        {error && (
          <div className="rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-sm text-red-100/75">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="border-t border-white/[0.07] px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={1}
            placeholder="Message"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-[15px] text-white placeholder:text-white/25 focus:border-sky-400/40 focus:outline-none"
          />
          <button
            onClick={() => void send()}
            disabled={!draft.trim() || streaming}
            className="h-11 shrink-0 rounded-full bg-sky-500 px-4 text-sm font-medium text-white disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
