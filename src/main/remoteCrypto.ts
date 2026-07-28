import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomInt,
  timingSafeEqual,
  type KeyObject,
} from 'crypto'
import { REMOTE_PAIRING_CODE_LENGTH } from '../shared/remote'

const HKDF_INFO = 'holmes-remote-v1'
const TRANSCRIPT_LABEL = 'holmes-remote-transcript-v1'
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Ambiguous glyphs removed: this gets read off one screen and typed into another. */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export interface KeyPairRaw {
  publicKey: string
  privateKey: string
}

export interface SessionKeys {
  clientToServer: Buffer
  serverToClient: Buffer
}

export function generateStaticKeyPair(): KeyPairRaw {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: publicKeyToRaw(publicKey).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

export function publicKeyToRaw(key: KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer
  return der.subarray(der.length - KEY_BYTES)
}

export function rawToPublicKey(raw: Buffer | string): KeyObject {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'base64') : raw
  if (bytes.length !== KEY_BYTES) throw new Error('Invalid public key')
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, bytes]),
    format: 'der',
    type: 'spki',
  })
}

export function rawToPrivateKey(base64: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(base64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}

export function generateEphemeralKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('x25519')
}

/**
 * Noise-KK shaped: the two ephemeral keys give forward secrecy, and mixing both
 * static keys in means a peer that does not hold the paired private key cannot
 * derive the same secret. A stolen session key therefore does not let anyone
 * impersonate the device on the next connection.
 */
export function deriveSessionKeys(params: {
  role: 'server' | 'client'
  ephemeralPrivate: KeyObject
  staticPrivate: KeyObject
  peerEphemeralPublic: KeyObject
  peerStaticPublic: KeyObject
  clientStaticPub: Buffer
  serverStaticPub: Buffer
  clientEphemeralPub: Buffer
  serverEphemeralPub: Buffer
}): SessionKeys {
  const ee = diffieHellman({ privateKey: params.ephemeralPrivate, publicKey: params.peerEphemeralPublic })

  // Ordered by role, not by which side is computing: "my static × their
  // ephemeral" is a different slot on each end, and mixing them in local order
  // would give the two peers different keys.
  const clientStaticServerEphemeral = params.role === 'server'
    ? diffieHellman({ privateKey: params.ephemeralPrivate, publicKey: params.peerStaticPublic })
    : diffieHellman({ privateKey: params.staticPrivate, publicKey: params.peerEphemeralPublic })

  const clientEphemeralServerStatic = params.role === 'server'
    ? diffieHellman({ privateKey: params.staticPrivate, publicKey: params.peerEphemeralPublic })
    : diffieHellman({ privateKey: params.ephemeralPrivate, publicKey: params.peerStaticPublic })

  const transcript = createHash('sha256')
    .update(TRANSCRIPT_LABEL)
    .update(params.clientStaticPub)
    .update(params.serverStaticPub)
    .update(params.clientEphemeralPub)
    .update(params.serverEphemeralPub)
    .digest()

  const ikm = Buffer.concat([ee, clientStaticServerEphemeral, clientEphemeralServerStatic])
  const okm = Buffer.from(hkdfSync('sha256', ikm, transcript, HKDF_INFO, KEY_BYTES * 2))

  return {
    clientToServer: okm.subarray(0, KEY_BYTES),
    serverToClient: okm.subarray(KEY_BYTES, KEY_BYTES * 2),
  }
}

function nonceFor(counter: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES)
  nonce.writeUInt32BE(0, 0)
  nonce.writeBigUInt64BE(BigInt(counter), 4)
  return nonce
}

export function seal(key: Buffer, counter: number, plaintext: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(counter))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()]).toString('base64')
}

export function open(key: Buffer, counter: number, payload: string): Buffer {
  const raw = Buffer.from(payload, 'base64')
  if (raw.length < TAG_BYTES) throw new Error('Frame is too short')
  const body = raw.subarray(0, raw.length - TAG_BYTES)
  const tag = raw.subarray(raw.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(counter))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export function generatePairingCode(): string {
  let code = ''
  for (let i = 0; i < REMOTE_PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
  }
  return code
}

export function pairingCodeMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
