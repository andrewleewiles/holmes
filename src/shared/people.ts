import type {
  AnalysisPersonEntry,
  ParsedPersonEntry,
  PersonRelation,
} from './types'

export const PEOPLE_BLOCK_HEADING = 'PEOPLE:'

export const PERSON_RELATIONS: PersonRelation[] = [
  'family',
  'partner',
  'friend',
  'colleague',
  'client',
  'professional',
  'community',
  'acquaintance',
  'public',
  'self',
  'unknown',
]

/**
 * Words models write instead of the vocabulary, each mapped to the relation it
 * means and — where the word is itself the answer — the role it states.
 *
 * The role half is why this table is worth its size: "- Linda | mother | ..."
 * carries both facts in one cell, and a table that only normalized `mother` to
 * `family` would throw the more specific one away.
 */
const RELATION_ALIASES: Record<string, { relation: PersonRelation; role: string }> = {}

function alias(relation: PersonRelation, words: string[], roleIsWord = true): void {
  for (const word of words) {
    RELATION_ALIASES[word] = { relation, role: roleIsWord ? word : '' }
  }
}

alias('family', [
  'mom', 'mother', 'mum', 'mommy', 'dad', 'father', 'daddy', 'parent', 'parents',
  'sister', 'brother', 'sibling', 'son', 'daughter', 'child', 'children', 'kid',
  'cousin', 'aunt', 'uncle', 'grandmother', 'grandma', 'grandfather', 'grandpa',
  'grandparent', 'nephew', 'niece', 'stepmother', 'stepfather', 'stepsister',
  'stepbrother', 'mother-in-law', 'father-in-law', 'sister-in-law', 'brother-in-law',
  'in-law', 'relative', 'godmother', 'godfather',
])
alias('partner', [
  'wife', 'husband', 'spouse', 'girlfriend', 'boyfriend', 'fiance', 'fiancee',
  'ex', 'ex-wife', 'ex-husband', 'ex-girlfriend', 'ex-boyfriend', 'date', 'partner',
])
alias('colleague', [
  'coworker', 'co-worker', 'boss', 'manager', 'supervisor', 'report', 'teammate',
  'employer', 'employee', 'cofounder', 'co-founder', 'colleague', 'director',
  'recruiter', 'intern', 'mentor',
])
alias('client', ['customer', 'vendor', 'contractor', 'supplier', 'counterparty', 'buyer', 'seller', 'landlord', 'tenant', 'agent', 'realtor', 'broker'])
alias('professional', [
  'doctor', 'physician', 'therapist', 'psychiatrist', 'psychologist', 'trainer',
  'coach', 'lawyer', 'attorney', 'accountant', 'dentist', 'teacher', 'professor',
  'nurse', 'barber', 'stylist', 'surgeon', 'chiropractor', 'dietitian',
  'nutritionist', 'instructor', 'advisor', 'provider', 'clinician', 'specialist',
])
alias('community', ['neighbor', 'neighbour', 'classmate', 'roommate', 'housemate', 'congregant', 'churchmember', 'groupmate', 'clubmate'])
alias('friend', ['friend', 'buddy', 'bestfriend', 'pal', 'bff'])
alias('public', ['author', 'artist', 'musician', 'actor', 'athlete', 'politician', 'celebrity', 'creator', 'streamer', 'writer', 'director-film', 'podcaster', 'influencer', 'journalist'])
alias('self', ['me', 'user', 'owner', 'myself', 'archiveowner'], false)
alias('acquaintance', ['contact', 'associate', 'connection'], false)
alias('unknown', ['unclear', 'unspecified', 'unstated', 'na'], false)

const NULL_TOKENS = new Set(['none', 'unknown', 'n/a', 'na', 'nobody', 'no one', 'tbd', '-', '—', '?', 'various', 'several', 'someone', 'unnamed'])

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'madam', 'rev', 'fr', 'st', 'capt', 'sgt', 'lt'])

/**
 * Suffixes stripped from a name key. Generational suffixes (jr, sr, ii, iii) are
 * deliberately absent: stripping them would merge a father and his son, which is
 * exactly the over-merge this whole subsystem is built to avoid.
 */
const DROPPED_SUFFIXES = new Set(['md', 'phd', 'esq', 'dds', 'rn', 'do', 'mba', 'cpa'])

