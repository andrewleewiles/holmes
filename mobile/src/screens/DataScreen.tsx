import { useEffect, useState } from 'react'
import type { Person, Project, ProjectIndexSummary, TimelineEvent, UserSuperContext } from '@shared/types'
import { api } from '../transport/api'

type Tab = 'profile' | 'sources' | 'timeline' | 'people'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'sources', label: 'Sources' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'people', label: 'People' },
]

export function DataScreen(): React.ReactElement {
  const [tab, setTab] = useState<Tab>('profile')
  const [profile, setProfile] = useState<UserSuperContext | null>(null)
  const [sources, setSources] = useState<ProjectIndexSummary[]>([])
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        if (tab === 'profile' && !profile) setProfile(await api.documents.userContext())
        if (tab === 'sources' && sources.length === 0) {
          const [summaries, projects] = await Promise.all([api.documents.summaries(), api.projects.list()])
          setSources(summaries)
          setProjectNames(Object.fromEntries(projects.map((project: Project) => [project.id, project.name])))
        }
        if (tab === 'timeline' && events.length === 0) setEvents(await api.timeline.list())
        if (tab === 'people' && people.length === 0) setPeople(await api.people.list())
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [tab])

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/[0.07] px-4 pt-3">
        <h1 className="font-serif-display text-lg text-white">Data</h1>
        <div className="mt-3 flex gap-4 overflow-x-auto">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`shrink-0 border-b-2 pb-2 text-sm transition-colors ${
                tab === entry.id ? 'border-sky-400 text-white' : 'border-transparent text-white/35'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && <div className="rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-sm text-red-100/75">{error}</div>}
        {loading && <div className="text-sm text-white/30">Loading…</div>}

        {!loading && tab === 'profile' && (
          profile?.context
            ? <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-white/75">{profile.context}</p>
            : <p className="text-sm text-white/30">No profile has been generated yet. Build one on your Mac.</p>
        )}

        {!loading && tab === 'sources' && (
          <ul className="space-y-2">
            {sources.map((source) => (
              <li key={source.projectId} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2">
                  {source.fullyIndexed && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
                  <span className="text-[15px] text-white/80">{projectNames[source.projectId] ?? 'Source'}</span>
                </div>
                <div className="mt-1 text-[11px] text-white/30">
                  {source.fileCount} files · {source.folderCount} folders · {source.sourceCount} connected
                </div>
                {source.missingSources.length > 0 && (
                  <div className="mt-1 text-[11px] text-amber-200/60">
                    {source.missingSources.length} source{source.missingSources.length === 1 ? '' : 's'} missing
                  </div>
                )}
              </li>
            ))}
            {sources.length === 0 && <li className="text-sm text-white/30">No indexed sources.</li>}
          </ul>
        )}

        {!loading && tab === 'timeline' && (
          <ul className="space-y-3">
            {events.map((event) => (
              <li key={event.id} className="border-l border-white/10 pl-3">
                <div className="text-[11px] uppercase tracking-wider text-white/30">
                  {event.startDate}{event.endDate ? ` – ${event.endDate}` : ''}
                </div>
                <div className="mt-0.5 text-[15px] leading-relaxed text-white/75">{event.title}</div>
                {event.detail && <div className="mt-0.5 text-[13px] leading-relaxed text-white/45">{event.detail}</div>}
              </li>
            ))}
            {events.length === 0 && <li className="text-sm text-white/30">Nothing on the timeline yet.</li>}
          </ul>
        )}

        {!loading && tab === 'people' && (
          <ul className="space-y-2">
            {people.map((person) => (
              <li key={person.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="text-[15px] text-white/80">{person.displayName}</div>
                {person.relation && <div className="mt-0.5 text-[11px] text-white/30">{person.relation}</div>}
              </li>
            ))}
            {people.length === 0 && <li className="text-sm text-white/30">No people yet.</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
