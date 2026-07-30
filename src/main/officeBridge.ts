// A request/response channel that runs the wrong way round.
//
// Every other main->renderer message in this app is a broadcast: progress, run
// state, a stream chunk. This one needs an answer, because the editor lives in
// the renderer and the tools that drive it run here. So: a pending-request map,
// a broadcast out, an ipcMain.handle back, and a timeout.
//
// Deliberately kept small and specific rather than generalised. Nothing else
// needs it, and a general version would invite someone to make main block on
// the renderer for something that should have been a broadcast.
import { randomUUID } from 'crypto'
import { IPC } from './ipcChannels'
import { broadcast } from './remoteBridge'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  /**
   * An open request is WAITING for the editor to appear, so "the editor is not
   * open" must never cancel it — that is its whole purpose. Only edits are
   * stranded when the document goes away.
   */
  cancelWhenClosed: boolean
}

const pending = new Map<string, Pending>()

/** Long enough for a large paste to land, short enough that a closed tab is not a hang. */
const EDITOR_REQUEST_TIMEOUT_MS = 30_000

/**
 * Opening is slower than editing: the frame has to boot sdkjs and instantiate
 * 63 MB of wasm before the document is editable. Measured cold start is well
 * under this, but a first run on a cold disk cache is not.
 */
const EDITOR_OPEN_TIMEOUT_MS = 90_000

let editorOpen = false

/**
 * Which editor is open: the office suite, the raster canvas, or the vector
 * canvas. Design kinds arrive verbatim from the frame; anything else that
 * reports open is the office editor, which predates the kind argument.
 */
type EditorKind = 'office' | 'image' | 'vector'
let openEditorKind: EditorKind | null = null

/**
 * Reported by the Work page. Gates whether the `work_*` and `design_*` tools
 * are offered at all — a model that cannot see the tools cannot try to use
 * them on a document that is not there.
 */
export function setEditorOpen(open: boolean, kind?: string): void {
  editorOpen = open
  if (open) {
    openEditorKind = kind === 'image' || kind === 'vector' ? kind : 'office'
    return
  }
  openEditorKind = null
  // Closing the document strands every request in flight. Rejecting them beats
  // leaving the model waiting 30s for an editor that has gone.
  for (const [id, entry] of pending) {
    if (!entry.cancelWhenClosed) continue
    clearTimeout(entry.timer)
    entry.reject(new Error('The document was closed before the edit could be applied'))
    pending.delete(id)
  }
}

export function isEditorOpen(): boolean {
  return editorOpen
}

/** Null when nothing is open. */
export function editorKind(): EditorKind | null {
  return openEditorKind
}

/**
 * Ask the open editor to do something and wait for the answer.
 *
 * `broadcast` sends to every window, and Holmes is single-window — verified: no
 * BrowserView or WebContentsView exists anywhere. A second window would answer
 * the same request twice, and the second answer would be dropped by the
 * `pending` lookup rather than corrupting anything, but the assumption is worth
 * knowing about.
 */
export function requestEditor(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (!editorOpen) return Promise.reject(new Error('No document is open in the Work tab'))
  return awaitRenderer(IPC.WORK.EDITOR_REQUEST, action, payload, EDITOR_REQUEST_TIMEOUT_MS, true)
}

/**
 * Open the Work tab on a new document and wait until it can be edited.
 *
 * Broadcast on its own channel because App handles it, not the editor frame —
 * at this point the frame does not exist. It resolves only once the editor
 * reports ready, so the model's next tool call lands on a live document rather
 * than racing a cold start.
 */
export function openWorkDocument(kind: string, name?: string): Promise<unknown> {
  return awaitRenderer(IPC.WORK.OPEN_DOCUMENT, 'open', { kind, name }, EDITOR_OPEN_TIMEOUT_MS, false)
}

function awaitRenderer(
  channel: string,
  action: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  cancelWhenClosed: boolean,
): Promise<unknown> {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`The editor did not answer within ${timeoutMs / 1000}s`))
    }, timeoutMs)
    pending.set(requestId, { resolve, reject, timer, cancelWhenClosed })
    broadcast(channel, { requestId, action, payload })
  })
}

/** Called by the WORK.EDITOR_RESPONSE handler in ipc.ts. */
export function settleEditorRequest(requestId: string, ok: boolean, value: unknown): void {
  const entry = pending.get(requestId)
  // A late answer to a request that already timed out is not an error.
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(requestId)
  if (ok) entry.resolve(value)
  else entry.reject(new Error(typeof value === 'string' ? value : 'The editor refused the edit'))
}
