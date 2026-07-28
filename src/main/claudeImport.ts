import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type {
  ClaudeImportOptions,
  ClaudeImportProgress,
  ClaudeImportResult,
  MemoryCandidate,
  ProviderConfig,
} from '../shared/types'
import * as database from './database'
import { extractMemoryCandidates } from './provider'
import type { MemoryEvidenceSource } from './memory'

const MEMORY_CATEGORY_KEYS = [
  'identity',
  'contact',
  'household',
  'relationships',
  'health',
  'work',
  'education',
  'finances',
  'pets',
  'preferences',
  'routines',
  'goals',
  'travel',
  'technology',
  'vehicles',
  'possessions',
  'important-dates',
]
const MAX_PROJECT_COLOR_PALETTE = [
  '#47a08f', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#22c55e',
  '#ec4899', '#06b6d4', '#eab308', '#6366f1',
]
const MAX_CONVERSATIONS_TO_IMPORT = 50_000
const MAX_MESSAGES_PER_CONVERSATION = 5_000
const MAX_DOC_CHARS = 200_000
const MAX_CLAUDE_SOURCE_CHARS = 16_000
const MAX_CLAUDE_EVIDENCE_CHARS = 80_000
const MEMORY_EXTRACTION_TIMEOUT_MS = 120_000

interface ClaudeChatMessage {
  uuid?: string
  text?: unknown
  sender?: unknown
  created_at?: unknown
}

interface ClaudeConversation {
  uuid?: string
  name?: unknown
  summary?: unknown
  created_at?: unknown
  updated_at?: unknown
  chat_messages?: unknown
}

interface ClaudeProjectDoc {
  uuid?: string
  filename?: unknown
  content?: unknown
  created_at?: unknown
}

interface ClaudeProject {
  uuid?: string
  name?: unknown
  description?: unknown
  created_at?: unknown
  updated_at?: unknown
  docs?: unknown
}

interface ClaudeMemoryEntry {
  conversations_memory?: unknown
  project_memories?: unknown
  account_uuid?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/[^\p{L}\p{N}.\-_ ]/gu, ' ').replace(/\s+/g, ' ').trim()
  return base || 'document'
}

function uniquePath(dir: string, baseName: string, ext: string): string {
  const safeBase = sanitizeFilename(baseName).slice(0, 120) || 'document'
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`
  let candidate = path.join(dir, `${safeBase}${safeExt}`)
  let counter = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safeBase} (${counter})${safeExt}`)
    counter += 1
  }
  return candidate
}

function ensureDir(target: string): void {
  fs.mkdirSync(target, { recursive: true })
}

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw) as T
}

function listJsonFiles(directory: string): string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch {
    return []
  }
  return entries
    .filter((entry) => !entry.startsWith('._') && entry.toLowerCase().endsWith('.json'))
    .map((entry) => path.join(directory, entry))
}

export function parseClaudeImportOptions(raw: unknown): ClaudeImportOptions {
  if (!isRecord(raw)) throw new Error('Claude import options must be an object')
  const allowed = [
    'importConversations',
    'importProjects',
    'importMemories',
    'includeSensitive',
    'categories',
    'confirmExternalProcessing',
  ]
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`Claude import option "${key}" is not supported`)
  }
  for (const booleanKey of ['importConversations', 'importProjects', 'importMemories', 'includeSensitive'] as const) {
    if (typeof raw[booleanKey] !== 'boolean') throw new Error(`Claude import option "${booleanKey}" must be true or false`)
  }
  if (raw.confirmExternalProcessing !== true) {
    throw new Error('Confirm external processing before importing Memory')
  }
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) {
    throw new Error('Select at least one Memory category')
  }
  if (raw.categories.length > MEMORY_CATEGORY_KEYS.length) {
    throw new Error('Too many Memory categories selected')
  }
  const categories = [...new Set(raw.categories.map((category) => cleanString(category, 80)))]
  if (categories.some((category) => !MEMORY_CATEGORY_KEYS.includes(category))) {
    throw new Error('Memory category is invalid')
  }
  if (!raw.importConversations && !raw.importProjects && !raw.importMemories) {
    throw new Error('Select at least one data type to import')
  }
  return {
    importConversations: raw.importConversations as boolean,
    importProjects: raw.importProjects as boolean,
    importMemories: raw.importMemories as boolean,
    includeSensitive: raw.includeSensitive as boolean,
    categories,
    confirmExternalProcessing: true,
  }
}

