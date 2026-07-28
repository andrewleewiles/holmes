import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DateSighting } from './dating'

const execFileAsync = promisify(execFile)

// Every image is downscaled to this longest edge before it is encoded. This is
// the single biggest cost lever in a photo index: a 4048x3036 original costs
// roughly 16,000 image tokens, the same photo at 768px costs roughly 590. It
// also makes per-image cost near-constant, which is what lets the pre-flight
// estimate be accurate without opening every file.
export const PHOTO_MAX_EDGE = 768
export const PHOTO_JPEG_QUALITY = 70

// HEIC/HEIF are not decodable by Chromium, so they take the sips path. Every
// other supported format goes through nativeImage in-process.
const SIPS_ONLY_EXTENSIONS = new Set(['.heic', '.heif', '.tif', '.tiff'])

const SIPS_TIMEOUT_MS = 30_000

export interface EncodedImage {
  dataUrl: string
  bytes: number
  width: number
  height: number
}

export interface ImageMetadata {
  width: number | null
  height: number | null
  capturedAt: string | null
  cameraMake: string | null
  cameraModel: string | null
}

export function needsSipsDecode(filePath: string): boolean {
  return SIPS_ONLY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

// Estimated image tokens for a downscaled photo. Providers differ, but the
// width*height/750 rule is the common approximation and is what the pre-flight
// estimate is built on. Bounded by the downscale, so this is a real ceiling
// rather than an average.
export function estimateImageTokens(maxEdge: number = PHOTO_MAX_EDGE): number {
  return Math.ceil((maxEdge * maxEdge * 0.75) / 750)
}

function parseSipsProperties(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s{2}([a-zA-Z]+):\s*(.*)$/)
    if (match) out[match[1]] = match[2].trim()
  }
  return out
}

// EXIF capture dates arrive as "2018:12:24 15:17:02". This is a date stated
// inside the data itself, so per the dating contract it outranks both the file
// name and the file's mtime.
export function parseExifDate(raw: string | undefined): DateSighting | null {
  if (!raw) return null
  const match = raw.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})/)
  if (!match) return null
  const [, year, month, day] = match
  const yearNum = Number(year)
  const monthNum = Number(month)
  const dayNum = Number(day)
  if (yearNum < 1900 || yearNum > 2100) return null
  if (monthNum < 1 || monthNum > 12) return null
  if (dayNum < 1 || dayNum > 31) return null
  return { date: `${year}-${month}-${day}`, precision: 'day', raw: raw.trim() }
}

export async function readImageMetadata(filePath: string): Promise<ImageMetadata> {
  const empty: ImageMetadata = { width: null, height: null, capturedAt: null, cameraMake: null, cameraModel: null }
  try {
    const { stdout } = await execFileAsync('sips', ['-g', 'all', filePath], { timeout: SIPS_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    const props = parseSipsProperties(stdout)
    const width = Number(props.pixelWidth)
    const height = Number(props.pixelHeight)
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      capturedAt: props.creation || null,
      cameraMake: props.make || null,
      cameraModel: props.model || null,
    }
  } catch {
    return empty
  }
}

async function encodeViaSips(filePath: string, maxEdge: number): Promise<EncodedImage | null> {
  const scratch = path.join(
    os.tmpdir(),
    `holmes-photo-${crypto.randomBytes(8).toString('hex')}.jpg`
  )
  try {
    await execFileAsync(
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(PHOTO_JPEG_QUALITY), '-Z', String(maxEdge), filePath, '--out', scratch],
      { timeout: SIPS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )
    const buffer = await fs.promises.readFile(scratch)
    if (buffer.length === 0) return null
    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      bytes: buffer.length,
      width: maxEdge,
      height: maxEdge,
    }
  } catch {
    return null
  } finally {
    try { await fs.promises.unlink(scratch) } catch { /* Scratch file may not exist. */ }
  }
}

async function encodeViaNativeImage(filePath: string, maxEdge: number): Promise<EncodedImage | null> {
  try {
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromPath(filePath)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    const resized = longest > maxEdge
      ? image.resize(size.width >= size.height ? { width: maxEdge } : { height: maxEdge })
      : image
    const buffer = resized.toJPEG(PHOTO_JPEG_QUALITY)
    if (buffer.length === 0) return null
    const finalSize = resized.getSize()
    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      bytes: buffer.length,
      width: finalSize.width,
      height: finalSize.height,
    }
  } catch {
    return null
  }
}

// Decodes and downscales an image to a JPEG data URL ready for a vision model.
// Returns null when the file cannot be decoded at all, which the caller records
// as an unreadable-document sentinel rather than retrying.
export async function encodeImageForVlm(filePath: string, maxEdge: number = PHOTO_MAX_EDGE): Promise<EncodedImage | null> {
  if (needsSipsDecode(filePath)) {
    return encodeViaSips(filePath, maxEdge)
  }
  const viaNative = await encodeViaNativeImage(filePath, maxEdge)
  if (viaNative) return viaNative
  // nativeImage silently returns an empty image for formats Chromium cannot
  // decode (and is unavailable outside Electron), so sips is the fallback.
  return encodeViaSips(filePath, maxEdge)
}
