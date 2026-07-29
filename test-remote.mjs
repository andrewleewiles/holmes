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
const remoteMedia = await import('./src/main/remoteMedia.ts')
const { registerHandler, broadcast, getHandler } = await import('./src/main/remoteBridge.ts')
const { IPC } = await import('./src/main/ipcChannels.ts')
const {
  guestReadingState,
  redactAudiobookForGuest,
  redactBookForGuest,
  redactLibraryBookForGuest,
} = await import('./src/shared/books.ts')
const {
  parseByteRange,
  encodeMediaTokenPayload,
  decodeMediaTokenPayload,
  isMediaKindAllowed,
  parseRemoteMediaPathname,
  REMOTE_MEDIA_TOKEN_PARAM,
} = await import('./src/shared/remoteMedia.ts')
const {
  deriveSessionKeys,
  generateEphemeralKeyPair,
  publicKeyToRaw,
  rawToPublicKey,
  rawToPrivateKey,
  derivePairingKeys,
  pairingBindTag,
  seal,
  open: openSealed,
} = await import('./src/main/remoteCrypto.ts')
const { REMOTE_PROTOCOL_VERSION, REMOTE_WS_PATH, isRemoteCallable, isRemoteEvent, MEDIA_CALLABLE_CHANNELS, OWNER_CALLABLE_CHANNELS } =
  await import('./src/shared/remote.ts')

database.initDatabase()

const PORT = 45000 + Math.floor(Math.random() * 2000)
settings.setRemotePort(PORT)

// --- allowlist --------------------------------------------------------------

// The security property the whole subsystem rests on: default deny.
assert.equal(isRemoteCallable(IPC.CONVERSATIONS.LIST, 'owner'), true)
assert.equal(isRemoteCallable(IPC.CHAT.SEND, 'owner'), true)
// settings:get returns the provider API key and the web-search key.
assert.equal(isRemoteCallable(IPC.SETTINGS.GET, 'owner'), false)
assert.equal(isRemoteCallable(IPC.SETTINGS.SET_PROVIDER, 'owner'), false)
// Arbitrary filesystem write access to the Mac.
assert.equal(isRemoteCallable(IPC.FS.WRITE_FILE, 'owner'), false)
assert.equal(isRemoteCallable(IPC.FS.READ_FILE, 'owner'), false)
assert.equal(isRemoteCallable(IPC.LIBRARY.APPLY_ORGANIZE, 'owner'), false)
assert.equal(isRemoteCallable(IPC.APP.OPEN_EXTERNAL, 'owner'), false)
assert.equal(isRemoteCallable(IPC.RECALL.OPEN_FILE, 'owner'), false)
// A phone must not be able to pair another phone or undo a revocation.
assert.equal(isRemoteCallable(IPC.REMOTE.CREATE_PAIRING, 'owner'), false)
assert.equal(isRemoteCallable(IPC.REMOTE.REVOKE_DEVICE, 'owner'), false)

// --- media scope -------------------------------------------------------------

// A guest device may read the shelf and a chapter, and nothing else.
for (const channel of [
  IPC.LIBRARY.LIST_BOOKS,
  IPC.LIBRARY.GET_BOOK,
  IPC.LIBRARY.GET_CHAPTER,
  IPC.LIBRARY.GET_RESOURCE,
  IPC.LIBRARY.LIST_AUDIOBOOKS,
  IPC.LIBRARY.GET_AUDIOBOOK,
  IPC.LIBRARY.GET_STATE,
  // Mints a signed URL for one resource the guest may already read.
  IPC.LIBRARY.GET_MEDIA_URL,
]) {
  assert.equal(isRemoteCallable(channel, 'media'), true, `${channel} should be callable by a media device`)
}

// The whole point of the split: a guest cannot name a personal-intelligence
// channel, so this list must never shrink.
for (const channel of [
  IPC.CONVERSATIONS.LIST,
  IPC.CONVERSATIONS.CREATE,
  IPC.CONVERSATIONS.GET_MESSAGES,
  IPC.CONVERSATIONS.SEARCH,
  IPC.CHAT.SEND,
  IPC.CHAT.PREVIEW_SYSTEM_PROMPT,
  IPC.MEMORY.LIST,
  IPC.MEMORY.GET,
  IPC.MEMORY.SUGGESTIONS,
  IPC.HEALTH.LIST_RECORDS,
  IPC.HEALTH.LIST_OBSERVATIONS,
  IPC.HEALTH.GET_SUMMARY,
  IPC.ACTIVITY.LIST_EVENTS,
  IPC.ACTIVITY.GET_SUMMARY,
  IPC.DOCUMENTS.GET_TREE,
  IPC.DOCUMENTS.GET_SUMMARIES,
  IPC.DOCUMENTS.GET_USER_CONTEXT,
  IPC.TIMELINE.LIST,
  IPC.TIMELINE.GET_SUMMARY,
  IPC.PEOPLE.LIST,
  IPC.PEOPLE.GET,
  IPC.RECALL.SEARCH,
  IPC.CONTEXT_VERSIONS.LIST,
  IPC.CONTEXT_VERSIONS.GET,
  IPC.ROLES.LIST,
  IPC.ROLES.GET_SESSION_NOTE,
  IPC.ROLES.LIST_SESSION_NOTES,
  IPC.CALL_HISTORY.LIST,
  IPC.CALL_HISTORY.STATS,
  IPC.PROVIDER_CREDIT.GET,
  IPC.PROJECTS.LIST,
  IPC.MODELS.LIST,
  // The owner's welcome lines, assistant name and model tiers.
  IPC.REMOTE.CLIENT_SETTINGS,
]) {
  // A typo'd constant is `undefined`, which every deny assertion below would
  // pass — so the name is checked before the rule is.
  assert.equal(typeof channel, 'string', 'channel constant does not exist')
  assert.equal(isRemoteCallable(channel, 'media'), false, `${channel} must be denied to a media device`)
  assert.equal(isRemoteCallable(channel, 'owner'), true, `${channel} should still be callable by the owner`)
}

