// XHTML → a typed block AST plus one canonical text string.
//
// Two jobs, and they must agree exactly:
//
// 1. Produce blocks the renderer can display. HTML never crosses the IPC bridge:
//    the app has no dangerouslySetInnerHTML anywhere, and the CSP permits inline
//    styles — so a <style> block inside a downloaded book could restyle the whole
//    application. An allowlisted AST makes that impossible by construction
//    rather than by sanitizer correctness.
//
// 2. Produce the canonical text that every offset in this feature indexes into —
//    chapter bounds, lesson citations, annotation anchors, reading progress.
//    One coordinate space, derived one way. If this function's output changes,
//    every stored offset shifts, which is why CANONICAL_TEXT_VERSION exists and
//    feeds the book's text hash.
import path from 'path'
import { decodeXmlEntities } from '../shared/xmlText'
import type { BookBlock, BookBlockKind, BookInline, BookLink, BookMark } from '../shared/books'

/** Bump when the canonical text changes shape: it invalidates every offset. */
export const CANONICAL_TEXT_VERSION = 'v1'

/** Elements whose CONTENT is discarded, not just their tags. */
const DROPPED_ELEMENTS = new Set([
  'script', 'style', 'svg', 'iframe', 'object', 'embed', 'form', 'input',
  'button', 'select', 'textarea', 'audio', 'video', 'link', 'meta', 'head',
  'title', 'noscript', 'canvas', 'map', 'template',
])

const BLOCK_TAGS: Record<string, BookBlockKind> = {
  p: 'p', div: 'p',
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  li: 'li', blockquote: 'blockquote', pre: 'pre', figcaption: 'figcaption',
  // A table row is flattened to a tab-separated paragraph — the same choice
  // extractXlsxText makes, and for the same reason: a real table renderer is a
  // large amount of work for a shape most prose books never use.
  tr: 'p',
}

const MARK_TAGS: Record<string, BookMark> = {
  em: 'em', i: 'em', cite: 'em', var: 'em',
  strong: 'strong', b: 'strong',
  code: 'code', kbd: 'code', samp: 'code', tt: 'code',
  sup: 'sup', sub: 'sub', small: 'small',
}

export interface BookTextOptions {
  /** Absolute offset this document starts at within the whole book. */
  baseOffset: number
  /** Zip directory of this document, for resolving relative hrefs and images. */
  baseDir: string
  /** Maps a resolved zip path to a spine index, for internal links. */
  chapterIndexForHref?: (href: string) => number | undefined
  /** Maps a resolved zip path to a resource id the renderer can fetch. */
  resourceIdForHref?: (href: string) => string | undefined
}

export interface BookTextResult {
  blocks: BookBlock[]
  /** The canonical text for this document — blocks joined by a single newline. */
  text: string
}

interface Token {
  kind: 'open' | 'close' | 'text' | 'void'
  name: string
  tag: string
  text: string
}

function tokenize(xhtml: string): Token[] {
  const tokens: Token[] = []
  let cursor = 0
  const pattern = /<!--[\s\S]*?-->|<\??[/!]?\s*([a-zA-Z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xhtml)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'text', name: '', tag: '', text: xhtml.slice(cursor, match.index) })
    }
    cursor = match.index + match[0].length
    if (match[0].startsWith('<!--')) continue
    const name = (match[1] ?? '').toLowerCase().replace(/^[\w.-]+:/, '')
    if (!name) continue
    const closing = match[0].startsWith('</')
    const selfClosing = match[3] === '/' || name === 'br' || name === 'img' || name === 'hr' || name === 'image'
    tokens.push({
      kind: closing ? 'close' : selfClosing ? 'void' : 'open',
      name,
      tag: match[2] ?? '',
      text: '',
    })
  }
  if (cursor < xhtml.length) {
    tokens.push({ kind: 'text', name: '', tag: '', text: xhtml.slice(cursor) })
  }
  return tokens
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  if (!match) return ''
  return decodeXmlEntities(match[2] ?? match[3] ?? '')
}

function resolve(baseDir: string, href: string): string {
  const clean = href.split('#')[0]
  if (!clean) return ''
  return path.posix.normalize(baseDir ? path.posix.join(baseDir, clean) : clean)
}

/**
 * A link the renderer may act on. Anything else — javascript:, file:, data: —
 * becomes plain text rather than an exception: a book with one odd link should
 * still be readable.
 */
