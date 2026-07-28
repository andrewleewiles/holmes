/**
 * Resolving phone numbers and email addresses to contact names.
 *
 * `imessage.ts` does this by shelling out to `osascript` against the Contacts
 * app. That path is unreliable in practice: it needs its own TCC grant on top
 * of Full Disk Access, it blocks for its full ten-second timeout when the grant
 * is missing, and it swallows the failure — on this machine it returns zero
 * entries, so every conversation is attributed to a pseudonym instead of a name.
 *
 * The same data is in the local AddressBook SQLite store, which Full Disk
 * Access already covers. Reading it directly is fast, needs no extra
 * permission, and cannot hang.
 *
 * Numbers are indexed by their last ten digits as well as in full: iMessage
 * handles arrive fully qualified (`+15551234567`) while Contacts commonly
 * stores the national form (`(555) 123-4567`), and an exact comparison of the
 * two never matches.
 */

import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SOURCES_DIR = path.join(os.homedir(), 'Library/Application Support/AddressBook/Sources')
const LOCAL_STORE = path.join(os.homedir(), 'Library/Application Support/AddressBook/AddressBook-v22.abcddb')

export interface ContactIndex {
  /** Lowercased email address, or full digit string, to name. */
  direct: Map<string, string>
  /** Last ten digits to name. */
  byLastTen: Map<string, string>
  /** How many contacts contributed, for diagnostics. */
  size: number
}

interface ContactRow {
  first: string | null
  last: string | null
  organization: string | null
  value: string | null
}

function displayName(row: ContactRow): string | null {
  const full = [row.first, row.last].filter(Boolean).join(' ').trim()
  if (full) return full
  const org = row.organization?.trim()
  return org || null
}

/** Every AddressBook store on this machine — one per configured account. */
function storePaths(): string[] {
  const paths: string[] = []

  try {
    for (const entry of fs.readdirSync(SOURCES_DIR)) {
      const candidate = path.join(SOURCES_DIR, entry, 'AddressBook-v22.abcddb')
      if (fs.existsSync(candidate)) paths.push(candidate)
    }
  } catch {
    // No Sources directory: an account-less Contacts setup, handled below.
  }

  if (fs.existsSync(LOCAL_STORE)) paths.push(LOCAL_STORE)
  return paths
}

function readStore(dbPath: string, index: ContactIndex): void {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })

    const phones = db
      .prepare(
        `SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS organization,
                p.ZFULLNUMBER AS value
         FROM ZABCDPHONENUMBER p
         JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`
      )
      .all() as ContactRow[]

    for (const row of phones) {
      const name = displayName(row)
      if (!name || !row.value) continue
      const digits = row.value.replace(/\D/g, '')
      if (digits.length < 7) continue
      if (!index.direct.has(digits)) index.direct.set(digits, name)
      if (digits.length >= 10 && !index.byLastTen.has(digits.slice(-10))) {
        index.byLastTen.set(digits.slice(-10), name)
      }
      index.size += 1
    }

    const emails = db
      .prepare(
        `SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS organization,
                e.ZADDRESS AS value
         FROM ZABCDEMAILADDRESS e
         JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`
      )
      .all() as ContactRow[]

    for (const row of emails) {
      const name = displayName(row)
      if (!name || !row.value) continue
      const address = row.value.trim().toLowerCase()
      if (!address) continue
      if (!index.direct.has(address)) index.direct.set(address, name)
      index.size += 1
    }
  } catch {
    // A store that cannot be opened (locked, or a schema this does not know)
    // simply contributes nothing; the others still count.
  } finally {
    try {
      db?.close()
    } catch {
      // Nothing useful to do if it never opened.
    }
  }
}

/**
 * Reads every AddressBook store. Returns an empty index rather than throwing
 * when Contacts is unreadable — an unnamed conversation is degraded, not fatal.
 */
export function readContactIndex(): ContactIndex {
  const index: ContactIndex = { direct: new Map(), byLastTen: new Map(), size: 0 }
  for (const dbPath of storePaths()) readStore(dbPath, index)
  return index
}

/** Name for a handle, or null when Contacts has nothing for it. */
export function lookupContact(index: ContactIndex, handle: string): string | null {
  const trimmed = handle.trim()
  if (!trimmed) return null

  const direct = index.direct.get(trimmed.toLowerCase())
  if (direct) return direct

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length >= 7) {
    const byDigits = index.direct.get(digits)
    if (byDigits) return byDigits
  }
  if (digits.length >= 10) {
    const byLastTen = index.byLastTen.get(digits.slice(-10))
    if (byLastTen) return byLastTen
  }

  return null
}

/**
 * One row per Contacts record, keeping the record identity that `readContactIndex`
 * flattens away.
 *
 * People needs the record, not the lookup: a person is an entity with several
 * handles, and an index keyed by handle cannot say that two handles belong to the
 * same card. `Z_PK` is stable for the life of the store, which is what makes
 * `contact:<pk>` a person key that survives every rebuild.
 */
export interface ContactRecord {
  recordId: string
  name: string
  emails: string[]
  phones: string[]
  organization: string | null
}

interface RecordRow {
  pk: number
  first: string | null
  last: string | null
  organization: string | null
}

function readStoreRecords(dbPath: string, storeId: string, out: Map<string, ContactRecord>): void {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })

    const records = db
      .prepare(
        `SELECT r.Z_PK AS pk, r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS organization
         FROM ZABCDRECORD r`
      )
      .all() as RecordRow[]

    for (const row of records) {
      const name = displayName({ first: row.first, last: row.last, organization: row.organization, value: null })
      if (!name) continue
      const recordId = `${storeId}:${row.pk}`
      out.set(recordId, { recordId, name, emails: [], phones: [], organization: row.organization })
    }

    const phones = db
      .prepare('SELECT ZOWNER AS owner, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER')
      .all() as Array<{ owner: number; value: string | null }>
    for (const row of phones) {
      const record = out.get(`${storeId}:${row.owner}`)
      if (!record || !row.value) continue
      record.phones.push(row.value)
    }

    const emails = db
      .prepare('SELECT ZOWNER AS owner, ZADDRESS AS value FROM ZABCDEMAILADDRESS')
      .all() as Array<{ owner: number; value: string | null }>
    for (const row of emails) {
      const record = out.get(`${storeId}:${row.owner}`)
      if (!record || !row.value) continue
      record.emails.push(row.value.trim().toLowerCase())
    }
  } catch {
    // A store that cannot be opened contributes nothing; the others still count.
  } finally {
    try {
      db?.close()
    } catch {
      // Nothing useful to do if it never opened.
    }
  }
}

export function readContactRecords(): ContactRecord[] {
  const out = new Map<string, ContactRecord>()
  const paths = storePaths()
  for (let index = 0; index < paths.length; index += 1) {
    // The store index keeps Z_PK values from colliding across accounts.
    readStoreRecords(paths[index], String(index), out)
  }
  return [...out.values()]
}
