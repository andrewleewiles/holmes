import { type FC, useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight, faPause, faPlay, faRefresh, faStop, faUserGroup } from '@fortawesome/free-solid-svg-icons'
import type { Person, PersonIdentityBasis, PersonRelation } from '@shared/types'
import { usePeopleRunState } from '../hooks/usePeopleRun'

interface PeopleWidgetProps {
  enabled: boolean
  /** Opens the full roster. The widget only ever shows the top of it. */
  onOpenPeople: () => void
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

// What each identity basis means in a sentence fragment the user can act on.
// Shown only for the bases that are a caveat — see the row below.
const IDENTITY_BASIS_LABEL: Partial<Record<PersonIdentityBasis, string>> = {
  'name-partial': 'matched on a shortened name only',
  unresolved: 'one name, nothing to match it to',
  ambiguous: 'several people fit this name',
}

const TOP_COUNT = 12

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export const PeopleWidget: FC<PeopleWidgetProps> = ({ enabled, onOpenPeople }) => {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const runState = usePeopleRunState()

  const load = useCallback(async () => {
    if (!enabled) {
      setPeople([])
      setLoading(false)
      return
    }
    try {
      setPeople(await window.electronAPI.people.list({ minScore: 3 }))
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

  // Refresh when a run settles, including the background one nobody started here.
  // A paused run counts as settled: what it wrote so far is already stored.
  useEffect(() => {
    if (status === 'idle' || status === 'paused') void load()
  }, [status, load])

  const handleRebuild = async () => {
    setRebuilding(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.electronAPI.people.rebuild()
      if (result.sourcesScanned === 0 && result.seedsCollected === 0) {
        // Paused or stopped before it got anywhere; the registry already says so.
        await load()
        return
      }
      const parts = [`${result.mentionsHarvested} mentions across ${result.sourcesScanned} sources`]
      if (result.seedsCollected > 0) parts.push(`${result.seedsCollected} contact and message seeds`)
      if (result.yearsCovered > 0) parts.push(`${result.yearsCovered} years of messages read`)
      if (result.dossiersGenerated > 0) parts.push(`${result.dossiersGenerated} profiles written`)
      if (result.ambiguous > 0) parts.push(`${result.ambiguous} left unresolved`)
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
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const counts = people.reduce<Record<string, number>>((acc, person) => {
    acc[person.relation] = (acc[person.relation] ?? 0) + 1
    return acc
  }, {})
  const composition = (['family', 'partner', 'friend', 'colleague', 'professional'] as PersonRelation[])
    .filter((relation) => counts[relation])
    .map((relation) => `${counts[relation]} ${relation}`)
    .join(' · ')

  const top = people.slice(0, TOP_COUNT)
  const maxScore = top.reduce((max, person) => Math.max(max, person.score), 1)

  return (
    <div className="bg-holmes-surface rounded-2xl border border-white/10 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <FontAwesomeIcon icon={faUserGroup} className="text-[20px] text-rose-300/80" />
          <h2 className="text-base font-medium text-white/80 font-serif-display">People</h2>
          {people.length > 0 && (
            <span className="text-[11px] text-white/35 tabular-nums">{people.length}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Pause and Stop mirror the document index: a paused rebuild keeps every
              profile it already wrote, and resuming skips them. */}
          {(running || stopping) && (
            <>
              <button
                onClick={() => void window.electronAPI.people.pause()}
                disabled={stopping}
                title="Pause — finished profiles are kept and resuming skips them"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] text-amber-200/80 hover:text-amber-100 bg-amber-400/[0.08] hover:bg-amber-400/[0.14] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <FontAwesomeIcon icon={faPause} />
                Pause
              </button>
              <button
                onClick={() => void window.electronAPI.people.abort()}
                title="Stop — finished profiles are kept, but there is no resume point"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] text-white/55 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                <FontAwesomeIcon icon={faStop} />
                Stop
              </button>
            </>
          )}
          {paused && (
            <button
              onClick={() => void window.electronAPI.people.abort()}
              title="Discard the resume point"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] text-white/55 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <FontAwesomeIcon icon={faStop} />
              Stop
            </button>
          )}
          <button
            onClick={handleRebuild}
            disabled={!enabled || busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] text-white/60 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <FontAwesomeIcon icon={paused ? faPlay : faRefresh} className={busy ? 'animate-spin' : ''} />
            {paused ? 'Resume' : people.length > 0 ? 'Rebuild' : 'Build'}
          </button>
        </div>
      </div>

      {!enabled && (
        <p className="text-xs text-amber-200/70">People is turned off in Settings.</p>
      )}

      {enabled && (running || stopping) && runState?.progress && (
        <p className="mb-2 rounded-lg border border-rose-400/15 bg-rose-400/[0.05] px-3 py-2 text-[11px] text-rose-100/75">
          {stopping ? `${runState.pendingAction === 'pause' ? 'Pausing' : 'Stopping'} — ` : ''}
          {runState.progress.message}
          {runState.progress.total ? ` (${runState.progress.current ?? 0}/${runState.progress.total})` : ''}
        </p>
      )}

      {enabled && paused && runState?.message && (
        <p className="mb-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-100/80">
          {runState.message}
        </p>
      )}

      {error && <p className="mb-2 text-[11px] text-red-300/80">{error}</p>}
      {notice && <p className="mb-2 text-[11px] text-white/45">{notice}</p>}

      {enabled && !loading && people.length === 0 && !error && (
        <p className="text-xs text-white/40 leading-relaxed">
          Nobody recorded yet. Build reads your Contacts and message history first, so it finds people
          even before anything has been indexed.
        </p>
      )}

      {composition && <p className="mb-3 text-[11px] text-white/35">{composition}</p>}

      <div className="space-y-1.5">
        {top.map((person) => {
          const open = openId === person.id
          return (
            <div key={person.id} className="rounded-lg bg-white/[0.03] hover:bg-white/[0.05] transition-colors">
              <button
                onClick={() => setOpenId(open ? null : person.id)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer"
              >
                <span className="text-xs text-white/75 truncate flex-1">{person.displayName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${RELATION_STYLE[person.relation]}`}>
                  {person.role || person.relation}
                </span>
                <span className="h-1 w-14 rounded-full bg-white/10 overflow-hidden shrink-0">
                  <span
                    className="block h-full rounded-full bg-rose-400/60"
                    style={{ width: `${Math.round((person.score / maxScore) * 100)}%` }}
                  />
                </span>
              </button>

              {open && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-[11px] text-white/45 leading-relaxed">
                    {person.dossierShort || 'No profile written yet — this person is below the profiling threshold.'}
                  </p>
                  <p className="text-[10px] text-white/30">
                    {person.sourceCount} source{person.sourceCount === 1 ? '' : 's'}
                    {person.messageCount > 0 && ` · ${person.messageCount} messages`}
                    {person.firstSeen && person.lastSeen && ` · ${person.firstSeen.slice(0, 4)}–${person.lastSeen.slice(0, 4)}`}
                    {person.aliases.length > 1 && ` · also ${person.aliases.slice(0, 3).map((a) => a.alias).join(', ')}`}
                  </p>
                  {/* How the identity itself was established, which is a different
                      question from how much this person's sources are worth. Said
                      out loud only when it is a caveat: "asserted" on every
                      Contacts-backed row would be noise. */}
                  {person.identityConfidence < 0.75 && (
                    <p
                      className="text-[10px] text-amber-300/50"
                      title="Identity resolution is deliberately cautious. A low basis means this row may be the wrong person, or the same person as another row."
                    >
                      Identity: {IDENTITY_BASIS_LABEL[person.identityBasis] ?? person.identityBasis}
                    </p>
                  )}
                  {/* Where the relationship actually lives, rather than one summed
                      number that cannot tell daily texting from a stray connection. */}
                  {person.platforms.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {person.platforms.map((platform) => (
                        <span
                          key={platform.provider}
                          className="rounded px-1.5 py-0.5 text-[10px] text-white/45 bg-white/[0.05]"
                          title={`${platform.messageCount} messages, ${platform.daysActive} active days`}
                        >
                          {platform.provider} · {platform.messageCount}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* Without these, a wrong merge is permanent — and a wrong merge
                      is the one failure that reaches every conversation. */}
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => void correct(() => window.electronAPI.people.ignore(person.personKey, true))}
                      className="px-2 py-1 rounded text-[10px] text-white/50 hover:text-white bg-white/[0.05] hover:bg-white/10 transition-colors cursor-pointer"
                    >
                      Not a person in my life
                    </button>
                    {/* Handle linking. A username on one platform shares no name with
                        a contact card on another, so nothing automatic can join them —
                        but saying so once is stored as an override and re-applied on
                        every rebuild thereafter. */}
                    <select
                      value=""
                      onChange={(e) => {
                        const target = e.target.value
                        if (target) void correct(() => window.electronAPI.people.merge(person.personKey, target))
                      }}
                      className="rounded bg-white/[0.05] px-2 py-1 text-[10px] text-white/50 hover:text-white cursor-pointer"
                      title="Record that this is the same person as someone else"
                    >
                      <option value="">Same as…</option>
                      {people
                        .filter((other) => other.id !== person.id)
                        .slice(0, 60)
                        .map((other) => (
                          <option key={other.id} value={other.personKey}>
                            {other.displayName}
                          </option>
                        ))}
                    </select>
                    {(['family', 'partner', 'friend', 'colleague', 'professional'] as PersonRelation[])
                      .filter((relation) => relation !== person.relation)
                      .map((relation) => (
                        <button
                          key={relation}
                          onClick={() => void correct(() => window.electronAPI.people.setRelation(person.personKey, relation))}
                          className="px-2 py-1 rounded text-[10px] text-white/40 hover:text-white bg-white/[0.05] hover:bg-white/10 transition-colors cursor-pointer"
                        >
                          {relation}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* The widget is a summary by design; everyone recorded — including the
          long tail below the chat threshold — lives on the People page. */}
      <button
        onClick={onOpenPeople}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/[0.03] py-2 text-[11px] text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/75 cursor-pointer"
      >
        {people.length > TOP_COUNT
          ? `All people — ${people.length - TOP_COUNT} more`
          : 'All people'}
        <FontAwesomeIcon icon={faArrowRight} className="text-[9px]" />
      </button>
    </div>
  )
}
