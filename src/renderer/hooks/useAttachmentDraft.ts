import { useCallback, useState } from 'react'
import type { ChatAttachment } from '@shared/types'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  classifyAttachment,
  classifyAttachmentMimeType,
  extensionForMimeType,
  formatAttachmentSize,
} from '@shared/attachments'

/** Two files with the same name and size are the same paste, not two attachments. */
const identity = (attachment: ChatAttachment): string => `${attachment.name}:${attachment.bytes}`

/**
 * The name is what the user sees on the chip, so a real filename wins over a
 * guess — but a clipboard image has none, and its MIME type is all we get.
 */
function classifyFile(file: File): { kind: ChatAttachment['kind']; mimeType: string } | null {
  return classifyAttachment(file.name) ?? classifyAttachmentMimeType(file.type)
}

/**
 * Built from the classified MIME rather than FileReader's data URL: the
 * clipboard can report a blank type, and a `data:;base64,` URL is one the
 * provider will reject downstream where it is far harder to explain.
 */
async function fileToDataUrl(file: File, mimeType: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

export interface AttachmentDraft {
  attachments: ChatAttachment[]
  error: string | null
  setError: (message: string | null) => void
  /** Merge already-built attachments (the file picker's route). */
  add: (incoming: ChatAttachment[]) => void
  addFiles: (files: File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  handlePaste: (event: React.ClipboardEvent) => void
}

/**
 * Shared attachment tray for the message boxes. Paste lives here rather than in
 * each input because the two boxes disagreeing about what a pasted screenshot
 * does is exactly the bug this replaces.
 */
export function useAttachmentDraft(): AttachmentDraft {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [error, setError] = useState<string | null>(null)

  const add = useCallback((incoming: ChatAttachment[]) => {
    if (incoming.length === 0) return
    setAttachments((current) => {
      const seen = new Set(current.map(identity))
      const merged = [...current]
      for (const attachment of incoming) {
        if (seen.has(identity(attachment))) continue
        if (merged.length >= MAX_ATTACHMENTS_PER_MESSAGE) break
        seen.add(identity(attachment))
        merged.push(attachment)
      }
      return merged
    })
  }, [])

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const accepted: ChatAttachment[] = []
      const problems: string[] = []
      for (const file of files) {
        const classified = classifyFile(file)
        if (!classified) {
          problems.push(`"${file.name || 'That file'}" is not a supported image or video`)
          continue
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          problems.push(
            `"${file.name || 'Pasted file'}" is ${formatAttachmentSize(file.size)}, larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit`
          )
          continue
        }
        try {
          const dataUrl = await fileToDataUrl(file, classified.mimeType)
          const extension = extensionForMimeType(classified.mimeType) ?? 'bin'
          accepted.push({
            id: crypto.randomUUID(),
            kind: classified.kind,
            name: file.name || `pasted-${classified.kind}.${extension}`,
            mimeType: classified.mimeType,
            bytes: file.size,
            dataUrl,
            origin: 'user',
          })
        } catch {
          problems.push(`Could not read "${file.name || 'the pasted file'}"`)
        }
      }
      add(accepted)
      setError(problems.length > 0 ? problems.join('. ') : null)
    },
    [add]
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length === 0) return
      // A file on the clipboard also carries its path as text on some
      // platforms; without this the path lands in the box alongside the chip.
      event.preventDefault()
      void addFiles(files)
    },
    [addFiles]
  )

  const remove = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }, [])

  const clear = useCallback(() => {
    setAttachments([])
    setError(null)
  }, [])

  return { attachments, error, setError, add, addFiles, remove, clear, handlePaste }
}
