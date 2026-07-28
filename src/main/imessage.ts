import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'

const IMESSAGE_DB = path.join(os.homedir(), 'Library/Messages/chat.db')
const APPLE_EPOCH_OFFSET = 978307200

export function appleDateToUnix(appleDate: number): number {
  const seconds = Math.abs(appleDate) > 1_000_000_000_000 ? appleDate / 1_000_000_000 : appleDate
  return Math.floor(seconds) + APPLE_EPOCH_OFFSET
}

function isShortCode(handle: string): boolean {
  return /^\d{1,6}$/.test(handle.trim())
}

function isLikelyAutomated(handle: string): boolean {
  const lower = handle.toLowerCase()
  const automatedPatterns = [
    /^noreply/i,
    /^no-reply/i,
    /^donotreply/i,
    /^do-not-reply/i,
    /^notifications?@/i,
    /^alert[s]?@/i,
    /^verify@/i,
    /^confirmation@/i,
    /^support@/i,
    /^info@/i,
    /^newsletter@/i,
    /^marketing@/i,
    /^update@/i,
    /^team@/i,
    /^hello@/i,
    /^mail@/i,
    /^contact@/i,
    /^service@/i,
    /^orders?@/i,
    /^ship@/i,
    /^tracking@/i,
    /^no-?reply/i,
    /\.onmicrosoft\.com$/i,
    /\.mail\./i,
  ]
  return automatedPatterns.some((p) => p.test(lower))
}

export function buildContactMap(): Record<string, string> {
  const script = `
    function run() {
      const Contacts = Application('Contacts')
      Contacts.includeStandardAdditions = true
      const people = Contacts.people()
      const map = {}
      people.forEach(p => {
        const name = p.name()
        if (!name) return
        try {
          const emails = p.emails()
          emails.forEach(e => { if (e.value()) map[e.value().toLowerCase()] = name })
        } catch {}
        try {
          const phones = p.phones()
          phones.forEach(ph => {
            const val = ph.value()
            if (val) {
              const digits = val.replace(/[^\\d]/g, '')
              if (digits.length >= 7) map[digits] = name
            }
          })
        } catch {}
      })
      return JSON.stringify(map)
    }
  `

  try {
    const output = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return JSON.parse(output.trim())
  } catch {
    return {}
  }
}

function normalizeNumber(phone: string): string {
  return phone.replace(/[^\d]/g, '')
}

export interface IMessagesContact {
  id: string
  name: string
  phoneNumber: string
  messageCount: number
  fromMeCount: number
  daysActive: number
  avgMessagesPerDay: number
  lastMessageDate: number
}

export interface IMessagesData {
  contacts: IMessagesContact[]
  totalMessages: number
  dbPath: string
  accessible: boolean
}

export function readIMessages(): IMessagesData {
  const dbPath = IMESSAGE_DB

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
  } catch {
    return { contacts: [], totalMessages: 0, dbPath, accessible: false }
  }

  const contactMap = buildContactMap()
  let rows: Array<{
    phoneNumber: string
    messageCount: number
    fromMeCount: number
    daysActive: number
    lastMessageDate: number
  }>
  try {
    // Approximate user's own handles: handles that appear only in is_from_me=1 messages.
    const userHandleRows = db.prepare(`
      SELECT handle_id
      FROM message
      WHERE text IS NOT NULL AND text != ''
      GROUP BY handle_id
      HAVING SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) = 0
    `).all() as Array<{ handle_id: number }>

    const userHandleIds = new Set(userHandleRows.map((r) => r.handle_id))

    rows = db.prepare(`
      WITH chat_participant_count AS (
        SELECT chat_id, COUNT(*) AS cnt
        FROM chat_handle_join
        GROUP BY chat_id
        HAVING cnt = 2
      ),
      chat_other_handle AS (
        SELECT
          chj.chat_id,
          chj.handle_id AS other_handle_id
        FROM chat_handle_join chj
        JOIN chat_participant_count cpc ON chj.chat_id = cpc.chat_id
        WHERE chj.handle_id NOT IN (${[...userHandleIds].join(',') || '0'})
      )
      SELECT
        h.id AS phoneNumber,
        COUNT(m.ROWID) AS messageCount,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS fromMeCount,
        COUNT(DISTINCT date(
          (CASE WHEN ABS(m.date) > 1000000000000 THEN m.date / 1000000000.0 ELSE m.date END)
          + ${APPLE_EPOCH_OFFSET},
          'unixepoch',
          'localtime'
        )) AS daysActive,
        MAX(m.date) AS lastMessageDate
      FROM chat_message_join cmj
      JOIN message m ON cmj.message_id = m.ROWID
      JOIN chat_other_handle coh ON cmj.chat_id = coh.chat_id
      JOIN handle h ON coh.other_handle_id = h.ROWID
      WHERE m.text IS NOT NULL AND m.text != ''
      GROUP BY h.id
      ORDER BY messageCount DESC
      LIMIT 50
    `).all() as typeof rows
  } catch {
    return { contacts: [], totalMessages: 0, dbPath, accessible: false }
  } finally {
    db.close()
  }

  const contacts: IMessagesContact[] = []
  for (const r of rows) {
    if (isShortCode(r.phoneNumber)) continue
    if (isLikelyAutomated(r.phoneNumber)) continue

    const digits = normalizeNumber(r.phoneNumber)
    const lowerEmail = r.phoneNumber.toLowerCase()
    const contactName = contactMap[digits] || contactMap[lowerEmail] || ''
    if (!contactName) continue

    const total = r.messageCount || 1
    const daysActive = r.daysActive || 1
    contacts.push({
      id: r.phoneNumber,
      name: contactName,
      phoneNumber: r.phoneNumber,
      messageCount: r.messageCount,
      fromMeCount: r.fromMeCount,
      daysActive: r.daysActive,
      avgMessagesPerDay: Math.round((total / daysActive) * 10) / 10,
      lastMessageDate: appleDateToUnix(r.lastMessageDate),
    })
  }

  const totalMessages = contacts.reduce((sum, c) => sum + c.messageCount, 0)

  return { contacts, totalMessages, dbPath, accessible: true }
}

export function formatIMessagesForAnalysis(data: IMessagesData): string {
  const lines = data.contacts.map((c) => {
    const fromMePct = Math.round((c.fromMeCount / c.messageCount) * 100)
    let lastDate = 'Unknown'
    if (typeof c.lastMessageDate === 'number' && Number.isFinite(c.lastMessageDate)) {
      try { lastDate = new Date(c.lastMessageDate * 1000).toISOString().split('T')[0] } catch {}
    }
    return [
      `Contact: ${c.name || c.phoneNumber}`,
      `  Messages: ${c.messageCount} total (${fromMePct}% from me)`,
      `  Days active: ${c.daysActive}`,
      `  Avg messages/day: ${c.avgMessagesPerDay}`,
      `  Last message: ${lastDate}`,
    ].join('\n')
  })

  return [
    `Total iMessage conversations analyzed: ${data.contacts.length}`,
    `Total messages: ${data.totalMessages}`,
    '',
    ...lines,
  ].join('\n')
}
