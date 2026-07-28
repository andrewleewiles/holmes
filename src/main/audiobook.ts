// Generating narration for one chapter, and serving it back with its timings.
//
// The shape of the work: take the chapter's slice of the book's canonical text,
// split it to fit the model's per-request cap, synthesize each piece with
// character timestamps, write the audio to disk, and store word spans in
// absolute canonical offsets.
//
// Segments are kept as separate files rather than concatenated. Joining MP3s
// byte-wise leaves encoder padding between frames, and re-encoding would shift
// the audio out of step with the timings ElevenLabs measured against it — so the
// player sequences the files instead, which keeps every timestamp exactly as
// reported.
import fs from 'fs'
import path from 'path'
import type {
  Audiobook,
  AudiobookChapter,
  AudiobookEstimate,
  AudiobookProgress,
  AudiobookSegment,
  SpeechProviderId,
} from '../shared/types'
import { splitForSynthesis } from '../shared/audiobookTiming'
import * as database from './database'
import { getCanonicalText } from './library'
import { DEFAULT_SPEECH_PROVIDER, getSpeechProvider, SpeechError } from './speech'
import { clearChapterAudio, segmentDirectory, segmentUrl } from './audioProtocol'

/**
 * Headroom under the model's published cap. The cap counts characters as
 * ElevenLabs does, which need not be exactly `String.length` for text outside
 * the BMP, and a rejected request wastes the whole segment.
 */
const CAP_HEADROOM = 0.95
/** How much neighbouring text to send as prosody context on the first segment. */
const STITCH_TEXT_CHARS = 400
/** Rough narration rate, for the pre-flight time estimate only. */
const CHARS_PER_SECOND = 14

export class AudiobookError extends Error {}

export type AudiobookProgressSender = (progress: AudiobookProgress) => void

function chapterTitle(bookId: string, chapterIndex: number): string {
  const chapter = database.listBookChapters(bookId)[chapterIndex]
  return chapter?.title ?? `Chapter ${chapterIndex + 1}`
}

/** What a chapter would cost, in the only unit ElevenLabs actually bills in. */
export async function estimateAudiobook(
  bookId: string,
  chapterIndex: number,
  providerId: SpeechProviderId = DEFAULT_SPEECH_PROVIDER,
  modelId?: string
): Promise<AudiobookEstimate> {
  const book = database.getBookById(bookId)
  if (!book) throw new AudiobookError('That book is no longer on the shelf')

  const provider = getSpeechProvider(providerId)
  const resolvedModelId = modelId ?? provider.defaultModelId()
  const model = provider.models().find((entry) => entry.modelId === resolvedModelId)
  if (!model) throw new AudiobookError(`${provider.label} has no model called ${resolvedModelId}`)

  const { text } = await getCanonicalText(bookId, chapterIndex, chapterIndex)
  const budget = Math.floor(model.maxCharacters * CAP_HEADROOM)
  const segments = splitForSynthesis(text, budget)
  const quota = await provider.getQuota()
  const existing = database.getAudiobook(bookId, chapterIndex)

  return {
    bookId,
    chapterIndex,
    chapterTitle: chapterTitle(bookId, chapterIndex),
    characterCount: text.length,
    segmentCount: segments.length,
    provider: providerId,
    modelId: resolvedModelId,
    quota,
    // Characters are billed against the plan's allowance; a run that would
    // overrun it should say so before spending any of it.
    exceedsQuota: quota !== null && text.length > Math.max(0, quota.characterLimit - quota.characterCount),
    estimatedSeconds: Math.round(text.length / CHARS_PER_SECOND),
    alreadyGenerated:
      existing?.status === 'ready' &&
      existing.textHash === book.textHash &&
      existing.provider === providerId &&
      existing.modelId === resolvedModelId,
  }
}

