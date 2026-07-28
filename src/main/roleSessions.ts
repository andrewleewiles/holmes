// A role-led conversation is a session, and a session gets written up.
//
// When a conversation whose role carries a `sessionAnalysis` spec goes quiet,
// this module reads the transcript and produces the formal note for it: stored
// structured in `role_session_notes`, archived through `context_versions` like
// every other generated context, harvested onto the timeline through its
// TIMELINE block, and — when the role's project has a directory — written out as
// a markdown file so the document indexer folds it into the profile.
//
// Hash-gated on the transcript plus `ROLE_PROMPT_VERSION`, so re-running over an
// untouched conversation costs nothing and a continued session is re-analysed
// whole rather than appended to.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ProviderConfig, RoleSessionNote } from '../shared/types'
import { getAssistantName } from '../shared/assistantIdentity'
import { getRole, parseSessionNote, renderSessionNoteMarkdown, ROLE_PROMPT_VERSION, type RoleDefinition } from '../shared/roles'
import { extractTimelineBlock } from '../shared/timeline'
import * as database from './database'
import { buildConversationTranscript } from './conversationContext'
import { redactMemoryContent } from './memory'
import { callLLMRetrying, type CallOptions } from './llmCall'
import { hasProviderCredentials, missingCredentialsError } from './providerEndpoint'

const MAX_NOTE_CHARS = 24_000

