import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowRotateRight,
  faBookOpen,
  faCircleExclamation,
  faMagnifyingGlass,
} from '@fortawesome/free-solid-svg-icons'
import type { BookReadingStatus, LibraryBook } from '@shared/types'
import { BookReader } from './BookReader'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { useLibraryRun } from '../hooks/useLibraryRun'

interface LibraryPageProps {
  onBack: () => void
  /** The shelf is empty until a folder is connected, which happens on the Data page. */
  onOpenData: () => void
  /** Opens a book/chapter-scoped conversation in the chat stack. */
  onDiscuss: (bookId: string, chapterIndex: number, lessonId?: string, stepId?: string) => Promise<void>
}

type ShelfFilter = 'all' | 'reading' | 'finished' | 'unread' | 'unreadable'

const FILTERS: Array<{ key: ShelfFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'reading', label: 'Reading' },
  { key: 'finished', label: 'Finished' },
  { key: 'unread', label: 'Unread' },
  { key: 'unreadable', label: 'Unreadable' },
]

const STATUS_LABEL: Record<BookReadingStatus, string> = {
  unread: 'Unread',
  reading: 'Reading',
  finished: 'Finished',
  abandoned: 'Abandoned',
  reference: 'Reference',
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

/** A book with no usable cover gets a typographic one rather than a grey box. */
const CoverFallback: FC<{ title: string; authors: string[] }> = ({ title, authors }) => (
  <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-violet-500/15 to-white/[0.03] p-3">
    <span className="font-serif-display text-[13px] leading-tight text-white/75 line-clamp-4">{title}</span>
    {authors.length > 0 && (
      <span className="text-[9px] uppercase tracking-wider text-white/30 line-clamp-2">{authors.join(', ')}</span>
    )}
  </div>
)

export const LibraryPage: FC<LibraryPageProps> = ({ onBack, onOpenData, onDiscuss }) => {
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ShelfFilter>('all')
  const [query, setQuery] = useState('')
  const [openBookId, setOpenBookId] = useState<string | null>(null)
  const runState = useLibraryRun()
  const scanning = runState?.status === 'scanning'

  const load = useCallback(async () => {
    try {
      setBooks(await window.electronAPI.library.listBooks())
      setError(null)
    } catch (err) {
      setError(cleanError(err))
      setBooks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // The shelf changes when a scan finishes, whoever started it.
  useEffect(() => {
    if (runState?.status === 'idle') void load()
  }, [runState?.status, load])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (openBookId) setOpenBookId(null)
      else onBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onBack, openBookId])

  const shelf = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return books.filter((entry) => {
      if (filter === 'unreadable') {
        if (entry.book.status !== 'failed' && !entry.book.missingSince) return false
      } else if (filter !== 'all') {
        if (entry.book.status === 'failed') return false
        if (entry.reading.status !== filter) return false
      }
      if (!needle) return true
      return (
        entry.book.title.toLowerCase().includes(needle) ||
        entry.book.authors.some((author) => author.toLowerCase().includes(needle)) ||
        entry.book.subjects.some((subject) => subject.toLowerCase().includes(needle))
      )
    })
  }, [books, filter, query])

  const handleRescan = async () => {
    // Every library project is rescanned: the page is the whole shelf, not one
    // source's view of it.
    const projectIds = [...new Set(books.map((entry) => entry.book.projectId))]
    setError(null)
    try {
      for (const projectId of projectIds) await window.electronAPI.library.scan(projectId)
      await load()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  if (openBookId) {
    return (
      <BookReader
        bookId={openBookId}
        onBack={() => { setOpenBookId(null); void load() }}
        onDiscuss={onDiscuss}
      />
    )
  }

  const finished = books.filter((entry) => entry.reading.status === 'finished').length

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<FontAwesomeIcon icon={faBookOpen} className={PAGE_HEADER_ICON} />}
        title="Library"
        actions={
          <>
            <span className="text-[11px] tabular-nums text-white/30">
              {books.length} book{books.length === 1 ? '' : 's'}
              {finished > 0 && ` · ${finished} finished`}
            </span>
            <button
              onClick={() => void handleRescan()}
              disabled={scanning || books.length === 0}
              title="Re-read every connected folder"
              className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-400/[0.07] px-2.5 py-1 text-[11px] text-violet-100/85 transition-colors hover:border-violet-400/45 disabled:opacity-40"
            >
              <FontAwesomeIcon icon={faArrowRotateRight} className={`text-[10px] ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </>
        }
      />

      <div className="mx-auto w-full max-w-6xl px-6 py-5">
        {error && (
          <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11px] text-red-200/80">
            {error}
          </div>
        )}

        {scanning && runState?.progress && (
          <div className="mb-4 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/50">
            {runState.progress.message}
            {runState.progress.total !== null && ` — ${runState.progress.current}/${runState.progress.total}`}
          </div>
        )}

        {books.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {FILTERS.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setFilter(entry.key)}
                className={`cursor-pointer rounded-full px-3 py-1 text-[11px] transition-colors ${
                  filter === entry.key
                    ? 'bg-violet-400/15 text-violet-100/90'
                    : 'text-white/40 hover:bg-white/[0.05] hover:text-white/70'
                }`}
              >
                {entry.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="text-[10px] text-white/25" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Title, author, subject…"
                className="w-44 bg-transparent text-[11px] text-white/70 outline-none placeholder:text-white/20"
              />
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-[11px] text-white/30">Loading…</p>
        ) : books.length === 0 ? (
          <div className="rounded-xl border border-white/[0.07] bg-holmes-surface px-5 py-6 text-center">
            <FontAwesomeIcon icon={faBookOpen} className="text-2xl text-white/15" />
            <p className="mt-3 text-[13px] text-white/55">No books yet.</p>
            <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-white/35">
              Connect a folder of EPUB or PDF files to the Books source under Media Sources, then scan it. Books are
              read here and never indexed into your profile.
            </p>
            <button
              onClick={onOpenData}
              className="mt-3 cursor-pointer rounded-lg bg-holmes-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-holmes-primary-light"
            >
              Open Data Sources
            </button>
          </div>
        ) : shelf.length === 0 ? (
          <p className="text-[11px] text-white/25">Nothing matches that filter.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {shelf.map((entry) => {
              const unreadable = entry.book.status === 'failed' || Boolean(entry.book.missingSince)
              return (
                <button
                  key={entry.book.id}
                  onClick={() => {
                    if (unreadable) return
                    setOpenBookId(entry.book.id)
                  }}
                  title={unreadable ? entry.book.scanError ?? 'This book is no longer at its scanned path' : entry.book.title}
                  className={`group flex flex-col text-left ${unreadable ? 'cursor-default' : 'cursor-pointer'}`}
                >
                  <div
                    className={`relative aspect-[2/3] w-full overflow-hidden rounded-lg border border-white/[0.07] bg-holmes-surface transition-colors ${
                      unreadable ? 'opacity-45' : 'group-hover:border-violet-400/35'
                    }`}
                  >
                    {entry.book.coverDataUrl ? (
                      <img src={entry.book.coverDataUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <CoverFallback title={entry.book.title} authors={entry.book.authors} />
                    )}
                    {unreadable && (
                      <span className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1">
                        <FontAwesomeIcon icon={faCircleExclamation} className="text-[10px] text-amber-300/80" />
                      </span>
                    )}
                    {entry.reading.progressPercent > 0 && entry.reading.progressPercent < 100 && (
                      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
                        <div className="h-full bg-violet-400/80" style={{ width: `${entry.reading.progressPercent}%` }} />
                      </div>
                    )}
                  </div>
                  <span className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-white/70">{entry.book.title}</span>
                  <span className="line-clamp-1 text-[10px] text-white/30">
                    {entry.book.authors.join(', ') || '—'}
                  </span>
                  <span className="text-[9px] uppercase tracking-wider text-white/25">
                    {unreadable
                      ? entry.book.missingSince ? 'Missing' : 'Unreadable'
                      : entry.reading.status === 'reading'
                        ? `${Math.round(entry.reading.progressPercent)}%`
                        : STATUS_LABEL[entry.reading.status]}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
