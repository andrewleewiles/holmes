import { isRelayId, relayIdFromPublicKey } from './base32.ts'
import {
  CLOSE_AUTH_FAILED,
  CLOSE_BUSY,
  CLOSE_IDLE,
  CLOSE_NO_SERVER,
  CLOSE_PROTOCOL,
  CLOSE_QUOTA,
  CLOSE_REPLACED,
  CLOSE_TOO_LARGE,
  FRAME_CLOSE,
  FRAME_DATA_BINARY,
  FRAME_DATA_TEXT,
  FRAME_OPEN,
  MAX_MESSAGE_BYTES,
  MAX_PAYLOAD_BYTES,
  decodeFrame,
  encodeFrame,
} from './protocol.ts'
import type { Env } from './worker.ts'

const MAX_CLIENTS = 4
const AUTH_WINDOW_MS = 120_000
const AUTH_GRACE_MS = 10_000
const CLIENT_IDLE_MS = 5 * 60_000
const SWEEP_MS = 60_000
/** Best-effort throughput ceiling per live instance. See the note on `#bytes`. */
const BYTE_BUDGET = 256 * 1024 * 1024

const AUTH_CONTEXT = 'holmes-relay-auth-v1'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface ServerAttachment {
  r: 's'
  authed: boolean
  nonce: string
  issuedAt: number
}

interface ClientAttachment {
  r: 'c'
  sid: number
  seen: number
}

type Attachment = ServerAttachment | ClientAttachment

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function attachmentOf(ws: WebSocket): Attachment | null {
  try {
    return (ws.deserializeAttachment() as Attachment) ?? null
  } catch {
    return null
  }
}

/**
 * One rendezvous slot: at most one authenticated "server" socket (the Mac) and a
 * handful of "client" sockets (the phone), joined by the relay identifier in the
 * URL. Everything a client sends is forwarded to the Mac verbatim inside a
 * 5-byte relay header, and everything the Mac sends for a stream is forwarded to
 * that client verbatim. The relay never parses a Holmes frame, and could not
 * read one if it tried — they are AES-GCM sealed under a key established at
 * pairing that never touches this code.
 */
export class RelaySlot {
  readonly #ctx: DurableObjectState
  /**
   * In-memory and therefore reset whenever the object is evicted. That is
   * deliberate: a durable counter would mean a storage write per message, which
   * costs more than the abuse it prevents. This catches a runaway session; real
   * per-account quota needs an account, which Holmes does not have.
   */
  #bytes = 0

  constructor(ctx: DurableObjectState, _env: Env) {
    this.#ctx = ctx
    // Keepalives are answered by the runtime without waking the object, which is
    // the difference between "billed while idle" and "not billed while idle".
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const relayId = url.pathname.slice(3)
    if (!isRelayId(relayId)) return new Response('Bad identifier', { status: 400 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const socket = pair[1]

    if (url.pathname.startsWith('/s/')) this.#acceptServer(socket, relayId)
    else this.#acceptClient(socket)

    return new Response(null, { status: 101, webSocket: client })
  }

  #acceptServer(socket: WebSocket, relayId: string): void {
    this.#ctx.acceptWebSocket(socket, ['server', relayId])

    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const issuedAt = Date.now()
    socket.serializeAttachment({ r: 's', authed: false, nonce, issuedAt } satisfies ServerAttachment)
    socket.send(JSON.stringify({ t: 'challenge', nonce, ts: issuedAt }))
    // Without this an unauthenticated socket could sit here forever holding a
    // slot open; the sweep is the only thing that reaps it.
    void this.#ctx.storage.setAlarm(Date.now() + SWEEP_MS)
  }

  #acceptClient(socket: WebSocket): void {
    this.#ctx.acceptWebSocket(socket, ['client'])

    // Accept-then-close rather than an HTTP error: a WebSocket that fails during
    // the upgrade surfaces as an opaque "error" in the phone's JS, while a close
    // code tells the client whether to retry, fail over, or tell the user the
    // Mac is asleep.
    if (!this.#server()) {
      socket.close(CLOSE_NO_SERVER, 'no server attached')
      return
    }

    const clients = this.#ctx.getWebSockets('client')
    if (clients.length > MAX_CLIENTS) {
      socket.close(CLOSE_BUSY, 'too many connections')
      return
    }

    let sid = 1
    for (const existing of clients) {
      const attachment = attachmentOf(existing)
      if (attachment?.r === 'c' && attachment.sid >= sid) sid = attachment.sid + 1
    }

    socket.serializeAttachment({ r: 'c', sid, seen: Date.now() } satisfies ClientAttachment)
    this.#server()?.send(encodeFrame(FRAME_OPEN, sid, new Uint8Array(0)))
    void this.#ctx.storage.setAlarm(Date.now() + SWEEP_MS)
  }

