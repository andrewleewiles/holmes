import crypto from 'crypto'
import * as database from './database'
import * as settings from './settings'
import { readContactRecords } from './contactsDb'
import { callLLMRetrying } from './llmCall'
import { createRateLimiter } from './rateLimit'
import { hasProviderCredentials } from '../shared/providerConfig'
import { redactMemoryContent } from './memory'
import { parseFolderContext } from './documentContext'
import {
  analysisPeopleToEntries,
  isPseudonymName,
  mentionsFingerprint,
  parsePeopleBlock,
  personKey,
  stripPeopleBlock,
} from '../shared/people'
import { stripTimelineBlock } from '../shared/timeline'
import {
  MIN_SCORE_FOR_DOSSIER,
  MIN_SCORE_FOR_PERSON,
  PERSON_SOURCE_CONFIDENCE,
  resolvePeople,
  type ResolvableMention,
} from '../shared/peopleResolve'
import type { PeopleRun } from './peopleRuns'
import { reportPeopleRunProgress } from './peopleRuns'
import type {
  ParsedPersonEntry,
  PeopleFilter,
  PeopleRebuildProgress,
  PeopleRebuildResult,
  Person,
  PersonRelation,
  PersonSeed,
  PersonSourceType,
  ProviderConfig,
} from '../shared/types'

type ProgressSender = (progress: PeopleRebuildProgress) => void

export const DOSSIER_PROMPT_VERSION = 'v1-person-dossier'

const MAX_DOSSIER_INPUT_CHARS = 30_000
const MAX_DOSSIER_CHARS = 4_000
const MAX_DOSSIER_SHORT_CHARS = 240
const DOSSIER_MAX_TOKENS = 8_000
const DOSSIER_CONCURRENCY = 3
/** Below this a counterparty is noise: a two-message thread is not a relationship. */
const MIN_MESSAGES_FOR_SEED = 5
const MAX_CHAT_PEOPLE_CHARS = 6_000

export const PERSON_YEAR_PROMPT_VERSION = 'v1-person-year'
const MAX_YEAR_INPUT_CHARS = 40_000
const MAX_YEAR_CONTEXT_CHARS = 2_000
const MAX_YEAR_SAMPLE = 600
const YEAR_MAX_TOKENS = 4_000
const YEAR_CONCURRENCY = 3
/** Below this a year is too thin to be worth a model call of its own. */
const MIN_MESSAGES_FOR_YEAR = 5

// --- harvest -----------------------------------------------------------------

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function mentionKeyFor(sourceRef: string, rawName: string): string {
  const normalized = personKey(rawName) || rawName.toLowerCase()
  return crypto.createHash('sha256').update(`${sourceRef}::${normalized}`).digest('hex').slice(0, 32)
}

function toMention(
  entry: ParsedPersonEntry,
  context: { sourceType: PersonSourceType; sourceRef: string; sourceLabel: string; projectId: string | null }
): ResolvableMention {
  return {
    mentionKey: mentionKeyFor(context.sourceRef, entry.name),
    rawName: entry.name,
    relation: entry.relation,
    role: entry.role,
    aka: entry.aka,
    evidence: entry.evidence,
    sourceType: context.sourceType,
    sourceRef: context.sourceRef,
    sourceLabel: context.sourceLabel,
    projectId: context.projectId,
    confidence: PERSON_SOURCE_CONFIDENCE[context.sourceType],
  }
}

/**
 * Reads every generated context's PEOPLE block. Purely local — no model calls,
 * exactly like the timeline harvest.
 *
 * Superseded context versions are deliberately NOT harvested. A regeneration is
 * a dated fact and belongs on the timeline; a person is not, and re-reading old
 * versions would double-count everyone and resurrect people the current context
 * dropped on purpose.
 */
