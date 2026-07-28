// Records every outbound call to the connected provider.
//
// Eighteen call sites across provider.ts, llmCall.ts, timeline.ts,
// healthSummary.ts and friends each build their own `fetch` — a per-site
// recorder would have to be added to all of them and remembered for the
// nineteenth. So the record is taken one layer down, by wrapping `fetch` itself
// and logging the requests whose URL sits under the provider base URL that
// providerEndpoint.ts resolves. Everything else (Exa, Amazon, Gmail, the weather
// API) passes through untouched.
//
// Nothing here may change what a caller sees: the response handed back is the
// same bytes, and a logging failure is swallowed.
import { AsyncLocalStorage } from 'async_hooks'
import { ipcMain } from 'electron'
import * as database from './database'
import * as settings from './settings'
import { getBaseUrl } from './providerEndpoint'
import { creditBlockedError, noteProviderResponse, requestProviderCall } from './providerCredit'
import { speechBaseUrls } from './speech'
import { peekPriceTable, priceCall } from './modelPricing'
import { elideDataUrls, parseProviderResponse, type ProviderCallUsage } from '../shared/callHistory'
import type { CalledService } from '../shared/types'

/**
 * How much of each body is kept. Index runs send whole documents and base64
 * images; storing those in full would put hundreds of megabytes in the DB for a
 * page that shows the first screen of them.
 */
const MAX_REQUEST_CHARS = 100_000
const MAX_RESPONSE_CHARS = 50_000

/** Only prune every so often — one DELETE per logged call is wasted work. */
const PRUNE_EVERY = 50
let sinceLastPrune = 0

interface CallFeature {
  feature: string
}

const featureStore = new AsyncLocalStorage<CallFeature>()

/**
 * Names whatever provider calls happen inside `fn`. Async-local, so it survives
 * awaits and covers calls made several modules deep without threading a label
 * through them. A nested call wins over an outer one.
 */
export function withProviderCallFeature<T>(feature: string, fn: () => T): T {
  return featureStore.run({ feature }, fn)
}

function currentFeature(): string | null {
  return featureStore.getStore()?.feature ?? null
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof input !== 'string' && !(input instanceof URL)) return (input.method || 'GET').toUpperCase()
  return 'GET'
}

/**
 * Whether this call is one an empty account can refuse. Completions, images and
 * embeddings are POSTs; the model listing — which Settings needs to work no
 * matter what the balance is — is a GET.
 */
function spendsCredit(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const method = requestMethod(input, init)
  return method !== 'GET' && method !== 'HEAD'
}

/** A call made by an hourly tick rather than by something the user just did. */
function isAutomatedCall(): boolean {
  return currentFeature()?.startsWith('timer:') ?? false
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

interface PendingCall {
  createdAt: number
  startedAt: number
  feature: string | null
  url: string
  endpoint: string
  model: string | null
  streamed: boolean
  request: string
  /** Which service this went to; ElevenLabs bills per character, not per token. */
  provider: CalledService
  characters: number | null
}

function describePending(
  url: string,
  init: RequestInit | undefined,
  base: string,
  provider: CalledService
): PendingCall {
  const rawBody = typeof init?.body === 'string' ? init.body : ''
  let model: string | null = null
  let streamed = false
  let characters: number | null = null
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>
      // ElevenLabs names it model_id, Speechify and OpenAI-shaped providers
      // name it model.
      const named = typeof parsed.model === 'string' ? parsed.model : parsed.model_id
      model = typeof named === 'string' && named.trim() ? named : null
      streamed = parsed.stream === true
      // What speech is actually billed on: ElevenLabs sends `text`, Speechify
      // sends `input`.
      const spoken = typeof parsed.text === 'string' ? parsed.text : parsed.input
      if (typeof spoken === 'string') characters = spoken.length
    } catch {
      // Not JSON — the raw body is still worth keeping.
    }
  }
  return {
    createdAt: Date.now(),
    startedAt: Date.now(),
    feature: currentFeature(),
    url,
    endpoint: url.startsWith(base) ? url.slice(base.length) || '/' : url,
    model,
    streamed,
    request: rawBody,
    provider,
    characters,
  }
}

function priceFor(model: string | null, usage: ProviderCallUsage): {
  costUsd: number | null
  costSource: 'provider' | 'estimated' | null
} {
  if (usage.costUsd !== null) return { costUsd: usage.costUsd, costSource: 'provider' }
  if (!model) return { costUsd: null, costSource: null }
  const cost = priceCall(peekPriceTable(), model, usage.inputTokens ?? 0, usage.outputTokens ?? 0)
  return cost === null ? { costUsd: null, costSource: null } : { costUsd: cost, costSource: 'estimated' }
}

