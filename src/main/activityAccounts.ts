/**
 * Orchestration for the Activity account registry.
 *
 * Everything account-shaped funnels through here: seeding the rows, dispatching
 * a sync to the right connector, dispatching an export file to the right parser,
 * and the background walk over watched folders. The connectors and parsers
 * themselves know nothing about accounts — they take a project id and a path.
 */

import fs from 'fs'
import path from 'path'
import * as database from './database'
import { listProjects } from './database'
import {
  ACTIVITY_PROVIDERS,
  activityProviderOrNull,
  type ActivityProviderDef,
} from '../shared/activityProviders'
import type {
  ActivityAccount,
  ActivityAccountSyncResult,
  ActivityIngestProgress,
  ActivityProviderId,
  ActivityRecord,
} from '../shared/types'
import { collectProjectDataFiles } from './projectContext'
import { getSecret } from './keychain'
import { hasCookieConnector } from './activityCookieSync'
import { syncAmazonOrdersGraphQL } from './activityAmazon'
import { syncIMessageActivity } from './activityIMessage'
import { syncGmailImap } from './activityGmail'
import {
  ingestAccountExport,
  ingestAccountExportWithFanOut,
  detectExportForProvider,
} from './activityExports'

export type AccountProgressSender = (progress: ActivityIngestProgress) => void

/** The Activity project is matched by name, the same way the rest of main.ts does. */
export function findActivityProjectId(): string | null {
  return listProjects().find((p) => p.name === 'Activity')?.id ?? null
}

/**
 * Gives every registry provider a row on the Activity project. Idempotent, so
 * this runs on every startup and picks up providers added since last launch.
 */
export function seedActivityAccounts(): void {
  try {
    const projectId = findActivityProjectId()
    if (!projectId) return
    for (const provider of ACTIVITY_PROVIDERS) {
      database.ensureActivityAccount(projectId, provider.id)
    }
  } catch (err) {
    console.error('Activity accounts: seeding failed', err)
  }
}

export function listAccounts(projectId: string): ActivityAccount[] {
  // Seed lazily too — a project that gained the Activity name after startup
  // would otherwise show an empty list until the next launch.
  for (const provider of ACTIVITY_PROVIDERS) {
    database.ensureActivityAccount(projectId, provider.id)
  }
  const accounts = database.listActivityAccounts(projectId)
  const order = new Map(ACTIVITY_PROVIDERS.map((p, i) => [p.id, i]))
  return accounts
    .filter((a) => order.has(a.provider))
    .sort((a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0))
}

function requireAccount(accountId: string): { account: ActivityAccount; def: ActivityProviderDef } {
  const account = database.getActivityAccount(accountId)
  if (!account) throw new Error('Activity account not found')
  const def = activityProviderOrNull(account.provider)
  if (!def) throw new Error(`Unknown activity provider: ${account.provider}`)
  return { account, def }
}

/**
 * Runs an account's live connector. Returns a result rather than throwing for
 * the expected failure modes (no credential, permission denied, expired
 * session) — those are states the Data page renders, not errors.
 */
export async function syncAccount(
  accountId: string,
  signal?: AbortSignal,
  sendProgress?: AccountProgressSender
): Promise<ActivityAccountSyncResult> {
  const { account, def } = requireAccount(accountId)

  const skip = (message: string): ActivityAccountSyncResult => ({
    provider: def.id,
    status: 'skipped',
    eventsCount: 0,
    message,
  })

  if (!account.enabled) return skip('Account is disabled')
  if (def.live === 'none') return skip(`${def.label} has no live path — import an export instead`)

  // A connector that can cost the user their account never runs on the strength
  // of the enable toggle alone.
  if (def.liveViability === 'ban-risk' && account.config.riskAccepted !== true) {
    return skip(`${def.label} live sync needs the risk acknowledgement first`)
  }

  // Checked before the credential, so an account whose live connector is not
  // built yet reports that rather than nagging every quarter hour for a
  // credential it would have no use for.
  if (def.live === 'cookie' && !hasCookieConnector(def.id)) {
    return skip(`No live connector is implemented for ${def.label} yet — import an export instead`)
  }

  if (def.credential !== 'none') {
    const secret = await getSecret(def.id, def.credential)
    if (!secret) {
      database.recordActivityAccountSync(accountId, 'needs_reauth', 'No credential stored')
      return { provider: def.id, status: 'needs_reauth', eventsCount: 0, message: 'No credential stored' }
    }
  }

  const relay: AccountProgressSender | undefined = sendProgress
    ? (progress) => sendProgress({ ...progress, provider: def.id })
    : undefined

  try {
    const result = await runLiveConnector(def, account, signal, relay)
    database.recordActivityAccountSync(
      accountId,
      result.status === 'synced' ? 'synced' : (result.status as ActivityAccount['lastSyncStatus']),
      result.status === 'error' || result.status === 'needs_reauth' ? result.message ?? null : null
    )
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    database.recordActivityAccountSync(accountId, 'error', message)
    return { provider: def.id, status: 'error', eventsCount: 0, message }
  }
}

