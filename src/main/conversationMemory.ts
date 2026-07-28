import type { ProviderConfig, MemoryCandidate, MemorySource, MemoryValueType } from '../shared/types'
import { getAssistantName } from '../shared/assistantIdentity'
import * as database from './database'
import { extractMemoryCandidates } from './provider'
import type { ParsedNewField, MemoryEvidenceSource } from './memory'
import { validateMemoryValue } from './memory'

const MAX_CONVERSATION_CHARS = 24_000
const IDLE_THRESHOLD_MS = 5 * 60 * 60 * 1000

interface ConversationExtractionResult {
  autoFilled: number
  suggestionsCreated: number
  candidatesFound: number
  newFieldsCreated: number
  model: string | null
  error: string | null
}

export function getIdleConversations(): database.IdleConversation[] {
  return database.listIdleConversations(IDLE_THRESHOLD_MS)
}

// A conversation filed under a separate-context project is off-limits to memory:
// that is the whole point of marking a project separate. Checked here rather
// than only at the call site, so no future caller can route around it.
function isSeparateContextConversation(conversationId: string): boolean {
  return database.listSeparateContextConversationIds().includes(conversationId)
}

export async function extractConversationMemory(
  conversationId: string,
  providerConfig: ProviderConfig,
  systemModel: string,
  signal: AbortSignal
): Promise<ConversationExtractionResult> {
  if (isSeparateContextConversation(conversationId)) {
    return {
      autoFilled: 0,
      suggestionsCreated: 0,
      candidatesFound: 0,
      newFieldsCreated: 0,
      model: null,
      error: 'This conversation belongs to a project kept separate from the life context, so memory does not read it',
    }
  }

  const messages = database.getMessages(conversationId)
  const conversationMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant')

  let totalChars = 0
  const turns: string[] = []
  for (const msg of conversationMessages) {
    const prefix = msg.role === 'user' ? 'User' : getAssistantName()
    const text = `${prefix}: ${msg.content}`
    if (totalChars + text.length > MAX_CONVERSATION_CHARS) {
      const remaining = MAX_CONVERSATION_CHARS - totalChars
      if (remaining > 200) {
        turns.push(`${prefix}: ${msg.content.slice(0, remaining - 20)}\n...[truncated]`)
        totalChars += remaining
      }
      break
    }
    turns.push(text)
    totalChars += text.length
  }

  if (turns.length === 0) {
    return {
      autoFilled: 0,
      suggestionsCreated: 0,
      candidatesFound: 0,
      newFieldsCreated: 0,
      model: null,
      error: 'No user or assistant messages found',
    }
  }

  const sources: MemoryEvidenceSource[] = [{
    id: 'source-1',
    type: 'conversation',
    reference: conversationId,
    label: `Conversation: ${database.listConversations().find((c) => c.id === conversationId)?.title || 'Untitled'}`,
    capturedAt: Date.now(),
    content: turns.join('\n\n'),
  }]

  const fields = database.listMemoryFields().filter((f) => !f.locked)

  try {
    const extraction = await extractMemoryCandidates(
      providerConfig,
      systemModel,
      fields,
      sources,
      signal,
      { allowCustomFields: true }
    )

    if (signal.aborted) throw new Error('Memory extraction cancelled')

    const allCandidates: MemoryCandidate[] = [...extraction.candidates]

    let newFieldsCreated = 0
    for (const newField of extraction.newFields) {
      if (signal.aborted) break
      try {
        const created = database.createMemoryField({
          category: newField.category,
          label: newField.label,
          valueType: newField.valueType,
          sensitive: false,
        })
        const createdField = created.find((f) => f.label === newField.label && f.category === newField.category)
        if (createdField) {
          allCandidates.push({
            fieldKey: createdField.fieldKey,
            value: newField.value,
            confidence: newField.confidence,
            rationale: newField.rationale,
            sources: newField.sources,
            mergeStrategy: 'replace',
          })
          newFieldsCreated += 1
        }
      } catch {
        // Skip fields that fail to create (e.g., duplicate label)
      }
    }

    const applied = database.applyMemoryCandidates(allCandidates)
    database.updateConversationMemoryExtractedAt(conversationId)

    return {
      autoFilled: applied.autoFilled,
      suggestionsCreated: applied.suggestionsCreated,
      candidatesFound: allCandidates.length,
      newFieldsCreated,
      model: extraction.model,
      error: null,
    }
  } catch (error) {
    if (signal.aborted) throw error
    return {
      autoFilled: 0,
      suggestionsCreated: 0,
      candidatesFound: 0,
      newFieldsCreated: 0,
      model: null,
      error: error instanceof Error ? error.message : 'Memory extraction failed',
    }
  }
}
