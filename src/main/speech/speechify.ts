// Speechify narration.
//
// Three differences from ElevenLabs drive everything here:
//
//  1. Timings come back per WORD (speech marks), not per character.
//  2. Times are MILLISECONDS. Mixing the two units would put the highlight a
//     thousand times out, so the conversion happens once, on the way in.
//  3. Offsets index the SSML-ESCAPED input. A single `&` early in a chapter
//     shifts every later offset by four characters, so the escaping is done here
//     and the map back is kept rather than assumed away.
import type { SpeechKeyResult, SpeechModel, SpeechQuota, SpeechVoice } from '../../shared/types'
import {
  buildWordTimingsFromSpeechMarks,
  escapeForSsml,
  type SpeechMarks,
} from '../../shared/audiobookTiming'
import { clearSpeechKey, getSpeechKey, setSpeechKey } from '../keychain'
import {
  emptyTimings,
  readProviderError,
  SpeechError,
  type SpeechProvider,
  type SpeechSynthesisRequest,
  type SpeechSynthesisResult,
} from './types'

export const SPEECHIFY_BASE_URL = 'https://api.speechify.ai'

/**
 * Caps are not published per model the way ElevenLabs' are, so this is a
 * conservative single budget. Being under the real limit costs an extra seam;
 * being over fails the request outright.
 */
const SPEECHIFY_MAX_CHARACTERS = 8_000

const MODELS: readonly SpeechModel[] = [
  {
    modelId: 'simba-english',
    name: 'Simba English',
    description: 'The default English voice model. Natural and even, well suited to long narration.',
    maxCharacters: SPEECHIFY_MAX_CHARACTERS,
    costMultiplier: 1,
    canStitch: false,
  },
  {
    modelId: 'simba-multilingual',
    name: 'Simba Multilingual',
    description: 'Use for books that are not in English, or that quote other languages at length.',
    maxCharacters: SPEECHIFY_MAX_CHARACTERS,
    costMultiplier: 1,
    canStitch: false,
  },
  {
    modelId: 'simba-turbo',
    name: 'Simba Turbo',
    description: 'Faster and cheaper, with less expression. Fine for reference material.',
    maxCharacters: SPEECHIFY_MAX_CHARACTERS,
    costMultiplier: 0.5,
    canStitch: false,
  },
] as const

async function requireKey(): Promise<string> {
  const key = await getSpeechKey('speechify')
  if (!key?.trim()) {
    throw new SpeechError('No Speechify API key is set. Add one to generate narration with Speechify.')
  }
  return key.trim()
}

function authHeaders(key: string): Record<string, string> {
  // Bearer, unlike ElevenLabs' xi-api-key header.
  return { Authorization: `Bearer ${key}` }
}

function mapVoice(entry: unknown): SpeechVoice | null {
  const record = (entry ?? {}) as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : typeof record.voice_id === 'string' ? record.voice_id : ''
  if (!id) return null
  const labels: Record<string, string> = {}
  for (const field of ['gender', 'locale', 'type']) {
    const value = record[field]
    if (typeof value === 'string') labels[field] = value
  }
  // Voices carry their supported models as a nested list; surfacing the first
  // locale is enough for the picker to be legible.
  const models = Array.isArray(record.models) ? record.models : []
  const firstLocale = models
    .flatMap((model) => (Array.isArray((model as { languages?: unknown[] })?.languages) ? (model as { languages: unknown[] }).languages : []))
    .map((language) => (language as { locale?: unknown })?.locale)
    .find((locale): locale is string => typeof locale === 'string')
  if (firstLocale && !labels.locale) labels.locale = firstLocale

  return {
    voiceId: id,
    name: typeof record.display_name === 'string' && record.display_name.trim()
      ? record.display_name
      : typeof record.name === 'string' ? record.name : id,
    category: typeof record.type === 'string' ? record.type : 'shared',
    description: typeof record.description === 'string' && record.description.trim() ? record.description : null,
    labels,
    previewUrl: typeof record.preview_audio === 'string' ? record.preview_audio : null,
  }
}

