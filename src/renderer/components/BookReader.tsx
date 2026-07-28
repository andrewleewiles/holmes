import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronLeft,
  faChevronRight,
  faCircleCheck,
  faList,
  faHeadphones,
  faMinus,
  faNoteSticky,
  faPlus,
} from '@fortawesome/free-solid-svg-icons'
import type {
  Book,
  BookAnnotation,
  BookAnnotationRun,
  BookChapter,
  BookChapterContent,
  BookCitation,
  BookLesson,
  BookLessonStep,
  BookReadingState,
} from '@shared/types'
import { annotationFocus, type AnnotationFocusKey } from '@shared/bookFocuses'
import { sentenceSpanAt } from '@shared/audiobookTiming'
import type { AudiobookChapter, SpeechProviderId, SpeechVoice } from '@shared/types'
import { AudiobookBar } from './AudiobookBar'
import { NarrationDialog } from './NarrationDialog'
import { useAudiobookPlayer } from '../hooks/useAudiobookPlayer'
import { BookBlockView } from './BookBlockView'
import { BookMarginPanel } from './BookMarginPanel'
import { AnnotationFocusDialog } from './AnnotationFocusDialog'
import { LessonView } from './LessonView'
import { useSettings } from '../hooks/useSettings'
import { useLibraryRun } from '../hooks/useLibraryRun'

interface BookReaderProps {
  bookId: string
  onBack: () => void
  /** Hands a book/chapter-scoped conversation to the chat stack. */
  onDiscuss: (bookId: string, chapterIndex: number, lessonId?: string, stepId?: string) => Promise<void>
}

/** Debounce before a scroll position is written — a paint is not a decision. */
const PROGRESS_SAVE_MS = 2000
/** A session that stops being touched for this long has ended. */
const SESSION_IDLE_MS = 5 * 60 * 1000
const FONT_STEPS = [16, 17, 18, 19, 21, 23, 25]

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

