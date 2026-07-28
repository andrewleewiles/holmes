import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-remote-db-'))
process.env.HOLMES_USER_DATA = dbDir

const database = await import('./src/main/database.ts')
const settings = await import('./src/main/settings.ts')
const remoteServer = await import('./src/main/remoteServer.ts')
const { registerHandler, broadcast } = await import('./src/main/remoteBridge.ts')
const { IPC } = await import('./src/main/ipcChannels.ts')
const {
  deriveSessionKeys,
  generateEphemeralKeyPair,
  publicKeyToRaw,
  rawToPublicKey,
  rawToPrivateKey,
  seal,
  open: openSealed,
} = await import('./src/main/remoteCrypto.ts')
const { REMOTE_PROTOCOL_VERSION, REMOTE_WS_PATH, isRemoteCallable } = await import('./src/shared/remote.ts')

database.initDatabase()

const PORT = 45000 + Math.floor(Math.random() * 2000)
settings.setRemotePort(PORT)

// --- allowlist --------------------------------------------------------------

// The security property the whole subsystem rests on: default deny.
assert.equal(isRemoteCallable(IPC.CONVERSATIONS.LIST), true)
assert.equal(isRemoteCallable(IPC.CHAT.SEND), true)
// settings:get returns the provider API key and the web-search key.
assert.equal(isRemoteCallable(IPC.SETTINGS.GET), false)
assert.equal(isRemoteCallable(IPC.SETTINGS.SET_PROVIDER), false)
// Arbitrary filesystem write access to the Mac.
assert.equal(isRemoteCallable(IPC.FS.WRITE_FILE), false)
assert.equal(isRemoteCallable(IPC.FS.READ_FILE), false)
assert.equal(isRemoteCallable(IPC.LIBRARY.APPLY_ORGANIZE), false)
assert.equal(isRemoteCallable(IPC.APP.OPEN_EXTERNAL), false)
assert.equal(isRemoteCallable(IPC.RECALL.OPEN_FILE), false)
// A phone must not be able to pair another phone or undo a revocation.
assert.equal(isRemoteCallable(IPC.REMOTE.CREATE_PAIRING), false)
assert.equal(isRemoteCallable(IPC.REMOTE.REVOKE_DEVICE), false)

// --- test handlers ----------------------------------------------------------

let lastCallerId = null
registerHandler(IPC.CONVERSATIONS.LIST, (event) => {
  lastCallerId = event.sender.id
  return [{ id: 'c1', title: 'From the Mac' }]
})
registerHandler(IPC.MODELS.LIST, () => {
  throw new Error('Provider is not configured')
})
registerHandler(IPC.CONVERSATIONS.SEARCH, (event, query) => {
  event.sender.send('test:progress', { query })
  return [{ id: 'c1', snippet: query }]
})
// Registered but NOT allowlisted: the allowlist, not the registry, is what gates.
registerHandler(IPC.FS.WRITE_FILE, () => {
  throw new Error('this handler must never run for a remote caller')
})

