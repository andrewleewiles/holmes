import { execFile } from 'child_process'
import { hostname } from 'os'
import { promisify } from 'util'
import { IPC } from './ipcChannels'
import * as database from './database'
import * as settings from './settings'
import { withProviderCallFeature } from './callLog'
import { broadcast, getHandler, setRemoteForwarder, type CallerEvent, type CallerSender } from './remoteBridge'
import { createWebSocketServer, type WsConnection, type WsServer } from './wsServer'
import {
  deriveSessionKeys,
  generateEphemeralKeyPair,
  generatePairingCode,
  open as openSealed,
  pairingCodeMatches,
  publicKeyToRaw,
  rawToPrivateKey,
  rawToPublicKey,
  seal,
  type SessionKeys,
} from './remoteCrypto'
import {
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PAIRING_CODE_TTL_MS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_WS_PATH,
  isRemoteCallable,
  type RemoteErrorCode,
  type RemoteFrame,
  type RemoteMessage,
  type RemotePairingOffer,
  type RemoteServerStatus,
} from '../shared/remote'

const execFileAsync = promisify(execFile)

const TAILSCALE_PATHS = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

interface Session {
  deviceId: string
  connection: WsConnection
  keys: SessionKeys
  sendCounter: number
  lastReceived: number
  sender: CallerSender
}

let server: WsServer | null = null
let starting: Promise<void> | null = null
let lastError: string | null = null
let pairing: (RemotePairingOffer & { expiresAt: number }) | null = null
let pairingTimer: NodeJS.Timeout | null = null
let detectedHost: string | null = null

const sessions = new Map<string, Session>()
/** Negative so a remote caller id can never collide with a real webContents id. */
let nextSenderId = -1000

function fail(connection: WsConnection, code: RemoteErrorCode, message: string): void {
  try {
    connection.send(JSON.stringify({ t: 'error', code, message }))
  } catch {
    // The socket is already gone; closing below is all that is left to do.
  }
  connection.close()
}

function sealedSend(session: Session, message: RemoteMessage): void {
  if (!session.connection.isOpen()) return
  session.sendCounter += 1
  const payload = seal(session.keys.serverToClient, session.sendCounter, Buffer.from(JSON.stringify(message), 'utf8'))
  session.connection.send(JSON.stringify({ t: 'msg', n: session.sendCounter, d: payload }))
}

function createSender(getSession: () => Session | undefined, destroyListeners: Set<() => void>): CallerSender {
  const id = nextSenderId
  nextSenderId -= 1

  return {
    id,
    isDestroyed: () => !getSession()?.connection.isOpen(),
    send: (channel: string, ...args: unknown[]) => {
      const session = getSession()
      if (session) sealedSend(session, { k: 'evt', channel, args })
    },
    once: (_event: 'destroyed', listener: () => void) => {
      destroyListeners.add(listener)
    },
    removeListener: (_event: 'destroyed', listener: () => void) => {
      destroyListeners.delete(listener)
    },
  }
}

async function dispatch(session: Session, id: number, channel: string, args: unknown[]): Promise<void> {
  if (!isRemoteCallable(channel)) {
    sealedSend(session, { k: 'res', id, ok: false, error: `${channel} is not available to a remote device`, code: 'channel-denied' })
    return
  }

  const handler = getHandler(channel)
  if (!handler) {
    sealedSend(session, { k: 'res', id, ok: false, error: `Unknown channel ${channel}`, code: 'channel-denied' })
    return
  }

  const event: CallerEvent = { sender: session.sender, remote: { deviceId: session.deviceId } }

  try {
    // Same wrapper the renderer path gets from callLog, so a call the phone
    // starts is labelled with its channel in Call History rather than landing
    // there anonymous.
    const result = await withProviderCallFeature(channel, () => handler(event, ...args))
    sealedSend(session, { k: 'res', id, ok: true, result: result ?? null })
  } catch (error) {
    sealedSend(session, {
      k: 'res',
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      code: 'handler-error',
    })
  }
}

