import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudiobookChapter } from '@shared/types'
import { wordIndexAt } from '@shared/audiobookTiming'

/**
 * Plays a chapter's narration and reports which word is being spoken.
 *
 * Two things here are deliberate:
 *
 * 1. **Two audio elements, not one.** A chapter is several files (each model has
 *    a per-request character cap), and switching `src` on a single element
 *    stalls while the next one buffers. The idle element preloads the next
 *    segment so the handover at a segment boundary is a swap, not a download.
 *
 * 2. **requestAnimationFrame, not `timeupdate`.** `timeupdate` fires about four
 *    times a second; spoken words average nearer three. Polling `currentTime` on
 *    a frame gives a highlight that lands on the word being said rather than
 *    trailing it by a beat. The loop only runs while playing.
 */
export interface AudiobookPlayerState {
  available: boolean
  playing: boolean
  /** Seconds into the whole chapter. */
  currentTime: number
  durationSeconds: number
  rate: number
  /** Canonical offsets of the word being spoken, or null between words. */
  word: { start: number; end: number } | null
  error: string | null
  loading: boolean
}

export interface AudiobookPlayerControls {
  play: () => void
  pause: () => void
  toggle: () => void
  /** Seek to a point in the chapter, in seconds. */
  seek: (seconds: number) => void
  /** Seek to whichever word covers a canonical offset — click-a-word-to-play. */
  seekToOffset: (offset: number) => void
  skip: (deltaSeconds: number) => void
  setRate: (rate: number) => void
  stop: () => void
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export { PLAYBACK_RATES }

export function useAudiobookPlayer(chapter: AudiobookChapter | null): [AudiobookPlayerState, AudiobookPlayerControls] {
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [rate, setRateState] = useState(1)
  const [word, setWord] = useState<{ start: number; end: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // `active` is the element that is sounding; `spare` holds the next segment.
  const active = useRef<HTMLAudioElement | null>(null)
  const spare = useRef<HTMLAudioElement | null>(null)
  const segmentIndex = useRef(0)
  const frame = useRef<number | null>(null)
  const shouldPlay = useRef(false)

  const segments = useMemo(() => chapter?.segments ?? [], [chapter])
  const durationSeconds = chapter?.audiobook.durationSeconds ?? 0
  const available = segments.length > 0 && chapter?.audiobook.status === 'ready'

  useEffect(() => {
    const a = new Audio()
    const b = new Audio()
    a.preload = 'auto'
    b.preload = 'auto'
    active.current = a
    spare.current = b
    return () => {
      a.pause()
      b.pause()
      a.src = ''
      b.src = ''
      active.current = null
      spare.current = null
    }
  }, [])

  const primeSpare = useCallback((nextIndex: number) => {
    const element = spare.current
    const next = segments[nextIndex]
    if (!element) return
    if (!next) { element.removeAttribute('src'); return }
    if (element.src !== next.url) {
      element.src = next.url
      element.load()
    }
  }, [segments])

  const loadSegment = useCallback((index: number, offsetWithin: number, autoplay: boolean) => {
    const element = active.current
    const segment = segments[index]
    if (!element || !segment) return
    segmentIndex.current = index
    if (element.src !== segment.url) {
      setLoading(true)
      element.src = segment.url
    }
    const applyTime = () => {
      try { element.currentTime = Math.max(0, offsetWithin) } catch { /* not seekable yet */ }
      setLoading(false)
      if (autoplay) void element.play().catch(() => setPlaying(false))
    }
    if (element.readyState >= 1) applyTime()
    else element.addEventListener('loadedmetadata', applyTime, { once: true })
    primeSpare(index + 1)
  }, [segments, primeSpare])

  // A new chapter (or a regenerated one) resets the transport.
  useEffect(() => {
    shouldPlay.current = false
    setPlaying(false)
    setCurrentTime(0)
    setWord(null)
    setError(null)
    segmentIndex.current = 0
    const element = active.current
    if (element) { element.pause(); element.removeAttribute('src') }
    const other = spare.current
    if (other) { other.pause(); other.removeAttribute('src') }
    if (available) loadSegment(0, 0, false)
  }, [chapter?.audiobook.id, available])

  // The frame loop: read the clock, place the word, and hand over at the end of
  // a segment. Everything the highlight depends on is derived here.
  useEffect(() => {
    if (!playing) {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      return
    }
    const step = () => {
      const element = active.current
      const segment = segments[segmentIndex.current]
      if (element && segment) {
        const local = element.currentTime
        setCurrentTime(segment.offsetSeconds + local)
        const index = wordIndexAt(segment.words, local)
        setWord(index === -1
          ? null
          : { start: segment.words.charStart[index], end: segment.words.charEnd[index] })
      }
      frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [playing, segments])

  // Segment handover.
  useEffect(() => {
    const element = active.current
    if (!element) return
    const onEnded = () => {
      const next = segmentIndex.current + 1
      if (next >= segments.length) {
        shouldPlay.current = false
        setPlaying(false)
        setWord(null)
        return
      }
      // Swap roles rather than reloading: the spare already holds this file.
      const finished = active.current
      active.current = spare.current
      spare.current = finished
      segmentIndex.current = next
      const nowActive = active.current
      if (nowActive) {
        nowActive.playbackRate = rate
        void nowActive.play().catch(() => setPlaying(false))
      }
      primeSpare(next + 1)
    }
    const onError = () => {
      setError('That narration file could not be played. Regenerate the chapter.')
      setPlaying(false)
    }
    const onWaiting = () => setLoading(true)
    const onPlaying = () => setLoading(false)

    element.addEventListener('ended', onEnded)
    element.addEventListener('error', onError)
    element.addEventListener('waiting', onWaiting)
    element.addEventListener('playing', onPlaying)
    return () => {
      element.removeEventListener('ended', onEnded)
      element.removeEventListener('error', onError)
      element.removeEventListener('waiting', onWaiting)
      element.removeEventListener('playing', onPlaying)
    }
    // Re-bound whenever the elements swap, which `playing` reliably follows.
  }, [segments, rate, playing, primeSpare])

  const play = useCallback(() => {
    const element = active.current
    if (!element || !available) return
    if (!element.src) loadSegment(segmentIndex.current, 0, true)
    else void element.play().catch(() => setPlaying(false))
    element.playbackRate = rate
    shouldPlay.current = true
    setPlaying(true)
  }, [available, loadSegment, rate])

  const pause = useCallback(() => {
    active.current?.pause()
    shouldPlay.current = false
    setPlaying(false)
  }, [])

  const toggle = useCallback(() => { if (playing) pause(); else play() }, [playing, play, pause])

  const seek = useCallback((seconds: number) => {
    if (segments.length === 0) return
    const target = Math.max(0, Math.min(seconds, durationSeconds))
    // The last segment whose start is at or before the target: an exact
    // arithmetic lookup, so scrubbing never lands in the wrong file.
    let index = 0
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i].offsetSeconds <= target) index = i
      else break
    }
    const segment = segments[index]
    const within = target - segment.offsetSeconds
    setCurrentTime(target)
    if (index === segmentIndex.current && active.current?.src === segment.url) {
      try { active.current.currentTime = within } catch { /* not seekable yet */ }
      if (shouldPlay.current) void active.current.play().catch(() => setPlaying(false))
    } else {
      loadSegment(index, within, shouldPlay.current)
    }
  }, [segments, durationSeconds, loadSegment])

  const seekToOffset = useCallback((offset: number) => {
    for (const segment of segments) {
      if (offset < segment.charStart || offset > segment.charEnd) continue
      const { charStart, charEnd, startSeconds } = segment.words
      for (let i = 0; i < charStart.length; i += 1) {
        // The word covering the offset, or the first one after it — clicking a
        // space should start at the next word rather than do nothing.
        if (offset <= charEnd[i]) {
          seek(segment.offsetSeconds + startSeconds[i])
          return
        }
      }
      seek(segment.offsetSeconds)
      return
    }
  }, [segments, seek])

  const skip = useCallback((delta: number) => seek(currentTime + delta), [seek, currentTime])

  const setRate = useCallback((next: number) => {
    setRateState(next)
    if (active.current) active.current.playbackRate = next
    if (spare.current) spare.current.playbackRate = next
  }, [])

  const stop = useCallback(() => {
    pause()
    seek(0)
    setWord(null)
  }, [pause, seek])

  return [
    { available, playing, currentTime, durationSeconds, rate, word, error, loading },
    { play, pause, toggle, seek, seekToOffset, skip, setRate, stop },
  ]
}
