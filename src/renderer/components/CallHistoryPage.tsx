import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRotateRight, faPause, faPlay, faReceipt, faTrash, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { ProviderCall, ProviderCallStats, ProviderCallSummary } from '@shared/types'
import { formatCallCost, formatTotalCost, renderMessageContent } from '@shared/callHistory'
import { useSettings } from '../hooks/useSettings'

interface CallHistoryPageProps {
  onBack: () => void
}

const PAGE_SIZE = 100

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function formatTokens(value: number | null): string {
  return value === null ? '—' : value.toLocaleString()
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayHeading(dayStart: number): string {
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (dayStart === todayStart) return 'Today'
  if (dayStart === todayStart - 86_400_000) return 'Yesterday'
  return new Date(dayStart).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: new Date(dayStart).getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

// The label is an IPC channel ("timeline:rebuild") or a timer name — readable
// enough to keep verbatim, but the namespace carries the meaning, so it leads.
function featureLabel(feature: string | null): string {
  if (!feature) return 'background'
  return feature
}

interface RenderedMessage {
  role: string
  text: string
}

interface RenderedRequest {
  messages: RenderedMessage[]
  /** model / temperature / max_tokens and friends, minus the messages. */
  params: string | null
  raw: string | null
}

/**
 * Shows the request the way it was sent — one block per message — falling back
 * to the raw body for anything that is not a chat completion.
 */
function renderRequest(request: string): RenderedRequest {
  if (!request.trim()) return { messages: [], params: null, raw: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(request)
  } catch {
    return { messages: [], params: null, raw: request }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { messages: [], params: null, raw: request }
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.messages)) return { messages: [], params: null, raw: request }

  const messages = record.messages.map((message) => {
    const entry = (message ?? {}) as Record<string, unknown>
    return {
      role: typeof entry.role === 'string' ? entry.role : 'message',
      text: renderMessageContent(entry.content),
    }
  })
  const { messages: _messages, ...rest } = record
  const params = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null
  return { messages, params, raw: null }
}

const ROLE_STYLE: Record<string, string> = {
  system: 'text-violet-200/70',
  user: 'text-sky-200/70',
  assistant: 'text-emerald-200/70',
  tool: 'text-amber-200/70',
}

/**
 * Every call the app has made to the connected provider, newest first: what
 * asked for it, what was sent, what came back, and what it cost.
 *
 * The rows are written by callLog.ts from the fetch layer, so this covers chat,
 * every indexer, and the bookkeeping calls alike — not only the subsystems that
 * remembered to report themselves.
 */
export const CallHistoryPage: FC<CallHistoryPageProps> = ({ onBack }) => {
  // The switch lives here rather than in Settings because this is the page that
  // shows what the automated passes actually cost — the number that makes
  // someone want to stop them.
  const { settings, updateSettings, loadSettings } = useSettings()
  const automationPaused = settings?.automationPaused ?? false

  const [calls, setCalls] = useState<ProviderCallSummary[]>([])
  const [stats, setStats] = useState<ProviderCallStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [completionsOnly, setCompletionsOnly] = useState(true)
  const [failedOnly, setFailedOnly] = useState(false)

  const [openId, setOpenId] = useState<string | null>(null)
  const [openCall, setOpenCall] = useState<ProviderCall | null>(null)
  const [openLoading, setOpenLoading] = useState(false)

  const filter = useMemo(
    () => ({
      ...(appliedSearch ? { search: appliedSearch } : {}),
      ...(completionsOnly ? { completionsOnly: true } : {}),
      ...(failedOnly ? { failedOnly: true } : {}),
    }),
    [appliedSearch, completionsOnly, failedOnly]
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rows, totals] = await Promise.all([
        window.electronAPI.callHistory.list({ ...filter, limit: PAGE_SIZE }),
        window.electronAPI.callHistory.stats(filter),
      ])
      setCalls(rows)
      setStats(totals)
      setHasMore(rows.length === PAGE_SIZE)
      setOpenId(null)
      setOpenCall(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the call history')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void load()
  }, [load])

  // The page can be opened before anything has read the settings — the toggle
  // must not render as "not paused" when it is.
  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const rows = await window.electronAPI.callHistory.list({
        ...filter,
        limit: PAGE_SIZE,
        offset: calls.length,
      })
      setCalls((current) => [...current, ...rows])
      setHasMore(rows.length === PAGE_SIZE)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read more calls')
    } finally {
      setLoadingMore(false)
    }
  }

  const handleToggle = async (call: ProviderCallSummary) => {
    if (openId === call.id) {
      setOpenId(null)
      setOpenCall(null)
      return
    }
    setOpenId(call.id)
    setOpenCall(null)
    setOpenLoading(true)
    try {
      setOpenCall(await window.electronAPI.callHistory.get(call.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that call')
    } finally {
      setOpenLoading(false)
    }
  }

  const handleClear = async () => {
    if (!window.confirm('Delete the recorded call history? The calls themselves are already made; this only clears the record.')) {
      return
    }
    await window.electronAPI.callHistory.clear()
    await load()
  }

  const days = useMemo(() => {
    const groups = new Map<number, ProviderCallSummary[]>()
    for (const call of calls) {
      const day = startOfDay(call.createdAt)
      const bucket = groups.get(day)
      if (bucket) bucket.push(call)
      else groups.set(day, [call])
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0])
  }, [calls])

  const rendered = openCall ? renderRequest(openCall.request) : null

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <div className="sticky top-0 z-10 border-b border-white/10 bg-holmes-bg/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="text-sm text-white/40 hover:text-white/80 transition-colors cursor-pointer"
            >
              ← Back
            </button>
            <span className="text-white/15">/</span>
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faReceipt} className="text-amber-300/80 text-sm" />
              <h1 className="text-xl font-medium text-white/85 font-serif-display">Call History</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void updateSettings({ automationPaused: !automationPaused })}
              title={
                automationPaused
                  ? 'Background timers are stopped. Chat, indexing you start, and anything else you ask for still run.'
                  : 'Stop every background timer — the hourly index, timeline, People, health and activity passes. Anything you start yourself still runs.'
              }
              className={`flex h-7 items-center gap-2 rounded-md border px-2.5 text-[11px] transition-colors cursor-pointer ${
                automationPaused
                  ? 'border-amber-300/40 bg-amber-300/10 text-amber-100/80'
                  : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/70'
              }`}
            >
              <FontAwesomeIcon icon={automationPaused ? faPlay : faPause} className="text-[10px]" />
              {automationPaused ? 'Automation paused' : 'Pause automation'}
            </button>
            <button
              onClick={() => void load()}
              title="Reload"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-white/10 text-white/40 transition-colors hover:border-white/25 hover:text-white/70 cursor-pointer"
            >
              <FontAwesomeIcon icon={faArrowRotateRight} className="text-[11px]" />
            </button>
            <button
              onClick={() => void handleClear()}
              title="Clear the recorded history"
              className="flex h-7 items-center gap-2 rounded-md border border-white/10 px-2.5 text-[11px] text-white/40 transition-colors hover:border-red-400/30 hover:text-red-200/80 cursor-pointer"
            >
              <FontAwesomeIcon icon={faTrash} className="text-[10px]" />
              Clear
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setAppliedSearch(search.trim())
              if (event.key === 'Escape') {
                setSearch('')
                setAppliedSearch('')
              }
            }}
            onBlur={() => setAppliedSearch(search.trim())}
            placeholder="Search model, feature, prompt or response…"
            className="w-72 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] text-white/70 outline-none focus:border-amber-300/40 placeholder:text-white/25"
          />
          <button
            onClick={() => setCompletionsOnly((value) => !value)}
            title="Model calls only — hides the model-list lookups the app makes to price them"
            className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
              completionsOnly
                ? 'border-amber-300/40 bg-amber-300/10 text-amber-100/80'
                : 'border-white/10 text-white/40 hover:border-white/25'
            }`}
          >
            Model calls only
          </button>
          <button
            onClick={() => setFailedOnly((value) => !value)}
            className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
              failedOnly
                ? 'border-red-400/40 bg-red-400/10 text-red-100/80'
                : 'border-white/10 text-white/40 hover:border-white/25'
            }`}
          >
            Failures only
          </button>
        </div>

        {stats && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-white/40">
            <span>
              <span className="text-white/70 tabular-nums">{stats.calls.toLocaleString()}</span> calls
            </span>
            <span>
              <span className="text-white/70 tabular-nums">{formatTotalCost(stats.costUsd)}</span> total
              {stats.pricedCalls < stats.calls && (
                <span className="text-white/25"> ({(stats.calls - stats.pricedCalls).toLocaleString()} unpriced)</span>
              )}
            </span>
            <span>
              <span className="text-white/70 tabular-nums">{stats.inputTokens.toLocaleString()}</span> in ·{' '}
              <span className="text-white/70 tabular-nums">{stats.outputTokens.toLocaleString()}</span> out
            </span>
            {stats.failedCalls > 0 && (
              <span className="text-red-200/60">{stats.failedCalls.toLocaleString()} failed</span>
            )}
            {stats.firstCallAt && (
              <span className="text-white/25">since {new Date(stats.firstCallAt).toLocaleString()}</span>
            )}
          </div>
        )}
      </div>

      <div className="px-6 py-4">
        {error && (
          <p className="mb-3 flex items-center gap-2 text-[12px] text-amber-200/70">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-[11px]" />
            {error}
          </p>
        )}

        {loading && <p className="text-[12px] text-white/30">Loading…</p>}

        {!loading && calls.length === 0 && (
          <p className="max-w-xl text-[12px] leading-relaxed text-white/35">
            No calls recorded yet. Every request Holmes makes to the connected provider — chat, indexing, Timeline,
            People, Memory, Health — is logged here from the moment it is sent, along with what it cost.
          </p>
        )}

        {days.map(([day, entries]) => (
          <div key={day} className="mb-4 last:mb-0">
            <div className="sticky top-[132px] z-[5] -mx-6 bg-holmes-bg/95 px-6 py-1 text-[10px] uppercase tracking-wider text-white/30 backdrop-blur">
              {dayHeading(day)} · {entries.length}
            </div>

            <div className="mt-1 space-y-1">
              {entries.map((call) => {
                const isOpen = openId === call.id
                return (
                  <div
                    key={call.id}
                    className={`rounded-md border bg-white/[0.02] ${
                      call.ok ? 'border-white/[0.06]' : 'border-red-400/25'
                    }`}
                  >
                    <button
                      onClick={() => void handleToggle(call)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-white/[0.03] cursor-pointer"
                    >
                      <span className="w-16 shrink-0 text-[10px] tabular-nums text-white/30">
                        {new Date(call.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="w-40 shrink-0 overflow-hidden" title={`${featureLabel(call.feature)} · ${call.endpoint}`}>
                        <span className="inline-block max-w-full truncate rounded bg-white/[0.06] px-1.5 py-0.5 align-middle text-[10px] text-white/45">
                          {featureLabel(call.feature)}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-white/65" title={call.model ?? call.endpoint}>
                        {call.model ?? call.endpoint}
                      </span>
                      {call.streamed && (
                        <span className="shrink-0 rounded bg-cyan-400/10 px-1 text-[9px] text-cyan-200/60">stream</span>
                      )}
                      <span
                        className="w-28 shrink-0 text-right text-[10px] tabular-nums text-white/35"
                        title={call.charCount !== null ? 'Characters of speech generated' : 'Input → output tokens'}
                      >
                        {/* Speech is billed per character, so showing it as
                            tokens would misdescribe what was actually charged. */}
                        {call.charCount !== null
                          ? `${call.charCount.toLocaleString()} chars`
                          : `${formatTokens(call.inputTokens)} → ${formatTokens(call.outputTokens)}`}
                      </span>
                      <span
                        className="w-16 shrink-0 text-right text-[11px] tabular-nums text-white/60"
                        title={
                          call.costSource === 'provider'
                            ? 'Charged by the provider'
                            : call.costSource === 'estimated'
                              ? 'Priced from the model list'
                              : 'No price for this model'
                        }
                      >
                        {formatCallCost(call.costUsd)}
                      </span>
                      <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-white/25">
                        {formatDuration(call.durationMs)}
                      </span>
                      <span
                        className={`w-10 shrink-0 text-right text-[10px] tabular-nums ${
                          call.ok ? 'text-white/25' : 'text-red-300/80'
                        }`}
                      >
                        {call.status ?? 'err'}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="border-t border-white/[0.06] px-3 py-3">
                        {openLoading && <p className="text-[11px] text-white/30">Loading…</p>}
                        {!openLoading && !openCall && (
                          <p className="text-[11px] text-amber-200/60">That call is no longer stored.</p>
                        )}
                        {openCall && (
                          <div className="space-y-3">
                            <p className="font-mono text-[10px] text-white/25">
                              {openCall.provider} · {openCall.endpoint} · {new Date(openCall.createdAt).toLocaleString()}
                              {openCall.error ? ` · ${openCall.error}` : ''}
                            </p>

                            <div className="grid gap-3 lg:grid-cols-2">
                              <div className="min-w-0">
                                <p className="mb-1 text-[10px] uppercase tracking-wider text-white/30">
                                  Input
                                  {openCall.requestTruncated && (
                                    <span className="ml-2 normal-case tracking-normal text-white/20">
                                      truncated for storage
                                    </span>
                                  )}
                                </p>
                                <div className="max-h-96 space-y-2 overflow-y-auto rounded border border-white/[0.06] bg-black/25 p-2.5 scrollbar-thin">
                                  {rendered?.messages.map((message, index) => (
                                    <div key={index}>
                                      <p
                                        className={`text-[9px] uppercase tracking-wider ${
                                          ROLE_STYLE[message.role] ?? 'text-white/40'
                                        }`}
                                      >
                                        {message.role}
                                      </p>
                                      <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-white/55">
                                        {message.text || '(empty)'}
                                      </p>
                                    </div>
                                  ))}
                                  {rendered?.raw && (
                                    <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-white/55">
                                      {rendered.raw}
                                    </p>
                                  )}
                                  {rendered?.params && (
                                    <details className="pt-1">
                                      <summary className="cursor-pointer text-[9px] uppercase tracking-wider text-white/25">
                                        Request parameters
                                      </summary>
                                      <p className="whitespace-pre-wrap break-words pt-1 font-mono text-[10px] text-white/40">
                                        {rendered.params}
                                      </p>
                                    </details>
                                  )}
                                  {!rendered?.messages.length && !rendered?.raw && !rendered?.params && (
                                    <p className="text-[11px] text-white/25">No request body was recorded.</p>
                                  )}
                                </div>
                              </div>

                              <div className="min-w-0">
                                <p className="mb-1 text-[10px] uppercase tracking-wider text-white/30">
                                  Output
                                  {openCall.responseTruncated && (
                                    <span className="ml-2 normal-case tracking-normal text-white/20">
                                      truncated for storage
                                    </span>
                                  )}
                                </p>
                                <div className="max-h-96 overflow-y-auto rounded border border-white/[0.06] bg-black/25 p-2.5 scrollbar-thin">
                                  <p
                                    className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed ${
                                      openCall.ok ? 'text-white/55' : 'text-red-200/70'
                                    }`}
                                  >
                                    {openCall.response || '(no response body)'}
                                  </p>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {hasMore && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="mt-2 rounded-md border border-white/10 px-3 py-1.5 text-[11px] text-white/45 transition-colors hover:border-white/25 hover:text-white/70 disabled:opacity-40 cursor-pointer"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  )
}
