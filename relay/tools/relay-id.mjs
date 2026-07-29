// Generates a relay identity and answers a relay challenge, using nothing but
// Node's built-in crypto. This is the reference implementation of what
// src/main/relayClient.ts will do on the Mac, and it is here so the Worker can
// be exercised end to end before any desktop code exists.
//
//   node --experimental-strip-types tools/relay-id.mjs new
//   node --experimental-strip-types tools/relay-id.mjs sign <privB64url> <relayId> <nonce> <ts>
//   node --experimental-strip-types tools/relay-id.mjs connect <wss://host> [privB64url]

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { base32Encode } from '../src/base32.ts'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const AUTH_CONTEXT = 'holmes-relay-auth-v1'

const b64u = (buf) => Buffer.from(buf).toString('base64url')

function rawPublic(keyObject) {
  const der = keyObject.export({ type: 'spki', format: 'der' })
  return der.subarray(der.length - 32)
}

function rawPrivate(keyObject) {
  const der = keyObject.export({ type: 'pkcs8', format: 'der' })
  return der.subarray(der.length - 32)
}

function privateKeyFromRaw(raw) {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: 'der', type: 'pkcs8' })
}

function publicKeyFromRaw(raw) {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function relayIdFor(rawPub) {
  return base32Encode(new Uint8Array(createHash('sha256').update(rawPub).digest().subarray(0, 16)))
}

function loadOrCreate(privArg) {
  if (privArg) {
    const priv = privateKeyFromRaw(Buffer.from(privArg, 'base64url'))
    const pub = rawPublic(createPublicKey(priv))
    return { priv, rawPriv: Buffer.from(privArg, 'base64url'), pub }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { priv: privateKey, rawPriv: rawPrivate(privateKey), pub: rawPublic(publicKey) }
}

function answer(priv, relayId, nonce, ts) {
  return b64u(sign(null, Buffer.from(`${AUTH_CONTEXT}|${relayId}|${nonce}|${ts}`, 'utf8'), priv))
}

const [command, ...rest] = process.argv.slice(2)

if (command === 'new') {
  const { rawPriv, pub } = loadOrCreate()
  console.log('relayId   ', relayIdFor(pub))
  console.log('publicKey ', b64u(pub))
  console.log('privateKey', b64u(rawPriv))
} else if (command === 'sign') {
  const [privArg, relayId, nonce, ts] = rest
  const { priv } = loadOrCreate(privArg)
  console.log(answer(priv, relayId, nonce, ts))
} else if (command === 'connect') {
  const [base, privArg] = rest
  const { priv, rawPriv, pub } = loadOrCreate(privArg)
  const relayId = relayIdFor(pub)
  if (!privArg) console.log('privateKey', b64u(rawPriv))
  console.log('relayId   ', relayId)
  console.log('client url', `${base.replace(/\/$/, '')}/c/${relayId}`)

  const socket = new WebSocket(`${base.replace(/\/$/, '')}/s/${relayId}`)
  socket.binaryType = 'arraybuffer'

  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const frame = JSON.parse(event.data)
      if (frame.t === 'challenge') {
        socket.send(JSON.stringify({ t: 'auth', pub: b64u(pub), sig: answer(priv, relayId, frame.nonce, frame.ts) }))
      } else {
        console.log('control   ', event.data)
      }
      return
    }
    const bytes = new Uint8Array(event.data)
    const type = bytes[0]
    const sid = new DataView(event.data).getUint32(1, false)
    const body = Buffer.from(bytes.subarray(5)).toString('utf8')
    console.log('frame     ', { type, sid, body })
    // Echo, so a browser console pointed at the client URL proves the round trip.
    if (type === 0x02) socket.send(new Uint8Array(event.data))
  }

  socket.onclose = (event) => console.log('closed    ', event.code, event.reason)
  socket.onerror = () => console.log('socket error')
} else {
  console.log('usage: relay-id.mjs new | sign <priv> <relayId> <nonce> <ts> | connect <wss://host> [priv]')
}
