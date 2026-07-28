// PDF books: metadata, outline and per-page text, mapped into the SAME block
// AST and canonical text space as EPUB.
//
// Deliberately text-only. Rasterizing pages would need either pdf.js in the
// renderer (its worker is created from a blob: URL, which this app's CSP does
// not permit) or a canvas backend in main (a new native dependency on top of
// better-sqlite3's rebuild dance). A scanned PDF therefore gets a shelf entry
// that says so rather than a reader that shows nothing — see SCANNED_PDF_ERROR.
import fs from 'fs'
import crypto from 'crypto'
import type { BookBlock, BookChapter, BookInline } from '../shared/types'
import { CANONICAL_TEXT_VERSION } from './bookText'
import { loadPdfjs } from './pdfjs'

export class PdfParseError extends Error {}

/** Beyond this a single book would dominate a scan; reported, never silent. */
const MAX_PDF_BOOK_PAGES = 3_000
/** No outline: fall back to fixed page runs so the reader still has chapters. */
const PDF_SECTION_PAGES = 20
const SCANNED_PDF_SAMPLE_PAGES = 10
const SCANNED_PDF_MIN_CHARS = 20

export const SCANNED_PDF_ERROR =
  'This PDF has no extractable text — it is most likely a scan without OCR'

interface PdfTextItem {
  str: string
  transform: number[]
  height: number
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * PDF text arrives as positioned fragments, not paragraphs. Group by baseline:
 * a new y means a new line, and a line whose gap from the previous one is more
 * than about one-and-a-half line heights starts a new paragraph. This is a
 * heuristic and will not recover a two-column academic layout — say so in the
 * scan error rather than pretending otherwise.
 */
function itemsToParagraphs(items: PdfTextItem[]): string[] {
  const lines: Array<{ y: number; height: number; text: string }> = []
  for (const item of items) {
    if (!item.str) continue
    const y = Math.round(item.transform[5])
    const previous = lines[lines.length - 1]
    if (previous && Math.abs(previous.y - y) <= 2) {
      previous.text += item.str
    } else {
      lines.push({ y, height: item.height || 12, text: item.str })
    }
  }

  const paragraphs: string[] = []
  let current = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const text = line.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const previous = lines[i - 1]
    const gap = previous ? Math.abs(previous.y - line.y) : 0
    const paragraphBreak = previous && gap > (line.height || 12) * 1.6
    if (paragraphBreak && current) {
      paragraphs.push(current.trim())
      current = ''
    }
    // A hyphen at a line end is a word split across lines, not punctuation.
    if (current.endsWith('-')) current = `${current.slice(0, -1)}${text}`
    else current = current ? `${current} ${text}` : text
  }
  if (current.trim()) paragraphs.push(current.trim())
  return paragraphs
}

function blockFor(kind: 'p' | 'pagebreak', text: string, start: number, page: number): BookBlock {
  const inlines: BookInline[] = text ? [{ text, start }] : []
  return { kind, start, end: start + text.length, inlines, page }
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null
  // PDF dates look like D:20180213120000Z.
  const match = value.match(/^D?:?(\d{4})(\d{2})?(\d{2})?/)
  if (!match) return null
  const [, year, month, day] = match
  if (month && day) return `${year}-${month}-${day}`
  if (month) return `${year}-${month}`
  return year
}

/** "Author - Title.pdf" and "Title (2011).pdf" are the two shapes worth reading. */
function fromFilename(fallbackTitle: string): { title: string; authors: string[]; publishedDate: string | null } {
  const yearMatch = fallbackTitle.match(/\((\d{4})\)/)
  let name = fallbackTitle.replace(/\s*\(\d{4}\)\s*/, ' ').replace(/[_]+/g, ' ').trim()
  let authors: string[] = []
  const dash = name.match(/^(.{2,60}?)\s+-\s+(.+)$/)
  if (dash) {
    authors = [dash[1].trim()]
    name = dash[2].trim()
  }
  return { title: name || fallbackTitle, authors, publishedDate: yearMatch ? yearMatch[1] : null }
}

