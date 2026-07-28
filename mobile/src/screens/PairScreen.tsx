import { useState } from 'react'
import { REMOTE_DEFAULT_PORT } from '@shared/remote'
import { remoteClient } from '../transport/client'

export function PairScreen({ onPaired }: { onPaired: () => void }): React.ReactElement {
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(REMOTE_DEFAULT_PORT))
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('iPhone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await remoteClient.pair({
        host,
        port: Number(port) || REMOTE_DEFAULT_PORT,
        code,
        deviceName: deviceName.trim() || 'iPhone',
      })
      onPaired()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not pair')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col justify-center px-6 py-12">
      <h1 className="font-serif-display text-2xl text-white">Connect to your Mac</h1>
      <p className="mt-2 text-sm leading-relaxed text-white/40">
        Open Holmes on your Mac, go to Settings, turn on Remote access and tap Pair a device. Your Mac and this
        iPhone both need to be on your tailnet.
      </p>

      <div className="mt-8 space-y-4">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">Mac name</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="macbook.tailnet.ts.net"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-base text-white placeholder:text-white/20 focus:border-sky-400/40 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">Port</span>
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-base text-white focus:border-sky-400/40 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">Pairing code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXXXXXX"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 font-mono text-xl tracking-[0.25em] text-white placeholder:tracking-normal placeholder:text-white/20 focus:border-sky-400/40 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-white/35">This device</span>
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-base text-white focus:border-sky-400/40 focus:outline-none"
          />
        </label>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-sm text-red-100/75">
          {error}
        </div>
      )}

      <button
        onClick={() => void submit()}
        disabled={busy || !host.trim() || code.trim().length < 4}
        className="mt-6 rounded-xl bg-sky-500 px-4 py-3.5 text-base font-medium text-white transition-colors disabled:opacity-30"
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  )
}
