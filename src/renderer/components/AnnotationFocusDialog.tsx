import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import type { BookChapter, IndexEstimate } from '@shared/types'
import { ANNOTATION_FOCUSES, type AnnotationFocusKey } from '@shared/bookFocuses'
import { formatDuration, formatEstimateCost } from './IndexEstimateBar'

interface AnnotationFocusDialogProps {
  chapters: BookChapter[]
  currentChapter: number
  busy: boolean
  error: string | null
  onEstimate: (chapterStart: number, chapterEnd: number) => Promise<IndexEstimate | null>
  onSubmit: (focus: { key: AnnotationFocusKey; customText?: string }, chapterStart: number, chapterEnd: number) => void
  onClose: () => void
}

export const AnnotationFocusDialog: FC<AnnotationFocusDialogProps> = ({
  chapters,
  currentChapter,
  busy,
  error,
  onEstimate,
  onSubmit,
  onClose,
}) => {
  const [focusKey, setFocusKey] = useState<AnnotationFocusKey>('key_arguments')
  const [customText, setCustomText] = useState('')
  const [start, setStart] = useState(currentChapter)
  const [end, setEnd] = useState(currentChapter)
  const [estimate, setEstimate] = useState<IndexEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // The range changed, so any quoted price is now for a different job.
  useEffect(() => { setEstimate(null) }, [start, end])

  const runnable = start <= end && (focusKey !== 'custom' || customText.trim().length > 0)
  const tooLong = estimate?.truncatedAtCap ?? false

  const handleEstimate = async () => {
    setEstimating(true)
    try {
      setEstimate(await onEstimate(start, end))
    } finally {
      setEstimating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <h2 className="font-serif-display text-[17px] text-white/85">Annotate</h2>
          <button onClick={onClose} className="ml-auto cursor-pointer text-white/30 hover:text-white/70">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-3">
          <p className="mb-3 text-[11px] leading-relaxed text-white/40">
            The chapters you pick are sent to your AI provider so they can be annotated. This is the only time a book's
            text leaves this machine.
          </p>

          <label className="mb-1 block text-[9px] uppercase tracking-wider text-white/30">Focus</label>
          <div className="mb-3 space-y-1">
            {ANNOTATION_FOCUSES.map((focus) => (
              <button
                key={focus.key}
                onClick={() => setFocusKey(focus.key)}
                className={`block w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-colors ${
                  focusKey === focus.key
                    ? 'border-violet-400/35 bg-violet-400/[0.08]'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15'
                }`}
              >
                <div className="text-[12px] text-white/80">{focus.label}</div>
                <div className="text-[10px] leading-snug text-white/35">{focus.description}</div>
              </button>
            ))}
          </div>

          {focusKey === 'custom' && (
            <textarea
              value={customText}
              onChange={(event) => setCustomText(event.target.value)}
              rows={3}
              placeholder="What should Holmes look for? e.g. “Anything about how habits form, and any concrete protocol I could actually follow.”"
              className="mb-3 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[12px] text-white/75 outline-none placeholder:text-white/20 focus:border-violet-400/35"
            />
          )}

          <label className="mb-1 block text-[9px] uppercase tracking-wider text-white/30">Chapters</label>
          <div className="flex items-center gap-2">
            <select
              value={start}
              onChange={(event) => {
                const next = Number(event.target.value)
                setStart(next)
                if (next > end) setEnd(next)
              }}
              className="min-w-0 flex-1 cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 outline-none"
            >
              {chapters.map((chapter) => (
                <option key={chapter.spineIndex} value={chapter.spineIndex}>{chapter.title}</option>
              ))}
            </select>
            <span className="text-[11px] text-white/25">to</span>
            <select
              value={end}
              onChange={(event) => setEnd(Math.max(start, Number(event.target.value)))}
              className="min-w-0 flex-1 cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 outline-none"
            >
              {chapters.filter((chapter) => chapter.spineIndex >= start).map((chapter) => (
                <option key={chapter.spineIndex} value={chapter.spineIndex}>{chapter.title}</option>
              ))}
            </select>
          </div>

          {estimate && (
            <p className="mt-2 text-[10px] tabular-nums text-white/45">
              1 call · {formatEstimateCost(estimate.costUsd)} · ~{formatDuration(estimate.estimatedSeconds)}
              {estimate.pricingUnavailable && ' — this model has no published pricing'}
            </p>
          )}
          {tooLong && (
            <p className="mt-2 text-[10px] leading-relaxed text-amber-200/70">
              That range is too long to annotate in one pass. Nothing is truncated — pick fewer chapters and run them
              separately, so the whole of each one is actually read.
            </p>
          )}
          {error && <p className="mt-2 text-[10px] leading-relaxed text-red-200/75">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
          <button
            onClick={() => void handleEstimate()}
            disabled={!runnable || estimating || busy}
            className="cursor-pointer rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/50 transition-colors hover:border-white/20 hover:text-white/75 disabled:opacity-40"
          >
            {estimating ? 'Estimating…' : 'Estimate cost'}
          </button>
          <button
            onClick={() => onSubmit(focusKey === 'custom' ? { key: focusKey, customText } : { key: focusKey }, start, end)}
            disabled={!runnable || busy || tooLong}
            className="ml-auto cursor-pointer rounded-lg bg-holmes-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-holmes-primary-light disabled:opacity-40"
          >
            {busy ? 'Annotating…' : 'Annotate'}
          </button>
        </div>
      </div>
    </div>
  )
}