function record(
  pending: PendingCall,
  outcome: {
    status: number | null
    ok: boolean
    body: string
    contentType: string
    error: string | null
  }
): void {
  try {
    const parsed = parseProviderResponse(outcome.body, outcome.contentType)
    const model = pending.model ?? parsed.model
    const { costUsd, costSource } = priceFor(model, parsed.usage)
    const request = truncate(elideDataUrls(pending.request), MAX_REQUEST_CHARS)
    const response = truncate(elideDataUrls(parsed.text), MAX_RESPONSE_CHARS)

    database.insertProviderCall({
      createdAt: pending.createdAt,
      feature: pending.feature,
      provider: pending.provider,
      endpoint: pending.endpoint,
      url: pending.url,
      model,
      streamed: pending.streamed,
      status: outcome.status,
      ok: outcome.ok,
      durationMs: Date.now() - pending.startedAt,
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
      charCount: pending.characters,
      costUsd,
      costSource,
      request: request.text,
      requestTruncated: request.truncated,
      response: response.text,
      responseTruncated: response.truncated,
      error: outcome.error ?? parsed.error,
    })

    sinceLastPrune += 1
    if (sinceLastPrune >= PRUNE_EVERY) {
      sinceLastPrune = 0
      database.pruneProviderCalls()
    }
  } catch {
    // The history is a record of the app's work, never a reason for it to fail.
  }
}

// Reads the logging half of a teed body. Capped: an aborted 2 GB download must
// not be buffered here, and past the response cap the rest is not stored anyway.
async function drainForLog(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
      // SSE output is reassembled from the whole stream, so the cap is applied
      // to the frames rather than to the reassembled text — generously, since
      // the deltas are a fraction of their framing.
      if (text.length > MAX_RESPONSE_CHARS * 20) {
        await reader.cancel()
        break
      }
    }
  } catch {
    // Aborted or errored mid-stream: whatever arrived is what was received.
  }
  return text + decoder.decode()
}

let installed = false

/**
 * Starts recording. Called once, before the IPC handlers are registered, so
 * every call the app makes from then on lands in the history.
 */
export function installProviderCallLog(): void {
  if (installed) return
  installed = true

  installFeatureTagging()

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let base: string
    try {
      base = getBaseUrl(settings.getProvider())
    } catch {
      return originalFetch(input, init)
    }
    const url = requestUrl(input)
    // Two known services: the text provider, and ElevenLabs for narration.
    // Everything else (Exa, Amazon, Gmail, the weather API) passes through.
    let matchedBase = base && url.startsWith(base) ? base : null
    // Only the text provider is under the credit breaker: an empty OpenRouter
    // balance says nothing about the narration account, which is billed
    // separately. And only the calls that spend credit — the model listing is a
    // GET that works fine on an empty account, so it must neither be blocked
    // (the user needs Settings to work) nor counted as proof the balance is back.
    const isBilledCall = matchedBase !== null && spendsCredit(input, init)
    let provider: CalledService = settings.getProvider().type
    if (!matchedBase) {
      // The narration services, taken from the registry so a third one is
      // logged without editing this file.
      for (const speech of speechBaseUrls()) {
        if (!url.startsWith(speech.baseUrl)) continue
        matchedBase = speech.baseUrl
        provider = speech.id
        break
      }
    }
    // Everything else (Exa, Amazon, Gmail, the weather API) passes through.
    if (!matchedBase) return originalFetch(input, init)

    // The user's pause switch. The timers already refuse to start while it is
    // on; this catches the work that was already in flight when they flipped it,
    // and anything a tick left running behind a delay of its own. Never applied
    // to a call the user just asked for — the pause is about automation, not
    // about the app.
    if (isAutomatedCall() && settings.isAutomationPaused()) {
      throw new Error('Automated calls are paused. Resume them on the Call History page.')
    }

    // The whole point of the breaker: a call the provider has already refused
    // for lack of credit never leaves the machine. Enforced here rather than at
    // the eighteen call sites, for the same reason the logging is.
    if (isBilledCall && !requestProviderCall().allowed) {
      throw creditBlockedError(settings.getProvider())
    }

    const pending = describePending(url, init, matchedBase, provider)

    let response: Response
    try {
      response = await originalFetch(input, init)
    } catch (error) {
      record(pending, {
        status: null,
        ok: false,
        body: '',
        contentType: '',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    const contentType = response.headers.get('content-type') ?? ''
    // 204/304 carry no body, and handing one to `new Response` throws.
    if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
      if (isBilledCall) noteProviderResponse(response.status, '')
      record(pending, { status: response.status, ok: response.ok, body: '', contentType, error: null })
      return response
    }

    // Tee rather than clone-and-read: the caller gets its half immediately, which
    // is what keeps a streamed chat streaming instead of arriving all at once.
    const [forCaller, forLog] = response.body.tee()
    // A 2xx is proof the account is live, so the streak clears without waiting
    // for the body — which for a streamed chat is the whole conversation.
    if (isBilledCall && response.ok) noteProviderResponse(response.status, '')
    void drainForLog(forLog).then((body) => {
      // Which refusal it was is only in the body, so the failing case is read
      // there. Cheap: an error response is a few hundred bytes.
      if (isBilledCall && !response.ok) noteProviderResponse(response.status, body)
      record(pending, { status: response.status, ok: response.ok, body, contentType, error: null })
    })

    return new Response(forCaller, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * Names each call after the IPC channel it was made under, so the history reads
 * "timeline:rebuild" rather than a list of anonymous completions. Done by
 * wrapping `ipcMain.handle` once instead of by editing ~200 registrations, which
 * also means a handler added later is labelled without anyone remembering to.
 */
function installFeatureTagging(): void {
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...args: any[]) => any) =>
    originalHandle(channel, (...args: any[]) =>
      withProviderCallFeature(channel, () => listener(...args))
    )) as typeof ipcMain.handle
}