  #server(): WebSocket | null {
    for (const ws of this.#ctx.getWebSockets('server')) {
      const attachment = attachmentOf(ws)
      if (attachment?.r === 's' && attachment.authed) return ws
    }
    return null
  }

  #clientFor(sid: number): WebSocket | null {
    for (const ws of this.#ctx.getWebSockets('client')) {
      const attachment = attachmentOf(ws)
      if (attachment?.r === 'c' && attachment.sid === sid) return ws
    }
    return null
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === 'string' ? message.length : message.byteLength
    if (size > MAX_MESSAGE_BYTES) {
      ws.close(CLOSE_TOO_LARGE, 'message too large')
      return
    }

    this.#bytes += size
    if (this.#bytes > BYTE_BUDGET) {
      this.#closeAll(CLOSE_QUOTA, 'throughput budget exceeded')
      return
    }

    const attachment = attachmentOf(ws)
    if (!attachment) {
      ws.close(CLOSE_PROTOCOL, 'no attachment')
      return
    }

    if (attachment.r === 's') await this.#onServerMessage(ws, attachment, message)
    else this.#onClientMessage(ws, attachment, message)
  }

  async #onServerMessage(ws: WebSocket, attachment: ServerAttachment, message: string | ArrayBuffer): Promise<void> {
    if (!attachment.authed) {
      if (typeof message !== 'string') {
        ws.close(CLOSE_PROTOCOL, 'expected auth')
        return
      }
      await this.#authenticate(ws, attachment, message)
      return
    }

    if (typeof message === 'string') {
      ws.close(CLOSE_PROTOCOL, 'expected a binary relay frame')
      return
    }

    const frame = decodeFrame(message)
    if (!frame) {
      ws.close(CLOSE_PROTOCOL, 'short frame')
      return
    }

    const target = this.#clientFor(frame.streamId)
    if (!target) return

    if (frame.type === FRAME_DATA_TEXT) target.send(decoder.decode(frame.payload))
    else if (frame.type === FRAME_DATA_BINARY) target.send(frame.payload)
    else if (frame.type === FRAME_CLOSE) target.close(1000, 'closed by server')
    else ws.close(CLOSE_PROTOCOL, 'unknown frame type')
  }

  async #authenticate(ws: WebSocket, attachment: ServerAttachment, message: string): Promise<void> {
    const relayId = this.#ctx.getTags(ws).find((tag) => isRelayId(tag))
    if (!relayId) {
      ws.close(CLOSE_PROTOCOL, 'untagged socket')
      return
    }

    if (Date.now() - attachment.issuedAt > AUTH_WINDOW_MS) {
      ws.close(CLOSE_AUTH_FAILED, 'challenge expired')
      return
    }

    let pub: Uint8Array
    let sig: Uint8Array
    try {
      const body = JSON.parse(message) as { t?: string; pub?: string; sig?: string }
      if (body.t !== 'auth' || typeof body.pub !== 'string' || typeof body.sig !== 'string') throw new Error('shape')
      pub = fromBase64url(body.pub)
      sig = fromBase64url(body.sig)
    } catch {
      ws.close(CLOSE_AUTH_FAILED, 'malformed auth')
      return
    }

    if (pub.length !== 32 || sig.length !== 64) {
      ws.close(CLOSE_AUTH_FAILED, 'bad key or signature length')
      return
    }

    // The identifier IS the fingerprint of the key, so ownership is checked
    // without the relay holding any registry: recompute it and compare. Nobody
    // can claim a slot they do not hold the private key for, and the relay never
    // learns who the holder is.
    if ((await relayIdFromPublicKey(pub)) !== relayId) {
      ws.close(CLOSE_AUTH_FAILED, 'identifier does not match key')
      return
    }

    let ok = false
    try {
      const key = await crypto.subtle.importKey('raw', pub as BufferSource, { name: 'Ed25519' }, false, ['verify'])
      const signed = encoder.encode(`${AUTH_CONTEXT}|${relayId}|${attachment.nonce}|${attachment.issuedAt}`)
      ok = await crypto.subtle.verify('Ed25519', key, sig as BufferSource, signed as BufferSource)
    } catch {
      ok = false
    }

    if (!ok) {
      ws.close(CLOSE_AUTH_FAILED, 'signature did not verify')
      return
    }

    // Last valid claimant wins. A Mac that restarts must not be locked out by
    // its own half-dead socket, and both sockets prove the same private key, so
    // there is no impersonation to prevent here — only a stale one to evict.
    for (const other of this.#ctx.getWebSockets('server')) {
      if (other !== ws) other.close(CLOSE_REPLACED, 'replaced by a newer connection')
    }

    ws.serializeAttachment({ ...attachment, authed: true } satisfies ServerAttachment)
    ws.send(JSON.stringify({ t: 'ready' }))

    // Clients that connected during the reconnect window are still waiting.
    for (const client of this.#ctx.getWebSockets('client')) {
      const clientAttachment = attachmentOf(client)
      if (clientAttachment?.r === 'c') ws.send(encodeFrame(FRAME_OPEN, clientAttachment.sid, new Uint8Array(0)))
    }
  }

  #onClientMessage(ws: WebSocket, attachment: ClientAttachment, message: string | ArrayBuffer): void {
    const server = this.#server()
    if (!server) {
      ws.close(CLOSE_NO_SERVER, 'server went away')
      return
    }

    const payload = typeof message === 'string' ? encoder.encode(message) : new Uint8Array(message)
    if (payload.length > MAX_PAYLOAD_BYTES) {
      ws.close(CLOSE_TOO_LARGE, 'message too large for the relay')
      return
    }

    const type = typeof message === 'string' ? FRAME_DATA_TEXT : FRAME_DATA_BINARY
    server.send(encodeFrame(type, attachment.sid, payload))

    // Rewriting the attachment costs more than it saves at chat rates, so the
    // idle clock is only advanced once every half sweep.
    const now = Date.now()
    if (now - attachment.seen > SWEEP_MS / 2) ws.serializeAttachment({ ...attachment, seen: now } satisfies ClientAttachment)
  }

  webSocketClose(ws: WebSocket): void {
    const attachment = attachmentOf(ws)
    if (!attachment) return

    if (attachment.r === 'c') {
      this.#server()?.send(encodeFrame(FRAME_CLOSE, attachment.sid, new Uint8Array(0)))
      return
    }

    // The Mac dropped. Its clients cannot be served by anyone else, and holding
    // them open would show the phone a live socket that answers nothing.
    if (attachment.authed && !this.#server()) {
      for (const client of this.#ctx.getWebSockets('client')) client.close(CLOSE_NO_SERVER, 'server disconnected')
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws)
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const server = this.#server()
    const clients = this.#ctx.getWebSockets('client')

    for (const client of clients) {
      const attachment = attachmentOf(client)
      if (attachment?.r !== 'c') continue
      if (!server) client.close(CLOSE_NO_SERVER, 'no server attached')
      else if (now - attachment.seen > CLIENT_IDLE_MS) client.close(CLOSE_IDLE, 'idle')
    }

    for (const ws of this.#ctx.getWebSockets('server')) {
      const attachment = attachmentOf(ws)
      if (attachment?.r === 's' && !attachment.authed && now - attachment.issuedAt > AUTH_WINDOW_MS + AUTH_GRACE_MS) {
        ws.close(CLOSE_AUTH_FAILED, 'did not authenticate')
      }
    }

    if (this.#ctx.getWebSockets().length > 0) await this.#ctx.storage.setAlarm(now + SWEEP_MS)
  }

  #closeAll(code: number, reason: string): void {
    for (const ws of this.#ctx.getWebSockets()) ws.close(code, reason)
  }
}
