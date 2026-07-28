/**
 * Reading an account export, which arrives either as a .zip or as the folder
 * the user already unzipped.
 *
 * `fflate`'s `unzipSync` decompresses the entire archive into memory at once.
 * That is fine for an Instagram or Tinder export and completely unworkable for
 * a Google Takeout archive, which routinely runs to tens of gigabytes. So the
 * zip path is capped, and past the cap the user is told to unzip it themselves
 * rather than being handed an out-of-memory crash.
 */

import fs from 'fs'
import path from 'path'
import { unzipSync, strFromU8 } from 'fflate'

/** Above this, a zip is refused and the unzipped folder is requested instead. */
export const MAX_ZIP_BYTES = 512 * 1024 * 1024

/** Per-entry cap, so one enormous member cannot blow the heap on its own. */
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024

export interface ExportSource {
  /** Entry paths relative to the archive or folder root, forward-slashed. */
  list(): string[]
  /** Reads one entry as UTF-8 text, or null if it is missing or too large. */
  readText(entry: string): string | null
  /**
   * Absolute path of an entry when it is a real file on disk, so a parser can
   * stream something too large to hold as a string. Null inside a zip, where
   * the bytes only exist in memory.
   */
  entryPath(entry: string): string | null
  /** Absolute path of the thing the user actually pointed at. */
  readonly rootPath: string
}

// Fields are declared and assigned explicitly rather than via constructor
// parameter properties: the test runner strips types without transforming, and
// parameter properties are the one TS-only syntax it cannot handle.
class FolderSource implements ExportSource {
  readonly rootPath: string
  private readonly entries: string[]

  constructor(rootPath: string, entries: string[]) {
    this.rootPath = rootPath
    this.entries = entries
  }

  list(): string[] {
    return this.entries
  }

  entryPath(entry: string): string | null {
    const resolved = path.resolve(this.rootPath, entry)
    // An entry path is derived from a walk of rootPath, but re-check anyway —
    // this is the only guard between a crafted name and a read outside the root.
    if (!resolved.startsWith(path.resolve(this.rootPath) + path.sep)) return null
    return resolved
  }

  readText(entry: string): string | null {
    const resolved = this.entryPath(entry)
    if (!resolved) return null
    try {
      if (fs.statSync(resolved).size > MAX_ENTRY_BYTES) return null
      return fs.readFileSync(resolved, 'utf8')
    } catch {
      return null
    }
  }
}

class ZipSource implements ExportSource {
  readonly rootPath: string
  private readonly files: Record<string, Uint8Array>

  constructor(rootPath: string, files: Record<string, Uint8Array>) {
    this.rootPath = rootPath
    this.files = files
  }

  list(): string[] {
    return Object.keys(this.files).filter((name) => !name.endsWith('/'))
  }

  /** Zip members have no path on disk — they only exist in memory. */
  entryPath(): string | null {
    return null
  }

  readText(entry: string): string | null {
    const data = this.files[entry]
    if (!data) return null
    if (data.length > MAX_ENTRY_BYTES) return null
    try {
      return strFromU8(data)
    } catch {
      return null
    }
  }
}

function walkFolder(root: string, maxEntries = 20_000): string[] {
  const out: string[] = []
  const queue: string[] = [root]
  const seen = new Set<string>()

  while (queue.length > 0 && out.length < maxEntries) {
    const dir = queue.shift()
    if (!dir) break
    let real: string
    try {
      real = fs.realpathSync(dir)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'))
        if (out.length >= maxEntries) break
      }
    }
  }

  return out
}

/**
 * Whether a file is a zip, by its first four bytes rather than its name.
 *
 * TikTok delivers its export as a bare UUID with no extension at all, and
 * browsers routinely strip or rename these downloads. Trusting the extension
 * means silently treating a zip as a single opaque file and reporting zero
 * events. The codebase already sniffs magic bytes this way for SQLite files in
 * `detectActivitySource`.
 */
export function isZipFile(filePath: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(4)
    const read = fs.readSync(fd, header, 0, 4, 0)
    if (read < 4) return false
    // "PK\x03\x04" for a normal archive; the other two are empty/spanned zips.
    return (
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      (header[2] === 0x03 || header[2] === 0x05 || header[2] === 0x07)
    )
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing useful to do if the descriptor is already gone.
      }
    }
  }
}

/**
 * Opens whatever the user pointed at. A single loose file (one MyActivity.json,
 * one data.json) is treated as a one-entry source so the parsers do not need a
 * separate code path for it.
 */
export function openExportSource(targetPath: string): ExportSource {
  const stat = fs.statSync(targetPath)

  if (stat.isDirectory()) {
    return new FolderSource(targetPath, walkFolder(targetPath))
  }

  if (isZipFile(targetPath)) {
    if (stat.size > MAX_ZIP_BYTES) {
      throw new Error(
        `This archive is ${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB, which is too large to unzip in memory. ` +
          'Unzip it yourself and point Holmes at the folder instead.'
      )
    }
    const files = unzipSync(new Uint8Array(fs.readFileSync(targetPath)))
    return new ZipSource(targetPath, files)
  }

  // A single file: its own parent is the root, and it is the only entry.
  const parent = path.dirname(targetPath)
  return new FolderSource(parent, [path.basename(targetPath)])
}

/** Case-insensitive suffix match over the entry list. */
export function findEntries(source: ExportSource, ...suffixes: string[]): string[] {
  const lowered = suffixes.map((s) => s.toLowerCase())
  return source.list().filter((entry) => {
    const name = entry.toLowerCase()
    return lowered.some((suffix) => name.endsWith(suffix))
  })
}

export function findEntry(source: ExportSource, ...suffixes: string[]): string | null {
  return findEntries(source, ...suffixes)[0] ?? null
}

/** Entries whose path contains all of the given fragments. */
export function findEntriesContaining(source: ExportSource, ...fragments: string[]): string[] {
  const lowered = fragments.map((f) => f.toLowerCase())
  return source.list().filter((entry) => {
    const name = entry.toLowerCase()
    return lowered.every((fragment) => name.includes(fragment))
  })
}

export function readJson<T>(source: ExportSource, entry: string): T | null {
  const text = source.readText(entry)
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * Meta's "Download Your Information" JSON stores UTF-8 bytes re-encoded as
 * latin-1 escapes, so "café" arrives as "cafÃ©" and every emoji becomes a run
 * of mojibake. Round-tripping through latin-1 puts it back. Harmless on text
 * that was never mangled, because the round trip is the identity for ASCII.
 */
export function fixMetaMojibake(value: string): string {
  if (!/[Â-Ãâ]/.test(value)) return value
  try {
    return Buffer.from(value, 'latin1').toString('utf8')
  } catch {
    return value
  }
}