// A guest's reading is not the owner's: the reading record reaches the life
// timeline, and every generate/estimate channel spends the owner's credit.
for (const channel of [
  IPC.LIBRARY.SET_READING_STATE,
  IPC.LIBRARY.RECORD_SESSION,
  IPC.LIBRARY.DELETE_BOOK,
  IPC.LIBRARY.SCAN,
  IPC.LIBRARY.GENERATE_ANNOTATIONS,
  IPC.LIBRARY.GENERATE_LESSON,
  IPC.LIBRARY.GENERATE_AUDIOBOOK,
  IPC.LIBRARY.REFRESH_SNAPSHOT,
  IPC.LIBRARY.SET_SPEECH_KEY,
  IPC.LIBRARY.APPLY_ORGANIZE,
  IPC.FS.READ_FILE,
  IPC.FS.WRITE_FILE,
  IPC.SETTINGS.GET,
  IPC.REMOTE.CREATE_PAIRING,
]) {
  assert.equal(typeof channel, 'string', 'channel constant does not exist')
  assert.equal(isRemoteCallable(channel, 'media'), false, `${channel} must be denied to a media device`)
}

// Owner is a superset, so nothing a guest may call is missing from it.
for (const channel of MEDIA_CALLABLE_CHANNELS) {
  assert.equal(OWNER_CALLABLE_CHANNELS.has(channel), true, `${channel} is media-callable but not owner-callable`)
}

// Broadcasts fan out to every connected device, so the scope has to hold there
// too: a guest must not receive the owner's chat stream.
assert.equal(isRemoteEvent(IPC.CHAT.STREAM_CHUNK, 'owner'), true)
assert.equal(isRemoteEvent(IPC.CHAT.STREAM_CHUNK, 'media'), false)
assert.equal(isRemoteEvent(IPC.CONVERSATIONS.UPDATED, 'media'), false)
assert.equal(isRemoteEvent(IPC.TIMELINE.STATE, 'media'), false)
assert.equal(isRemoteEvent(IPC.PEOPLE.STATE, 'media'), false)
assert.equal(isRemoteEvent(IPC.LIBRARY.STATE, 'media'), true)

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

// A shelf entry carrying everything a guest must not see: the owner's rating,
// their private note, their progress and dates, and the Mac's filesystem layout.
const OWNER_BOOK = {
  id: 'b1',
  projectId: 'library-project',
  sourcePath: '/Users/andrew/Library/Books',
  filePath: '/Users/andrew/Library/Books/melville/moby-dick.epub',
  relativePath: 'melville/moby-dick.epub',
  format: 'epub',
  identityHash: 'a1b2c3identity',
  textHash: 'd4e5f6text',
  fileSize: 918_273,
  title: 'Moby-Dick',
  subtitle: 'or, The Whale',
  authors: ['Herman Melville'],
  publisher: 'Harper & Brothers',
  publishedDate: '1851',
  language: 'en',
  identifier: 'isbn:9780000000000',
  subjects: ['Sea stories'],
  description: 'Call me Ishmael.',
  coverDataUrl: 'data:image/jpeg;base64,AAAA',
  chapterCount: 135,
  wordCount: 209_117,
  status: 'ready',
  scanError: null,
  missingSince: null,
  addedAt: 1,
  updatedAt: 2,
}
const OWNER_READING = {
  bookId: 'b1',
  status: 'finished',
  lastChapterIndex: 98,
  lastCharOffset: 700_000,
  furthestCharOffset: 700_000,
  progressPercent: 73,
  rating: 5,
  startedAt: '2026-01-04T09:00:00.000Z',
  finishedAt: '2026-03-03T22:41:00.000Z',
  secondsRead: 41_233,
  notes: 'Read this the winter my father was ill.',
  updatedAt: 3,
}
const OWNER_SHELF_ENTRY = { book: OWNER_BOOK, reading: OWNER_READING, lessonCount: 4, annotationCount: 61 }
const OWNER_AUDIOBOOK = {
  id: 'ab1',
  bookId: 'b1',
  chapterIndex: 0,
  provider: 'elevenlabs',
  voiceId: 'v1',
  voiceName: 'Reader',
  modelId: 'm1',
  textHash: 'd4e5f6text',
  charStart: 0,
  charEnd: 100,
  characterCount: 100,
  durationSeconds: 12,
  status: 'failed',
  error: 'You have exceeded your character limit for this billing period',
  createdAt: 1,
  updatedAt: 2,
}

// Mirrors the real handlers in ipc.ts: same helpers, same `media`-only
// condition. What this proves that a unit test cannot is that the scope reaches
// the handler at all, on a real session, for the device it belongs to.
registerHandler(IPC.LIBRARY.LIST_BOOKS, (event) =>
  event.remote?.scope === 'media' ? [redactLibraryBookForGuest(OWNER_SHELF_ENTRY)] : [OWNER_SHELF_ENTRY]
)
registerHandler(IPC.LIBRARY.GET_BOOK, (event) =>
  event.remote?.scope === 'media'
    ? { book: redactBookForGuest(OWNER_BOOK), chapters: [], reading: guestReadingState(OWNER_BOOK.id) }
    : { book: OWNER_BOOK, chapters: [], reading: OWNER_READING }
)
registerHandler(IPC.LIBRARY.LIST_AUDIOBOOKS, (event) =>
  event.remote?.scope === 'media' ? [redactAudiobookForGuest(OWNER_AUDIOBOOK)] : [OWNER_AUDIOBOOK]
)
registerHandler(IPC.LIBRARY.GET_CHAPTER, (_event, bookId, chapterIndex) => ({ bookId, chapterIndex, blocks: [] }))
// Mirrors the real minter: remote-only, and the device and scope come from the
// authenticated session rather than from anything the caller sent.
registerHandler(IPC.LIBRARY.GET_MEDIA_URL, (event, kind, id) => {
  if (!event.remote) throw new Error('Bulk media URLs are only issued to paired devices')
  return remoteMedia.mintMediaTicket({ kind, id, deviceId: event.remote.deviceId, scope: event.remote.scope })
})
// Personal-intelligence handlers that a media device must never reach. They are
// owner-callable, so only the scope check can stop them.
for (const channel of [IPC.HEALTH.GET_SUMMARY, IPC.MEMORY.LIST, IPC.REMOTE.CLIENT_SETTINGS]) {
  registerHandler(channel, () => {
    throw new Error(`${channel} must never run for a media device`)
  })
}

