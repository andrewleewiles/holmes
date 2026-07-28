/**
 * Extracting message text from `message.attributedBody`.
 *
 * On modern macOS the Messages database mostly stops populating `message.text`:
 * in a real 285k-message library only ~30% of rows have it, and the other ~70%
 * carry the body solely in `attributedBody`. So a reader that only looks at
 * `text` silently loses most of the conversation — it does not error, it just
 * returns a third of the data.
 *
 * `attributedBody` is an NSArchiver "streamtyped" blob — the serialized
 * NSAttributedString. Fully decoding typedstream is a large job, but the part
 * that matters has a stable shape:
 *
 *     ... "NSString" <01 9x 84 01> 2b <length> <utf-8 bytes> ... "NSDictionary" ...
 *
 * The bytes between the class name and the `2b` type marker vary (they are
 * object-reference bookkeeping), so the marker is scanned for rather than
 * assumed at a fixed offset. Length is one byte when short, `81` + uint16LE
 * when longer, `82` + uint32LE for the rare very long message.
 *
 * The first NSString is the body; later ones are attribute names such as
 * `__kIMMessagePartAttributeName` and belong to the trailing NSDictionary.
 */

const CLASS_MARKER = Buffer.from('NSString', 'ascii')

/** Type marker introducing the string payload. */
const STRING_TYPE = 0x2b

/** How far past "NSString" the marker may sit before we give up. */
const MARKER_SEARCH_WINDOW = 16

/** Refuse absurd declared lengths rather than trying to allocate them. */
const MAX_DECODED_BYTES = 1 << 20

/**
 * Returns the message text, or null when the blob carries none — an
 * attachment-only message is the common case, not an error.
 */
export function decodeAttributedBody(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (!blob || blob.length === 0) return null
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)

  const classIndex = buffer.indexOf(CLASS_MARKER)
  if (classIndex === -1) return null

  // Scan for the type marker that follows the class name.
  let cursor = classIndex + CLASS_MARKER.length
  const limit = Math.min(cursor + MARKER_SEARCH_WINDOW, buffer.length)
  while (cursor < limit && buffer[cursor] !== STRING_TYPE) cursor += 1
  if (cursor >= limit) return null
  cursor += 1

  if (cursor >= buffer.length) return null

  let length = buffer[cursor]
  cursor += 1

  if (length === 0x81) {
    if (cursor + 2 > buffer.length) return null
    length = buffer.readUInt16LE(cursor)
    cursor += 2
  } else if (length === 0x82) {
    if (cursor + 4 > buffer.length) return null
    length = buffer.readUInt32LE(cursor)
    cursor += 4
  } else if (length >= 0x80) {
    // Any other high-bit value is a shape this decoder does not know.
    return null
  }

  if (length === 0 || length > MAX_DECODED_BYTES) return null
  if (cursor + length > buffer.length) return null

  const text = buffer.toString('utf8', cursor, cursor + length)
  return text.length > 0 ? text : null
}

/**
 * The body of a message row, preferring the plain column and falling back to
 * the archived one. Returns null when the message carries no text at all.
 */
export function messageBodyText(
  text: string | null | undefined,
  attributedBody: Buffer | Uint8Array | null | undefined
): string | null {
  if (typeof text === 'string' && text.length > 0) return text
  return decodeAttributedBody(attributedBody)
}
