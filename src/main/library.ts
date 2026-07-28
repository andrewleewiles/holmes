// The Library: scanning a folder of e-books into the shelf, and reading one.
//
// Everything here is local I/O. No LLM call is made by this module, and no book
// text is written to the database — chapter content is re-derived from the file
// on every read, cached only in memory. What persists is the shelf and the
// reading record, which is the only part of a library that feeds the profile.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { strFromU8 } from 'fflate'
import type {
  Book,
  BookBlock,
  BookChapter,
  BookChapterContent,
  BookResource,
  LibraryScanProgress,
  LibraryScanResult,
} from '../shared/types'
import * as database from './database'
import { assertPathAllowed } from './fileScope'
import { scanProjectTextFiles, BOOK_EXTENSIONS, MAX_INDEXED_DIRECTORY_ENTRIES } from './projectContext'
import { parseEpub, EpubParseError, MAX_BOOK_FILE_SIZE, type ParsedEpub } from './epub'
import { parseBookDocument, CANONICAL_TEXT_VERSION } from './bookText'
import { parsePdfBook, PdfParseError } from './bookPdf'
import { reanchorBookAnnotations } from './bookAnnotations'

/** Bump when the scan's own logic changes what a book looks like: it is part of
 *  the identity hash, so every book re-parses once and then caches again. */
const LIBRARY_SCAN_VERSION = `v1-${CANONICAL_TEXT_VERSION}`

const MAX_BOOKS_PER_SOURCE = 5_000
/** A cover string is stored per book; 300 books at 4 MB each would be 1.2 GB. */
const MAX_COVER_BYTES = 150 * 1024
const COVER_MAX_HEIGHT = 480
const MAX_IMAGE_EDGE = 1200
const MAX_RESOURCE_BYTES = 400 * 1024
/** Two books' worth of parsed content, which is what page-turning actually touches. */
const CONTENT_CACHE_SIZE = 2

export class LibraryError extends Error {}

// --- parsed-book cache ------------------------------------------------------
// Keyed on identity hash, so a file that changed on disk can never serve stale
// content out of the cache.

interface ParsedBook {
  identityHash: string
  textHash: string
  text: string
  chapters: Array<Omit<BookChapter, 'id' | 'bookId'>>
  blocksByChapter: BookBlock[][]
  /** Resource id → the bytes and media type, for images the reader asks for. */
  resources: Map<string, { data: Uint8Array; mediaType: string }>
}

const contentCache = new Map<string, ParsedBook>()

function cacheGet(key: string, identityHash: string): ParsedBook | null {
  const hit = contentCache.get(key)
  if (!hit || hit.identityHash !== identityHash) return null
  // Refresh recency.
  contentCache.delete(key)
  contentCache.set(key, hit)
  return hit
}

function cachePut(key: string, value: ParsedBook): void {
  contentCache.delete(key)
  contentCache.set(key, value)
  while (contentCache.size > CONTENT_CACHE_SIZE) {
    const oldest = contentCache.keys().next().value
    if (oldest === undefined) break
    contentCache.delete(oldest)
  }
}

export function clearLibraryCache(): void {
  contentCache.clear()
}

// --- identity ---------------------------------------------------------------

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Stat-based, not content-based, and for the same reason the health importer's
 * identity is: re-hashing a 400 MB shelf on every scan is minutes of disk I/O to
 * answer a question `stat` already answered. `realpath` comes FIRST because a
 * folder walk yields realpath'd files while a file picker yields whatever the
 * user navigated to, and on macOS those differ under /var.
 */
function bookIdentity(filePath: string, size: number, mtimeMs: number): string {
  return hash(`${filePath}\n${size}\n${Math.round(mtimeMs)}\n${LIBRARY_SCAN_VERSION}`)
}

function realpath(filePath: string): string {
  try {
    return fs.realpathSync(path.resolve(filePath))
  } catch {
    return path.resolve(filePath)
  }
}

// --- cover ------------------------------------------------------------------