function handlePaired(connection: WsConnection, frame: Extract<RemoteFrame, { t: 'pair' }>): void {
  if (!pairing) {
    fail(connection, 'pairing-closed', 'This Mac is not accepting new devices right now')
    return
  }
  if (Date.now() > pairing.expiresAt) {
    clearPairing()
    fail(connection, 'pairing-closed', 'The pairing code expired')
    return
  }
  if (typeof frame.code !== 'string' || !pairingCodeMatches(pairing.code, frame.code)) {
    fail(connection, 'bad-pairing-code', 'That pairing code is not correct')
    return
  }

  let publicKey: string
  try {
    publicKey = publicKeyToRaw(rawToPublicKey(frame.clientStaticPub)).toString('base64')
  } catch {
    fail(connection, 'bad-frame', 'The device sent an invalid key')
    return
  }

  const name = typeof frame.deviceName === 'string' && frame.deviceName.trim() ? frame.deviceName.trim().slice(0, 64) : 'iPhone'
  const platform = typeof frame.platform === 'string' ? frame.platform.trim().slice(0, 32) : ''

  const device = database.createRemoteDevice({ name, platform, publicKey })
  // Single use: a code that stays live is a code that gets shoulder-surfed.
  clearPairing()

  connection.send(JSON.stringify({
    t: 'paired',
    deviceId: device.id,
    serverStaticPub: settings.getRemoteServerKey().publicKey,
  }))
  connection.close()
  publishStatus()
}

function handleHello(connection: WsConnection, frame: Extract<RemoteFrame, { t: 'hello' }>): Session | null {
  const device = typeof frame.deviceId === 'string' ? database.getRemoteDeviceById(frame.deviceId) : null
  if (!device) {
    fail(connection, 'unknown-device', 'This device is not paired with this Mac')
    return null
  }

  const serverKey = settings.getRemoteServerKey()
  const ephemeral = generateEphemeralKeyPair()

  let clientEphemeralPub: Buffer
  let clientStaticPub: Buffer
  try {
    clientEphemeralPub = publicKeyToRaw(rawToPublicKey(frame.clientEphemeralPub))
    clientStaticPub = Buffer.from(device.publicKey, 'base64')
  } catch {
    fail(connection, 'bad-frame', 'The device sent an invalid key')
    return null
  }

  const serverEphemeralPub = publicKeyToRaw(ephemeral.publicKey)

  const keys = deriveSessionKeys({
    role: 'server',
    ephemeralPrivate: ephemeral.privateKey,
    staticPrivate: rawToPrivateKey(serverKey.privateKey),
    peerEphemeralPublic: rawToPublicKey(clientEphemeralPub),
    peerStaticPublic: rawToPublicKey(clientStaticPub),
    clientStaticPub,
    serverStaticPub: Buffer.from(serverKey.publicKey, 'base64'),
    clientEphemeralPub,
    serverEphemeralPub,
  })

  connection.send(JSON.stringify({ t: 'hello-ok', serverEphemeralPub: serverEphemeralPub.toString('base64') }))

  const destroyListeners = new Set<() => void>()
  const session: Session = {
    deviceId: device.id,
    connection,
    keys,
    sendCounter: 0,
    lastReceived: 0,
    sender: createSender(() => sessions.get(device.id), destroyListeners),
  }

  // One live session per device: a reconnect replaces the old socket rather
  // than leaving a dead one to receive every broadcast.
  sessions.get(device.id)?.connection.close()
  sessions.set(device.id, session)
  database.touchRemoteDevice(device.id)

  connection.onClose(() => {
    if (sessions.get(device.id) === session) sessions.delete(device.id)
    for (const listener of destroyListeners) {
      try {
        listener()
      } catch {
        // A cancel handler throwing must not block the rest.
      }
    }
    publishStatus()
  })

  publishStatus()
  return session
}

function onConnection(connection: WsConnection): void {
  let session: Session | null = null

  connection.onMessage((raw) => {
    let frame: RemoteFrame
    try {
      frame = JSON.parse(raw) as RemoteFrame
    } catch {
      fail(connection, 'bad-frame', 'Malformed frame')
      return
    }

    if (!frame || typeof frame !== 'object') {
      fail(connection, 'bad-frame', 'Malformed frame')
      return
    }

    if (frame.t === 'pair') {
      if (frame.v !== REMOTE_PROTOCOL_VERSION) {
        fail(connection, 'protocol-version', 'This app version cannot pair with this Mac')
        return
      }
      handlePaired(connection, frame)
      return
    }

    if (frame.t === 'hello') {
      if (session) {
        fail(connection, 'bad-frame', 'Already authenticated')
        return
      }
      if (frame.v !== REMOTE_PROTOCOL_VERSION) {
        fail(connection, 'protocol-version', 'This app version cannot talk to this Mac')
        return
      }
      session = handleHello(connection, frame)
      return
    }

    if (frame.t === 'msg') {
      if (!session) {
        fail(connection, 'not-authenticated', 'Say hello first')
        return
      }
      // Strictly increasing: a replayed or reordered frame is dropped with the
      // connection rather than re-executed.
      if (typeof frame.n !== 'number' || frame.n <= session.lastReceived) {
        fail(connection, 'bad-frame', 'Frame counter replay')
        return
      }

      let message: RemoteMessage
      try {
        message = JSON.parse(openSealed(session.keys.clientToServer, frame.n, frame.d).toString('utf8')) as RemoteMessage
      } catch {
        fail(connection, 'bad-frame', 'Frame failed authentication')
        return
      }
      session.lastReceived = frame.n

      if (message.k === 'ping') {
        sealedSend(session, { k: 'pong' })
        return
      }
      if (message.k === 'req') {
        void dispatch(session, message.id, message.channel, Array.isArray(message.args) ? message.args : [])
      }
      return
    }

    fail(connection, 'bad-frame', 'Unexpected frame')
  })
}