// --- guest redaction, as a pure function --------------------------------------

{
  const redacted = redactLibraryBookForGuest(OWNER_SHELF_ENTRY)

  // What survives: what is printed on the book, plus enough to read it.
  assert.equal(redacted.book.title, 'Moby-Dick')
  assert.equal(redacted.book.subtitle, 'or, The Whale')
  assert.deepEqual(redacted.book.authors, ['Herman Melville'])
  assert.equal(redacted.book.publisher, 'Harper & Brothers')
  assert.equal(redacted.book.publishedDate, '1851')
  assert.equal(redacted.book.language, 'en')
  assert.equal(redacted.book.format, 'epub')
  assert.equal(redacted.book.coverDataUrl, 'data:image/jpeg;base64,AAAA')
  assert.equal(redacted.book.chapterCount, 135)
  assert.equal(redacted.book.wordCount, 209_117)
  assert.equal(redacted.book.status, 'ready')

  // What does not: every path, and both hashes.
  for (const field of ['sourcePath', 'filePath', 'relativePath', 'identityHash', 'textHash']) {
    assert.equal(redacted.book[field], '', `${field} must be blanked for a guest`)
  }

  // The reading record is the owner's. A guest gets a neutral one, not a
  // filtered one: "73% read, finished 3 March" is a statement about the owner.
  assert.equal(redacted.reading.notes, '')
  assert.equal(redacted.reading.rating, null)
  assert.equal(redacted.reading.status, 'unread')
  assert.equal(redacted.reading.progressPercent, 0)
  assert.equal(redacted.reading.lastChapterIndex, 0)
  assert.equal(redacted.reading.furthestCharOffset, 0)
  assert.equal(redacted.reading.startedAt, null)
  assert.equal(redacted.reading.finishedAt, null)
  assert.equal(redacted.reading.secondsRead, 0)
  assert.equal(redacted.lessonCount, 0)
  assert.equal(redacted.annotationCount, 0)

  // A blanket check, so a field added to Book later cannot quietly reintroduce
  // the leak without this failing.
  const serialized = JSON.stringify(redacted)
  assert.ok(!serialized.includes('/Users/andrew'), 'no absolute path may survive redaction')
  assert.ok(!serialized.includes('a1b2c3identity'), 'the identity hash must not survive redaction')
  assert.ok(!serialized.includes('d4e5f6text'), 'the text hash must not survive redaction')
  assert.ok(!serialized.includes('my father'), "the owner's notes must not survive redaction")

  // Redaction copies; the owner's own row is untouched.
  assert.equal(OWNER_BOOK.filePath, '/Users/andrew/Library/Books/melville/moby-dick.epub')
  assert.equal(OWNER_READING.notes, 'Read this the winter my father was ill.')
  assert.equal(OWNER_SHELF_ENTRY.annotationCount, 61)

  const audiobook = redactAudiobookForGuest(OWNER_AUDIOBOOK)
  assert.equal(audiobook.textHash, '')
  // Provider errors quote the owner's plan and quota back at them.
  assert.ok(!audiobook.error.includes('billing'))
  assert.equal(redactAudiobookForGuest({ ...OWNER_AUDIOBOOK, error: null }).error, null)
}

// A renderer caller has no `remote` at all, so the desktop must be unaffected.
{
  const shelf = getHandler(IPC.LIBRARY.LIST_BOOKS)({ sender: { id: 1 } })
  assert.deepEqual(shelf, [OWNER_SHELF_ENTRY], 'a renderer call must keep its unredacted behaviour')
}

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

const offer = await remoteServer.createPairingOffer('owner')
assert.equal(offer.code.length, 8)
assert.equal(offer.scope, 'owner')
assert.ok(offer.serverStaticPub)
// The host must be a name ATS can except, never a bare IP.
assert.ok(!/^[0-9.]+$/.test(offer.host), `pairing host must not be a bare IP, got ${offer.host}`)


/**
 * Drives the v2 pairing exchange the way the phone does: pair-hello, verify the
 * bind tag against the code the user typed, then seal the code to the key that
 * tag vouched for. Returns the wire transcript so a test can assert what an
 * observer would have seen.
 */
