// What the two design shells have in common: the postMessage contract with
// DesignEditorFrame, the editor iframe they wrap, and the dirty heartbeat.
//
// Same construction as office-shell/shell.ts, one step simpler: there is no
// vendored wrapper library in between. Each shell page is served from its own
// holmes-design:// host, creates an iframe onto the vendored editor's own
// index.html (same origin, untouched bytes), and drives the editor through the
// globals it publishes.

/** Only the embedding renderer may drive this page. */
export function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ holmesDesign: true, ...message }, '*')
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** The editor page, embedded same-origin so the shell can reach its globals. */
export function createEditorFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.id = 'holmes-design-editor'
  frame.setAttribute('title', 'Design editor')
  frame.src = '../index.html'
  document.getElementById('holmes-design-root')!.appendChild(frame)
  return frame
}

/**
 * Polls until the editor publishes what the shell needs. Editors initialise
 * asynchronously after their load event (svgedit's svgCanvas only exists once
 * Editor.init() has fetched locales and extensions), so readiness is a probe,
 * not an event.
 */
export function until<T>(probe: () => T | null | undefined, what: string, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let value: T | null | undefined
      try {
        value = probe()
      } catch {
        value = null
      }
      if (value !== null && value !== undefined) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error(`The editor did not expose ${what}`))
      window.setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * Whether the design has edits that are not on disk. Holmes treats unsaved work
 * as a task in flight, so the workspace is not torn down underneath it when the
 * user navigates away. `depth` is whatever monotonic edit counter the editor
 * offers; the baseline moves on open and export, which is when Holmes considers
 * the content accounted for.
 */
export function watchDirty(depth: () => number): { rebase: () => void } {
  let baseline = 0
  let lastDirty: boolean | null = null
  const check = () => {
    let dirty: boolean
    try {
      dirty = depth() !== baseline
    } catch {
      return
    }
    if (dirty === lastDirty) return
    lastDirty = dirty
    post({ type: 'dirty', dirty })
  }
  window.setInterval(check, 500)
  return {
    rebase: () => {
      try {
        baseline = depth()
      } catch {
        baseline = 0
      }
      check()
    },
  }
}

/**
 * Wires the message contract and announces the shell. The `open` action is the
 * handler's job to await editor readiness on; shell-ready only means this
 * script is running — the same split the office shell uses, because the frame
 * may finish loading before or after the embedding component subscribes.
 */
export function installShell(
  handle: (action: string, payload: Record<string, unknown>) => Promise<unknown>,
): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { holmesDesign?: boolean; id?: number; action?: string } | null
    if (!data || data.holmesDesign !== true || typeof data.action !== 'string') return
    const id = data.id
    void handle(data.action, data as unknown as Record<string, unknown>)
      .then((result) => post({ type: 'result', id, result }))
      .catch((error) => post({ type: 'error', id, error: describe(error) }))
  })
  window.addEventListener('error', (event) => post({ type: 'crash', error: event.message }))
  post({ type: 'shell-ready' })
}
