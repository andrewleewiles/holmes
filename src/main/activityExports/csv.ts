/**
 * A record-oriented CSV parser for account exports.
 *
 * This deliberately does not reuse the four `splitCsvLine`/`parseCsv` pairs
 * already in the codebase: those split the text on newlines *before* parsing
 * quotes, which is fine for the Amazon and Apple CSVs they were written for but
 * silently corrupts any file with a newline inside a quoted field. Discord
 * message exports are full of them — a multi-line message becomes several
 * broken rows and the column alignment is gone for everything after it.
 */

export interface CsvTable {
  headers: string[]
  rows: string[][]
}

/** Parses the whole document in one pass so quoted newlines survive. */
export function parseCsv(text: string, maxRows = 500_000): CsvTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnyChar = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    // Skip the blank row a trailing newline produces.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length && rows.length < maxRows; i += 1) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      sawAnyChar = true
    } else if (ch === ',') {
      endField()
    } else if (ch === '\r') {
      // Consume CRLF as one terminator.
      if (text[i + 1] === '\n') i += 1
      endRow()
    } else if (ch === '\n') {
      endRow()
    } else {
      field += ch
      sawAnyChar = true
    }
  }

  if (field.length > 0 || row.length > 0 || sawAnyChar) endRow()

  const headers = rows.shift() ?? []
  return { headers: headers.map((h) => h.trim()), rows }
}

/** Header lookup that tolerates spacing, casing and underscore differences. */
export function csvColumn(headers: string[], ...aliases: string[]): number {
  const normalize = (value: string): string => value.toLowerCase().replace(/[\s_\-.]+/g, '')
  const normalized = headers.map(normalize)
  for (const alias of aliases) {
    const target = normalize(alias)
    const exact = normalized.indexOf(target)
    if (exact !== -1) return exact
  }
  for (const alias of aliases) {
    const target = normalize(alias)
    const partial = normalized.findIndex((h) => h.includes(target))
    if (partial !== -1) return partial
  }
  return -1
}

export function csvValue(row: string[], index: number): string {
  if (index < 0 || index >= row.length) return ''
  return (row[index] ?? '').trim()
}
