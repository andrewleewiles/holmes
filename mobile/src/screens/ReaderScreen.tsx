import { useEffect, useRef, useState } from 'react'
import type { BookChapter, BookChapterContent, LibraryBook } from '@shared/types'
import { api } from '../transport/api'

interface Props {
  entry: LibraryBook
  onBack: () => void
}

export function ReaderScreen({ entry, onBack }: Props): React.ReactElement {
  const [chapters, setChapters] = useState<BookChapter[]>([])
  const [index, setIndex] = useState<number | null>(null)
  const [content, setContent] = useState<BookChapterContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)

  // Open where this device left off. The Mac keeps a position per paired
  // device, so resuming does not touch the owner's place in the same book.
  useEffect(() => {
    void api.library
      .getBook(entry.book.id)
      .then((detail) => {
        setChapters(detail.chapters)
        setIndex(detail.reading.lastChapterIndex || 0)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not open this book'))
  }, [entry.book.id])

  useEffect(() => {
    if (index === null) return
    let cancelled = false
    setContent(null)
    void api.library
      .getChapter(entry.book.id, index)
      .then((chapter) => {
        if (cancelled) return
        setContent(chapter)
        scroller.current?.scrollTo({ top: 0 })
        // Record the position for this device only.
        void api.library.setProgress(entry.book.id, index, chapter.charStart).catch(() => {
          // Losing a position is not worth interrupting the reading for.
        })
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this chapter')
      })
    return () => {
      cancelled = true
    }
  }, [entry.book.id, index])

  const current = chapters[index ?? 0]

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <button onClick={onBack} className="text-sm text-sky-400">Library</button>
        <span className="min-w-0 flex-1 truncate text-sm text-white/70">{current?.title || entry.book.title}</span>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {error && (
          <div className="rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-sm text-red-100/75">{error}</div>
        )}
        {!content && !error && <p className="text-sm text-white/30">Loading…</p>}

        {content?.blocks.map((block, i) => (
          <p key={i} className="mb-4 text-[17px] leading-[1.7] text-white/80">
            {block.inlines.map((run) => run.text).join('')}
          </p>
        ))}

        {content?.truncated && <p className="text-xs text-white/30">This chapter was shortened.</p>}
      </div>

      <nav className="flex items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          onClick={() => setIndex((n) => Math.max(0, (n ?? 0) - 1))}
          disabled={(index ?? 0) <= 0}
          className="rounded-lg bg-white/[0.06] px-3 py-2 text-sm text-white/70 disabled:opacity-25"
        >
          Previous
        </button>
        <span className="text-[11px] text-white/30">
          {chapters.length > 0 ? `${(index ?? 0) + 1} of ${chapters.length}` : ''}
        </span>
        <button
          onClick={() => setIndex((n) => Math.min(chapters.length - 1, (n ?? 0) + 1))}
          disabled={(index ?? 0) >= chapters.length - 1}
          className="rounded-lg bg-white/[0.06] px-3 py-2 text-sm text-white/70 disabled:opacity-25"
        >
          Next
        </button>
      </nav>
    </div>
  )
}
