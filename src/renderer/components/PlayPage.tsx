import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRotateRight, faPlay, faStop, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { PLAY_ITEM_KINDS, type PlayFeed, type PlayItem, type PlayItemKind, type PlayReaction } from '@shared/types'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { PlayCard } from './PlayCard'
import { PlayPlayer } from './PlayPlayer'
import { ProvenanceExplorer } from './ProvenanceExplorer'
import { usePlayRun } from '../hooks/usePlayRun'

/** Only `video` retrieves today; the rest advertise the shape of what is coming. */
const ENABLED_KINDS: readonly PlayItemKind[] = ['video']

const KIND_LABEL: Record<PlayItemKind, string> = {
  video: 'Videos',
  article: 'Articles',
  podcast: 'Podcasts',
  book: 'Books',
  audiobook: 'Audiobooks',
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return 'never'
  const minutes = Math.round((Date.now() - timestamp) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

interface EmptyStateProps {
  feed: PlayFeed
  onOpenSettings: () => void
  onOpenData: () => void
}

/**
 * Every status is a state the page explains. Deliberately NO starter videos when
 * there is no profile: generic opening prompts work on the home screen because a
 * generic prompt is still useful, but a generic video is a lie about what Holmes
 * knows about you.
 */
const EmptyState: FC<EmptyStateProps> = ({ feed, onOpenSettings, onOpenData }) => {
  const body: Record<string, { title: string; detail: string; action?: { label: string; run: () => void } }> = {
    'no-api-key': {
      title: 'Add a YouTube key to build your feed',
      detail:
        'Holmes turns what it knows about you into search terms and needs somewhere to run them. A free YouTube Data API key is enough.',
      action: { label: 'Open Settings', run: onOpenSettings },
    },
    'no-profile': {
      title: 'Nothing to go on yet',
      detail:
        'The feed is built from your own indexed data — your profile, your timeline, what you already watch, what is on your shelf. Connect and index a source first.',
      action: { label: 'Open Data', run: onOpenData },
    },
    'no-credentials': {
      title: 'Connect a model provider',
      detail: feed.lastError ?? 'Holmes needs a model to plan and curate the feed.',
      action: { label: 'Open Settings', run: onOpenSettings },
    },
    quota: {
      title: "YouTube's daily quota is used up",
      detail: "It resets at midnight Pacific time. Your existing picks are still here until then.",
    },
    error: {
      title: 'The feed could not be built',
      detail: feed.lastError ?? 'Try refreshing again.',
    },
    ok: {
      title: 'No suggestions yet',
      detail: 'Press Refresh to build your first feed.',
    },
  }

  const content = body[feed.status] ?? body['ok']!

  return (
    <div className="mx-auto max-w-md px-6 py-20 text-center">
      <p className="font-serif-display text-[19px] text-white/70">{content.title}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-white/40">{content.detail}</p>
      {content.action && (
        <button
          onClick={content.action.run}
          className="mt-5 cursor-pointer rounded-lg border border-white/15 px-4 py-2 text-[13px] text-white/70 transition-colors hover:border-white/30 hover:text-white/90"
        >
          {content.action.label}
        </button>
      )}
    </div>
  )
}

interface PlayPageProps {
  onOpenSettings: () => void
  onOpenData: () => void
}

export const PlayPage: FC<PlayPageProps> = ({ onOpenSettings, onOpenData }) => {
  const [feed, setFeed] = useState<PlayFeed | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<PlayItem | null>(null)
  const [showSources, setShowSources] = useState(false)
  // The build reports through the shared run registry, so the page shows the
  // same state the sidebar strip does even when another window started it.
  const runState = usePlayRun()
  const building = runState?.status === 'building'
  const archivingIds = new Set(
    (runState?.archives ?? [])
      .filter((entry) => entry.status === 'queued' || entry.status === 'downloading')
      .map((entry) => entry.itemId)
  )

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true)
    setError(null)
    try {
      setFeed(await window.electronAPI.play.refresh(force))
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  const stop = useCallback(async () => {
    try {
      await window.electronAPI.play.stop()
    } catch (err) {
      setError(cleanError(err))
    }
  }, [])

  const archive = useCallback(async (item: PlayItem) => {
    setError(null)
    try {
      setFeed(await window.electronAPI.play.archive(item.id))
    } catch (err) {
      setError(cleanError(err))
    }
  }, [])

  // The analysis pass writes a flag badge onto a card that is already on screen,
  // so the feed is re-read whenever a build finishes — whoever started it.
  useEffect(() => {
    if (runState?.status !== 'idle') return
    void window.electronAPI.play.get().then(setFeed).catch(() => undefined)
  }, [runState?.status])

  // Paint what is stored immediately, then refresh only if a refresh would
  // actually produce something different. Opening the tab costs nothing when
  // nothing has moved.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.play
      .get()
      .then((stored) => {
        if (cancelled) return
        setFeed(stored)
        if (stored.stale) void refresh(false)
      })
      .catch((err) => {
        if (!cancelled) setError(cleanError(err))
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  const react = useCallback(async (item: PlayItem, reaction: PlayReaction | null) => {
    try {
      setFeed(await window.electronAPI.play.react(item.id, reaction))
    } catch (err) {
      setError(cleanError(err))
    }
  }, [])

  const open = useCallback((item: PlayItem) => {
    if (item.embeddable) setPlaying(item)
    else void window.electronAPI.app.openExternal(item.url)
  }, [])

  const items = feed?.items ?? []
  const busy = refreshing || building

  // The feed arrives newest-batch-first and ranked within each batch, so the
  // grouping only has to preserve that order rather than re-sort anything.
  const batches = useMemo(() => {
    const groups: Array<{ batch: number; batchAt: number; items: PlayItem[] }> = []
    for (const item of items) {
      const current = groups[groups.length - 1]
      if (current && current.batch === item.batch) current.items.push(item)
      else groups.push({ batch: item.batch, batchAt: item.batchAt, items: [item] })
    }
    return groups
  }, [items])
  const refreshesLeft = feed
    ? Math.max(0, Math.floor((feed.searchUnitBudget - feed.searchUnitsUsedToday) / 1000))
    : null
  const message = error ?? (feed?.status !== 'ok' ? feed?.lastError ?? null : null)

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        icon={<FontAwesomeIcon icon={faPlay} className={PAGE_HEADER_ICON} />}
        title="Play"
        aside={
          feed && items.length > 0 ? (
            <span className="ml-1 flex items-center gap-2 text-[12px] text-white/30">
              <span>
                {batches[0]?.items.length ?? 0} new · {relativeTime(feed.generatedAt)}
              </span>
              {batches.length > 1 && (
                <span className="text-white/20">{items.length} kept</span>
              )}
              {feed.stale && <span className="text-holmes-primary-light/70">new picks available</span>}
            </span>
          ) : undefined
        }
        actions={
          <>
            {feed?.provenance && (
              <button
                onClick={() => setShowSources((open) => !open)}
                aria-pressed={showSources}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${
                  showSources
                    ? 'border-holmes-primary/40 bg-holmes-primary/10 text-holmes-primary-light'
                    : 'border-white/10 text-white/50 hover:border-white/25 hover:text-white/80'
                }`}
              >
                Why these?
              </button>
            )}
            {building ? (
              <button
                onClick={() => void stop()}
                title="Stop building"
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-amber-400/30 px-3 py-1.5 text-[12px] text-amber-200/80 transition-colors hover:border-amber-400/50"
              >
                <FontAwesomeIcon icon={faStop} />
                Stop
              </button>
            ) : (
              <button
                onClick={() => void refresh(true)}
                disabled={refreshing}
                title={
                  refreshesLeft !== null
                    ? `About ${refreshesLeft} refresh${refreshesLeft === 1 ? '' : 'es'} left today`
                    : undefined
                }
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-white/60 transition-colors hover:border-white/25 hover:text-white/90 disabled:cursor-default disabled:opacity-50"
              >
                <FontAwesomeIcon icon={faArrowRotateRight} className={refreshing ? 'animate-spin' : ''} />
                Refresh
              </button>
            )}
          </>
        }
        below={
          <div className="flex items-center gap-1.5">
            {PLAY_ITEM_KINDS.map((kind) => {
              const enabled = ENABLED_KINDS.includes(kind)
              return (
                <span
                  key={kind}
                  title={enabled ? undefined : 'Coming soon'}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                    enabled
                      ? 'border-holmes-primary/40 bg-holmes-primary/10 text-holmes-primary-light'
                      : 'border-white/[0.06] text-white/20'
                  }`}
                >
                  {KIND_LABEL[kind]}
                </span>
              )
            })}
          </div>
        }
      />

      {message && (
        <div className="mx-6 mt-4 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0 text-[12px] text-red-400/80" />
          <p className="flex-1 text-[12px] leading-relaxed text-red-200/70">{message}</p>
          <button
            onClick={() => void refresh(true)}
            className="shrink-0 cursor-pointer text-[12px] text-red-200/60 underline hover:text-red-200/90"
          >
            Retry
          </button>
        </div>
      )}

      {showSources && feed?.provenance && (
        <div className="mx-6 mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="mb-2 text-[12px] leading-relaxed text-white/45">
            Every pick is chosen against your own record, and each card says which part of it. This is the profile the
            whole feed was planned from.
          </p>
          <ProvenanceExplorer nodeRef="user:super-context" projectId={null} label="What this feed was built from" />
        </div>
      )}

      {items.length === 0 && !busy && feed ? (
        <EmptyState feed={feed} onOpenSettings={onOpenSettings} onOpenData={onOpenData} />
      ) : (
        <div className={`px-6 py-6 transition-opacity ${busy ? 'opacity-60' : ''}`}>
          {batches.map((batch, index) => (
            <section key={batch.batch} className={index > 0 ? 'mt-8' : ''}>
              {/* The newest batch needs no heading when it is the only one —
                  a lone "Just now" above a first feed is noise. */}
              {batches.length > 1 && (
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="shrink-0 text-[12px] font-medium uppercase tracking-wider text-white/35">
                    {index === 0 ? 'Latest' : relativeTime(batch.batchAt)}
                  </h2>
                  <span className="shrink-0 text-[11px] text-white/20">
                    {index === 0 ? relativeTime(batch.batchAt) : `${batch.items.length} picks`}
                  </span>
                  <span className="h-px flex-1 bg-white/[0.06]" />
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {batch.items.map((item) => (
                  <PlayCard
                    key={item.id}
                    item={item}
                    onPlay={open}
                    onReact={(target, reaction) => void react(target, reaction)}
                    onArchive={(target) => void archive(target)}
                    archiving={archivingIds.has(item.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {playing && (
        <PlayPlayer
          item={playing}
          onClose={() => setPlaying(null)}
          onProgress={() => {
            // Closing the player wrote a new position; re-read so the card's
            // progress bar matches where it was actually left.
            void window.electronAPI.play.get().then(setFeed).catch(() => undefined)
          }}
        />
      )}
    </div>
  )
}