async function runLiveConnector(
  def: ActivityProviderDef,
  account: ActivityAccount,
  signal?: AbortSignal,
  sendProgress?: AccountProgressSender
): Promise<ActivityAccountSyncResult> {
  switch (def.id) {
    case 'imessage':
      return await syncIMessageActivity(account.projectId, signal, sendProgress)

    case 'gmail':
      return await syncGmailImap(account, signal, sendProgress)

    case 'amazon': {
      // The pre-registry Amazon sync already does the right thing; the account
      // row just wraps it so it appears alongside everything else.
      const record = await syncAmazonOrdersGraphQL(account.projectId, signal, sendProgress)
      if (!record) return { provider: 'amazon', status: 'skipped', eventsCount: 0 }
      if (record.status === 'failed') {
        const reauth = (record.parseError ?? '').toLowerCase().includes('reauth')
        return {
          provider: 'amazon',
          status: reauth ? 'needs_reauth' : 'error',
          eventsCount: 0,
          message: record.parseError ?? undefined,
        }
      }
      return { provider: 'amazon', status: 'synced', eventsCount: record.eventsCount }
    }

    default:
      // Cookie-capable in the registry, but no endpoint set is implemented for
      // it yet. Saying so beats running a sync that quietly finds nothing and
      // leaves the user thinking the account is empty.
      return {
        provider: def.id,
        status: 'skipped',
        eventsCount: 0,
        message: hasCookieConnector(def.id)
          ? `${def.label} sync is not wired up`
          : `No live connector is implemented for ${def.label} yet — import an export instead`,
      }
  }
}

/**
 * Ingests one export archive or file for an account. The account only picks the
 * parser; the parser writes through the same record/dedupe machinery every
 * other Activity ingest uses.
 */
export async function importAccountExport(
  accountId: string,
  filePath: string,
  signal?: AbortSignal,
  sendProgress?: AccountProgressSender
): Promise<ActivityRecord> {
  const { account, def } = requireAccount(accountId)
  const relay: AccountProgressSender | undefined = sendProgress
    ? (progress) => sendProgress({ ...progress, provider: def.id })
    : undefined

  // A Google Takeout holds Search, YouTube and Gmail at once, so one import
  // feeds every account the archive actually contains rather than making the
  // user point three accounts at the same folder.
  const { primary, siblings } = await ingestAccountExportWithFanOut(
    def,
    account.projectId,
    filePath,
    signal,
    relay
  )

  database.touchActivityAccountExport(accountId)
  for (const sibling of siblings) {
    if (!sibling.record) {
      console.error(`Activity accounts: fan-out to ${sibling.provider} failed`, sibling.error)
      continue
    }
    const siblingAccount = database.findActivityAccount(account.projectId, sibling.provider)
    if (siblingAccount) database.touchActivityAccountExport(siblingAccount.id)
  }

  return primary
}

/** Every enabled account with a live path, run one after another. */
export async function syncEnabledAccounts(
  projectId: string,
  perAccountTimeoutMs = 90_000
): Promise<ActivityAccountSyncResult[]> {
  const results: ActivityAccountSyncResult[] = []
  for (const account of listAccounts(projectId)) {
    const def = activityProviderOrNull(account.provider)
    if (!def || !account.enabled || def.live === 'none') continue

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), perAccountTimeoutMs)
    try {
      results.push(await syncAccount(account.id, controller.signal))
    } catch (err) {
      console.error(`Activity accounts: ${account.provider} sync failed`, err)
    } finally {
      clearTimeout(timeout)
    }
  }
  return results
}

