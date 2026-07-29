import { createHash } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'
import type { Socket } from 'net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const CLOSE_NORMAL = 1000
const CLOSE_PROTOCOL_ERROR = 1002
const CLOSE_TOO_LARGE = 1009

type MessageListener = (data: string) => void
type CloseListener = () => void

export interface WsConnection {
  readonly remoteAddress: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onMessage(listener: MessageListener): void
  onClose(listener: CloseListener): void
  isOpen(): boolean
}

export interface WsServerOptions {
  port: number
  host: string
  path: string
  maxPayloadBytes: number
  onConnection: (connection: WsConnection, request: IncomingMessage) => void
  /**
   * Plain HTTP on the same port, for bulk bytes that have no business inside a
   * JSON frame. Return true to claim the request; anything not claimed still
   * gets 426, so the upgrade path is exactly as narrow as it was. The hook is
   * deliberately synchronous-or-void and receives the raw request: it is
   * expected to authenticate for itself, because an HTTP connection carries
   * none of the session's proof.
   */
  onRequest?: (request: IncomingMessage, response: ServerResponse) => boolean
}

export interface WsServer {
  readonly port: number
  close(): Promise<void>
}

function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer

  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }

  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

class Connection implements WsConnection {
  readonly remoteAddress: string

  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode = 0
  private fragmentBytes = 0
  private open = true
  private readonly messageListeners: MessageListener[] = []
  private readonly closeListeners: CloseListener[] = []

  private readonly socket: Duplex
  private readonly maxPayloadBytes: number

  // Explicit fields rather than parameter properties: the tests load this
  // module under `node --experimental-strip-types`, which rejects them.
  constructor(socket: Duplex, maxPayloadBytes: number) {
    this.socket = socket
    this.maxPayloadBytes = maxPayloadBytes
    this.remoteAddress = (socket as Socket).remoteAddress ?? ''
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }

  isOpen(): boolean {
    return this.open
  }

  onMessage(listener: MessageListener): void {
    this.messageListeners.push(listener)
  }

  onClose(listener: CloseListener): void {
    this.closeListeners.push(listener)
  }

  send(data: string): void {
    if (!this.open) return
    try {
      this.socket.write(encodeFrame(OP_TEXT, Buffer.from(data, 'utf8')))
    } catch {
      this.finish()
    }
  }

  close(code = CLOSE_NORMAL, reason = ''): void {
    if (!this.open) return
    const reasonBytes = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      // The peer is already gone; the socket teardown below is what matters.
    }
    this.finish()
    this.socket.end()
  }

  private finish(): void {
    if (!this.open) return
    this.open = false
    for (const listener of this.closeListeners) {
      try {
        listener()
      } catch {
        // One listener throwing must not strand the others.
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    while (this.open) {
      const frame = this.readFrame()
      if (!frame) return
      this.handleFrame(frame.fin, frame.opcode, frame.payload)
    }
  }

  private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const buf = this.buffer
    if (buf.length < 2) return null

    const fin = (buf[0] & 0x80) !== 0
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(this.maxPayloadBytes)) {
        this.close(CLOSE_TOO_LARGE, 'Frame too large')
        return null
      }
      length = Number(big)
      offset += 8
    }

    if (length > this.maxPayloadBytes) {
      this.close(CLOSE_TOO_LARGE, 'Frame too large')
      return null
    }

    // RFC 6455: every client-to-server frame must be masked.
    if (!masked) {
      this.close(CLOSE_PROTOCOL_ERROR, 'Unmasked frame')
      return null
    }

    if (buf.length < offset + 4 + length) return null
    const maskKey = buf.subarray(offset, offset + 4)
    offset += 4

    const payload = Buffer.allocUnsafe(length)
    buf.copy(payload, 0, offset, offset + length)
    for (let i = 0; i < length; i += 1) payload[i] ^= maskKey[i & 3]

    this.buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_PING:
        this.socket.write(encodeFrame(OP_PONG, payload))
        return
      case OP_PONG:
        return
      case OP_CLOSE:
        this.close(CLOSE_NORMAL)
        return
      case OP_CONTINUATION: {
        if (this.fragmentOpcode === 0) {
          this.close(CLOSE_PROTOCOL_ERROR, 'Unexpected continuation')
          return
        }
        if (!this.pushFragment(payload)) return
        if (fin) this.completeMessage()
        return
      }
      case OP_TEXT:
      case OP_BINARY: {
        if (this.fragmentOpcode !== 0) {
          this.close(CLOSE_PROTOCOL_ERROR, 'Interleaved message')
          return
        }
        if (fin) {
          this.emit(payload)
          return
        }
        this.fragmentOpcode = opcode
        this.pushFragment(payload)
        return
      }
      default:
        this.close(CLOSE_PROTOCOL_ERROR, 'Unknown opcode')
    }
  }

  private pushFragment(payload: Buffer): boolean {
    this.fragmentBytes += payload.length
    if (this.fragmentBytes > this.maxPayloadBytes) {
      this.close(CLOSE_TOO_LARGE, 'Message too large')
      return false
    }
    this.fragments.push(payload)
    return true
  }

  private completeMessage(): void {
    const message = Buffer.concat(this.fragments)
    this.fragments = []
    this.fragmentOpcode = 0
    this.fragmentBytes = 0
    this.emit(message)
  }

  private emit(payload: Buffer): void {
    const text = payload.toString('utf8')
    for (const listener of this.messageListeners) {
      try {
        listener(text)
      } catch {
        // A handler throwing must not tear down the socket.
      }
    }
  }
}

export function createWebSocketServer(options: WsServerOptions): Promise<WsServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      try {
        if (options.onRequest?.(req, res)) return
      } catch {
        // A throwing handler must not leave the socket hanging open.
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('Internal error')
        } else {
          res.destroy()
        }
        return
      }
      // The phone ships its own bundle; nothing else is served over HTTP.
      res.writeHead(426, { 'Content-Type': 'text/plain' })
      res.end('Upgrade required')
    })

    const onUpgrade = (request: IncomingMessage, socket: Duplex): void => {
      const key = request.headers['sec-websocket-key']
      const requestPath = (request.url ?? '').split('?')[0]

      if (typeof key !== 'string' || requestPath !== options.path) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
      )
      ;(socket as Socket).setNoDelay?.(true)

      options.onConnection(new Connection(socket, options.maxPayloadBytes), request)
    }

    server.on('upgrade', onUpgrade)
    server.on('error', (error) => reject(error))

    server.listen(options.port, options.host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : options.port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}
