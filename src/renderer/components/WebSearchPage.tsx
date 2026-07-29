import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowUpRightFromSquare,
  faGlobe,
  faLightbulb,
  faMagnifyingGlass,
  faNewspaper,
  faSpinner,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons'
import type { WebSearchDepth, WebSearchResult, WebSearchTopic } from '@shared/types'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'

interface WebSearchPageProps {
  enabled: boolean
  apiKeyConfigured: boolean
  pendingQuery?: string
  onConsumePendingQuery?: () => void
  onOpenExternal: (url: string) => Promise<void>
  onOpenSettings?: () => void
}

const MISSING_WEBSEARCH_BRIDGE =
  'Web Search is not loaded in the current Electron session. Fully quit and reopen Holmes to load the updated preload bridge.'

interface CachedWebSearchState {
  query: string
  topic: WebSearchTopic
  depth: WebSearchDepth
  maxResults: number
  result: WebSearchResult | null
}

let cachedWebSearchState: CachedWebSearchState = {
  query: '',
  topic: 'general',
  depth: 'basic',
  maxResults: 8,
  result: null,
}

function readableError(error: unknown): string {
  if (!(error instanceof Error)) return 'Web search failed'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export const WebSearchPage: FC<WebSearchPageProps> = ({
  enabled,
  apiKeyConfigured,
  pendingQuery,
  onConsumePendingQuery,
  onOpenExternal,
  onOpenSettings,
}) => {
  const [query, setQuery] = useState(cachedWebSearchState.query)
  const [topic, setTopic] = useState<WebSearchTopic>(cachedWebSearchState.topic)
  const [depth, setDepth] = useState<WebSearchDepth>(cachedWebSearchState.depth)
  const [maxResults, setMaxResults] = useState<number>(cachedWebSearchState.maxResults)
  const [searching, setSearching] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WebSearchResult | null>(cachedWebSearchState.result)
  const searchingRef = useRef(false)
  const cancelRequestedRef = useRef(false)

  useEffect(() => () => {
    const websearch = window.electronAPI.websearch
    if (searchingRef.current && websearch) void websearch.abort()
  }, [])

  useEffect(() => {
    cachedWebSearchState = { query, topic, depth, maxResults, result }
  }, [query, topic, depth, maxResults, result])

  useEffect(() => {
    if (pendingQuery && pendingQuery.trim()) {
      setQuery(pendingQuery.trim())
      onConsumePendingQuery?.()
      setError(null)
      void performSearch(pendingQuery.trim())
    }
  }, [pendingQuery])

  const performSearch = async (overrideQuery?: string) => {
    const trimmedQuery = (overrideQuery ?? query).trim()
    if (!trimmedQuery || searching) return
    const websearch = window.electronAPI.websearch
    if (!websearch) {
      setError(MISSING_WEBSEARCH_BRIDGE)
      return
    }
    if (!enabled || !apiKeyConfigured) {
      setError('Web search is disabled or has no API key. Configure it in Settings first.')
      return
    }

    setSearching(true)
    searchingRef.current = true
    cancelRequestedRef.current = false
    setCancelling(false)
    setError(null)
    setResult(null)

    try {
      const searchResult = await websearch.search({
        query: trimmedQuery,
        maxResults,
        searchDepth: depth,
        topic,
      })
      setResult(searchResult)
    } catch (searchError) {
      if (!cancelRequestedRef.current) setError(readableError(searchError))
    } finally {
      searchingRef.current = false
      setSearching(false)
      setCancelling(false)
    }
  }

  const cancel = () => {
    const websearch = window.electronAPI.websearch
    if (!websearch) {
      setError(MISSING_WEBSEARCH_BRIDGE)
      return
    }
    cancelRequestedRef.current = true
    setCancelling(true)
    void websearch.abort()
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faGlobe} className={PAGE_HEADER_ICON} />}
        title="Web Search"
      />

      <div className="mx-auto w-full max-w-5xl p-6 sm:p-8">
        <p className="mb-6 max-w-2xl text-xs leading-relaxed text-white/40">
          Search the public web via Tavily. The assistant can also call this autonomously during chat once enabled in Settings.
        </p>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface">
          <div className="border-b border-white/[0.06] p-5">
            <label htmlFor="websearch-query" className="mb-2 block text-xs font-medium text-white/65">
              Search query
            </label>
            <div className="relative">
              <textarea
                id="websearch-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void performSearch()
                  }
                }}
                maxLength={1000}
                rows={3}
                disabled={searching}
                placeholder="Example: latest stable version of Electron, what changed in macOS Tahoe privacy permissions..."
                className="w-full resize-none rounded-xl border border-white/10 bg-black/15 py-3 pl-11 pr-4 text-sm leading-relaxed text-white/85 outline-none placeholder:text-white/25 focus:border-holmes-primary/45 disabled:opacity-50"
              />
              <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-4 top-4 text-sm text-holmes-primary/70" />
            </div>
          </div>

          <div className="border-b border-white/[0.06] p-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Topic</span>
                <select
                  value={topic}
                  onChange={(event) => setTopic(event.target.value as WebSearchTopic)}
                  disabled={searching}
                  className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none focus:border-holmes-primary/40 disabled:opacity-50"
                >
                  <option value="general">General</option>
                  <option value="news">News (recent)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Search depth</span>
                <select
                  value={depth}
                  onChange={(event) => setDepth(event.target.value as WebSearchDepth)}
                  disabled={searching}
                  className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none focus:border-holmes-primary/40 disabled:opacity-50"
                >
                  <option value="basic">Basic (faster)</option>
                  <option value="advanced">Advanced (deeper)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">
                  Max results · {maxResults}
                </span>
                <input
                  type="range"
                  min="1"
                  max="20"
                  value={maxResults}
                  disabled={searching}
                  onChange={(event) => setMaxResults(Number(event.target.value))}
                  className="mt-2 h-1 w-full accent-holmes-primary"
                  aria-label="Maximum results"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
              {searching ? (
                <button
                  onClick={cancel}
                  disabled={cancelling}
                  className="rounded-lg border border-red-300/20 bg-red-400/10 px-4 py-2 text-xs font-medium text-red-200/75 transition-colors hover:bg-red-400/15 disabled:opacity-50 cursor-pointer"
                >
                  {cancelling ? 'Cancelling...' : 'Cancel search'}
                </button>
              ) : (
                <button
                  onClick={() => void performSearch()}
                  disabled={!query.trim() || !enabled || !apiKeyConfigured}
                  className="flex items-center gap-2 rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <FontAwesomeIcon icon={faMagnifyingGlass} />
                  Search the web
                </button>
              )}
              {!enabled && (
                <button
                  onClick={onOpenSettings}
                  className="rounded-lg border border-holmes-primary/25 bg-holmes-primary/[0.06] px-3 py-2 text-xs text-holmes-primary-light transition-colors hover:bg-holmes-primary/[0.12] cursor-pointer"
                >
                  Enable in Settings
                </button>
              )}
              {enabled && !apiKeyConfigured && (
                <button
                  onClick={onOpenSettings}
                  className="rounded-lg border border-holmes-primary/25 bg-holmes-primary/[0.06] px-3 py-2 text-xs text-holmes-primary-light transition-colors hover:bg-holmes-primary/[0.12] cursor-pointer"
                >
                  Add API key in Settings
                </button>
              )}
              <span className="ml-auto text-[10px] leading-relaxed text-white/25">
                Cmd+Enter to search · queries are redacted for secrets before being sent
              </span>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-5 flex items-start gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-4 text-sm text-red-100/75">
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0 text-red-300/70" />
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-xs text-red-100/40 hover:text-red-100 cursor-pointer">
              Dismiss
            </button>
          </div>
        )}

        {searching && (
          <section className="mt-6 overflow-hidden rounded-2xl border border-holmes-primary/20 bg-gradient-to-br from-holmes-primary/[0.08] to-transparent p-7 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-holmes-primary/10 text-holmes-primary">
              <FontAwesomeIcon icon={faSpinner} spin className="text-xl" />
            </span>
            <h2 className="mt-4 text-sm font-medium text-white/75">Searching the public web</h2>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-white/35">
              Holmes is querying Tavily and ranking the most relevant pages for "{query.trim()}".
            </p>
          </section>
        )}

        {result && (
          <div className="mt-7 space-y-5">
            {result.answer && (
              <section className="rounded-2xl border border-holmes-primary/20 bg-holmes-primary/[0.06] p-5">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-holmes-primary-light/75">
                  <FontAwesomeIcon icon={faLightbulb} />
                  Synthesized answer
                </div>
                <p className="mt-2 text-sm leading-relaxed text-white/70">{result.answer}</p>
              </section>
            )}

            <div className="flex items-center justify-between text-[10px] leading-relaxed text-white/30">
              <span>{result.results.length} result{result.results.length === 1 ? '' : 's'}</span>
              <span>
                {topic === 'news' ? <><FontAwesomeIcon icon={faNewspaper} className="mr-1" />news · </> : null}
                {depth} depth · {new Date(result.searchedAt).toLocaleString()}
                {result.responseTimeMs !== null ? ` · ${result.responseTimeMs}ms` : ''}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {result.results.map((item, index) => {
                let domain = item.url
                try {
                  domain = new URL(item.url).hostname.replace(/^www\./, '')
                } catch { /* keep raw url */ }
                return (
                  <article
                    key={`${item.url}-${index}`}
                    className="overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface p-5"
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-[10px] font-semibold text-white/45">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <button
                          onClick={() => void onOpenExternal(item.url)}
                          title={item.url}
                          className="block text-left"
                        >
                          <h2 className="truncate text-sm font-medium text-holmes-primary-light hover:underline">{item.title}</h2>
                          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-white/35">
                            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-[8px]" />
                            {domain}
                          </span>
                        </button>
                        <p className="mt-2 text-xs leading-relaxed text-white/55">{item.content}</p>
                      </div>
                      {item.score > 0 && (
                        <div className="shrink-0 text-right">
                          <div className="text-[11px] font-medium tabular-nums text-white/50">
                            {Math.round(item.score * 100)}
                          </div>
                          <div className="text-[9px] uppercase tracking-wider text-white/25">match</div>
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
