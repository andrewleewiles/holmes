import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowUpRightFromSquare, faCircleInfo, faXmark } from '@fortawesome/free-solid-svg-icons'
import { formatClock } from '@shared/playFeed'
import type { PlayFlag, PlayItem } from '@shared/types'

const EMBED_ORIGIN = 'https://www.youtube-nocookie.com'

/** How often playback position is written back. Every tick would be absurd. */
const SAVE_INTERVAL_MS = 5000

/**
 * If the player has said nothing by now, the postMessage channel is not working
 * and the panel drops to its unsynced mode rather than sitting on 0:00 forever.
 */
const HANDSHAKE_TIMEOUT_MS = 4000

const FLAG_LABEL: Record<PlayFlag['kind'], string> = {
  unsupported: 'Unsupported',
  false: 'Incorrect',
  misleading: 'Misleading',
  bias: 'One-sided',
  omission: 'Missing context',
  outdated: 'Out of date',
  speculation: 'Speculation',
}

const SEVERITY_CLASS: Record<PlayFlag['severity'], string> = {
  high: 'border-red-400/40 bg-red-400/10 text-red-200/85',
  medium: 'border-amber-400/35 bg-amber-400/10 text-amber-100/85',
  low: 'border-white/15 bg-white/[0.04] text-white/60',
}

/**
 * The embed URL.
 *
 * `enablejsapi=1` is what opens the postMessage channel below. It does NOT load
 * YouTube's iframe_api script — that would need https://www.youtube.com in
 * script-src, which is a real widening of the policy and is why the API is
 * driven by raw postMessage here instead.
 *
 * There is deliberately NO `origin` parameter. It looks like it belongs next to
 * `enablejsapi`, but the player uses it as the postMessage TARGET: setting it to
 * anything other than this page's real origin sends every time update somewhere
 * nothing is listening, and the panel silently stops following playback. The
 * page's real origin (localhost in dev, opaque under file://) is not something
 * YouTube accepts, which is why the Referer is fixed in main.ts instead.
 *
 * THREE things are required for the player to work, and each fails silently on
 * its own: the frame-src CSP entry, the will-frame-navigate allowance in
 * main.ts, and the Referer injected by the onBeforeSendHeaders handler there.
 * Missing one of the first two gives a blank frame; missing the third gives
 * "Error 153 — Video player configuration error".
 */
function embedUrl(videoId: string, startSeconds: number): string {
  const params = new URLSearchParams({
    autoplay: '1',
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
    iv_load_policy: '3',
    enablejsapi: '1',
  })
  if (startSeconds > 1) params.set('start', String(Math.floor(startSeconds)))
  return `${EMBED_ORIGIN}/embed/${encodeURIComponent(videoId)}?${params.toString()}`
}

interface PlayPlayerProps {
  item: PlayItem
  onClose: () => void
  /** Fires when playback position is persisted, so cards can re-render. */
  onProgress: (positionSeconds: number, durationSeconds: number | null) => void
}

