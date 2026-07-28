// Filing books into `[Author Last Name] - [Book Title]` folders.
//
// Two things make this more than a rename:
//
// 1. **The name has to be derived, not read off.** EPUB metadata is written by
//    whoever made the file: authors arrive as "Orwell, George", "George Orwell",
//    "orwell,george" or inside a publisher string; titles carry subtitles,
//    series numbers and "(Retail) (v3.1)". So the folder name comes from an LLM
//    call over the metadata, which is what the user asked for — and it is why
//    this is an explicit action rather than something the background scan does.
//
// 2. **It moves the user's actual files.** Everything here is planned first and
//    applied second, never leaves the connected source root, never overwrites,
//    and reports what it skipped.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
export type { OrganizePlan, OrganizeResult }
import type { Book, OrganizePlan, OrganizePlanEntry, OrganizeResult, ProviderConfig } from '../shared/types'
import * as database from './database'
import { callLLMRetrying, type SpendTracker } from './llmCall'
import { hasProviderCredentials, missingCredentialsError } from './providerEndpoint'
import type { RateLimiter } from './rateLimit'

export const ORGANIZE_PROMPT_VERSION = 'v1-author-title-folder'

/** How many books one call describes. Enough to be cheap, small enough to parse. */
const BATCH_SIZE = 40
/** Filesystems dislike very long components, and so do people. */
const MAX_FOLDER_NAME = 90

const ORGANIZE_SYSTEM_PROMPT = `You are tidying an e-book library. For each book you are given the metadata as it appears in the file — which is often messy, inconsistent, or wrong — and the filename it currently has.

For each one, produce the folder name it should live in, in exactly this form:

<Author Last Name> - <Book Title>

Rules:
- AUTHOR: use the primary author's LAST NAME only, correctly capitalised. Metadata arrives in every shape: "Orwell, George", "george orwell", "GEORGE ORWELL", "Orwell, George [Blair, Eric]". Resolve it to "Orwell". For names where the family name is not obviously last ("Ursula K. Le Guin", "Gabriel García Márquez", "bell hooks"), use the name that library catalogues file under: "Le Guin", "García Márquez", "hooks". Keep accents and internal capitals. For two authors use the first only. For an organisation or an "Anonymous" author, use that name as-is.
- If the author genuinely cannot be determined from any of the fields, return the TITLE ALONE with no separator and no author part. Never invent an author, and never write "Unknown".
- TITLE: the work's own title in title case. Strip subtitles after a colon ONLY when the part before the colon is a complete, recognisable title on its own; keep it otherwise. Strip series numbering ("Book the Second", "#3"), edition and format noise ("Retail", "v5.0", "epub", "Kindle Edition", "Illustrated"), and any bracketed publisher junk. Expand nothing that is not there and correct obvious mis-spellings only where you are certain.
- Use the filename as evidence when the metadata is empty or plainly a placeholder ("Untitled", "calibre", "document").
- The result is a folder name, so it must contain no slashes, colons, or characters a filesystem would reject. Keep it under 80 characters.

Respond with ONLY a JSON array, one object per book, in the order given:
[{ "index": <the index you were given>, "folder": "<the folder name>" }]

No prose, no code fences, no commentary.`

/** Strips what a filesystem cannot take, without silently emptying the name. */
export function sanitizeFolderName(raw: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, ' ')
    // Control characters become a SPACE, not nothing: a tab or newline in a
    // metadata field separates words, and deleting it would run them together.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    // Trailing dots and spaces are legal on macOS and not on Windows; dropping
    // them keeps a library portable.
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, MAX_FOLDER_NAME).trim()
}

/**
 * The fallback used when there is no provider configured, or the model's answer
 * for a book was unusable. Deliberately plain: better an honest "Last - Title"
 * built from the metadata than a clever guess made by string surgery.
 */
export function fallbackFolderName(book: Book): string {
  const primary = book.authors[0]?.trim() ?? ''
  const title = book.title.trim() || path.basename(book.filePath, path.extname(book.filePath))
  if (!primary) return sanitizeFolderName(title)
  // "Orwell, George" is already surname-first; anything else takes its last word.
  const last = primary.includes(',')
    ? primary.split(',')[0]!.trim()
    : primary.split(/\s+/).filter(Boolean).slice(-1)[0] ?? ''
  return sanitizeFolderName(last ? `${last} - ${title}` : title)
}

