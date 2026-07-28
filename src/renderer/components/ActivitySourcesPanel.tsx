import { type FC, useCallback, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCircleCheck,
  faCircleExclamation,
  faFileImport,
  faKey,
  faRefresh,
  faShieldHalved,
  faSpinner,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import type { ActivityIngestProgress, ActivityRecord, ActivitySourceType } from '@shared/types'

interface ActivitySourcesPanelProps {
  projectId: string
  records: ActivityRecord[]
  progress: ActivityIngestProgress | null
  onIngest: (filePath: string, source: ActivitySourceType) => Promise<void>
  onAbort: () => Promise<void>
  onDelete: (recordId: string) => Promise<void>
  onRefresh: () => void
  onLiveSync: (sourceTypes?: ActivitySourceType[]) => Promise<void>
  liveBusy?: boolean
  onScanDirectory?: () => Promise<void>
  scanning?: boolean
  hasDirectory?: boolean
}

const SOURCE_LABEL: Record<ActivitySourceType, string> = {
  browser: 'Browser',
  youtube: 'YouTube',
  amazon: 'Amazon',
  email: 'Email',
  knowledge: 'Knowledge',
  photos: 'Photos',
  location: 'Location',
  weather: 'Weather',
  subscription: 'Subscription',
  account: 'Account',
}

const LIVE_SOURCES: ActivitySourceType[] = ['knowledge', 'amazon', 'photos', 'weather', 'subscription']

const INGEST_SOURCES: Array<{ value: ActivitySourceType; label: string }> = [
  { value: 'browser', label: 'Browser history' },
  { value: 'youtube', label: 'YouTube history' },
  { value: 'amazon', label: 'Amazon orders' },
  { value: 'email', label: 'Email export' },
  { value: 'photos', label: 'Photos library' },
  { value: 'location', label: 'Location history' },
  { value: 'subscription', label: 'Subscriptions' },
]

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export const ActivitySourcesPanel: FC<ActivitySourcesPanelProps> = ({
  projectId,
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
  const [pendingSource, setPendingSource] = useState<ActivitySourceType>('browser')

  const handleChooseFiles = useCallback(async () => {
    setChoosing(true)
    setError(null)
    try {
      const files = await window.electronAPI.app.selectFiles()
      for (const file of files) {
        try {
          await onIngest(file, pendingSource)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Ingest failed')
          break
        }
      }
      onRefresh()
    } finally {
      setChoosing(false)
    }
  }, [onIngest, onRefresh, pendingSource])

  const handleGrantPermission = async () => {
    try {
      await window.electronAPI.activity.grantPermission()
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open System Settings')
    }
  }

  void projectId

  return (
    <section className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-sm font-medium text-white/75 font-serif-display">Activity sources</h2>
          <p className="text-xs text-white/35 mt-0.5">
            Import browser/email/YouTube exports, or connect live sources (knowledge, Amazon, photos, weather, subscriptions).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasDirectory && onScanDirectory && (
            <button
              onClick={() => void onScanDirectory()}
              disabled={scanning || choosing}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 hover:border-white/20 hover:text-white/80 disabled:opacity-40 cursor-pointer"
            >
              <FontAwesomeIcon icon={faRefresh} className={`text-[11px] ${scanning ? 'animate-spin' : ''}`} />
              {scanning ? 'Scanning…' : 'Scan directory'}
            </button>
          )}
          <select
            value={pendingSource}
            onChange={(event) => setPendingSource(event.target.value as ActivitySourceType)}
            className="rounded-lg border border-white/10 bg-black/15 px-2 py-1.5 text-[11px] text-white/65 outline-none"
          >
            {INGEST_SOURCES.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            onClick={() => void handleChooseFiles()}
            disabled={choosing}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/60 hover:border-white/20 hover:text-white/80 disabled:opacity-40 cursor-pointer"
          >
            <FontAwesomeIcon icon={faFileImport} className="text-[11px]" />
            {choosing ? 'Importing…' : 'Import file'}
          </button>
          <button
            onClick={() => onRefresh()}
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
            <FontAwesomeIcon icon={faSpinner} spin className="text-amber-300" />
            <span className="capitalize">{progress.phase}</span>
            <span className="text-white/35">— {progress.message}</span>
            {progress.sourceType && (
              <span className="rounded-full bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/40">
                {SOURCE_LABEL[progress.sourceType]}
              </span>
            )}
            {progress.phase !== 'complete' && progress.phase !== 'permission' && progress.phase !== 'reauth' && (
              <button
                onClick={() => void onAbort()}
                className="ml-auto text-[10px] text-white/40 hover:text-red-300 cursor-pointer"
              >
                Abort
              </button>
            )}
          </div>
          {progress.total != null && progress.total > 0 && progress.current != null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full bg-amber-400 transition-all"
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
          No sources imported yet. Choose a source type above and import a file, or use Sync now for live sources.
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
          {records.map((record) => {
            const isLive = LIVE_SOURCES.includes(record.sourceType) && (record.filename === 'live-sync' || record.filename == null)
            return (
              <li
                key={record.id}
                className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${
                  isLive
                    ? 'border-amber-400/20 bg-amber-500/[0.05]'
                    : 'border-white/[0.07] bg-black/10'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[11px] text-white/70" title={record.filename || SOURCE_LABEL[record.sourceType]}>
                      {record.filename || SOURCE_LABEL[record.sourceType]}
                    </span>
                    <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] uppercase tracking-wider text-white/40">
                      {SOURCE_LABEL[record.sourceType]}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-white/35">
                    <span>{formatDate(record.importedAt)}</span>
                    <span>·</span>
                    <span>{record.eventsCount} events</span>
                    <span>·</span>
                    {record.status === 'parsed' && (
                      <span className="text-amber-300/70">
                        <FontAwesomeIcon icon={faCircleCheck} className="mr-1" /> parsed
                      </span>
                    )}
                    {record.status === 'pending' && (
                      <span className="text-amber-300/70">
                        <FontAwesomeIcon icon={faSpinner} spin className="mr-1" /> pending
                      </span>
                    )}
                    {record.status === 'failed' && (
                      <span className="text-red-300/70" title={record.parseError ?? ''}>
                        <FontAwesomeIcon icon={faCircleExclamation} className="mr-1" /> failed
                      </span>
                    )}
                    {record.status === 'needs_permission' && (
                      <span className="text-amber-200/80">
                        <FontAwesomeIcon icon={faShieldHalved} className="mr-1" /> needs permission
                      </span>
                    )}
                  </div>
                  {record.status === 'failed' && record.parseError && (
                    <p className="mt-1 text-[10px] leading-relaxed text-red-300/70 line-clamp-2">{record.parseError}</p>
                  )}
                  {record.status === 'needs_permission' && (
                    <div className="mt-1.5">
                      <button
                        onClick={() => void handleGrantPermission()}
                        className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[10px] text-amber-200/80 hover:border-amber-400/50 cursor-pointer"
                      >
                        <FontAwesomeIcon icon={faShieldHalved} className="mr-1" />
                        Grant Full Disk Access
                      </button>
                    </div>
                  )}
                  {record.sourceType === 'amazon' && record.status === 'failed' && record.parseError?.toLowerCase().includes('reauth') && (
                    <p className="mt-1 text-[10px] leading-relaxed text-amber-200/70">
                      <FontAwesomeIcon icon={faKey} className="mr-1" />
                      Reconnect Amazon in Settings (Amazon cookies section).
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isLive && (
                    <button
                      onClick={() => void onLiveSync([record.sourceType])}
                      disabled={liveBusy}
                      title={`Sync ${SOURCE_LABEL[record.sourceType]} now`}
                      className="rounded px-2 py-1 text-[10px] text-amber-300/70 hover:text-amber-200 disabled:opacity-40 cursor-pointer"
                    >
                      <FontAwesomeIcon icon={faRefresh} className={liveBusy ? 'animate-spin' : ''} />
                    </button>
                  )}
                  <button
                    onClick={() => void onDelete(record.id)}
                    className="rounded px-2 py-1 text-[10px] text-white/40 hover:text-red-300 cursor-pointer"
                    title="Delete record and events"
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
        Ingestion runs locally. Email and Amazon order data are redacted for API keys, passwords, and payment numbers before any AI summary generation.
      </p>
    </section>
  )
}