const MAX_NAME_CHARS = 80
const MAX_ROLE_CHARS = 60
const MAX_EVIDENCE_CHARS = 300
const MAX_AKA_ENTRIES = 6

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Must admit the national form `(555) 123-4567` as readily as `+15551234567`:
// iMessage handles arrive fully qualified while Contacts stores the national
// form, and a pattern that only takes one of them never matches the other.
const PHONE_RE = /^\+?[\d(][\d\s().+-]{5,}$/
// A date-shaped first cell means a stray TIMELINE line landed in the block.
const DATE_LIKE_RE = /^(?:\d{4}(?:-\d{2}(?:-\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*\.\.|\s*$)/

export function normalizePersonRelation(raw: string | null | undefined): { relation: PersonRelation; role: string } {
  const cell = (raw ?? '').trim().toLowerCase()
  if (!cell) return { relation: 'unknown', role: '' }

  // `relation:role` — the role rides in the same cell, so the format stays four
  // cells wide while still carrying the specific answer.
  const colon = cell.indexOf(':')
  const head = (colon === -1 ? cell : cell.slice(0, colon)).trim()
  const tail = colon === -1 ? '' : cell.slice(colon + 1).trim()

  const key = head.replace(/[^a-z-]/g, '')
  if (!key) return { relation: 'unknown', role: tail.slice(0, MAX_ROLE_CHARS) }

  if ((PERSON_RELATIONS as string[]).includes(key)) {
    return { relation: key as PersonRelation, role: tail.slice(0, MAX_ROLE_CHARS) }
  }
  const aliased = RELATION_ALIASES[key]
  if (aliased) {
    return { relation: aliased.relation, role: (tail || aliased.role).slice(0, MAX_ROLE_CHARS) }
  }
  // A word nobody anticipated is `unknown`, never a plausible-looking bucket —
  // a wrong relation is asserted downstream as fact.
  return { relation: 'unknown', role: (tail || head).slice(0, MAX_ROLE_CHARS) }
}

/** True when a cell is a relation word (optionally `relation:role`) rather than a phrase. */
function looksLikeRelationCell(cell: string): boolean {
  const lower = cell.trim().toLowerCase()
  if (!lower) return false
  if (!/^[a-z][a-z-]{0,24}(:[a-z][a-z0-9 '/-]{0,49})?$/.test(lower)) return false
  const head = (lower.split(':')[0] ?? '').replace(/[^a-z-]/g, '')
  return (PERSON_RELATIONS as string[]).includes(head) || head in RELATION_ALIASES
}

/** True when a cell looks like an alternate-names list rather than a sentence. */
function looksLikeAkaCell(cell: string): boolean {
  const trimmed = cell.trim()
  if (!trimmed) return false
  if (/[;@]/.test(trimmed) || /^\+\d/.test(trimmed)) return true
  if (trimmed.length >= 40) return false
  if (/[.!?]$/.test(trimmed)) return false
  return /[A-Z]/.test(trimmed) && trimmed.split(/\s+/).length <= 4
}

function foldDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/**
 * Splits camelCase and PascalCase runs. Real photo albums in this corpus are
 * named `sarahPhillipsPhotoshoot` / `brookeAndrewProm`, and the folder prompt is
 * how those names reach People at all — without this they key as one token and
 * never match the person.
 */
function splitCamelCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

/** The name tokens two spellings of one person must share. */
export function personTokens(raw: string): string[] {
  if (!raw) return []
  let value = splitCamelCase(raw)
  value = foldDiacritics(value).toLowerCase()
  // Emoji, decorations and bracketed asides: a real counterparty here is
  // literally stored as `erika duffin :)`.
  value = value.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
  value = value.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  value = value.replace(/[^a-z0-9'\- ]/g, ' ')
  const tokens = value.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^['-]+|['-]+$/g, '')
    if (!token) continue
    if (index === 0 && HONORIFICS.has(token)) continue
    if (DROPPED_SUFFIXES.has(token)) continue
    out.push(token)
  }
  return out
}

export function personKey(raw: string): string {
  return personTokens(raw).join(' ')
}

/**
 * Emails and phone numbers identify a person far more reliably than a name does,
 * so they get their own key space. Phones match on the last ten digits, the same
 * rule `contactsDb` uses — handles arrive fully qualified while Contacts stores
 * the national form, and an exact comparison of the two never matches.
 */
export function handleKey(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (EMAIL_RE.test(trimmed)) return trimmed.toLowerCase()
  if (PHONE_RE.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) return null
    return digits.length > 10 ? digits.slice(-10) : digits
  }
  return null
}

export function isPseudonymName(raw: string): boolean {
  return /^contact-[0-9a-f]{4,}$/i.test((raw ?? '').trim())
}

function cleanCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
}

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•+]|\d+[.)])\s*/, '').trim()
}

