// Turning ElevenLabs' per-character alignment into word spans the reader can
// highlight, and looking those spans up at playback time.
//
// Pure and shared: main builds the spans when narration is generated, the
// renderer searches them 4-10 times a second while audio plays, and a test
// exercises both without a database or an Electron runtime.

import type { AudiobookWordTimings } from './books'

/**
 * ElevenLabs returns one entry per character of the text it was GIVEN. Because
 * the text handed to it is an exact slice of the book's canonical text, index i
 * of the alignment is canonical offset `charStart + i` — no fuzzy matching, no
 * re-alignment, and the timings land in the same coordinate space as chapters,
 * annotations and lesson citations.
 */
export interface CharacterAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

/** A character that cannot be part of a word. */
function isBoundary(character: string): boolean {
  // Anything that is not a letter, digit, apostrophe or intra-word hyphen ends a
  // word. Apostrophes stay in ("don't", "O'Brien") because splitting them would
  // flash the highlight twice inside one spoken word.
  return !/[\p{L}\p{N}'’\-]/u.test(character)
}

export interface BuildWordTimingsInput {
  alignment: CharacterAlignment
  /** Absolute canonical offset of the first aligned character. */
  charStart: number
  /**
   * The text actually sent. Used only to verify the alignment lines up with what
   * we asked for — if it does not, the timings are dropped rather than applied
   * to the wrong words.
   */
  text: string
}

export interface BuildWordTimingsResult {
  words: AudiobookWordTimings
  /** Seconds of audio this alignment accounts for. */
  durationSeconds: number
  /** True when the alignment did not correspond to the text we sent. */
  mismatched: boolean
}

export function buildWordTimings(input: BuildWordTimingsInput): BuildWordTimingsResult {
  const { alignment, charStart, text } = input
  const chars = alignment.characters ?? []
  const starts = alignment.character_start_times_seconds ?? []
  const ends = alignment.character_end_times_seconds ?? []

  const empty: AudiobookWordTimings = { charStart: [], charEnd: [], startSeconds: [], endSeconds: [] }
  if (chars.length === 0 || chars.length !== starts.length || chars.length !== ends.length) {
    return { words: empty, durationSeconds: 0, mismatched: true }
  }

  // The alignment must describe the text we sent, or every offset below is
  // pointing at the wrong place. Compared as a join rather than character by
  // character so a provider that splits a surrogate pair still passes.
  const mismatched = chars.join('') !== text

  const wordCharStart: number[] = []
  const wordCharEnd: number[] = []
  const wordStart: number[] = []
  const wordEnd: number[] = []

  let openIndex = -1
  for (let i = 0; i < chars.length; i += 1) {
    const boundary = isBoundary(chars[i])
    if (!boundary && openIndex === -1) {
      openIndex = i
    } else if (boundary && openIndex !== -1) {
      wordCharStart.push(charStart + openIndex)
      wordCharEnd.push(charStart + i)
      wordStart.push(starts[openIndex])
      // The end of the last character of the word, not of the boundary that
      // closed it — otherwise every highlight would run into the space after it.
      wordEnd.push(ends[i - 1])
      openIndex = -1
    }
  }
  if (openIndex !== -1) {
    wordCharStart.push(charStart + openIndex)
    wordCharEnd.push(charStart + chars.length)
    wordStart.push(starts[openIndex])
    wordEnd.push(ends[chars.length - 1])
  }

  const durationSeconds = ends.length > 0 ? Math.max(...ends.slice(-1), 0) : 0

  return {
    words: { charStart: wordCharStart, charEnd: wordCharEnd, startSeconds: wordStart, endSeconds: wordEnd },
    durationSeconds,
    mismatched,
  }
}

/**
 * The word being spoken at `seconds`, as an index into the parallel arrays, or
 * -1 between words.
 *
 * Binary search rather than a scan: this runs on every `timeupdate` (~4Hz) and
 * on every frame while scrubbing, over a few thousand words.
 */
export function wordIndexAt(words: AudiobookWordTimings, seconds: number): number {
  const starts = words.startSeconds
  if (starts.length === 0) return -1

  let low = 0
  let high = starts.length - 1
  let candidate = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (starts[mid] <= seconds) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (candidate === -1) return -1
  // Past the end of that word — the gap between words — is not a match, so the
  // highlight clears during a pause instead of clinging to the last word.
  return seconds <= words.endSeconds[candidate] ? candidate : -1
}

/**
 * The sentence around a canonical offset, as a [start, end) span.
 *
 * Sentence bounds are derived from the text rather than from the model, because
 * ElevenLabs reports characters and says nothing about sentences. Abbreviations
 * ("Dr.", "e.g.") will occasionally split one sentence in two, which costs a
 * slightly short tint and nothing else.
 */
export function sentenceSpanAt(
  text: string,
  textStart: number,
  offset: number
): { start: number; end: number } | null {
  const local = offset - textStart
  if (local < 0 || local >= text.length) return null

  let start = 0
  for (let i = local; i > 0; i -= 1) {
    if (/[.!?]/.test(text[i - 1]) && /\s/.test(text[i] ?? ' ')) {
      start = i
      break
    }
    if (text[i - 1] === '\n') {
      start = i
      break
    }
  }
  let end = text.length
  for (let i = local; i < text.length; i += 1) {
    if (/[.!?]/.test(text[i])) {
      end = i + 1
      break
    }
    if (text[i] === '\n') {
      end = i
      break
    }
  }
  while (start < end && /\s/.test(text[start])) start += 1
  return { start: textStart + start, end: textStart + end }
}

/**
 * Splits text for synthesis so no request exceeds the model's character cap.
 *
 * Splits on paragraph breaks first, then sentence ends, and only falls back to a
 * hard cut when a single sentence is longer than the whole budget. Never splits
 * mid-word: a seam inside a word is audible, and the two halves would be spoken
 * as two words.
 */
export function splitForSynthesis(text: string, maxCharacters: number): Array<{ text: string; offset: number }> {
  if (maxCharacters <= 0) throw new Error('A positive character budget is required')
  if (text.length <= maxCharacters) return text.trim() ? [{ text, offset: 0 }] : []

  const chunks: Array<{ text: string; offset: number }> = []
  let cursor = 0

  while (cursor < text.length) {
    const remaining = text.length - cursor
    if (remaining <= maxCharacters) {
      chunks.push({ text: text.slice(cursor), offset: cursor })
      break
    }

    const window = text.slice(cursor, cursor + maxCharacters)
    // Preference order: paragraph break, sentence end, any whitespace.
    let cut = window.lastIndexOf('\n')
    if (cut < maxCharacters * 0.5) {
      const sentence = window.search(/[^]*[.!?]["'’”]?\s/)
      if (sentence !== -1) {
        const match = window.match(/[^]*[.!?]["'’”]?\s/)
        if (match) cut = match[0].length
      }
    }
    if (cut < maxCharacters * 0.5) {
      const space = window.lastIndexOf(' ')
      if (space > 0) cut = space + 1
    }
    // A single unbroken run longer than the budget: cut it at the cap rather
    // than send an over-length request that the API would reject outright.
    if (cut <= 0) cut = maxCharacters

    chunks.push({ text: text.slice(cursor, cursor + cut), offset: cursor })
    cursor += cut
  }

  return chunks.filter((chunk) => chunk.text.trim().length > 0)
}

// --- Speechify speech marks --------------------------------------------------

/**
 * One word as Speechify reports it. Note the units and the coordinate space,
 * both of which differ from ElevenLabs: times are MILLISECONDS, and `start`/
 * `end` index the SSML-escaped input rather than the text as we wrote it.
 */
export interface SpeechMarkChunk {
  start_time: number
  end_time: number
  start: number
  end: number
  value: string
  type?: string
}

export interface SpeechMarks extends SpeechMarkChunk {
  chunks?: SpeechMarkChunk[]
}

/**
 * SSML treats `&`, `<` and `>` as markup, so they have to be escaped on the way
 * in — and Speechify then reports offsets against that escaped string. A single
 * ampersand early in a chapter shifts every later offset by four characters,
 * which would put the highlight steadily further ahead of the voice.
 *
 * So we do the escaping ourselves and keep the map back, rather than sending raw
 * text and hoping the offsets happen to line up.
 */
export interface EscapedText {
  text: string
  /** For each index in the escaped text, the index in the original. */
  toOriginal: number[]
}

export function escapeForSsml(text: string): EscapedText {
  let escaped = ''
  const toOriginal: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]
    const replacement = character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : character
    for (let j = 0; j < replacement.length; j += 1) toOriginal.push(i)
    escaped += replacement
  }
  // One past the end, so an exclusive `end` offset always has a mapping.
  toOriginal.push(text.length)
  return { text: escaped, toOriginal }
}

export interface BuildFromSpeechMarksInput {
  marks: SpeechMarks
  /** Absolute canonical offset of the ORIGINAL (unescaped) text. */
  charStart: number
  /** The original text, for verifying each mark lands where it claims. */
  text: string
  escaped: EscapedText
}

export interface BuildFromSpeechMarksResult {
  words: AudiobookWordTimings
  durationSeconds: number
  droppedWords: number
  mismatched: boolean
}

export function buildWordTimingsFromSpeechMarks(
  input: BuildFromSpeechMarksInput
): BuildFromSpeechMarksResult {
  const { marks, charStart, text, escaped } = input
  const chunks = (marks?.chunks ?? []).filter((chunk) => chunk && typeof chunk.start === 'number')
  if (chunks.length === 0) {
    return { words: { charStart: [], charEnd: [], startSeconds: [], endSeconds: [] }, durationSeconds: 0, droppedWords: 0, mismatched: true }
  }

  const wordCharStart: number[] = []
  const wordCharEnd: number[] = []
  const wordStart: number[] = []
  const wordEnd: number[] = []
  let dropped = 0

  for (const chunk of chunks) {
    // Sentence-level chunks would highlight a whole clause at once.
    if (chunk.type && chunk.type !== 'word') continue

    const from = escaped.toOriginal[chunk.start]
    const to = escaped.toOriginal[chunk.end]
    if (from === undefined || to === undefined || to <= from) { dropped += 1; continue }

    // The value is reported escaped, so compare against the escaped source —
    // this is what catches an offset that has drifted rather than trusting it.
    const claimed = escaped.text.slice(chunk.start, chunk.end)
    if (claimed !== chunk.value) { dropped += 1; continue }
    if (!text.slice(from, to).trim()) { dropped += 1; continue }

    wordCharStart.push(charStart + from)
    wordCharEnd.push(charStart + to)
    // Milliseconds in, seconds out — the player and ElevenLabs both work in
    // seconds, and mixing the two would put the highlight 1000x out.
    wordStart.push(chunk.start_time / 1000)
    wordEnd.push(chunk.end_time / 1000)
  }

  // The parent chunk spans the whole request including trailing silence, so it
  // is a better duration than the last word's end.
  const parentEnd = typeof marks.end_time === 'number' ? marks.end_time / 1000 : 0
  const lastWordEnd = wordEnd.length > 0 ? wordEnd[wordEnd.length - 1] : 0

  return {
    words: { charStart: wordCharStart, charEnd: wordCharEnd, startSeconds: wordStart, endSeconds: wordEnd },
    durationSeconds: Math.max(parentEnd, lastWordEnd),
    droppedWords: dropped,
    // Losing a word here and there to a gap is normal; losing most of them means
    // the offsets are not describing our text at all.
    mismatched: wordCharStart.length === 0 || dropped > chunks.length / 2,
  }
}
