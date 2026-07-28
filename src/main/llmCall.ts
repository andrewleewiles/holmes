// The one outbound call every context generator makes, with the spend tracking
// and retry discipline that go with it. Extracted from documentContext.ts so the
// conversation indexer can use it without the two modules importing each other.
import type { ProviderConfig } from '../shared/types'
import { priceCall, type PriceTable } from './modelPricing'
import type { RateLimiter } from './rateLimit'
import { getBaseUrl, getHeaders } from './providerEndpoint'

export type UserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

// Accumulates what a run has actually consumed, priced against the same table
// the pre-flight estimate uses so the two are directly comparable.
export interface SpendTracker {
  inputTokens: number
  outputTokens: number
  costUsd: number
  callsMade: number
  imageCalls: number
  priceTable: PriceTable
}

export function createSpendTracker(priceTable: PriceTable = new Map()): SpendTracker {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, callsMade: 0, imageCalls: 0, priceTable }
}

function recordSpend(
  tracker: SpendTracker | undefined,
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  isImage: boolean
): void {
  if (!tracker) return
  const inputTokens = Number(usage?.prompt_tokens) || 0
  const outputTokens = Number(usage?.completion_tokens) || 0
  tracker.inputTokens += inputTokens
  tracker.outputTokens += outputTokens
  tracker.callsMade += 1
  if (isImage) tracker.imageCalls += 1
  const cost = priceCall(tracker.priceTable, model, inputTokens, outputTokens, isImage ? 1 : 0)
  if (cost !== null) tracker.costUsd += cost
}

export interface CallOptions {
  maxTokens?: number
  spend?: SpendTracker
  isImage?: boolean
  limiter?: RateLimiter
  /**
   * Provider-specific `response_format`, spread into the body only when present.
   *
   * Exists so a JSON caller gets this module's retry, spend-tracking and
   * rate-limiting discipline instead of hand-rolling another fetch. Note that
   * only OpenRouter honours json_schema — callers must build the value
   * conditionally and must still parse tolerantly, because for `custom` and
   * `ollama` endpoints it is silently ignored.
   */
  responseFormat?: unknown
}

async function callLLM(
  config: ProviderConfig,
  model: string,
  systemPrompt: string,
  userPrompt: UserContent,
  signal?: AbortSignal,
  options: CallOptions = {}
): Promise<string> {
  // Pace before every attempt, retries included — a 429 retry that ignores the
  // limit is what turns a transient throttle into a run of failure rows.
  if (options.limiter) await options.limiter.acquire(signal)
  const response = await fetch(`${getBaseUrl(config)}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(config),
    signal: signal as never,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      // Generous cap: some system models (e.g. glm-4.7-flash) spend output tokens
      // on reasoning first, returning empty content if the cap is too low. The
      // long-form super-context prompts need room for both. Image calls override
      // this down hard — a photo description is a few sentences, and at photo
      //-library scale the output cap is a direct cost multiplier.
      max_tokens: options.maxTokens ?? 24000,
      temperature: 0.2,
      stream: false,
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    }),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    let detail = `HTTP ${response.status}`
    if (errorBody) {
      try {
        const parsed = JSON.parse(errorBody)
        detail = parsed.error?.message || parsed.message || errorBody
      } catch {
        detail = errorBody
      }
    }
    throw new Error(`LLM call failed: ${detail}`)
  }
  const data = await response.json()
  recordSpend(options.spend, model, data?.usage, options.isImage ?? false)
  const content: string = data?.choices?.[0]?.message?.content || ''
  return content
}

export function isTransientError(message: string): boolean {
  return /\b(429|408|409|425|5\d\d)\b|rate.?limit|timeout|timed out|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|overloaded|temporarily/i.test(message)
}

// Some fast models (e.g. glm-4.7-flash) intermittently return an empty 200 body,
// especially under concurrency. Retry empty content and transient errors with backoff.
export async function callLLMRetrying(
  config: ProviderConfig,
  model: string,
  systemPrompt: string,
  userPrompt: UserContent,
  signal?: AbortSignal,
  attempts = 3,
  options: CallOptions = {}
): Promise<string> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new Error('Document context generation cancelled')
    try {
      const raw = await callLLM(config, model, systemPrompt, userPrompt, signal, options)
      if (raw.trim()) return raw
      // Empty content — fall through to backoff and retry.
    } catch (err) {
      lastError = err
      if (signal?.aborted) throw err
      if (!isTransientError(err instanceof Error ? err.message : String(err))) throw err
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  if (lastError) throw lastError
  return ''
}