function parseAka(cell: string): string[] {
  if (!cell) return []
  return cell
    .split(/[;,]/)
    .map((part) => cleanCell(part))
    .filter((part) => part.length > 0 && part.length <= MAX_NAME_CHARS && !NULL_TOKENS.has(part.toLowerCase()))
    .slice(0, MAX_AKA_ENTRIES)
}

/** Rejects cells that are not a person's name at all. */
function isUsableName(name: string): boolean {
  if (!name) return false
  if (name.length > MAX_NAME_CHARS) return false
  if (NULL_TOKENS.has(name.toLowerCase())) return false
  if (!/[a-z]/i.test(name)) return false
  if (DATE_LIKE_RE.test(name)) return false
  // An address in the name cell would merge every unrelated sender who shares it.
  if (EMAIL_RE.test(name) || PHONE_RE.test(name)) return false
  return true
}

/**
 * Parses one "name | relation[:role] | aka | evidence" line. Tolerant of missing
 * middle cells: models drop them often enough that a strict parser would lose
 * most of the block the first time one forgets a pipe.
 */
export function parsePersonLine(line: string): ParsedPersonEntry | null {
  const body = stripBullet(line)
  if (!body) return null
  if (NULL_TOKENS.has(body.toLowerCase())) return null

  const cells = body.split('|').map(cleanCell)
  const name = cells[0] ?? ''
  if (!isUsableName(name)) return null

  const rest = cells.slice(1).filter((cell) => cell.length > 0)
  let relationCell = ''
  let akaCell = ''
  let evidence = ''

  if (rest.length >= 3) {
    relationCell = rest[0]
    akaCell = rest[1]
    evidence = rest.slice(2).join(' — ')
  } else {
    // With a cell missing, recover by shape — relation words and name lists look
    // nothing like the evidence sentence.
    let index = 0
    if (index < rest.length && looksLikeRelationCell(rest[index])) {
      relationCell = rest[index]
      index += 1
    }
    if (index < rest.length - 1 && looksLikeAkaCell(rest[index])) {
      akaCell = rest[index]
      index += 1
    }
    evidence = rest.slice(index).join(' — ')
  }

  const { relation, role } = normalizePersonRelation(relationCell)

  return {
    name: name.slice(0, MAX_NAME_CHARS),
    relation,
    role,
    aka: parseAka(akaCell),
    evidence: evidence.slice(0, MAX_EVIDENCE_CHARS),
  }
}

const PEOPLE_HEADING_LINE = /^\s*(?:#{1,4}\s*)?\**\s*PEOPLE\s*\**\s*:?\s*$/i

// The contract puts the block last, so the final heading wins: prose mentioning
// the word earlier does not truncate the real block.
function findPeopleHeadingLine(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (PEOPLE_HEADING_LINE.test(lines[index])) return index
  }
  return -1
}

/**
 * Extracts the trailing PEOPLE: block from a generated context and parses it.
 *
 * The block sits after TIMELINE:, and both parsers stop at the other's heading
 * via the shared ALL-CAPS terminator, so the two coexist in one context.
 */
export function parsePeopleBlock(text: string): ParsedPersonEntry[] {
  if (!text) return []
  const lines = text.split('\n')
  const headingIndex = findPeopleHeadingLine(lines)
  if (headingIndex === -1) return []

  const entries: ParsedPersonEntry[] = []
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    // A new heading ends the block.
    if (/^#{1,4}\s/.test(trimmed) || /^[A-Z][A-Z \t]{3,}:$/.test(trimmed)) break
    const entry = parsePersonLine(trimmed)
    if (entry) entries.push(entry)
  }
  return entries
}

/** The generated prose keeps its block; this strips it for surfaces that render people separately. */
export function stripPeopleBlock(text: string): string {
  if (!text) return text
  const lines = text.split('\n')
  const headingIndex = findPeopleHeadingLine(lines)
  if (headingIndex === -1) return text
  return lines.slice(0, headingIndex).join('\n').trimEnd()
}

export function personDedupeKey(sourceRef: string, rawName: string): string {
  return `${sourceRef}::${personKey(rawName) || rawName.toLowerCase()}`
}

export function renderPersonLine(entry: {
  displayName: string
  relation: PersonRelation
  role: string
}): string {
  const label = entry.role ? `${entry.relation}, ${entry.role}` : entry.relation
  return `- ${entry.displayName} (${label})`
}

/**
 * Identifies a person's evidence set for the dossier cache gate. Sorted, so the
 * hash does not change when the harvest happens to visit sources in a new order.
 */
