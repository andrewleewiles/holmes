import { x25519 } from '@noble/curves/ed25519'

const HKDF_INFO = 'holmes-remote-v1'
const TRANSCRIPT_LABEL = 'holmes-remote-transcript-v1'
const KEY_BYTES = 32

export interface SessionKeys {
  clientToServer: CryptoKey
  serverToClient: CryptoKey
}

export interface StaticKeyPair {
  publicKey: string
  privateKey: string
}

const encoder = new TextEncoder()

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * X25519 comes from @noble/curves rather than WebCrypto: WebKit only gained
 * X25519 in iOS 17, and a pure-JS implementation keeps the deployment target
 * where Capacitor puts it. AES-GCM and HKDF below are WebCrypto, which has had
 * both for years.
 */
export function generateStaticKeyPair(): StaticKeyPair {
  const privateKey = x25519.utils.randomPrivateKey()
  return {
    privateKey: toBase64(privateKey),
    publicKey: toBase64(x25519.getPublicKey(privateKey)),
  }
}

export function generateEphemeralKeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomPrivateKey()
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined))
}

/**
 * Mirrors deriveSessionKeys in src/main/remoteCrypto.ts. The two static-ephemeral
 * products are ordered by role, not by which side is computing them — ordering
 * them locally would give the two ends different keys.
 */
export async function deriveSessionKeys(params: {
  ephemeralPrivate: Uint8Array
  staticPrivate: Uint8Array
  peerEphemeralPublic: Uint8Array
  peerStaticPublic: Uint8Array
  clientStaticPub: Uint8Array
  serverStaticPub: Uint8Array
  clientEphemeralPub: Uint8Array
  serverEphemeralPub: Uint8Array
}): Promise<SessionKeys> {
  const ee = x25519.getSharedSecret(params.ephemeralPrivate, params.peerEphemeralPublic)
  const clientStaticServerEphemeral = x25519.getSharedSecret(params.staticPrivate, params.peerEphemeralPublic)
  const clientEphemeralServerStatic = x25519.getSharedSecret(params.ephemeralPrivate, params.peerStaticPublic)

  const transcript = await sha256([
    encoder.encode(TRANSCRIPT_LABEL),
    params.clientStaticPub,
    params.serverStaticPub,
    params.clientEphemeralPub,
    params.serverEphemeralPub,
  ])

  const ikm = new Uint8Array(ee.length + clientStaticServerEphemeral.length + clientEphemeralServerStatic.length)
  ikm.set(ee, 0)
  ikm.set(clientStaticServerEphemeral, ee.length)
  ikm.set(clientEphemeralServerStatic, ee.length + clientStaticServerEphemeral.length)

  const hkdfKey = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: transcript as BufferSource, info: encoder.encode(HKDF_INFO) },
      hkdfKey,
      KEY_BYTES * 2 * 8
    )
  )

  const importAes = (raw: Uint8Array): Promise<CryptoKey> =>
    crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])

  return {
    clientToServer: await importAes(okm.slice(0, KEY_BYTES)),
    serverToClient: await importAes(okm.slice(KEY_BYTES, KEY_BYTES * 2)),
  }
}

function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter))
  return nonce
}

export async function seal(key: CryptoKey, counter: number, plaintext: string): Promise<string> {
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceFor(counter) as BufferSource },
    key,
    encoder.encode(plaintext)
  )
  return toBase64(new Uint8Array(sealed))
}

export async function open(key: CryptoKey, counter: number, payload: string): Promise<string> {
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonceFor(counter) as BufferSource },
    key,
    fromBase64(payload) as BufferSource
  )
  return new TextDecoder().decode(opened)
}