export function harvestPersonMentions(sendProgress?: ProgressSender): {
  mentions: ResolvableMention[]
  sourcesScanned: number
} {
  const mentions: ResolvableMention[] = []
  let sourcesScanned = 0

  const push = (
    entries: ParsedPersonEntry[],
    context: { sourceType: PersonSourceType; sourceRef: string; sourceLabel: string; projectId: string | null }
  ): void => {
    sourcesScanned += 1
    for (const entry of entries) mentions.push(toMention(entry, context))
  }

  for (const project of database.listProjects()) {
    // Text only: photo contexts never name anyone by contract, so loading them
    // would be megabytes of blobs read to find nothing.
    for (const file of database.listDocumentFileContexts(project.id, { kind: 'text' })) {
      push(parsePeopleBlock(file.context), {
        sourceType: 'document',
        sourceRef: `project:${project.id}:file:${file.relativePath}`,
        sourceLabel: `${project.name} · ${file.relativePath}`,
        projectId: project.id,
      })
    }

    for (const folder of database.listDocumentFolderContexts(project.id)) {
      const isRoot = folder.relativePath === '.'
      push(parsePeopleBlock(folder.context), {
        sourceType: isRoot ? 'project' : 'folder',
        sourceRef: `project:${project.id}:folder:${folder.relativePath}`,
        sourceLabel: isRoot ? `${project.name} index` : `${project.name} · ${folder.relativePath}/`,
        projectId: project.id,
      })
    }

    for (const conversation of database.listProjectConversationContexts(project.id)) {
      push(parsePeopleBlock(conversation.context), {
        sourceType: 'conversation',
        sourceRef: `project:${project.id}:conversation:${conversation.conversationId}`,
        sourceLabel: `${project.name} · ${conversation.title}`,
        projectId: project.id,
      })
    }

    if (project.healthAnalysis?.people?.length) {
      push(analysisPeopleToEntries(project.healthAnalysis.people), {
        sourceType: 'health',
        sourceRef: `project:${project.id}:health-analysis`,
        sourceLabel: `${project.name} health analysis`,
        projectId: project.id,
      })
    }
    if (project.activityAnalysis?.people?.length) {
      push(analysisPeopleToEntries(project.activityAnalysis.people), {
        sourceType: 'activity',
        sourceRef: `project:${project.id}:activity-analysis`,
        sourceLabel: `${project.name} activity analysis`,
        projectId: project.id,
      })
    }

    sendProgress?.({ phase: 'harvest', message: `Reading ${project.name}`, current: sourcesScanned, total: null })
  }

  const userContext = database.getUserSuperContext()
  if (userContext?.context) {
    push(parsePeopleBlock(userContext.context), {
      sourceType: 'user-context',
      sourceRef: 'user:super-context',
      sourceLabel: 'User super-context',
      projectId: null,
    })
  }

  const memorySummary = database.getMemorySummary().summary
  if (memorySummary) {
    push(parsePeopleBlock(memorySummary), {
      sourceType: 'memory',
      sourceRef: 'memory:summary',
      sourceLabel: 'Memory summary',
      projectId: null,
    })
  }

  // Absorbed from the retired iMessage relationship analysis, if a database ever
  // stored one. Read from the mention table, since that migration wrote there.
  for (const stored of database.listAllPersonMentions({ includeArchived: true })) {
    if (stored.sourceType !== 'relationship-analysis') continue
    mentions.push({
      mentionKey: stored.mentionKey,
      rawName: stored.rawName,
      relation: stored.relation,
      role: stored.role,
      aka: stored.aka,
      evidence: stored.evidence,
      sourceType: 'relationship-analysis',
      sourceRef: stored.sourceRef,
      sourceLabel: stored.sourceLabel,
      projectId: stored.projectId,
      confidence: PERSON_SOURCE_CONFIDENCE['relationship-analysis'],
    })
  }

  return { mentions, sourcesScanned }
}

// --- seeds -------------------------------------------------------------------

const MEMORY_RELATION_FIELDS: Record<string, { relation: PersonRelation; role: string }> = {
  partner_name: { relation: 'partner', role: 'partner' },
  children: { relation: 'family', role: 'child' },
  dependents: { relation: 'family', role: 'dependent' },
  household_members: { relation: 'family', role: 'household member' },
  close_family: { relation: 'family', role: '' },
  close_friends: { relation: 'friend', role: '' },
  colleagues: { relation: 'colleague', role: '' },
  important_contacts: { relation: 'acquaintance', role: '' },
}

function splitMemoryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') return value.split(/[,\n;]/).map((part) => part.trim()).filter(Boolean)
  return []
}

/**
 * The structured spine, built before any model output is consulted.
 *
 * This is what makes People useful with zero LLM calls and zero re-indexing: the
 * macOS address book supplies asserted identities and their handles, the stored
 * iMessage events supply real volume and cadence per counterparty, and Memory
 * supplies the only relation assertions the user made themselves.
 */
export function collectPersonSeeds(): PersonSeed[] {
  const seeds: PersonSeed[] = []

  try {
    for (const record of readContactRecords()) {
      const name = record.name.trim()
      if (!name) continue
      seeds.push({
        personKey: `contact:${record.recordId}`,
        displayName: name,
        seedSource: 'contacts',
        relation: 'unknown',
        role: '',
        aliases: [
          ...record.emails.map((email) => ({ alias: email, kind: 'email' as const })),
          ...record.phones.map((phone) => ({ alias: phone, kind: 'phone' as const })),
        ],
        platforms: [],
        isPseudonym: false,
        messageCount: 0,
        sentCount: 0,
        daysActive: 0,
        firstSeen: null,
        lastSeen: null,
        confidence: 1,
      })
    }
  } catch {
    // No Full Disk Access, or no address book. The other seed layers still work.
  }

  // One seed per (counterparty, platform). Two platforms naming the same person
  // therefore arrive as two seeds that merge on the name — which is what makes a
  // single record span platforms without any special case.
  for (const row of database.listMessagingPlatforms(MIN_MESSAGES_FOR_SEED)) {
    const pseudonym = isPseudonymName(row.name)
    seeds.push({
      personKey: pseudonym
        ? `pseudo:${row.provider}:${row.name}`
        : `messaging:${personKey(row.name) || row.name.toLowerCase()}`,
      displayName: row.name,
      seedSource: 'messaging',
      relation: 'unknown',
      role: '',
      aliases: [],
      platforms: [{
        provider: row.provider,
        messageCount: row.messageCount,
        sentCount: row.sentCount,
        daysActive: row.daysActive,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
      }],
      isPseudonym: pseudonym,
      messageCount: row.messageCount,
      sentCount: row.sentCount,
      daysActive: row.daysActive,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      confidence: 0.9,
    })
  }

  try {
    for (const field of database.listMemoryFields()) {
      const mapping = MEMORY_RELATION_FIELDS[field.fieldKey]
      if (!mapping || !field.value) continue
      for (const name of splitMemoryList((field.value as { value?: unknown }).value ?? field.value)) {
        const trimmed = name.trim()
        if (!trimmed || trimmed.length > 80) continue
        seeds.push({
          personKey: `memory:${personKey(trimmed) || trimmed.toLowerCase()}`,
          displayName: trimmed,
          seedSource: 'memory',
          relation: mapping.relation,
          role: mapping.role,
          aliases: [],
          platforms: [],
          isPseudonym: false,
          messageCount: 0,
          sentCount: 0,
          daysActive: 0,
          firstSeen: null,
          lastSeen: null,
          confidence: 1,
        })
      }
    }
  } catch {
    // Memory is optional evidence, never a hard dependency.
  }

  return seeds
}

// --- dossiers ----------------------------------------------------------------

const PERSON_YEAR_SYSTEM_PROMPT = `You are summarizing one year of message history between the owner of an archive and one other person, so that a later pass can describe the relationship without re-reading tens of thousands of messages.

Write 1-2 paragraphs of plain prose covering: what this year of the relationship was actually about — the recurring subjects, plans, and shared context; how the two of them relate, as the messages themselves show it; and anything that visibly began, changed, or ended during the year.

Rules:
- Use ONLY these messages. Never add anything you were not shown, and never infer facts because they are likely.
- These are excerpts, evenly sampled across the year, not the whole thread. Describe what they show; do not claim completeness.
- Do not quote more than a short phrase, and never reproduce anything that reads as private detail — an address, an account, a medical fact about a third party.
- Report what was said, not what you think it means about either person's character or mental state. No diagnoses, no judgments.
- If the messages are thin or purely logistical, say that plainly in one or two sentences. A short honest summary is correct; do not pad.
- Output prose only. No headings, no lists, no TIMELINE block, no PEOPLE block.`

