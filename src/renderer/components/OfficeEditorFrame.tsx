import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import type { WorkDocumentKind } from '@shared/workDocuments'

/**
 * The ONLYOFFICE editor, embedded.
 *
 * Everything ONLYOFFICE lives behind this iframe, in the `holmes-office://`
 * origin: the editor, its wasm converter, and the shell that drives them. This
 * component only ever posts messages at it. That is deliberate — the editor
 * needs `unsafe-eval`, and this is what keeps that inside a frame which has no
 * preload, no `window.electronAPI`, and no network scheme it can reach.
 */

const SHELL_URL = 'holmes-office://editor/holmes/shell.html'
/** Long enough for a cold start on a slow disk; short enough to not look hung. */
const READY_TIMEOUT_MS = 20_000

type ShellState = 'loading' | 'ready' | 'unavailable'

interface OfficeEditorFrameProps {
  kind: WorkDocumentKind
  /** Bumped by the caller to reopen — a new document of the same kind. */
  openToken?: number
  onStateChange?: (state: ShellState) => void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export const OfficeEditorFrame: FC<OfficeEditorFrameProps> = ({ kind, openToken = 0, onStateChange }) => {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const pending = useRef(new Map<number, PendingCall>())
  const nextId = useRef(1)
  const shellReady = useRef(false)
  const [state, setState] = useState<ShellState>('loading')

  const move = useCallback((next: ShellState) => {
    setState(next)
    onStateChange?.(next)
  }, [onStateChange])

  const call = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    const frame = frameRef.current
    if (!frame?.contentWindow) return Promise.reject(new Error('The editor is not loaded'))
    const id = nextId.current++
    return new Promise<unknown>((resolve, reject) => {
      pending.current.set(id, { resolve, reject })
      frame.contentWindow!.postMessage({ holmesOffice: true, id, action, ...payload }, '*')
    })
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The shell is the only thing that talks this protocol, and it is the only
      // thing in that origin — but check anyway rather than trusting the shape.
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { holmesOffice?: boolean; type?: string; id?: number; result?: unknown; error?: string }
      if (!data || data.holmesOffice !== true) return

      if (data.type === 'shell-ready') {
        shellReady.current = true
        return
      }
      if (data.id === undefined) return
      const entry = pending.current.get(data.id)
      if (!entry) return
      pending.current.delete(data.id)
      if (data.type === 'error') entry.reject(new Error(data.error || 'The editor refused the request'))
      else entry.resolve(data.result)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Open (or reopen) once the shell has announced itself. Polled rather than
  // event-driven because the frame may already have been ready before this
  // effect ran, and a missed announcement would leave a blank editor forever.
  useEffect(() => {
    let cancelled = false
    let waited = 0
    const step = 150
    move('loading')

    const tick = () => {
      if (cancelled) return
      if (shellReady.current) {
        call('open', { kind })
          .then(() => { if (!cancelled) move('ready') })
          .catch(() => { if (!cancelled) move('unavailable') })
        return
      }
      waited += step
      if (waited >= READY_TIMEOUT_MS) {
        if (!cancelled) move('unavailable')
        return
      }
      window.setTimeout(tick, step)
    }
    window.setTimeout(tick, step)
    return () => { cancelled = true }
  }, [kind, openToken, call, move])

  return (
    <div className="relative flex-1">
      <iframe
        ref={frameRef}
        src={SHELL_URL}
        title="Document editor"
        className="absolute inset-0 h-full w-full border-0"
        // allow-same-origin is required: the shell drives the editor iframe it
        // creates, which only works same-origin. Combined with allow-scripts
        // that means this attribute is NOT the security boundary — the response
        // CSP and the absence of a preload are.
        sandbox="allow-scripts allow-same-origin allow-downloads allow-modals allow-popups"
        allow="clipboard-read; clipboard-write"
      />
      {state !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-holmes-bg">
          <div className="pointer-events-auto max-w-md px-6 text-center">
            {state === 'loading' ? (
              <p className="text-[14px] text-white/45">Opening the editor…</p>
            ) : (
              <>
                <p className="text-[14px] text-white/70">The editor could not be loaded.</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">
                  Its bundle is not installed in this build. Run{' '}
                  <code className="font-mono text-white/60">node scripts/build-office-shell.mjs</code>{' '}
                  after vendoring ONLYOFFICE.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