function classifyLink(href: string, options: BookTextOptions): BookLink | undefined {
  const raw = href.trim()
  if (!raw) return undefined
  if (/^https?:\/\//i.test(raw)) return { kind: 'external', url: raw }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined
  const anchor = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : undefined
  // A bare "#frag" points inside the current document.
  const target = raw.startsWith('#') ? '' : resolve(options.baseDir, raw)
  const chapterIndex = target ? options.chapterIndexForHref?.(target) : undefined
  if (target && chapterIndex === undefined) return undefined
  if (!target && anchor === undefined) return undefined
  return { kind: 'internal', chapterIndex: chapterIndex ?? -1, anchor }
}

/** Collapses runs of whitespace; the canonical text is normalized, once, here. */
function normalize(value: string): string {
  return value.replace(/[\t\r\f\v ]+/g, ' ').replace(/\n+/g, ' ')
}

export function parseBookDocument(xhtml: string, options: BookTextOptions): BookTextResult {
  const blocks: BookBlock[] = []
  const texts: string[] = []
  let offset = options.baseOffset

  // Open-block state.
  let kind: BookBlockKind | null = null
  let inlines: BookInline[] = []
  let buffer = ''
  let anchorId: string | undefined
  let listOrdered: boolean | undefined
  let listDepth = 0
  const marks: BookMark[] = []
  let link: BookLink | undefined
  let pendingAnchorId: string | undefined
  const listStack: boolean[] = []
  let dropDepth = 0
  let dropName = ''

  const flushInline = () => {
    if (!buffer) return
    inlines.push({
      text: buffer,
      start: offset + inlines.reduce((sum, run) => sum + run.text.length, 0),
      ...(marks.length > 0 ? { marks: [...new Set(marks)] } : {}),
      ...(link ? { link } : {}),
    })
    buffer = ''
  }

  const closeBlock = () => {
    flushInline()
    if (kind === null) return
    const text = inlines.map((run) => run.text).join('').replace(/\s+$/, '')
    if (!text.trim()) {
      // An empty block still resets state but contributes nothing — otherwise a
      // book's layout <div>s would each cost a newline in the canonical text.
      kind = null; inlines = []; anchorId = undefined; listOrdered = undefined
      return
    }
    // Re-derive inline offsets against the trimmed text so a block's runs always
    // sum to exactly what the canonical text holds.
    let running = offset
    const trimmed: BookInline[] = []
    let remaining = text
    for (const run of inlines) {
      if (!remaining) break
      const slice = run.text.slice(0, remaining.length)
      if (!slice) continue
      trimmed.push({ ...run, text: slice, start: running })
      running += slice.length
      remaining = remaining.slice(slice.length)
    }
    blocks.push({
      kind,
      start: offset,
      end: offset + text.length,
      inlines: trimmed,
      ...(anchorId ? { anchorId } : {}),
      ...(listOrdered !== undefined ? { listOrdered } : {}),
      ...(kind === 'li' ? { listDepth } : {}),
    })
    texts.push(text)
    offset += text.length + 1 // the joining newline
    kind = null; inlines = []; anchorId = undefined; listOrdered = undefined
  }

  const openBlock = (next: BookBlockKind) => {
    closeBlock()
    kind = next
    anchorId = pendingAnchorId
    pendingAnchorId = undefined
    if (next === 'li') listOrdered = listStack[listStack.length - 1] ?? false
  }

  const pushStandalone = (block: Omit<BookBlock, 'start' | 'end' | 'inlines'>) => {
    closeBlock()
    blocks.push({ ...block, start: offset, end: offset, inlines: [] })
  }

  for (const token of tokenize(xhtml)) {
    if (dropDepth > 0) {
      if (token.kind === 'open' && token.name === dropName) dropDepth += 1
      else if (token.kind === 'close' && token.name === dropName) dropDepth -= 1
      continue
    }

    if (token.kind === 'text') {
      if (kind === null) {
        // Bare text outside any block still belongs to the book.
        const stray = normalize(decodeXmlEntities(token.text))
        if (stray.trim()) { openBlock('p'); buffer += stray.replace(/^\s+/, '') }
        continue
      }
      const decoded = decodeXmlEntities(token.text)
      // <pre> is the one place whitespace carries meaning.
      buffer += kind === 'pre' ? decoded.replace(/\r/g, '') : normalize(decoded)
      continue
    }

    const { name, tag } = token

    if (token.kind === 'open' && DROPPED_ELEMENTS.has(name)) {
      dropDepth = 1
      dropName = name
      continue
    }
    if (token.kind === 'void' && DROPPED_ELEMENTS.has(name)) continue

    const id = attr(tag, 'id')
    if (id && !pendingAnchorId) pendingAnchorId = id

    if (token.kind === 'open' || token.kind === 'void') {
      if (name === 'ul' || name === 'ol') { closeBlock(); listStack.push(name === 'ol'); listDepth = listStack.length - 1; continue }
      if (name === 'br') { if (kind !== null) buffer += kind === 'pre' ? '\n' : ' '; continue }
      if (name === 'hr') { pushStandalone({ kind: 'hr' }); continue }
      if (name === 'img' || name === 'image') {
        const src = attr(tag, 'src') || attr(tag, 'href')
        const resourceId = src ? options.resourceIdForHref?.(resolve(options.baseDir, src)) : undefined
        // An image whose file is missing from the archive is dropped rather than
        // rendered as a broken frame.
        if (resourceId) pushStandalone({ kind: 'img', resourceId, alt: attr(tag, 'alt') || undefined })
        continue
      }
      if (name === 'a') { flushInline(); link = classifyLink(attr(tag, 'href'), options); continue }
      if (MARK_TAGS[name]) { flushInline(); marks.push(MARK_TAGS[name]); continue }
      if (BLOCK_TAGS[name]) {
        // A wrapper <div> that only contains other blocks must not open one of
        // its own, or every book would gain a blank paragraph per layer.
        if (name === 'div' && kind !== null) continue
        openBlock(BLOCK_TAGS[name])
        continue
      }
      // Anything unrecognised (span, section, article, table, tbody, figure…)
      // is transparent: its text still counts, it just carries no structure.
      continue
    }

    // close
    if (name === 'ul' || name === 'ol') { closeBlock(); listStack.pop(); listDepth = Math.max(0, listStack.length - 1); continue }
    if (name === 'a') { flushInline(); link = undefined; continue }
    if (MARK_TAGS[name]) {
      flushInline()
      const at = marks.lastIndexOf(MARK_TAGS[name])
      if (at >= 0) marks.splice(at, 1)
      continue
    }
    if (BLOCK_TAGS[name]) { closeBlock(); continue }
  }

  closeBlock()
  return { blocks, text: texts.join('\n') }
}
