// The ElevenLabs client.
//
// Only the endpoints this feature needs: list voices, read the character quota,
// and synthesize speech WITH per-character timestamps. The timestamps are the
// whole point — plain speech would be a much smaller feature.
import type { SpeechKeyResult, SpeechModel, SpeechQuota, SpeechVoice } from '../../shared/types'
import { buildWordTimings, type CharacterAlignment } from '../../shared/audiobookTiming'
import { clearSpeechKey, getSpeechKey, setSpeechKey } from '../keychain'
import {
  emptyTimings,
  readProviderError,
  SpeechError,
  type SpeechProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
} from './types'

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io'

/** mp3 at 44.1kHz/128kbps — the default paid tier format, and small enough to keep. */
const OUTPUT_FORMAT = 'mp3_44100_128'

/** Kept as an alias so existing call sites and error checks stay meaningful. */
export const ElevenLabsError = SpeechError

/**
 * The models worth offering for narration, with the per-request character caps
 * the docs publish. The cap is what forces a chapter into segments, so getting
 * it wrong means either rejected requests or needless seams.
 *
 * Hard-coded rather than read from `GET /v1/models` because that endpoint does
 * not report the caps, and a wrong cap fails the whole run.
 */
export const ELEVENLABS_MODELS: readonly SpeechModel[] = [
  {
    modelId: 'eleven_multilingual_v2',
    name: 'Multilingual v2',
    description: 'The most lifelike voice, with the richest emotional range. Best for fiction and anything read closely.',
    maxCharacters: 10_000,
    costMultiplier: 1,
    canStitch: true,
  },
  {
    modelId: 'eleven_turbo_v2_5',
    name: 'Turbo v2.5',
    description: 'Close to Multilingual v2 at half the credits. A good default for non-fiction.',
    maxCharacters: 40_000,
    costMultiplier: 0.5,
    canStitch: true,
  },
  {
    modelId: 'eleven_flash_v2_5',
    name: 'Flash v2.5',
    description: 'Cheapest and fastest, noticeably flatter. Fine for reference material you are skimming by ear.',
    maxCharacters: 40_000,
    costMultiplier: 0.5,
    canStitch: true,
  },
] as const

export function findModel(modelId: string): SpeechModel {
  const model = ELEVENLABS_MODELS.find((entry) => entry.modelId === modelId)
  if (!model) throw new SpeechError(`Unknown narration model: ${modelId}`)
  return model
}

export const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'

async function requireKey(): Promise<string> {
  const key = await getSpeechKey('elevenlabs')
  if (!key?.trim()) {
    throw new SpeechError('No ElevenLabs API key is set. Add one to generate narration with ElevenLabs.')
  }
  return key.trim()
}

export async function hasElevenLabsKey(): Promise<boolean> {
  const key = await getSpeechKey('elevenlabs')
  return Boolean(key?.trim())
}

