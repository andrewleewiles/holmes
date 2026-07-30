import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowLeft,
  faMagnifyingGlass,
  faPause,
  faPlay,
  faRefresh,
  faStop,
  faUserGroup,
} from '@fortawesome/free-solid-svg-icons'
import type { Person, PersonIdentityBasis, PersonMention, PersonRelation } from '@shared/types'
import { MIN_SCORE_FOR_DOSSIER, MIN_SCORE_FOR_PERSON } from '@shared/peopleResolve'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { usePeopleRunState } from '../hooks/usePeopleRun'

interface PeoplePageProps {
  enabled: boolean
  onBack: () => void
}

const RELATION_STYLE: Record<PersonRelation, string> = {
  partner: 'bg-pink-500/20 text-pink-300',
  family: 'bg-purple-500/20 text-purple-300',
  friend: 'bg-blue-500/20 text-blue-300',
  colleague: 'bg-amber-500/20 text-amber-300',
  client: 'bg-teal-500/20 text-teal-300',
  professional: 'bg-emerald-500/20 text-emerald-300',
  community: 'bg-indigo-500/20 text-indigo-300',
  acquaintance: 'bg-white/10 text-white/50',
  public: 'bg-white/10 text-white/40',
  self: 'bg-white/10 text-white/40',
  unknown: 'bg-white/10 text-white/40',
}

/** Same wording the widget uses, for the bases that are a caveat. */
const IDENTITY_BASIS_LABEL: Partial<Record<PersonIdentityBasis, string>> = {
  'name-partial': 'matched on a shortened name only',
  unresolved: 'one name, nothing to match it to',
  ambiguous: 'several people fit this name',
}

const RELATION_ORDER: PersonRelation[] = [
  'partner', 'family', 'friend', 'colleague', 'professional', 'community', 'client', 'acquaintance', 'public', 'unknown', 'self',
]

const CORRECTABLE_RELATIONS: PersonRelation[] = ['family', 'partner', 'friend', 'colleague', 'professional', 'acquaintance']

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function years(person: Person): string | null {
  if (!person.firstSeen || !person.lastSeen) return null
  const from = person.firstSeen.slice(0, 4)
  const to = person.lastSeen.slice(0, 4)
  return from === to ? from : `${from}–${to}`
}

/**
 * Everyone the People index has recorded, not the dashboard's top twelve.
 *
 * The widget is a summary and has to stay one, so this page is where the rest
 * of the record lives: the long tail below the widget's cut, the full profile
 * text (which the widget only ever showed the first sentence of), and the
 * evidence each person was built from. Corrections are here too — a wrong merge
 * is easiest to spot next to the evidence that caused it.
 */
