import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { WorkDocumentKind } from '@shared/workDocuments'

/**
 * The design editor, embedded — Graphite, one procedural canvas for both the
 * image and vector kinds (the kind decides what Save exports: PNG or SVG).
 *
 * The structural twin of OfficeEditorFrame, kept as its own component rather
 * than a generalisation of it: the office frame's comments and tests are
 * load-bearing, and the two differ in exactly the ways worth reading here —
 * the message tag is `holmesDesign`, and editor-open is reported to main WITH
 * the kind so it offers the design_* tools, not the office ones.
 *
 * Everything third-party lives behind the iframe in its own holmes-design://
 * origin, with no preload, no `window.electronAPI`, and no network scheme it
 * can reach. This component only ever posts messages at it.
 */

const SHELL_URLS: Partial<Record<WorkDocumentKind, string>> = {
  image: 'holmes-design://graphite/holmes/shell.html',
  vector: 'holmes-design://graphite/holmes/shell.html',
}
/** Long enough for a cold start on a slow disk; short enough to not look hung. */
const READY_TIMEOUT_MS = 20_000

type ShellState = 'loading' | 'ready' | 'unavailable'

/** Same handle shape as OfficeEditorHandle, so WorkspaceView holds one ref type. */
export interface DesignEditorHandle {
  /** The design as file bytes: PNG from the raster editor, SVG from the vector. */
  exportDocument: () => Promise<{ bytes: Uint8Array; fileName: string }>
}

interface DesignEditorFrameProps {
  kind: WorkDocumentKind
  /** Bumped by the caller to reopen — a new design of the same kind. */
  openToken?: number
  onStateChange?: (state: ShellState) => void
  /** Unsaved changes. Holmes counts these as work in flight. */
  onDirtyChange?: (dirty: boolean) => void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export const DesignEditorFrame = forwardRef<DesignEditorHandle, DesignEditorFrameProps>(function DesignEditorFrame(
  { kind, openToken = 0, onStateChange, onDirtyChange },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const pending = useRef(new Map<number, PendingCall>())
  const nextId = useRef(1)
  const shellReady = useRef(false)
  const [state, setState] = useState<ShellState>('loading')

  // Held in a ref, not closed over — same reopen-loop reasoning as
  // OfficeEditorFrame.
  const onStateChangeRef = useRef(onStateChange)
  const onDirtyRef = useRef(onDirtyChange)
  useEffect(() => {
    onStateChangeRef.current = onStateChange
    onDirtyRef.current = onDirtyChange
  }, [onStateChange, onDirtyChange])

  const move = useCallback((next: ShellState) => {
    setState(next)
    onStateChangeRef.current?.(next)
  }, [])

  const call = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    const frame = frameRef.current
    if (!frame?.contentWindow) return Promise.reject(new Error('The editor is not loaded'))
    const id = nextId.current++
    return new Promise<unknown>((resolve, reject) => {
      pending.current.set(id, { resolve, reject })
      frame.contentWindow!.postMessage({ holmesDesign: true, id, action, ...payload }, '*')
    })
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The shell is the only thing that talks this protocol, and it is the only
      // thing in that origin — but check anyway rather than trusting the shape.
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data as { holmesDesign?: boolean; type?: string; id?: number; result?: unknown; error?: string }
      if (!data || data.holmesDesign !== true) return

      if (data.type === 'shell-ready') {
        shellReady.current = true
        return
      }
      if (data.type === 'dirty') {
        onDirtyRef.current?.(Boolean((data as { dirty?: unknown }).dirty))
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

  // The AI bridge: main broadcasts a request, this forwards it to the shell and
  // sends the answer back. Subscribed here because this is the component that
  // holds the frame — the same rule as OfficeEditorFrame, and only one of the
  // two is ever mounted, because workKind is single-valued.
  useEffect(() => {
    const stop = window.electronAPI.work.onEditorRequest((request) => {
      call(request.action, request.payload)
        .then((value) => window.electronAPI.work.respondToEditor({ requestId: request.requestId, ok: true, value }))
        .catch((error: unknown) => window.electronAPI.work.respondToEditor({
          requestId: request.requestId,
          ok: false,
          value: error instanceof Error ? error.message : String(error),
        }))
    })
    return stop
  }, [call])

  // Main gates the design_* tools on this — and on the KIND, so an open raster
  // canvas offers the raster tools and never the SVG ones.
  //
  // Only ever reports `true` here; `false` only on unmount. Reporting `false`
  // during boot cancels the very open request that is waiting — the lesson
  // OfficeEditorFrame's comment records.
  useEffect(() => {
    if (state !== 'ready') return
    void window.electronAPI.work.setEditorOpen(true, kind)
  }, [state, kind])

  // Closing really is closing, and only on unmount.
  useEffect(() => () => { void window.electronAPI.work.setEditorOpen(false) }, [])

  useImperativeHandle(ref, () => ({
    exportDocument: async () => {
      const result = (await call('export')) as { bytes: Uint8Array; fileName: string }
      if (!result?.bytes?.byteLength) throw new Error('The editor returned an empty design')
      return result
    },
  }), [call])

  return (
    <div className="relative flex-1">
      <iframe
        ref={frameRef}
        src={SHELL_URLS[kind]}
        title="Design editor"
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
                  <code className="font-mono text-white/60">pnpm vendor:design</code> then{' '}
                  <code className="font-mono text-white/60">pnpm build:design-shell</code>.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
