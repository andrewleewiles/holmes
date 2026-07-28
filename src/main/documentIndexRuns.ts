import type {
  DocumentContextProgress,
  DocumentIndexOutcome,
  DocumentIndexPauseRecord,
  DocumentIndexScope,
  DocumentIndexState,
  DocumentIndexStatus,
} from '../shared/types'
import { getDocumentIndexPause, setDocumentIndexPause } from './settings'

export interface DocumentIndexRun {
  token: number
  scope: DocumentIndexScope
  controller: AbortController
  signal: AbortSignal
}

interface ActiveRun extends DocumentIndexRun {
  origin: 'user' | 'timer'
}

const PROGRESS_NOTIFY_INTERVAL_MS = 400

/**
 * How long an indexing run may go without finishing a single document before it
 * is treated as stuck. Sized against the worst legitimate gap between two
 * progress events — one document's three retry attempts, each waiting behind the
 * configured requests-per-minute budget — with a wide margin on top, so only a
 * genuinely dead request trips it.
 */
export const INDEX_IDLE_TIMEOUT_MINUTES = 15
export const INDEX_IDLE_TIMEOUT_MS = INDEX_IDLE_TIMEOUT_MINUTES * 60 * 1000

let active: ActiveRun | null = null
let pendingAction: 'pause' | 'stop' | null = null
let lastProgress: DocumentContextProgress | null = null
let statusMessage: string | null = null
let lastScope: DocumentIndexScope | null = null
let lastProjectId: string | null = null
let lastProjectName: string | null = null
let nextToken = 1
let lastNotifyAt = 0

type StateListener = (state: DocumentIndexState) => void
const listeners = new Set<StateListener>()

