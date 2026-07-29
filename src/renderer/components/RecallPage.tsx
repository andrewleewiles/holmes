import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowRight,
  faArrowUpRightFromSquare,
  faChevronDown,
  faClockRotateLeft,
  faComments,
  faFileLines,
  faFolderOpen,
  faLaptop,
  faMagnifyingGlass,
  faRotateRight,
  faShieldHalved,
  faSpinner,
  faTrash,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons'
import type {
  RecallHistoryEntry,
  RecallSearchRequest,
  RecallSearchResponse,
  RecallSearchResult,
  RecallSearchSource,
} from '@shared/types'
import { useSettingsStore } from '../store/settingsStore'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'

interface RecallPageProps {
  onSelectConversation: (id: string) => void
  onFollowUp: (content: string) => Promise<void>
  followUpDisabled: boolean
}

interface SearchOverrides {
  query?: string
  source?: RecallSearchSource
  semantic?: boolean
}

const SOURCE_OPTIONS: Array<{ value: RecallSearchSource; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'files', label: 'Files' },
]

const EXAMPLE_QUERIES = [
  'notes about moving house',
  'ideas for a summer trip',
  'what did I decide about insurance',
]

function readableError(error: unknown): string {
  if (!(error instanceof Error)) return 'Recall search failed'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

export const RecallPage: FC<RecallPageProps> = ({ onSelectConversation, onFollowUp, followUpDisabled }) => {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<RecallSearchSource>('all')
  const [semantic, setSemantic] = useState(true)
  const [searching, setSearching] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [response, setResponse] = useState<RecallSearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [followUp, setFollowUp] = useState('')
  const [startingChat, setStartingChat] = useState(false)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [history, setHistory] = useState<RecallHistoryEntry[]>([])
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchingRef = useRef(false)
  const cancelRequestedRef = useRef(false)
  const requestIdRef = useRef(0)

  const fileAccessScope = useSettingsStore((state) => state.settings?.fileAccessScope)
  const scopeLabel = !fileAccessScope
    ? 'File scope unavailable'
    : fileAccessScope.mode === 'everywhere'
      ? 'Entire Mac'
      : fileAccessScope.roots.length === 0
        ? 'No folders configured'
        : fileAccessScope.roots.length === 1
          ? fileAccessScope.roots[0]
          : `${fileAccessScope.roots.length} folders`
  const scopeConfigured = fileAccessScope?.mode === 'everywhere' || (fileAccessScope?.roots.length ?? 0) > 0

  useEffect(() => {
    inputRef.current?.focus()
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  useEffect(() => () => {
    requestIdRef.current += 1
    void window.electronAPI.recall.clear()
  }, [])

  const loadHistory = async () => {
    try {
      setHistory(await window.electronAPI.recall.history())
    } catch (historyError) {
      setError(readableError(historyError))
    }
  }

  useEffect(() => {
    void loadHistory()
  }, [])

  const runSearch = async (overrides: SearchOverrides = {}) => {
    const nextQuery = (overrides.query ?? query).trim()
    const nextSource = overrides.source ?? source
    const nextSemantic = overrides.semantic ?? semantic
    if (!nextQuery) {
      inputRef.current?.focus()
      return
    }

    if (searchingRef.current) void window.electronAPI.recall.abort()
    const requestId = ++requestIdRef.current
    searchingRef.current = true
    cancelRequestedRef.current = false
    setSearching(true)
    setCancelling(false)
    setError(null)
    setResponse(null)
    setFollowUp('')
    setFollowUpError(null)

    const request: RecallSearchRequest = {
      query: nextQuery,
      source: nextSource,
      semantic: nextSemantic,
      limit: 60,
    }

    try {
      const result = await window.electronAPI.recall.search(request)
      if (requestId === requestIdRef.current && !cancelRequestedRef.current) {
        setResponse(result)
        // The search is recorded by the main process; re-read rather than
        // guessing at the row it wrote.
        void loadHistory()
      }
    } catch (searchError) {
      if (requestId === requestIdRef.current && !cancelRequestedRef.current) {
        setError(readableError(searchError))
      }
    } finally {
      if (requestId === requestIdRef.current) {
        searchingRef.current = false
        setSearching(false)
        setCancelling(false)
      }
    }
  }

  const cancel = () => {
    cancelRequestedRef.current = true
    setCancelling(true)
    void window.electronAPI.recall.abort()
  }

  const changeSource = (nextSource: RecallSearchSource) => {
    setSource(nextSource)
    if (response) void runSearch({ source: nextSource })
  }

  const changeSemantic = (nextSemantic: boolean) => {
    setSemantic(nextSemantic)
    if (response) void runSearch({ semantic: nextSemantic })
  }

  const openResult = async (result: RecallSearchResult) => {
    setError(null)
    if (result.source === 'conversation' && result.conversationId) {
      onSelectConversation(result.conversationId)
      return
    }
    if (!result.path) return
    try {
      await window.electronAPI.recall.openFile(result.path)
    } catch (openError) {
      setError(readableError(openError))
    }
  }

  const revealFile = async (filePath: string) => {
    setError(null)
    try {
      await window.electronAPI.recall.revealFile(filePath)
    } catch (revealError) {
      setError(readableError(revealError))
    }
  }

  const submitFollowUp = async () => {
    const content = followUp.trim()
    if (!content || startingChat || followUpDisabled) return
    setStartingChat(true)
    setFollowUpError(null)
    try {
      await onFollowUp(content)
    } catch (followUpFailure) {
      setFollowUpError(readableError(followUpFailure))
      setStartingChat(false)
    }
  }

  const rerunHistoryEntry = (entry: RecallHistoryEntry) => {
    setQuery(entry.query)
    setSource(entry.source)
    setSemantic(entry.semantic)
    void runSearch({ query: entry.query, source: entry.source, semantic: entry.semantic })
  }

  const deleteHistoryEntry = async (id: string) => {
    setError(null)
    try {
      setHistory(await window.electronAPI.recall.deleteHistory(id))
      if (expandedHistoryId === id) setExpandedHistoryId(null)
    } catch (deleteError) {
      setError(readableError(deleteError))
    }
  }

  const clearHistory = async () => {
    setError(null)
    try {
      await window.electronAPI.recall.clearHistory()
      setHistory([])
      setExpandedHistoryId(null)
    } catch (clearError) {
      setError(readableError(clearError))
    } finally {
      setConfirmingClear(false)
    }
  }

  const openHistorySource = async (source: RecallHistoryEntry['sources'][number]) => {
    setError(null)
    if (source.conversationId) {
      onSelectConversation(source.conversationId)
      return
    }
    if (!source.path) return
    try {
      await window.electronAPI.recall.openFile(source.path)
    } catch (openError) {
      setError(readableError(openError))
    }
  }

  const resultSummary = response
    ? `${response.results.length} ranked ${response.results.length === 1 ? 'result' : 'results'} in ${response.durationMs < 1000 ? `${response.durationMs} ms` : `${(response.durationMs / 1000).toFixed(1)} s`}`
    : ''

  return (
    <div className="scrollbar-thin flex flex-1 flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faClockRotateLeft} className={PAGE_HEADER_ICON} />}
        title="Recall"
      />

      <div className="mx-auto w-full max-w-6xl px-5 py-6 sm:px-8 sm:py-8">
        <p className="mb-6 max-w-2xl text-xs leading-relaxed text-white/40">
          Find ideas, decisions, and details across Holmes conversations and documents indexed by Spotlight on this Mac.
        </p>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-[0_18px_60px_rgba(0,0,0,0.14)]">
          <form
            className="border-b border-white/[0.06] p-4 sm:p-5"
            onSubmit={(event) => {
              event.preventDefault()
              void runSearch()
            }}
          >
            <label htmlFor="recall-query" className="mb-2 block text-[10px] font-medium uppercase tracking-[0.12em] text-white/35">
              What are you trying to remember?
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-holmes-primary/70" />
                <input
                  ref={inputRef}
                  id="recall-query"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={300}
                  disabled={searching}
                  placeholder="Describe a topic, decision, person, or phrase..."
                  className="h-12 w-full rounded-xl border border-white/10 bg-black/15 pl-11 pr-16 text-sm text-white/85 outline-none placeholder:text-white/25 focus:border-holmes-primary/50 disabled:opacity-60"
                />
                <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-white/25">
                  {navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}
                </kbd>
              </div>
              {searching ? (
                <button
                  type="button"
                  onClick={cancel}
                  disabled={cancelling}
                  className="h-12 shrink-0 rounded-xl border border-red-300/20 bg-red-400/[0.08] px-5 text-xs font-medium text-red-100/70 transition-colors hover:bg-red-400/[0.13] disabled:opacity-50 cursor-pointer"
                >
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!query.trim()}
                  className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-holmes-primary px-6 text-xs font-medium text-white transition-colors hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <FontAwesomeIcon icon={faMagnifyingGlass} />
                  Search memory
                </button>
              )}
            </div>
          </form>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-5">
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-black/15 p-1">
              {SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => changeSource(option.value)}
                  disabled={searching}
                  className={`rounded-md px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 cursor-pointer ${
                    source === option.value
                      ? 'bg-white/10 text-white/75 shadow-sm'
                      : 'text-white/30 hover:text-white/55'
                  }`}
                  aria-pressed={source === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] ${scopeConfigured ? 'border-white/[0.07] bg-black/10 text-white/40' : 'border-amber-300/20 bg-amber-300/[0.06] text-amber-100/55'}`}
                title={scopeConfigured ? `File scope: ${scopeLabel}` : 'Add allowed folders in Settings to search your files'}
              >
                <FontAwesomeIcon icon={faLaptop} />
                <span className="max-w-[160px] truncate">{scopeLabel}</span>
              </div>

              <button
                type="button"
                onClick={() => changeSemantic(!semantic)}
                disabled={searching}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] transition-colors disabled:opacity-50 cursor-pointer ${
                  semantic
                    ? 'border-holmes-primary/25 bg-holmes-primary/[0.08] text-holmes-primary-light/80'
                    : 'border-white/[0.07] bg-black/10 text-white/30'
                }`}
                aria-pressed={semantic}
                title="Uses the System Model for related concepts and grounded answers to questions"
              >
                <FontAwesomeIcon icon={faWandMagicSparkles} />
                Semantic {semantic ? 'on' : 'off'}
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.07] px-4 py-3 text-xs text-red-100/75">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-[10px] text-red-100/40 hover:text-red-100 cursor-pointer">Dismiss</button>
          </div>
        )}

        {searching && (
          <section className="mt-6 rounded-2xl border border-holmes-primary/20 bg-gradient-to-br from-holmes-primary/[0.08] to-transparent p-8 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-holmes-primary/10 text-holmes-primary">
              <FontAwesomeIcon icon={faSpinner} spin className="text-xl" />
            </span>
            <h2 className="mt-4 text-sm font-medium text-white/70">Searching your local memory</h2>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-white/35">
              Holmes is expanding the idea, querying conversations, asking Spotlight for matching files, and reading the strongest sources when an answer is needed.
            </p>
          </section>
        )}

        {!searching && response && (
          <div className="mt-6">
            {response.answer && (
              <section className="mb-5 rounded-2xl border border-holmes-primary/25 bg-gradient-to-br from-holmes-primary/[0.1] to-holmes-primary/[0.025] p-5 sm:p-6">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-holmes-primary-light/70">
                  <FontAwesomeIcon icon={faWandMagicSparkles} />
                  Grounded answer
                </div>
                <p className="mt-3 whitespace-pre-wrap text-base leading-relaxed text-white/78">
                  {response.answer.text}
                </p>
                <form
                  className="mt-5 border-t border-holmes-primary/10 pt-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitFollowUp()
                  }}
                >
                  <label htmlFor="recall-follow-up" className="mb-2 block text-[10px] font-medium uppercase tracking-[0.12em] text-holmes-primary-light/55">
                    Continue in a new conversation
                  </label>
                  <div className="flex items-end gap-2">
                    <textarea
                      id="recall-follow-up"
                      value={followUp}
                      onChange={(event) => setFollowUp(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          event.currentTarget.form?.requestSubmit()
                        }
                      }}
                      rows={1}
                      maxLength={10_000}
                      disabled={startingChat || followUpDisabled}
                      placeholder={followUpDisabled
                        ? 'Wait for the current response to finish...'
                        : 'Ask a follow-up about this answer or its sources...'}
                      className="min-h-10 min-w-0 flex-1 resize-y rounded-xl border border-holmes-primary/20 bg-black/15 px-3 py-2.5 text-xs leading-relaxed text-white/75 outline-none placeholder:text-white/25 focus:border-holmes-primary/50 disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={!followUp.trim() || startingChat || followUpDisabled}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-holmes-primary text-white transition-colors hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                      aria-label="Continue in a new conversation"
                      title="Continue in a new conversation"
                    >
                      <FontAwesomeIcon icon={startingChat ? faSpinner : faArrowRight} spin={startingChat} />
                    </button>
                  </div>
                  {followUpError && (
                    <p className="mt-2 text-[10px] text-red-200/70">{followUpError}</p>
                  )}
                </form>
                <div className="mt-3 text-[9px] text-white/25">
                  Based on {response.answer.sourceIds.length} {response.answer.sourceIds.length === 1 ? 'source' : 'sources'} listed below
                </div>
              </section>
            )}

            <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
              <div>
                <div className="text-xs font-medium text-white/60">{resultSummary}</div>
                <div className="mt-1 text-[10px] text-white/25">
                  {response.resultCounts.conversations} conversation matches, {response.resultCounts.files} file matches
                </div>
              </div>
              {response.semanticApplied && (
                <div className="flex max-w-2xl flex-wrap justify-end gap-1.5">
                  {response.expandedQueries.map((expandedQuery) => (
                    <span key={expandedQuery} className="rounded-full border border-holmes-primary/15 bg-holmes-primary/[0.05] px-2 py-1 text-[9px] text-holmes-primary-light/55">
                      {expandedQuery}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {response.notices.map((notice) => (
              <div key={notice} className="mb-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-[10px] leading-relaxed text-amber-100/60">
                {notice}
              </div>
            ))}

            {response.results.length === 0 ? (
              <section className="rounded-2xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-12 text-center">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="text-xl text-white/15" />
                <h2 className="mt-3 text-sm font-medium text-white/55 font-serif-display">Nothing matched that memory</h2>
                <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-white/30">
                  Try a broader idea, turn on semantic matching, or switch to Entire Mac. Spotlight settings and macOS privacy permissions determine which files can appear.
                </p>
              </section>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface">
                {response.results.map((result, index) => (
                  <article
                    key={result.id}
                    className={`group flex items-stretch ${index > 0 ? 'border-t border-white/[0.06]' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => void openResult(result)}
                      className="flex min-w-0 flex-1 items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-white/[0.035] sm:px-5 cursor-pointer"
                    >
                      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                        result.source === 'file'
                          ? 'bg-blue-400/[0.08] text-blue-200/55'
                          : 'bg-holmes-primary/[0.1] text-holmes-primary-light/70'
                      }`}>
                        <FontAwesomeIcon icon={result.source === 'file' ? faFileLines : faComments} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="max-w-full truncate text-sm font-medium text-white/72">{result.title}</span>
                          <span className="rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 text-[8px] font-medium tracking-wider text-white/25">
                            {result.source === 'file' ? result.fileType : 'CHAT'}
                          </span>
                          {response.answer?.sourceIds.includes(result.id) && (
                            <span className="rounded border border-holmes-primary/20 bg-holmes-primary/[0.08] px-1.5 py-0.5 text-[8px] font-medium tracking-wider text-holmes-primary-light/60">
                              ANSWER SOURCE
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-white/42">{result.snippet}</span>
                        <span className="mt-2 flex min-w-0 items-center gap-2 text-[9px] text-white/22">
                          <span className="truncate" title={result.context}>{result.context}</span>
                          <span className="shrink-0">{formatDate(result.modifiedAt)}</span>
                        </span>
                      </span>
                      <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="mt-2 shrink-0 text-[10px] text-white/15 transition-colors group-hover:text-holmes-primary-light/55" />
                    </button>
                    {result.source === 'file' && result.path && (
                      <button
                        type="button"
                        onClick={() => void revealFile(result.path!)}
                        className="flex w-12 shrink-0 items-center justify-center border-l border-white/[0.05] text-white/18 transition-colors hover:bg-white/[0.035] hover:text-white/55 cursor-pointer"
                        aria-label={`Show ${result.title} in Finder`}
                        title="Show in Finder"
                      >
                        <FontAwesomeIcon icon={faFolderOpen} />
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {!searching && !response && (
          <div className="mt-7 grid grid-cols-1 gap-4 lg:grid-cols-5">
            <section className="rounded-2xl border border-white/10 bg-holmes-surface p-5 lg:col-span-3">
              <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-white/30">
                <FontAwesomeIcon icon={faWandMagicSparkles} className="text-holmes-primary/70" />
                Search by meaning
              </div>
              <h2 className="mt-3 text-base font-medium text-white/68 font-serif-display">Describe the memory, not the filename.</h2>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-white/35">
                Recall combines related wording from your System Model with local Spotlight matches and Holmes conversation history.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {EXAMPLE_QUERIES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => {
                      setQuery(example)
                      void runSearch({ query: example })
                    }}
                    className="rounded-lg border border-white/[0.08] bg-black/10 px-3 py-2 text-[10px] text-white/38 transition-colors hover:border-holmes-primary/25 hover:text-white/60 cursor-pointer"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-holmes-primary/15 bg-holmes-primary/[0.04] p-5 lg:col-span-2">
              <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-holmes-primary-light/55">
                <FontAwesomeIcon icon={faShieldHalved} />
                Privacy boundary
              </div>
              <p className="mt-3 text-xs leading-relaxed text-white/38">
                Result-only searches stay on this Mac except for semantic query expansion. For question-style prompts, Holmes sends the strongest selected source excerpts to the configured System Model to produce a grounded answer.
              </p>
              <p className="mt-3 border-t border-white/[0.06] pt-3 text-[10px] leading-relaxed text-white/25">
                File coverage follows Spotlight indexing and macOS permissions. Protected folders may require Full Disk Access for Holmes.
              </p>
            </section>
          </div>
        )}

        {history.length > 0 && (
          <section className="mt-7">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
              <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-white/30">
                <FontAwesomeIcon icon={faClockRotateLeft} className="text-holmes-primary/70" />
                Past searches
                <span className="text-white/20">({history.length})</span>
              </div>
              {confirmingClear ? (
                <div className="flex items-center gap-2 text-[10px] text-white/40">
                  <span>Delete every past search?</span>
                  <button
                    type="button"
                    onClick={() => void clearHistory()}
                    className="rounded-md border border-red-300/25 bg-red-400/[0.1] px-2 py-1 text-red-100/75 transition-colors hover:bg-red-400/[0.16] cursor-pointer"
                  >
                    Delete all
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingClear(false)}
                    className="rounded-md border border-white/[0.08] px-2 py-1 text-white/40 transition-colors hover:text-white/70 cursor-pointer"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingClear(true)}
                  className="text-[10px] text-white/25 transition-colors hover:text-white/55 cursor-pointer"
                >
                  Clear history
                </button>
              )}
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface">
              {history.map((entry, index) => {
                const expanded = expandedHistoryId === entry.id
                return (
                  <article key={entry.id} className={index > 0 ? 'border-t border-white/[0.06]' : ''}>
                    <div className="group flex items-stretch">
                      <button
                        type="button"
                        onClick={() => setExpandedHistoryId(expanded ? null : entry.id)}
                        aria-expanded={expanded}
                        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.035] sm:px-5 cursor-pointer"
                      >
                        <FontAwesomeIcon
                          icon={faChevronDown}
                          className={`mt-1 shrink-0 text-[10px] text-white/20 transition-transform ${expanded ? 'rotate-0' : '-rotate-90'}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="max-w-full truncate text-sm text-white/72">{entry.query}</span>
                            {entry.answer && (
                              <span className="rounded border border-holmes-primary/20 bg-holmes-primary/[0.08] px-1.5 py-0.5 text-[8px] font-medium tracking-wider text-holmes-primary-light/60">
                                ANSWERED
                              </span>
                            )}
                          </span>
                          {!expanded && entry.answer && (
                            <span className="mt-1 block line-clamp-1 text-xs leading-relaxed text-white/42">{entry.answer}</span>
                          )}
                          <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[9px] text-white/22">
                            <span>{formatDate(entry.createdAt)}</span>
                            <span>{entry.resultCount} {entry.resultCount === 1 ? 'result' : 'results'}</span>
                            <span>{formatDuration(entry.durationMs)}</span>
                            {entry.source !== 'all' && <span className="capitalize">{entry.source}</span>}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => rerunHistoryEntry(entry)}
                        disabled={searching}
                        className="flex w-11 shrink-0 items-center justify-center border-l border-white/[0.05] text-white/18 transition-colors hover:bg-white/[0.035] hover:text-holmes-primary-light/70 disabled:opacity-30 cursor-pointer"
                        aria-label={`Search for "${entry.query}" again`}
                        title="Search again"
                      >
                        <FontAwesomeIcon icon={faRotateRight} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteHistoryEntry(entry.id)}
                        className="flex w-11 shrink-0 items-center justify-center border-l border-white/[0.05] text-white/18 transition-colors hover:bg-red-400/[0.08] hover:text-red-200/70 cursor-pointer"
                        aria-label={`Delete "${entry.query}" from history`}
                        title="Delete from history"
                      >
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                    </div>

                    {expanded && (
                      <div className="border-t border-white/[0.05] bg-black/10 px-4 py-4 sm:px-5">
                        {entry.answer ? (
                          <>
                            <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/72">{entry.answer}</p>
                            {entry.answerModel && (
                              <div className="mt-2 text-[9px] text-white/22">Answered by {entry.answerModel}</div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs leading-relaxed text-white/35">
                            No grounded answer was generated for this search.
                          </p>
                        )}

                        {entry.sources.length > 0 && (
                          <div className="mt-4">
                            <div className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.12em] text-white/25">
                              Based on
                            </div>
                            <div className="flex flex-col gap-1">
                              {entry.sources.map((source) => (
                                <button
                                  key={source.resultId}
                                  type="button"
                                  onClick={() => void openHistorySource(source)}
                                  className="flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-left transition-colors hover:border-holmes-primary/25 hover:bg-white/[0.045] cursor-pointer"
                                  title={source.path || source.context}
                                >
                                  <FontAwesomeIcon
                                    icon={source.conversationId ? faComments : faFileLines}
                                    className="shrink-0 text-[10px] text-white/25"
                                  />
                                  <span className="truncate text-[11px] text-white/60">{source.title}</span>
                                  <span className="truncate text-[9px] text-white/20">{source.context}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {entry.expandedQueries.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-1.5">
                            {entry.expandedQueries.map((expandedQuery) => (
                              <span
                                key={expandedQuery}
                                className="rounded-full border border-holmes-primary/15 bg-holmes-primary/[0.05] px-2 py-1 text-[9px] text-holmes-primary-light/55"
                              >
                                {expandedQuery}
                              </span>
                            ))}
                          </div>
                        )}

                        {entry.notices.map((notice) => (
                          <div
                            key={notice}
                            className="mt-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-[10px] leading-relaxed text-amber-100/60"
                          >
                            {notice}
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