// --- client ------------------------------------------------------------------

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${REMOTE_WS_PATH}`)
  const queue = []
  const waiters = []

  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data)
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })

  return {
    ws,
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    }),
    closed: new Promise((resolve) => ws.addEventListener('close', resolve)),
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: () =>
      new Promise((resolve) => {
        const queued = queue.shift()
        if (queued) resolve(queued)
        else waiters.push(resolve)
      }),
  }
}

function makeStaticKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKeyRaw: publicKeyToRaw(publicKey),
    privateKeyB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/** Mirrors what the mobile transport does, so the protocol is proven from both ends. */
async function openSession(deviceId, staticKeys, serverStaticPubB64) {
  const client = connect()
  await client.ready

  const ephemeral = generateEphemeralKeyPair()
  const clientEphemeralPub = publicKeyToRaw(ephemeral.publicKey)

  client.send({
    t: 'hello',
    v: REMOTE_PROTOCOL_VERSION,
    deviceId,
    clientEphemeralPub: clientEphemeralPub.toString('base64'),
  })

  const reply = await client.next()
  if (reply.t !== 'hello-ok') return { client, error: reply }

  const serverEphemeralPub = Buffer.from(reply.serverEphemeralPub, 'base64')
  const serverStaticPub = Buffer.from(serverStaticPubB64, 'base64')

  const keys = deriveSessionKeys({
    role: 'client',
    ephemeralPrivate: ephemeral.privateKey,
    staticPrivate: rawToPrivateKey(staticKeys.privateKeyB64),
    peerEphemeralPublic: rawToPublicKey(serverEphemeralPub),
    peerStaticPublic: rawToPublicKey(serverStaticPub),
    clientStaticPub: staticKeys.publicKeyRaw,
    serverStaticPub,
    clientEphemeralPub,
    serverEphemeralPub,
  })

  let counter = 0
  return {
    client,
    keys,
    sendSealed: (message) => {
      counter += 1
      client.send({ t: 'msg', n: counter, d: seal(keys.clientToServer, counter, Buffer.from(JSON.stringify(message))) })
      return counter
    },
    sendRaw: (n, message) => {
      client.send({ t: 'msg', n, d: seal(keys.clientToServer, n, Buffer.from(JSON.stringify(message))) })
    },
    receive: async () => {
      const frame = await client.next()
      if (frame.t !== 'msg') return frame
      return JSON.parse(openSealed(keys.serverToClient, frame.n, frame.d).toString('utf8'))
    },
  }
}

// --- start -------------------------------------------------------------------

await remoteServer.startRemoteServer()
const status = remoteServer.getStatus()
assert.equal(status.listening, true, 'server should be listening')
assert.equal(status.port, PORT)

// --- pairing -----------------------------------------------------------------

const offer = await remoteServer.createPairingOffer()
assert.equal(offer.code.length, 8)
assert.ok(offer.serverStaticPub)
// The host must be a name ATS can except, never a bare IP.
assert.ok(!/^[0-9.]+$/.test(offer.host), `pairing host must not be a bare IP, got ${offer.host}`)

const staticKeys = makeStaticKeyPair()

// A wrong code is refused and the offer survives for the real device.
{
  const client = connect()
  await client.ready
  client.send({
    t: 'pair',
    v: REMOTE_PROTOCOL_VERSION,
    code: 'WRONGCOD',
    clientStaticPub: staticKeys.publicKeyRaw.toString('base64'),
    deviceName: 'Attacker',
    platform: 'ios',
  })
  const reply = await client.next()
  assert.equal(reply.t, 'error')
  assert.equal(reply.code, 'bad-pairing-code')
  await client.closed
}
assert.equal(database.listRemoteDevices().length, 0, 'a bad code must not create a device')

// The real pairing.
let deviceId
{
  const client = connect()
  await client.ready
  client.send({
    t: 'pair',
    v: REMOTE_PROTOCOL_VERSION,
    code: offer.code,
    clientStaticPub: staticKeys.publicKeyRaw.toString('base64'),
    deviceName: "Andrew's iPhone",
    platform: 'ios',
  })
  const reply = await client.next()
  assert.equal(reply.t, 'paired')
  assert.equal(reply.serverStaticPub, offer.serverStaticPub)
  deviceId = reply.deviceId
  await client.closed
}

const devices = database.listRemoteDevices()
assert.equal(devices.length, 1)
assert.equal(devices[0].name, "Andrew's iPhone")
assert.equal(devices[0].id, deviceId)

// Single use: the same code cannot pair a second device.
{
  const second = makeStaticKeyPair()
  const client = connect()
  await client.ready
  client.send({
    t: 'pair',
    v: REMOTE_PROTOCOL_VERSION,
    code: offer.code,
    clientStaticPub: second.publicKeyRaw.toString('base64'),
    deviceName: 'Second phone',
    platform: 'ios',
  })
  const reply = await client.next()
  assert.equal(reply.t, 'error')
  assert.equal(reply.code, 'pairing-closed')
  await client.closed
}
assert.equal(database.listRemoteDevices().length, 1)

// --- session -----------------------------------------------------------------

const session = await openSession(deviceId, staticKeys, offer.serverStaticPub)
assert.ok(session.keys, 'handshake should have produced session keys')

// An allowlisted call round-trips, which also proves both sides derived the
// same keys from the handshake.
{
  const id = session.sendSealed({ k: 'req', id: 1, channel: IPC.CONVERSATIONS.LIST, args: [] })
  assert.equal(id, 1)
  const response = await session.receive()
  assert.equal(response.k, 'res')
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, [{ id: 'c1', title: 'From the Mac' }])
}

// The remote caller id is negative, so it can never collide with a webContents id.
assert.ok(lastCallerId < 0, `remote sender id should be negative, got ${lastCallerId}`)

// A denied channel is refused even though a handler is registered for it.
{
  session.sendSealed({ k: 'req', id: 2, channel: IPC.FS.WRITE_FILE, args: [{ path: '/etc/passwd', content: 'x' }] })
  const response = await session.receive()
  assert.equal(response.ok, false)
  assert.equal(response.code, 'channel-denied')
}
assert.equal(isRemoteCallable(IPC.SETTINGS.GET), false)
{
  session.sendSealed({ k: 'req', id: 3, channel: IPC.SETTINGS.GET, args: [] })
  const response = await session.receive()
  assert.equal(response.ok, false)
  assert.equal(response.code, 'channel-denied')
}

// A throwing handler returns the message rather than dropping the connection.
{
  session.sendSealed({ k: 'req', id: 4, channel: IPC.MODELS.LIST, args: [] })
  const response = await session.receive()
  assert.equal(response.ok, false)
  assert.equal(response.error, 'Provider is not configured')
  assert.equal(response.code, 'handler-error')
}

// event.sender.send reaches the device that made the call.
{
  session.sendSealed({ k: 'req', id: 5, channel: IPC.CONVERSATIONS.SEARCH, args: ['tailscale'] })
  const progress = await session.receive()
  assert.equal(progress.k, 'evt')
  assert.equal(progress.channel, 'test:progress')
  assert.deepEqual(progress.args, [{ query: 'tailscale' }])
  const response = await session.receive()
  assert.equal(response.ok, true)
}

// ping/pong keeps the socket warm.
{
  session.sendSealed({ k: 'ping' })
  const pong = await session.receive()
  assert.equal(pong.k, 'pong')
}

// --- broadcasts --------------------------------------------------------------

// An allowlisted broadcast reaches the phone.
{
  broadcast(IPC.CHAT.STREAM_CHUNK, { text: 'hello from the desktop', done: false })
  const event = await session.receive()
  assert.equal(event.k, 'evt')
  assert.equal(event.channel, IPC.CHAT.STREAM_CHUNK)
  assert.deepEqual(event.args, [{ text: 'hello from the desktop', done: false }])
}

// A channel not in REMOTE_EVENT_CHANNELS stays on the desktop. Proven by
// sending it first and then a forwarded one: only the second arrives.
{
  broadcast(IPC.REMOTE.STATUS, { enabled: true })
  broadcast(IPC.CONVERSATIONS.UPDATED)
  const event = await session.receive()
  assert.equal(event.channel, IPC.CONVERSATIONS.UPDATED, 'remote:status must not be forwarded to devices')
}

// --- replay ------------------------------------------------------------------

// A replayed counter drops the connection rather than re-running the call.
{
  session.sendRaw(1, { k: 'req', id: 99, channel: IPC.CONVERSATIONS.LIST, args: [] })
  const frame = await session.client.next()
  assert.equal(frame.t, 'error')
  assert.equal(frame.code, 'bad-frame')
  await session.client.closed
}

// --- unknown and revoked devices ---------------------------------------------

{
  const unknown = await openSession('00000000-0000-0000-0000-000000000000', staticKeys, offer.serverStaticPub)
  assert.equal(unknown.error.t, 'error')
  assert.equal(unknown.error.code, 'unknown-device')
  await unknown.client.closed
}

// A device holding the right key but the wrong one for this device id cannot
// derive the session keys, so its first sealed frame fails authentication.
{
  const impostorKeys = makeStaticKeyPair()
  const impostor = await openSession(deviceId, impostorKeys, offer.serverStaticPub)
  impostor.sendSealed({ k: 'req', id: 1, channel: IPC.CONVERSATIONS.LIST, args: [] })
  const frame = await impostor.client.next()
  assert.equal(frame.t, 'error')
  assert.equal(frame.code, 'bad-frame', 'a wrong static key must fail frame authentication')
  await impostor.client.closed
}

// Revocation kills the live socket, not just future connections.
{
  const live = await openSession(deviceId, staticKeys, offer.serverStaticPub)
  live.sendSealed({ k: 'req', id: 1, channel: IPC.CONVERSATIONS.LIST, args: [] })
  const ok = await live.receive()
  assert.equal(ok.ok, true)
  assert.equal(remoteServer.getStatus().connectedDeviceIds.length, 1)

  remoteServer.revokeDevice(deviceId)
  await live.client.closed
  assert.equal(database.listRemoteDevices().length, 0)
  assert.equal(remoteServer.getStatus().connectedDeviceIds.length, 0)

  const afterRevoke = await openSession(deviceId, staticKeys, offer.serverStaticPub)
  assert.equal(afterRevoke.error.code, 'unknown-device')
  await afterRevoke.client.closed
}

await remoteServer.stopRemoteServer()
assert.equal(remoteServer.getStatus().listening, false)

fs.rmSync(dbDir, { recursive: true, force: true })
console.log('test-remote: all assertions passed')