async function encodeCover(data: Uint8Array): Promise<string | null> {
  try {
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromBuffer(Buffer.from(data))
    // SVG covers land here empty — Chromium will not decode them from a buffer.
    // The shelf falls back to a typographic card, which is better than a blank.
    if (image.isEmpty()) return null
    const size = image.getSize()
    const resized = size.height > COVER_MAX_HEIGHT ? image.resize({ height: COVER_MAX_HEIGHT }) : image
    const jpeg = resized.toJPEG(72)
    if (jpeg.length === 0 || jpeg.length > MAX_COVER_BYTES) return null
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  } catch {
    return null
  }
}

// --- parsing ----------------------------------------------------------------

function countWords(text: string): number {
  const matches = text.match(/\S+/g)
  return matches ? matches.length : 0
}

function parseEpubContent(parsed: ParsedEpub): Omit<ParsedBook, 'identityHash'> {
  const hrefToIndex = new Map<string, number>()
  parsed.spine.forEach((entry, index) => hrefToIndex.set(entry.href, index))

  const resources = new Map<string, { data: Uint8Array; mediaType: string }>()
  const resourceIdFor = (href: string): string | undefined => {
    const data = parsed.files[href]
    if (!data) return undefined
    const item = [...parsed.manifest.values()].find((entry) => entry.href === href)
    const mediaType = item?.mediaType || ''
    if (mediaType && !mediaType.startsWith('image/')) return undefined
    const id = hash(href).slice(0, 16)
    resources.set(id, { data, mediaType: mediaType || 'image/jpeg' })
    return id
  }

  const chapters: Array<Omit<BookChapter, 'id' | 'bookId'>> = []
  const blocksByChapter: BookBlock[][] = []
  const texts: string[] = []
  let offset = 0

  parsed.spine.forEach((entry, index) => {
    const xhtml = strFromU8(parsed.files[entry.href])
    const { blocks, text } = parseBookDocument(xhtml, {
      baseOffset: offset,
      baseDir: path.posix.dirname(entry.href),
      chapterIndexForHref: (href) => hrefToIndex.get(href),
      resourceIdForHref: resourceIdFor,
    })
    chapters.push({
      spineIndex: index,
      href: entry.href,
      anchor: null,
      title: entry.title,
      navDepth: entry.navDepth,
      charStart: offset,
      charEnd: offset + text.length,
      wordCount: countWords(text),
      pageStart: null,
      pageEnd: null,
    })
    blocksByChapter.push(blocks)
    texts.push(text)
    // The chapter separator is one newline, so a book's canonical text is the
    // concatenation of its chapters and every chapter bound is exact.
    offset += text.length + 1
  })

  const text = texts.join('\n')
  return { textHash: hash(`${CANONICAL_TEXT_VERSION}\n${text}`), text, chapters, blocksByChapter, resources }
}

async function parseBookFile(filePath: string, format: 'epub' | 'pdf'): Promise<{
  parsed: Omit<ParsedBook, 'identityHash'>
  metadata: {
    title: string; subtitle: string | null; authors: string[]; publisher: string | null
    publishedDate: string | null; language: string | null; identifier: string | null
    subjects: string[]; description: string | null
  }
  coverDataUrl: string | null
}> {
  const fallbackTitle = path.basename(filePath, path.extname(filePath))
  if (format === 'pdf') {
    const pdf = await parsePdfBook(filePath, fallbackTitle)
    return { parsed: pdf.content, metadata: pdf.metadata, coverDataUrl: null }
  }

  const buffer = await fs.promises.readFile(filePath)
  const epub = parseEpub(buffer)
  const content = parseEpubContent(epub)
  const coverData = epub.coverHref ? epub.files[epub.coverHref] : undefined
  return {
    parsed: content,
    metadata: epub.metadata,
    coverDataUrl: coverData ? await encodeCover(coverData) : null,
  }
}

// --- scanning ---------------------------------------------------------------

export type LibraryProgressSender = (progress: LibraryScanProgress) => void