async function callJson<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ELEVENLABS_BASE_URL}${path}`, {
    ...init,
    headers: { 'xi-api-key': key, ...(init?.headers ?? {}) },
  })
  if (!response.ok) throw new SpeechError(await readProviderError(response, 'ElevenLabs'), response.status)
  return (await response.json()) as T
}

export async function listVoices(): Promise<SpeechVoice[]> {
  const key = await requireKey()
  const data = await callJson<{ voices?: unknown[] }>('/v1/voices', key)
  const voices = Array.isArray(data.voices) ? data.voices : []
  return voices
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>
      const labels: Record<string, string> = {}
      if (record.labels && typeof record.labels === 'object') {
        for (const [label, value] of Object.entries(record.labels as Record<string, unknown>)) {
          if (typeof value === 'string') labels[label] = value
        }
      }
      return {
        voiceId: typeof record.voice_id === 'string' ? record.voice_id : '',
        name: typeof record.name === 'string' ? record.name : 'Unnamed voice',
        category: typeof record.category === 'string' ? record.category : 'generated',
        description: typeof record.description === 'string' && record.description.trim() ? record.description : null,
        labels,
        previewUrl: typeof record.preview_url === 'string' ? record.preview_url : null,
      }
    })
    .filter((voice) => voice.voiceId)
}

/**
 * The character allowance left on the key.
 *
 * Best-effort: a key scoped without user permissions can synthesize but cannot
 * read this, and that must not block generating. Callers get null and the UI
 * says the allowance is unknown rather than inventing one.
 */
export async function getQuota(): Promise<SpeechQuota | null> {
  try {
    const key = await requireKey()
    const data = await callJson<Record<string, unknown>>('/v1/user/subscription', key)
    const used = typeof data.character_count === 'number' ? data.character_count : 0
    const limit = typeof data.character_limit === 'number' ? data.character_limit : 0
    const resetUnix = typeof data.next_character_count_reset_unix === 'number'
      ? data.next_character_count_reset_unix
      : null
    return {
      tier: typeof data.tier === 'string' ? data.tier : 'unknown',
      characterCount: used,
      characterLimit: limit,
      nextResetAt: resetUnix ? new Date(resetUnix * 1000).toISOString() : null,
    }
  } catch {
    return null
  }
}

export interface SynthesisRequest {
  text: string
  voiceId: string
  modelId: string
  /**
   * Ids of up to 3 already-completed requests from this same chapter. This is
   * ElevenLabs' request stitching: it conditions the new audio on what came
   * before, which is what stops each segment restarting the narrator's prosody
   * from cold. `previous_text` is ignored when these are supplied.
   */
  previousRequestIds?: string[]
  /** Sent when there are no request ids yet — same purpose, weaker effect. */
  previousText?: string
  nextText?: string
  signal?: AbortSignal
}

export interface SynthesisResult {
  audio: Buffer
  alignment: CharacterAlignment | null
  /** Needed to stitch the NEXT segment onto this one. */
  requestId: string | null
}

/**
 * One synthesis call, returning audio and the character alignment together.
 *
 * `alignment` (not `normalized_alignment`) is the one used: it describes the
 * text as it was SENT, so index i is canonical offset charStart + i. The
 * normalized variant describes text after number- and abbreviation-expansion,
 * whose characters have no position in the book at all.
 */
export async function synthesizeWithTimestamps(request: SynthesisRequest): Promise<SynthesisResult> {
  const key = await requireKey()
  const model = findModel(request.modelId)

  if (request.text.length > model.maxCharacters) {
    throw new SpeechError(
      `That passage is ${request.text.length} characters, over ${model.name}'s ${model.maxCharacters} limit.`
    )
  }

  const body: Record<string, unknown> = {
    text: request.text,
    model_id: request.modelId,
  }
  const stitchIds = (request.previousRequestIds ?? []).filter(Boolean).slice(-3)
  if (model.canStitch && stitchIds.length > 0) {
    body.previous_request_ids = stitchIds
  } else if (request.previousText) {
    body.previous_text = request.previousText
  }
  if (request.nextText) body.next_text = request.nextText

  const response = await fetch(
    `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal as never,
    }
  )
  if (!response.ok) throw new SpeechError(await readProviderError(response, 'ElevenLabs'), response.status)

  const payload = (await response.json()) as {
    audio_base64?: unknown
    alignment?: CharacterAlignment | null
  }
  if (typeof payload.audio_base64 !== 'string' || !payload.audio_base64) {
    throw new SpeechError('ElevenLabs returned no audio for that passage')
  }

  return {
    audio: Buffer.from(payload.audio_base64, 'base64'),
    alignment: payload.alignment ?? null,
    // Stitching needs the id of a request that has completed — which, since this
    // is the non-streaming endpoint, this one has by the time we read it.
    requestId: response.headers.get('request-id') ?? response.headers.get('x-request-id'),
  }
}

/** Verifies a key before it is stored, so a typo is caught at paste time. */
export async function verifyKey(key: string): Promise<SpeechKeyResult> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, message: 'Paste a key first', quota: null }
  try {
    const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/user/subscription`, {
      headers: { 'xi-api-key': trimmed },
    })
    if (!response.ok) {
      // A key that cannot read the subscription may still synthesize, so this is
      // reported as a caveat rather than as a rejection.
      if (response.status === 401) return { ok: false, message: 'That key was rejected', quota: null }
      return { ok: true, message: 'Key accepted, but its allowance could not be read', quota: null }
    }
    const data = (await response.json()) as Record<string, unknown>
    const used = typeof data.character_count === 'number' ? data.character_count : 0
    const limit = typeof data.character_limit === 'number' ? data.character_limit : 0
    const resetUnix = typeof data.next_character_count_reset_unix === 'number'
      ? data.next_character_count_reset_unix
      : null
    return {
      ok: true,
      message: `Connected — ${(limit - used).toLocaleString()} characters left`,
      quota: {
        tier: typeof data.tier === 'string' ? data.tier : 'unknown',
        characterCount: used,
        characterLimit: limit,
        nextResetAt: resetUnix ? new Date(resetUnix * 1000).toISOString() : null,
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Could not reach ElevenLabs', quota: null }
  }
}

export const elevenLabsProvider: SpeechProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  baseUrl: ELEVENLABS_BASE_URL,
  keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
  keyHint: 'starts with sk_',
  supportsStitching: true,

  models: () => ELEVENLABS_MODELS,
  defaultModelId: () => DEFAULT_MODEL_ID,
  hasKey: hasElevenLabsKey,
  setKey: async (key: string) => { await setSpeechKey('elevenlabs', key.trim()) },
  clearKey: async () => { await clearSpeechKey('elevenlabs') },
  verifyKey,
  listVoices,
  getQuota,

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const result = await synthesizeWithTimestamps({
      text: request.text,
      voiceId: request.voiceId,
      modelId: request.modelId,
      previousRequestIds: request.previousRequestIds,
      previousText: request.previousText,
      nextText: request.nextText,
      signal: request.signal,
    })

    const timings = result.alignment
      ? buildWordTimings({ alignment: result.alignment, charStart: request.charStart, text: request.text })
      : { words: emptyTimings(), durationSeconds: 0, mismatched: true }

    return {
      audio: result.audio,
      mimeType: 'audio/mpeg',
      // A mismatched alignment would highlight the wrong words, which is worse
      // than highlighting none — the audio is kept and still plays.
      words: timings.mismatched ? emptyTimings() : timings.words,
      durationSeconds: timings.durationSeconds,
      requestId: result.requestId,
      // ElevenLabs does not report what it billed; the text length is what it
      // charges on, and the caller already knows that.
      billedCharacters: request.text.length,
      mismatched: timings.mismatched,
      droppedWords: 0,
    }
  },
}
