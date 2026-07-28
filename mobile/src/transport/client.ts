import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_WS_PATH,
  isAllowedRemoteHost,
  normalizePairingCode,
  type RemoteFrame,
  type RemoteMessage,
} from '@shared/remote'
import {
  deriveSessionKeys,
  fromBase64,
  generateEphemeralKeyPair,
  generateStaticKeyPair,
  open as openSealed,
  seal,
  toBase64,
  type SessionKeys,
} from './crypto'
import { loadIdentity, saveIdentity, type PairedIdentity } from './secureStore'

export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'unpaired' | 'revoked'

type EventListener = (channel: string, args: unknown[]) => void
type StateListener = (state: ConnectionState, error: string | null) => void

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000
const REQUEST_TIMEOUT_MS = 180_000

function socketUrl(host: string, port: number): string {
  return `ws://${host}:${port}${REMOTE_WS_PATH}`
}

export class RemoteClient {
  private socket: WebSocket | null = null
  private keys: SessionKeys | null = null
  private identity: PairedIdentity | null = null
  private sendCounter = 0
  private receiveCounter = 0
  private nextRequestId = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false
  private state: ConnectionState = 'offline'
  private lastError: string | null = null

  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<EventListener>()
  private readonly stateListeners = new Set<StateListener>()

  getState(): ConnectionState {
    return this.state
  }

  getError(): string | null {
    return this.lastError
  }

  getHost(): string | null {
    return this.identity?.host ?? null
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private setState(state: ConnectionState, error: string | null = null): void {
    this.state = state
    this.lastError = error
    for (const listener of this.stateListeners) listener(state, error)
  }

  /**
   * One-shot pairing. The socket is closed by the Mac once the device is
   * recorded, so this connects, pairs, and hands back to start() to open a real
   * session with the key it just registered.
   */
  async pair(input: { host: string; port: number; code: string; deviceName: string }): Promise<void> {
    const host = input.host.trim().toLowerCase()

    // A bare IP would force NSAllowsArbitraryLoads across the whole app.
    if (!isAllowedRemoteHost(host)) {
      throw new Error('Enter the Mac\'s Tailscale name (something.ts.net), not its IP address')
    }

    const keyPair = generateStaticKeyPair()
    const code = normalizePairingCode(input.code)

    const paired = await new Promise<{ deviceId: string; serverStaticPub: string }>((resolve, reject) => {
      const socket = new WebSocket(socketUrl(host, input.port))
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('The Mac did not answer. Check that both devices are on your tailnet.'))
      }, 15_000)

      socket.onopen = () => {
        socket.send(JSON.stringify({
          t: 'pair',
          v: REMOTE_PROTOCOL_VERSION,
          code,
          clientStaticPub: keyPair.publicKey,
          deviceName: input.deviceName,
          platform: 'ios',
        }))
      }

      socket.onmessage = (event) => {
        clearTimeout(timer)
        let frame: RemoteFrame
        try {
          frame = JSON.parse(String(event.data)) as RemoteFrame
        } catch {
          reject(new Error('The Mac sent something unreadable'))
          socket.close()
          return
        }
        if (frame.t === 'paired') {
          resolve({ deviceId: frame.deviceId, serverStaticPub: frame.serverStaticPub })
        } else if (frame.t === 'error') {
          reject(new Error(frame.message))
        } else {
          reject(new Error('Unexpected reply from the Mac'))
        }
        socket.close()
      }

      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('Could not reach the Mac'))
      }
    })

    const identity: PairedIdentity = {
      deviceId: paired.deviceId,
      host,
      port: input.port,
      // Pinned here and never renegotiated: it is what proves on every later
      // session that this is the same Mac and not something on the path.
      serverStaticPub: paired.serverStaticPub,
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
    }
    await saveIdentity(identity)
    this.identity = identity
    await this.start()
  }

  async start(): Promise<void> {
    this.closedByUs = false
    this.identity = this.identity ?? (await loadIdentity())
    if (!this.identity) {
      this.setState('unpaired')
      return
    }
    this.connect()
  }

  stop(): void {
    this.closedByUs = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.keys = null
    this.setState('offline')
  }

  private connect(): void {
    const identity = this.identity
    if (!identity) return

    this.setState('connecting')
    this.keys = null
    this.sendCounter = 0
    this.receiveCounter = 0

    const socket = new WebSocket(socketUrl(identity.host, identity.port))
    this.socket = socket

    const ephemeral = generateEphemeralKeyPair()

    socket.onopen = () => {
      socket.send(JSON.stringify({
        t: 'hello',
        v: REMOTE_PROTOCOL_VERSION,
        deviceId: identity.deviceId,
        clientEphemeralPub: toBase64(ephemeral.publicKey),
      }))
    }

    socket.onmessage = (event) => {
      void this.handleFrame(String(event.data), ephemeral, identity)
    }

    socket.onerror = () => {
      // onclose always follows, and that is where the retry is scheduled.
    }

    socket.onclose = () => {
      this.failAllPending(new Error('Lost the connection to your Mac'))
      this.keys = null
      if (this.state === 'revoked' || this.closedByUs) return
      this.scheduleReconnect()
    }
  }

  private async handleFrame(
    raw: string,
    ephemeral: { privateKey: Uint8Array; publicKey: Uint8Array },
    identity: PairedIdentity
  ): Promise<void> {
    let frame: RemoteFrame
    try {
      frame = JSON.parse(raw) as RemoteFrame
    } catch {
      return
    }

    if (frame.t === 'error') {
      if (frame.code === 'unknown-device') {
        // The Mac revoked this device. Reconnecting would only be refused again.
        this.setState('revoked', 'This iPhone was removed from your Mac. Pair it again.')
        this.closedByUs = true
      } else {
        this.setState('connecting', frame.message)
      }
      return
    }

    if (frame.t === 'hello-ok') {
      const serverEphemeralPub = fromBase64(frame.serverEphemeralPub)
      // Pinned at pairing. If the Mac's identity ever differs, the derived keys
      // will not match and the first sealed frame fails to open.
      const serverStaticPub = fromBase64(identity.serverStaticPub)

      this.keys = await deriveSessionKeys({
        ephemeralPrivate: ephemeral.privateKey,
        staticPrivate: fromBase64(identity.privateKey),
        peerEphemeralPublic: serverEphemeralPub,
        peerStaticPublic: serverStaticPub,
        clientStaticPub: fromBase64(identity.publicKey),
        serverStaticPub,
        clientEphemeralPub: ephemeral.publicKey,
        serverEphemeralPub,
      })

      this.reconnectAttempt = 0
      this.setState('connected')
      return
    }

    if (frame.t === 'msg') {
      if (!this.keys) return
      let message: RemoteMessage
      try {
        message = JSON.parse(await openSealed(this.keys.serverToClient, frame.n, frame.d)) as RemoteMessage
      } catch {
        this.socket?.close()
        return
      }
      this.receiveCounter = frame.n

      if (message.k === 'res') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new Error(message.error))
        return
      }

      if (message.k === 'evt') {
        for (const listener of this.eventListeners) listener(message.channel, message.args)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  async call<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (!this.keys || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to your Mac')
    }

    this.nextRequestId += 1
    const id = this.nextRequestId
    this.sendCounter += 1
    const counter = this.sendCounter

    const payload = await seal(
      this.keys.clientToServer,
      counter,
      JSON.stringify({ k: 'req', id, channel, args })
    )

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Your Mac did not answer in time'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      this.socket?.send(JSON.stringify({ t: 'msg', n: counter, d: payload }))
    })
  }
}

export const remoteClient = new RemoteClient()
