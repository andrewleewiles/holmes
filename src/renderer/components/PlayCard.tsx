import { type FC, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faBook,
  faBrain,
  faCircleCheck,
  faClockRotateLeft,
  faDatabase,
  faDownload,
  faFlag,
  faFloppyDisk,
  faNewspaper,
  faPlay,
  faSitemap,
  faThumbsDown,
  faThumbsUp,
  faTimeline,
  faUser,
} from '@fortawesome/free-solid-svg-icons'
import type { PlayItem, PlayReaction, PlaySourceRefKind } from '@shared/types'
import { ProvenanceExplorer } from './ProvenanceExplorer'

const REF_ICON: Record<PlaySourceRefKind, typeof faBrain> = {
  'super-context': faSitemap,
  'memory-field': faBrain,
  timeline: faTimeline,
  person: faUser,
  'watch-history': faClockRotateLeft,
  book: faBook,
  project: faDatabase,
  reaction: faThumbsUp,
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** No thumbnail is a typographic tile, not a grey box. */
const ThumbFallback: FC<{ title: string; creator: string | null }> = ({ title, creator }) => (
  <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-holmes-primary/20 to-white/[0.03] p-3">
    <span className="font-serif-display text-[14px] leading-tight text-white/75 line-clamp-3">{title}</span>
    {creator && <span className="text-[9px] uppercase tracking-wider text-white/30 line-clamp-1">{creator}</span>}
  </div>
)

interface PlayCardProps {
  item: PlayItem
  onPlay: (item: PlayItem) => void
  onReact: (item: PlayItem, reaction: PlayReaction | null) => void
  onArchive: (item: PlayItem) => void
  /** True while yt-dlp is downloading this one. */
  archiving: boolean
}

/**
 * One suggestion. The rationale is the point of the card — it is the thing a
 * public recommender cannot show you, so it sits under the title rather than
 * behind a hover, and the facts behind it are one click away.
 */
export const PlayCard: FC<PlayCardProps> = ({ item, onPlay, onReact, onArchive, archiving }) => {
  const [openRef, setOpenRef] = useState<string | null>(null)
  const duration = formatDuration(item.durationSeconds)
  const drillable = item.sourceRefs.find((ref) => ref.ref === openRef && ref.drillable)

  const total = item.watch?.durationSeconds ?? item.durationSeconds
  const watchedFraction =
    item.watch && total && total > 0 ? Math.min(1, item.watch.furthestSeconds / total) : null
  const finished = item.watch?.completedAt !== null && item.watch?.completedAt !== undefined

  const flags = item.analysis?.flags ?? []
  const flagCount = flags.length
  const worstSeverity = flags.some((flag) => flag.severity === 'high')
    ? 'high'
    : flags.some((flag) => flag.severity === 'medium')
      ? 'medium'
      : 'low'

  const archived = item.archive?.status === 'done'

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.02] transition-colors hover:border-white/20">
      <button
        onClick={() => onPlay(item)}
        className="group relative aspect-video w-full cursor-pointer overflow-hidden bg-black/30 text-left"
        title={item.embeddable ? 'Play here' : 'Open on YouTube'}
      >
        {item.thumbnailMediaId ? (
          <img
            src={`holmes-media://thumb/${item.thumbnailMediaId}`}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <ThumbFallback title={item.title} creator={item.creator} />
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/35">
          <FontAwesomeIcon
            icon={faPlay}
            className="text-[22px] text-white/0 drop-shadow transition-colors group-hover:text-white/90"
          />
        </span>
        {duration && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] text-white/85">
            {duration}
          </span>
        )}
        {/* How far in you got, in the place every video player puts it. Driven by
            furthestSeconds, so rewatching a section never shortens the bar. */}
        {watchedFraction !== null && (
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/50">
            <span
              className={`block h-full ${finished ? 'bg-emerald-400/70' : 'bg-holmes-primary'}`}
              style={{ width: `${Math.round(watchedFraction * 100)}%` }}
            />
          </span>
        )}
        {flagCount > 0 && (
          <span
            title={`${flagCount} claim${flagCount === 1 ? '' : 's'} worth checking`}
            className={`absolute left-1.5 top-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] backdrop-blur-sm ${
              worstSeverity === 'high' ? 'bg-red-500/80 text-white' : 'bg-amber-400/85 text-black/80'
            }`}
          >
            <FontAwesomeIcon icon={faFlag} className="text-[8px]" />
            {flagCount}
          </span>
        )}
        {item.analysis?.status === 'ok' && flagCount === 0 && (
          <span
            title="Nothing stood out as unsupported or one-sided"
            className="absolute left-1.5 top-1.5 rounded bg-emerald-500/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm"
          >
            <FontAwesomeIcon icon={faCircleCheck} className="text-[9px]" />
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div>
          <h3 className="text-[14px] leading-snug text-white/85 line-clamp-2">{item.title}</h3>
          {item.creator && <p className="mt-0.5 text-[12px] text-white/40 line-clamp-1">{item.creator}</p>}
        </div>

        {item.rationale && (
          <p className="text-[12px] leading-relaxed text-holmes-primary-light/80">{item.rationale}</p>
        )}

        {item.sourceRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.sourceRefs.map((ref) => (
              <button
                key={ref.ref}
                onClick={() => setOpenRef((current) => (current === ref.ref ? null : ref.ref))}
                title={ref.detail}
                className={`flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                  openRef === ref.ref
                    ? 'border-holmes-primary/40 bg-holmes-primary/10 text-holmes-primary-light'
                    : 'border-white/10 bg-white/[0.03] text-white/40 hover:text-white/70'
                } ${ref.drillable ? 'cursor-pointer' : 'cursor-help'}`}
              >
                <FontAwesomeIcon icon={REF_ICON[ref.kind]} className="shrink-0 text-[9px]" />
                <span className="truncate">{ref.label}</span>
              </button>
            ))}
          </div>
        )}

        {openRef && (
          <div className="rounded border border-white/10 bg-black/20 p-2">
            <p className="text-[11px] leading-relaxed text-white/50">
              {item.sourceRefs.find((ref) => ref.ref === openRef)?.detail}
            </p>
            {/* Only refs the chain resolver understands drill further. The rest
                are terminal: their detail above is the whole of the evidence. */}
            {drillable && (
              <div className="mt-2">
                <ProvenanceExplorer nodeRef={drillable.ref} projectId={null} label="Built from" depth={1} />
              </div>
            )}
          </div>
        )}

        <div className="mt-auto flex items-center gap-1 pt-1">
          <button
            onClick={() => onReact(item, item.reaction === 'up' ? null : 'up')}
            title="More like this"
            aria-pressed={item.reaction === 'up'}
            className={`cursor-pointer rounded px-2 py-1 text-[11px] transition-colors ${
              item.reaction === 'up'
                ? 'bg-holmes-primary/15 text-holmes-primary-light'
                : 'text-white/30 hover:bg-white/[0.04] hover:text-white/60'
            }`}
          >
            <FontAwesomeIcon icon={faThumbsUp} />
          </button>
          <button
            onClick={() => onReact(item, item.reaction === 'down' ? null : 'down')}
            title="Not for me — and do not suggest this again"
            aria-pressed={item.reaction === 'down'}
            className={`cursor-pointer rounded px-2 py-1 text-[11px] transition-colors ${
              item.reaction === 'down'
                ? 'bg-white/10 text-white/70'
                : 'text-white/30 hover:bg-white/[0.04] hover:text-white/60'
            }`}
          >
            <FontAwesomeIcon icon={faThumbsDown} />
          </button>
          <button
            onClick={() => onArchive(item)}
            disabled={archiving || archived}
            title={
              archived
                ? `Archived to the Videos source${item.archive?.byteSize ? ` — ${(item.archive.byteSize / 1_000_000_000).toFixed(2)} GB` : ''}`
                : item.archive?.error
                  ? `Archiving failed: ${item.archive.error}`
                  : 'Download to the Videos source'
            }
            className={`cursor-pointer rounded px-2 py-1 text-[11px] transition-colors disabled:cursor-default ${
              archived
                ? 'text-emerald-300/70'
                : item.archive?.status === 'failed'
                  ? 'text-red-400/60 hover:bg-white/[0.04]'
                  : 'text-white/30 hover:bg-white/[0.04] hover:text-white/60'
            }`}
          >
            <FontAwesomeIcon
              icon={archived ? faFloppyDisk : faDownload}
              className={archiving ? 'animate-pulse' : ''}
            />
          </button>
          {!item.embeddable && (
            <span className="ml-auto text-[10px] text-white/25" title="This video cannot be played inside an app">
              <FontAwesomeIcon icon={faNewspaper} className="mr-1" />
              opens externally
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
