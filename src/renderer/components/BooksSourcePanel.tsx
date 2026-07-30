import { type FC, type ReactNode, useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight, faBookOpen, faFolderTree, faRefresh, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type {
  IndexEstimate,
  LibraryBook,
  LibraryScanResult,
  LibrarySnapshotResult,
  OrganizePlan,
  OrganizeResult,
} from '@shared/types'
import { OrganizeBooksDialog } from './OrganizeBooksDialog'
import type { LibraryRowStats } from './DataPage'
import { formatDuration, formatEstimateCost } from './IndexEstimateBar'
import { useLibraryRun } from '../hooks/useLibraryRun'
import { useSettings } from '../hooks/useSettings'

interface BooksSourcePanelProps {
  projectId: string
  /** Path editor / connect controls, rendered directly under the header. */
  directoryRow?: ReactNode
  /** Replaces the default book glyph — lets the card wear the project's own icon. */
  icon?: ReactNode
  reloadKey?: number
  /** Lifts the shelf counts up so the row's dot can report the shelf, not an index. */
  onStats: (stats: LibraryRowStats) => void
  onOpenLibrary: () => void
}

function cleanError(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong'
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

const CONTROL_BUTTON =
  'shrink-0 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/55 hover:border-violet-400/30 hover:text-violet-200/80 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-white/55 cursor-pointer transition-colors'

export const BooksSourcePanel: FC<BooksSourcePanelProps> = ({
  projectId,
  directoryRow,
  icon,
  reloadKey,
  onStats,
  onOpenLibrary,
}) => {
  const [books, setBooks] = useState<LibraryBook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastScan, setLastScan] = useState<LibraryScanResult | null>(null)
  const [estimate, setEstimate] = useState<IndexEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [snapshot, setSnapshot] = useState<LibrarySnapshotResult | null>(null)
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizePlan, setOrganizePlan] = useState<OrganizePlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null)
  const [organizeError, setOrganizeError] = useState<string | null>(null)
  const runState = useLibraryRun()
  const { settings } = useSettings()
  const scanning = runState?.status === 'scanning'
  const generating = runState?.status === 'generating'
  const snapshotEnabled = settings?.librarySnapshotEnabled ?? false

  const load = useCallback(async () => {
    try {
      const list = await window.electronAPI.library.listBooks(projectId)
      setBooks(list)
      setError(null)
      onStats({
        books: list.length,
        read: list.filter((entry) => entry.reading.status === 'finished').length,
        unreachable: list.some((entry) => entry.book.missingSince !== null),
      })
    } catch (err) {
      setError(cleanError(err))
      setBooks([])
    } finally {
      setLoading(false)
    }
  }, [projectId, onStats])

  useEffect(() => { void load() }, [load, reloadKey])

  // The shelf changes when a scan finishes, whoever started it — including the
  // background timer.
  useEffect(() => {
    if (runState?.status === 'idle') void load()
  }, [runState?.status, load])

  const handleScan = async () => {
    setError(null)
    try {
      setLastScan(await window.electronAPI.library.scan(projectId))
      await load()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  // Never on mount, never on a timer: a cost quote is an explicit request.
  const handleEstimate = async () => {
    setEstimating(true)
    setError(null)
    try {
      setEstimate(await window.electronAPI.library.estimateSnapshot(projectId, settings?.defaultTier ?? 'mid'))
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setEstimating(false)
    }
  }

  const handleRefreshSnapshot = async () => {
    setError(null)
    try {
      setSnapshot(await window.electronAPI.library.refreshSnapshot(projectId, settings?.defaultTier ?? 'mid'))
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const handleOrganize = async () => {
    setOrganizeOpen(true)
    setOrganizePlan(null)
    setOrganizeResult(null)
    setOrganizeError(null)
    setPlanning(true)
    try {
      setOrganizePlan(await window.electronAPI.library.planOrganize(projectId, settings?.defaultTier ?? 'mid'))
    } catch (err) {
      setOrganizeError(cleanError(err))
    } finally {
      setPlanning(false)
    }
  }

  const handleApplyOrganize = async () => {
    if (!organizePlan) return
    setApplying(true)
    setOrganizeError(null)
    try {
      setOrganizeResult(await window.electronAPI.library.applyOrganize(organizePlan))
      await load()
    } catch (err) {
      setOrganizeError(cleanError(err))
    } finally {
      setApplying(false)
    }
  }

  const finished = books.filter((entry) => entry.reading.status === 'finished').length
  const reading = books.filter((entry) => entry.reading.status === 'reading').length
  const failed = books.filter((entry) => entry.book.status === 'failed').length
  const missing = books.filter((entry) => entry.book.missingSince !== null).length

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-holmes-surface">
      <div className="flex items-center gap-2 border-b border-white/[0.05] px-3 py-2">
        {icon ?? <FontAwesomeIcon icon={faBookOpen} className="shrink-0 text-base text-violet-300/70" />}
        <span className="text-[11px] text-white/55">Library</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => void handleScan()} disabled={scanning} className={CONTROL_BUTTON}>
            <FontAwesomeIcon icon={faRefresh} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scanning…' : 'Scan library'}
          </button>
          <button
            onClick={() => void handleOrganize()}
            disabled={scanning || books.length === 0}
            title="File each book into an [Author] - [Title] folder"
            className={CONTROL_BUTTON}
          >
            <FontAwesomeIcon icon={faFolderTree} />
            Organise files
          </button>
          <button onClick={onOpenLibrary} className={CONTROL_BUTTON}>
            Open Library
            <FontAwesomeIcon icon={faArrowRight} />
          </button>
        </div>
      </div>

      {directoryRow && <div className="border-b border-white/[0.05] px-3 py-2">{directoryRow}</div>}

      <div className="space-y-2 px-3 py-2.5">
        {/* Books are never sent to a model by this panel — say so once, plainly,
            because every other source card on this page means the opposite. */}
        <p className="text-[11px] leading-relaxed text-white/40">
          Books here are scanned locally and read in the Library. Their text is never indexed into your profile —
          only the reading record is, and only when you ask for it.
        </p>

        {error && (
          <div className="rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11px] text-red-200/80">
            {error}
          </div>
        )}

        {scanning && runState?.progress && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/50">
            {runState.progress.message}
            {runState.progress.total !== null && ` — ${runState.progress.current}/${runState.progress.total}`}
          </div>
        )}

        {loading ? (
          <p className="text-[11px] text-white/30">Loading…</p>
        ) : books.length === 0 ? (
          <p className="text-[11px] text-white/25">
            No books yet — connect a folder of EPUB or PDF files above, then scan.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'Books', value: books.length },
              { label: 'Finished', value: finished },
              { label: 'Reading', value: reading },
              { label: 'Unreadable', value: failed + missing },
            ].map((tile) => (
              <div key={tile.label} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
                <div className="text-[15px] tabular-nums text-white/80">{tile.value}</div>
                <div className="text-[9px] uppercase tracking-wider text-white/30">{tile.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* The only paid thing the Library does, and it reads the catalogue —
            titles, subjects and the reading record — never a word of any book. */}
        {books.length > 0 && (
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-white/60">Reading record</span>
              <span className="text-[10px] text-white/30">feeds your profile and timeline</span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => void handleEstimate()} disabled={estimating || generating} className={CONTROL_BUTTON}>
                  {estimating ? 'Estimating…' : 'Estimate'}
                </button>
                <button
                  onClick={() => void handleRefreshSnapshot()}
                  disabled={!snapshotEnabled || generating || scanning}
                  title={snapshotEnabled ? 'Summarize what you have read' : 'Switch the reading-record snapshot on in Settings'}
                  className={CONTROL_BUTTON}
                >
                  {generating ? 'Working…' : 'Refresh'}
                </button>
              </div>
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
              Summarizes what you acquire, start, abandon and finish — from titles, subjects and dates only.
            </p>
            {estimate && (
              <p className="mt-1.5 text-[10px] tabular-nums text-white/45">
                {estimate.lines.length} call · {formatEstimateCost(estimate.costUsd)} · ~{formatDuration(estimate.estimatedSeconds)}
                {estimate.pricingUnavailable && ' — this model has no published pricing'}
                {estimate.truncatedAtCap && ' · the largest shelves are packed down to fit'}
              </p>
            )}
            {!snapshotEnabled && (
              <p className="mt-1.5 text-[10px] text-amber-200/60">
                Switched off in Settings — nothing about your reading reaches your profile until you enable it.
              </p>
            )}
            {snapshot && (
              <p className="mt-1.5 text-[10px] leading-relaxed text-white/50">
                {snapshot.generated
                  ? snapshot.contextShort
                  : `Already up to date across ${snapshot.bookCount} book${snapshot.bookCount === 1 ? '' : 's'}.`}
              </p>
            )}
          </div>
        )}

        {lastScan && (lastScan.booksFiled ?? 0) > 0 && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-white/50">
            <FontAwesomeIcon icon={faFolderTree} className="mr-1.5 text-violet-300/60" />
            Filed {lastScan.booksFiled} book{lastScan.booksFiled === 1 ? '' : 's'} into author folders.
          </div>
        )}

        {/* A scan that stopped short must never read as a complete one. */}
        {lastScan && !lastScan.scanComplete && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-200/80">
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0" />
            <span>
              The last scan could not read every folder, so nothing was removed from the shelf.
              {lastScan.unreadableRoots.length > 0 && ` Unreachable: ${lastScan.unreadableRoots.join(', ')}`}
            </span>
          </div>
        )}
      </div>

      {organizeOpen && (
        <OrganizeBooksDialog
          plan={organizePlan}
          planning={planning}
          applying={applying}
          result={organizeResult}
          error={organizeError}
          onApply={() => void handleApplyOrganize()}
          onClose={() => setOrganizeOpen(false)}
        />
      )}
    </div>
  )
}