async function attemptPair({ code, staticPub, deviceName = 'Test device', tamperKey = false, skipTagCheck = false }) {
  const client = connect()
  await client.ready
  const transcript = []

  const ephemeral = generateEphemeralKeyPair()
  const clientEphemeralPub = publicKeyToRaw(ephemeral.publicKey)

  const helloFrame = { t: 'pair-hello', v: REMOTE_PROTOCOL_VERSION, clientEphemeralPub: clientEphemeralPub.toString('base64') }
  transcript.push(JSON.stringify(helloFrame))
  client.send(helloFrame)

  const offerFrame = await client.next()
  transcript.push(JSON.stringify(offerFrame))
  if (offerFrame.t !== 'pair-offer') {
    await client.closed
    return { error: offerFrame, transcript }
  }

  // What an attacker in the path would try: swap in a key it holds the private
  // half of. The tag is computed over the key actually offered.
  const offered = tamperKey ? makeStaticKeyPair().publicKeyRaw : Buffer.from(offerFrame.serverStaticPub, 'base64')

  const expectedTag = pairingBindTag(code, offered, clientEphemeralPub)
  const tagOk = expectedTag === offerFrame.tag
  if (!tagOk && !skipTagCheck) {
    client.ws.close()
    await client.closed
    return { tagRejected: true, transcript }
  }

  const keys = derivePairingKeys({
    role: 'client',
    ephemeralPrivate: ephemeral.privateKey,
    peerPublic: rawToPublicKey(offered),
    serverStaticPub: offered,
    clientEphemeralPub,
  })

  const pairFrame = {
    t: 'pair',
    v: REMOTE_PROTOCOL_VERSION,
    d: seal(keys.clientToServer, 1, Buffer.from(JSON.stringify({
      code,
      clientStaticPub: staticPub.toString('base64'),
      deviceName,
      platform: 'ios',
    }), 'utf8')),
  }
  transcript.push(JSON.stringify(pairFrame))
  client.send(pairFrame)

  const reply = await client.next()
  transcript.push(JSON.stringify(reply))
  await client.closed

  if (reply.t !== 'paired') return { error: reply, transcript, tagOk }
  const payload = JSON.parse(openSealed(keys.serverToClient, 1, reply.d).toString('utf8'))
  return { payload, transcript, tagOk }
}

const staticKeys = makeStaticKeyPair()

// The attack the v2 exchange exists to stop: something on the path substitutes
// its own static key so it can hold both halves of every later session. It can
// only tag a key it substituted if it knows the code, and it does not.
{
  const result = await attemptPair({ code: offer.code, staticPub: staticKeys.publicKeyRaw, tamperKey: true })
  assert.equal(result.tagRejected, true, 'a substituted server key must fail the bind tag')
}
assert.equal(database.listRemoteDevices().length, 0, 'a substituted key must not create a device')

// A client that ignores the tag and seals to the impostor key cannot be paired
// either: the Mac cannot open a frame sealed to somebody else's key.
{
  const result = await attemptPair({
    code: offer.code, staticPub: staticKeys.publicKeyRaw, tamperKey: true, skipTagCheck: true,
  })
  assert.equal(result.error?.code, 'pair-untrusted', 'a frame sealed to the wrong key must not authenticate')
}
assert.equal(database.listRemoteDevices().length, 0)

// A wrong code is refused and the offer survives for the real device.
{
  const result = await attemptPair({ code: 'WRONGCOD', staticPub: staticKeys.publicKeyRaw, deviceName: 'Attacker' })
  // The tag is keyed by the code, so a wrong code fails before anything is sent.
  assert.equal(result.tagRejected, true)
}
assert.equal(database.listRemoteDevices().length, 0, 'a bad code must not create a device')

// The real pairing.
let deviceId
{
  const result = await attemptPair({ code: offer.code, staticPub: staticKeys.publicKeyRaw, deviceName: "Andrew's iPhone" })
  assert.equal(result.tagOk, true)
  assert.ok(result.payload, 'pairing should have produced a sealed reply')
  assert.equal(result.payload.serverStaticPub, offer.serverStaticPub)
  assert.equal(result.payload.scope, 'owner')
  deviceId = result.payload.deviceId

  // The whole point: the code never crosses the wire, so a relay or anything
  // else on the path cannot read it and pair itself.
  for (const frame of result.transcript) {
    assert.ok(!frame.includes(offer.code), 'the pairing code must never appear in cleartext on the wire')
  }
}

const devices = database.listRemoteDevices()
assert.equal(devices.length, 1)
assert.equal(devices[0].name, "Andrew's iPhone")
assert.equal(devices[0].id, deviceId)
// The scope is recorded on the row, so it survives a restart of the app.
assert.equal(devices[0].scope, 'owner')

// Single use: the same code cannot pair a second device.
{
  const second = makeStaticKeyPair()
  const result = await attemptPair({ code: offer.code, staticPub: second.publicKeyRaw, deviceName: 'Second phone' })
  assert.ok(result.error, 'the offer must be closed')
  assert.ok(['pairing-closed', 'pair-not-offered'].includes(result.error.code), result.error.code)
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

// The owner's own phone is not a guest: it gets the shelf exactly as the
// desktop sees it, redaction included in neither direction.
{
  session.sendSealed({ k: 'req', id: 100, channel: IPC.LIBRARY.LIST_BOOKS, args: [] })
  const response = await session.receive()
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, [OWNER_SHELF_ENTRY], 'an owner device must still receive everything')
  assert.equal(response.result[0].reading.notes, OWNER_READING.notes)
  assert.equal(response.result[0].reading.rating, 5)
  assert.equal(response.result[0].book.filePath, OWNER_BOOK.filePath)
}
{
  session.sendSealed({ k: 'req', id: 101, channel: IPC.LIBRARY.GET_BOOK, args: ['b1'] })
  const response = await session.receive()
  assert.equal(response.ok, true)
  assert.equal(response.result.book.identityHash, OWNER_BOOK.identityHash)
  assert.equal(response.result.reading.finishedAt, OWNER_READING.finishedAt)
}

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

// A channel not in OWNER_EVENT_CHANNELS stays on the desktop. Proven by
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

// --- a media-scoped guest device ---------------------------------------------

const mediaOffer = await remoteServer.createPairingOffer('media')
assert.equal(mediaOffer.scope, 'media')