function renderYearMessages(
  messages: Array<{ occurredAt: string; direction: string; text: string }>,
  maxChars: number
): { text: string; used: number } {
  const lines: string[] = []
  let length = 0
  for (const message of messages) {
    const line = `${message.occurredAt.slice(0, 10)} ${message.direction === 'sent' ? 'owner' : 'them'}: ${message.text}`
    if (length + line.length + 1 > maxChars) break
    lines.push(line)
    length += line.length + 1
  }
  return { text: lines.join('\n'), used: lines.length }
}

/**
 * Compresses each person-year of message history into prose.
 *
 * This is the middle layer that makes reading messages possible at all: the
 * largest thread here is ~29,000 messages, and a dossier budget is 30,000
 * characters. Summarizing per year first is the same move the document index
 * makes from file to folder, and it is what lets a dossier describe how a
 * relationship changed rather than only how big it is.
 */
async function generatePersonYearContexts(
  people: Person[],
  config: ProviderConfig,
  model: string,
  signal: AbortSignal | undefined,
  sendProgress: ProgressSender | undefined,
  force: boolean
): Promise<{ generated: number; covered: number; failed: number; firstError: string | null }> {
  // Only people who actually have message history, keyed by the display name the
  // events are stored under.
  const byName = new Map<string, Person>()
  for (const person of people) {
    if (person.messageCount > 0) byName.set(person.displayName, person)
  }
  if (byName.size === 0) return { generated: 0, covered: 0, failed: 0, firstError: null }

  const years = database.listCounterpartyYears([...byName.keys()])
  const hashes = database.getPersonYearHashes()
  const limiter = createRateLimiter(settings.getSettings().requestsPerMinute)

  const work: Array<{ person: Person; year: number; messageCount: number }> = []
  let covered = 0
  for (const row of years) {
    const person = byName.get(row.name)
    if (!person) continue
    if (row.messageCount < MIN_MESSAGES_FOR_YEAR) continue
    const hash = hashString(`${PERSON_YEAR_PROMPT_VERSION}:${row.messageCount}`)
    if (!force && hashes.get(`${person.personKey}:${row.year}`) === hash) {
      covered += 1
      continue
    }
    work.push({ person, year: row.year, messageCount: row.messageCount })
  }

  let generated = 0
  let failed = 0
  let firstError: string | null = null
  let done = 0

  const run = async (item: { person: Person; year: number; messageCount: number }): Promise<void> => {
    if (signal?.aborted) return
    try {
      const messages = database.listCounterpartyMessages(item.person.displayName, item.year, MAX_YEAR_SAMPLE)
      const rendered = renderYearMessages(messages, MAX_YEAR_INPUT_CHARS)
      if (rendered.used === 0) return
      const header = `Messages between the archive's owner and ${item.person.displayName} during ${item.year}. ${rendered.used} of ${item.messageCount} messages, evenly sampled across the year.\n\n`
      const raw = await callLLMRetrying(
        config, model, PERSON_YEAR_SYSTEM_PROMPT, `${header}${rendered.text}`, signal, 3,
        { maxTokens: YEAR_MAX_TOKENS, limiter }
      )
      const text = redactMemoryContent(raw.trim()).slice(0, MAX_YEAR_CONTEXT_CHARS)
      if (!text) throw new Error('empty year summary')
      database.upsertPersonYearContext({
        personKey: item.person.personKey,
        displayName: item.person.displayName,
        year: item.year,
        context: text,
        messageCount: item.messageCount,
        sampledCount: rendered.used,
        inputHash: hashString(`${PERSON_YEAR_PROMPT_VERSION}:${item.messageCount}`),
      })
      generated += 1
      covered += 1
    } catch (err) {
      if (signal?.aborted) throw err
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      if (!firstError) firstError = message
      console.error(`[people] year summary failed for ${item.person.displayName} ${item.year}:`, message)
    } finally {
      done += 1
      sendProgress?.({
        phase: 'messages',
        message: `Reading ${item.person.displayName}, ${item.year}`,
        current: done,
        total: work.length,
      })
    }
  }

  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(YEAR_CONCURRENCY, work.length)) }, async () => {
      while (cursor < work.length) {
        const index = cursor
        cursor += 1
        await run(work[index])
      }
    })
  )

  return { generated, covered, failed, firstError }
}