/**
 * Walks each enabled account's watched folder and ingests anything it has not
 * seen. Re-ingest is idempotent — `findActivityRecord` matches on content hash —
 * so re-walking a folder every quarter hour costs a hash per file, not a parse.
 *
 * This is what makes an export-only account semi-live: point it at the folder
 * Google Takeout (or Dropbox, or iCloud Drive) drops scheduled exports into and
 * new archives get picked up without anyone clicking anything.
 */
export async function scanAccountWatchFolders(projectId: string): Promise<number> {
  let ingested = 0

  // Re-ingesting an unchanged archive returns the record that already exists,
  // so counting every parsed result would report "18 imported" on a scan that
  // found nothing new. Only records that did not exist before this run count.
  const known = new Set(database.listActivityRecords(projectId).map((record) => record.id))
  const isNew = (recordId: string): boolean => !known.has(recordId)

  for (const account of listAccounts(projectId)) {
    const def = activityProviderOrNull(account.provider)
    if (!def || !account.enabled || account.sources.length === 0) continue

    // Every connected folder, deduped: two accounts may point at the same
    // Takeout, and a folder may be listed under one account twice by path.
    //
    // A watched directory is offered as an export root in its own right, along
    // with its immediate subdirectories, before its loose files are considered.
    // An unzipped Takeout is a *tree*, not a file — matching only files means a
    // 3.7 GB mbox buried three levels down is never seen, and the folder-level
    // fan-out that feeds Search, YouTube and Gmail together never runs.
    const candidates: string[] = []
    const seen = new Set<string>()
    const offer = (candidate: string): void => {
      if (seen.has(candidate)) return
      seen.add(candidate)
      candidates.push(candidate)
    }

    for (const source of account.sources) {
      try {
        if (!fs.existsSync(source.path)) continue

        offer(source.path)
        // Immediate children, files included regardless of extension:
        // TikTok delivers its archive as a bare UUID with no suffix at all,
        // which the data-file collector below filters out.
        for (const entry of fs.readdirSync(source.path, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue
          if (entry.isDirectory() || entry.isFile()) offer(path.join(source.path, entry.name))
        }

        for (const file of collectProjectDataFiles(source.path)) offer(file)
      } catch (err) {
        console.error(`Activity accounts: could not read ${source.path} for ${account.provider}`, err)
      }
    }

    // Candidates are offered outermost-first, and anything inside a directory
    // that already ingested successfully is skipped. Without this the same
    // archive is imported once per nesting level — the Takeout root, the
    // Takeout subfolder and each MyActivity.html inside it are all valid
    // candidates, and each gets a different identity hash, so the usual
    // content dedupe does not catch it. Measured: exactly 3x every event.
    const covered: string[] = []
    const isCovered = (candidate: string): boolean =>
      covered.some((root) => candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep))

    for (const file of candidates) {
      if (isCovered(file)) continue
      if (!detectExportForProvider(def, file)) continue
      try {
        // Same fan-out as a manual import: one Takeout in a watched folder
        // feeds Search, YouTube and Gmail together.
        const { primary, siblings } = await ingestAccountExportWithFanOut(def, projectId, file)
        if (primary.status === 'parsed' && primary.eventsCount > 0) {
          if (isNew(primary.id)) ingested += 1
          database.touchActivityAccountExport(account.id)
          // Everything beneath this path is part of the archive just imported,
          // whether it was freshly parsed or already on file.
          covered.push(file)
        }
        for (const sibling of siblings) {
          if (!sibling.record || sibling.record.eventsCount === 0) continue
          if (isNew(sibling.record.id)) ingested += 1
          const siblingAccount = database.findActivityAccount(projectId, sibling.provider)
          if (siblingAccount) database.touchActivityAccountExport(siblingAccount.id)
        }
      } catch (err) {
        console.error(`Activity accounts: watch-folder ingest failed for ${path.basename(file)}`, err)
      }
    }
  }

  return ingested
}

export function accountProviderIds(): ActivityProviderId[] {
  return ACTIVITY_PROVIDERS.map((p) => p.id)
}