const guestKeys = makeStaticKeyPair()
let guestId
{
  // The sealed payload carries no scope, and would be ignored if it did: the
  // offer the user created is what decides.
  const result = await attemptPair({
    code: mediaOffer.code, staticPub: guestKeys.publicKeyRaw, deviceName: "Guest's iPad",
  })
  assert.ok(result.payload, 'the guest should have paired')
  assert.equal(result.payload.scope, 'media')
  guestId = result.payload.deviceId
}

const guestDevices = database.listRemoteDevices()
assert.equal(guestDevices.length, 1)
assert.equal(guestDevices[0].id, guestId)
assert.equal(guestDevices[0].scope, 'media')

const guest = await openSession(guestId, guestKeys, mediaOffer.serverStaticPub)
assert.ok(guest.keys, 'the guest handshake should have produced session keys')

// Library browsing and reading work — and arrive redacted.
{
  guest.sendSealed({ k: 'req', id: 1, channel: IPC.LIBRARY.LIST_BOOKS, args: [] })
  const response = await guest.receive()
  assert.equal(response.ok, true, 'a media device must be able to list books')
  const [entry] = response.result
  assert.equal(entry.book.title, 'Moby-Dick', 'a guest still sees the shelf')
  assert.equal(entry.book.filePath, '', "a guest must not see the Mac's filesystem layout")
  assert.equal(entry.book.sourcePath, '')
  assert.equal(entry.book.identityHash, '')
  assert.equal(entry.book.textHash, '')
  assert.equal(entry.reading.notes, '', "a guest must not see the owner's notes")
  assert.equal(entry.reading.rating, null, "a guest must not see the owner's rating")
  assert.equal(entry.reading.progressPercent, 0, "a guest must not see the owner's progress")
  assert.equal(entry.reading.finishedAt, null)
  assert.ok(!JSON.stringify(response.result).includes('/Users/andrew'))
  assert.ok(!JSON.stringify(response.result).includes('my father'))
}
{
  guest.sendSealed({ k: 'req', id: 40, channel: IPC.LIBRARY.GET_BOOK, args: ['b1'] })
  const response = await guest.receive()
  assert.equal(response.ok, true)
  assert.equal(response.result.book.title, 'Moby-Dick')
  assert.equal(response.result.book.filePath, '')
  assert.equal(response.result.book.identityHash, '')
  assert.equal(response.result.reading.notes, '')
  assert.equal(response.result.reading.status, 'unread')
}
{
  guest.sendSealed({ k: 'req', id: 41, channel: IPC.LIBRARY.LIST_AUDIOBOOKS, args: ['b1'] })
  const response = await guest.receive()
  assert.equal(response.ok, true)
  assert.equal(response.result[0].textHash, '')
  assert.ok(!response.result[0].error.includes('billing'))
}
{
  guest.sendSealed({ k: 'req', id: 2, channel: IPC.LIBRARY.GET_CHAPTER, args: ['b1', 3] })
  const response = await guest.receive()
  assert.equal(response.ok, true, 'a media device must be able to read a chapter')
  assert.deepEqual(response.result, { bookId: 'b1', chapterIndex: 3, blocks: [] })
}

// Every personal channel is refused before the handler runs — each of these has
// a registered handler that throws if it is ever reached.
{
  let id = 10
  for (const channel of [
    IPC.HEALTH.GET_SUMMARY,
    IPC.MEMORY.LIST,
    IPC.CONVERSATIONS.LIST,
    IPC.CONVERSATIONS.SEARCH,
    IPC.CHAT.SEND,
    IPC.REMOTE.CLIENT_SETTINGS,
  ]) {
    id += 1
    guest.sendSealed({ k: 'req', id, channel, args: [] })
    const response = await guest.receive()
    assert.equal(response.ok, false, `${channel} must be refused for a media device`)
    assert.equal(response.code, 'channel-denied', `${channel} must be refused as channel-denied`)
    assert.equal(response.id, id)
  }
}

// A broadcast the owner scope forwards is withheld from the guest. Proven by
// sending it first and then a media event: only the second arrives.
{
  broadcast(IPC.CHAT.STREAM_CHUNK, { text: 'the owner is talking to the model', done: false })
  broadcast(IPC.LIBRARY.STATE, { status: 'idle' })
  const event = await guest.receive()
  assert.equal(event.k, 'evt')
  assert.equal(event.channel, IPC.LIBRARY.STATE, 'a media device must not receive the chat stream')
}

// --- bulk media: range serving on the same port -------------------------------