const DOSSIER_SYSTEM_PROMPT = `You are building a factual profile of one person in someone's life, from evidence already extracted from that person's own archive.

Write exactly this shape:

SHORT: <one sentence, under 200 characters, naming who this person is to the archive's owner and the single most telling thing the evidence shows>
---
<the long profile: 2-4 paragraphs covering who they are to the owner and on what evidence; how the relationship appears across the sources, including how it changed over time when the evidence shows that; and what the evidence does NOT establish>

Rules:
- Use ONLY the evidence given below. Never add biography, employment, location or history from outside it, and never infer a fact because it is likely.
- Where sources disagree about the relationship, say so plainly and attribute each reading to its source. Do not pick a winner and do not average them.
- Messaging statistics describe volume and cadence, nothing more. Never read closeness, affection, conflict or sentiment out of a message count.
- Never state a diagnosis, a judgment of character, or a sentiment the evidence does not carry in words.
- When per-year message summaries are given, the history is the point: say how the relationship actually developed across those years, naming the years. Do not simply restate each year in turn.
- Name what is missing: if the evidence is one mention from one source, say that, and keep the profile to a single short paragraph. A thin honest profile is correct; do not pad.
- This is a real person who did not consent to being profiled. Write nothing you could not show them.
- Do not output a TIMELINE or PEOPLE block.`

function packMentions(
  mentions: Array<{ sourceLabel: string; rawName: string; relation: string; role: string; evidence: string }>,
  maxChars: number
): { text: string; omitted: number } {
  // Evidence text is dropped before whole mentions are, so every source stays
  // represented even when the budget is tight.
  const render = (withEvidence: boolean): string[] =>
    mentions.map((mention) => {
      const head = `- [${mention.sourceLabel}] "${mention.rawName}" — ${mention.relation}${mention.role ? `, ${mention.role}` : ''}`
      return withEvidence && mention.evidence ? `${head}: ${mention.evidence}` : head
    })

  let lines = render(true)
  if (lines.join('\n').length > maxChars) lines = render(false)

  let omitted = 0
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines.pop()
    omitted += 1
  }
  return { text: lines.join('\n'), omitted }
}

function dossierHashFor(
  person: Person,
  mentions: Array<{ sourceRef: string; rawName: string; relation: string; evidence: string }>
): string {
  const stats = `${person.messageCount}:${person.sentCount}:${person.daysActive}:${person.firstSeen ?? ''}:${person.lastSeen ?? ''}:${person.relation}:${person.role}`
  // The year summaries are an input to the profile, so a regenerated year has to
  // invalidate it — otherwise the dossier keeps quoting a summary that changed.
  const yearFingerprint = database
    .listPersonYearContexts(person.personKey)
    .map((year) => `${year.year}:${year.context.length}:${year.sampledCount}`)
    .join(',')
  return crypto
    .createHash('sha256')
    .update(`${DOSSIER_PROMPT_VERSION}\n${stats}\n${yearFingerprint}\n${mentionsFingerprint(mentions)}`)
    .digest('hex')
    .slice(0, 32)
}