export async function parsePdfBook(filePath: string, fallbackTitle: string): Promise<{
  content: {
    textHash: string
    text: string
    chapters: Array<Omit<BookChapter, 'id' | 'bookId'>>
    blocksByChapter: BookBlock[][]
    resources: Map<string, { data: Uint8Array; mediaType: string }>
  }
  metadata: {
    title: string; subtitle: string | null; authors: string[]; publisher: string | null
    publishedDate: string | null; language: string | null; identifier: string | null
    subjects: string[]; description: string | null
  }
}> {
  const pdfjs = await loadPdfjs()
  const data = await fs.promises.readFile(filePath)
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true } as never)

  let doc: Awaited<typeof loadingTask.promise>
  try {
    doc = await loadingTask.promise
  } catch {
    throw new PdfParseError('This file could not be opened as a PDF')
  }

  try {
    const pageCount = Math.min(doc.numPages, MAX_PDF_BOOK_PAGES)

    // --- metadata
    const info = (await doc.getMetadata().catch(() => null))?.info as Record<string, string> | undefined
    const guessed = fromFilename(fallbackTitle)
    const title = (info?.Title || '').trim() || guessed.title
    const author = (info?.Author || '').trim()
    const keywords = (info?.Keywords || '').split(/[,;]/).map((entry) => entry.trim()).filter(Boolean)

    // --- section bounds, from the outline when there is one
    const outline = await doc.getOutline().catch(() => null)
    const bounds: Array<{ title: string; page: number; depth: number }> = []
    if (outline && outline.length > 0) {
      const walk = async (entries: typeof outline, depth: number): Promise<void> => {
        for (const entry of entries) {
          try {
            const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest
            const ref = Array.isArray(dest) ? dest[0] : null
            if (ref) {
              const pageIndex = await doc.getPageIndex(ref as never)
              bounds.push({ title: entry.title.trim() || `Section ${bounds.length + 1}`, page: pageIndex, depth })
            }
          } catch {
            // An outline entry pointing nowhere is skipped, not fatal.
          }
          if (entry.items?.length) await walk(entry.items as typeof outline, depth + 1)
        }
      }
      await walk(outline, 0)
    }
    bounds.sort((left, right) => left.page - right.page)
    if (bounds.length === 0 || bounds[0].page > 0) {
      bounds.unshift({ title: bounds.length > 0 ? 'Front matter' : 'Pages', page: 0, depth: 0 })
    }

    const sections = bounds.length > 1
      ? bounds.map((entry, index) => ({
          title: entry.title,
          depth: entry.depth,
          start: entry.page,
          end: (index + 1 < bounds.length ? bounds[index + 1].page : pageCount) - 1,
        })).filter((section) => section.end >= section.start)
      : Array.from({ length: Math.ceil(pageCount / PDF_SECTION_PAGES) }, (_, index) => {
          const start = index * PDF_SECTION_PAGES
          const end = Math.min(start + PDF_SECTION_PAGES, pageCount) - 1
          return { title: `Pages ${start + 1}–${end + 1}`, depth: 0, start, end }
        })

    // --- text, page by page
    const pageParagraphs: string[][] = []
    let sampledChars = 0
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      let paragraphs: string[] = []
      try {
        const page = await doc.getPage(pageNumber)
        const content = await page.getTextContent()
        paragraphs = itemsToParagraphs(content.items as unknown as PdfTextItem[])
        page.cleanup()
      } catch {
        paragraphs = []
      }
      pageParagraphs.push(paragraphs)
      if (pageNumber <= SCANNED_PDF_SAMPLE_PAGES) {
        sampledChars += paragraphs.join('').length
      }
    }

    // A scan without OCR yields a document with pages and no words. Detect it
    // here so the shelf can say so, rather than opening an empty reader.
    if (sampledChars < SCANNED_PDF_MIN_CHARS) throw new PdfParseError(SCANNED_PDF_ERROR)

    const chapters: Array<Omit<BookChapter, 'id' | 'bookId'>> = []
    const blocksByChapter: BookBlock[][] = []
    const texts: string[] = []
    let offset = 0

    sections.forEach((section, index) => {
      const blocks: BookBlock[] = []
      const parts: string[] = []
      let cursor = offset
      for (let page = section.start; page <= section.end; page += 1) {
        // The page break carries no text but does carry a number, which is what
        // makes "page 214" mean something in a citation.
        blocks.push(blockFor('pagebreak', '', cursor, page + 1))
        for (const paragraph of pageParagraphs[page] ?? []) {
          blocks.push(blockFor('p', paragraph, cursor, page + 1))
          parts.push(paragraph)
          cursor += paragraph.length + 1
        }
      }
      const text = parts.join('\n')
      chapters.push({
        spineIndex: index,
        href: `page:${section.start + 1}`,
        anchor: null,
        title: section.title,
        navDepth: section.depth,
        charStart: offset,
        charEnd: offset + text.length,
        wordCount: text.match(/\S+/g)?.length ?? 0,
        pageStart: section.start + 1,
        pageEnd: section.end + 1,
      })
      blocksByChapter.push(blocks)
      texts.push(text)
      offset += text.length + 1
    })

    const text = texts.join('\n')
    return {
      content: {
        textHash: hash(`${CANONICAL_TEXT_VERSION}\n${text}`),
        text,
        chapters,
        blocksByChapter,
        resources: new Map(),
      },
      metadata: {
        title,
        subtitle: null,
        authors: author ? [author] : guessed.authors,
        publisher: null,
        publishedDate: parseDate(info?.CreationDate) ?? guessed.publishedDate,
        language: null,
        identifier: null,
        subjects: keywords,
        description: (info?.Subject || '').trim() || null,
      },
    }
  } finally {
    await loadingTask.destroy()
  }
}