export interface GenerateAudiobookOptions {
  providerId: SpeechProviderId
  voiceId: string
  voiceName: string
  modelId: string
  signal?: AbortSignal
  sendProgress?: AudiobookProgressSender
  /** Regenerate even when ready narration already matches this text. */
  force?: boolean
}

export async function generateAudiobook(
  bookId: string,
  chapterIndex: number,
  options: GenerateAudiobookOptions
): Promise<AudiobookChapter> {
  const book = database.getBookById(bookId)
  if (!book) throw new AudiobookError('That book is no longer on the shelf')
  if (book.status !== 'ready') throw new AudiobookError(book.scanError ?? 'This book could not be read')
  if (!options.voiceId.trim()) throw new AudiobookError('Choose a voice before generating narration')

  const provider = getSpeechProvider(options.providerId)
  const model = provider.models().find((entry) => entry.modelId === options.modelId)
  if (!model) throw new AudiobookError(`${provider.label} has no model called ${options.modelId}`)
  const chapters = database.listBookChapters(bookId)
  const chapter = chapters[chapterIndex]
  if (!chapter) throw new AudiobookError('That chapter does not exist in this book')

  const { text, charStart } = await getCanonicalText(bookId, chapterIndex, chapterIndex)
  if (!text.trim()) throw new AudiobookError('There is no readable text in that chapter')

  const existing = database.getAudiobook(bookId, chapterIndex)
  if (
    !options.force &&
    existing?.status === 'ready' &&
    existing.textHash === book.textHash &&
    existing.provider === options.providerId &&
    existing.modelId === options.modelId &&
    existing.voiceId === options.voiceId
  ) {
    return readAudiobook(bookId, chapterIndex)!
  }

  // Whole-book context for the first segment's prosody: the tail of the previous
  // chapter and the head of the next, so a chapter does not open cold.
  const whole = await getCanonicalText(bookId)
  const before = whole.text.slice(Math.max(0, charStart - STITCH_TEXT_CHARS), charStart)
  const after = whole.text.slice(chapter.charEnd, chapter.charEnd + STITCH_TEXT_CHARS)

  const budget = Math.floor(model.maxCharacters * CAP_HEADROOM)
  const pieces = splitForSynthesis(text, budget)
  if (pieces.length === 0) throw new AudiobookError('There is no readable text in that chapter')

  const record = database.upsertAudiobook({
    bookId,
    chapterIndex,
    provider: options.providerId,
    voiceId: options.voiceId,
    voiceName: options.voiceName,
    modelId: options.modelId,
    textHash: book.textHash,
    charStart,
    charEnd: chapter.charEnd,
    characterCount: text.length,
    durationSeconds: 0,
    status: 'generating',
    error: null,
  })

  // Replacing an earlier narration: drop its rows and its files, or the chapter
  // would play the old audio interleaved with the new.
  database.deleteAudiobookSegments(record.id)
  clearChapterAudio(bookId, chapterIndex)
  const directory = segmentDirectory(bookId, chapterIndex)
  fs.mkdirSync(directory, { recursive: true })

  const requestIds: string[] = []
  let offsetSeconds = 0

  try {
    for (let index = 0; index < pieces.length; index += 1) {
      if (options.signal?.aborted) throw new AudiobookError('Narration cancelled')
      const piece = pieces[index]
      options.sendProgress?.({
        phase: 'synthesizing',
        message: `Narrating part ${index + 1} of ${pieces.length}`,
        current: index,
        total: pieces.length,
        chapterIndex,
      })

      const pieceStart = charStart + piece.offset
      const result = await provider.synthesize({
        text: piece.text,
        charStart: pieceStart,
        voiceId: options.voiceId,
        modelId: options.modelId,
        previousRequestIds: requestIds,
        previousText: index === 0 ? before : undefined,
        nextText: index === pieces.length - 1 ? after : pieces[index + 1]?.text.slice(0, STITCH_TEXT_CHARS),
        signal: options.signal,
      })

      options.sendProgress?.({
        phase: 'writing',
        message: `Saving part ${index + 1} of ${pieces.length}`,
        current: index,
        total: pieces.length,
        chapterIndex,
      })

      const extension = result.mimeType === 'audio/wav' ? 'wav' : 'mp3'
      const filePath = path.join(directory, `${String(index).padStart(4, '0')}.${extension}`)
      fs.writeFileSync(filePath, result.audio)

      database.insertAudiobookSegment({
        audiobookId: record.id,
        bookId,
        segmentIndex: index,
        filePath,
        mimeType: result.mimeType,
        byteSize: result.audio.byteLength,
        charStart: pieceStart,
        charEnd: pieceStart + piece.text.length,
        durationSeconds: result.durationSeconds,
        offsetSeconds,
        requestId: result.requestId,
        words: result.words,
      })

      offsetSeconds += result.durationSeconds
      if (result.requestId) {
        requestIds.push(result.requestId)
        // Stitching accepts at most three, and the most recent are the ones that
        // matter for continuity.
        if (requestIds.length > 3) requestIds.shift()
      }
    }

    database.upsertAudiobook({
      bookId,
      chapterIndex,
      provider: options.providerId,
      voiceId: options.voiceId,
      voiceName: options.voiceName,
      modelId: options.modelId,
      textHash: book.textHash,
      charStart,
      charEnd: chapter.charEnd,
      characterCount: text.length,
      durationSeconds: offsetSeconds,
      status: 'ready',
      error: null,
    })

    options.sendProgress?.({
      phase: 'complete',
      message: 'Narration ready',
      current: pieces.length,
      total: pieces.length,
      chapterIndex,
    })

    return readAudiobook(bookId, chapterIndex)!
  } catch (error) {
    const message = error instanceof SpeechError || error instanceof AudiobookError
      ? error.message
      : error instanceof Error ? error.message : String(error)
    database.upsertAudiobook({
      bookId,
      chapterIndex,
      provider: options.providerId,
      voiceId: options.voiceId,
      voiceName: options.voiceName,
      modelId: options.modelId,
      textHash: book.textHash,
      charStart,
      charEnd: chapter.charEnd,
      characterCount: text.length,
      durationSeconds: offsetSeconds,
      status: 'failed',
      error: message,
    })
    // Segments already written are deliberately kept: a run that failed on part
    // 7 of 9 has seven parts of paid-for audio, and throwing them away would
    // charge the user twice for the same words.
    throw error instanceof Error ? error : new AudiobookError(message)
  }
}