export const PlayPlayer: FC<PlayPlayerProps> = ({ item, onClose, onProgress }) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [currentTime, setCurrentTime] = useState(item.watch?.positionSeconds ?? 0)
  const [duration, setDuration] = useState<number | null>(item.durationSeconds)
  /** False until the player answers — see HANDSHAKE_TIMEOUT_MS. */
  const [synced, setSynced] = useState(false)
  const lastSavedAt = useRef(0)
  const latest = useRef({ time: currentTime, duration })

  const resumeAt = item.watch?.positionSeconds ?? 0
  const flags = useMemo(() => item.analysis?.flags ?? [], [item.analysis])

  const post = useCallback((message: Record<string, unknown>) => {
    const frame = frameRef.current
    if (!frame?.contentWindow) return
    frame.contentWindow.postMessage(JSON.stringify({ ...message, id: 1, channel: 'widget' }), EMBED_ORIGIN)
  }, [])

  const seekTo = useCallback(
    (seconds: number) => {
      if (synced) {
        post({ event: 'command', func: 'seekTo', args: [Math.floor(seconds), true] })
        setCurrentTime(seconds)
        return
      }
      // Without the channel there is no way to move the embedded player, so the
      // timestamp opens where it definitely works rather than doing nothing.
      void window.electronAPI.app.openExternal(`${item.url}&t=${Math.floor(seconds)}s`)
    },
    [item.url, post, synced]
  )

  // The player only sends infoDelivery messages once something is listening.
  useEffect(() => {
    const handshake = window.setInterval(() => post({ event: 'listening' }), 500)
    const giveUp = window.setTimeout(() => window.clearInterval(handshake), HANDSHAKE_TIMEOUT_MS)
    return () => {
      window.clearInterval(handshake)
      window.clearTimeout(giveUp)
    }
  }, [post])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== EMBED_ORIGIN) return
      let payload: { event?: string; info?: { currentTime?: unknown; duration?: unknown } }
      try {
        payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      const info = payload?.info
      if (!info) return

      if (typeof info.currentTime === 'number' && Number.isFinite(info.currentTime)) {
        setSynced(true)
        setCurrentTime(info.currentTime)
        latest.current.time = info.currentTime
      }
      if (typeof info.duration === 'number' && info.duration > 0) {
        setDuration(info.duration)
        latest.current.duration = info.duration
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Persist on a timer rather than on every tick, and once more on the way out
  // so closing at 4:59 does not round back to the last five-second mark.
  useEffect(() => {
    if (!synced) return
    const now = Date.now()
    if (now - lastSavedAt.current < SAVE_INTERVAL_MS) return
    lastSavedAt.current = now
    void window.electronAPI.play.setProgress(item.id, currentTime, duration)
  }, [currentTime, duration, item.id, synced])

  useEffect(() => {
    const captured = latest
    const id = item.id
    return () => {
      if (captured.current.time <= 0) return
      void window.electronAPI.play
        .setProgress(id, captured.current.time, captured.current.duration)
        .then(() => onProgress(captured.current.time, captured.current.duration))
    }
  }, [item.id, onProgress])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const openExternally = (): void => {
    void window.electronAPI.app.openExternal(item.url)
  }

  // The flag being spoken right now: the latest one whose timestamp has passed,
  // and only for a while after it, so a flag at 2:14 is not still highlighted at
  // 40:00 for want of a later one.
  const activeFlagId = useMemo(() => {
    if (!synced) return null
    let active: PlayFlag | null = null
    for (const flag of flags) {
      if (flag.startSeconds <= currentTime + 0.5) active = flag
    }
    if (!active) return null
    return currentTime - active.startSeconds < 25 ? active.id : null
  }, [currentTime, flags, synced])

  const analysis = item.analysis
  const total = duration ?? item.durationSeconds

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-[1400px] flex-col p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] text-white/85">{item.title}</h2>
            {item.creator && <p className="truncate text-[12px] text-white/40">{item.creator}</p>}
          </div>
          {resumeAt > 5 && (
            <span className="shrink-0 self-center text-[11px] text-white/35">
              resumed at {formatClock(resumeAt)}
            </span>
          )}
          {/* Always present, never conditional. A video the platform refuses to
              embed renders YouTube's own "unavailable" notice inside the frame
              and fires no catchable cross-origin event, so there is no reliable
              way to detect it and offer this only when needed. */}
          <button
            onClick={openExternally}
            className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/60 transition-colors hover:border-white/30 hover:text-white/85"
          >
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
            Watch on YouTube
          </button>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="shrink-0 cursor-pointer rounded-lg px-2.5 py-1.5 text-[14px] text-white/40 transition-colors hover:bg-white/5 hover:text-white/80"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black">
              {item.embeddable ? (
                <iframe
                  ref={frameRef}
                  key={item.id}
                  src={embedUrl(item.externalId, resumeAt)}
                  title={item.title}
                  className="h-full w-full"
                  // No sandbox attribute: the player needs scripts, same-origin
                  // and popups, and a wrong list black-screens it with no error.
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                  // No referrerPolicy: whatever this element asked for, the
                  // onBeforeSendHeaders handler in main.ts overwrites the header
                  // afterwards, so a policy here would only be misleading.
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="text-[14px] text-white/60">This video cannot be played inside an app.</p>
                  <button
                    onClick={openExternally}
                    className="cursor-pointer rounded-lg bg-holmes-primary/20 px-4 py-2 text-[13px] text-holmes-primary-light transition-colors hover:bg-holmes-primary/30"
                  >
                    Watch on YouTube
                  </button>
                </div>
              )}
            </div>

            {/* The flag ruler. Marks sit where the claims are, so the shape of a
                video's problems is visible before watching any of it. */}
            {total !== null && total > 0 && flags.length > 0 && (
              <div className="relative mt-2 h-4 w-full">
                <div className="absolute inset-x-0 top-1.5 h-[3px] overflow-hidden rounded-full bg-white/10">
                  {synced && (
                    <div
                      className="h-full rounded-full bg-white/35 transition-all"
                      style={{ width: `${Math.min(100, (currentTime / total) * 100)}%` }}
                    />
                  )}
                </div>
                {flags.map((flag) => (
                  <button
                    key={flag.id}
                    onClick={() => seekTo(flag.startSeconds)}
                    title={`${formatClock(flag.startSeconds)} — ${FLAG_LABEL[flag.kind]}`}
                    style={{ left: `${Math.min(99, (flag.startSeconds / total) * 100)}%` }}
                    className={`absolute top-0 h-4 w-[3px] -translate-x-1/2 cursor-pointer rounded-full transition-transform hover:scale-y-125 ${
                      flag.severity === 'high'
                        ? 'bg-red-400/80'
                        : flag.severity === 'medium'
                          ? 'bg-amber-400/80'
                          : 'bg-white/40'
                    } ${activeFlagId === flag.id ? 'scale-y-150' : ''}`}
                  />
                ))}
              </div>
            )}

            {item.rationale && (
              <p className="pt-2 text-[13px] leading-relaxed text-holmes-primary-light/70">{item.rationale}</p>
            )}
          </div>

          <aside className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
            <div className="border-b border-white/[0.06] px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-white/35">What to watch for</p>
              {analysis?.summary && (
                <p className="mt-1.5 text-[12px] leading-relaxed text-white/55">{analysis.summary}</p>
              )}
              {!synced && item.embeddable && flags.length > 0 && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-white/30">
                  <FontAwesomeIcon icon={faCircleInfo} className="mt-0.5 shrink-0" />
                  Not synced to playback. Clicking a flag opens YouTube at that moment.
                </p>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
              {analysis === null || analysis.status === 'pending' ? (
                <p className="px-1.5 py-2 text-[12px] text-white/35">Not reviewed yet.</p>
              ) : analysis.status === 'no-transcript' ? (
                <p className="px-1.5 py-2 text-[12px] leading-relaxed text-white/35">
                  This video has no captions, so there was nothing to review.
                </p>
              ) : analysis.status !== 'ok' ? (
                <p className="px-1.5 py-2 text-[12px] leading-relaxed text-white/35">
                  {analysis.error ?? 'The review could not be completed.'}
                </p>
              ) : flags.length === 0 ? (
                <p className="px-1.5 py-2 text-[12px] leading-relaxed text-white/45">
                  Nothing stood out as unsupported or one-sided.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {flags.map((flag) => (
                    <li key={flag.id}>
                      <button
                        onClick={() => seekTo(flag.startSeconds)}
                        className={`w-full rounded-lg border p-2 text-left transition-all cursor-pointer ${SEVERITY_CLASS[flag.severity]} ${
                          activeFlagId === flag.id ? 'ring-1 ring-white/40' : 'opacity-80 hover:opacity-100'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] tabular-nums opacity-70">
                            {formatClock(flag.startSeconds)}
                          </span>
                          <span className="text-[10px] font-medium uppercase tracking-wider">
                            {FLAG_LABEL[flag.kind]}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] italic leading-snug opacity-70">“{flag.quote}”</p>
                        <p className="mt-1 text-[12px] leading-relaxed">{flag.note}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
