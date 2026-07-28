/**
 * Gmail over IMAP.
 *
 * IMAP with an app password rather than OAuth, deliberately. `gmail.readonly`
 * is a Google *restricted* scope: a distributed unverified app is blocked
 * outright, and in "Testing" publishing mode refresh tokens expire every seven
 * days, so an OAuth Gmail connector in a local app is a connector the user
 * reconnects weekly. An app password needs no cloud project, no consent screen
 * and no verification, and it does not expire.
 *
 * Only ENVELOPE data is fetched — From, To, Subject, Date. Bodies are never
 * requested, which makes the sync cheap and keeps the mailbox text off the
 * disk. `email_events.body_excerpt` stays null for IMAP-sourced rows; the mbox
 * importer is what fills it, for the user who deliberately imported an export.
 */

import { ImapFlow } from 'imapflow'
import * as database from './database'
import { getSecret } from './keychain'
import * as settings from './settings'
import { redactEmailContent } from './activity'
import { emitProgress, type ProgressSender } from './activityExports/common'
import type { ActivityAccount, ActivityAccountSyncResult, ActivityRecord } from '../shared/types'

const LIVE_FILENAME = 'gmail-imap'
const DEFAULT_HOST = 'imap.gmail.com'
const DEFAULT_PORT = 993

/** Ceiling on one sync so a first run over a large mailbox stays bounded. */
const MAX_MESSAGES_PER_SYNC = 20_000

/** Batch size for the envelope fetch. */
const FETCH_CHUNK = 500

interface EnvelopeAddress {
  address?: string
  name?: string
}

function addressOf(entry: EnvelopeAddress | undefined): string | null {
  const value = entry?.address?.trim()
  return value ? value : null
}

/**
 * Gmail rejects a normal password with a message about the app not being
 * secure; an app password that has been revoked reads as a plain auth failure.
 * Both mean "the user has to go get a new credential", so both surface as
 * needs_reauth rather than a generic error.
 */
function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /auth|credential|password|login|invalid/i.test(message)
}

export async function syncGmailImap(
  account: ActivityAccount,
  signal?: AbortSignal,
  sendProgress?: ProgressSender
): Promise<ActivityAccountSyncResult> {
  const password = await getSecret('gmail', 'app-password')
  if (!password) {
    return { provider: 'gmail', status: 'needs_reauth', eventsCount: 0, message: 'No app password stored' }
  }

  const user = account.config.imapUser?.trim()
  if (!user) {
    return {
      provider: 'gmail',
      status: 'needs_reauth',
      eventsCount: 0,
      message: 'Set the Gmail address for this account first',
    }
  }

  let record: ActivityRecord
  const existing = database.findLiveActivityRecord(account.projectId, 'email', LIVE_FILENAME)
  if (existing) {
    record = existing
  } else {
    record = database.createActivityRecord({
      projectId: account.projectId,
      sourceType: 'email',
      filename: LIVE_FILENAME,
      fileSize: null,
      contentHash: null,
    })
  }

  const client = new ImapFlow({
    host: account.config.imapHost?.trim() || DEFAULT_HOST,
    port: account.config.imapPort ?? DEFAULT_PORT,
    secure: true,
    auth: { user, pass: password },
    // ImapFlow logs every command at info level by default, which would put
    // mailbox structure into the console.
    logger: false,
  })

  const allowlist = settings.getSettings().activityEmailAllowedAddress || ''
  let written = 0

  try {
    emitProgress(sendProgress, 'gmail', 'reading', 'Connecting to Gmail', null, null, record.id)
    await client.connect()

    const lock = await client.getMailboxLock('INBOX')
    try {
      const mailbox = client.mailbox
      const total = typeof mailbox === 'object' && mailbox ? mailbox.exists : 0
      if (!total) {
        database.completeActivityRecord(record.id, existing?.eventsCount ?? 0)
        return { provider: 'gmail', status: 'synced', eventsCount: 0 }
      }

      // Only messages newer than the newest one already stored. `since` is a
      // date, not a UID, because a UID is per-mailbox and the user may have
      // moved messages around between syncs.
      const latest = database.listEmailEvents(record.id, { limit: 1 })[0]
      const since = latest ? new Date(latest.occurredAt) : null

      const range = `${Math.max(1, total - MAX_MESSAGES_PER_SYNC + 1)}:${total}`
      emitProgress(sendProgress, 'gmail', 'parsing', 'Fetching message envelopes', 0, total, record.id)

      const pending: Array<{
        kind: 'received' | 'sent'
        occurredAt: string
        fromAddress: string | null
        toAddresses: string[]
        subject: string | null
      }> = []

      for await (const message of client.fetch(range, { envelope: true })) {
        if (signal?.aborted) break

        const envelope = message.envelope
        if (!envelope?.date) continue
        const occurredAt = new Date(envelope.date)
        if (Number.isNaN(occurredAt.getTime())) continue
        if (since && occurredAt <= since) continue

        const from = addressOf(envelope.from?.[0])
        const to = (envelope.to ?? []).map(addressOf).filter((a): a is string => Boolean(a))

        pending.push({
          // A message the user sent is the one whose From is their own address.
          kind: from && from.toLowerCase() === user.toLowerCase() ? 'sent' : 'received',
          occurredAt: occurredAt.toISOString(),
          fromAddress: from,
          toAddresses: to,
          subject: envelope.subject ?? null,
        })

        if (pending.length >= MAX_MESSAGES_PER_SYNC) break
      }

      for (let offset = 0; offset < pending.length; offset += FETCH_CHUNK) {
        if (signal?.aborted) break
        const batch = pending.slice(offset, offset + FETCH_CHUNK)
        database.runInTransaction(() => {
          for (const item of batch) {
            // Same redaction the mbox importer applies, with the user's own
            // address allowlisted so their mail is still attributable to them.
            database.createEmailEvent({
              recordId: record.id,
              kind: item.kind,
              occurredAt: item.occurredAt,
              fromAddress: item.fromAddress ? redactEmailContent(item.fromAddress, allowlist) : null,
              toAddresses: item.toAddresses.map((a) => redactEmailContent(a, allowlist)),
              subject: item.subject ? redactEmailContent(item.subject, allowlist) : null,
              // Nothing to excerpt: bodies are never fetched over IMAP.
              bodyExcerpt: null,
              sourceMeta: { provider: 'gmail', transport: 'imap' },
            })
            written += 1
          }
        })
        emitProgress(
          sendProgress,
          'gmail',
          'storing',
          `Stored ${written} of ${pending.length}`,
          written,
          pending.length,
          record.id
        )
      }
    } finally {
      lock.release()
    }

    database.completeActivityRecord(record.id, (existing?.eventsCount ?? 0) + written)
    database.touchActivityRecordImportedAt(record.id)
    emitProgress(sendProgress, 'gmail', 'complete', `Synced ${written} messages`, written, written, record.id)
    return { provider: 'gmail', status: 'synced', eventsCount: written }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gmail sync failed'
    database.failActivityRecord(record.id, message)
    if (isAuthFailure(err)) {
      emitProgress(sendProgress, 'gmail', 'reauth', 'Gmail rejected the app password', null, null, record.id)
      return { provider: 'gmail', status: 'needs_reauth', eventsCount: 0, message }
    }
    return { provider: 'gmail', status: 'error', eventsCount: 0, message }
  } finally {
    try {
      await client.logout()
    } catch {
      // A connection that never opened has nothing to log out of.
    }
  }
}