/** One chapter's narration, ready for the player. */
export function readAudiobook(bookId: string, chapterIndex: number): AudiobookChapter | null {
  const audiobook = database.getAudiobook(bookId, chapterIndex)
  if (!audiobook) return null
  const book = database.getBookById(bookId)

  const segments: AudiobookSegment[] = database.listAudiobookSegments(audiobook.id).map((row) => ({
    id: row.id,
    segmentIndex: row.segmentIndex,
    mimeType: row.mimeType,
    charStart: row.charStart,
    charEnd: row.charEnd,
    durationSeconds: row.durationSeconds,
    offsetSeconds: row.offsetSeconds,
    url: segmentUrl(row.id),
    words: row.words,
  }))

  return {
    audiobook,
    segments,
    // The book's text moved after this was narrated, so every stored offset now
    // points somewhere slightly different. Surfaced rather than silently applied.
    stale: Boolean(book && audiobook.textHash && book.textHash !== audiobook.textHash),
  }
}

export function listBookAudiobooks(bookId: string): Audiobook[] {
  return database.listAudiobooks(bookId)
}

export function deleteChapterAudio(bookId: string, chapterIndex: number): void {
  const audiobook = database.getAudiobook(bookId, chapterIndex)
  if (!audiobook) return
  database.deleteAudiobook(audiobook.id)
  clearChapterAudio(bookId, chapterIndex)
}
