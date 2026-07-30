// Resolving paper mode at save time, on the .docx bytes themselves.
//
// The Work tab shows a new document as Holmes — no page, white text, set in
// Holmes Minion — and the save dialog asks which of those the file should
// actually carry. This is where that answer is applied.
//
// It happens here, on the exported bytes, rather than in the editor, because
// this ONLYOFFICE build has no working way to change document formatting from
// outside: the plugin connector's first `connect` is lost whenever it lands
// before the editor's plugin runtime is listening — after which every
// `callCommand` times out for the life of the document — and the editor api's
// `put_TextPrFontName` moves the toolbar without touching a single run (checked
// against Liberation Serif as a control). A .docx is a zip of XML, x2t has just
// written it, and a string in a part is a string in a part; there is no race and
// nothing to wait for.
//
// Kept free of Electron imports so the transforms can be asserted in
// test-work.mjs without booting an app — the same reason documentText.ts is.
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

/** Must match PAPER_FONT in src/office-shell/shell.ts and the committed template. */
export const PAPER_FONT = 'Holmes Minion'
/** What a document is set in once the treatment is dropped. */
export const PLAIN_FONT = 'Arial'
/** Must match PAPER_PAGE_HEX in the shell, without the '#'. */
export const PAPER_PAGE = '20201E'

/** Which way the save dialog was answered. */
export type PaperChoice = 'keep' | 'plain'

/**
 * Rewrites an exported .docx to match the choice.
 *
 * Returns the bytes unchanged for anything that is not a Word document, or that
 * turns out not to be a zip — a save must never fail because a cosmetic rewrite
 * could not be applied.
 */
export function applyPaperChoice(bytes: Uint8Array, choice: PaperChoice): Uint8Array {
  let parts: Record<string, Uint8Array>
  try {
    parts = unzipSync(bytes)
  } catch {
    return bytes
  }
  if (!parts['word/document.xml']) return bytes

  const next: Record<string, Uint8Array> = { ...parts }
  const edit = (name: string, change: (xml: string) => string) => {
    const part = next[name]
    if (!part) return
    const before = strFromU8(part)
    const after = change(before)
    if (after !== before) next[name] = strToU8(after)
  }

  if (choice === 'plain') {
    // Every part, not just styles.xml: x2t writes the font onto the runs as well
    // as the defaults, and a document left half-converted is worse than either
    // whole answer. The name is ours and distinctive, so there is nothing else
    // in the file it can collide with.
    for (const name of Object.keys(next)) {
      if (name.endsWith('.xml')) edit(name, (xml) => xml.split(PAPER_FONT).join(PLAIN_FONT))
    }
    return zipSync(next)
  }

  edit('word/document.xml', addPageBackground)
  edit('word/styles.xml', addWhiteDefaultColor)
  // Without this Word parses w:background and declines to draw it, which would
  // leave exactly the white-on-white document this option exists to prevent.
  edit('word/settings.xml', addDisplayBackgroundShape)
  return zipSync(next)
}

/**
 * `w:background` is the document's page colour. It is the first child of
 * `w:document`, before `w:body`; anywhere else and Word rejects the part.
 */
function addPageBackground(xml: string): string {
  if (xml.includes('<w:background')) return xml
  const body = xml.indexOf('<w:body')
  if (body === -1) return xml
  return `${xml.slice(0, body)}<w:background w:color="${PAPER_PAGE}"/>${xml.slice(body)}`
}

/**
 * White text as real formatting, not the automatic colour.
 *
 * Automatic resolves to black against a page Word thinks is white, so a document
 * with a dark page and automatic text is unreadable in every reader that honours
 * one and not the other. This is the half that makes "keep the Holmes look"
 * legible rather than merely dark.
 */
function addWhiteDefaultColor(xml: string): string {
  if (/<w:rPrDefault>[\s\S]*?<w:color /.test(xml)) return xml
  return xml.replace(/(<w:rPrDefault>\s*<w:rPr>)/, '$1<w:color w:val="FFFFFF"/>')
}

function addDisplayBackgroundShape(xml: string): string {
  if (xml.includes('<w:displayBackgroundShape')) return xml
  const settings = xml.indexOf('<w:settings')
  if (settings === -1) return xml
  const open = xml.indexOf('>', settings)
  if (open === -1) return xml
  return `${xml.slice(0, open + 1)}<w:displayBackgroundShape/>${xml.slice(open + 1)}`
}
