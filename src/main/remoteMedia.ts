// Authenticated HTTP range serving for bulk Library media.
//
// This is the second path onto the remote port. The sealed WebSocket carries
// RPC; this carries bytes. Read `src/shared/remoteMedia.ts` first — it holds the
// contract, the token payload format and the reasoning.
//
// THE TWO SECURITY PROPERTIES, both of which are structural rather than
// defensive:
//
//   1. A request names a RESOURCE, never a location. The URL carries an opaque
//      id which is used only as a database lookup key. There is no root
//      directory that a client-supplied fragment is appended to, so there is no
//      traversal to escape from — `../../../health.db` is a lookup that finds no
//      row. After the row resolves to a path, that path is re-checked against
//      the Library's connected source roots and the file access scope, because a
//      book row can outlive the source it was scanned from.
//
//   2. Every request is authenticated on its own. The WebSocket session proves
//      device identity; an HTTP connection proves nothing. So a `library:*` RPC
//      over the authenticated socket mints a short-lived HMAC token bound to
//      resource id + device id + scope + expiry, and the request is refused
//      unless all four still hold. A device id alone is never accepted as a
//      bearer credential, and nothing is stored in a cookie.
import fs from 'fs'
import path from 'path'
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import * as database from './database'
import { assertPathAllowed } from './fileScope'
import { audiobookRoot } from './audioProtocol'
import { isLibraryProject } from '../shared/defaultProjects'
import type { RemoteScope } from '../shared/remote'
import {
  REMOTE_MEDIA_TOKEN_LABEL,
  REMOTE_MEDIA_TOKEN_PARAM,
  REMOTE_MEDIA_TOKEN_TTL_MS,
  REMOTE_MEDIA_TOKEN_VERSION,
  buildRemoteMediaUrl,
  decodeMediaTokenPayload,
  encodeMediaTokenPayload,
  formatContentRange,
  formatUnsatisfiableContentRange,
  isMediaKindAllowed,
  mediaEtag,
  parseByteRange,
  parseRemoteMediaPathname,
  type RemoteMediaKind,
  type RemoteMediaTicket,
  type RemoteMediaTokenPayload,
} from '../shared/remoteMedia'

export class RemoteMediaError extends Error {}

/**
 * The signing key is generated in memory when the remote server starts and
 * thrown away when it stops. Deliberately not persisted: nothing at rest means
 * nothing to steal from a backup, and every outstanding URL dying when remote
 * access is turned off is the behaviour a user toggling that switch expects.
 */
let signingKey: Buffer | null = null

/** The Mac's own direct address, set by the server. Minted URLs are absolute
 *  against it, which is what keeps bulk media off any future relay. */
let origin: { host: string; port: number } | null = null

export function startRemoteMedia(input: { host: string; port: number }): void {
  signingKey = randomBytes(32)
  origin = { host: input.host, port: input.port }
}

export function setRemoteMediaOrigin(input: { host: string; port: number }): void {
  if (!signingKey) return
  origin = input
}

export function stopRemoteMedia(): void {
  signingKey = null
  origin = null
}

// --- id resolution -------------------------------------------------------------

interface ResolvedMedia {
  filePath: string
  contentType: string
}

function isUnderRoot(target: string, root: string): boolean {
  if (target === root) return true
  const withSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target.startsWith(withSep)
}

function realpathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

const BOOK_CONTENT_TYPES: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
}

/**
 * Book id -> file on disk. Four gates, in order, and all four have to hold:
 * the row exists and parsed, the project it belongs to is actually a Library,
 * the file still sits under one of that project's connected source roots, and
 * the file access scope still permits it.
 *
 * The source-root re-check is the one that is easy to leave out and must not be:
 * a book row survives the source being disconnected, and without this a
 * disconnected folder would keep serving over the network.
 */