export interface RoleSessionNoteResult {
  conversationId: string
  outcome: 'generated' | 'cached' | 'empty' | 'skipped'
  note?: RoleSessionNote
  /** Why a `skipped` result was skipped, for the UI to show. */
  reason?: string
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/**
 * Where the note is filed. A conversation already filed under the role's project
 * keeps that filing; otherwise the built-in project the role names is used, and
 * failing that the conversation's own head project.
 */
function resolveNoteProject(conversationId: string, role: RoleDefinition): { id: string; name: string; path: string | null } | null {
  const wantedName = role.sessionAnalysis?.projectName
  const projects = database.listProjects()
  const memberIds = new Set(database.listConversationProjectIds(conversationId))

  const byMembershipAndName = projects.find((project) => memberIds.has(project.id) && project.name === wantedName)
  const byName = projects.find((project) => project.name === wantedName)
  const byMembership = projects.find((project) => memberIds.has(project.id))
  const project = byMembershipAndName ?? byName ?? byMembership ?? null
  return project ? { id: project.id, name: project.name, path: project.path } : null
}

function noteFileName(role: RoleDefinition, sessionDate: string, conversationId: string): string {
  const slug = role.sessionAnalysis?.fileSlug ?? 'session'
  return `${sessionDate}_${slug}_${conversationId.slice(0, 8)}.md`
}

/**
 * Writes the note beside the project's other documents. Best-effort by design:
 * the structured row is the record, and a Psychology project with no directory
 * set must not cost the user their session note.
 */
function writeNoteFile(input: {
  role: RoleDefinition
  project: { id: string; path: string | null }
  markdown: string
  sessionDate: string
  conversationId: string
  previousPath: string | null
}): string | null {
  if (!input.project.path) return null
  let directory: string
  try {
    directory = path.resolve(input.project.path)
    if (!fs.statSync(directory).isDirectory()) return null
  } catch {
    return null
  }

  // Re-analysing a session rewrites the file it already owns rather than
  // littering the folder with one note per regeneration.
  const target = input.previousPath && path.dirname(input.previousPath) === directory
    ? input.previousPath
    : path.join(directory, noteFileName(input.role, input.sessionDate, input.conversationId))

  try {
    fs.writeFileSync(target, input.markdown, { encoding: 'utf-8', mode: 0o600 })
  } catch {
    return null
  }

  try {
    const files = database.getProjectById(input.project.id)?.files ?? []
    if (!files.includes(target)) database.addProjectFile(input.project.id, target)
  } catch {
    // The note is written; registering it with the project is best-effort.
  }
  return target
}

/**
 * Produces the session note for one conversation. Returns `skipped` when the
 * conversation has no role, its role writes no note, or it is too short to be a
 * session — none of which are errors.
 */
export async function generateRoleSessionNote(
  conversationId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  options: { force?: boolean } & CallOptions = {}
): Promise<RoleSessionNoteResult> {
  const conversation = database.listConversations().find((entry) => entry.id === conversationId)
  if (!conversation) return { conversationId, outcome: 'skipped', reason: 'Conversation not found' }

  const role = getRole(conversation.roleId)
  const spec = role?.sessionAnalysis
  if (!role || !spec) {
    return { conversationId, outcome: 'skipped', reason: 'This conversation has no role that produces a session note' }
  }

  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No text model configured for this tier')

  const { text, turns } = buildConversationTranscript(conversationId)
  if (!text.trim() || turns < spec.minTurns) {
    return { conversationId, outcome: 'skipped', reason: `A session note needs at least ${spec.minTurns} turns` }
  }

  const messageHash = hashString(`${ROLE_PROMPT_VERSION}\n${role.id}\n${text}`)
  if (!options.force && database.getRoleSessionNoteHash(conversationId) === messageHash) {
    return { conversationId, outcome: 'cached' }
  }

  const sessionDate = new Date(conversation.createdAt).toISOString().slice(0, 10)
  const raw = await callLLMRetrying(
    config,
    model,
    spec.systemPrompt,
    `Session date: ${sessionDate}\nConversation title: ${conversation.title}\nTurns: ${turns}\n\n--- TRANSCRIPT ---\n${text}`,
    signal,
    3,
    { spend: options.spend, limiter: options.limiter }
  )

  // A vision or text model can echo material straight out of the transcript, so
  // the note goes through the same redaction the transcript did before storage.
  const content = redactMemoryContent(raw.trim()).slice(0, MAX_NOTE_CHARS)
  const parsed = parseSessionNote(content, spec.sections)
  if (!parsed) return { conversationId, outcome: 'empty' }

  const project = resolveNoteProject(conversationId, role)
  const existing = database.getRoleSessionNote(conversationId)
  const generatedAt = new Date()

  const markdown = renderSessionNoteMarkdown({
    role,
    note: parsed,
    conversationTitle: conversation.title,
    conversationId,
    sessionDate,
    generatedAt: generatedAt.toISOString(),
    model,
    turns,
    assistantName: getAssistantName(),
    timelineBlock: extractTimelineBlock(content),
  })

  const filePath = project
    ? writeNoteFile({
        role,
        project,
        markdown,
        sessionDate,
        conversationId,
        previousPath: existing?.filePath ?? null,
      })
    : null

  database.upsertRoleSessionNote({
    conversationId,
    roleId: role.id,
    projectId: project?.id ?? null,
    sessionDate,
    messageHash,
    model,
    title: parsed.title,
    summary: parsed.summary,
    risk: parsed.risk,
    sections: parsed.sections,
    content,
    turns,
    filePath,
    sourceLabel: `${role.name} session · ${conversation.title}`,
  })

  return { conversationId, outcome: 'generated', note: database.getRoleSessionNote(conversationId) ?? undefined }
}

/** Conversations whose role writes a note. Used to scope the background pass. */
export function conversationIdsWithSessionRoles(candidateIds: string[]): string[] {
  const conversations = database.listConversations()
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  return candidateIds.filter((id) => Boolean(getRole(byId.get(id)?.roleId)?.sessionAnalysis))
}

const MAX_CONTEXT_NOTES = 12
const MAX_CONTEXT_NOTE_CHARS = 1_400

/**
 * The block of prior session notes handed to a later session and to the
 * psychology analysis. Newest first, summaries only past the first few — a
 * therapist re-reads the last session closely and the older ones in outline.
 */
export function buildSessionNotesContext(options: { projectId?: string; maxChars?: number } = {}): string {
  const notes = database.listRoleSessionNotes({ projectId: options.projectId, limit: MAX_CONTEXT_NOTES })
  if (notes.length === 0) return ''

  const maxChars = options.maxChars ?? 12_000
  const lines: string[] = []
  let used = 0
  let included = 0

  for (const note of notes) {
    const role = getRole(note.roleId)
    const header = `### ${note.sessionDate} — ${note.title} (${role?.name ?? note.roleId}, ${note.turns} turns, risk: ${note.risk})`
    // The most recent sessions carry their full structure; older ones are the
    // summary line only, so continuity survives without eating the budget.
    const body = included < 3
      ? note.sections
          .map((section) => `${section.heading}: ${section.body.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTEXT_NOTE_CHARS)}`)
          .join('\n')
      : note.summary.replace(/\s+/g, ' ').trim()
    const entry = `${header}\n${body}`
    if (used + entry.length > maxChars) {
      lines.push(`[${notes.length - included} earlier session note${notes.length - included === 1 ? '' : 's'} omitted for length.]`)
      break
    }
    lines.push(entry)
    used += entry.length
    included += 1
  }

  return lines.join('\n\n')
}
