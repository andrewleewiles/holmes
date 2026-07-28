// Reading a provider response back into "what came out of this call".
//
// Kept here, import-free, because the recorder in src/main/callLog.ts sits in
// the fetch layer where a mistake breaks every call the app makes — so the part
// with the parsing in it is a leaf module that a test can load on its own.

export interface ProviderCallUsage {
  inputTokens: number | null
  outputTokens: number | null
  /** What the provider says it charged. OpenRouter reports this; nobody else does. */
  costUsd: number | null
}

export interface ParsedProviderResponse {
  /** The assistant text, or the raw body when there is no message in it. */
  text: string
  model: string | null
  usage: ProviderCallUsage
  error: string | null
}

export const EMPTY_USAGE: ProviderCallUsage = { inputTokens: null, outputTokens: null, costUsd: null }

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function extractUsage(usage: unknown): ProviderCallUsage {
  if (!usage || typeof usage !== 'object') return EMPTY_USAGE
  const record = usage as Record<string, unknown>
  const input = Number(record.prompt_tokens ?? record.promptTokens ?? record.input_tokens)
  const output = Number(record.completion_tokens ?? record.completionTokens ?? record.output_tokens)
  const cost = Number(record.cost)
  return {
    inputTokens: Number.isFinite(input) ? input : null,
    outputTokens: Number.isFinite(output) ? output : null,
    costUsd: Number.isFinite(cost) ? cost : null,
  }
}

/**
 * Photo indexing sends a downscaled JPEG inline and image generation sends one
 * back. Stored verbatim the payload would be the whole record, so it is named
 * and dropped — the prompt around it is the part worth reading.
 */
export function elideDataUrls(text: string): string {
  return text
    .replace(
      /data:([\w./+-]+);base64,[A-Za-z0-9+/=]{200,}/g,
      (match, mime: string) => `data:${mime};base64,[${Math.round(match.length / 1024)} KB elided]`
    )
    // A speech response is a bare base64 string under `audio_base64`, not a
    // data: URL — several megabytes per call, and completely unreadable. Without
    // this the history would carry an entire audiobook.
    .replace(
      /"(audio_base64|audio)"\s*:\s*"[A-Za-z0-9+/=]{200,}"/g,
      (match, field: string) => `"${field}":"[${Math.round(match.length / 1024)} KB of audio elided]"`
    )
}

// A message's content is a string for text calls and an array of parts for
// vision ones.
export function renderMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (record.type === 'text') return readString(record.text) ?? ''
      if (record.type === 'image_url') {
        const url = (record.image_url as { url?: unknown } | undefined)?.url
        if (typeof url === 'string' && url.startsWith('data:')) {
          const mime = /^data:([^;]+);/.exec(url)?.[1] ?? 'image'
          return `[${mime}, ${Math.round(url.length / 1024)} KB inline]`
        }
        return `[image ${typeof url === 'string' ? url : ''}]`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as Record<string, unknown>
  const content = renderMessageContent(record.content)
  if (content.trim()) return content
  // A reasoning model can spend a whole call on reasoning and return no
  // content; showing nothing there would misreport the call as empty.
  const reasoning = readString(record.reasoning)
  if (reasoning) return reasoning
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
    return record.tool_calls
      .map((call) => {
        const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function
        return `[tool call] ${readString(fn?.name) ?? 'unknown'}(${readString(fn?.arguments) ?? ''})`
      })
      .join('\n')
  }
  return ''
}

export function parseJsonProviderResponse(body: string): ParsedProviderResponse {
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return { text: body, model: null, usage: EMPTY_USAGE, error: null }
  }
  if (!payload || typeof payload !== 'object') {
    return { text: body, model: null, usage: EMPTY_USAGE, error: null }
  }
  const record = payload as Record<string, unknown>
  const errorField = record.error
  const error =
    errorField && typeof errorField === 'object'
      ? readString((errorField as Record<string, unknown>).message)
      : readString(errorField)

  const choices = Array.isArray(record.choices) ? record.choices : []
  const text = messageText((choices[0] as { message?: unknown } | undefined)?.message)

  return {
    // Nothing to show (a model listing, an error payload, an image response) —
    // the raw body is more honest than an empty cell.
    text: text || body,
    model: readString(record.model),
    usage: extractUsage(record.usage),
    error: error ?? null,
  }
}

/**
 * A streamed completion arrives as `data:` frames carrying deltas. Replaying
 * them is what lets a streamed call's output be read next to a non-streamed
 * one, instead of as a screenful of SSE framing.
 */
export function parseSseProviderResponse(body: string): ParsedProviderResponse {
  let text = ''
  let reasoning = ''
  let model: string | null = null
  let usage = EMPTY_USAGE
  let error: string | null = null
  const toolCalls: string[] = []

  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) continue
    const data = trimmed.slice(6)
    if (data === '[DONE]') continue
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    if (typeof parsed?.model === 'string') model = parsed.model
    if (parsed?.usage) usage = extractUsage(parsed.usage)
    if (parsed?.error) error = readString(parsed.error?.message) ?? readString(parsed.error) ?? error
    const choice = parsed?.choices?.[0]
    if (!choice) continue
    if (typeof choice.delta?.content === 'string') text += choice.delta.content
    if (typeof choice.delta?.reasoning === 'string') reasoning += choice.delta.reasoning
    if (Array.isArray(choice.delta?.tool_calls)) {
      for (const call of choice.delta.tool_calls) {
        const name = readString(call?.function?.name)
        if (name) toolCalls.push(name)
      }
    }
  }

  const parts = [text.trim() || reasoning.trim()]
  if (toolCalls.length > 0) parts.push(`[tool calls] ${[...new Set(toolCalls)].join(', ')}`)
  return { text: parts.filter(Boolean).join('\n\n') || body, model, usage, error }
}

export function looksLikeSse(contentType: string, body: string): boolean {
  return contentType.includes('text/event-stream') || body.startsWith('data: ')
}

export function parseProviderResponse(body: string, contentType: string): ParsedProviderResponse {
  if (!body) return { text: '', model: null, usage: EMPTY_USAGE, error: null }
  return looksLikeSse(contentType, body) ? parseSseProviderResponse(body) : parseJsonProviderResponse(body)
}

/** Per-call costs are fractions of a cent; the usual two decimals would read $0.00. */
export function formatCallCost(cost: number | null): string {
  if (cost === null) return '—'
  if (cost === 0) return '$0'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

export function formatTotalCost(cost: number): string {
  if (cost === 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}