// The pure half first: parsing decides what the server answers, so it is worth
// pinning independently of a socket.
{
  const SIZE = 1000
  assert.deepEqual(parseByteRange(undefined, SIZE), { kind: 'full' })
  assert.deepEqual(parseByteRange('bytes=0-99', SIZE), { kind: 'range', range: { start: 0, end: 99 } })
  assert.deepEqual(parseByteRange('bytes=500-', SIZE), { kind: 'range', range: { start: 500, end: 999 } })
  assert.deepEqual(parseByteRange('bytes=-100', SIZE), { kind: 'range', range: { start: 900, end: 999 } })
  // Past the end is clamped, not refused: a client asking for more than exists
  // gets what exists.
  assert.deepEqual(parseByteRange('bytes=900-99999', SIZE), { kind: 'range', range: { start: 900, end: 999 } })
  assert.deepEqual(parseByteRange('bytes=1000-', SIZE), { kind: 'unsatisfiable' })
  assert.deepEqual(parseByteRange('bytes=-0', SIZE), { kind: 'unsatisfiable' })
  assert.deepEqual(parseByteRange('bytes=0-0', 0), { kind: 'unsatisfiable' })
  // Multi-range and unknown units are ignored, which RFC 7233 allows.
  assert.deepEqual(parseByteRange('bytes=0-9,20-29', SIZE), { kind: 'full' })
  assert.deepEqual(parseByteRange('items=0-9', SIZE), { kind: 'full' })
  assert.deepEqual(parseByteRange('bytes=nonsense', SIZE), { kind: 'full' })

  const payload = { v: 1, kind: 'segment', id: 's1', deviceId: 'd1', scope: 'media', exp: 42 }
  assert.deepEqual(decodeMediaTokenPayload(encodeMediaTokenPayload(payload)), payload)
  assert.equal(decodeMediaTokenPayload('1|book|a|b|media'), null, 'a short payload must not decode')
  assert.equal(decodeMediaTokenPayload('2|book|a|b|media|1'), null, 'a future version must not decode')
  assert.equal(decodeMediaTokenPayload('1|rom|a|b|media|1'), null, 'an unknown kind must not decode')
  // A field carrying the separator would let one payload be read as another.
  assert.throws(() => encodeMediaTokenPayload({ ...payload, id: 'a|b' }))

  // Media kinds are default-deny per scope, exactly like the channel allowlist.
  assert.equal(isMediaKindAllowed('book', 'media'), true)
  assert.equal(isMediaKindAllowed('segment', 'media'), true)
  assert.equal(isMediaKindAllowed('rom', 'media'), false)

  // The URL names a resource, never a location. Anything shaped like a path is
  // refused before it reaches a lookup.
  assert.deepEqual(parseRemoteMediaPathname('/holmes/media/book/b1'), { kind: 'book', id: 'b1' })
  assert.equal(parseRemoteMediaPathname('/holmes'), null)
  assert.equal(parseRemoteMediaPathname('/holmes/media/rom/x'), null)
  assert.equal(parseRemoteMediaPathname('/holmes/media/book/a/b'), null)
  assert.equal(parseRemoteMediaPathname(`/holmes/media/book/${encodeURIComponent('../../health.db')}`), null)
}

const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-remote-lib-'))
const secretRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-remote-secret-'))
const secretFile = path.join(secretRoot, 'health.db')
fs.writeFileSync(secretFile, 'PRIVATE-HEALTH-RECORD')

const BOOK_BYTES = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251))
const bookFile = path.join(libraryRoot, 'moby-dick.epub')
fs.writeFileSync(bookFile, BOOK_BYTES)

settings.setFileAccessScope({ mode: 'custom', roots: [libraryRoot] })

const libraryProject = database.listProjects().find((project) => project.kind === 'library')
assert.ok(libraryProject, 'initDatabase seeds a library project')
database.addProjectSource(libraryProject.id, libraryRoot)

function shelveBook(filePath) {
  return database.upsertBook({
    projectId: libraryProject.id,
    sourcePath: libraryRoot,
    filePath,
    relativePath: path.basename(filePath),
    format: 'epub',
    identityHash: `identity-${path.basename(filePath)}`,
    textHash: 'text',
    fileSize: 0,
    title: path.basename(filePath),
    subtitle: null,
    authors: [],
    publisher: null,
    publishedDate: null,
    language: null,
    identifier: null,
    subjects: [],
    description: null,
    coverDataUrl: null,
    chapterCount: 1,
    wordCount: 1,
    status: 'ready',
    scanError: null,
  })
}

const shelvedBook = shelveBook(bookFile)

// The real ipc.ts SET_PROGRESS handler is not loaded here (it would drag in the
// whole app), so this stub reproduces its scope branch verbatim. What that
// leaves untested is the branch itself; the database layer, the scope plumbing
// and the transport below are the real thing.
registerHandler(IPC.LIBRARY.SET_PROGRESS, (event, bookId, chapterIndex, charOffset) => {
  if (event.remote?.scope === 'media') {
    const offset = Math.max(0, Math.trunc(charOffset))
    return database.setDeviceReadingProgress(event.remote.deviceId, bookId, {
      lastChapterIndex: Math.max(0, Math.trunc(chapterIndex)),
      lastCharOffset: offset,
      furthestCharOffset: offset,
      progressPercent: 0,
    })
  }
  throw new Error('the owner path must not run for a guest')
})

registerHandler(IPC.LIBRARY.GET_BOOK, (event, bookId) => {
  const mine = event.remote?.scope === 'media'
    ? database.getDeviceReadingState(event.remote.deviceId, bookId)
    : null
  return { book: { id: bookId }, chapters: [], reading: mine ?? guestReadingState(bookId) }
})

// A guest keeps their OWN place in a shared book, and the owner's row is not
// touched. This is the one write a media device is allowed, and the whole reason
// it is allowed is the scope branch inside the handler.
{
  const ownerBefore = database.ensureReadingState(shelvedBook.id)

  guest.sendSealed({ k: 'req', id: 30, channel: IPC.LIBRARY.SET_PROGRESS, args: [shelvedBook.id, 3, 120] })
  const response = await guest.receive()
  assert.equal(response.ok, true, 'a guest may record their own position')
  assert.equal(response.result.lastChapterIndex, 3)
  assert.equal(response.result.lastCharOffset, 120)
  // Never the owner's editorial fields, even on a row the guest owns.
  assert.equal(response.result.rating, null)
  assert.equal(response.result.notes, '')

  // The owner's record is untouched: same row, same values, same timestamp.
  const ownerAfter = database.ensureReadingState(shelvedBook.id)
  assert.deepEqual(ownerAfter, ownerBefore, "a guest's reading must not move the owner's record")

  // Stored against the device, and reflected back to that device only.
  const stored = database.getDeviceReadingState(guestId, shelvedBook.id)
  assert.equal(stored.lastCharOffset, 120)

  guest.sendSealed({ k: 'req', id: 31, channel: IPC.LIBRARY.GET_BOOK, args: [shelvedBook.id] })
  const reopened = await guest.receive()
  assert.equal(reopened.result.reading.lastCharOffset, 120, 'the guest resumes where they left off')
  assert.equal(reopened.result.reading.rating, null)

  // Monotonic for a guest too: paging back must not lose their furthest point.
  guest.sendSealed({ k: 'req', id: 32, channel: IPC.LIBRARY.SET_PROGRESS, args: [shelvedBook.id, 1, 10] })
  const back = await guest.receive()
  assert.equal(back.result.lastCharOffset, 10)
  assert.equal(back.result.furthestCharOffset, 120, 'furthest progress is monotonic')
}