function buildDossierPrompt(person: Person, mentions: ReturnType<typeof database.listPersonMentions>): string {
  const parts: string[] = []
  parts.push(`PERSON: ${person.displayName}`)
  parts.push(`RELATION TO THE ARCHIVE'S OWNER: ${person.relation}${person.role ? ` (${person.role})` : ''}`)
  if (person.aliases.length > 0) {
    parts.push(`ALSO APPEARS AS: ${person.aliases.map((alias) => alias.alias).slice(0, 12).join(', ')}`)
  }
  if (person.messageCount > 0) {
    const sentShare = person.messageCount > 0 ? Math.round((person.sentCount / person.messageCount) * 100) : 0
    parts.push(
      `MESSAGING: ${person.messageCount} messages, ${sentShare}% sent by the owner, across ${person.daysActive} distinct days` +
        (person.firstSeen && person.lastSeen ? `, from ${person.firstSeen.slice(0, 10)} to ${person.lastSeen.slice(0, 10)}` : '')
    )
  }
  const years = database.listPersonYearContexts(person.personKey)
  if (years.length > 0) {
    parts.push(
      `\nMESSAGE HISTORY BY YEAR (each year below is a summary of that year's messages, not the messages themselves):`
    )
    for (const year of years) {
      parts.push(`${year.year} (${year.messageCount} messages, ${year.sampledCount} read): ${year.context}`)
    }
  }
  const packed = packMentions(mentions, MAX_DOSSIER_INPUT_CHARS - parts.join('\n').length - 200)
  parts.push(`\nEVIDENCE (${mentions.length} mention${mentions.length === 1 ? '' : 's'}${packed.omitted > 0 ? `, ${packed.omitted} omitted for space` : ''}):`)
  parts.push(packed.text)
  return parts.join('\n')
}

async function generateDossiers(
  config: ProviderConfig,
  model: string,
  signal: AbortSignal | undefined,
  sendProgress: ProgressSender | undefined,
  force: boolean
): Promise<{ generated: number; covered: number; failed: number; firstError: string | null }> {
  const candidates = database
    .listPeople({ minScore: MIN_SCORE_FOR_DOSSIER })
    .filter((person) => person.status === 'confirmed' && !person.isPseudonym && !person.isSelf && person.relation !== 'public')

  let generated = 0
  let covered = 0
  let failed = 0
  let firstError: string | null = null
  let done = 0

  const limiter = createRateLimiter(settings.getSettings().requestsPerMinute)

  const work = async (person: Person): Promise<void> => {
    if (signal?.aborted) return
    const mentions = database.listPersonMentions(person.id)
    const hash = dossierHashFor(person, mentions)
    if (!force && person.dossierHash === hash && person.dossier) {
      covered += 1
      done += 1
      return
    }
    try {
      const raw = await callLLMRetrying(
        config,
        model,
        DOSSIER_SYSTEM_PROMPT,
        buildDossierPrompt(person, mentions),
        signal,
        3,
        { maxTokens: DOSSIER_MAX_TOKENS, limiter }
      )
      const parsed = parseFolderContext(raw, MAX_DOSSIER_CHARS)
      const long = redactMemoryContent(parsed.long).trim()
      if (!long) throw new Error('empty dossier')
      database.setPersonDossier({
        personKey: person.personKey,
        contextShort: redactMemoryContent(parsed.short).slice(0, MAX_DOSSIER_SHORT_CHARS),
        context: long,
        dossierHash: hash,
      })
      generated += 1
      covered += 1
    } catch (err) {
      if (signal?.aborted) throw err
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      if (!firstError) firstError = message
      console.error(`[people] dossier failed for ${person.displayName}:`, message)
    } finally {
      done += 1
      sendProgress?.({
        phase: 'dossier',
        message: `Profiling ${person.displayName}`,
        current: done,
        total: candidates.length,
      })
    }
  }

  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(DOSSIER_CONCURRENCY, candidates.length)) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor
      cursor += 1
      await work(candidates[index])
    }
  })
  await Promise.all(runners)

  return { generated, covered, failed, firstError }
}

// --- rebuild -----------------------------------------------------------------

export function isPeopleEnabled(): boolean {
  try {
    return settings.getSettings().peopleEnabled === true
  } catch {
    return false
  }
}

