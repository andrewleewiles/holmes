// EPUB container parsing: zip → container.xml → OPF → manifest / spine / nav.
//
// No new dependency: an EPUB is a zip of XHTML, so `fflate.unzipSync` — already
// how DOCX and XLSX are read in documentContext.ts — is the whole of it.
//
// This module is deliberately free of database and Electron imports (the cover
// decoder is passed in) so it can be unit-tested against a zip built in-test.
import path from 'path'
import { unzipSync, strFromU8 } from 'fflate'
import { decodeXmlEntities } from '../shared/xmlText'

export interface EpubManifestItem {
  id: string
  /** Zip-relative, already resolved against the OPF's own directory. */
  href: string
  mediaType: string
  properties: string
}

export interface EpubSpineEntry {
  id: string
  href: string
  title: string
  navDepth: number
}

export interface EpubMetadata {
  title: string
  subtitle: string | null
  authors: string[]
  publisher: string | null
  publishedDate: string | null
  language: string | null
  identifier: string | null
  subjects: string[]
  description: string | null
}

export interface ParsedEpub {
  metadata: EpubMetadata
  spine: EpubSpineEntry[]
  manifest: Map<string, EpubManifestItem>
  /** Zip path of the cover image, or null. */
  coverHref: string | null
  files: Record<string, Uint8Array>
}

/** unzipSync is fully in-memory, so the ceiling is real memory, not a guess. */
export const MAX_BOOK_FILE_SIZE = 512 * 1024 * 1024

export class EpubParseError extends Error {}

function textOf(buffer: Uint8Array | undefined): string {
  return buffer ? strFromU8(buffer) : ''
}

/** Zip entries are '/'-joined regardless of platform, so path.posix throughout. */
function resolveHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0]
  if (!clean) return ''
  return path.posix.normalize(baseDir ? path.posix.join(baseDir, clean) : clean)
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return match ? decodeXmlEntities(match[1]) : ''
}

