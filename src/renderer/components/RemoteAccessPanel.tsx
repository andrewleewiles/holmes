import { useCallback, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faMobileScreen, faRotate, faTrash, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { RemoteDevice, RemoteServerStatus } from '@shared/remote'

function formatLastSeen(lastSeenAt: number | null): string {
  if (!lastSeenAt) return 'never connected'
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000)
  if (minutes < 1) return 'connected just now'
  if (minutes < 60) return `last seen ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `last seen ${hours}h ago`
  return `last seen ${Math.floor(hours / 24)}d ago`
}

export function RemoteAccessPanel(): React.ReactElement {
  const [status, setStatus] = useState<RemoteServerStatus | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const refreshDevices = useCallback(async () => {
    setDevices(await window.electronAPI.remote.listDevices())
  }, [])

  useEffect(() => {
    void window.electronAPI.remote.getStatus().then(setStatus)
    void refreshDevices()
    return window.electronAPI.remote.onStatus((next) => {
      setStatus(next)
      void refreshDevices()
    })
  }, [refreshDevices])

  // Only ticks while a code is live, so the panel is not repainting on a timer
  // for the whole time Settings is open.
  useEffect(() => {
    if (!status?.pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status?.pairing])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const enabled = status?.enabled ?? false
  const pairing = status?.pairing ?? null
  const secondsLeft = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-white/80">Remote access</div>
          <p className="mt-1 text-xs leading-relaxed text-white/40">
            Lets the Holmes app on your iPhone talk to this Mac over your tailnet. The phone stores nothing:
            every answer, and your provider key, stay here. <span className="text-white/55">Chat and read-only
            browsing only</span> — a paired phone cannot read or write files, change your file access scope,
            see your provider key, or pair another device.
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void run(async () => setStatus(await window.electronAPI.remote.setEnabled(e.target.checked)))}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-sky-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
        </label>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-400/[0.07] p-2.5 text-[11px] text-red-100/70">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {enabled && status && (
        <div className="mt-4 space-y-4 border-t border-white/[0.07] pt-4">
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className="text-white/35">
              {status.listening
                ? <>Listening on <span className="text-white/60">{status.host ?? 'this Mac'}:{status.port}</span></>
                : status.error ?? 'Starting…'}
            </span>
            <span className="text-white/35">
              {status.connectedDeviceIds.length > 0
                ? `${status.connectedDeviceIds.length} connected`
                : 'no device connected'}
            </span>
          </div>

          {pairing ? (
            <div className="rounded-xl border border-sky-400/20 bg-sky-500/[0.06] p-4">
              <div className="text-[10px] font-medium uppercase tracking-wider text-white/35">
                Enter this on your iPhone
              </div>
              <div className="mt-2 font-mono text-2xl tracking-[0.3em] text-white">{pairing.code}</div>
              <div className="mt-3 space-y-1 text-[11px] text-white/45">
                <div>Host <span className="font-mono text-white/70">{pairing.host}</span></div>
                <div>Port <span className="font-mono text-white/70">{pairing.port}</span></div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-[11px] text-white/30">
                  {secondsLeft > 0 ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Expired'}
                </span>
                <button
                  onClick={() => void run(() => window.electronAPI.remote.cancelPairing())}
                  className="text-[11px] text-white/40 hover:text-white/70 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              disabled={busy || !status.listening}
              onClick={() => void run(() => window.electronAPI.remote.createPairing())}
              className="flex items-center gap-2 rounded-lg bg-white/[0.06] px-3 py-2 text-xs text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40 cursor-pointer"
            >
              <FontAwesomeIcon icon={faMobileScreen} /> Pair a device
            </button>
          )}

          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35">Paired devices</h3>
              <button
                onClick={() => void run(refreshDevices)}
                className="text-white/25 hover:text-white/60 cursor-pointer"
                title="Refresh"
              >
                <FontAwesomeIcon icon={faRotate} className="text-[11px]" />
              </button>
            </div>

            {devices.length === 0 ? (
              <p className="mt-2 text-[11px] text-white/30">No devices yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {devices.map((device) => {
                  const connected = status.connectedDeviceIds.includes(device.id)
                  return (
                    <li
                      key={device.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-white/70">
                          {connected && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
                          <span className="truncate">{device.name}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-white/30">
                          {connected ? 'connected now' : formatLastSeen(device.lastSeenAt)}
                        </div>
                      </div>
                      <button
                        onClick={() => void run(async () => {
                          await window.electronAPI.remote.revokeDevice(device.id)
                          await refreshDevices()
                        })}
                        className="shrink-0 text-white/25 hover:text-red-300 cursor-pointer"
                        title="Revoke this device"
                      >
                        <FontAwesomeIcon icon={faTrash} className="text-[11px]" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
