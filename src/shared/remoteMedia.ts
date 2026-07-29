// The bulk-media contract: how a paired device asks for a whole audiobook
// segment or e-book file over HTTP instead of through the sealed WebSocket.
//
// Everything here is pure — no crypto, no filesystem, no database — so it can be
// unit-tested and so the mobile client can build and read the same URLs. The
// HMAC, the id-to-path resolution and the streaming live in
// `src/main/remoteMedia.ts`.
//
// WHY A SECOND PATH AT ALL: `REMOTE_MAX_FRAME_BYTES` is 8 MiB and a sealed frame
// is JSON with a base64 payload — ~33% overhead, fully buffered on both ends. A
// 400 MB audiobook cannot cross that, and should not: seeking and resuming are
// what HTTP Range is for.
//
// WHY IT IS DIRECT-ONLY: see docs/relay.md section 6. One hour of audiobook
// forwarded through the relay keeps a Durable Object awake for an hour, and at
// scale the media bill exceeds the chat bill roughly two to one. Bulk media
// therefore requires a direct connection as a product rule, not a config value.
// The mechanism is that a minted URL is ABSOLUTE and points at the Mac's own
// direct host and port — a client connected over a relay simply cannot reach it,
// so there is no code path in which media is proxied.

export const REMOTE_MEDIA_PATH = '/holmes/media'

/**
 * How long a minted URL stays valid. Long enough to play a chapter through
 * without a mid-sentence re-mint, short enough that a URL captured out of a log
 * or a screen recording is dead by the time anyone tries it. The client re-mints
 * on a 403 rather than caching a URL for a session.
 */
export const REMOTE_MEDIA_TOKEN_TTL_MS = 60 * 60 * 1000

/** Domain separation, the same reasoning as the session transcript label: a
 *  signature obtained for one purpose must not verify for another. */
export const REMOTE_MEDIA_TOKEN_LABEL = 'holmes-media-token-v1'

export const REMOTE_MEDIA_TOKEN_VERSION = 1

/** The query parameter the token travels in. */
export const REMOTE_MEDIA_TOKEN_PARAM = 't'

/**
 * What a bulk URL may address. Every one of these is an OPAQUE ID resolved
 * through the database to a path — never a path, and never a fragment appended
 * to a root. Adding a kind means adding a resolver that does the same.
 */
export type RemoteMediaKind = 'book' | 'segment'

export const REMOTE_MEDIA_KINDS: readonly RemoteMediaKind[] = ['book', 'segment']

export function isRemoteMediaKind(value: unknown): value is RemoteMediaKind {
  return value === 'book' || value === 'segment'
}

/**
 * Which kinds each scope may fetch, default-deny in the same shape as the
 * channel allowlist. A guest reaches Library media and nothing else; a new
 * non-Library kind is denied to `media` until someone adds it deliberately.
 */
export const MEDIA_SCOPE_MEDIA_KINDS: ReadonlySet<string> = new Set<string>(['book', 'segment'])
export const OWNER_SCOPE_MEDIA_KINDS: ReadonlySet<string> = new Set<string>([...MEDIA_SCOPE_MEDIA_KINDS])

export function isMediaKindAllowed(kind: string, scope: 'owner' | 'media'): boolean {
  return scope === 'owner' ? OWNER_SCOPE_MEDIA_KINDS.has(kind) : MEDIA_SCOPE_MEDIA_KINDS.has(kind)
}

// --- the token payload --------------------------------------------------------

export interface RemoteMediaTokenPayload {
  v: number
  kind: RemoteMediaKind
  /** The opaque resource id — a book id or an audiobook segment id. */
  id: string
  /** The device the token was minted for. A different device's token is refused. */
  deviceId: string
  scope: 'owner' | 'media'
  /** Absolute expiry, epoch ms. */
  exp: number
}

const FIELD_SEPARATOR = '|'

/**
 * The exact bytes that get signed. A canonical delimiter string rather than
 * JSON: two encoders must never disagree about key order or spacing, or a
 * signature verifies over one reading of the payload and is acted on under
 * another. Any field containing the delimiter is refused rather than escaped.
 */
export function encodeMediaTokenPayload(payload: RemoteMediaTokenPayload): string {
  const fields = [
    String(payload.v),
    payload.kind,
    payload.id,
    payload.deviceId,
    payload.scope,
    String(Math.trunc(payload.exp)),
  ]
  for (const field of fields) {
    if (field.includes(FIELD_SEPARATOR)) throw new Error('A media token field cannot contain a separator')
  }
  return fields.join(FIELD_SEPARATOR)
}