function elementTexts(xml: string, localName: string): Array<{ text: string; tag: string }> {
  // EPUB metadata is namespaced inconsistently in the wild (`dc:title`, `title`,
  // `DC:Title`), so match on the local name and ignore whatever prefix a
  // producer chose.
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`, 'gi')
  const out: Array<{ text: string; tag: string }> = []
  for (const match of xml.matchAll(pattern)) {
    out.push({ tag: match[1], text: decodeXmlEntities(match[2].replace(/<[^>]*>/g, '')).trim() })
  }
  return out
}

function parseMetadata(opf: string, fallbackTitle: string): EpubMetadata {
  const metaBlock = opf.match(/<(?:[\w.-]+:)?metadata\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?metadata>/i)?.[1] ?? opf

  const titles = elementTexts(metaBlock, 'title').map((entry) => entry.text).filter(Boolean)
  const creators = elementTexts(metaBlock, 'creator')
  // `opf:role="aut"` distinguishes the author from illustrators, translators and
  // editors, which share the dc:creator element. Producers that omit the role
  // get every creator, which is the honest fallback.
  const authored = creators.filter((entry) => /role\s*=\s*["']aut["']/i.test(entry.tag))
  const authors = (authored.length > 0 ? authored : creators).map((entry) => entry.text).filter(Boolean)

  return {
    title: titles[0] || fallbackTitle,
    subtitle: titles[1] || null,
    authors: [...new Set(authors)],
    publisher: elementTexts(metaBlock, 'publisher')[0]?.text || null,
    publishedDate: elementTexts(metaBlock, 'date')[0]?.text || null,
    language: elementTexts(metaBlock, 'language')[0]?.text || null,
    identifier: elementTexts(metaBlock, 'identifier')[0]?.text || null,
    subjects: [...new Set(elementTexts(metaBlock, 'subject').map((entry) => entry.text).filter(Boolean))],
    description: elementTexts(metaBlock, 'description')[0]?.text || null,
  }
}

function parseManifest(opf: string, baseDir: string): Map<string, EpubManifestItem> {
  const manifestBlock = opf.match(/<(?:[\w.-]+:)?manifest\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?manifest>/i)?.[1] ?? ''
  const items = new Map<string, EpubManifestItem>()
  for (const match of manifestBlock.matchAll(/<(?:[\w.-]+:)?item\b([^>]*)\/?>/gi)) {
    const tag = match[1]
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    if (!id || !href) continue
    items.set(id, {
      id,
      href: resolveHref(baseDir, href),
      mediaType: attr(tag, 'media-type'),
      properties: attr(tag, 'properties'),
    })
  }
  return items
}

function parseSpineIds(opf: string): string[] {
  const spineBlock = opf.match(/<(?:[\w.-]+:)?spine\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?spine>/i)?.[1] ?? ''
  const ids: string[] = []
  for (const match of spineBlock.matchAll(/<(?:[\w.-]+:)?itemref\b([^>]*)\/?>/gi)) {
    const tag = match[1]
    // linear="no" is the publisher saying "not part of the reading order":
    // cover pages, ad pages, alternate front matter.
    if (/\blinear\s*=\s*["']no["']/i.test(tag)) continue
    const idref = attr(tag, 'idref')
    if (idref) ids.push(idref)
  }
  return ids
}

/** EPUB3 nav document: `<nav epub:type="toc">` with nested `<ol>`. */
function parseNav(xhtml: string, baseDir: string): Array<{ href: string; title: string; depth: number }> {
  const navMatch = xhtml.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)
  const block = navMatch?.[1] ?? ''
  if (!block) return []
  const out: Array<{ href: string; title: string; depth: number }> = []
  let depth = 0
  // A single pass tracking <ol> nesting: anchors carry no depth of their own, so
  // the list structure is the only evidence of how deep an entry sits.
  for (const token of block.matchAll(/<(\/?)(ol|a)\b([^>]*)>([\s\S]*?)(?=<)/gi)) {
    const [, closing, tagName, tag, trailing] = token
    if (tagName.toLowerCase() === 'ol') {
      depth = closing ? Math.max(0, depth - 1) : depth + 1
      continue
    }
    if (closing) continue
    const href = attr(tag, 'href')
    if (!href) continue
    out.push({
      href: resolveHref(baseDir, href),
      title: decodeXmlEntities(trailing.replace(/<[^>]*>/g, '')).trim(),
      depth: Math.max(0, depth - 1),
    })
  }
  return out
}

/** EPUB2 NCX fallback: `<navPoint>` with `<navLabel><text>` and `<content src>`. */
function parseNcx(xml: string, baseDir: string): Array<{ href: string; title: string; depth: number }> {
  const out: Array<{ href: string; title: string; depth: number }> = []
  let depth = 0
  for (const token of xml.matchAll(/<(\/?)navPoint\b[^>]*>|<navLabel\b[^>]*>([\s\S]*?)<\/navLabel>|<content\b([^>]*)\/?>/gi)) {
    const [full, closing, label, contentTag] = token
    if (/^<\/?navPoint/i.test(full)) {
      depth = closing ? Math.max(0, depth - 1) : depth + 1
      continue
    }
    if (label !== undefined) {
      const text = decodeXmlEntities(label.replace(/<[^>]*>/g, '')).trim()
      out.push({ href: '', title: text, depth: Math.max(0, depth - 1) })
      continue
    }
    if (contentTag !== undefined && out.length > 0) {
      const src = attr(contentTag, 'src')
      if (src && !out[out.length - 1].href) out[out.length - 1].href = resolveHref(baseDir, src)
    }
  }
  return out.filter((entry) => entry.href)
}

/** First heading in a chapter document — the last resort for a chapter title. */
function firstHeading(xhtml: string): string {
  const match = xhtml.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)
  if (!match) return ''
  return decodeXmlEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 200)
}

function findCoverHref(opf: string, manifest: Map<string, EpubManifestItem>, spineHrefs: string[], files: Record<string, Uint8Array>): string | null {
  // EPUB3: the manifest item declares itself.
  for (const item of manifest.values()) {
    if (/\bcover-image\b/.test(item.properties)) return item.href
  }
  // EPUB2: a <meta name="cover"> points at a manifest id.
  const metaCover = opf.match(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i)?.[0]
  if (metaCover) {
    const item = manifest.get(attr(metaCover, 'content'))
    if (item && item.mediaType.startsWith('image/')) return item.href
  }
  // Last resort: the first image referenced by the first spine document, which
  // for a great many EPUB2 books is the cover page.
  const first = spineHrefs[0]
  if (first && files[first]) {
    const src = textOf(files[first]).match(/<(?:img|image)\b[^>]*\b(?:src|xlink:href)\s*=\s*["']([^"']+)["']/i)?.[1]
    if (src) {
      const resolved = resolveHref(path.posix.dirname(first), src)
      if (files[resolved]) return resolved
    }
  }
  return null
}

export function parseEpub(buffer: Buffer): ParsedEpub {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new EpubParseError('This file is not a readable EPUB archive')
  }

  const container = textOf(files['META-INF/container.xml'])
  const opfPath = container.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i)?.[1]
    // Some producers ship a broken container.xml but a findable OPF.
    ?? Object.keys(files).find((name) => name.toLowerCase().endsWith('.opf'))
  if (!opfPath || !files[opfPath]) throw new EpubParseError('This EPUB has no package document')

  const opf = textOf(files[opfPath])
  const baseDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath)

  const manifest = parseManifest(opf, baseDir)
  const metadata = parseMetadata(opf, path.basename(opfPath, path.extname(opfPath)))

  const spineIds = parseSpineIds(opf)
  const spineHrefs = spineIds
    .map((id) => manifest.get(id))
    .filter((item): item is EpubManifestItem => Boolean(item && files[item.href]))

  if (spineHrefs.length === 0) throw new EpubParseError('This EPUB has no readable chapters')

  // Nav first (EPUB3), then NCX (EPUB2), then nothing — each entry is matched to
  // a spine position by href, since only the spine defines reading order.
  const navItem = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties))
  const ncxItem = [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
  let navEntries: Array<{ href: string; title: string; depth: number }> = []
  if (navItem && files[navItem.href]) {
    navEntries = parseNav(textOf(files[navItem.href]), path.posix.dirname(navItem.href))
  }
  if (navEntries.length === 0 && ncxItem && files[ncxItem.href]) {
    navEntries = parseNcx(textOf(files[ncxItem.href]), path.posix.dirname(ncxItem.href))
  }
  const navByHref = new Map<string, { title: string; depth: number }>()
  for (const entry of navEntries) {
    if (!navByHref.has(entry.href) && entry.title) navByHref.set(entry.href, entry)
  }

  const spine: EpubSpineEntry[] = spineHrefs.map((item, index) => {
    const nav = navByHref.get(item.href)
    return {
      id: item.id,
      href: item.href,
      title: nav?.title || firstHeading(textOf(files[item.href])) || `Section ${index + 1}`,
      navDepth: nav?.depth ?? 0,
    }
  })

  return {
    metadata,
    spine,
    manifest,
    coverHref: findCoverHref(opf, manifest, spine.map((entry) => entry.href), files),
    files,
  }
}