export function subscribeDocumentIndexState(listener: StateListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(force: boolean): void {
  if (!force) {
    const now = Date.now()
    if (now - lastNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return
    lastNotifyAt = now
  } else {
    lastNotifyAt = Date.now()
  }
  const state = getDocumentIndexState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch { /* A dead renderer must never break the run. */ }
  }
}

export function getDocumentIndexState(): DocumentIndexState {
  const paused = active ? null : getDocumentIndexPause()
  let status: DocumentIndexStatus = 'idle'
  if (active) status = pendingAction ? 'stopping' : 'running'
  else if (paused) status = 'paused'
  return {
    status,
    scope: active?.scope ?? paused?.scope ?? lastScope,
    projectId: paused?.projectId ?? lastProjectId,
    projectName: paused?.projectName ?? lastProjectName,
    pendingAction,
    origin: active?.origin ?? null,
    progress: active ? lastProgress : null,
    message: active ? null : paused?.message ?? statusMessage,
    canResume: !active && Boolean(paused),
    updatedAt: new Date().toISOString(),
  }
}

export function isDocumentIndexRunActive(): boolean {
  return active !== null
}

export function isDocumentIndexPaused(): boolean {
  return !active && getDocumentIndexPause() !== null
}

export function getDocumentIndexPauseRecord(): DocumentIndexPauseRecord | null {
  return getDocumentIndexPause()
}

// Starting a run always supersedes an in-flight one: document indexing cannot run
// concurrently, so a new run aborts whatever was running before it.
export function beginDocumentIndexRun(input: {
  scope: DocumentIndexScope
  projectId?: string | null
  projectName?: string | null
  origin?: 'user' | 'timer'
}): DocumentIndexRun {
  active?.controller.abort()
  const controller = new AbortController()
  active = {
    token: nextToken,
    scope: input.scope,
    controller,
    signal: controller.signal,
    origin: input.origin ?? 'user',
  }
  nextToken += 1
  pendingAction = null
  lastProgress = null
  statusMessage = null
  lastScope = input.scope
  lastProjectId = input.projectId ?? null
  lastProjectName = input.projectName ?? null
  // A user-super-context refresh is not an indexing run — it must not discard a
  // pending resume point for a paused index.
  if (input.scope !== 'user') setDocumentIndexPause(null)
  notify(true)
  return { token: active.token, scope: active.scope, controller, signal: controller.signal }
}

export function setDocumentIndexRunProject(run: DocumentIndexRun, projectId: string | null, projectName: string | null): void {
  if (active?.token !== run.token) return
  lastProjectId = projectId
  lastProjectName = projectName
  notify(true)
}

/**
 * A watchdog that measures SILENCE, not duration.
 *
 * An indexing run's length scales with the corpus: five hundred documents at a
 * provider's rate limit is legitimately hours of work, so a fixed wall-clock cap
 * kills healthy runs and throws away everything after the last saved file. What
 * genuinely needs killing is a run wedged on a request that will never answer —
 * `fetch` has no default timeout, so a dead socket would otherwise hang forever.
 *
 * Every progress event pushes the deadline back, which makes the two cases
 * distinguishable: a run that is still finishing files is never interrupted, and
 * a run that has gone quiet for the whole window is.
 */
export interface IdleWatchdog {
  /** Push the deadline back — call on every sign of life. */
  ping: () => void
  cancel: () => void
  /** True when this watchdog is what aborted the run, as opposed to the user. */
  fired: () => boolean
}

export function createIdleWatchdog(controller: AbortController, idleMs: number): IdleWatchdog {
  let didFire = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (): void => {
    timer = setTimeout(() => {
      didFire = true
      controller.abort()
    }, idleMs)
  }
  arm()
  return {
    ping: () => {
      if (didFire) return
      if (timer) clearTimeout(timer)
      arm()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
    },
    fired: () => didFire,
  }
}

export function reportDocumentIndexProgress(run: DocumentIndexRun, progress: DocumentContextProgress): void {
  if (active?.token !== run.token) return
  lastProgress = progress
  notify(false)
}

export function requestDocumentIndexPause(): DocumentIndexState {
  if (active) {
    pendingAction = 'pause'
    active.controller.abort()
    notify(true)
  }
  return getDocumentIndexState()
}

// Stop doubles as "clear the pause": stopping a paused index drops the resume
// point so neither the user nor the hourly timer picks it back up implicitly.
export function requestDocumentIndexStop(): DocumentIndexState {
  if (active) {
    pendingAction = 'stop'
    active.controller.abort()
  } else {
    const pausedRecord = getDocumentIndexPause()
    if (pausedRecord) {
      setDocumentIndexPause(null)
      statusMessage = `${pausedRecord.message.split('.')[0].replace(/^Paused/, 'Stopped')}. Finished documents are saved.`
    }
  }
  notify(true)
  return getDocumentIndexState()
}

export function describeDocumentIndexProgress(progress: DocumentContextProgress | null, projectName: string | null): string {
  const where = projectName ? ` in ${projectName}` : ''
  if (progress && progress.total) {
    const noun = progress.phase === 'folder' ? 'folder' : 'document'
    const done = progress.current ?? 0
    return `after ${done} of ${progress.total} ${noun}${progress.total === 1 ? '' : 's'}${where}`
  }
  return `before any documents${where} were indexed`
}

export function finishDocumentIndexRun(
  run: DocumentIndexRun,
  outcome?: { failed?: boolean; message?: string | null }
): DocumentIndexOutcome {
  // A superseded run must not touch shared state — the newer run owns it now.
  if (active?.token !== run.token) return 'stopped'

  const action = pendingAction
  const progress = lastProgress
  const projectName = lastProjectName
  active = null
  pendingAction = null
  lastProgress = null

  let result: DocumentIndexOutcome
  // A user-super-context refresh is a single call with nothing to resume into,
  // so pausing it is the same as stopping it.
  if (action === 'pause' && run.scope !== 'user') {
    result = 'paused'
    const message = `Paused ${describeDocumentIndexProgress(progress, projectName)}. Finished documents are saved — resuming skips them.`
    statusMessage = message
    setDocumentIndexPause({
      scope: run.scope,
      projectId: lastProjectId,
      projectName,
      message,
      pausedAt: new Date().toISOString(),
    })
  } else if (action) {
    result = 'stopped'
    statusMessage = `Stopped ${describeDocumentIndexProgress(progress, projectName)}. Finished documents are saved.`
  } else if (outcome?.failed) {
    result = 'failed'
    statusMessage = outcome.message ?? 'Indexing failed.'
  } else {
    result = 'completed'
    statusMessage = outcome?.message ?? null
  }
  notify(true)
  return result
}

export function resetDocumentIndexRunsForTests(): void {
  active = null
  pendingAction = null
  lastProgress = null
  statusMessage = null
  lastScope = null
  lastProjectId = null
  lastProjectName = null
  lastNotifyAt = 0
  listeners.clear()
  setDocumentIndexPause(null)
}
