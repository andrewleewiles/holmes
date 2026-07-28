import { type FC, useRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faGaugeHigh,
  faPause,
  faPlay,
  faRotateLeft,
  faRotateRight,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import type { AudiobookChapter } from '@shared/types'
import { PLAYBACK_RATES, type AudiobookPlayerControls, type AudiobookPlayerState } from '../hooks/useAudiobookPlayer'

interface AudiobookBarProps {
  chapter: AudiobookChapter
  state: AudiobookPlayerState
  controls: AudiobookPlayerControls
  onClose: () => void
  onRegenerate: () => void
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

const CONTROL =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white/85'

export const AudiobookBar: FC<AudiobookBarProps> = ({ chapter, state, controls, onClose, onRegenerate }) => {
  const scrubRef = useRef<HTMLDivElement>(null)
  const progress = state.durationSeconds > 0 ? (state.currentTime / state.durationSeconds) * 100 : 0

  const scrubTo = (clientX: number) => {
    const bar = scrubRef.current
    if (!bar) return
    const box = bar.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width))
    controls.seek(ratio * state.durationSeconds)
  }

  return (
    <div className="shrink-0 border-t border-white/[0.08] bg-holmes-surface/80 backdrop-blur">
      {chapter.stale && (
        // The offsets were measured against text that has since moved, so the
        // highlight would land on the wrong words. Said plainly rather than
        // quietly drifting.
        <div className="flex items-center gap-2 border-b border-amber-400/15 bg-amber-400/[0.07] px-6 py-1.5 text-[10px] text-amber-200/80">
          <FontAwesomeIcon icon={faTriangleExclamation} />
          <span>This book changed after it was narrated, so the highlighting may not line up.</span>
          <button onClick={onRegenerate} className="cursor-pointer underline underline-offset-2 hover:text-amber-100">
            Regenerate
          </button>
        </div>
      )}

      <div
        ref={scrubRef}
        onMouseDown={(event) => {
          scrubTo(event.clientX)
          const move = (moveEvent: MouseEvent) => scrubTo(moveEvent.clientX)
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        }}
        className="group relative h-1.5 w-full cursor-pointer bg-white/[0.06]"
        title="Scrub"
      >
        <div className="h-full bg-holmes-primary/70 transition-[width] duration-100" style={{ width: `${progress}%` }} />
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-holmes-primary opacity-0 transition-opacity group-hover:opacity-100"
          style={{ left: `${progress}%` }}
        />
      </div>

      <div className="flex items-center gap-2 px-6 py-2.5">
        <button onClick={() => controls.skip(-15)} title="Back 15 seconds" className={CONTROL}>
          <FontAwesomeIcon icon={faRotateLeft} className="text-[12px]" />
        </button>
        <button
          onClick={controls.toggle}
          title={state.playing ? 'Pause' : 'Play'}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-holmes-primary text-white transition-colors hover:bg-holmes-primary-light"
        >
          <FontAwesomeIcon icon={state.playing ? faPause : faPlay} className={state.playing ? '' : 'ml-0.5'} />
        </button>
        <button onClick={() => controls.skip(15)} title="Forward 15 seconds" className={CONTROL}>
          <FontAwesomeIcon icon={faRotateRight} className="text-[12px]" />
        </button>

        <span className="ml-1 shrink-0 text-[11px] tabular-nums text-white/45">
          {clock(state.currentTime)} <span className="text-white/20">/</span> {clock(state.durationSeconds)}
        </span>

        <div className="mx-3 min-w-0 flex-1">
          <div className="truncate text-[11px] text-white/60">{chapter.audiobook.voiceName || 'Narration'}</div>
          <div className="truncate text-[9px] text-white/25">
            {state.loading
              ? 'Buffering…'
              : state.error
                ? state.error
                : `${chapter.audiobook.provider === 'speechify' ? 'Speechify' : 'ElevenLabs'} · ${chapter.audiobook.modelId}`}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <FontAwesomeIcon icon={faGaugeHigh} className="text-[10px] text-white/25" />
          <select
            value={state.rate}
            onChange={(event) => controls.setRate(Number(event.target.value))}
            title="Playback speed"
            className="cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[10px] tabular-nums text-white/60 outline-none hover:border-white/20"
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={rate}>{rate}×</option>
            ))}
          </select>
        </div>

        <button onClick={onClose} title="Close the player" className={CONTROL}>
          <FontAwesomeIcon icon={faXmark} className="text-[12px]" />
        </button>
      </div>
    </div>
  )
}
