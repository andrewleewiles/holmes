/**
 * The relay's own wire format. It exists only on the server leg (relay <-> Mac),
 * because one physical socket there carries every phone's stream. On the client
 * leg (relay <-> phone) nothing is added: a phone's message is forwarded byte
 * for byte, and the relay never looks inside it.
 *
 * Server-leg frame: [type u8][streamId u32 BE][payload...]
 * The 5-byte header is the ONLY thing the relay parses, and it is the relay's
 * own header, not Holmes'.
 */

export const FRAME_OPEN = 0x01
export const FRAME_DATA_TEXT = 0x02
export const FRAME_DATA_BINARY = 0x03
export const FRAME_CLOSE = 0x04

export const HEADER_BYTES = 5

/**
 * Cloudflare caps a WebSocket message at 1 MiB, so this is a platform limit, not
 * a policy choice. Holmes' own REMOTE_MAX_FRAME_BYTES is 8 MiB — see docs/relay.md
 * for what the desktop and phone must do about the gap.
 */
export const MAX_MESSAGE_BYTES = 1024 * 1024
export const MAX_PAYLOAD_BYTES = MAX_MESSAGE_BYTES - HEADER_BYTES

export function encodeFrame(type: number, streamId: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  out[0] = type
  new DataView(out.buffer).setUint32(1, streamId >>> 0, false)
  out.set(payload, HEADER_BYTES)
  return out.buffer
}

export function decodeFrame(data: ArrayBuffer): { type: number; streamId: number; payload: Uint8Array } | null {
  if (data.byteLength < HEADER_BYTES) return null
  const bytes = new Uint8Array(data)
  return {
    type: bytes[0],
    streamId: new DataView(data).getUint32(1, false),
    payload: bytes.subarray(HEADER_BYTES),
  }
}

/** Close codes. 4xxx is the range WebSocket reserves for the application. */
export const CLOSE_REPLACED = 4001
export const CLOSE_PROTOCOL = 4002
export const CLOSE_AUTH_FAILED = 4003
export const CLOSE_NO_SERVER = 4004
export const CLOSE_BUSY = 4008
export const CLOSE_TOO_LARGE = 4009
export const CLOSE_IDLE = 4010
export const CLOSE_QUOTA = 4029