export async function rebuildPeople(
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  sendProgress?: ProgressSender,
  options?: { skipDossiers?: boolean; forceDossiers?: boolean }
): Promise<PeopleRebuildResult> {
  sendProgress?.({ phase: 'seed', message: 'Reading contacts and message history', current: null, total: null })
  database.absorbRelationshipAnalyses()
  const seeds = collectPersonSeeds()

  sendProgress?.({ phase: 'harvest', message: 'Reading generated contexts', current: 0, total: null })
  const { mentions, sourcesScanned } = harvestPersonMentions(sendProgress)

  sendProgress?.({ phase: 'resolve', message: `Resolving ${mentions.length} mentions`, current: mentions.length, total: mentions.length })
  const resolved = resolvePeople({ mentions, seeds, overrides: database.listPeopleOverrides() })

  const stored = database.mergeDerivedPeople(
    resolved.people.map((person) => ({
      personKey: person.personKey,
      displayName: person.displayName,
      relation: person.relation,
      role: person.role,
      status: person.status,
      isPseudonym: person.isPseudonym,
      isSelf: person.isSelf,
      seedSource: person.seedSource,
      mentionCount: person.mentionCount,
      sourceCount: person.sourceCount,
      messageCount: person.messageCount,
      sentCount: person.sentCount,
      daysActive: person.daysActive,
      firstSeen: person.firstSeen,
      lastSeen: person.lastSeen,
      score: person.score,
      confidence: person.confidence,
      projectIds: person.projectIds,
      platforms: person.platforms,
      aliases: person.aliases,
    })),
    resolved.mentions.map((mention) => ({
      mentionKey: mention.mentionKey,
      personKey: mention.personKey,
      rawName: mention.rawName,
      nameKey: mention.nameKey,
      handleKey: mention.handleKey,
      relation: mention.relation,
      role: mention.role,
      aka: mention.aka,
      evidence: mention.evidence,
      sourceType: mention.sourceType,
      sourceRef: mention.sourceRef,
      sourceLabel: mention.sourceLabel,
      projectId: mention.projectId,
      confidence: mention.confidence,
      resolutionRule: mention.resolutionRule,
    }))
  )

  let years = { generated: 0, covered: 0, failed: 0, firstError: null as string | null }
  let dossiers = { generated: 0, covered: 0, failed: 0, firstError: null as string | null }
  const wantsDossiers = !options?.skipDossiers && hasProviderCredentials(config) && model.trim().length > 0
  if (wantsDossiers) {
    // Years first: a dossier is written from them, so an out-of-date year would
    // be baked into the profile for as long as its own hash stayed valid.
    const candidates = database
      .listPeople({ minScore: MIN_SCORE_FOR_DOSSIER })
      .filter((person) => person.status === 'confirmed' && !person.isPseudonym && !person.isSelf && person.relation !== 'public')
    years = await generatePersonYearContexts(candidates, config, model, signal, sendProgress, options?.forceDossiers === true)
    dossiers = await generateDossiers(config, model, signal, sendProgress, options?.forceDossiers === true)
  }

  const total = database.listPeople({ minScore: MIN_SCORE_FOR_PERSON }).length
  sendProgress?.({
    phase: 'complete',
    message: `${total} people across ${sourcesScanned} source${sourcesScanned === 1 ? '' : 's'}, ${years.covered} year${years.covered === 1 ? '' : 's'} of messages read, ${dossiers.covered} profiled`,
    current: total,
    total,
  })

  return {
    sourcesScanned,
    mentionsHarvested: mentions.length,
    seedsCollected: seeds.length,
    peopleStored: stored.inserted,
    peopleUpdated: stored.updated,
    peopleArchived: stored.archived,
    ambiguous: resolved.ambiguous,
    overridesApplied: resolved.overridesApplied,
    dossiersGenerated: dossiers.generated,
    dossiersCovered: dossiers.covered,
    dossiersFailed: dossiers.failed,
    dossiersError: dossiers.firstError ?? years.firstError,
    yearsGenerated: years.generated,
    yearsCovered: years.covered,
    yearsFailed: years.failed,
  }
}

