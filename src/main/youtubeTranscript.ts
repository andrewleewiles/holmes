// Fetching a video's auto-generated captions.
//
// There is no official way to do this. `captions.download` in the Data API
// requires OAuth as the video's OWNER, so it can never read a stranger's
// captions, and the internal timedtext endpoint is undocumented and actively
// being broken. yt-dlp tracks those changes for a living, so the app shells out
// to it — the same shape as the `sips` calls in photoContext.ts and the Swift
// sidecar: an external tool invoked with execFile, never a new npm dependency.
//
// THE LANGUAGE MUST BE PINNED. Asking for "en.*" matches the ~32 machine
// translations YouTube offers alongside the real track, yt-dlp then requests
// them one after another, and the burst comes back 429 Too Many Requests with
// nothing downloaded. `en-orig,en` is the auto-generated original plus the
// cleaned English track, and it succeeds where the wildcard fails.

import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createHash } from 'node:crypto'
import { parseVtt, type TranscriptCue } from '../shared/playFeed'

const execFileAsync = promisify(execFile)

/** Where a Homebrew install puts it, plus whatever is on PATH. */
const YTDLP_CANDIDATES = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp']

const FETCH_TIMEOUT_MS = 90_000
/** A feature-length transcript is well under this; anything more is not one. */
const MAX_VTT_BYTES = 4_000_000

let resolvedBinary: string | null | undefined

/**
 * The yt-dlp binary, or null when it is not installed.
 *
 * Cached because it is asked for once per video in a build. A null result is
 * cached too: twelve failed spawns per refresh is pure latency, and the answer
 * cannot change while the app is running in any way worth chasing.
 */
export async function findYtDlp(): Promise<string | null> {
  if (resolvedBinary !== undefined) return resolvedBinary
  for (const candidate of YTDLP_CANDIDATES) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 10_000 })
      resolvedBinary = candidate
      return candidate
    } catch {
      // Not at this path, or not executable. Try the next.
    }
  }
  resolvedBinary = null
  return null
}

export function resetYtDlpCacheForTests(): void {
  resolvedBinary = undefined
}

export interface TranscriptResult {
  cues: TranscriptCue[]
  language: string
  /** Identity of the caption text, so an unchanged transcript is not re-analysed. */
  hash: string
}

export class TranscriptUnavailableError extends Error {
  readonly reason: 'no-tool' | 'no-captions' | 'failed'

  constructor(reason: 'no-tool' | 'no-captions' | 'failed', message: string) {
    super(message)
    this.name = 'TranscriptUnavailableError'
    this.reason = reason
  }
}

/**
 * Picks the best of whatever landed in the temp directory.
 *
 * `en-orig` is the true auto-generated track — what was actually said. Plain
 * `en` may be a machine translation of it back into English on a foreign-language
 * video, so it is the fallback rather than the first choice.
 */
function pickCaptionFile(directory: string): { filePath: string; language: string } | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(directory).filter((name) => name.endsWith('.vtt'))
  } catch {
    return null
  }
  if (entries.length === 0) return null

  const byPreference = (name: string): number => {
    if (name.includes('.en-orig.')) return 0
    if (name.includes('.en.')) return 1
    return 2
  }
  entries.sort((left, right) => byPreference(left) - byPreference(right))

  const chosen = entries[0]!
  const language = /\.([a-z]{2}(?:-[A-Za-z]+)?)\.vtt$/.exec(chosen)?.[1] ?? 'en'
  return { filePath: path.join(directory, chosen), language }
}

/**
 * Downloads and parses one video's captions.
 *
 * Nothing about the video itself is fetched — `--skip-download` means only the
 * caption file crosses the wire, which is why this costs a few hundred KB per
 * video rather than hundreds of megabytes.
 */
export async function fetchTranscript(videoId: string, signal?: AbortSignal): Promise<TranscriptResult> {
  const binary = await findYtDlp()
  if (!binary) {
    throw new TranscriptUnavailableError(
      'no-tool',
      'yt-dlp is not installed. Install it with `brew install yt-dlp` to analyse transcripts.'
    )
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-transcript-'))
  try {
    await execFileAsync(
      binary,
      [
        '--skip-download',
        '--write-auto-subs',
        '--write-subs',
        // Pinned, never a wildcard. See the note at the top of this file.
        '--sub-langs',
        'en-orig,en',
        '--sub-format',
        'vtt',
        '--no-playlist',
        '--no-warnings',
        '-o',
        path.join(directory, 'cc.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: FETCH_TIMEOUT_MS, signal, maxBuffer: 8 * 1024 * 1024 }
    )

    const picked = pickCaptionFile(directory)
    if (!picked) {
      throw new TranscriptUnavailableError('no-captions', 'This video has no captions to analyse.')
    }

    const stat = fs.statSync(picked.filePath)
    if (stat.size > MAX_VTT_BYTES) {
      throw new TranscriptUnavailableError('failed', 'The caption file was unexpectedly large.')
    }

    const raw = fs.readFileSync(picked.filePath, 'utf8')
    const cues = parseVtt(raw)
    if (cues.length === 0) {
      throw new TranscriptUnavailableError('no-captions', 'The captions for this video were empty.')
    }

    return {
      cues,
      language: picked.language,
      // Hashed from the PARSED text, not the raw file: YouTube re-times captions
      // without changing a word, and a raw hash would re-pay for the analysis
      // every time it did.
      hash: createHash('sha256')
        .update(cues.map((cue) => cue.text).join('\n'))
        .digest('hex')
        .slice(0, 32),
    }
  } catch (error) {
    if (error instanceof TranscriptUnavailableError) throw error
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : 'Could not fetch captions.'
    // yt-dlp says so in plain words when a video simply has none.
    if (/no subtitles|requested format|unavailable|private video|members-only/i.test(message)) {
      throw new TranscriptUnavailableError('no-captions', 'This video has no captions to analyse.')
    }
    throw new TranscriptUnavailableError('failed', message.replace(/\s+/g, ' ').slice(0, 300))
  } finally {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch {
      // A temp directory that will not delete is not worth failing a build over.
    }
  }
}
