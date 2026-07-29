// Regenerates src/shared/workRoles.ts from assets/characterRoles.xlsx.
//
// The spreadsheet is the source of truth for the role catalog — it is where the
// characters, their colours, and their tool lists are authored. This script
// exists so that stays true without the app having to parse a workbook at boot.
//
//   node scripts/generate-work-roles.mjs
//
// Run it after editing the spreadsheet, and commit the generated file.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { unzipSync, strFromU8 } from 'fflate'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(root, 'assets/characterRoles.xlsx')
const TARGET = path.join(root, 'src/shared/workRoles.ts')

/**
 * In-cell line breaks are not always U+000A. Numbers writes U+2028 LINE
 * SEPARATOR, and the sheet mixes both — the Game Studio row uses U+2028 while
 * its neighbours use \n. Splitting on \n alone silently collapses that row into
 * one 86-character "tool", which is how this was missed the first time.
 */
const LINE_BREAKS = /[\n\r\u2028\u2029]+/

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n').replace(/&#xA;/gi, '\n')
    .replace(/&amp;/g, '&')
}

function readSheet(filePath) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)))
  const sharedXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : ''
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((si) =>
    [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(''),
  )
  const sheetName = Object.keys(files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
  if (!sheetName) throw new Error('No worksheet found in the workbook')
  const xml = strFromU8(files[sheetName])

  const rows = []
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const cells = {}
    for (const cell of row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const column = /r="([A-Z]+)\d+"/.exec(cell[1])?.[1]
      if (!column) continue
      let value = ''
      if (/\bt="s"/.test(cell[1])) {
        const index = /<v[^>]*>([^<]*)<\/v>/.exec(cell[2])
        if (index) value = shared[Number(index[1])] ?? ''
      } else {
        const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])
        const raw = /<v[^>]*>([^<]*)<\/v>/.exec(cell[2])
        value = inline ? decodeXml(inline[1]) : raw ? raw[1] : ''
      }
      if (value) cells[column] = value
    }
    rows.push(cells)
  }
  return rows
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function parseTools(raw, warnings, role) {
  if (!raw) return []
  // Four rows carry a bare number here rather than a tool list — leftovers from
  // another column. Treated as "no tools authored yet", not as a tool called 33.
  if (/^\d+$/.test(raw.trim())) return []
  const lines = raw.split(LINE_BREAKS).map((line) => line.trim()).filter(Boolean)
  // A single long run means the cell used a separator this does not know about;
  // better to say so than to render one unusable button.
  if (lines.length === 1 && lines[0].split(/\s+/).length > 3) {
    warnings.push(`${role}: Tools cell did not split — unrecognised line separator. Codepoints: ${[...new Set([...lines[0]].filter((c) => c.codePointAt(0) < 48).map((c) => c.codePointAt(0)))].join(',')}`)
    return []
  }
  return lines
}

const rows = readSheet(SOURCE)
const header = rows.find((cells) => cells.A === 'Name' && cells.B === 'Role')
if (!header) throw new Error('Could not find the header row (expected "Name" in A and "Role" in B)')
const headerIndex = rows.indexOf(header)

const warnings = []
const roles = []
for (const cells of rows.slice(headerIndex + 1)) {
  const character = (cells.A ?? '').trim()
  const role = (cells.B ?? '').trim()
  // The sheet trails a few scratch rows with a number in A and "#" in C.
  if (!role || !character || /^\d+$/.test(character)) continue
  roles.push({
    id: slugify(role),
    role,
    character,
    color: (cells.C ?? '').trim() || '#8b857f',
    tools: parseTools(cells.D, warnings, role),
  })
}

if (!roles.length) throw new Error('No roles parsed — has the sheet layout changed?')

const body = roles
  .map((entry) => {
    const tools = entry.tools.length
      ? `[${entry.tools.map((tool) => JSON.stringify(tool)).join(', ')}]`
      : '[]'
    return `  {
    id: ${JSON.stringify(entry.id)},
    role: ${JSON.stringify(entry.role)},
    character: ${JSON.stringify(entry.character)},
    color: ${JSON.stringify(entry.color)},
    tools: ${tools},
  },`
  })
  .join('\n')

const output = `// GENERATED FILE — do not edit by hand.
//
// Source: assets/characterRoles.xlsx
// Regenerate: node scripts/generate-work-roles.mjs
//
// The workbook is where these are authored; this module exists so the app does
// not have to parse a spreadsheet at boot. Editing here is lost on the next run.

/** One row of the character/role sheet, as the Work tab uses it. */
export interface WorkRole {
  /** Slug of the role name, stable across renames of the character. */
  id: string
  /** The Role column — what the dropdown lists. */
  role: string
  /** The Name column — the character who embodies the role. */
  character: string
  color: string
  /**
   * The Tools column, one entry per line in the sheet. Empty when no tools have
   * been authored for the role yet, in which case the Work tab keeps its
   * default actions rather than showing an empty nav.
   */
  tools: string[]
}

export const WORK_ROLES: readonly WorkRole[] = [
${body}
]

const BY_ID: ReadonlyMap<string, WorkRole> = new Map(WORK_ROLES.map((role) => [role.id, role]))

export function getWorkRole(id: string | null | undefined): WorkRole | null {
  if (!id) return null
  return BY_ID.get(id) ?? null
}

export function isWorkRoleId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value)
}

/** Roles that actually change the action list. */
export function workRolesWithTools(): WorkRole[] {
  return WORK_ROLES.filter((role) => role.tools.length > 0)
}
`

fs.writeFileSync(TARGET, output)
console.log(`Wrote ${path.relative(root, TARGET)} — ${roles.length} roles, ${roles.filter((r) => r.tools.length).length} with tools`)
for (const role of roles) {
  console.log(`  ${role.role.padEnd(14)} ${String(role.tools.length).padStart(2)} tools  (${role.character})`)
}
if (warnings.length) {
  console.log('\nWarnings:')
  for (const warning of warnings) console.log(`  ! ${warning}`)
}