export const BookReader: FC<BookReaderProps> = ({ bookId, onBack, onDiscuss }) => {
  const [book, setBook] = useState<Book | null>(null)
  const [chapters, setChapters] = useState<BookChapter[]>([])
  const [reading, setReading] = useState<BookReadingState | null>(null)
  const [content, setContent] = useState<BookChapterContent | null>(null)
  const [chapterIndex, setChapterIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [fontStep, setFontStep] = useState(3)
  const [pendingAnchor, setPendingAnchor] = useState<string | undefined>(undefined)
  const [annotations, setAnnotations] = useState<BookAnnotation[]>([])
  const [runs, setRuns] = useState<BookAnnotationRun[]>([])
  const [lessons, setLessons] = useState<BookLesson[]>([])
  const [activeAnnotation, setActiveAnnotation] = useState<string | null>(null)
  const [marginOpen, setMarginOpen] = useState(true)
  const [focusDialogOpen, setFocusDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [openLesson, setOpenLesson] = useState<BookLesson | null>(null)
  const [pendingOffset, setPendingOffset] = useState<number | null>(null)
  const [audiobook, setAudiobook] = useState<AudiobookChapter | null>(null)
  const [narrationOpen, setNarrationOpen] = useState(false)
  const [narrationError, setNarrationError] = useState<string | null>(null)
  const [narrating, setNarrating] = useState(false)
  const [narrationProgress, setNarrationProgress] = useState<string | null>(null)
  const [playerOpen, setPlayerOpen] = useState(false)
  const { settings } = useSettings()
  const runState = useLibraryRun()
  const generating = runState?.status === 'generating'
  const tier = settings?.defaultTier ?? 'mid'

  const scrollRef = useRef<HTMLDivElement>(null)
  const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const saveTimer = useRef<number | null>(null)
  // A session is opened by the first real scroll and closed on unmount, idleness
  // or blur. Sessions are the evidence the reading-record context summarizes:
  // a progress number says what was read, sessions say how.
  const session = useRef<{ startedAt: string; startOffset: number; startChapter: number; lastActivity: number } | null>(null)
  const latestOffset = useRef(0)

  const flushSession = useCallback(() => {
    const current = session.current
    session.current = null
    if (!current) return
    const seconds = Math.round((Date.now() - new Date(current.startedAt).getTime()) / 1000)
    if (seconds < 5) return
    void window.electronAPI.library.recordSession({
      bookId,
      startedAt: current.startedAt,
      endedAt: new Date().toISOString(),
      chapterStart: current.startChapter,
      chapterEnd: chapterIndex,
      charsAdvanced: Math.max(0, latestOffset.current - current.startOffset),
      seconds: Math.min(seconds, 6 * 60 * 60),
    }).catch(() => { /* A lost session must never interrupt reading. */ })
  }, [bookId, chapterIndex])

  // Load the book and resume where reading stopped.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.library
      .getBook(bookId)
      .then((result) => {
        if (cancelled) return
        setBook(result.book)
        setChapters(result.chapters)
        setReading(result.reading)
        setChapterIndex(Math.min(result.reading.lastChapterIndex, Math.max(0, result.chapters.length - 1)))
        latestOffset.current = result.reading.lastCharOffset
      })
      .catch((err) => { if (!cancelled) setError(cleanError(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bookId])

  const loadArtifacts = useCallback(async () => {
    try {
      const [nextAnnotations, nextRuns, nextLessons] = await Promise.all([
        window.electronAPI.library.listAnnotations(bookId),
        window.electronAPI.library.listAnnotationRuns(bookId),
        window.electronAPI.library.listLessons(bookId),
      ])
      setAnnotations(nextAnnotations)
      setRuns(nextRuns)
      setLessons(nextLessons)
    } catch {
      // Annotations are an overlay: failing to load them must not stop reading.
    }
  }, [bookId])

  useEffect(() => { void loadArtifacts() }, [loadArtifacts])

  // Narration is per chapter, so it reloads with the chapter rather than with
  // the book.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.library
      .getAudiobook(bookId, chapterIndex)
      .then((result) => {
        if (cancelled) return
        setAudiobook(result?.audiobook.status === 'ready' ? result : null)
        if (result?.audiobook.status === 'ready') setPlayerOpen(true)
      })
      .catch(() => { if (!cancelled) setAudiobook(null) })
    return () => { cancelled = true }
  }, [bookId, chapterIndex])

  useEffect(() => window.electronAPI.library.onAudiobookProgress((progress) => {
    setNarrationProgress(progress.phase === 'complete' ? null : progress.message)
  }), [])

  // Load one chapter at a time: a whole book across the bridge would be tens of MB.
  useEffect(() => {
    if (!book) return
    let cancelled = false
    setContent(null)
    window.electronAPI.library
      .getChapter(bookId, chapterIndex)
      .then((result) => { if (!cancelled) setContent(result) })
      .catch((err) => { if (!cancelled) setError(cleanError(err)) })
    return () => { cancelled = true }
  }, [bookId, chapterIndex, book])

  // Scroll to the resume point, or to a link's anchor, once the chapter paints.
  useEffect(() => {
    if (!content || !scrollRef.current) return
    const container = scrollRef.current
    if (pendingAnchor) {
      const target = container.querySelector(`#${CSS.escape(pendingAnchor)}`)
      setPendingAnchor(undefined)
      if (target) { target.scrollIntoView({ block: 'start' }); return }
    }
    if (pendingOffset !== null) {
      const target = pendingOffset
      setPendingOffset(null)
      for (const [start, node] of blockRefs.current) {
        if (start + node.textContent!.length >= target) {
          node.scrollIntoView({ block: 'center', behavior: 'smooth' })
          return
        }
      }
    }
    const resumeTo = reading?.lastCharOffset ?? 0
    if (resumeTo > content.charStart && resumeTo < content.charEnd) {
      for (const [start, node] of blockRefs.current) {
        if (start >= resumeTo) { node.scrollIntoView({ block: 'start' }); return }
      }
    }
    container.scrollTop = 0
  }, [content])

  const saveProgress = useCallback((offset: number) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.electronAPI.library
        .setProgress(bookId, chapterIndex, offset)
        .then(setReading)
        .catch(() => { /* Progress is best-effort; never interrupt reading for it. */ })
    }, PROGRESS_SAVE_MS)
  }, [bookId, chapterIndex])

  // The topmost visible block is the reading position. Every block is a DOM node
  // with a known absolute offset, so this is exact rather than estimated.
  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    let current: number | null = null
    for (const [start, node] of blockRefs.current) {
      if (node.getBoundingClientRect().bottom >= top) { current = start; break }
    }
    if (current === null) return
    latestOffset.current = current

    const now = Date.now()
    if (!session.current || now - session.current.lastActivity > SESSION_IDLE_MS) {
      if (session.current) flushSession()
      session.current = { startedAt: new Date().toISOString(), startOffset: current, startChapter: chapterIndex, lastActivity: now }
    }
    session.current.lastActivity = now
    saveProgress(current)
  }, [chapterIndex, saveProgress, flushSession])

  useEffect(() => {
    const onBlur = () => flushSession()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
      flushSession()
    }
  }, [flushSession])

  const goToChapter = useCallback((next: number, anchor?: string) => {
    if (next < 0 || next >= chapters.length) return
    setPendingAnchor(anchor)
    blockRefs.current.clear()
    setChapterIndex(next)
    setTocOpen(false)
  }, [chapters.length])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'ArrowRight') goToChapter(chapterIndex + 1)
      if (event.key === 'ArrowLeft') goToChapter(chapterIndex - 1)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chapterIndex, goToChapter])

  const focusKeyForRun = useMemo(() => {
    const map = new Map<string, string>()
    for (const run of runs) map.set(run.id, run.focusKey)
    return map
  }, [runs])

  const accentFor = useCallback((annotation: BookAnnotation): string => {
    if (annotation.origin === 'manual') return 'slate'
    const key = annotation.runId ? focusKeyForRun.get(annotation.runId) : undefined
    return (key ? annotationFocus(key)?.accent : undefined) ?? 'slate'
  }, [focusKeyForRun])

  const jumpTo = useCallback((chapter: number, offset: number) => {
    setPendingOffset(offset)
    if (chapter !== chapterIndex) {
      blockRefs.current.clear()
      setChapterIndex(chapter)
    }
    setOpenLesson(null)
  }, [chapterIndex])

  const handleEstimateAnnotations = async (start: number, end: number) => {
    try {
      return await window.electronAPI.library.estimateAnnotations(bookId, start, end, tier)
    } catch (err) {
      setDialogError(cleanError(err))
      return null
    }
  }

  const handleAnnotate = async (
    focus: { key: AnnotationFocusKey; customText?: string },
    start: number,
    end: number
  ) => {
    setDialogError(null)
    try {
      await window.electronAPI.library.generateAnnotations(bookId, focus, start, end, tier)
      await loadArtifacts()
      setFocusDialogOpen(false)
      setMarginOpen(true)
    } catch (err) {
      setDialogError(cleanError(err))
    }
  }

  const handleCreateLesson = async () => {
    setError(null)
    try {
      await window.electronAPI.library.generateLesson(bookId, chapterIndex, chapterIndex, tier)
      await loadArtifacts()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const handleDiscussStep = async (step: BookLessonStep) => {
    if (!openLesson) return
    await onDiscuss(bookId, chapterIndex, openLesson.id, step.id)
  }

  const handleMarkFinished = async () => {
    try {
      setReading(await window.electronAPI.library.setReadingState(bookId, { status: 'finished' }))
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const progress = reading?.progressPercent ?? 0
  const nearEnd = progress >= 97 || chapterIndex >= chapters.length - 1
  const fontSize = FONT_STEPS[fontStep]

  const [playerState, playerControls] = useAudiobookPlayer(playerOpen ? audiobook : null)

  // The sentence around the spoken word. Derived here rather than stored,
  // because it depends only on the text and the current word — and recomputing
  // it per word is cheaper than another set of spans in the database.
  const audioHighlight = useMemo(() => {
    if (!playerState.word || !content) return undefined
    const chapterText = content.blocks
      .map((block) => block.inlines.map((run) => run.text).join(''))
      .join('\n')
    return {
      word: playerState.word,
      sentence: sentenceSpanAt(chapterText, content.charStart, playerState.word.start),
    }
  }, [playerState.word, content])

  // Follow the narration: when the spoken word leaves the viewport, bring it
  // back. Only when it is actually off-screen, so a reader scrolling ahead to
  // look at something is not yanked back on every word.
  useEffect(() => {
    if (!playerState.playing || !playerState.word) return
    const container = scrollRef.current
    if (!container) return
    for (const [start, node] of blockRefs.current) {
      const end = start + (node.textContent?.length ?? 0)
      if (playerState.word.start < start || playerState.word.start > end) continue
      const box = node.getBoundingClientRect()
      const view = container.getBoundingClientRect()
      if (box.top < view.top + 60 || box.bottom > view.bottom - 60) {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      return
    }
  }, [playerState.word?.start, playerState.playing])

  const handleGenerateNarration = async (
    targetChapter: number,
    providerId: SpeechProviderId,
    voice: SpeechVoice,
    modelId: string,
    force: boolean
  ) => {
    setNarrating(true)
    setNarrationError(null)
    try {
      const result = await window.electronAPI.library.generateAudiobook(bookId, targetChapter, {
        providerId,
        voiceId: voice.voiceId,
        voiceName: voice.name,
        modelId,
        force,
      })
      setNarrationOpen(false)
      if (targetChapter === chapterIndex) {
        setAudiobook(result)
        setPlayerOpen(true)
      }
    } catch (err) {
      setNarrationError(cleanError(err))
    } finally {
      setNarrating(false)
      setNarrationProgress(null)
    }
  }

  // Only this chapter's annotations reach the renderer: a 400-annotation book
  // should not run the span sweep against every paragraph of every chapter.
  const chapterAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation.chapterIndex === chapterIndex && annotation.anchorStatus !== 'orphaned'),
    [annotations, chapterIndex]
  )

  const toc = useMemo(() => chapters.map((chapter) => ({
    index: chapter.spineIndex,
    title: chapter.title,
    depth: Math.min(chapter.navDepth, 3),
  })), [chapters])

  if (loading) {
    return <div className="flex flex-1 items-center justify-center bg-holmes-bg text-[11px] text-white/30">Loading…</div>
  }

  if (!book) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-holmes-bg">
        <p className="text-[13px] text-white/55">{error ?? 'That book is no longer on the shelf.'}</p>
        <button onClick={onBack} className="cursor-pointer text-[11px] text-white/40 hover:text-white/75">← Back to Library</button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-holmes-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-holmes-bg/95 px-6 py-3 backdrop-blur">
        <button onClick={onBack} className="cursor-pointer text-sm text-white/40 transition-colors hover:text-white/80">
          ← Library
        </button>
        <span className="text-white/15">/</span>
        <div className="min-w-0">
          <h1 className="truncate font-serif-display text-[17px] leading-tight text-white/85">{book.title}</h1>
          {book.authors.length > 0 && (
            <p className="truncate text-[10px] text-white/30">{book.authors.join(', ')}</p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-white/30">{Math.round(progress)}%</span>
          <button
            onClick={() => setFontStep((step) => Math.max(0, step - 1))}
            disabled={fontStep === 0}
            title="Smaller text"
            className="cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/50 hover:text-white/80 disabled:opacity-30"
          >
            <FontAwesomeIcon icon={faMinus} />
          </button>
          <button
            onClick={() => setFontStep((step) => Math.min(FONT_STEPS.length - 1, step + 1))}
            disabled={fontStep === FONT_STEPS.length - 1}
            title="Larger text"
            className="cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/50 hover:text-white/80 disabled:opacity-30"
          >
            <FontAwesomeIcon icon={faPlus} />
          </button>
          <button
            onClick={() => { setDialogError(null); setFocusDialogOpen(true) }}
            disabled={generating}
            title="Read this book under a focus"
            className="cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/50 hover:text-white/80 disabled:opacity-30"
          >
            {generating ? 'Working…' : 'Annotate'}
          </button>
          <button
            onClick={() => {
              if (audiobook) setPlayerOpen((open) => !open)
              else { setNarrationError(null); setNarrationOpen(true) }
            }}
            disabled={narrating}
            title={audiobook ? 'Show the narration player' : 'Generate narration for this chapter'}
            className={`cursor-pointer rounded-md border px-2 py-1 text-[10px] transition-colors ${
              audiobook && playerOpen
                ? 'border-holmes-primary/35 bg-holmes-primary/10 text-holmes-primary-light'
                : 'border-white/10 bg-white/[0.04] text-white/50 hover:text-white/80'
            } disabled:opacity-30`}
          >
            <FontAwesomeIcon icon={faHeadphones} className="mr-1" />
            {narrating ? 'Narrating…' : audiobook ? 'Listen' : 'Narrate'}
          </button>
          <button
            onClick={() => void handleCreateLesson()}
            disabled={generating}
            title="Build an interactive lesson from this chapter"
            className="cursor-pointer rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/50 hover:text-white/80 disabled:opacity-30"
          >
            Lesson
          </button>
          <button
            onClick={() => setMarginOpen((open) => !open)}
            title="Notes"
            className={`cursor-pointer rounded-md border px-2 py-1 text-[10px] transition-colors ${
              marginOpen ? 'border-violet-400/35 bg-violet-400/10 text-violet-100/85' : 'border-white/10 bg-white/[0.04] text-white/50 hover:text-white/80'
            }`}
          >
            <FontAwesomeIcon icon={faNoteSticky} />
          </button>
          <button
            onClick={() => setTocOpen((open) => !open)}
            title="Contents"
            className={`cursor-pointer rounded-md border px-2 py-1 text-[10px] transition-colors ${
              tocOpen ? 'border-violet-400/35 bg-violet-400/10 text-violet-100/85' : 'border-white/10 bg-white/[0.04] text-white/50 hover:text-white/80'
            }`}
          >
            <FontAwesomeIcon icon={faList} />
          </button>
          {reading?.status !== 'finished' && nearEnd && (
            <button
              onClick={() => void handleMarkFinished()}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-400/[0.07] px-2.5 py-1 text-[10px] text-violet-100/85 hover:border-violet-400/45"
            >
              <FontAwesomeIcon icon={faCircleCheck} />
              Mark finished
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {tocOpen && (
          <nav className="w-64 shrink-0 overflow-y-auto border-r border-white/[0.06] bg-holmes-surface/40 px-2 py-3 scrollbar-thin">
            {toc.map((entry) => (
              <button
                key={entry.index}
                onClick={() => goToChapter(entry.index)}
                className={`block w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                  entry.index === chapterIndex
                    ? 'bg-violet-400/10 text-violet-100/85'
                    : 'text-white/45 hover:bg-white/[0.04] hover:text-white/75'
                }`}
                style={{ paddingLeft: `${0.5 + entry.depth * 0.75}rem` }}
                title={entry.title}
              >
                {entry.title}
              </button>
            ))}
          </nav>
        )}

        <div ref={scrollRef} onScroll={handleScroll} className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
          <div
            className="mx-auto w-full max-w-[38rem] px-6 pb-24 pt-8 font-serif-display text-white/80"
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.8 }}
          >
            {error && (
              <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11px] text-red-200/80">
                {error}
              </div>
            )}
            {!content ? (
              <p className="text-[11px] text-white/25">Loading chapter…</p>
            ) : (
              <>
                <h2 className="mb-6 border-b border-white/[0.06] pb-3 text-[11px] uppercase tracking-wider text-white/30">
                  {content.title}
                </h2>
                {content.blocks.map((block, index) => (
                  <div
                    key={`${block.start}-${index}`}
                    ref={(node) => {
                      if (node) blockRefs.current.set(block.start, node)
                      else blockRefs.current.delete(block.start)
                    }}
                  >
                    <BookBlockView
                      bookId={bookId}
                      block={block}
                      onNavigate={goToChapter}
                      layer={{
                        annotations: chapterAnnotations,
                        accentFor,
                        activeId: activeAnnotation,
                        onActivate: setActiveAnnotation,
                      }}
                      audio={audioHighlight}
                      onSeekToOffset={playerOpen && audiobook ? playerControls.seekToOffset : undefined}
                    />
                  </div>
                ))}
              </>
            )}

            <div className="mt-10 flex items-center justify-between border-t border-white/[0.06] pt-5">
              <button
                onClick={() => goToChapter(chapterIndex - 1)}
                disabled={chapterIndex === 0}
                className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/40 hover:text-white/75 disabled:opacity-25"
              >
                <FontAwesomeIcon icon={faChevronLeft} className="text-[9px]" />
                Previous
              </button>
              <span className="text-[10px] tabular-nums text-white/25">
                {chapterIndex + 1} / {chapters.length}
              </span>
              <button
                onClick={() => goToChapter(chapterIndex + 1)}
                disabled={chapterIndex >= chapters.length - 1}
                className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/40 hover:text-white/75 disabled:opacity-25"
              >
                Next
                <FontAwesomeIcon icon={faChevronRight} className="text-[9px]" />
              </button>
            </div>
          </div>
        </div>

        {marginOpen && (
          <BookMarginPanel
            annotations={annotations}
            runs={runs}
            lessons={lessons}
            chapterIndex={chapterIndex}
            activeId={activeAnnotation}
            accentFor={accentFor}
            onActivate={setActiveAnnotation}
            onScrollTo={(annotation) => jumpTo(annotation.chapterIndex, annotation.charStart)}
            onTogglePin={(annotation) => {
              void window.electronAPI.library
                .setAnnotationPinned(annotation.id, !annotation.pinned)
                .then(loadArtifacts)
                .catch(() => { /* best effort */ })
            }}
            onDelete={(annotation) => {
              void window.electronAPI.library
                .deleteAnnotation(annotation.id)
                .then(loadArtifacts)
                .catch(() => { /* best effort */ })
            }}
            onDeleteRun={(run) => {
              void window.electronAPI.library
                .deleteAnnotationRun(run.id)
                .then(loadArtifacts)
                .catch(() => { /* best effort */ })
            }}
            onOpenLesson={setOpenLesson}
          />
        )}
      </div>

      {playerOpen && audiobook && (
        <AudiobookBar
          chapter={audiobook}
          state={playerState}
          controls={playerControls}
          onClose={() => { playerControls.pause(); setPlayerOpen(false) }}
          onRegenerate={() => { setNarrationError(null); setNarrationOpen(true) }}
        />
      )}

      {narrationProgress && (
        <div className="shrink-0 border-t border-white/[0.08] bg-holmes-surface/70 px-6 py-2 text-[11px] text-white/50">
          {narrationProgress}
        </div>
      )}

      {narrationOpen && (
        <NarrationDialog
          bookId={bookId}
          chapters={chapters}
          currentChapter={chapterIndex}
          busy={narrating}
          error={narrationError}
          onGenerate={(target, providerId, voice, modelId, force) =>
            void handleGenerateNarration(target, providerId, voice, modelId, force)}
          onClose={() => setNarrationOpen(false)}
        />
      )}

      {focusDialogOpen && (
        <AnnotationFocusDialog
          chapters={chapters}
          currentChapter={chapterIndex}
          busy={generating}
          error={dialogError}
          onEstimate={handleEstimateAnnotations}
          onSubmit={(focus, start, end) => void handleAnnotate(focus as { key: AnnotationFocusKey; customText?: string }, start, end)}
          onClose={() => setFocusDialogOpen(false)}
        />
      )}

      {openLesson && (
        <div className="fixed inset-0 z-50 flex bg-holmes-bg">
          <LessonView
            lesson={openLesson}
            onJumpToCitation={(citation: BookCitation) => jumpTo(citation.chapterIndex, citation.charStart)}
            onDiscuss={(step) => void handleDiscussStep(step)}
            onClose={() => setOpenLesson(null)}
          />
        </div>
      )}
    </div>
  )
}
