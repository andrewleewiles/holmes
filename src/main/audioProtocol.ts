// Serving generated audiobook files to the renderer.
//
// An <audio> element needs a URL, and the app's CSP is `default-src 'self'` with
// the renderer loaded from file:// in a packaged build — so a bare file:// src is
// not reliably loadable, and a data: URL is out of the question because a chapter
// of narration is several megabytes.
//
// So: a custom scheme the main process fully controls. The URL carries an opaque
// SEGMENT ID, never a path. The handler resolves that id to a file through the
// database and refuses anything it does not recognise, which makes path traversal
// impossible by construction rather than by sanitizing a path out of a URL.
import fs from 'fs'
import path from 'path'
import { app, net, protocol } from 'electron'
import * as database from './database'

export const AUDIO_SCHEME = 'holmes-audio'
/** The only host the scheme answers on; anything else is refused. */
const AUDIO_HOST = 'segment'

/** Where generated narration lives. Outside the DB: these are megabytes each. */
export function audiobookRoot(): string {
  return path.join(app.getPath('userData'), 'audiobooks')
}

export function segmentDirectory(bookId: string, chapterIndex: number): string {
  // Book ids are uuids, so they are already safe path components; the join is
  // still built from validated pieces rather than from anything a URL carried.
  return path.join(audiobookRoot(), bookId, String(chapterIndex))
}

export function segmentUrl(segmentId: string): string {
  return `${AUDIO_SCHEME}://${AUDIO_HOST}/${segmentId}`
}

/**
 * Handed to the single registerSchemesAsPrivileged call in main.ts — a second
 * call silently strips privileges granted by the first (verified on Electron
 * 39: the earlier scheme loses its secure context), so every scheme must
 * register together. `stream: true` is what lets Chromium issue range requests
 * against the response, which is what makes seeking in a long chapter work
 * rather than forcing a full re-download on every scrub.
 */
export const AUDIO_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: AUDIO_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    // Deliberately NOT bypassCSP: the scheme is named explicitly in the
    // policy instead, so this cannot become a hole for anything else.
    bypassCSP: false,
  },
}

/** Must run AFTER app ready. */
export function installAudioProtocol(): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (url.hostname !== AUDIO_HOST) return new Response('Not found', { status: 404 })

    const segmentId = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!segmentId) return new Response('Not found', { status: 404 })

    const segment = database.getAudiobookSegmentById(segmentId)
    if (!segment) return new Response('Not found', { status: 404 })

    // The path came from our own writer, but the file can still have been
    // deleted underneath us — a missing file is a 404, never a thrown handler.
    const filePath = segment.filePath
    if (!filePath.startsWith(audiobookRoot() + path.sep) || !fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 })
    }

    // net.fetch over file:// streams the body and honours Range, so scrubbing a
    // twenty-minute chapter does not re-read it from the start each time.
    const response = await net.fetch(`file://${filePath}`, {
      headers: request.headers,
      method: request.method,
    })
    const headers = new Headers(response.headers)
    headers.set('Content-Type', 'audio/mpeg')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  })
}

/** Removes every generated file for one chapter — used when regenerating. */
export function clearChapterAudio(bookId: string, chapterIndex: number): void {
  try {
    fs.rmSync(segmentDirectory(bookId, chapterIndex), { recursive: true, force: true })
  } catch {
    // A directory that will not delete is not a reason to refuse to regenerate;
    // the new files overwrite by name anyway.
  }
}

export function clearBookAudio(bookId: string): void {
  try {
    fs.rmSync(path.join(audiobookRoot(), bookId), { recursive: true, force: true })
  } catch {
    // Same reasoning as above.
  }
}
