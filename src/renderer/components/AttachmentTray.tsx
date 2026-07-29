import type { FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faFilm, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment } from '@shared/types'
import { formatAttachmentSize } from '@shared/attachments'

interface AttachmentTrayProps {
  attachments: ChatAttachment[]
  error: string | null
  onRemove: (id: string) => void
  onDismissError: () => void
}

/** The staged attachments above a message box, shared by both input surfaces. */
export const AttachmentTray: FC<AttachmentTrayProps> = ({ attachments, error, onRemove, onDismissError }) => (
  <>
    {attachments.length > 0 && (
      <div className="mb-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <div
            key={attachment.id}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 pl-2 pr-1 py-1 text-xs text-white/70"
          >
            {attachment.kind === 'image' ? (
              <img
                src={attachment.dataUrl}
                alt=""
                className="w-6 h-6 rounded object-cover border border-white/10"
              />
            ) : (
              <span className="flex w-6 h-6 items-center justify-center rounded bg-white/10 text-white/50">
                <FontAwesomeIcon icon={faFilm} className="w-3 h-3" />
              </span>
            )}
            <span className="max-w-[180px] truncate">{attachment.name}</span>
            <span className="text-white/30 font-mono text-[10px]">{formatAttachmentSize(attachment.bytes)}</span>
            <button
              onClick={() => onRemove(attachment.id)}
              aria-label={`Remove ${attachment.name}`}
              className="px-1 py-0.5 rounded text-white/30 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <FontAwesomeIcon icon={faXmark} className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    )}

    {error && (
      <div className="mb-2 flex items-start gap-2 rounded-lg border border-holmes-error-border bg-holmes-error-bg px-3 py-2 text-xs text-red-300">
        <span className="flex-1">{error}</span>
        <button onClick={onDismissError} className="text-red-300 hover:text-white cursor-pointer">
          ×
        </button>
      </div>
    )}
  </>
)
