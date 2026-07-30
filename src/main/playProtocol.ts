// Serving cached Play thumbnails to the renderer.
//
// The renderer CSP is `img-src 'self' data: blob:` and the packaged build loads
// from file://, so a remote https thumbnail cannot be rendered directly and a
// data: URL for a grid of twelve would bloat every IPC payload carrying a feed.
//
// So: a custom scheme the main process fully controls, exactly the shape of
// holmes-audio://. The URL carries an OPAQUE ID, never a path. The handler
// resolves that id to a file through the database and refuses anything it does
// not recognise, which makes path traversal impossible by construction rather
// than by sanitizing a path out of a URL (AGENTS.md: never let a media endpoint
// take a path).

import fs from 'fs'
import path from 'path'
import { app, net, protocol } from 'electron'
import * as database from './database'

export const MEDIA_SCHEME = 'holmes-media'
/** The only host the scheme answers on; anything else is refused. */
const MEDIA_HOST = 'thumb'

/** Where cached artwork lives. Outside the DB: these are binaries, not rows. */
export function playMediaRoot(): string {
  return path.join(app.getPath('userData'), 'play-media')
}

/**
 * Two-level fan-out on the id. A single flat directory of thousands of JPEGs is
 * slow to enumerate on macOS and unpleasant to inspect by hand.
 */
export function playMediaPath(id: string): string {
  return path.join(playMediaRoot(), id.slice(0, 2), `${id}.jpg`)
}

export function mediaUrl(id: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${id}`
}

/**
 * Handed to the single registerSchemesAsPrivileged call in main.ts — a second
 * call silently strips privileges granted by the first, so every scheme must
 * register together. No `stream`: a 20KB JPEG needs no range support, unlike a
 * twenty-minute audio chapter.
 */
export const MEDIA_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    // Deliberately NOT bypassCSP: the scheme is named explicitly in the policy
    // instead, so this cannot become a hole for anything else.
    bypassCSP: false,
  },
}

/** Must run AFTER app ready and AFTER initDatabase. */
export function installPlayMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (url.hostname !== MEDIA_HOST) return new Response('Not found', { status: 404 })

    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!id) return new Response('Not found', { status: 404 })

    const row = database.getPlayMediaById(id)
    if (!row) return new Response('Not found', { status: 404 })

    // The path came from our own writer, but the file can still have been
    // deleted underneath us — a missing file is a 404, never a thrown handler.
    const filePath = row.filePath
    if (!filePath.startsWith(playMediaRoot() + path.sep) || !fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 })
    }

    database.touchPlayMedia(id)

    const response = await net.fetch(`file://${filePath}`, {
      headers: request.headers,
      method: request.method,
    })
    const headers = new Headers(response.headers)
    headers.set('Content-Type', row.contentType)
    // The id is derived from the source URL, so the bytes behind one never
    // change and the renderer may hold onto them.
    headers.set('Cache-Control', 'max-age=86400')
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}
