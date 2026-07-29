const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * RFC 4648 base32, lowercase, unpadded. Used for the relay identifier because it
 * survives a QR round-trip, a URL path, and being read aloud without the
 * case-folding and `+/` problems of base64url.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function isRelayId(value: string): boolean {
  return /^[a-z2-7]{26}$/.test(value)
}

/** relayId = base32(sha256(ed25519 public key)[0..16]) — 128 bits. */
export async function relayIdFromPublicKey(publicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', publicKey as BufferSource)
  return base32Encode(new Uint8Array(digest).subarray(0, 16))
}
