import { arch, platform, release, userInfo } from 'node:os'
import path from 'node:path'
import type {
  AppSettings,
  MemoryExtractionRequest,
  MemoryField,
  MemorySourceType,
  RecallSearchResult,
} from '../shared/types'
import { getAssistantName } from '../shared/assistantIdentity'
import * as database from './database'
import { collectProjectTextFiles, readTextFileBounded } from './projectContext'
import { readIMessages } from './imessage'
import { redactMemoryContent, type MemoryEvidenceSource } from './memory'
import {
  buildMemoryRecallQueries,
  rankMemoryRecallDocuments,
  type MemoryRecallDocument,
  type MemoryRecallMatch,
  type MemoryRecallQuery,
} from './memoryQueries'
import { extractRecallFileText, searchRecallFilesForQuery } from './recall'
import { getResolvedRoots, isPathEverywhere } from './fileScope'

const MAX_CONTEXT_CHARS = 90_000
const MAX_SOURCE_CHARS = 12_000
const MAX_PROJECT_FILES_TO_SCAN = 200
const MAX_PROJECT_SCAN_CHARS = 8_000_000
const MAX_PROJECT_FILE_SCAN_CHARS = 60_000
const MAX_PROJECT_MATCH_CHARS = 1_600
const MAX_CONVERSATION_MATCH_CHARS = 1_200
const MAX_RECALL_FILES_TO_EXTRACT = 18
const MAX_RECALL_FILE_MATCH_CHARS = 1_600
const SOURCE_TYPE_BUDGETS: Record<MemorySourceType, number> = {
  'os-account': 4_000,
  settings: 4_000,
  'imessage-metadata': 12_000,
  'psychology-analysis': 8_000,
  'project-file': 28_000,
  'recall-file': 32_000,
  conversation: 26_000,
  'claude-import': 32_000,
  'activity-events': 12_000,
  'super-context': 24_000,
  manual: 0,
}

export interface CollectedMemoryEvidence {
  sources: MemoryEvidenceSource[]
  sourceCounts: Partial<Record<MemorySourceType, number>>
  truncated: boolean
}

type MemoryEvidenceCandidate = Omit<MemoryEvidenceSource, 'id'>

function throwIfCollectionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Memory auto-fill cancelled')
}