function parseChatMessageText(message: ClaudeChatMessage): string {
  if (typeof message.text === 'string') return message.text
  return ''
}

function mapSender(sender: unknown): 'user' | 'assistant' | null {
  if (typeof sender !== 'string') return null
  const normalized = sender.trim().toLocaleLowerCase()
  if (normalized === 'human' || normalized === 'user') return 'user'
  if (normalized === 'assistant') return 'assistant'
  return null
}

function buildProjectMemoryEvidence(
  memories: ClaudeMemoryEntry[]
): MemoryEvidenceSource[] {
  const now = Date.now()
  const raw: MemoryEvidenceSource[] = []
  for (const entry of memories) {
    if (typeof entry.conversations_memory === 'string' && entry.conversations_memory.trim()) {
      raw.push({
        id: `claude-conversations-memory-${raw.length + 1}`,
        type: 'claude-import',
        reference: 'claude:conversations-memory',
        label: 'Claude conversation memory summary',
        capturedAt: now,
        content: entry.conversations_memory.slice(0, MAX_CLAUDE_SOURCE_CHARS),
      })
    }
    if (isRecord(entry.project_memories)) {
      for (const [projectUuid, memory] of Object.entries(entry.project_memories)) {
        if (typeof memory !== 'string' || !memory.trim()) continue
        const project = database.getProjectById(projectUuid)
        const label = project
          ? `Claude project memory / ${project.name}`
          : `Claude project memory / ${projectUuid}`
        raw.push({
          id: `claude-project-memory-${raw.length + 1}`,
          type: 'claude-import',
          reference: `claude:project-memory:${projectUuid}`,
          label,
          capturedAt: now,
          content: memory.slice(0, MAX_CLAUDE_SOURCE_CHARS),
        })
      }
    }
  }

  const sources: MemoryEvidenceSource[] = []
  let usedChars = 0
  for (const source of raw) {
    if (usedChars >= MAX_CLAUDE_EVIDENCE_CHARS) break
    const remaining = MAX_CLAUDE_EVIDENCE_CHARS - usedChars
    const content = source.content.length > remaining
      ? `${source.content.slice(0, Math.max(0, remaining - 16))}\n...[truncated]`
      : source.content
    sources.push({ ...source, content })
    usedChars += content.length
  }
  return sources
}