// Two guests do not share a place in the same book.
{
  const otherKeys = makeStaticKeyPair()
  const otherOffer = await remoteServer.createPairingOffer('media')
  const otherPaired = await attemptPair({ code: otherOffer.code, staticPub: otherKeys.publicKeyRaw, deviceName: 'Second guest' })
  const otherId = otherPaired.payload.deviceId

  assert.equal(database.getDeviceReadingState(otherId, shelvedBook.id), null, 'a new guest starts unstarted')
  database.setDeviceReadingProgress(otherId, shelvedBook.id, {
    lastChapterIndex: 9, lastCharOffset: 900, furthestCharOffset: 900, progressPercent: 50,
  })
  assert.equal(database.getDeviceReadingState(guestId, shelvedBook.id).lastCharOffset, 10, 'the first guest is unaffected')

  // Revoking a device takes its reading history with it.
  remoteServer.revokeDevice(otherId)
  assert.equal(database.getDeviceReadingState(otherId, shelvedBook.id), null, 'revocation cascades the reading state away')
}


// A row whose file sits outside every connected source root. Shelf rows outlive
// their source, so this is a real state and not a contrived one.
const strayBook = shelveBook(secretFile)

const ticket = remoteMedia.mintMediaTicket({ kind: 'book', id: shelvedBook.id, deviceId: guestId, scope: 'media' })
assert.equal(ticket.byteSize, BOOK_BYTES.length)
assert.equal(ticket.contentType, 'application/epub+zip')
// Bulk media must not be proxied through a future relay, so the URL is absolute
// against the Mac's own direct address rather than relative to the connection.
assert.equal(ticket.directOnly, true)
assert.ok(/^http:\/\/[^/]+:\d+\/holmes\/media\/book\//.test(ticket.url), `unexpected media url ${ticket.url}`)
assert.ok(ticket.url.includes(`:${PORT}/`), 'a media url must point at the direct port')
assert.ok(ticket.expiresAt > Date.now())

const ticketUrl = new URL(ticket.url)
const token = ticketUrl.searchParams.get(REMOTE_MEDIA_TOKEN_PARAM)
assert.ok(token, 'the url must carry a token')
// The tailnet name is not resolvable from the test, so requests go to the
// loopback address the server is also listening on.
const mediaUrl = (pathname, search = `?${REMOTE_MEDIA_TOKEN_PARAM}=${encodeURIComponent(token)}`) =>
  `http://127.0.0.1:${PORT}${pathname}${search}`

/** Every body is consumed: an undici response left open holds a socket, and a
 *  held socket keeps the test process alive after the last assertion. */
async function get(url, init) {
  const response = await fetch(url, init)
  const body = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, body }
}
const bookPathname = ticketUrl.pathname

// A book whose file left the connected roots cannot be minted at all.
assert.throws(
  () => remoteMedia.mintMediaTicket({ kind: 'book', id: strayBook.id, deviceId: guestId, scope: 'media' }),
  /No such media/
)

// The client's real route to a URL: an RPC over the sealed socket. The guest
// names only the id — the device and the scope come from the session.
{
  guest.sendSealed({ k: 'req', id: 50, channel: IPC.LIBRARY.GET_MEDIA_URL, args: ['book', shelvedBook.id] })
  const response = await guest.receive()
  assert.equal(response.ok, true, 'a media device must be able to mint a media url')
  assert.equal(response.result.kind, 'book')
  assert.equal(response.result.id, shelvedBook.id)
  assert.equal(response.result.byteSize, BOOK_BYTES.length)
  assert.equal(response.result.directOnly, true)
  const minted = new URL(response.result.url)
  const fetched = await get(
    `http://127.0.0.1:${PORT}${minted.pathname}${minted.search}`
  )
  assert.equal(fetched.status, 200)
  assert.ok(fetched.body.equals(BOOK_BYTES), 'a URL minted over the socket must serve the file')
}

// A guest cannot mint for a kind it does not hold.
{
  guest.sendSealed({ k: 'req', id: 51, channel: IPC.LIBRARY.GET_MEDIA_URL, args: ['rom', shelvedBook.id] })
  const response = await guest.receive()
  assert.equal(response.ok, false, 'an unknown media kind must be refused')
}

// Full body.
{
  const response = await get(mediaUrl(bookPathname))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('content-type'), 'application/epub+zip')
  assert.equal(response.headers.get('content-length'), String(BOOK_BYTES.length))
  assert.ok(response.headers.get('etag'), 'an entity needs a validator')
  assert.ok(response.headers.get('last-modified'))
  const body = response.body
  assert.ok(body.equals(BOOK_BYTES), 'the whole file must round-trip byte for byte')
}

// HEAD: the same headers, no body. This is what a player asks first.
{
  const response = await get(mediaUrl(bookPathname), { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), String(BOOK_BYTES.length))
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.body.length, 0)
}

// A byte range: 206, the right slice, and a Content-Range that agrees with it.
{
  const response = await get(mediaUrl(bookPathname), { headers: { Range: 'bytes=1000-1999' } })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), `bytes 1000-1999/${BOOK_BYTES.length}`)
  assert.equal(response.headers.get('content-length'), '1000')
  const body = response.body
  assert.ok(body.equals(BOOK_BYTES.subarray(1000, 2000)), 'a range must return exactly that range')
}
{
  const response = await get(mediaUrl(bookPathname), { headers: { Range: 'bytes=-64' } })
  assert.equal(response.status, 206)
  const body = response.body
  assert.ok(body.equals(BOOK_BYTES.subarray(BOOK_BYTES.length - 64)), 'a suffix range must return the tail')
}