/** Same basename in the same directory: the cover, the .opf, the notes. */
function findSidecars(filePath: string): string[] {
  const directory = path.dirname(filePath)
  const base = path.basename(filePath, path.extname(filePath))
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch {
    return []
  }
  return entries
    .filter((entry) => {
      if (entry === path.basename(filePath)) return false
      const entryBase = path.basename(entry, path.extname(entry))
      return entryBase === base
    })
    .map((entry) => path.join(directory, entry))
    .filter((candidate) => {
      try { return fs.statSync(candidate).isFile() } catch { return false }
    })
}

function parseFolderResponse(text: string, count: number): Map<number, string> {
  const out = new Map<number, string>()
  let trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fence) trimmed = fence[1].trim()
  const first = trimmed.indexOf('[')
  const last = trimmed.lastIndexOf(']')
  if (first === -1 || last === -1 || last <= first) return out
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown
    if (!Array.isArray(parsed)) return out
    for (const entry of parsed) {
      const record = (entry ?? {}) as Record<string, unknown>
      const index = typeof record.index === 'number' ? record.index : Number(record.index)
      const folder = typeof record.folder === 'string' ? sanitizeFolderName(record.folder) : ''
      if (!Number.isInteger(index) || index < 0 || index >= count || !folder) continue
      out.set(index, folder)
    }
  } catch {
    // An unreadable batch falls back to the metadata-derived names below.
  }
  return out
}

export interface OrganizeOptions {
  config?: ProviderConfig
  model?: string
  spend?: SpendTracker
  limiter?: RateLimiter
  signal?: AbortSignal
  /** Skip the LLM entirely and use metadata-derived names. */
  offline?: boolean
}

/**
 * Works out what would move, without touching anything.
 *
 * Always run before `applyOrganizePlan`, and always shown to the user first —
 * this is the only chance to see a mis-parsed author before it becomes a folder.
 */
export async function planOrganize(projectId: string, options: OrganizeOptions = {}): Promise<OrganizePlan> {
  const books = database
    .listBooks(projectId)
    .filter((book) => book.status !== 'failed' && !book.missingSince)

  const entries: OrganizePlanEntry[] = []
  if (books.length === 0) return { projectId, entries, moveCount: 0, skipCount: 0 }

  // Names first, for every book, so one bad batch cannot leave half the plan
  // computed a different way from the other half.
  const names = new Map<string, string>()
  const useModel = !options.offline && options.config && hasProviderCredentials(options.config) && options.model?.trim()

  if (useModel) {
    for (let start = 0; start < books.length; start += BATCH_SIZE) {
      if (options.signal?.aborted) throw new Error('Organise cancelled')
      const batch = books.slice(start, start + BATCH_SIZE)
      const listing = batch
        .map((book, index) =>
          [
            `${index}.`,
            `  title: ${book.title || '(none)'}`,
            `  authors: ${book.authors.join('; ') || '(none)'}`,
            `  publisher: ${book.publisher ?? '(none)'}`,
            `  filename: ${path.basename(book.filePath)}`,
          ].join('\n')
        )
        .join('\n')

      let answered = new Map<number, string>()
      try {
        const raw = await callLLMRetrying(
          options.config!,
          options.model!,
          ORGANIZE_SYSTEM_PROMPT,
          `Produce a folder name for each of these ${batch.length} books:\n\n${listing}`,
          options.signal,
          3,
          { spend: options.spend, limiter: options.limiter, maxTokens: 4000 }
        )
        answered = parseFolderResponse(raw, batch.length)
      } catch (error) {
        if (options.signal?.aborted) throw error
        // A failed batch is not a failed run: those books fall back to the
        // metadata-derived name rather than being dropped from the plan.
      }
      batch.forEach((book, index) => {
        names.set(book.id, answered.get(index) || fallbackFolderName(book))
      })
    }
  } else {
    for (const book of books) names.set(book.id, fallbackFolderName(book))
  }

  for (const book of books) {
    const folderName = names.get(book.id) || fallbackFolderName(book)
    const currentDirectory = path.dirname(book.filePath)
    const sidecars = findSidecars(book.filePath)

    const base: Omit<OrganizePlanEntry, 'targetPath' | 'skipped'> = {
      bookId: book.id,
      title: book.title,
      authors: book.authors,
      currentPath: book.filePath,
      folderName,
      sidecars,
    }

    if (!folderName) {
      entries.push({ ...base, targetPath: null, skipped: 'No usable title' })
      continue
    }
    // Already filed: the book sits directly inside a folder of this name.
    if (path.basename(currentDirectory) === folderName) {
      entries.push({ ...base, targetPath: null, skipped: 'Already filed here' })
      continue
    }

    const targetDirectory = path.join(currentDirectory, folderName)
    const targetPath = path.join(targetDirectory, path.basename(book.filePath))

    // Never climb out of the directory the book is in, whatever the model said.
    if (!targetPath.startsWith(currentDirectory + path.sep)) {
      entries.push({ ...base, targetPath: null, skipped: 'That name is not a safe folder' })
      continue
    }
    if (fs.existsSync(targetPath)) {
      entries.push({ ...base, targetPath: null, skipped: 'A file of that name is already there' })
      continue
    }

    entries.push({ ...base, targetPath, skipped: null })
  }

  return {
    projectId,
    entries,
    moveCount: entries.filter((entry) => entry.targetPath && !entry.skipped).length,
    skipCount: entries.filter((entry) => entry.skipped).length,
  }
}