export const PeoplePage: FC<PeoplePageProps> = ({ enabled, onBack }) => {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [relationFilter, setRelationFilter] = useState<PersonRelation | 'all'>('all')
  const [showLowSignal, setShowLowSignal] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mentions, setMentions] = useState<PersonMention[]>([])
  const runState = usePeopleRunState()

  const load = useCallback(async () => {
    if (!enabled) {
      setPeople([])
      setLoading(false)
      return
    }
    try {
      // Everything, once. The thresholds below are a view of this list rather
      // than separate queries, so switching them is instant and the counts on
      // the toggles are always the true ones.
      setPeople(await window.electronAPI.people.list({ minScore: 0, includeIgnored: true }))
      setError(null)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
  }, [load])

  const status = runState?.status ?? 'idle'
  const running = status === 'running'
  const stopping = status === 'stopping'
  const paused = status === 'paused'
  const busy = rebuilding || running || stopping

  // A settled run — including the background one nobody started here — has new
  // profiles to show.
  useEffect(() => {
    if (status === 'idle' || status === 'paused') void load()
  }, [status, load])

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return people.filter((person) => {
      if (person.status === 'ignored') return false
      if (!showLowSignal && person.score < MIN_SCORE_FOR_PERSON) return false
      if (relationFilter !== 'all' && person.relation !== relationFilter) return false
      if (!query) return true
      return (
        person.displayName.toLowerCase().includes(query) ||
        person.role.toLowerCase().includes(query) ||
        person.dossierShort.toLowerCase().includes(query) ||
        person.aliases.some((alias) => alias.alias.toLowerCase().includes(query))
      )
    })
  }, [people, search, relationFilter, showLowSignal])

  const lowSignalCount = useMemo(
    () => people.filter((person) => person.status !== 'ignored' && person.score < MIN_SCORE_FOR_PERSON).length,
    [people]
  )
  const ignoredCount = useMemo(() => people.filter((person) => person.status === 'ignored').length, [people])

  const presentRelations = useMemo(() => {
    const present = new Set(visible.map((person) => person.relation))
    return RELATION_ORDER.filter(
      (relation) => present.has(relation) || relation === relationFilter
    )
  }, [visible, relationFilter])

  const selected = useMemo(
    () => visible.find((person) => person.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId]
  )

  // The evidence behind whoever is open. Kept out of the list payload: 487
  // people carry tens of thousands of mentions between them.
  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setMentions([])
      return
    }
    window.electronAPI.people
      .get(selected.id)
      .then((result) => {
        if (!cancelled) setMentions(result?.mentions ?? [])
      })
      .catch(() => {
        if (!cancelled) setMentions([])
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const handleRebuild = async () => {
    setRebuilding(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.electronAPI.people.rebuild()
      const parts = [`${result.mentionsHarvested} mentions across ${result.sourcesScanned} sources`]
      if (result.yearsCovered > 0) parts.push(`${result.yearsCovered} years of messages read`)
      if (result.dossiersGenerated > 0) parts.push(`${result.dossiersGenerated} profiles written`)
      setNotice(parts.join(' · '))
      await load()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setRebuilding(false)
    }
  }

  const correct = async (action: () => Promise<void>) => {
    try {
      await action()
      setNotice('Saved. It will be applied on the next rebuild and every one after it.')
      await load()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faUserGroup} className={PAGE_HEADER_ICON} />}
        title="People"
        aside={
          <span className="text-[13px] text-white/35 tabular-nums">
            {visible.length}
            {visible.length !== people.length && ` of ${people.length}`}
          </span>
        }
        actions={
          <>
            {(running || stopping) && (
              <>
                <button
                  onClick={() => void window.electronAPI.people.pause()}
                  disabled={stopping}
                  title="Pause — finished profiles are kept and resuming skips them"
                  className="flex h-[30px] items-center gap-2 rounded-md border border-amber-400/20 bg-amber-400/[0.08] px-3 text-[13px] text-amber-200/80 transition-colors hover:text-amber-100 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <FontAwesomeIcon icon={faPause} className="text-[12px]" /> Pause
                </button>
                <button
                  onClick={() => void window.electronAPI.people.abort()}
                  title="Stop — finished profiles are kept, but there is no resume point"
                  className="flex h-[30px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 cursor-pointer"
                >
                  <FontAwesomeIcon icon={faStop} className="text-[12px]" /> Stop
                </button>
              </>
            )}
            <button
              onClick={handleRebuild}
              disabled={!enabled || busy}
              className="flex h-[30px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <FontAwesomeIcon icon={paused ? faPlay : faRefresh} className={`text-[12px] ${busy ? 'animate-spin' : ''}`} />
              {paused ? 'Resume' : 'Rebuild'}
            </button>
            <button
              onClick={onBack}
              className="flex h-[30px] items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 text-[13px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 cursor-pointer"
            >
              <FontAwesomeIcon icon={faArrowLeft} className="text-[12px]" /> Life Dashboard
            </button>
          </>
        }
        below={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <FontAwesomeIcon
                icon={faMagnifyingGlass}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-white/25"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search names, roles, aliases"
                className="h-[28px] w-[260px] rounded-md border border-white/10 bg-white/[0.03] pl-7 pr-2 text-[12px] text-white/75 placeholder:text-white/25 focus:border-white/20 focus:outline-none"
              />
            </div>
            <button
              onClick={() => setRelationFilter('all')}
              className={`h-[26px] rounded-md px-2.5 text-[11px] transition-colors cursor-pointer ${
                relationFilter === 'all' ? 'bg-white/[0.12] text-white/85' : 'bg-white/[0.04] text-white/45 hover:text-white/75'
              }`}
            >
              All
            </button>
            {presentRelations.map((relation) => (
              <button
                key={relation}
                onClick={() => setRelationFilter(relation === relationFilter ? 'all' : relation)}
                className={`h-[26px] rounded-md px-2.5 text-[11px] transition-colors cursor-pointer ${
                  relation === relationFilter ? RELATION_STYLE[relation] : 'bg-white/[0.04] text-white/45 hover:text-white/75'
                }`}
              >
                {relation}
              </button>
            ))}
            {lowSignalCount > 0 && (
              <button
                onClick={() => setShowLowSignal((value) => !value)}
                title={`Named once or twice and never matched to anything else — below the score ${MIN_SCORE_FOR_PERSON} the widget and chat use`}
                className={`ml-auto h-[26px] rounded-md px-2.5 text-[11px] transition-colors cursor-pointer ${
                  showLowSignal ? 'bg-white/[0.12] text-white/85' : 'bg-white/[0.04] text-white/45 hover:text-white/75'
                }`}
              >
                {showLowSignal ? 'Hide' : 'Show'} {lowSignalCount} low-signal
              </button>
            )}
          </div>
        }
      />

      {!enabled && (
        <p className="px-6 py-4 text-[12px] text-white/45">People is switched off in Settings.</p>
      )}

      {enabled && (running || stopping || paused) && runState?.progress && (
        <p className="border-b border-white/[0.06] px-6 py-2 text-[11px] text-white/45">
          {runState.progress.message}
          {runState.progress.total ? ` (${runState.progress.current ?? 0}/${runState.progress.total})` : ''}
        </p>
      )}
      {error && <p className="border-b border-white/[0.06] px-6 py-2 text-[11px] text-red-300/80">{error}</p>}
      {notice && <p className="border-b border-white/[0.06] px-6 py-2 text-[11px] text-white/45">{notice}</p>}

      <div className="flex flex-1 min-h-0">
        {/* The roster. */}
        <div className="w-[320px] shrink-0 overflow-y-auto border-r border-white/[0.06] py-2">
          {loading && <p className="px-4 py-3 text-[12px] text-white/35">Loading…</p>}
          {!loading && visible.length === 0 && (
            <p className="px-4 py-3 text-[12px] text-white/35">
              {people.length === 0 ? 'Nobody recorded yet — run a build.' : 'Nobody matches these filters.'}
            </p>
          )}
          {visible.map((person) => {
            const active = selected?.id === person.id
            return (
              <button
                key={person.id}
                onClick={() => setSelectedId(person.id)}
                className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors cursor-pointer ${
                  active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`truncate text-[13px] ${active ? 'text-white/90' : 'text-white/70'}`}>
                    {person.displayName}
                  </span>
                  <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${RELATION_STYLE[person.relation]}`}>
                    {person.role || person.relation}
                  </span>
                </div>
                <span className="truncate text-[10px] text-white/30 tabular-nums">
                  {person.messageCount > 0 ? `${person.messageCount.toLocaleString()} messages` : `${person.sourceCount} source${person.sourceCount === 1 ? '' : 's'}`}
                  {years(person) && ` · ${years(person)}`}
                  {person.dossier && ' · profiled'}
                </span>
              </button>
            )
          })}
          {ignoredCount > 0 && (
            <p className="px-4 py-3 text-[10px] text-white/25">
              {ignoredCount} marked “not a person in my life” and hidden.
            </p>
          )}
        </div>

        {/* The person. */}
        <div className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
          {selected ? (
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="font-serif-display text-[22px] leading-none text-white/85">{selected.displayName}</h2>
                <span className={`rounded px-2 py-0.5 text-[11px] ${RELATION_STYLE[selected.relation]}`}>
                  {selected.role ? `${selected.relation}, ${selected.role}` : selected.relation}
                </span>
              </div>

              <p className="mt-2 text-[11px] text-white/35 tabular-nums">
                {selected.sourceCount} source{selected.sourceCount === 1 ? '' : 's'}
                {' · '}
                {selected.mentionCount} mention{selected.mentionCount === 1 ? '' : 's'}
                {selected.messageCount > 0 && (
                  <>
                    {' · '}
                    {selected.messageCount.toLocaleString()} messages
                    {` (${Math.round((selected.sentCount / selected.messageCount) * 100)}% sent by you)`}
                    {` · ${selected.daysActive} active days`}
                  </>
                )}
                {years(selected) && ` · ${years(selected)}`}
              </p>

              {/* An identity that could be wrong says so before its profile is read. */}
              {IDENTITY_BASIS_LABEL[selected.identityBasis] && (
                <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-100/75">
                  Identity {IDENTITY_BASIS_LABEL[selected.identityBasis]} — the profile below may be describing more than
                  one person.
                </p>
              )}

              {selected.platforms.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {selected.platforms.map((platform) => (
                    <span
                      key={platform.provider}
                      className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-white/45"
                      title={`${platform.messageCount} messages, ${platform.daysActive} active days`}
                    >
                      {platform.provider} · {platform.messageCount.toLocaleString()}
                    </span>
                  ))}
                </div>
              )}

              {selected.aliases.length > 0 && (
                <p className="mt-3 text-[11px] text-white/30">
                  Also appears as {selected.aliases.slice(0, 12).map((alias) => alias.alias).join(', ')}
                </p>
              )}

              {/* The profile itself — the whole of it, which nothing else shows. */}
              <div className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-white/30">Profile</span>
                  {selected.dossierUpdatedAt && (
                    <span className="text-[10px] text-white/20">
                      written {new Date(selected.dossierUpdatedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {selected.dossier ? (
                  <>
                    {selected.dossierShort && (
                      <p className="mb-3 text-[13px] leading-relaxed text-white/70">{selected.dossierShort}</p>
                    )}
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-white/55">{selected.dossier}</p>
                  </>
                ) : (
                  <p className="text-[12px] leading-relaxed text-white/35">
                    No profile written. A profile costs a model call, so it is only written for people scoring{' '}
                    {MIN_SCORE_FOR_DOSSIER} or more; this person scores {selected.score}.
                  </p>
                )}
              </div>

              {/* Where the person came from. The profile is only as good as this. */}
              <div className="mt-5">
                <p className="mb-2 text-[10px] uppercase tracking-wider text-white/30">
                  Evidence ({mentions.length})
                </p>
                <div className="space-y-1.5">
                  {mentions.length === 0 && (
                    <p className="text-[12px] text-white/30">
                      No document mentions — this person comes from Contacts and message history alone.
                    </p>
                  )}
                  {mentions.map((mention) => (
                    <div key={mention.id} className="rounded-lg bg-white/[0.03] px-3 py-2">
                      <p className="text-[11px] text-white/50">
                        <span className="text-white/70">{mention.sourceLabel}</span>
                        {' — '}
                        {mention.relation}
                        {mention.role ? `, ${mention.role}` : ''}
                        {mention.rawName !== selected.displayName && ` · named “${mention.rawName}”`}
                      </p>
                      {mention.evidence && (
                        <p className="mt-1 text-[11px] leading-relaxed text-white/35">{mention.evidence}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Corrections, next to the evidence that would motivate them. */}
              <div className="mt-6 border-t border-white/[0.06] pt-4">
                <p className="mb-2 text-[10px] uppercase tracking-wider text-white/30">Corrections</p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => void correct(() => window.electronAPI.people.ignore(selected.personKey, true))}
                    className="cursor-pointer rounded bg-white/[0.05] px-2 py-1 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    Not a person in my life
                  </button>
                  <select
                    value=""
                    onChange={(event) => {
                      const target = event.target.value
                      if (target) void correct(() => window.electronAPI.people.merge(selected.personKey, target))
                    }}
                    className="cursor-pointer rounded bg-white/[0.05] px-2 py-1 text-[10px] text-white/50 hover:text-white"
                    title="Record that this is the same person as someone else"
                  >
                    <option value="">Same as…</option>
                    {visible
                      .filter((other) => other.id !== selected.id)
                      .map((other) => (
                        <option key={other.id} value={other.personKey}>
                          {other.displayName}
                        </option>
                      ))}
                  </select>
                  {CORRECTABLE_RELATIONS.filter((relation) => relation !== selected.relation).map((relation) => (
                    <button
                      key={relation}
                      onClick={() => void correct(() => window.electronAPI.people.setRelation(selected.personKey, relation))}
                      className="cursor-pointer rounded bg-white/[0.05] px-2 py-1 text-[10px] text-white/40 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {relation}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            !loading && <p className="text-[12px] text-white/35">Select someone from the list.</p>
          )}
        </div>
      </div>
    </div>
  )
}
