import { type FC, useCallback, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faArrowUpRightFromSquare,
  faBriefcase,
  faCamera,
  faCartShopping,
  faCircleCheck,
  faCircleExclamation,
  faComment,
  faEnvelope,
  faFileImport,
  faFire,
  faFolderOpen,
  faGhost,
  faHashtag,
  faHeart,
  faKey,
  faMagnifyingGlass,
  faMusic,
  faPlay,
  faRefresh,
  faShieldHalved,
  faSpinner,
  faThumbsUp,
  faTrashCan,
  faTriangleExclamation,
  faXmark,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import {
  ACTIVITY_PROVIDERS,
  type ActivityProviderDef,
  type ActivityLiveViability,
} from '@shared/activityProviders'
import type { ActivityAccount, ActivityIngestProgress } from '@shared/types'

interface ActivityAccountsPanelProps {
  projectId: string
  progress: ActivityIngestProgress | null
  onChanged: () => void
}

const ICONS: Record<string, IconDefinition> = {
  comment: faComment,
  envelope: faEnvelope,
  'magnifying-glass': faMagnifyingGlass,
  play: faPlay,
  'cart-shopping': faCartShopping,
  camera: faCamera,
  'thumbs-up': faThumbsUp,
  music: faMusic,
  ghost: faGhost,
  hashtag: faHashtag,
  briefcase: faBriefcase,
  fire: faFire,
  heart: faHeart,
}

const CONTROL_BUTTON =
  'flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-white/60 transition-colors hover:border-white/20 hover:text-white/85 disabled:cursor-default disabled:opacity-40 cursor-pointer'

const FIELD =
  'w-full rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-[11px] text-white/75 outline-none placeholder:text-white/20 focus:border-holmes-primary/40'

/** Colour of the dot in a row summary. */
function statusTone(account: ActivityAccount | undefined): string {
  if (!account?.enabled) return 'bg-white/15'
  switch (account.lastSyncStatus) {
    case 'synced':
      return 'bg-amber-400/70'
    case 'error':
      return 'bg-red-400/70'
    case 'needs_permission':
    case 'needs_reauth':
      return 'bg-amber-200/80'
    default:
      return account.eventsCount > 0 ? 'bg-amber-400/50' : 'bg-white/25'
  }
}

const VIABILITY_LABEL: Record<ActivityLiveViability, string> = {
  stable: 'Live',
  brittle: 'Live (unofficial)',
  'ban-risk': 'Live (account risk)',
  none: 'Export only',
}

const VIABILITY_TONE: Record<ActivityLiveViability, string> = {
  stable: 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200/70',
  brittle: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200/70',
  'ban-risk': 'border-red-400/30 bg-red-400/[0.07] text-red-200/75',
  none: 'border-white/10 bg-white/[0.04] text-white/40',
}

function relativeDate(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

interface AccountRowProps {
  def: ActivityProviderDef
  account: ActivityAccount | undefined
  busy: boolean
  onUpdate: (accountId: string, update: Parameters<typeof window.electronAPI.activity.updateAccount>[1]) => Promise<void>
  onSetCredential: (accountId: string, secret: string) => Promise<void>
  onClearCredential: (accountId: string) => Promise<void>
  onSync: (accountId: string) => Promise<void>
  onImport: (accountId: string) => Promise<void>
  onAddSource: (accountId: string) => Promise<void>
  onRemoveSource: (accountId: string, sourcePath: string) => Promise<void>
  onScanSources: () => Promise<void>
}

const AccountRow: FC<AccountRowProps> = ({
  def,
  account,
  busy,
  onUpdate,
  onSetCredential,
  onClearCredential,
  onSync,
  onImport,
  onAddSource,
  onRemoveSource,
  onScanSources,
}) => {
  const [secretDraft, setSecretDraft] = useState('')
  const [userDraft, setUserDraft] = useState(account?.config.imapUser ?? '')

  useEffect(() => {
    setUserDraft(account?.config.imapUser ?? '')
  }, [account?.config.imapUser])

  if (!account) return null

  const icon = ICONS[def.icon] ?? faCircleExclamation
  const riskBlocked = def.liveViability === 'ban-risk' && account.config.riskAccepted !== true
  const canSyncNow = def.live !== 'none' && account.enabled && !riskBlocked

  return (
    <details className="group overflow-hidden rounded-lg border border-white/[0.06] bg-black/10">
      <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-white/[0.03]">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(account)}`} />
        <FontAwesomeIcon icon={icon} className="w-3.5 shrink-0 text-[11px] text-white/35" />
        <span className="flex-1 truncate text-[11px] text-white/70">{def.label}</span>
        {account.eventsCount > 0 && (
          <span className="shrink-0 text-[9px] text-white/30">{account.eventsCount.toLocaleString()} events</span>
        )}
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${VIABILITY_TONE[def.liveViability]}`}
        >
          {VIABILITY_LABEL[def.liveViability]}
        </span>
        {account.enabled && (
          <span className="shrink-0 text-[9px] text-white/25">synced {relativeDate(account.lastSyncAt)}</span>
        )}
      </summary>

      <div className="space-y-3 border-t border-white/[0.05] px-3 pb-3 pt-2.5">
        <p className="text-[10px] leading-relaxed text-white/35">{def.blurb}</p>

        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-white/60">
          <input
            type="checkbox"
            checked={account.enabled}
            onChange={(event) => void onUpdate(account.id, { enabled: event.target.checked })}
            className="cursor-pointer accent-holmes-primary"
          />
          Enabled
          <span className="text-[10px] text-white/25">
            {account.enabled
              ? 'synced in the background, and its events feed the Activity analysis'
              : 'not synced, and its stored events are left out of the analysis'}
          </span>
        </label>

        {account.lastError && (
          <div className="flex items-start gap-2 rounded-md border border-red-400/20 bg-red-400/[0.06] px-2.5 py-1.5 text-[10px] leading-relaxed text-red-200/70">
            <FontAwesomeIcon icon={faCircleExclamation} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{account.lastError}</span>
          </div>
        )}

        {def.liveWarning && (
          <div
            className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[10px] leading-relaxed ${
              def.liveViability === 'ban-risk'
                ? 'border-red-400/30 bg-red-400/[0.06] text-red-200/75'
                : 'border-amber-400/20 bg-amber-400/[0.05] text-amber-100/60'
            }`}
          >
            <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{def.liveWarning}</span>
          </div>
        )}

        {def.liveViability === 'ban-risk' && (
          <label className="flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-white/55">
            <input
              type="checkbox"
              checked={account.config.riskAccepted === true}
              onChange={(event) =>
                void onUpdate(account.id, { config: { ...account.config, riskAccepted: event.target.checked } })
              }
              className="mt-0.5 cursor-pointer accent-red-400"
            />
            I understand this can get my {def.label} account terminated, and I want the live connector anyway.
          </label>
        )}

        {/* Live connection */}
        {def.live === 'local-db' && (
          <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[10px] leading-relaxed text-white/45">
            <FontAwesomeIcon icon={faShieldHalved} className="mr-1.5 text-white/30" />
            Reads a database already on this Mac. Holmes needs Full Disk Access — if a sync reports a permission
            problem, grant it in System Settings › Privacy &amp; Security.
          </div>
        )}

        {def.credential === 'app-password' && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-white/30">Connection</div>
            <input
              className={FIELD}
              placeholder="you@gmail.com"
              value={userDraft}
              onChange={(event) => setUserDraft(event.target.value)}
              onBlur={() => {
                if (userDraft !== (account.config.imapUser ?? '')) {
                  void onUpdate(account.id, { config: { ...account.config, imapUser: userDraft } })
                }
              }}
            />
            {account.credentialStored ? (
              <div className="flex items-center gap-2 text-[10px] text-emerald-200/60">
                <FontAwesomeIcon icon={faCircleCheck} />
                App password stored
                <button className={`${CONTROL_BUTTON} ml-auto`} onClick={() => void onClearCredential(account.id)}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <input
                  className={FIELD}
                  type="password"
                  placeholder="16-character app password"
                  value={secretDraft}
                  onChange={(event) => setSecretDraft(event.target.value)}
                />
                <button
                  className={CONTROL_BUTTON}
                  disabled={!secretDraft.trim()}
                  onClick={() => {
                    void onSetCredential(account.id, secretDraft).then(() => setSecretDraft(''))
                  }}
                >
                  <FontAwesomeIcon icon={faKey} />
                  Save
                </button>
              </div>
            )}
            <p className="text-[9px] leading-relaxed text-white/25">
              Turn on 2-Step Verification, then generate an app password at myaccount.google.com/apppasswords. Only
              message envelopes are read — subjects, senders and dates, never message bodies.
            </p>
          </div>
        )}

        {def.credential === 'cookie' && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-white/30">Session cookies</div>
            {account.credentialStored ? (
              <div className="flex items-center gap-2 text-[10px] text-emerald-200/60">
                <FontAwesomeIcon icon={faCircleCheck} />
                Cookies stored
                <button className={`${CONTROL_BUTTON} ml-auto`} onClick={() => void onClearCredential(account.id)}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <input
                  className={FIELD}
                  type="password"
                  placeholder="Paste the cookie header from your browser"
                  value={secretDraft}
                  onChange={(event) => setSecretDraft(event.target.value)}
                />
                <button
                  className={CONTROL_BUTTON}
                  disabled={!secretDraft.trim()}
                  onClick={() => {
                    void onSetCredential(account.id, secretDraft).then(() => setSecretDraft(''))
                  }}
                >
                  <FontAwesomeIcon icon={faKey} />
                  Save
                </button>
              </div>
            )}
          </div>
        )}

        {/* Export path */}
        {def.exportFormat !== 'none' && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/30">
              Data export
              {def.exportEta && <span className="normal-case tracking-normal text-white/20">takes {def.exportEta}</span>}
              {account.lastExportAt && (
                <span className="ml-auto normal-case tracking-normal text-white/20">
                  last import {relativeDate(account.lastExportAt)}
                </span>
              )}
            </div>
            <p className="text-[10px] leading-relaxed text-white/40">{def.exportSteps}</p>

            {/* Connected folders, laid out like a data source's directory list. */}
            {account.sources.length > 0 && (
              <ul className="space-y-1">
                {account.sources.map((source) => (
                  <li key={source.id} className="flex items-center gap-2">
                    <span className="shrink-0 text-[10px] text-white/20">↳</span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10px] text-white/45"
                      title={source.path}
                    >
                      {source.path}
                    </span>
                    <button
                      onClick={() => void onRemoveSource(account.id, source.path)}
                      title="Stop watching this folder"
                      className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-white/30 transition-colors hover:text-red-300"
                    >
                      <FontAwesomeIcon icon={faTrashCan} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <button className={CONTROL_BUTTON} disabled={busy} onClick={() => void onImport(account.id)}>
                <FontAwesomeIcon icon={faFileImport} />
                Import export file
              </button>
              <button className={CONTROL_BUTTON} onClick={() => void onAddSource(account.id)}>
                <FontAwesomeIcon icon={faFolderOpen} />
                {account.sources.length > 0 ? 'Add directory' : 'Watch a directory'}
              </button>
              {account.sources.length > 0 && (
                <button
                  className={CONTROL_BUTTON}
                  disabled={busy}
                  title="Scan the watched directories for anything new"
                  onClick={() => void onScanSources()}
                >
                  <FontAwesomeIcon icon={faRefresh} className={busy ? 'animate-spin' : ''} />
                  Scan now
                </button>
              )}
              {def.exportUrl && (
                <a
                  href={def.exportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto flex items-center gap-1 text-[10px] text-white/30 transition-colors hover:text-holmes-primary-light"
                >
                  Request your data
                  <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-[8px]" />
                </a>
              )}
            </div>
          </div>
        )}

        {def.exportFormat === 'none' && (
          <p className="text-[10px] leading-relaxed text-white/35">{def.exportSteps}</p>
        )}

        <div className="flex items-center gap-1.5 border-t border-white/[0.04] pt-2">
          <button
            className={CONTROL_BUTTON}
            disabled={!canSyncNow || busy}
            title={
              def.live === 'none'
                ? `${def.label} has no live path — import an export instead`
                : riskBlocked
                  ? 'Accept the risk acknowledgement first'
                  : `Sync ${def.label} now`
            }
            onClick={() => void onSync(account.id)}
          >
            <FontAwesomeIcon icon={faRefresh} className={busy ? 'animate-spin' : ''} />
            Sync now
          </button>
        </div>
      </div>
    </details>
  )
}

export const ActivityAccountsPanel: FC<ActivityAccountsPanelProps> = ({ projectId, progress, onChanged }) => {
  const [accounts, setAccounts] = useState<ActivityAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setAccounts(await window.electronAPI.activity.listAccounts(projectId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load accounts')
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const byProvider = useMemo(() => new Map(accounts.map((a) => [a.provider, a])), [accounts])

  /** Every mutation refreshes both this list and the records list above it. */
  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await action()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed')
      } finally {
        setBusy(false)
        await refresh()
        onChanged()
      }
    },
    [refresh, onChanged]
  )

  const handlers = useMemo(
    () => ({
      onUpdate: async (accountId: string, update: Parameters<typeof window.electronAPI.activity.updateAccount>[1]) => {
        await run(() => window.electronAPI.activity.updateAccount(accountId, update))
      },
      onSetCredential: async (accountId: string, secret: string) => {
        await run(() => window.electronAPI.activity.setAccountCredential(accountId, secret))
      },
      onClearCredential: async (accountId: string) => {
        await run(() => window.electronAPI.activity.clearAccountCredential(accountId))
      },
      onSync: async (accountId: string) => {
        await run(async () => {
          const result = await window.electronAPI.activity.syncAccount(accountId)
          // A skip is not a failure, but it is the only feedback the user gets
          // for an account whose live path is not implemented.
          if (result.status === 'skipped' && result.message) setError(result.message)
        })
      },
      onImport: async (accountId: string) => {
        const files = await window.electronAPI.app.selectFiles()
        if (files.length === 0) return
        await run(async () => {
          for (const file of files) {
            await window.electronAPI.activity.importAccountExport(accountId, file)
          }
        })
      },
      onAddSource: async (accountId: string) => {
        const folder = await window.electronAPI.app.selectDirectory()
        if (!folder) return
        await run(() => window.electronAPI.activity.addAccountSource(accountId, folder))
      },
      onRemoveSource: async (accountId: string, sourcePath: string) => {
        await run(() => window.electronAPI.activity.removeAccountSource(accountId, sourcePath))
      },
      onScanSources: async () => {
        await run(async () => {
          const { ingested } = await window.electronAPI.activity.scanAccountSources(projectId)
          if (ingested === 0) setError('Nothing new found in the watched directories.')
        })
      },
    }),
    [run, projectId]
  )

  const googleProviders = ACTIVITY_PROVIDERS.filter((p) => p.parent === 'google')
  const flatProviders = ACTIVITY_PROVIDERS.filter((p) => !p.parent)

  const renderRow = (def: ActivityProviderDef) => (
    <AccountRow key={def.id} def={def} account={byProvider.get(def.id)} busy={busy} {...handlers} />
  )

  const enabledCount = accounts.filter((a) => a.enabled).length

  return (
    <section className="mb-6 rounded-2xl border border-white/10 bg-holmes-surface p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif-display text-sm font-medium text-white/75">Connected accounts</h2>
          <p className="mt-0.5 text-xs text-white/35">
            Each account is configured on its own. A few can sync live; the rest read the data export the service
            provides — point one at a watched folder and new exports get picked up automatically.
          </p>
        </div>
        <span className="shrink-0 text-[10px] text-white/30">
          {enabledCount} of {ACTIVITY_PROVIDERS.length} enabled
        </span>
      </div>

      {progress && progress.provider && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-white/[0.07] bg-black/10 p-3 text-xs text-white/55">
          <FontAwesomeIcon icon={faSpinner} spin className="text-amber-300" />
          <span className="capitalize">{progress.phase}</span>
          <span className="text-white/35">— {progress.message}</span>
        </div>
      )}

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3 text-xs text-amber-100/70">
          <span className="min-w-0 flex-1">{error}</span>
          <button onClick={() => setError(null)} className="cursor-pointer text-amber-100/35 hover:text-amber-100">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        {/* Gmail and Search history are one Google account to the user. */}
        <details className="group overflow-hidden rounded-lg border border-white/[0.06] bg-black/[0.15]" open>
          <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-white/[0.03]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/25" />
            <span className="flex-1 text-[11px] text-white/70">Google</span>
            <span className="text-[9px] text-white/25">{googleProviders.length} services</span>
          </summary>
          <div className="space-y-1.5 border-t border-white/[0.05] p-2">{googleProviders.map(renderRow)}</div>
        </details>

        {flatProviders.map(renderRow)}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-white/25">
        Everything is parsed locally. iMessage stores a 500-character excerpt of each message; every other account
        keeps message metadata only — who, when and how much. All text is redacted for addresses, tokens and payment
        numbers before any AI analysis runs.
      </p>
    </section>
  )
}