async function importProjects(
  projectsDir: string,
  onProgress: (progress: ClaudeImportProgress) => void,
  signal: AbortSignal
): Promise<{ imported: number; skipped: number }> {
  const files = listJsonFiles(projectsDir)
  let imported = 0
  let skipped = 0

  const importRoot = path.join(app.getPath('userData'), 'claude-import')
  ensureDir(importRoot)

  for (let index = 0; index < files.length; index += 1) {
    if (signal.aborted) throw new Error('Claude import cancelled')
    onProgress({
      phase: 'projects',
      message: `Importing projects (${index + 1}/${files.length})`,
      current: index + 1,
      total: files.length,
    })
    let project: ClaudeProject
    try {
      project = readJsonFile<ClaudeProject>(files[index])
    } catch {
      skipped += 1
      continue
    }
    if (!isRecord(project) || typeof project.uuid !== 'string') {
      skipped += 1
      continue
    }
    const projectId = project.uuid
    const name = cleanString(project.name, 200) || 'Imported Claude project'
    const createdAt = parseIsoTimestamp(project.created_at) ?? Date.now()
    const updatedAt = parseIsoTimestamp(project.updated_at) ?? createdAt
    const color = MAX_PROJECT_COLOR_PALETTE[index % MAX_PROJECT_COLOR_PALETTE.length]

    const projectDir = path.join(importRoot, projectId)
    let createdProjectDir = false
    if (database.projectExistsById(projectId)) {
      skipped += 1
    } else {
      ensureDir(projectDir)
      createdProjectDir = true
      database.importProject({
        id: projectId,
        name,
        icon: 'folder',
        color,
        path: projectDir,
        createdAt,
        updatedAt,
      })
      imported += 1
    }

    if (createdProjectDir) {
      const docs = Array.isArray(project.docs) ? (project.docs as unknown[]) : []
      for (const rawDoc of docs) {
        if (!isRecord(rawDoc)) continue
        const doc = rawDoc as ClaudeProjectDoc
        if (typeof doc.content !== 'string' || !doc.content.trim()) continue
        const filename = typeof doc.filename === 'string' ? doc.filename : `document-${doc.uuid ?? 'untitled'}`
        const ext = path.extname(filename) || '.md'
        const base = path.basename(filename, ext)
        const targetPath = uniquePath(projectDir, base, ext)
        try {
          fs.writeFileSync(targetPath, doc.content.slice(0, MAX_DOC_CHARS), 'utf8')
          database.addProjectFile(projectId, targetPath)
        } catch {
          // Skip docs that cannot be written.
        }
      }
    }
  }

  onProgress({
    phase: 'projects',
    message: `Imported ${imported} project${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`,
    current: files.length,
    total: files.length,
  })
  return { imported, skipped }
}

async function importConversations(
  conversationsFile: string,
  onProgress: (progress: ClaudeImportProgress) => void,
  signal: AbortSignal
): Promise<{ imported: number; skipped: number; messagesImported: number }> {
  onProgress({
    phase: 'reading',
    message: 'Reading Claude conversations',
    current: 0,
    total: 0,
  })
  let conversations: ClaudeConversation[]
  try {
    conversations = readJsonFile<ClaudeConversation[]>(conversationsFile)
  } catch (error) {
    throw new Error(`Could not read conversations.json: ${error instanceof Error ? error.message : 'invalid JSON'}`)
  }
  if (!Array.isArray(conversations)) throw new Error('conversations.json must be an array')

  const total = Math.min(conversations.length, MAX_CONVERSATIONS_TO_IMPORT)
  let imported = 0
  let skipped = 0
  let messagesImported = 0

  for (let index = 0; index < total; index += 1) {
    if (signal.aborted) throw new Error('Claude import cancelled')
    if (index % 25 === 0) {
      onProgress({
        phase: 'conversations',
        message: `Importing conversations (${index + 1}/${total})`,
        current: index + 1,
        total,
      })
    }
    const conversation = conversations[index]
    if (!isRecord(conversation) || typeof conversation.uuid !== 'string') {
      skipped += 1
      continue
    }
    const conversationId = conversation.uuid
    const title = cleanString(conversation.name, 300) || 'Imported from Claude'
    const createdAt = parseIsoTimestamp(conversation.created_at) ?? Date.now()
    const updatedAt = parseIsoTimestamp(conversation.updated_at) ?? createdAt

    if (database.conversationExists(conversationId)) {
      skipped += 1
      continue
    }

    const created = database.importConversation({
      id: conversationId,
      title,
      createdAt,
      updatedAt,
    })
    if (!created) {
      skipped += 1
      continue
    }
    imported += 1

    const messages = Array.isArray(conversation.chat_messages)
      ? (conversation.chat_messages as unknown[]).filter(isRecord) as ClaudeChatMessage[]
      : []
    const limited = messages.slice(0, MAX_MESSAGES_PER_CONVERSATION)
    for (const message of limited) {
      if (signal.aborted) throw new Error('Claude import cancelled')
      const role = mapSender(message.sender)
      if (!role) continue
      const content = parseChatMessageText(message)
      if (!content.trim()) continue
      const messageId = typeof message.uuid === 'string' ? message.uuid : ''
      const messageCreatedAt = parseIsoTimestamp(message.created_at) ?? createdAt
      if (messageId) {
        if (database.importMessage({
          id: messageId,
          conversationId,
          role,
          content,
          createdAt: messageCreatedAt,
        })) {
          messagesImported += 1
        }
      } else {
        database.addMessage({ conversationId, role, content })
        messagesImported += 1
      }
    }
  }

  onProgress({
    phase: 'conversations',
    message: `Imported ${imported} conversation${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`,
    current: total,
    total,
  })
  return { imported, skipped, messagesImported }
}

