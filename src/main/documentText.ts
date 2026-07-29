// Office document text extraction: DOCX, XLSX and PPTX are zips of XML, so
// `fflate.unzipSync` — already how EPUBs are read — is the whole of it.
//
// This module is deliberately free of database and Electron imports so both the
// document indexer and Recall can use it, and so it can be unit-tested against a
// zip built in-test.
import fs from 'fs'
import { unzipSync, strFromU8 } from 'fflate'
import { decodeXmlEntities } from '../shared/xmlText'

export function extractDocxText(filePath: string, maxChars: number): string {
  const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)))
  const doc = files['word/document.xml']
  if (!doc) return ''
  const xml = strFromU8(doc)
  // One line per paragraph rather than one blob: a document flattened to a
  // single line can only ever be cited as "line 1", which tells a reader nothing.
  const lines: string[] = []
  let used = 0
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const runs = [...paragraph[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1]))
    const line = runs.join('')
    if (!line.trim()) continue
    lines.push(line)
    used += line.length + 1
    if (used > maxChars) break
  }
  return lines.join('\n')
}

/**
 * Column index of a cell reference such as `C5` (zero-based), or -1 when the
 * reference is missing or malformed.
 */
export function spreadsheetColumnIndex(reference: string): number {
  const letters = /^([A-Z]+)\d+$/.exec(reference.trim().toUpperCase())?.[1]
  if (!letters) return -1
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

/**
 * Trailing `.0` on a whole number is an artifact of the XML's float encoding,
 * not something the sheet ever displayed. Left in, a rating column reads as
 * `10.0` and a year as `2023.0`.
 */
function trimNumericNoise(value: string): string {
  return /^-?\d+\.0+$/.test(value) ? value.replace(/\.0+$/, '') : value
}

export function extractXlsxText(filePath: string, maxChars: number): string {
  const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)))
  const sharedXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : ''
  // A shared string can be split across several runs (<si><r><t>a</t></r>...),
  // so join per <si> rather than treating every <t> as its own entry — a stray
  // extra entry shifts every subsequent string index by one.
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) => (
    [...si[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXmlEntities(m[1])).join('')
  ))

  const sheetNames = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => (
      Number(/(\d+)\.xml$/.exec(left)?.[1] || 0) - Number(/(\d+)\.xml$/.exec(right)?.[1] || 0)
    ))
  const titles = sheetTitles(files)

  // One line per spreadsheet row, so a citation names a row a reader can find.
  const out: string[] = []
  let used = 0
  for (const [sheetIndex, name] of sheetNames.entries()) {
    const sheetXml = strFromU8(files[name])
    if (sheetNames.length > 1) {
      out.push(`# ${titles[sheetIndex] || name.replace(/^xl\/worksheets\//, '')}`)
    }
    for (const row of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      // Values are placed by their cell reference, not by order of appearance:
      // a blank interior cell is simply absent from the XML, and dropping it
      // would shift every later value one column left, so a rating would be
      // read under the genre header.
      const values: string[] = []
      let column = 0
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1]
        const inner = cell[2]
        const referenced = spreadsheetColumnIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] || '')
        if (referenced >= 0) column = referenced
        let value = ''
        if (/\bt="s"/.test(attrs)) {
          const v = inner.match(/<v[^>]*>([^<]*)<\/v>/)
          if (v) value = sharedStrings[Number(v[1])] ?? ''
        } else {
          const t = inner.match(/<t[^>]*>([^<]*)<\/t>/)
          const v = inner.match(/<v[^>]*>([^<]*)<\/v>/)
          value = t ? decodeXmlEntities(t[1]) : v ? trimNumericNoise(v[1]) : ''
        }
        if (value) {
          while (values.length < column) values.push('')
          values[column] = value
        }
        column += 1
      }
      if (values.every((value) => !value)) continue
      const line = values.join('\t').replace(/\t+$/, '')
      out.push(line)
      used += line.length + 1
      if (used > maxChars) return out.join('\n')
    }
  }
  return out.join('\n')
}

/**
 * A deck's text, grouped by slide.
 *
 * Slides are headed rather than flattened for the same reason a workbook is
 * headed by sheet: "slide 7" is something a reader can turn to, where a line
 * number into a concatenated deck is not.
 */
export function extractPptxText(filePath: string, maxChars: number): string {
  const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)))
  // Ordered by the numeric suffix, not by name: `slide10.xml` sorts before
  // `slide2.xml` lexically, which would silently reorder any deck of ten or
  // more slides. Same reason extractXlsxText sorts its worksheets numerically.
  const slideNames = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => (
      Number(/(\d+)\.xml$/.exec(left)?.[1] || 0) - Number(/(\d+)\.xml$/.exec(right)?.[1] || 0)
    ))

  const out: string[] = []
  let used = 0
  for (const name of slideNames) {
    const index = Number(/(\d+)\.xml$/.exec(name)?.[1] || 0)
    const xml = strFromU8(files[name])
    out.push(`# Slide ${index}`)
    used += 9
    // One line per <a:p>, so a bullet stays a bullet instead of running into
    // the next one. The <a:t> runs inside a paragraph are joined with no
    // separator: PowerPoint splits a single word across runs wherever
    // formatting changes, so anything between them breaks the word.
    for (const paragraph of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const line = [...paragraph[1].matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
        .map((match) => decodeXmlEntities(match[1]))
        .join('')
      if (!line.trim()) continue
      out.push(line)
      used += line.length + 1
    }
    // Speaker notes carry the argument the slide only gestures at, so they are
    // part of the document rather than metadata.
    const notes = files[`ppt/notesSlides/notesSlide${index}.xml`]
    if (notes) {
      const notesText = [...strFromU8(notes).matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
        .map((match) => decodeXmlEntities(match[1]))
        .join('')
        .trim()
      // The notes pane repeats the slide number as its own text box; that is
      // chrome, not content.
      if (notesText && notesText !== String(index)) {
        out.push(`Notes: ${notesText}`)
        used += notesText.length + 8
      }
    }
    if (used > maxChars) break
  }
  return out.join('\n')
}

/** Human sheet names in workbook order, so rows are labelled "Movies" not "sheet1.xml". */
function sheetTitles(files: Record<string, Uint8Array>): string[] {
  const workbook = files['xl/workbook.xml']
  if (!workbook) return []
  return [...strFromU8(workbook).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)]
    .map((match) => decodeXmlEntities(match[1]))
}
