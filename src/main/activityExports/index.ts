/**
 * Dispatches an export file to the right parser for an account.
 *
 * Accounts whose data fits a table that predates the registry (Gmail → mbox,
 * YouTube → watch history, Amazon → orders) delegate straight to the existing
 * ingest functions rather than reimplementing them. Everything else is parsed
 * here and written to `account_events`.
 */

import fs from 'fs'
import path from 'path'
import { activityProviderOrNull, type ActivityProviderDef } from '../../shared/activityProviders'
import type { ActivityRecord } from '../../shared/types'
import { detectActivitySource, ingestActivityFile } from '../activity'
import { ingestAmazonFile } from '../activityAmazon'
import { findEntries, isZipFile, openExportSource, type ExportSource, type ExportSource as ExportSourceType } from './archive'
import { ingestYouTubeHistoryHtml, looksLikeYouTubeHistory } from './youtube'
import { ingestExport, type ParsedAccountEvent, type ProgressSender } from './common'
import { looksLikeGoogleActivity, parseGoogleSearchExport } from './google'
import { looksLikeMetaExport, parseMetaExport } from './meta'
import { looksLikeTikTokExport, parseTikTokExport } from './tiktok'
import { looksLikeSnapchatExport, parseSnapchatExport } from './snapchat'
import { looksLikeDiscordExport, parseDiscordExport } from './discord'
import { looksLikeLinkedInExport, parseLinkedInExport } from './linkedin'
import { looksLikeTinderExport, parseBumbleExport, parseTinderExport } from './dating'

type Parser = (source: ExportSource) => ParsedAccountEvent[]

/** Providers parsed here, as opposed to delegated to a pre-registry ingest. */
const PARSERS: Partial<Record<ActivityProviderDef['id'], Parser>> = {
  'google-search': parseGoogleSearchExport,
  instagram: (source) => parseMetaExport(source, 'instagram'),
  facebook: (source) => parseMetaExport(source, 'facebook'),
  tiktok: parseTikTokExport,
  snapchat: parseSnapchatExport,
  discord: parseDiscordExport,
  linkedin: parseLinkedInExport,
  tinder: parseTinderExport,
  bumble: parseBumbleExport,
}

/** Cheap shape checks used by the watched-folder walk. */
const DETECTORS: Partial<Record<ActivityProviderDef['id'], (source: ExportSource) => boolean>> = {
  'google-search': looksLikeGoogleActivity,
  instagram: looksLikeMetaExport,
  facebook: looksLikeMetaExport,
  tiktok: looksLikeTikTokExport,
  snapchat: looksLikeSnapchatExport,
  discord: looksLikeDiscordExport,
  linkedin: looksLikeLinkedInExport,
  tinder: looksLikeTinderExport,
}

/**
 * Whether a path in a watched folder is plausibly this provider's export.
 * Deliberately conservative: a false positive means parsing someone's unrelated
 * zip, so anything it cannot open or recognize is skipped.
 */
export function detectExportForProvider(def: ActivityProviderDef, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()

  switch (def.id) {
    case 'gmail':
      return ext === '.mbox'
    case 'youtube': {
      const base = path.basename(filePath).toLowerCase()
      if (base === 'watch-history.json' || base === 'watch-history.html') return true
      // A Takeout folder holding YouTube history counts as this account's export.
      try {
        if (!fs.statSync(filePath).isDirectory()) return false
      } catch {
        return false
      }
      try {
        return looksLikeYouTubeHistory(openExportSource(filePath))
      } catch {
        return false
      }
    }
    case 'amazon':
      // An Amazon data request contains hundreds of unrelated CSVs — watchlists,
      // addresses, viewing history. Matching every .csv fed all of them to the
      // orders parser, which mostly failed and occasionally "parsed" an address
      // book as an order. The header is what actually identifies an order file.
      if (ext === '.json') return true
      if (ext !== '.csv') return false
      return detectActivitySource(filePath) === 'amazon'
    case 'bumble':
      // Bumble's walker accepts almost anything, so it never auto-detects —
      // matching every stray .json in a watched folder would be worse than
      // requiring a manual import.
      return false
    default:
      break
  }

  // `.html` matters: Takeout emits HTML by default, so a watched folder full of
  // MyActivity.html would otherwise be skipped entirely.
  if (ext !== '.zip' && ext !== '.json' && ext !== '.csv' && ext !== '.html') {
    // A folder may be an unzipped export, and an extension-less file may still
    // be an archive — TikTok delivers its export as a bare UUID with no suffix
    // at all. Checking the magic bytes here is what lets the detector below
    // ever see it; `openExportSource` already sniffs, but this gate ran first
    // and rejected the file outright.
    let admissible = false
    try {
      admissible = fs.statSync(filePath).isDirectory() || isZipFile(filePath)
    } catch {
      admissible = false
    }
    if (!admissible) return false
  }

  const detector = DETECTORS[def.id]
  if (!detector) return false

  try {
    return detector(openExportSource(filePath))
  } catch {
    return false
  }
}

