import { type FC, useCallback, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCircleCheck,
  faCircleExclamation,
  faFileImport,
  faRefresh,
  faSpinner,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import type { HealthIngestProgress, HealthRecord } from '@shared/types'

interface HealthSourcesPanelProps {
  records: HealthRecord[]
  progress: HealthIngestProgress | null
  onIngest: (filePath: string) => Promise<void>
  onAbort: () => Promise<void>
  onDelete: (recordId: string) => Promise<void>
  onRefresh: () => void
  onLiveSync?: () => void
  liveBusy?: boolean
  onScanDirectory?: () => Promise<void>
  scanning?: boolean
  hasDirectory?: boolean
}

const SOURCE_LABEL: Record<HealthRecord['sourceType'], string> = {
  apple_health: 'Apple Health',
  mychart: 'MyChart',
  bloodwork: 'Bloodwork',
  other: 'Other',
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

export const HealthSourcesPanel: FC<HealthSourcesPanelProps> = ({
  records,
  progress,
  onIngest,
  onAbort,
  onDelete,
  onRefresh,
  onLiveSync,
  liveBusy,
  onScanDirectory,
  scanning,
  hasDirectory,
}) => {
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleChooseFiles = useCallback(async () => {
    setChoosing(true)
    setError(null)
    try {
      const files = await window.electronAPI.app.selectFiles()
      for (const file of files) {
        try {
          await onIngest(file)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Ingest failed')
          break
        }
      }
      onRefresh()
    } finally {
      setChoosing(false)
    }
  }, [onIngest, onRefresh])

  return (
    <section className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-medium text-white/75 font-serif-display">Health sources</h2>
          <p className="text-xs text-white/35 mt-0.5">
            {hasDirectory
              ? 'Apple Health exports, MyChart CCDA/PDF and bloodwork CSV/PDF are picked up from the connected folders on their own. Structured observations are stored locally.'
              : 'Import Apple Health exports, MyChart CCDA/PDF, and bloodwork CSV/PDF. Connect a folder on this project to have new files picked up automatically.'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasDirectory && onScanDirectory && (
            <button
              onClick={() => void onScanDirectory()}
              disabled={scanning || choosing}
              title="Read the connected folders now instead of waiting for the hourly pass. Files already ingested are skipped; previously failed ones are retried."
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 hover:border-white/20 hover:text-white/80 disabled:opacity-40 cursor-pointer"
            >
              <FontAwesomeIcon icon={faRefresh} className={`text-[11px] ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Scanning…' : 'Scan now'}
            </button>
          )}
          <button
            onClick={() => void handleChooseFiles()}
            disabled={choosing}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 hover:border-white/20 hover:text-white/80 disabled:opacity-40 cursor-pointer"
          >
            <FontAwesomeIcon icon={faFileImport} className="text-[11px]" />
            {choosing ? 'Importing…' : 'Import file'}
          </button>
          <button
            onClick={() => void onRefresh()}
            className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
            title="Refresh records list"
          >
            Refresh
          </button>
        </div>
      </div>

      {progress && (
        <div className="mb-3 rounded-xl border border-white/[0.07] bg-black/10 p-3">
          <div className="flex items-center gap-2 text-xs text-white/55">
            <FontAwesomeIcon icon={faSpinner} spin className="text-holmes-primary" />
            <span className="capitalize">{progress.phase}</span>
            <span className="text-white/35">— {progress.message}</span>
            {progress.phase !== 'complete' && progress.phase !== 'error' && (
              <button
                onClick={() => void onAbort()}
                className="ml-auto text-[10px] text-white/40 hover:text-red-300 cursor-pointer"
              >
                Abort
              </button>
            )}
          </div>
          {progress.total > 0 && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full bg-holmes-primary transition-all"
                style={{ width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-xs text-red-100/70">
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-100/35 hover:text-red-100 cursor-pointer">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}

      {records.length === 0 ? (
        <p className="text-xs text-white/30 text-center py-6">
          No sources imported yet. Use the file picker above or set a watched directory.
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
          {records.map((record) => {
            const isLive = record.sourceType === 'apple_health' && record.filename === 'live-sync'
            return (
            <li
              key={record.id}
              className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${
                isLive
                  ? 'border-emerald-400/20 bg-emerald-500/[0.05]'
                  : 'border-white/[0.07] bg-black/10'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[11px] text-white/70" title={record.filename}>
                    {record.filename}
                  </span>
                  {isLive ? (
                    <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-emerald-200/80">
                      Live
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] uppercase tracking-wider text-white/40">
                      {SOURCE_LABEL[record.sourceType]}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/35">
                  <span>{formatDate(record.importedAt)}</span>
                  <span>·</span>
                  <span>{record.observationsCount} observations</span>
                  <span>·</span>
                  {record.status === 'parsed' && (
                    <span className="text-emerald-300/60">
                      <FontAwesomeIcon icon={faCircleCheck} className="mr-1" /> parsed
                    </span>
                  )}
                  {record.status === 'pending' && (
                    <span className="text-amber-300/60">
                      <FontAwesomeIcon icon={faSpinner} spin className="mr-1" /> pending
                    </span>
                  )}
                  {record.status === 'failed' && (
                    <span className="text-red-300/70" title={record.parseError ?? ''}>
                      <FontAwesomeIcon icon={faCircleExclamation} className="mr-1" /> failed
                    </span>
                  )}
                </div>
                {record.status === 'failed' && record.parseError && (
                  <p className="mt-1 text-[10px] leading-relaxed text-red-300/70 line-clamp-2">{record.parseError}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isLive && onLiveSync && (
                  <button
                    onClick={() => onLiveSync()}
                    disabled={liveBusy}
                    title="Sync live Apple Health now"
                    className="rounded px-2 py-1 text-[10px] text-emerald-300/70 hover:text-emerald-200 disabled:opacity-40 cursor-pointer"
                  >
                    <FontAwesomeIcon icon={faRefresh} className={liveBusy ? 'animate-spin' : ''} />
                  </button>
                )}
                <button
                  onClick={() => void onDelete(record.id)}
                  className="rounded px-2 py-1 text-[10px] text-white/40 hover:text-red-300 cursor-pointer"
                  title="Delete record and observations"
                >
                  <FontAwesomeIcon icon={faTrash} />
                </button>
              </div>
            </li>
            )
          })}
        </ul>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-white/25">
        Ingestion runs locally and does not require an AI key. Bloodwork PDF extraction sends only structured lab rows (redacted) to your configured AI provider.
      </p>
    </section>
  )
}
