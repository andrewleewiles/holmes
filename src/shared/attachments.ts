import type { ChatAttachment, ChatAttachmentKind } from './types'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const MAX_ATTACHMENTS_PER_MESSAGE = 6

export const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
}

export const VIDEO_EXTENSIONS: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
}

export function getAttachmentExtension(name: string): string {
  const parts = name.toLowerCase().split('.')
  return parts.length > 1 ? parts[parts.length - 1] : ''
}

export function classifyAttachment(name: string): { kind: ChatAttachmentKind; mimeType: string } | null {
  const ext = getAttachmentExtension(name)
  if (!ext) return null
  if (IMAGE_EXTENSIONS[ext]) return { kind: 'image', mimeType: IMAGE_EXTENSIONS[ext] }
  if (VIDEO_EXTENSIONS[ext]) return { kind: 'video', mimeType: VIDEO_EXTENSIONS[ext] }
  return null
}

/**
 * Pasted files often arrive without a usable name — a screenshot off the
 * clipboard is just `image.png`, and some sources hand over no name at all —
 * so the MIME type the clipboard reports is the only thing left to classify by.
 */
export function classifyAttachmentMimeType(mimeType: string): { kind: ChatAttachmentKind; mimeType: string } | null {
  const normalized = mimeType.toLowerCase().split(';')[0].trim()
  if (!normalized) return null
  if (Object.values(IMAGE_EXTENSIONS).includes(normalized)) return { kind: 'image', mimeType: normalized }
  if (Object.values(VIDEO_EXTENSIONS).includes(normalized)) return { kind: 'video', mimeType: normalized }
  return null
}

/** The canonical extension for a supported MIME type, for naming unnamed pastes. */
export function extensionForMimeType(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase().split(';')[0].trim()
  for (const [ext, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (mime === normalized) return ext
  }
  for (const [ext, mime] of Object.entries(VIDEO_EXTENSIONS)) {
    if (mime === normalized) return ext
  }
  return null
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function isValidAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ChatAttachment>
  if (candidate.kind !== 'image' && candidate.kind !== 'video') return false
  if (typeof candidate.id !== 'string' || !candidate.id) return false
  if (typeof candidate.name !== 'string' || !candidate.name) return false
  if (typeof candidate.mimeType !== 'string' || !candidate.mimeType) return false
  if (typeof candidate.dataUrl !== 'string' || !candidate.dataUrl.startsWith('data:')) return false
  if (typeof candidate.bytes !== 'number' || !Number.isFinite(candidate.bytes) || candidate.bytes < 0) return false
  if (candidate.bytes > MAX_ATTACHMENT_BYTES) return false
  if (candidate.origin !== 'user' && candidate.origin !== 'generated') return false
  return true
}

export function parseAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isValidAttachment)
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    .map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name.slice(0, 200),
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
      dataUrl: attachment.dataUrl,
      origin: attachment.origin,
    }))
}