export async function ingestAccountExport(
  def: ActivityProviderDef,
  projectId: string,
  filePath: string,
  signal?: AbortSignal,
  send?: ProgressSender
): Promise<ActivityRecord> {
  // The three accounts that reuse a pre-registry table also reuse its parser.
  switch (def.id) {
    case 'gmail':
      return await ingestActivityFile(filePath, projectId, 'email', signal, send)
    case 'youtube': {
      // Takeout emits HTML unless the format was changed, so the JSON importer
      // only applies when the user actually has a .json file.
      if (path.basename(filePath).toLowerCase() === 'watch-history.json') {
        return await ingestActivityFile(filePath, projectId, 'youtube', signal, send)
      }
      const source = openExportSource(filePath)
      return await ingestYouTubeHistoryHtml(filePath, projectId, source, signal, send)
    }
    case 'amazon':
      return await ingestAmazonFile(filePath, projectId, signal, send)
    default:
      break
  }

  const parser = PARSERS[def.id]
  if (!parser) {
    throw new Error(`${def.label} exports are not supported yet`)
  }

  return await ingestExport(
    def.id,
    projectId,
    filePath,
    () => parser(openExportSource(filePath)),
    signal,
    send
  )
}

/**
 * Which other accounts a single export also feeds.
 *
 * Google Takeout is one archive containing Search history, YouTube history and
 * the Gmail mbox at once. Left to per-account imports, the user has to point
 * three different accounts at the same folder and remember which of its
 * subtrees belongs to which — and the watched-folder scan, which only ever
 * matches one provider per account, would silently pick up a third of it.
 *
 * So an export is offered to every provider that recognizes something in it.
 */
const FAN_OUT: Partial<Record<ActivityProviderDef['id'], ActivityProviderDef['id'][]>> = {
  'google-search': ['youtube', 'gmail'],
  youtube: ['google-search', 'gmail'],
  gmail: ['google-search', 'youtube'],
}

export interface FanOutResult {
  provider: ActivityProviderDef['id']
  record: ActivityRecord | null
  error?: string
}

/**
 * Ingests an export for its own account, then for every sibling account that
 * also recognizes the archive. Siblings that find nothing are skipped silently;
 * a sibling that throws does not fail the primary import.
 */
export async function ingestAccountExportWithFanOut(
  def: ActivityProviderDef,
  projectId: string,
  filePath: string,
  signal?: AbortSignal,
  send?: ProgressSender
): Promise<{ primary: ActivityRecord; siblings: FanOutResult[] }> {
  const primary = await ingestAccountExport(def, projectId, filePath, signal, send)

  const siblings: FanOutResult[] = []
  for (const siblingId of FAN_OUT[def.id] ?? []) {
    if (signal?.aborted) break
    const sibling = activityProviderOrNull(siblingId)
    if (!sibling) continue

    // Only if this archive actually contains that account's data.
    let applicable = false
    try {
      applicable = detectExportForProvider(sibling, filePath) || containsSiblingExport(sibling, filePath)
    } catch {
      applicable = false
    }
    if (!applicable) continue

    // Gmail's importer takes the mbox itself, not the folder holding it.
    const target = siblingExportPath(sibling, filePath)
    if (!target) continue

    try {
      const record = await ingestAccountExport(sibling, projectId, target, signal, send)
      siblings.push({ provider: siblingId, record })
    } catch (err) {
      siblings.push({
        provider: siblingId,
        record: null,
        error: err instanceof Error ? err.message : 'Import failed',
      })
    }
  }

  return { primary, siblings }
}

/**
 * A Takeout *folder* holds each service in its own subtree, so the sibling's
 * data is present even though the folder itself is not that sibling's export
 * file. Gmail is the case that matters: its mbox sits several levels down.
 */
function containsSiblingExport(sibling: ActivityProviderDef, filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isDirectory()) return false
  } catch {
    return false
  }

  let source: ExportSourceType
  try {
    source = openExportSource(filePath)
  } catch {
    return false
  }

  switch (sibling.id) {
    case 'gmail':
      return findEntries(source, '.mbox').length > 0
    case 'youtube':
      return looksLikeYouTubeHistory(source)
    case 'google-search':
      return looksLikeGoogleActivity(source)
    default:
      return false
  }
}

/**
 * The path a sibling should actually be handed. Gmail's importer takes the
 * mbox file, not the folder it sits in.
 */
export function siblingExportPath(sibling: ActivityProviderDef, filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isDirectory()) return filePath
  } catch {
    return null
  }
  if (sibling.id !== 'gmail') return filePath

  try {
    const source = openExportSource(filePath)
    const mbox = findEntries(source, '.mbox')[0]
    return mbox ? source.entryPath(mbox) : null
  } catch {
    return null
  }
}

export { openExportSource } from './archive'
export type { ExportSource } from './archive'