function identityFor(filePath: string): { hash: string; size: number } | null {
  try {
    const stat = fs.statSync(filePath)
    const real = fs.realpathSync(filePath)
    return {
      hash: crypto.createHash('sha256').update(`${real}\n${stat.size}\n${Math.round(stat.mtimeMs)}`).digest('hex'),
      size: stat.size,
    }
  } catch {
    return null
  }
}

/**
 * Carries out a plan.
 *
 * Each book is moved on its own: one failure leaves the rest of the library
 * organised and reports the one that did not go, rather than rolling everything
 * back into a half-known state.
 */
export function applyOrganizePlan(plan: OrganizePlan): OrganizeResult {
  const result: OrganizeResult = { moved: 0, skipped: 0, failed: [] }
  const sourceRoots = database.listProjectSourcePaths(plan.projectId).map((root) => {
    try { return fs.realpathSync(root) } catch { return path.resolve(root) }
  })

  for (const entry of plan.entries) {
    if (entry.skipped || !entry.targetPath) { result.skipped += 1; continue }

    const book = database.getBookById(entry.bookId)
    if (!book) { result.skipped += 1; continue }
    // The plan may have been made minutes ago; re-check rather than trust it.
    if (book.filePath !== entry.currentPath) {
      result.failed.push({ bookId: entry.bookId, title: entry.title, error: 'The file moved since the plan was made' })
      continue
    }

    // The one hard boundary: nothing leaves a connected source root.
    let real: string
    try { real = fs.realpathSync(entry.currentPath) } catch {
      result.failed.push({ bookId: entry.bookId, title: entry.title, error: 'The file is no longer there' })
      continue
    }
    if (!sourceRoots.some((root) => real.startsWith(root + path.sep))) {
      result.failed.push({ bookId: entry.bookId, title: entry.title, error: 'That file is outside this source' })
      continue
    }

    // And the DESTINATION, which is the one that actually matters: the plan
    // round-trips through the renderer, so its target path is untrusted input.
    // Validating only the source would let a doctored plan write anywhere the
    // process can reach.
    const targetReal = path.resolve(entry.targetPath)
    if (!sourceRoots.some((root) => targetReal.startsWith(root + path.sep))) {
      result.failed.push({ bookId: entry.bookId, title: entry.title, error: 'That destination is outside this source' })
      continue
    }

    try {
      const targetDirectory = path.dirname(entry.targetPath)
      fs.mkdirSync(targetDirectory, { recursive: true })
      if (fs.existsSync(entry.targetPath)) {
        result.failed.push({ bookId: entry.bookId, title: entry.title, error: 'A file of that name is already there' })
        continue
      }
      fs.renameSync(entry.currentPath, entry.targetPath)

      // Sidecars follow the book. A failure here is not fatal: the book has
      // moved, and leaving its cover behind is better than moving it back.
      for (const sidecar of entry.sidecars) {
        const destination = path.join(targetDirectory, path.basename(sidecar))
        try {
          if (!fs.existsSync(destination)) fs.renameSync(sidecar, destination)
        } catch { /* the book itself is what matters */ }
      }

      // Re-point the shelf entry. The identity hash is stat-based and includes
      // the path, so recomputing it here is what stops the next scan treating a
      // moved book as a new one and re-parsing it.
      const identity = identityFor(entry.targetPath)
      const root = sourceRoots.find((candidate) => entry.targetPath!.startsWith(candidate + path.sep)) ?? book.sourcePath
      database.updateBookLocation(book.id, {
        filePath: entry.targetPath,
        relativePath: path.relative(root, entry.targetPath) || path.basename(entry.targetPath),
        identityHash: identity?.hash ?? book.identityHash,
      })
      result.moved += 1
    } catch (error) {
      result.failed.push({
        bookId: entry.bookId,
        title: entry.title,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}