async function importMemories(
  memoriesFile: string,
  options: ClaudeImportOptions,
  providerConfig: ProviderConfig,
  systemModel: string,
  onProgress: (progress: ClaudeImportProgress) => void,
  signal: AbortSignal
): Promise<{
  autoFilled: number
  suggestionsCreated: number
  candidatesFound: number
  model: string | null
  skipped: boolean
  error: string | null
}> {
  onProgress({
    phase: 'memories',
    message: 'Reading Claude memories',
    current: 0,
    total: 0,
  })
  let memories: ClaudeMemoryEntry[]
  try {
    memories = readJsonFile<ClaudeMemoryEntry[]>(memoriesFile)
  } catch (error) {
    return {
      autoFilled: 0,
      suggestionsCreated: 0,
      candidatesFound: 0,
      model: null,
      skipped: true,
      error: `Could not read memories.json: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    }
  }
  if (!Array.isArray(memories)) {
    return {
      autoFilled: 0,
      suggestionsCreated: 0,
      candidatesFound: 0,
      model: null,
      skipped: true,
      error: 'memories.json must be an array',
    }
  }

  const evidenceSources = buildProjectMemoryEvidence(memories)
  if (evidenceSources.length === 0) {
    return { autoFilled: 0, suggestionsCreated: 0, candidatesFound: 0, model: null, skipped: true, error: null }
  }

  const fields = database.listMemoryFields().filter((field) => (
    options.categories.includes(field.category) &&
    !field.locked &&
    (options.includeSensitive || !field.sensitive)
  ))
  if (fields.length === 0) {
    return { autoFilled: 0, suggestionsCreated: 0, candidatesFound: 0, model: null, skipped: true, error: null }
  }

  onProgress({
    phase: 'memories',
    message: `Analyzing ${evidenceSources.length} Claude memory summar${evidenceSources.length === 1 ? 'y' : 'ies'}`,
    current: 0,
    total: evidenceSources.length,
  })

  try {
    const allCandidates: MemoryCandidate[] = []
    let extractionModel: string | null = null
    let lastError: string | null = null
    let succeeded = 0

    for (let i = 0; i < evidenceSources.length; i += 1) {
      if (signal.aborted) throw new Error('Claude import cancelled')
      onProgress({
        phase: 'memories',
        message: `Analyzing memory ${i + 1}/${evidenceSources.length}`,
        current: i + 1,
        total: evidenceSources.length,
      })
      const source = evidenceSources[i]
      const stageController = new AbortController()
      const timer = setTimeout(() => stageController.abort(), MEMORY_EXTRACTION_TIMEOUT_MS)
      const onParentAbort = () => stageController.abort()
      signal.addEventListener('abort', onParentAbort, { once: true })
      try {
        const extraction = await extractMemoryCandidates(
          providerConfig,
          systemModel,
          fields,
          [source],
          stageController.signal
        )
        allCandidates.push(...extraction.candidates)
        extractionModel = extraction.model
        succeeded += 1
      } catch (error) {
        if (signal.aborted) throw error
        lastError = error instanceof Error ? error.message : 'Memory analysis failed for one source'
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onParentAbort)
      }
    }

    if (succeeded === 0 && lastError) {
      return {
        autoFilled: 0,
        suggestionsCreated: 0,
        candidatesFound: 0,
        model: null,
        skipped: true,
        error: lastError,
      }
    }

    const applied = database.applyMemoryCandidates(allCandidates)
    return {
      autoFilled: applied.autoFilled,
      suggestionsCreated: applied.suggestionsCreated,
      candidatesFound: allCandidates.length,
      model: extractionModel,
      skipped: false,
      error: succeeded < evidenceSources.length
        ? `${evidenceSources.length - succeeded} of ${evidenceSources.length} sources failed${lastError ? ` (${lastError})` : ''}`
        : null,
    }
  } catch (error) {
    if (signal.aborted) throw error
    return {
      autoFilled: 0,
      suggestionsCreated: 0,
      candidatesFound: 0,
      model: null,
      skipped: true,
      error: error instanceof Error ? error.message : 'Memory analysis failed',
    }
  }
}

export async function importClaudeData(
  directory: string,
  options: ClaudeImportOptions,
  providerConfig: ProviderConfig,
  systemModel: string,
  onProgress: (progress: ClaudeImportProgress) => void,
  signal: AbortSignal
): Promise<ClaudeImportResult> {
  const resolved = path.resolve(directory)
  let stats: fs.Stats
  try {
    stats = fs.statSync(resolved)
  } catch {
    throw new Error('Selected directory could not be read. Choose the folder exported from Claude.')
  }
  if (!stats.isDirectory()) {
    throw new Error('Selected path is not a directory. Choose the folder exported from Claude.')
  }

  const conversationsFile = path.join(resolved, 'conversations.json')
  const memoriesFile = path.join(resolved, 'memories.json')
  const projectsDir = path.join(resolved, 'projects')

  const result: ClaudeImportResult = {
    projectsImported: 0,
    projectsSkipped: 0,
    conversationsImported: 0,
    conversationsSkipped: 0,
    messagesImported: 0,
    memoryAutoFilled: 0,
    memorySuggestionsCreated: 0,
    memoryCandidatesFound: 0,
    memoryModel: null,
    memorySkipped: false,
    memoryError: null,
  }

  if (options.importProjects && fs.existsSync(projectsDir)) {
    onProgress({ phase: 'projects', message: 'Importing projects', current: 0, total: 0 })
    const projectResult = await importProjects(projectsDir, onProgress, signal)
    result.projectsImported = projectResult.imported
    result.projectsSkipped = projectResult.skipped
  }

  if (options.importConversations) {
    if (fs.existsSync(conversationsFile)) {
      const conversationResult = await importConversations(conversationsFile, onProgress, signal)
      result.conversationsImported = conversationResult.imported
      result.conversationsSkipped = conversationResult.skipped
      result.messagesImported = conversationResult.messagesImported
    } else {
      throw new Error('conversations.json was not found in the selected directory')
    }
  }

  if (options.importMemories) {
    if (!fs.existsSync(memoriesFile)) {
      result.memorySkipped = true
    } else {
      onProgress({ phase: 'finalizing', message: 'Finalizing Claude import', current: 0, total: 0 })
      const memoryResult = await importMemories(
        memoriesFile,
        options,
        providerConfig,
        systemModel,
        onProgress,
        signal
      )
      result.memoryAutoFilled = memoryResult.autoFilled
      result.memorySuggestionsCreated = memoryResult.suggestionsCreated
      result.memoryCandidatesFound = memoryResult.candidatesFound
      result.memoryModel = memoryResult.model
      result.memorySkipped = memoryResult.skipped
      result.memoryError = memoryResult.error
    }
  }

  onProgress({
    phase: 'finalizing',
    message: 'Claude import complete',
    current: 1,
    total: 1,
  })
  return result
}
