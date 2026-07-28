// The contract every narration service implements.
//
// The two services report timing very differently — ElevenLabs gives one entry
// per CHARACTER in seconds against the text as sent; Speechify gives one per
// WORD in milliseconds against the SSML-escaped text — so the normalization has
// to live inside each provider, where the details are known. What comes out is
// always the same thing: word spans in ABSOLUTE canonical offsets, which is the
// coordinate space the reader, annotations and lesson citations already share.
import type {
  AudiobookWordTimings,
  SpeechKeyResult,
  SpeechModel,
  SpeechProviderId,
  SpeechQuota,
  SpeechVoice,
} from '../../shared/types'

export interface SpeechSynthesisRequest {
  text: string
  /** Absolute canonical offset of `text`, so returned spans index the book. */
  charStart: number
  voiceId: string
  modelId: string
  /**
   * Ids of already-completed requests for this chapter, most recent last.
   * Providers that support request stitching use them to carry prosody across a
   * seam; the rest ignore them.
   */
  previousRequestIds?: string[]
  previousText?: string
  nextText?: string
  signal?: AbortSignal
}

export interface SpeechSynthesisResult {
  audio: Buffer
  mimeType: string
  /** Word spans in absolute canonical offsets, times relative to this audio. */
  words: AudiobookWordTimings
  /**
   * Length of this audio. Both services report timings that can stop short of
   * the real end (trailing silence), so this is a floor, and the player refines
   * it from the decoded file.
   */
  durationSeconds: number
  /** For stitching the next segment onto this one, when supported. */
  requestId: string | null
  /** What the provider says it billed, when it says. */
  billedCharacters: number | null
  /**
   * True when the timing data did not line up with the text we sent. The audio
   * is still good; the highlighting is dropped rather than pointed at the wrong
   * words.
   */
  mismatched: boolean
  /** Words whose reported position could not be trusted and were discarded. */
  droppedWords: number
}

export interface SpeechProvider {
  readonly id: SpeechProviderId
  readonly label: string
  /** Used by the call logger to recognise this service's traffic. */
  readonly baseUrl: string
  readonly keyUrl: string
  readonly keyHint: string
  /** Whether a seam can be conditioned on the previous request. */
  readonly supportsStitching: boolean

  models(): readonly SpeechModel[]
  defaultModelId(): string
  hasKey(): Promise<boolean>
  setKey(key: string): Promise<void>
  clearKey(): Promise<void>
  verifyKey(key: string): Promise<SpeechKeyResult>
  listVoices(): Promise<SpeechVoice[]>
  getQuota(): Promise<SpeechQuota | null>
  synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>
}

export class SpeechError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

export function emptyTimings(): AudiobookWordTimings {
  return { charStart: [], charEnd: [], startSeconds: [], endSeconds: [] }
}

/** Reads a provider's error body, which is JSON of no agreed shape. */
export async function readProviderError(response: Response, label: string): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body) return `${label} returned HTTP ${response.status}`
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const detail = parsed.detail ?? parsed.error ?? parsed.message
    if (typeof detail === 'string') return detail
    if (detail && typeof detail === 'object') {
      const message = (detail as { message?: unknown }).message
      if (typeof message === 'string') return message
      const status = (detail as { status?: unknown }).status
      if (typeof status === 'string') return status
    }
  } catch {
    // Not JSON; the raw body says more than a bare status code.
  }
  return body.slice(0, 300)
}