export async function scanLibrary(
  projectId: string,
  signal?: AbortSignal,
  sendProgress?: LibraryProgressSender
): Promise<LibraryScanResult> {
  const project = database.getProjectById(projectId)
  if (!project) throw new LibraryError('That source no longer exists')

  const sources = database.listProjectSourcePaths(projectId)
  const result: LibraryScanResult = {
    booksFound: 0, booksAdded: 0, booksUpdated: 0, booksUnchanged: 0,
    booksFailed: 0, booksMissing: 0, pruned: 0, scanComplete: true, unreadableRoots: [],
  }
  if (sources.length === 0) return result

  const seenPaths = new Set<string>()
  const existingByPath = new Map(database.listBooks(projectId).map((book) => [book.filePath, book]))

  for (const sourcePath of sources) {
    if (signal?.aborted) throw new LibraryError('Library scan cancelled')
    assertPathAllowed(path.resolve(sourcePath))

    sendProgress?.({ phase: 'scanning', message: `Scanning ${path.basename(sourcePath)}`, current: 0, total: null })
    const scan = scanProjectTextFiles([], sourcePath, BOOK_EXTENSIONS, {
      maxFiles: MAX_BOOKS_PER_SOURCE,
      maxEntries: MAX_INDEXED_DIRECTORY_ENTRIES,
      maxFileSize: MAX_BOOK_FILE_SIZE,
    })
    if (!scan.complete) result.scanComplete = false
    if (scan.rootUnreadable) result.unreadableRoots.push(sourcePath)

    const root = realpath(sourcePath)
    result.booksFound += scan.files.length

    for (let index = 0; index < scan.files.length; index += 1) {
      if (signal?.aborted) throw new LibraryError('Library scan cancelled')
      const filePath = scan.files[index]
      seenPaths.add(filePath)

      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        result.scanComplete = false
        continue
      }

      const identityHash = bookIdentity(filePath, stat.size, stat.mtimeMs)
      const existing = existingByPath.get(filePath)
      // The cheap gate: nothing about the file changed, so nothing about the
      // shelf entry can have. Reading state and annotations are untouched.
      if (existing && existing.identityHash === identityHash && existing.status === 'ready' && !existing.missingSince) {
        result.booksUnchanged += 1
        continue
      }

      const format = path.extname(filePath).toLowerCase() === '.pdf' ? 'pdf' : 'epub'
      sendProgress?.({
        phase: 'parsing',
        message: `Reading ${path.basename(filePath)}`,
        current: index + 1,
        total: scan.files.length,
        bookTitle: path.basename(filePath),
      })

      try {
        const { parsed, metadata, coverDataUrl } = await parseBookFile(filePath, format)
        const book = database.upsertBook({
          projectId,
          sourcePath: root,
          filePath,
          relativePath: path.relative(root, filePath) || path.basename(filePath),
          format,
          identityHash,
          textHash: parsed.textHash,
          fileSize: stat.size,
          ...metadata,
          coverDataUrl,
          chapterCount: parsed.chapters.length,
          wordCount: countWords(parsed.text),
          status: 'ready',
          scanError: null,
        })
        database.replaceBookChapters(book.id, parsed.chapters)
        cachePut(book.id, { ...parsed, identityHash })
        // The file changed AND its text changed, so every stored offset for this
        // book is now suspect. Re-point the annotations rather than leaving
        // notes attached to whatever sentence has moved into their place.
        if (existing && existing.textHash && existing.textHash !== parsed.textHash) {
          try {
            await reanchorBookAnnotations(book.id)
          } catch {
            // Re-anchoring is best-effort: a failure leaves annotations where
            // they were, which the reader can still see and judge.
          }
        }
        if (existing) result.booksUpdated += 1
        else result.booksAdded += 1
      } catch (error) {
        // A book that will not parse still belongs on the shelf, saying why.
        // Silently omitting it is how a library comes to look complete when it
        // is not.
        const message = error instanceof EpubParseError || error instanceof PdfParseError
          ? error.message
          : 'This file could not be read as a book'
        database.upsertBook({
          projectId,
          sourcePath: root,
          filePath,
          relativePath: path.relative(root, filePath) || path.basename(filePath),
          format,
          identityHash,
          textHash: '',
          fileSize: stat.size,
          title: path.basename(filePath, path.extname(filePath)),
          subtitle: null, authors: [], publisher: null, publishedDate: null,
          language: null, identifier: null, subjects: [], description: null,
          coverDataUrl: null, chapterCount: 0, wordCount: 0,
          status: 'failed',
          scanError: message,
        })
        result.booksFailed += 1
      }
    }
  }

  // Absence is only meaningful when the scan actually saw everything. An
  // external drive that slept must not wipe the shelf, the reading history and
  // every annotation attached to it — the same rule the document indexer's
  // prune obeys.
  const now = new Date().toISOString()
  for (const [filePath, book] of existingByPath) {
    if (seenPaths.has(filePath)) continue
    if (!result.scanComplete) continue
    if (fs.existsSync(filePath)) continue
    database.markBookMissing(book.id, book.missingSince ?? now)
    result.booksMissing += 1
  }

  sendProgress?.({ phase: 'complete', message: 'Library up to date', current: result.booksFound, total: result.booksFound })
  return result
}

