import type { ChatAttachment, CitedSource, Message } from '@shared/types'
import type { StreamingToolInteraction } from '../store/chatStore'

/**
 * Grouping a turn back together.
 *
 * One answer is stored as several rows: the assistant message that asked for a
 * tool, a `tool` row per result, then the assistant message that finally answers.
 * Rendered one-row-per-bubble that shows as a broken-up turn — a mark and a
 * thinking block per row, and a tool call sitting far away from its own result.
 *
 * So the transcript is grouped before it is rendered: every non-user row up to the
 * next user message is one turn, and a tool result is folded into the call that
 * produced it. Nothing is dropped — a row with neither prose nor a tool call
 * contributes only its thinking, which the turn shows once for all of them.
 */

export interface ToolStep {
  /** The provider's tool_call id. Unique within a turn, and how a result finds its call. */
  id: string
  name: string
  arguments: string
  /** Absent until the result arrives, which is what `running` renders from. */
  result?: string
  /**
   * `running` is only ever a live turn. A stored call with no stored result was
   * cut off — aborted, or the app closed mid-turn — and says so rather than
   * spinning forever against a result that is never coming.
   */
  status: 'running' | 'done' | 'error' | 'interrupted'
}

/**
 * One assistant row's contribution: what it said, then what it called.
 *
 * That order is chronological — a model writes "let me look that up" before the
 * call, not after — and keeping segments separate is what lets a turn that talks
 * between two tool calls render in the order it actually happened.
 */
export interface TurnSegment {
  id: string
  content: string
  sources?: CitedSource[]
  steps: ToolStep[]
}

export interface UserTurn {
  kind: 'user'
  key: string
  message: Message
}

export interface AssistantTurn {
  kind: 'assistant'
  key: string
  segments: TurnSegment[]
  /** Every row's thinking, joined: the turn shows one disclosure, not one per row. */
  reasoning?: string
  model?: string
  createdAt: number
  attachments?: ChatAttachment[]
  /**
   * Where sibling navigation and retry anchor: the turn's FIRST row. Retrying
   * regenerates the whole answer, so the branch point is the message that hangs
   * off the user's question — the later rows are its descendants, not its siblings.
   */
  branchMessage: Message
  /** Everything the assistant said this turn, for the copy button. */
  copyText: string
}

export type Turn = UserTurn | AssistantTurn

function stepsFromMessage(message: Message, resultsByCallId: Map<string, { content: string; error?: boolean }>): ToolStep[] {
  return (message.toolCalls ?? []).map((call) => {
    const result = resultsByCallId.get(call.id)
    return {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      ...(result ? { result: result.content } : {}),
      status: !result ? 'interrupted' : result.error ? 'error' : 'done',
    } satisfies ToolStep
  })
}

function buildAssistantTurn(group: Message[]): AssistantTurn | null {
  if (group.length === 0) return null

  const resultsByCallId = new Map<string, { content: string; error?: boolean }>()
  for (const message of group) {
    if (message.role === 'tool' && message.toolCallId) {
      resultsByCallId.set(message.toolCallId, { content: message.content, error: message.toolError })
    }
  }

  const spoken = group.filter((message) => message.role !== 'tool')
  const anchor = spoken[0] ?? group[0]
  const last = spoken[spoken.length - 1] ?? group[group.length - 1]

  const segments: TurnSegment[] = []
  for (const message of spoken) {
    const steps = stepsFromMessage(message, resultsByCallId)
    if (!message.content && steps.length === 0) continue
    segments.push({
      id: message.id,
      content: message.content,
      ...(message.sources ? { sources: message.sources } : {}),
      steps,
    })
  }

  const reasoning = spoken.map((message) => message.reasoning).filter(Boolean).join('\n\n')
  const attachments = spoken.flatMap((message) => message.attachments ?? [])
  const copyText = spoken.map((message) => message.content).filter(Boolean).join('\n\n')

  return {
    kind: 'assistant',
    key: anchor.id,
    segments,
    ...(reasoning ? { reasoning } : {}),
    ...(last.model ? { model: last.model } : {}),
    createdAt: last.createdAt,
    ...(attachments.length > 0 ? { attachments } : {}),
    branchMessage: anchor,
    copyText,
  }
}

export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'user') {
      turns.push({ kind: 'user', key: message.id, message })
      index += 1
      continue
    }

    const group: Message[] = []
    while (index < messages.length && messages[index].role !== 'user') {
      group.push(messages[index])
      index += 1
    }
    const turn = buildAssistantTurn(group)
    if (turn) turns.push(turn)
  }

  return turns
}

/**
 * The same shape from the live stream, where calls and results arrive as separate
 * events. Pairing them here is what lets one row render a call that is still
 * running and the same row show its result a moment later, instead of the two
 * appearing as unrelated entries.
 */
export function toolStepsFromInteractions(interactions: StreamingToolInteraction[]): ToolStep[] {
  const steps: ToolStep[] = []
  const byId = new Map<string, ToolStep>()

  for (const interaction of interactions) {
    if (interaction.type === 'call' && interaction.toolCall) {
      const call = interaction.toolCall
      const step: ToolStep = { id: call.id, name: call.name, arguments: call.arguments, status: 'running' }
      byId.set(call.id, step)
      steps.push(step)
      continue
    }
    if (interaction.type === 'result' && interaction.toolResult) {
      const result = interaction.toolResult
      const status = result.error ? 'error' : 'done'
      const existing = byId.get(result.callId)
      if (existing) {
        existing.result = result.content
        existing.status = status
        continue
      }
      // A result whose call was never announced still gets a row, so the work is
      // visible rather than swallowed.
      const step: ToolStep = { id: result.callId, name: result.name, arguments: '', result: result.content, status }
      byId.set(result.callId, step)
      steps.push(step)
    }
  }

  return steps
}

/**
 * The in-flight turn as a turn like any other, so one component renders both.
 *
 * Two segments rather than one: the steps land above the prose, which is the order
 * a turn actually unfolds in and the order the finished turn will render in once
 * the rows are grouped.
 */
export function streamingSegments(text: string, steps: ToolStep[], sources?: CitedSource[]): TurnSegment[] {
  const segments: TurnSegment[] = []
  if (steps.length > 0) segments.push({ id: 'streaming-steps', content: '', steps })
  segments.push({ id: 'streaming-text', content: text, ...(sources ? { sources } : {}), steps: [] })
  return segments
}