function resolveBook(bookId: string): ResolvedMedia {
  const book = database.getBookById(bookId)
  if (!book) throw new RemoteMediaError('No such media')
  if (book.status !== 'ready' || book.missingSince) throw new RemoteMediaError('No such media')

  const project = database.getProjectById(book.projectId)
  if (!project || !isLibraryProject(project)) throw new RemoteMediaError('No such media')

  const resolved = realpathOrNull(path.resolve(book.filePath))
  if (!resolved) throw new RemoteMediaError('No such media')

  const roots = database
    .listProjectSourcePaths(book.projectId)
    .map((source) => realpathOrNull(path.resolve(source)))
    .filter((source): source is string => source !== null)
  if (!roots.some((root) => isUnderRoot(resolved, root))) throw new RemoteMediaError('No such media')

  // The scope can change after a scan, so it is re-read here rather than trusted
  // from the row — the same rule every Library handler follows.
  assertPathAllowed(resolved)

  return { filePath: resolved, contentType: BOOK_CONTENT_TYPES[book.format] ?? 'application/octet-stream' }
}

/**
 * Segment id -> generated audio file. These are written by Holmes into its own
 * userData directory, so the containment check is against `audiobookRoot()`
 * rather than a user folder. The book is re-checked too: narration for a book
 * that has left the shelf must stop being servable with it.
 */
function resolveSegment(segmentId: string): ResolvedMedia {
  const segment = database.getAudiobookSegmentById(segmentId)
  if (!segment) throw new RemoteMediaError('No such media')

  const book = database.getBookById(segment.bookId)
  if (!book) throw new RemoteMediaError('No such media')
  const project = database.getProjectById(book.projectId)
  if (!project || !isLibraryProject(project)) throw new RemoteMediaError('No such media')

  const root = realpathOrNull(audiobookRoot())
  const resolved = realpathOrNull(path.resolve(segment.filePath))
  if (!root || !resolved || !isUnderRoot(resolved, root)) throw new RemoteMediaError('No such media')

  return { filePath: resolved, contentType: segment.mimeType || 'audio/mpeg' }
}

function resolveMedia(kind: RemoteMediaKind, id: string): ResolvedMedia {
  return kind === 'book' ? resolveBook(id) : resolveSegment(id)
}

// --- tokens ---------------------------------------------------------------------

function base64url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sign(encodedPayload: string): Buffer {
  if (!signingKey) throw new RemoteMediaError('Remote access is not running')
  return createHmac('sha256', signingKey).update(`${REMOTE_MEDIA_TOKEN_LABEL}|${encodedPayload}`).digest()
}

export function mintMediaToken(payload: RemoteMediaTokenPayload): string {
  const encoded = encodeMediaTokenPayload(payload)
  return `${base64url(Buffer.from(encoded, 'utf8'))}.${base64url(sign(encoded))}`
}

/**
 * Verifies the signature FIRST and only then reads the payload, so nothing a
 * client wrote is acted on before it has been proved to be ours. Every failure
 * returns null rather than a reason: a caller that can tell "bad signature" from
 * "expired" from "revoked" has an oracle.
 */
export function verifyMediaToken(token: string, now = Date.now()): RemoteMediaTokenPayload | null {
  if (!signingKey || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null

  const encoded = fromBase64url(token.slice(0, dot)).toString('utf8')
  const supplied = fromBase64url(token.slice(dot + 1))
  let expected: Buffer
  try {
    expected = sign(encoded)
  } catch {
    return null
  }
  if (supplied.length !== expected.length) return null
  if (!timingSafeEqual(supplied, expected)) return null

  const payload = decodeMediaTokenPayload(encoded)
  if (!payload) return null
  if (payload.exp <= now) return null
  return payload
}

/**
 * Mints one URL. Called from a `library:*` handler, i.e. only ever over an
 * already-authenticated session — which is what makes the token a delegation of
 * an existing right rather than a new one.
 */
export function mintMediaTicket(input: {
  kind: RemoteMediaKind
  id: string
  deviceId: string
  scope: RemoteScope
  now?: number
}): RemoteMediaTicket {
  if (!signingKey || !origin) throw new RemoteMediaError('Remote access is not running')
  if (!isMediaKindAllowed(input.kind, input.scope)) throw new RemoteMediaError('No such media')

  const resolved = resolveMedia(input.kind, input.id)
  const stat = fs.statSync(resolved.filePath)
  const now = input.now ?? Date.now()
  const expiresAt = now + REMOTE_MEDIA_TOKEN_TTL_MS

  const token = mintMediaToken({
    v: REMOTE_MEDIA_TOKEN_VERSION,
    kind: input.kind,
    id: input.id,
    deviceId: input.deviceId,
    scope: input.scope,
    exp: expiresAt,
  })

  return {
    url: buildRemoteMediaUrl({ host: origin.host, port: origin.port, kind: input.kind, id: input.id, token }),
    kind: input.kind,
    id: input.id,
    contentType: resolved.contentType,
    byteSize: stat.size,
    expiresAt,
    directOnly: true,
  }
}

// --- serving ---------------------------------------------------------------------

function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): true {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(message)
  return true
}

