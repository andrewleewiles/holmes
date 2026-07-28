/**
 * XML entity decoding, shared by every extractor that reads a zipped XML
 * container — DOCX and XLSX in the document indexer, XHTML and OPF in the EPUB
 * parser. It lives here rather than in documentContext.ts so the book parser
 * does not have to import the indexer to read a chapter.
 *
 * `&amp;` is decoded LAST on purpose: decoding it first would turn `&amp;lt;`
 * into `&lt;` and then into `<`, inventing markup that was escaped precisely so
 * it would not be markup.
 */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      const point = Number.parseInt(code, 16)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/&amp;/g, '&')
}