function yieldForCancellation(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

function buildFilesystemRecallQueries(queries: MemoryRecallQuery[]): string[] {
  const termsByCategory = new Map<string, Set<string>>()
  for (const query of queries) {
    const terms = termsByCategory.get(query.category) || new Set<string>()
    for (const term of query.filesystemTerms) {
      const safeTerm = term
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s'_\-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!safeTerm || safeTerm.length > 100) continue
      terms.add(safeTerm)
      if (terms.size >= 24) break
    }
    termsByCategory.set(query.category, terms)
  }
  return [...termsByCategory.values()].flatMap((terms) => {
    const values = [...terms]
    if (values.length === 0) return []
    return [values.map((term) => `"${term.replace(/["\\]/g, ' ')}"`).join(' OR ')]
  })
}

const ACTIVITY_EVIDENCE_PER_SOURCE = 40

function collectProjectActivityEvidence(projectId: string): string | null {
  const browser = database.listAllBrowserEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const youtube = database.listAllYoutubeEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const amazon = database.listAllAmazonEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const email = database.listAllEmailEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const knowledge = database.listAllKnowledgeEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const photos = database.listAllPhotoEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const location = database.listAllLocationEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const weather = database.listAllWeatherEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  const subscription = database.listAllSubscriptionEvents(projectId, { limit: ACTIVITY_EVIDENCE_PER_SOURCE })
  if (
    browser.length === 0 && youtube.length === 0 && amazon.length === 0 && email.length === 0 &&
    knowledge.length === 0 && photos.length === 0 && location.length === 0 && weather.length === 0 &&
    subscription.length === 0
  ) {
    return null
  }
  return JSON.stringify({
    browser: browser.map((event) => ({ kind: event.kind, occurredAt: event.occurredAt, title: event.title, url: event.url })),
    youtube: youtube.map((event) => ({ occurredAt: event.occurredAt, title: event.title, channel: event.channel, url: event.url, durationSeconds: event.durationSeconds })),
    amazon: amazon.map((event) => ({ occurredAt: event.occurredAt, orderId: event.orderId, title: event.title, totalCents: event.totalCents, items: event.items })),
    email: email.map((event) => ({ kind: event.kind, occurredAt: event.occurredAt, fromAddress: event.fromAddress, toAddresses: event.toAddresses, subject: event.subject, bodyExcerpt: event.bodyExcerpt })),
    knowledge: knowledge.map((event) => ({ occurredAt: event.occurredAt, bundleId: event.bundleId, appName: event.appName, eventType: event.eventType, durationSeconds: event.durationSeconds })),
    photos: photos.map((event) => ({ occurredAt: event.occurredAt, assetKind: event.assetKind, locationName: event.locationName, faces: event.faces })),
    location: location.map((event) => ({ occurredAt: event.occurredAt, lat: event.lat, lng: event.lng, source: event.source })),
    weather: weather.map((event) => ({ occurredAt: event.occurredAt, tempC: event.tempC, humidityPct: event.humidityPct, precipMm: event.precipMm, windKph: event.windKph, conditions: event.conditions })),
    subscription: subscription.map((event) => ({ occurredAt: event.occurredAt, provider: event.provider, planName: event.planName, amountCents: event.amountCents, currency: event.currency, cadence: event.cadence })),
  })
}

function appendInterleavedMatches(
  candidates: MemoryEvidenceCandidate[],
  matchesByQuery: MemoryRecallMatch[][],
  type: Extract<MemorySourceType, 'conversation' | 'project-file' | 'recall-file'>,
  maxRanks: number,
  maxMergedChars: number
): void {
  const added = new Map<string, MemoryEvidenceCandidate>()
  for (let rank = 0; rank < maxRanks; rank += 1) {
    for (const matches of matchesByQuery) {
      const match = matches[rank]
      if (!match) continue
      const existing = added.get(match.reference)
      if (existing) {
        if (!existing.content.includes(match.content)) {
          existing.content = `${existing.content}\n\n${match.content}`.slice(0, maxMergedChars)
        }
        continue
      }
      const candidate: MemoryEvidenceCandidate = {
        type,
        reference: match.reference,
        label: match.label,
        capturedAt: match.capturedAt,
        content: match.content,
      }
      added.set(match.reference, candidate)
      candidates.push(candidate)
    }
  }
}

export async function collectMemoryEvidence(
  request: MemoryExtractionRequest,
  appSettings: AppSettings,
  fields: MemoryField[],
  signal?: AbortSignal
): Promise<CollectedMemoryEvidence> {
  const candidates: MemoryEvidenceCandidate[] = []
  const now = Date.now()
  const recallQueries = buildMemoryRecallQueries(fields)
  let retrievalTruncated = false

  if (request.includeSettings) {
    const account = userInfo()
    candidates.push({
      type: 'os-account',
      reference: 'local-os-account',
      label: 'Local Mac account',
      capturedAt: now,
      content: JSON.stringify({
        username: account.username,
        homeDirectoryName: account.homedir.split('/').filter(Boolean).pop() || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: platform(),
        operatingSystemRelease: release(),
        architecture: arch(),
      }),
    })
    candidates.push({
      type: 'settings',
      reference: 'holmes-settings-safe',
      label: `${getAssistantName()} preferences`,
      capturedAt: now,
      content: JSON.stringify({
        theme: appSettings.theme,
        providerType: appSettings.provider.type,
        defaultModel: appSettings.defaultModel,
        defaultTier: appSettings.defaultTier,
        tierModels: appSettings.modelTiers[appSettings.defaultTier],
      }),
    })
  }

  if (request.includeProjects) {
    // A separate-context project is not part of the life picture, so its files
    // and analyses are not evidence memory may draw on.
    const projects = database.listProjects().filter((project) => project.contextScope !== 'separate')
    const projectDocuments: MemoryRecallDocument[] = []
    let scannedProjectChars = 0
    let scannedProjectFiles = 0
    for (const project of projects) {
      await yieldForCancellation()
      throwIfCollectionAborted(signal)
      if (project.analysis) {
        candidates.push({
          type: 'psychology-analysis',
          reference: project.id,
          label: `${project.name} profile analysis`,
          capturedAt: project.updatedAt,
          content: JSON.stringify(project.analysis),
        })
      }

      if (project.activityAnalysis) {
        candidates.push({
          type: 'activity-events',
          reference: `${project.id}:activity-analysis`,
          label: `${project.name} activity analysis`,
          capturedAt: project.updatedAt,
          content: JSON.stringify(project.activityAnalysis),
        })
      } else {
        const activitySample = collectProjectActivityEvidence(project.id)
        if (activitySample) {
          candidates.push({
            type: 'activity-events',
            reference: `${project.id}:activity-events`,
            label: `${project.name} activity events`,
            capturedAt: now,
            content: activitySample,
          })
        }
      }

      if (scannedProjectFiles >= MAX_PROJECT_FILES_TO_SCAN || scannedProjectChars >= MAX_PROJECT_SCAN_CHARS) {
        retrievalTruncated = true
        break
      }
      const files = collectProjectTextFiles(project.files, project.path)
      await yieldForCancellation()
      throwIfCollectionAborted(signal)
      if (files.length > Math.max(0, MAX_PROJECT_FILES_TO_SCAN - scannedProjectFiles)) retrievalTruncated = true
      for (const filePath of files) {
        throwIfCollectionAborted(signal)
        if (scannedProjectFiles >= MAX_PROJECT_FILES_TO_SCAN || scannedProjectChars >= MAX_PROJECT_SCAN_CHARS) {
          retrievalTruncated = true
          break
        }
        const remainingChars = MAX_PROJECT_SCAN_CHARS - scannedProjectChars
        try {
          const file = readTextFileBounded(
            filePath,
            Math.min(MAX_PROJECT_FILE_SCAN_CHARS, remainingChars)
          )
          scannedProjectFiles += 1
          scannedProjectChars += file.text.length
          if (file.truncated) retrievalTruncated = true
          if (!file.text.trim()) continue
          const projectBase = project.path ? path.resolve(project.path) : null
          const relativePath = projectBase && (filePath === projectBase || filePath.startsWith(`${projectBase}${path.sep}`))
            ? path.relative(projectBase, filePath)
            : path.basename(filePath)
          projectDocuments.push({
            reference: `${project.id}:${filePath}`,
            label: `${project.name} / ${relativePath.replace(/[\r\n]/g, ' ')}`,
            capturedAt: file.modifiedAt,
            content: file.text,
          })
        } catch {
          // Skip unreadable project files.
        }
        await yieldForCancellation()
        throwIfCollectionAborted(signal)
      }
    }

    const projectMatches = recallQueries.map((query) => rankMemoryRecallDocuments(
      projectDocuments,
      query,
      4,
      MAX_PROJECT_MATCH_CHARS
    ))
    if (projectMatches.some((matches) => matches.length > 3)) retrievalTruncated = true
    appendInterleavedMatches(candidates, projectMatches, 'project-file', 3, 8_000)
  }

  if (request.includeConversations) {
    const conversationMatches: MemoryRecallMatch[][] = []
    for (const query of recallQueries) {
      await yieldForCancellation()
      throwIfCollectionAborted(signal)
      const documents = database.searchMemoryConversationDocuments(query.terms)
      if (documents.length >= 60) retrievalTruncated = true
      conversationMatches.push(rankMemoryRecallDocuments(
        documents.map((document) => ({
          reference: document.messageId,
          label: `Your message in ${document.conversationTitle}`,
          capturedAt: document.createdAt,
          content: document.content,
          role: document.role,
        })),
        query,
        4,
        MAX_CONVERSATION_MATCH_CHARS
      ))
    }
    if (conversationMatches.some((matches) => matches.length > 3)) retrievalTruncated = true
    appendInterleavedMatches(candidates, conversationMatches, 'conversation', 3, MAX_CONVERSATION_MATCH_CHARS)
  }

  if (request.includeRecallFiles) {
    const filesystemController = new AbortController()
    let filesystemTimedOut = false
    const abortFilesystem = () => filesystemController.abort()
    const filesystemTimer = setTimeout(() => {
      filesystemTimedOut = true
      filesystemController.abort()
    }, 150_000)
    signal?.addEventListener('abort', abortFilesystem, { once: true })
    try {
      const filesystemQueries = buildFilesystemRecallQueries(recallQueries)
      const memoryFileScope = { everywhere: isPathEverywhere(), roots: getResolvedRoots() }
      const resultGroups = await mapWithConcurrency(filesystemQueries, 4, async (query) => {
        throwIfCollectionAborted(signal)
        const results = await searchRecallFilesForQuery(query, filesystemController.signal, 10, memoryFileScope)
        if (results.length >= 10) retrievalTruncated = true
        return results
      })

      const selectedFiles: RecallSearchResult[] = []
      const selectedPaths = new Set<string>()
      for (let rank = 0; rank < 3 && selectedFiles.length < MAX_RECALL_FILES_TO_EXTRACT; rank += 1) {
        for (const results of resultGroups) {
          const result = results[rank]
          if (!result?.path || selectedPaths.has(result.path)) continue
          selectedPaths.add(result.path)
          selectedFiles.push(result)
          if (selectedFiles.length >= MAX_RECALL_FILES_TO_EXTRACT) break
        }
      }
      if (resultGroups.some((results) => results.length > 3)) retrievalTruncated = true

      const recallDocuments = (await mapWithConcurrency(selectedFiles, 3, async (result) => {
        throwIfCollectionAborted(signal)
        try {
          const content = await extractRecallFileText(result.path!, filesystemController.signal)
          if (!content.trim()) return null
          return {
            reference: result.path!,
            label: `Recall file / ${result.title}`,
            capturedAt: result.modifiedAt,
            content,
          } satisfies MemoryRecallDocument
        } catch (error) {
          if (signal?.aborted || filesystemTimedOut) throw error
          return null
        }
      })).filter((document): document is MemoryRecallDocument => document !== null)

      const recallFileMatches = recallQueries.map((query) => rankMemoryRecallDocuments(
        recallDocuments,
        query,
        4,
        MAX_RECALL_FILE_MATCH_CHARS
      ))
      if (recallFileMatches.some((matches) => matches.length > 3)) retrievalTruncated = true
      appendInterleavedMatches(candidates, recallFileMatches, 'recall-file', 3, 4_800)
    } catch (error) {
      if (signal?.aborted) throw error
      retrievalTruncated = true
    } finally {
      clearTimeout(filesystemTimer)
      signal?.removeEventListener('abort', abortFilesystem)
    }
  }

  if (request.includeIMessages) {
    const messages = readIMessages()
    await yieldForCancellation()
    throwIfCollectionAborted(signal)
    if (messages.accessible && messages.contacts.length > 0) {
      candidates.push({
        type: 'imessage-metadata',
        reference: 'imessage-contact-activity',
        label: 'iMessage contact activity metadata',
        capturedAt: now,
        content: JSON.stringify({
          totalMessages: messages.totalMessages,
          contacts: messages.contacts.map((contact) => ({
            name: contact.name,
            handle: contact.phoneNumber,
            messageCount: contact.messageCount,
            fromMeCount: contact.fromMeCount,
            daysActive: contact.daysActive,
            lastMessageDate: contact.lastMessageDate,
          })),
        }),
      })
    }
  }

  const sources: MemoryEvidenceSource[] = []
  const sourceCounts: Partial<Record<MemorySourceType, number>> = {}
  const usedByType: Partial<Record<MemorySourceType, number>> = {}
  const sourcePriority: Record<MemorySourceType, number> = {
    'os-account': 0,
    settings: 1,
    'imessage-metadata': 2,
    conversation: 3,
    'project-file': 4,
    'recall-file': 5,
    'psychology-analysis': 6,
      'claude-import': 8,
    'activity-events': 9,
    'super-context': 10,
    manual: 11,
  }
  candidates.sort((left, right) => sourcePriority[left.type] - sourcePriority[right.type])
  let usedChars = 0
  let truncated = retrievalTruncated
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    if (candidateIndex % 20 === 0) await yieldForCancellation()
    const candidate = candidates[candidateIndex]
    throwIfCollectionAborted(signal)
    if (usedChars >= MAX_CONTEXT_CHARS) {
      truncated = true
      break
    }
    const remaining = MAX_CONTEXT_CHARS - usedChars
    const typeRemaining = SOURCE_TYPE_BUDGETS[candidate.type] - (usedByType[candidate.type] || 0)
    if (typeRemaining < 100) {
      truncated = true
      continue
    }
    const typeLimit = candidate.type === 'conversation'
      ? 1200
      : candidate.type === 'project-file'
        ? 8000
        : candidate.type === 'recall-file'
          ? 4800
        : candidate.type === 'psychology-analysis'
          ? 6000
        : candidate.type === 'activity-events'
          ? 6000
          : MAX_SOURCE_CHARS
    const maxContent = Math.min(typeLimit, remaining, typeRemaining)
    if (maxContent < 100) {
      truncated = true
      break
    }
    const redactedContent = redactMemoryContent(candidate.content)
    const content = redactedContent.length > maxContent
      ? `${redactedContent.slice(0, Math.max(0, maxContent - 16))}\n...[truncated]`
      : redactedContent
    if (content.length < redactedContent.length) truncated = true
    const source: MemoryEvidenceSource = {
      ...candidate,
      id: `source-${sources.length + 1}`,
      label: redactMemoryContent(candidate.label).slice(0, 300),
      content,
    }
    sources.push(source)
    sourceCounts[source.type] = (sourceCounts[source.type] || 0) + 1
    usedByType[source.type] = (usedByType[source.type] || 0) + content.length
    usedChars += content.length
  }
  if (sources.length < candidates.length) truncated = true

  await yieldForCancellation()
  throwIfCollectionAborted(signal)

  return { sources, sourceCounts, truncated }
}
