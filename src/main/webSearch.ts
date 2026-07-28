import { redactMemoryContent } from './memory'
import type {
  WebSearchDepth,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchResultItem,
  WebSearchTopic,
} from '../shared/types'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
const DEFAULT_MAX_RESULTS = 8
const MAX_ALLOWED_RESULTS = 20
const MIN_QUERY_LENGTH = 2
const MAX_QUERY_LENGTH = 1000
const MAX_RESPONSE_BYTES = 1_500_000

const DEPTH_VALUES = new Set<WebSearchDepth>(['basic', 'advanced'])
const TOPIC_VALUES = new Set<WebSearchTopic>(['general', 'news'])
const PROVIDER_VALUES = new Set<WebSearchProvider>(['tavily'])

function requiredString(value: unknown, label: string, maxLength: number, minLength = 1): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length < minLength) throw new Error(`${label} is too short`)
  if (trimmed.length > maxLength) throw new Error(`${label} is too long`)
  return trimmed
}

export function parseWebSearchRequest(value: unknown): WebSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Web search request must be an object')
  }
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).find((key) => !['query', 'maxResults', 'searchDepth', 'topic'].includes(key))
  if (unexpected) throw new Error(`Web search request contains unsupported field "${unexpected}"`)

  const query = requiredString(record.query, 'Search query', MAX_QUERY_LENGTH, MIN_QUERY_LENGTH)

  let maxResults: number | undefined
  if (record.maxResults !== undefined) {
    if (typeof record.maxResults !== 'number' || !Number.isFinite(record.maxResults)) {
      throw new Error('maxResults must be a number')
    }
    if (!Number.isInteger(record.maxResults)) throw new Error('maxResults must be a whole number')
    maxResults = Math.max(1, Math.min(record.maxResults, MAX_ALLOWED_RESULTS))
  }

  let searchDepth: WebSearchDepth | undefined
  if (record.searchDepth !== undefined) {
    if (!DEPTH_VALUES.has(record.searchDepth as WebSearchDepth)) {
      throw new Error('searchDepth must be "basic" or "advanced"')
    }
    searchDepth = record.searchDepth as WebSearchDepth
  }

  let topic: WebSearchTopic | undefined
  if (record.topic !== undefined) {
    if (!TOPIC_VALUES.has(record.topic as WebSearchTopic)) {
      throw new Error('topic must be "general" or "news"')
    }
    topic = record.topic as WebSearchTopic
  }

  return {
    query,
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(searchDepth !== undefined ? { searchDepth } : {}),
    ...(topic !== undefined ? { topic } : {}),
  }
}

function normalizeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function parseResultItem(value: unknown, index: number): WebSearchResultItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Result ${index + 1} must be an object`)
  }
  const record = value as Record<string, unknown>
  const url = normalizeExternalUrl(record.url)
  if (!url) throw new Error(`Result ${index + 1} has an invalid url`)
  const score = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : 0
  return {
    title: requiredString(record.title, `Result ${index + 1} title`, 500).slice(0, 500),
    url,
    content: requiredString(String(record.content ?? ''), `Result ${index + 1} content`, 8000, 0).slice(0, 8000),
    score,
  }
}

export function parseWebSearchResponse(
  payload: unknown,
  request: WebSearchRequest
): WebSearchResult {
  const envelope = asRecord(payload, 'Web search response')
  const rawResults = Array.isArray(envelope.results) ? envelope.results : []
  const seen = new Set<string>()
  const results: WebSearchResultItem[] = []
  for (const raw of rawResults) {
    try {
      const item = parseResultItem(raw, results.length)
      if (seen.has(item.url)) continue
      seen.add(item.url)
      results.push(item)
      if (results.length >= MAX_ALLOWED_RESULTS) break
    } catch {
      continue
    }
  }

  const answer = typeof envelope.answer === 'string' && envelope.answer.trim()
    ? envelope.answer.trim().slice(0, 4000)
    : null

  const responseTimeMs = typeof envelope.response_time === 'number' && Number.isFinite(envelope.response_time)
    ? Math.round(envelope.response_time * 1000)
    : null

  return {
    query: request.query,
    answer,
    results,
    responseTimeMs,
    searchedAt: Date.now(),
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function describeTavilyError(response: Response, bodyText: string): string {
  let detail = `HTTP ${response.status}`
  try {
    const payload = JSON.parse(bodyText)
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>
      const message = record.message
      if (typeof message === 'string' && message.trim()) {
        detail = message.trim().slice(0, 500)
      } else if (typeof record.detail === 'string' && record.detail.trim()) {
        detail = record.detail.trim().slice(0, 500)
      }
    }
  } catch {
    if (bodyText.trim()) detail = bodyText.trim().replace(/\s+/g, ' ').slice(0, 500)
  }
  return detail
}

export async function executeWebSearch(
  provider: WebSearchProvider,
  apiKey: string,
  request: WebSearchRequest,
  signal: AbortSignal
): Promise<WebSearchResult> {
  if (!PROVIDER_VALUES.has(provider)) {
    throw new Error(`Unsupported web search provider: ${provider}`)
  }
  if (!apiKey.trim()) {
    throw new Error('No web search API key configured. Add one in Settings before searching.')
  }

  const redactedQuery = redactMemoryContent(request.query)
  const maxResults = Math.max(1, Math.min(request.maxResults ?? DEFAULT_MAX_RESULTS, MAX_ALLOWED_RESULTS))
  const searchDepth: WebSearchDepth = request.searchDepth ?? 'basic'
  const topic: WebSearchTopic = request.topic ?? 'general'

  let response: Response
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        api_key: apiKey,
        query: redactedQuery,
        search_depth: searchDepth,
        topic,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
      }),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`Web search failed: ${error instanceof Error ? error.message : 'network error'}`)
  }

  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('Web search response was unexpectedly large')
  }

  const responseText = await response.text()
  if (new TextEncoder().encode(responseText).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('Web search response was unexpectedly large')
  }

  if (!response.ok) {
    const detail = describeTavilyError(response, responseText)
    throw new Error(`Web search failed: ${detail}`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw new Error('Web search provider returned an invalid response')
  }

  return parseWebSearchResponse(payload, request)
}