export function mentionsFingerprint(
  mentions: Array<{ sourceRef: string; rawName: string; relation: string; evidence: string }>
): string {
  return mentions
    .map((mention) => `${mention.sourceRef}|${mention.rawName}|${mention.relation}|${mention.evidence.length}`)
    .sort()
    .join('\n')
}

/**
 * The PEOPLE contract every generated context must follow. Shared so the file,
 * folder, project, user, conversation and memory prompts all emit a block the
 * same parser can read.
 *
 * The block goes AFTER the timeline block, and that ordering is load-bearing:
 * `extractClaims` bounds prose claims at the TIMELINE heading, so everything
 * here is already excluded from citation without a second exclusion rule.
 */
export function peoplePromptSection(maxPeople: number): string {
  return `PEOPLE (required):
After the timeline section, output a final section whose first line is exactly "${PEOPLE_BLOCK_HEADING}" and which then contains one line per person this material names, in this exact pipe-delimited format:

- <name> | <relation[:role]> | <aka> | <evidence>

- <name>: the person's name as this material writes it ("Mom", "Sarah Jennings", "Dr. Patel"). Never a phone number, email address or street address — those belong in <aka>. Do not expand or guess a fuller name than the material gives.
- <relation>: how they stand to the person whose archive this is, from exactly this list: ${PERSON_RELATIONS.join(', ')}. Optionally add a specific role after a colon — family:mother, colleague:manager, professional:physical therapist. Use "public" for someone whose work this person reads, watches or follows but does not personally know. Use "self" for the person whose archive this is, always, and never label them anything else.
- <aka>: other names, nicknames, email addresses or phone numbers THIS MATERIAL SHOWS FOR THE SAME PERSON, separated by semicolons. Leave empty when the material shows only one form. This is how "Mom" and "Sarah Jennings" become one person rather than two, so record a co-reference whenever the material actually makes one.
- <evidence>: one clause naming what this material shows about them and about how they relate to the person.

Rules: record only people this material actually names. Never guess a relationship the material does not state — "unknown" is correct and is strongly preferred over a plausible label, because a stated relation is treated downstream as fact. Never merge two people who merely share a first name. Do not list organizations, companies, brands, products or fictional characters, and do not list the boilerplate contact printed on a form. One line per person, not per appearance. Emit at most ${maxPeople} entries, chosen by how much this material actually says about them. If this material names nobody, output "${PEOPLE_BLOCK_HEADING}" followed by a single line reading "- none".`
}

export const ANALYSIS_PEOPLE_JSON_FIELD = `  "people": [
    {
      "name": "<the person's name as the data writes it, never a phone number or email address>",
      "relation": "<${PERSON_RELATIONS.join('|')}>",
      "role": "<optional short specific role, e.g. 'mother', 'manager', 'primary care physician'>",
      "aka": ["<other names, handles or addresses this data shows for the same person>"],
      "evidence": "<one sentence on what this data shows about them and how they relate to the person>"
    }
  ],`

export function analysisPeoplePromptRule(maxPeople: number): string {
  return `- "people" lists the individuals this data names, at most ${maxPeople}, chosen by how much the data says about them. Use "unknown" for the relation whenever the data does not actually state how they relate to the person — a plausible guess is treated downstream as fact. Never record an organization, brand or product as a person, and never put a phone number or email address in "name". Use an empty array when the data names nobody.`
}

export function coerceAnalysisPeople(value: unknown): AnalysisPersonEntry[] {
  if (!Array.isArray(value)) return []
  const out: AnalysisPersonEntry[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) continue
    out.push({
      name,
      relation: typeof record.relation === 'string' ? record.relation : undefined,
      role: typeof record.role === 'string' ? record.role : undefined,
      aka: Array.isArray(record.aka) ? record.aka.filter((item): item is string => typeof item === 'string') : undefined,
      evidence: typeof record.evidence === 'string' ? record.evidence : undefined,
    })
  }
  return out
}

export function analysisPeopleToEntries(entries: AnalysisPersonEntry[] | undefined): ParsedPersonEntry[] {
  if (!entries?.length) return []
  const out: ParsedPersonEntry[] = []
  for (const entry of entries) {
    const name = (entry.name ?? '').trim()
    if (!isUsableName(name)) continue
    const combined = entry.role ? `${entry.relation ?? ''}:${entry.role}` : (entry.relation ?? '')
    const { relation, role } = normalizePersonRelation(combined)
    out.push({
      name: name.slice(0, MAX_NAME_CHARS),
      relation,
      role,
      aka: parseAka((entry.aka ?? []).join('; ')),
      evidence: (entry.evidence ?? '').slice(0, MAX_EVIDENCE_CHARS),
    })
  }
  return out
}