// --- reading ----------------------------------------------------------------

async function loadParsed(book: Book): Promise<ParsedBook> {
  const cached = cacheGet(book.id, book.identityHash)
  if (cached) return cached
  assertPathAllowed(path.resolve(book.filePath))
  if (!fs.existsSync(book.filePath)) {
    throw new LibraryError('This book is no longer at the path it was scanned from')
  }
  const { parsed } = await parseBookFile(book.filePath, book.format)
  const value: ParsedBook = { ...parsed, identityHash: book.identityHash }
  cachePut(book.id, value)
  return value
}

export async function getChapterContent(bookId: string, chapterIndex: number): Promise<BookChapterContent> {
  const book = database.getBookById(bookId)
  if (!book) throw new LibraryError('That book is no longer on the shelf')
  if (book.status === 'failed') throw new LibraryError(book.scanError ?? 'This book could not be read')

  const parsed = await loadParsed(book)
  const chapter = parsed.chapters[chapterIndex]
  if (!chapter) throw new LibraryError('That chapter does not exist in this book')

  return {
    bookId,
    chapterIndex,
    title: chapter.title,
    charStart: chapter.charStart,
    charEnd: chapter.charEnd,
    blocks: parsed.blocksByChapter[chapterIndex] ?? [],
    truncated: false,
  }
}

/** The canonical text of a chapter range — the input to lessons and annotations. */
export async function getCanonicalText(
  bookId: string,
  chapterStart?: number,
  chapterEnd?: number
): Promise<{ text: string; charStart: number }> {
  const book = database.getBookById(bookId)
  if (!book) throw new LibraryError('That book is no longer on the shelf')
  const parsed = await loadParsed(book)
  if (chapterStart === undefined || chapterEnd === undefined) return { text: parsed.text, charStart: 0 }
  const first = parsed.chapters[chapterStart]
  const last = parsed.chapters[chapterEnd]
  if (!first || !last) throw new LibraryError('That chapter range does not exist in this book')
  return { text: parsed.text.slice(first.charStart, last.charEnd), charStart: first.charStart }
}

export async function getBookResource(bookId: string, resourceId: string): Promise<BookResource> {
  const book = database.getBookById(bookId)
  if (!book) throw new LibraryError('That book is no longer on the shelf')
  const parsed = await loadParsed(book)
  const resource = parsed.resources.get(resourceId)
  if (!resource) throw new LibraryError('That image is not part of this book')

  const { nativeImage } = await import('electron')
  const image = nativeImage.createFromBuffer(Buffer.from(resource.data))
  if (image.isEmpty()) throw new LibraryError('That image could not be decoded')
  const size = image.getSize()
  const longest = Math.max(size.width, size.height)
  const resized = longest > MAX_IMAGE_EDGE
    ? image.resize(size.width >= size.height ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE })
    : image
  // A data: URL, which the CSP already permits under img-src — no blob:, no
  // CSP change, and no multi-megabyte chapter payloads.
  let buffer = resized.toPNG()
  let mediaType = 'image/png'
  if (buffer.length > MAX_RESOURCE_BYTES) {
    buffer = resized.toJPEG(80)
    mediaType = 'image/jpeg'
  }
  if (buffer.length > MAX_RESOURCE_BYTES) throw new LibraryError('That image is too large to display')
  const finalSize = resized.getSize()
  return {
    dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}`,
    width: finalSize.width,
    height: finalSize.height,
  }
}
