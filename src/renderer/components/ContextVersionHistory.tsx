import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faClockRotateLeft, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import type { ContextVersion, ContextVersionSummary } from '@shared/types'
import { CONTEXT_VERSION_LABELS } from '@shared/contextVersions'

interface ContextVersionHistoryProps {
  /** Scopes the history to one project's contexts. Null lists by sourceRef alone. */
  projectId: string | null
  /** Narrows further to a single path (e.g. `user:super-context`). */
  sourceRef?: string
  /** Bumped by the parent after an index run so the list picks up new versions. */
  reloadKey?: number
}

// A project index can archive a version per file, so the whole history of a photo
// tree is far more than one list should hold. Newest wins; the rest stays in the DB.
const MAX_ROWS = 500

function startOfDay(iso: string): number {
  const date = new Date(iso)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayHeading(dayStart: number): string {
  const today = new Date()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const dayMs = 86_400_000
  if (dayStart === todayStart) return 'Today'
  if (dayStart === todayStart - dayMs) return 'Yesterday'
  return new Date(dayStart).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: new Date(dayStart).getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

// Labels are stored project-qualified ("Photos · 2019/img.heic"); inside a project's
// own card that prefix is noise on every row.
function trimLabel(label: string): string {
  const separator = label.indexOf(' · ')
  return separator > 0 ? label.slice(separator + 3) : label
}

// Structured analyses are archived as raw JSON. Showing it pretty beats a wall of one line.
function displayContext(version: ContextVersion): string {
  const body = version.context.trim()
  if (!body.startsWith('{') && !body.startsWith('[')) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

/**
 * Every archived version of the contexts under one source, newest first. A context
 * is never overwritten on regeneration — it is superseded — so this is the record
 * of how this source's understanding changed over time.
 */
export const ContextVersionHistory: FC<ContextVersionHistoryProps> = ({ projectId, sourceRef, reloadKey }) => {
  const [versions, setVersions] = useState<ContextVersionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [openVersion, setOpenVersion] = useState<ContextVersion | null>(null)
  const [openLoading, setOpenLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.electronAPI.contextVersions.list({
        ...(projectId ? { projectIds: [projectId] } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        limit: MAX_ROWS,
      })
      setVersions(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the version history')
    } finally {
      setLoading(false)
    }
  }, [projectId, sourceRef])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  // The open row belongs to the old scope — keeping it would show one source's
  // text under another's heading.
  useEffect(() => {
    setOpenId(null)
    setOpenVersion(null)
  }, [projectId, sourceRef])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return versions
    return versions.filter(
      (v) => v.sourceLabel.toLowerCase().includes(needle) || v.contextShort.toLowerCase().includes(needle)
    )
  }, [versions, query])

  const days = useMemo(() => {
    const groups = new Map<number, ContextVersionSummary[]>()
    for (const version of filtered) {
      const day = startOfDay(version.generatedAt)
      const bucket = groups.get(day)
      if (bucket) bucket.push(version)
      else groups.set(day, [version])
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0])
  }, [filtered])

  const handleToggle = async (version: ContextVersionSummary) => {
    if (openId === version.id) {
      setOpenId(null)
      setOpenVersion(null)
      return
    }
    setOpenId(version.id)
    setOpenVersion(null)
    setOpenLoading(true)
    try {
      setOpenVersion(await window.electronAPI.contextVersions.get(version.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that version')
    } finally {
      setOpenLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-white/[0.07] bg-black/20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.05]">
        <FontAwesomeIcon icon={faClockRotateLeft} className="text-[10px] text-white/30 shrink-0" />
        <span className="text-[10px] uppercase tracking-wider text-white/40">Context history</span>
        <span className="text-[10px] text-white/25">
          {loading ? 'loading…' : `${versions.length}${versions.length === MAX_ROWS ? '+' : ''} version${versions.length === 1 ? '' : 's'}`}
        </span>
        {versions.length > 8 && (
          <div className="ml-auto flex items-center gap-1.5 min-w-0">
            <FontAwesomeIcon icon={faMagnifyingGlass} className="text-[9px] text-white/25 shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by path"
              className="w-32 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[10px] text-white/70 outline-none focus:border-cyan-400/40 placeholder:text-white/20"
            />
          </div>
        )}
      </div>

      <div className="max-h-80 overflow-y-auto px-3 py-2">
        {error && <p className="text-[10px] text-amber-200/70">{error}</p>}

        {!loading && !error && versions.length === 0 && (
          <p className="text-[10px] text-white/30">
            No archived versions yet. The first version is recorded the next time a context here is generated;
            regenerating the same content does not create one.
          </p>
        )}

        {!loading && versions.length > 0 && filtered.length === 0 && (
          <p className="text-[10px] text-white/30">Nothing matches “{query.trim()}”.</p>
        )}

        {days.map(([day, entries]) => (
          <div key={day} className="mb-2 last:mb-0">
            <div className="sticky top-0 -mx-3 px-3 py-1 bg-holmes-surface/95 backdrop-blur text-[9px] uppercase tracking-wider text-white/30">
              {dayHeading(day)} · {entries.length}
            </div>
            <div className="space-y-1 pt-1">
              {entries.map((version) => {
                const isOpen = openId === version.id
                return (
                  <div key={version.id} className="rounded border border-white/[0.05] bg-white/[0.02]">
                    <button
                      onClick={() => void handleToggle(version)}
                      className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
                    >
                      <span className="text-[9px] text-white/30 shrink-0 tabular-nums">
                        {new Date(version.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                      <span className="text-[11px] text-white/60 truncate flex-1" title={version.sourceRef}>
                        {trimLabel(version.sourceLabel)}
                      </span>
                      <span
                        className="shrink-0 rounded bg-white/[0.06] px-1 text-[9px] text-white/40"
                        title={CONTEXT_VERSION_LABELS[version.sourceType]}
                      >
                        v{version.version}
                      </span>
                      {!version.supersededAt && (
                        <span
                          className="shrink-0 rounded bg-cyan-400/10 px-1 text-[9px] text-cyan-200/60"
                          title="This is the version in use right now."
                        >
                          current
                        </span>
                      )}
                      <span className="shrink-0 text-[9px] text-white/20 tabular-nums">
                        {version.charCount.toLocaleString()} ch
                      </span>
                    </button>

                    {isOpen && (
                      <div className="px-2.5 pb-2.5 pt-1 border-t border-white/[0.05] space-y-1.5">
                        {openLoading && <p className="text-[10px] text-white/30">Loading…</p>}
                        {openVersion && (
                          <>
                            <p className="text-[9px] text-white/25 font-mono">
                              {CONTEXT_VERSION_LABELS[openVersion.sourceType]} · generated{' '}
                              {new Date(openVersion.generatedAt).toLocaleString()}
                              {openVersion.supersededAt
                                ? ` · superseded ${new Date(openVersion.supersededAt).toLocaleString()}`
                                : ' · still in use'}
                              {openVersion.provenance?.model ? ` · ${openVersion.provenance.model}` : ''}
                              {openVersion.provenance?.promptVersion ? ` · ${openVersion.provenance.promptVersion}` : ''}
                            </p>
                            <p className="text-[11px] leading-relaxed text-white/55 whitespace-pre-wrap">
                              {displayContext(openVersion)}
                            </p>
                          </>
                        )}
                        {!openLoading && !openVersion && (
                          <p className="text-[10px] text-amber-200/60">That version is no longer stored.</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}

        {versions.length === MAX_ROWS && (
          <p className="pt-1 text-[9px] text-white/25">
            Showing the {MAX_ROWS.toLocaleString()} most recent versions — older ones are still archived.
          </p>
        )}
      </div>
    </div>
  )
}