function forwardToDevices(channel: string, args: unknown[]): void {
  for (const session of sessions.values()) {
    sealedSend(session, { k: 'evt', channel, args })
  }
}

async function detectHost(): Promise<string> {
  if (detectedHost) return detectedHost

  for (const bin of TAILSCALE_PATHS) {
    try {
      const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 4000 })
      const parsed = JSON.parse(stdout) as { Self?: { DNSName?: string } }
      const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '')
      if (dnsName) {
        detectedHost = dnsName
        return dnsName
      }
    } catch {
      // Not installed at this path, or the tailnet is down. Try the next one.
    }
  }

  // Same-Wi-Fi fallback. ATS covers .local without a second exception.
  detectedHost = `${hostname().replace(/\.local$/, '')}.local`
  return detectedHost
}

function clearPairing(): void {
  pairing = null
  if (pairingTimer) {
    clearTimeout(pairingTimer)
    pairingTimer = null
  }
}

export function getStatus(): RemoteServerStatus {
  return {
    enabled: settings.isRemoteEnabled(),
    listening: server !== null,
    port: server?.port ?? settings.getRemotePort(),
    host: detectedHost,
    error: lastError,
    connectedDeviceIds: [...sessions.keys()],
    pairing: pairing ? { ...pairing } : null,
  }
}

function publishStatus(): void {
  broadcast(IPC.REMOTE.STATUS, getStatus())
}

export async function createPairingOffer(): Promise<RemotePairingOffer> {
  if (!server) throw new Error('Turn on remote access first')

  clearPairing()
  const host = await detectHost()
  const offer: RemotePairingOffer = {
    code: generatePairingCode(),
    expiresAt: Date.now() + REMOTE_PAIRING_CODE_TTL_MS,
    host,
    port: server.port,
    serverStaticPub: settings.getRemoteServerKey().publicKey,
  }

  pairing = offer
  pairingTimer = setTimeout(() => {
    clearPairing()
    publishStatus()
  }, REMOTE_PAIRING_CODE_TTL_MS)

  publishStatus()
  return offer
}

export function cancelPairingOffer(): void {
  clearPairing()
  publishStatus()
}

export function revokeDevice(deviceId: string): void {
  sessions.get(deviceId)?.connection.close()
  sessions.delete(deviceId)
  database.deleteRemoteDevice(deviceId)
  publishStatus()
}

export async function startRemoteServer(): Promise<void> {
  if (server || starting) {
    await starting
    return
  }

  starting = (async () => {
    try {
      server = await createWebSocketServer({
        port: settings.getRemotePort(),
        host: '::',
        path: REMOTE_WS_PATH,
        maxPayloadBytes: REMOTE_MAX_FRAME_BYTES,
        onConnection,
      })
      lastError = null
      setRemoteForwarder(forwardToDevices)
      void detectHost().then(() => publishStatus())
    } catch (error) {
      server = null
      lastError = error instanceof Error ? error.message : 'Could not start remote access'
    } finally {
      starting = null
      publishStatus()
    }
  })()

  await starting
}

export async function stopRemoteServer(): Promise<void> {
  clearPairing()
  setRemoteForwarder(null)
  for (const session of sessions.values()) session.connection.close()
  sessions.clear()

  const running = server
  server = null
  if (running) await running.close()
  publishStatus()
}

export async function setRemoteEnabled(enabled: boolean): Promise<RemoteServerStatus> {
  settings.setRemoteEnabled(enabled)
  if (enabled) await startRemoteServer()
  else await stopRemoteServer()
  return getStatus()
}

export async function initRemoteServer(): Promise<void> {
  if (settings.isRemoteEnabled()) await startRemoteServer()
}