// Unsatisfiable: 416, and the size so the client can correct itself.
{
  const response = await get(mediaUrl(bookPathname), { headers: { Range: `bytes=${BOOK_BYTES.length}-` } })
  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), `bytes */${BOOK_BYTES.length}`)
}

// A matching validator means the client already has the bytes.
{
  const head = await get(mediaUrl(bookPathname), { method: 'HEAD' })
  const response = await get(mediaUrl(bookPathname), { headers: { 'If-None-Match': head.headers.get('etag') } })
  assert.equal(response.status, 304)
}

// --- media token auth ----------------------------------------------------------

// No token at all. The socket session proves identity; an HTTP request proves
// nothing, so it must carry its own credential.
assert.equal((await get(mediaUrl(bookPathname, ''))).status, 401)
// Garbage, and a real payload with a forged signature.
assert.equal((await get(mediaUrl(bookPathname, `?${REMOTE_MEDIA_TOKEN_PARAM}=nonsense`))).status, 403)
{
  const forged = `${token.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
  assert.equal((await get(mediaUrl(bookPathname, `?${REMOTE_MEDIA_TOKEN_PARAM}=${forged}`))).status, 403)
}
// Expired.
{
  const expired = remoteMedia.mintMediaToken({
    v: 1, kind: 'book', id: shelvedBook.id, deviceId: guestId, scope: 'media', exp: Date.now() - 1,
  })
  assert.equal((await get(mediaUrl(bookPathname, `?${REMOTE_MEDIA_TOKEN_PARAM}=${encodeURIComponent(expired)}`))).status, 403)
}
// Minted for another device — including one that has been revoked.
{
  const wrongDevice = remoteMedia.mintMediaToken({
    v: 1, kind: 'book', id: shelvedBook.id, deviceId, scope: 'media', exp: Date.now() + 60_000,
  })
  assert.equal((await get(mediaUrl(bookPathname, `?${REMOTE_MEDIA_TOKEN_PARAM}=${encodeURIComponent(wrongDevice)}`))).status, 403)
}
// Claiming a scope the device does not hold.
{
  const wrongScope = remoteMedia.mintMediaToken({
    v: 1, kind: 'book', id: shelvedBook.id, deviceId: guestId, scope: 'owner', exp: Date.now() + 60_000,
  })
  assert.equal((await get(mediaUrl(bookPathname, `?${REMOTE_MEDIA_TOKEN_PARAM}=${encodeURIComponent(wrongScope)}`))).status, 403)
}
// Repointed: a valid token for one resource, presented against another. Without
// the id in the signed payload a signature would only prove "some token exists".
assert.equal((await get(mediaUrl(`/holmes/media/book/${strayBook.id}`))).status, 403)
assert.equal((await get(mediaUrl(`/holmes/media/segment/${shelvedBook.id}`))).status, 403)

// --- path traversal --------------------------------------------------------------

// The endpoint addresses resources by id, so there is no root to escape from: a
// path-shaped id is a lookup that finds no row.
for (const attempt of [
  `/holmes/media/book/${encodeURIComponent('../../../health.db')}`,
  `/holmes/media/book/${encodeURIComponent(secretFile)}`,
  '/holmes/media/book/..%2F..%2F..%2Fetc%2Fpasswd',
  `/holmes/media/file/${encodeURIComponent(secretFile)}`,
  `/holmes/media/book/${shelvedBook.id}/../../../etc/passwd`,
]) {
  const response = await get(mediaUrl(attempt))
  assert.ok(
    [403, 404, 426].includes(response.status),
    `${attempt} should be refused, got ${response.status}`
  )
  const body = response.body.toString('utf8')
  assert.ok(!body.includes('PRIVATE-HEALTH-RECORD'), `${attempt} must not serve a file outside the Library`)
}

// A path the media endpoint does not claim still gets the old answer, so adding
// HTTP has not widened what the port serves.
assert.equal((await get(`http://127.0.0.1:${PORT}/`)).status, 426)
assert.equal((await get(`http://127.0.0.1:${PORT}${REMOTE_WS_PATH}`)).status, 426)
assert.equal((await get(mediaUrl(bookPathname), { method: 'POST' })).status, 405)

// Narrowing the file access scope revokes outstanding URLs, because the path is
// re-checked on every request rather than trusted from the row.
{
  settings.setFileAccessScope({ mode: 'custom', roots: [] })
  assert.equal((await get(mediaUrl(bookPathname))).status, 404)
  settings.setFileAccessScope({ mode: 'custom', roots: [libraryRoot] })
  assert.equal((await get(mediaUrl(bookPathname))).status, 200)
}

remoteServer.revokeDevice(guestId)
await guest.client.closed

// Revoking the device kills its outstanding URLs too: the device row is re-read
// on every request, not captured into the token.
assert.equal((await get(mediaUrl(bookPathname))).status, 403)

await remoteServer.stopRemoteServer()
assert.equal(remoteServer.getStatus().listening, false)

// Minting needs a running server: the signing key lives for one run only, so
// turning remote access off invalidates every URL that was handed out.
assert.throws(
  () => remoteMedia.mintMediaTicket({ kind: 'book', id: shelvedBook.id, deviceId: guestId, scope: 'media' }),
  /not running/
)

fs.rmSync(libraryRoot, { recursive: true, force: true })
fs.rmSync(secretRoot, { recursive: true, force: true })
fs.rmSync(dbDir, { recursive: true, force: true })
console.log('test-remote: all assertions passed')
