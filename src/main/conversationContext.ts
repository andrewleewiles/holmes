// A conversation is a source like any other: it gets summarized into a context
// that belongs to the project(s) the conversation is filed under, and that
// context feeds the project's super-context the same way a folder root does.
//
// The summary is written once per conversation and shared by every project it
// belongs to — the transcript does not change per project — and it is keyed on a
// hash of the messages, so re-indexing an untouched conversation costs nothing.
import crypto from 'crypto'
import type { ContextProvenance, IndexStyle, ProviderConfig } from '../shared/types'
import * as database from './database'
import { redactMemoryContent } from './memory'
import { callLLMRetrying, type CallOptions } from './llmCall'
import { hasProviderCredentials, missingCredentialsError } from './providerEndpoint'
import { normalizeIndexStyle, styleConversationPrompt, styleVersion } from './indexStyles'
import { getAssistantName } from '../shared/assistantIdentity'

export const CONVERSATION_PROMPT_VERSION = 'v2-conversation-people'

const MAX_TRANSCRIPT_CHARS = 40_000
const MAX_CONTEXT_CHARS = 9_000
const MAX_SHORT_CHARS = 300

export interface ConversationContextResult {
  conversationId: string
  outcome: 'generated' | 'cached' | 'empty' | 'skipped'
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function firstSentence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^.*?[.!?](\s|$)/)
  return (match?.[0] ?? trimmed.slice(0, MAX_SHORT_CHARS)).trim().slice(0, MAX_SHORT_CHARS)
}

// The transcript as the model sees it: redacted, speaker-labelled, and cut at
// the input budget from the START rather than the end — the tail of a long
// conversation is where its conclusions are.
export function buildConversationTranscript(conversationId: string): { text: string; turns: number } {
  const messages = database
    .getMessages(conversationId)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
  if (messages.length === 0) return { text: '', turns: 0 }

  const assistantName = getAssistantName()
  const lines = messages.map((message) => {
    const speaker = message.role === 'user' ? 'You' : assistantName
    return `${speaker}: ${message.content}`
  })

  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (used + line.length > MAX_TRANSCRIPT_CHARS) {
      kept.unshift('…[earlier turns omitted]')
      break
    }
    kept.unshift(line)
    used += line.length
  }

  return { text: redactMemoryContent(kept.join('\n\n')), turns: messages.length }
}

/**
 * Summarizes one conversation into a stored context. Hash-gated: an unchanged
 * transcript under an unchanged prompt returns the cached row untouched.
 */
export async function generateConversationContext(
  conversationId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  options: { style?: IndexStyle; force?: boolean } & CallOptions = {}
): Promise<ConversationContextResult> {
  if (!hasProviderCredentials(config)) throw missingCredentialsError(config)
  if (!model.trim()) throw new Error('No text model configured for this tier')

  const conversation = database.listConversations().find((entry) => entry.id === conversationId)
  if (!conversation) return { conversationId, outcome: 'skipped' }

  const { text, turns } = buildConversationTranscript(conversationId)
  // A conversation with nothing said in it has nothing to summarize, and a
  // single opening line is not yet a source.
  if (!text.trim() || turns < 2) return { conversationId, outcome: 'empty' }

  const style = normalizeIndexStyle(options.style)
  const promptVersion = styleVersion(CONVERSATION_PROMPT_VERSION, style)
  const messageHash = hashString(`${promptVersion}\n${text}`)

  const existing = database.getConversationContext(conversationId)
  if (!options.force && existing && existing.messageHash === messageHash) {
    return { conversationId, outcome: 'cached' }
  }

  const startedOn = new Date(conversation.createdAt).toISOString().slice(0, 10)
  const raw = await callLLMRetrying(
    config,
    model,
    styleConversationPrompt(style),
    `Conversation: ${conversation.title}\nStarted: ${startedOn}\nTurns: ${turns}\n\n--- TRANSCRIPT ---\n${text}`,
    signal,
    3,
    { spend: options.spend, limiter: options.limiter }
  )

  const context = raw.trim().slice(0, MAX_CONTEXT_CHARS)
  if (!context) return { conversationId, outcome: 'empty' }

  const provenance: ContextProvenance = {
    promptVersion,
    model,
    generatedAt: new Date().toISOString(),
    sources: [{
      kind: 'conversation',
      ref: `conversation:${conversationId}`,
      label: conversation.title,
      hash: messageHash,
      included: true,
    }],
    unrecordedCount: 0,
    omittedCount: 0,
    leafCount: 1,
    inputChars: text.length,
    truncated: text.includes('…[earlier turns omitted]'),
  }

  database.upsertConversationContext({
    conversationId,
    messageHash,
    contextShort: firstSentence(context),
    context,
    provenance,
  })
  return { conversationId, outcome: 'generated' }
}

/**
 * Every conversation filed under a project, summarized. Sequential on purpose:
 * these share the index run's rate limit with the file passes.
 */
export async function generateProjectConversationContexts(
  projectId: string,
  config: ProviderConfig,
  model: string,
  signal?: AbortSignal,
  sendProgress?: (progress: { current: number; total: number; title: string }) => void,
  options: { force?: boolean } & CallOptions = {}
): Promise<{ generated: number; cached: number; skipped: number }> {
  const project = database.getProjectById(projectId)
  const style = normalizeIndexStyle(project?.indexStyle)
  const conversationIds = database.listProjectConversationIds(projectId)

  let generated = 0
  let cached = 0
  let skipped = 0
  for (let index = 0; index < conversationIds.length; index += 1) {
    if (signal?.aborted) break
    const conversationId = conversationIds[index]
    sendProgress?.({ current: index + 1, total: conversationIds.length, title: conversationId })
    try {
      const result = await generateConversationContext(conversationId, config, model, signal, { ...options, style })
      if (result.outcome === 'generated') generated += 1
      else if (result.outcome === 'cached') cached += 1
      else skipped += 1
    } catch (error) {
      if (signal?.aborted) break
      // One unreadable conversation must not fail the project's index run.
      skipped += 1
    }
  }
  return { generated, cached, skipped }
}