export function decodeMediaTokenPayload(encoded: string): RemoteMediaTokenPayload | null {
  const parts = encoded.split(FIELD_SEPARATOR)
  if (parts.length !== 6) return null
  const [rawVersion, kind, id, deviceId, scope, rawExp] = parts
  const version = Number(rawVersion)
  const exp = Number(rawExp)
  if (!Number.isInteger(version) || version !== REMOTE_MEDIA_TOKEN_VERSION) return null
  if (!isRemoteMediaKind(kind)) return null
  if (!id || !deviceId) return null
  if (scope !== 'owner' && scope !== 'media') return null
  if (!Number.isFinite(exp)) return null
  return { v: version, kind, id, deviceId, scope, exp }
}

// --- URLs ---------------------------------------------------------------------

/**
 * `<REMOTE_MEDIA_PATH>/<kind>/<id>`. The id is percent-encoded, and on the way
 * back in it is used only as a database lookup key — it is never joined to a
 * directory, so `../` in it can only ever fail to match a row.
 */
export function remoteMediaPathname(kind: RemoteMediaKind, id: string): string {
  return `${REMOTE_MEDIA_PATH}/${kind}/${encodeURIComponent(id)}`
}

export function parseRemoteMediaPathname(pathname: string): { kind: RemoteMediaKind; id: string } | null {
  if (!pathname.startsWith(`${REMOTE_MEDIA_PATH}/`)) return null
  const rest = pathname.slice(REMOTE_MEDIA_PATH.length + 1)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const kind = rest.slice(0, slash)
  if (!isRemoteMediaKind(kind)) return null
  let id: string
  try {
    id = decodeURIComponent(rest.slice(slash + 1))
  } catch {
    return null
  }
  // One path segment only. A second slash means the caller is trying to describe
  // a location rather than name a resource.
  if (!id || id.includes('/')) return null
  return { kind, id }
}

/**
 * An ABSOLUTE url on the Mac's own direct address. Absolute on purpose: it is
 * what makes "bulk media never crosses the relay" a property of the URL rather
 * than a rule someone has to remember.
 */
export function buildRemoteMediaUrl(input: {
  host: string
  port: number
  kind: RemoteMediaKind
  id: string
  token: string
}): string {
  const path = remoteMediaPathname(input.kind, input.id)
  return `http://${input.host}:${input.port}${path}?${REMOTE_MEDIA_TOKEN_PARAM}=${encodeURIComponent(input.token)}`
}

/** What a `library:get-media-url` call hands back. */
export interface RemoteMediaTicket {
  url: string
  kind: RemoteMediaKind
  id: string
  contentType: string
  byteSize: number
  expiresAt: number
  /** Always true today — bulk media requires a direct connection. */
  directOnly: boolean
}

// --- HTTP Range ---------------------------------------------------------------

export interface ByteRange {
  start: number
  end: number
}

export type ByteRangeResult =
  | { kind: 'full' }
  | { kind: 'range'; range: ByteRange }
  | { kind: 'unsatisfiable' }

/**
 * RFC 7233 single-range parsing. Deliberately tolerant in one direction and
 * strict in the other: a malformed or multi-range header is IGNORED and the
 * whole entity is sent (which the RFC explicitly allows), while a syntactically
 * valid range that cannot be satisfied is reported as such so the caller can
 * answer 416 rather than silently sending the wrong bytes.
 */
export function parseByteRange(header: string | undefined | null, size: number): ByteRangeResult {
  if (typeof header !== 'string' || !header.trim()) return { kind: 'full' }
  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim())
  if (!match) return { kind: 'full' }

  const specs = match[1].split(',')
  // Multipart/byteranges is not implemented; sending the whole entity is a legal
  // answer and is better than a wrong one.
  if (specs.length !== 1) return { kind: 'full' }

  const spec = specs[0].trim()
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts) return { kind: 'full' }
  const [, rawStart, rawEnd] = parts
  if (!rawStart && !rawEnd) return { kind: 'full' }

  let start: number
  let end: number

  if (!rawStart) {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix)) return { kind: 'full' }
    if (suffix <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    if (!Number.isFinite(start)) return { kind: 'full' }
    end = rawEnd ? Number(rawEnd) : size - 1
    if (!Number.isFinite(end)) return { kind: 'full' }
    if (end > size - 1) end = size - 1
  }

  if (size <= 0) return { kind: 'unsatisfiable' }
  if (start >= size || start > end || start < 0) return { kind: 'unsatisfiable' }
  return { kind: 'range', range: { start, end } }
}

export function formatContentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}

export function formatUnsatisfiableContentRange(size: number): string {
  return `bytes */${size}`
}

/** A strong validator built from what a `stat` already answered. */
export function mediaEtag(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`
}
