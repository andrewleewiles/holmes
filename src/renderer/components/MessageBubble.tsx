import { type FC, useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { Message } from '@shared/types'
import { formatAttachmentSize } from '@shared/attachments'
import { MessageToolbar } from './MessageToolbar'

interface MessageBubbleProps {
  message: Message
  /** True while any turn is streaming — see the note in MessageToolbar. */
  turnInFlight?: boolean
  onEdit?: (messageId: string, newContent: string) => void
  onRetry?: (messageId: string) => void
  onSetActiveBranch?: (messageId: string) => void
}

/**
 * The user's own message.
 *
 * Assistant replies do NOT come through here: one reply can span several stored
 * rows (prose, tool calls, tool results), so it is grouped into a turn and
 * rendered by AssistantTurnBlock instead.
 */
export const MessageBubble: FC<MessageBubbleProps> = ({ message, turnInFlight, onEdit, onRetry, onSetActiveBranch }) => {
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const editRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isEditing) {
      editRef.current?.focus()
      editRef.current?.select()
      const el = editRef.current
      if (el) {
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight}px`
      }
    }
  }, [isEditing])

  const startEdit = () => {
    setEditContent(message.content)
    setIsEditing(true)
  }

  const commitEdit = () => {
    const trimmed = editContent.trim()
    if (trimmed && trimmed !== message.content && onEdit) onEdit(message.id, trimmed)
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setEditContent(message.content)
    setIsEditing(false)
  }

  const attachments = message.attachments ?? []

  return (
    <div className="group mb-4 flex flex-col items-end">
      {attachments.length > 0 && (
        <div className={`flex flex-wrap justify-end gap-2 ${message.content ? 'mb-2' : ''}`}>
          {attachments.map((attachment) => (
            <figure key={attachment.id} className="max-w-[260px] overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]">
              {attachment.kind === 'image' ? (
                <img src={attachment.dataUrl} alt={attachment.name} className="block max-h-64 w-full bg-black/20 object-contain" />
              ) : (
                <video src={attachment.dataUrl} controls className="block max-h-64 w-full bg-black/40" />
              )}
              <figcaption className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-white/40">
                <span className="flex-1 truncate">{attachment.name}</span>
                <span className="shrink-0 font-mono text-white/25">{formatAttachmentSize(attachment.bytes)}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#151514] px-4 py-3 text-white">
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <textarea
              ref={editRef}
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = `${el.scrollHeight}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitEdit()
                }
                if (e.key === 'Escape') cancelEdit()
              }}
              className="min-w-[300px] resize-none rounded-lg border border-white/20 bg-white/10 px-3 py-2 font-serif-display text-base text-white outline-none focus:border-holmes-primary/50"
              rows={1}
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={cancelEdit}
                className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-white/50 transition-colors hover:bg-white/10 hover:text-white"
              >
                <FontAwesomeIcon icon={faXmark} className="h-3 w-3" />
                Cancel
              </button>
              <button
                onClick={commitEdit}
                className="flex cursor-pointer items-center gap-1 rounded bg-holmes-primary/20 px-2 py-1 text-xs text-holmes-primary-light transition-colors hover:bg-holmes-primary/30 hover:text-white"
              >
                <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-base">{message.content}</div>
        )}
      </div>

      {!isEditing && (
        <MessageToolbar
          copyText={message.content}
          createdAt={message.createdAt}
          align="right"
          target={message}
          turnInFlight={turnInFlight}
          onEdit={onEdit ? startEdit : undefined}
          onRetry={onRetry}
          onSetActiveBranch={onSetActiveBranch}
        />
      )}
    </div>
  )
}
