import { useEffect, useState } from 'react'
import type { LibraryBook } from '@shared/types'
import { api } from '../transport/api'

export function LibraryScreen({ onOpen }: { onOpen: (book: LibraryBook) => void }): React.ReactElement {
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void api.library
      .listBooks()
      .then((shelf) =>
        // `status` alone is not enough: a book whose file has gone is still
        // 'ready', and opening one fails at the first chapter.
        setBooks(shelf.filter((entry) => entry.book.status === 'ready' && !entry.book.missingSince))
      )
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the shelf'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/[0.07] px-4 py-3">
        <h1 className="font-serif-display text-lg text-white">Library</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading && <p className="text-sm text-white/30">Loading…</p>}
        {error && (
          <div className="rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-sm text-red-100/75">{error}</div>
        )}
        {!loading && !error && books.length === 0 && <p className="text-sm text-white/30">Nothing shared yet.</p>}

        <ul className="grid grid-cols-2 gap-4">
          {books.map((entry) => (
            <li key={entry.book.id}>
              <button onClick={() => onOpen(entry)} className="w-full text-left active:opacity-70">
                <div className="aspect-[2/3] overflow-hidden rounded-lg border border-white/10 bg-white/[0.04]">
                  {entry.book.coverDataUrl ? (
                    <img src={entry.book.coverDataUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center p-3 text-center text-xs text-white/40">
                      {entry.book.title}
                    </div>
                  )}
                </div>
                <div className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-white/75">{entry.book.title}</div>
                <div className="truncate text-[11px] text-white/35">{entry.book.authors.join(', ')}</div>
                {entry.reading.progressPercent > 0 && (
                  <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-sky-400" style={{ width: `${Math.min(100, entry.reading.progressPercent)}%` }} />
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