export const speechifyProvider: SpeechProvider = {
  id: 'speechify',
  label: 'Speechify',
  baseUrl: SPEECHIFY_BASE_URL,
  keyUrl: 'https://console.sws.speechify.com/api',
  keyHint: 'Bearer token from the Speechify API console',
  // Speechify has no request-stitching equivalent, so a seam restarts prosody.
  // Chunking on paragraph boundaries is what keeps that from being audible.
  supportsStitching: false,

  models: () => MODELS,
  defaultModelId: () => 'simba-english',

  async hasKey() {
    const key = await getSpeechKey('speechify')
    return Boolean(key?.trim())
  },

  async setKey(key) { await setSpeechKey('speechify', key.trim()) },
  async clearKey() { await clearSpeechKey('speechify') },

  async verifyKey(key) {
    const trimmed = key.trim()
    if (!trimmed) return { ok: false, message: 'Paste a key first', quota: null }
    try {
      const response = await fetch(`${SPEECHIFY_BASE_URL}/v1/voices`, { headers: authHeaders(trimmed) })
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: 'That key was rejected', quota: null }
      }
      if (!response.ok) {
        return { ok: false, message: await readProviderError(response, 'Speechify'), quota: null }
      }
      const voices = (await response.json()) as unknown[]
      const count = Array.isArray(voices) ? voices.length : 0
      return { ok: true, message: `Connected — ${count} voice${count === 1 ? '' : 's'} available`, quota: null }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not reach Speechify',
        quota: null,
      }
    }
  },

  async listVoices() {
    const key = await requireKey()
    const response = await fetch(`${SPEECHIFY_BASE_URL}/v1/voices`, { headers: authHeaders(key) })
    if (!response.ok) throw new SpeechError(await readProviderError(response, 'Speechify'), response.status)
    const payload = (await response.json()) as unknown
    const entries = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { voices?: unknown[] })?.voices)
        ? (payload as { voices: unknown[] }).voices
        : []
    return entries.map(mapVoice).filter((voice): voice is SpeechVoice => voice !== null)
  },

  /**
   * Speechify bills per character but publishes no allowance endpoint that is
   * safe to rely on here, so the UI is told the allowance is unknown rather than
   * being shown a number that might be wrong.
   */
  async getQuota(): Promise<SpeechQuota | null> {
    return null
  },

  async synthesize(request: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const key = await requireKey()
    if (request.text.length > SPEECHIFY_MAX_CHARACTERS) {
      throw new SpeechError(
        `That passage is ${request.text.length} characters, over Speechify's ${SPEECHIFY_MAX_CHARACTERS} limit.`
      )
    }

    // Escape here so we know exactly what coordinate space the returned offsets
    // are in, instead of inferring it from whatever the service did to our text.
    const escaped = escapeForSsml(request.text)

    const response = await fetch(`${SPEECHIFY_BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: escaped.text,
        voice_id: request.voiceId,
        model: request.modelId,
        audio_format: 'mp3',
        // Text normalization rewrites numbers and abbreviations, which moves the
        // offsets away from our text. Off, so the marks describe what we sent.
        options: { text_normalization: false },
      }),
      signal: request.signal as never,
    })
    if (!response.ok) throw new SpeechError(await readProviderError(response, 'Speechify'), response.status)

    const payload = (await response.json()) as {
      audio_data?: unknown
      audio_format?: unknown
      billable_characters_count?: unknown
      speech_marks?: SpeechMarks | null
    }
    if (typeof payload.audio_data !== 'string' || !payload.audio_data) {
      throw new SpeechError('Speechify returned no audio for that passage')
    }

    const format = typeof payload.audio_format === 'string' ? payload.audio_format : 'mp3'
    const timings = payload.speech_marks
      ? buildWordTimingsFromSpeechMarks({
          marks: payload.speech_marks,
          charStart: request.charStart,
          text: request.text,
          escaped,
        })
      : { words: emptyTimings(), durationSeconds: 0, droppedWords: 0, mismatched: true }

    return {
      audio: Buffer.from(payload.audio_data, 'base64'),
      mimeType: format === 'mp3' ? 'audio/mpeg' : format === 'wav' ? 'audio/wav' : `audio/${format}`,
      words: timings.mismatched ? emptyTimings() : timings.words,
      durationSeconds: timings.durationSeconds,
      // No stitching, so nothing to carry forward.
      requestId: null,
      billedCharacters:
        typeof payload.billable_characters_count === 'number' ? payload.billable_characters_count : null,
      mismatched: timings.mismatched,
      droppedWords: timings.droppedWords,
    }
  },
}