export function reportProgressTo(run: PeopleRun): ProgressSender {
  return (progress) => reportPeopleRunProgress(run, progress)
}

// --- chat context ------------------------------------------------------------

/**
 * Leaves separate-context projects out of the life scope, mirroring
 * `lifeTimelineFilter`. The explicit `projectScoped` boolean matters: an
 * always-truthy filter object silently disabled an unrelated branch when the
 * timeline did this, and the same trap is here.
 */
export function lifePeopleFilter(filter?: PeopleFilter): PeopleFilter {
  const separate = database.listProjects().filter((project) => project.contextScope === 'separate').map((project) => project.id)
  return { ...(filter ?? {}), excludeProjectIds: separate.length > 0 ? separate : undefined }
}

const RELATION_ORDER: PersonRelation[] = [
  'partner', 'family', 'friend', 'colleague', 'professional', 'community', 'client', 'acquaintance', 'public', 'unknown', 'self',
]

export function buildPeopleContext(options: {
  projectIds?: string[]
  maxChars?: number
  includeDossiers?: boolean
}): { content: string; personCount: number } | null {
  const maxChars = options.maxChars ?? MAX_CHAT_PEOPLE_CHARS
  const projectScoped = Boolean(options.projectIds && options.projectIds.length > 0)
  const filter: PeopleFilter = projectScoped
    ? { projectIds: options.projectIds, minScore: MIN_SCORE_FOR_PERSON }
    : lifePeopleFilter({ minScore: MIN_SCORE_FOR_PERSON })

  const people = database
    .listPeople(filter)
    // An unresolvable name must never be presented as a person.
    .filter((person) => person.status === 'confirmed')

  if (people.length === 0) return null

  const ranked = [...people].sort((a, b) => {
    const byRelation = RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation)
    if (byRelation !== 0) return byRelation
    return b.score - a.score || b.messageCount - a.messageCount || a.displayName.localeCompare(b.displayName)
  })

  const spine: string[] = []
  for (const person of ranked) {
    const label = person.role ? `${person.relation}, ${person.role}` : person.relation
    const stats: string[] = []
    if (person.sourceCount > 0) stats.push(`${person.sourceCount} source${person.sourceCount === 1 ? '' : 's'}`)
    if (person.messageCount > 0) stats.push(`${person.messageCount} messages`)
    if (person.firstSeen && person.lastSeen) {
      stats.push(`${person.firstSeen.slice(0, 4)}–${person.lastSeen.slice(0, 4)}`)
    }
    const gist = person.dossierShort ? ` — ${person.dossierShort}` : ''
    spine.push(`- ${person.displayName} (${label})${gist}${stats.length > 0 ? ` [${stats.join(' · ')}]` : ''}`)
  }

  const parts: string[] = []
  let budget = maxChars
  const spineText = spine.join('\n')
  const spineBlock = spineText.length > budget ? spineText.slice(0, budget) : spineText
  parts.push(spineBlock)
  budget -= spineBlock.length

  let expanded = 0
  if (options.includeDossiers !== false) {
    const details: string[] = []
    for (const person of [...ranked].sort((a, b) => b.score - a.score || b.messageCount - a.messageCount)) {
      if (!person.dossier) continue
      const block = `\n${person.displayName} — ${person.relation}${person.role ? `, ${person.role}` : ''}\n${person.dossier}`
      if (block.length > budget) break
      details.push(block)
      budget -= block.length
      expanded += 1
    }
    if (details.length > 0) parts.push(`\nPROFILES\n${details.join('\n')}`)
  }

  const coverage = expanded > 0
    ? `${people.length} recorded people; ${expanded} given in full below and the rest one line each.`
    : `${people.length} recorded people, one line each.`

  return { content: `${coverage}\n\n${parts.join('\n')}`, personCount: people.length }
}

/** Strips both machine-parsed blocks from a generated context for display. */
export function stripGeneratedBlocks(text: string): string {
  return stripTimelineBlock(stripPeopleBlock(text))
}