/**
 * Returns true when the request belonged to this endpoint and has been answered.
 * Returning false leaves the caller free to answer 426, so the WebSocket upgrade
 * path is untouched by this existing at all.
 */
export function handleRemoteMediaRequest(request: IncomingMessage, response: ServerResponse): boolean {
  let url: URL
  try {
    url = new URL(request.url ?? '', 'http://holmes.invalid')
  } catch {
    return false
  }

  const target = parseRemoteMediaPathname(url.pathname)
  if (!target) return false

  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return refuse(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
  }

  const token = url.searchParams.get(REMOTE_MEDIA_TOKEN_PARAM) ?? ''
  if (!token) return refuse(response, 401, 'A media token is required')

  const payload = verifyMediaToken(token)
  if (!payload) return refuse(response, 403, 'Not authorized')

  // Repointing check: a token minted for one resource must not fetch another.
  // Without this the signature would only prove "some valid token exists".
  if (payload.kind !== target.kind || payload.id !== target.id) return refuse(response, 403, 'Not authorized')

  // The device is re-read on every request, so revoking a device kills its
  // outstanding URLs rather than leaving them live until they expire.
  const device = database.getRemoteDeviceById(payload.deviceId)
  if (!device) return refuse(response, 403, 'Not authorized')
  if (device.scope !== payload.scope) return refuse(response, 403, 'Not authorized')
  if (!isMediaKindAllowed(target.kind, device.scope)) return refuse(response, 403, 'Not authorized')

  let resolved: ResolvedMedia
  let stat: fs.Stats
  try {
    resolved = resolveMedia(target.kind, target.id)
    stat = fs.statSync(resolved.filePath)
  } catch {
    return refuse(response, 404, 'No such media')
  }
  if (!stat.isFile()) return refuse(response, 404, 'No such media')

  const size = stat.size
  const etag = mediaEtag(size, stat.mtimeMs)
  const lastModified = new Date(stat.mtimeMs).toUTCString()

  const baseHeaders: Record<string, string> = {
    'Content-Type': resolved.contentType,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': lastModified,
    // A token in the URL must not land in a shared cache, and the bytes are the
    // user's library.
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }

  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, baseHeaders)
    response.end()
    return true
  }

  // If-Range: when the validator has moved on, the client's byte offsets refer
  // to a file that no longer exists, so it gets the whole current entity.
  const ifRange = request.headers['if-range']
  const rangeHeader = typeof ifRange === 'string' && ifRange !== etag && ifRange !== lastModified
    ? undefined
    : request.headers.range

  const parsed = parseByteRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, size)

  if (parsed.kind === 'unsatisfiable') {
    return refuse(response, 416, 'Requested range not satisfiable', {
      'Content-Range': formatUnsatisfiableContentRange(size),
      'Accept-Ranges': 'bytes',
    })
  }

  const range = parsed.kind === 'range' ? parsed.range : { start: 0, end: Math.max(0, size - 1) }
  const length = size === 0 ? 0 : range.end - range.start + 1

  const headers: Record<string, string> = {
    ...baseHeaders,
    'Content-Length': String(length),
  }
  if (parsed.kind === 'range') headers['Content-Range'] = formatContentRange(range, size)

  response.writeHead(parsed.kind === 'range' ? 206 : 200, headers)

  if (method === 'HEAD' || length === 0) {
    response.end()
    return true
  }

  // Streamed from disk with an explicit window. A 400 MB audiobook is never
  // held in memory, and a seek reads only the bytes it asked for.
  const stream = fs.createReadStream(resolved.filePath, { start: range.start, end: range.end })
  stream.on('error', () => {
    response.destroy()
  })
  response.on('close', () => {
    stream.destroy()
  })
  stream.pipe(response)
  return true
}
