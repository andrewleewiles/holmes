import type { LibraryRunState, LibraryScanProgress } from '../shared/types'

/**
 * Tracks the one in-flight library operation so every window can show it.
 *
 * Modeled on `timelineRuns` rather than `documentIndexRuns`: a library scan has
 * no pause or resume, because each book is committed as it is parsed and an
 * interrupted scan simply re-parses the unfinished tail next time — the identity
 * hash makes everything already done a cache hit.
 *
 * `scanning` and `generating` share one slot deliberately. A lesson run that
 * started while a scan was rewriting the same book's chapter offsets would be
 * citing text that no longer exists at those offsets.
 */
export type LibraryRunKind = 'scanning' | 'generating'

export interface LibraryRun {
  token: number
  kind: LibraryRunKind
  origin: 'user' | 'timer'
}

const PROGRESS_NOTIFY_INTERVAL_MS = 400

let active: LibraryRun | null = null
let lastProgress: LibraryScanProgress | null = null
let statusMessage: string | null = null
let nextToken = 1
let lastNotifyAt = 0

type StateListener = (state: LibraryRunState) => void
const listeners = new Set<StateListener>()

export function subscribeLibraryRunState(listener: StateListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(force: boolean): void {
  if (!force) {
    const now = Date.now()
    if (now - lastNotifyAt < PROGRESS_NOTIFY_INTERVAL_MS) return
  }
  lastNotifyAt = Date.now()
  const state = getLibraryRunState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch { /* A dead renderer must never break the run. */ }
  }
}

export function getLibraryRunState(): LibraryRunState {
  return {
    status: active?.kind ?? 'idle',
    origin: active?.origin ?? null,
    progress: active ? lastProgress : null,
    message: active ? null : statusMessage,
    updatedAt: new Date().toISOString(),
  }
}

export function isLibraryRunActive(): boolean {
  return active !== null
}

export function beginLibraryRun(kind: LibraryRunKind, origin: 'user' | 'timer'): LibraryRun {
  active = { token: nextToken, kind, origin }
  nextToken += 1
  lastProgress = null
  statusMessage = null
  notify(true)
  return active
}

export function reportLibraryRunProgress(run: LibraryRun, progress: LibraryScanProgress): void {
  // A superseded run must not paint over the state of the run that replaced it.
  if (active?.token !== run.token) return
  lastProgress = progress
  notify(false)
}

export function finishLibraryRun(run: LibraryRun, outcome?: { failed?: boolean; message?: string | null }): void {
  if (active?.token !== run.token) return
  active = null
  lastProgress = null
  statusMessage = outcome?.failed ? outcome.message ?? 'Library scan failed.' : null
  notify(true)
}

export function resetLibraryRunsForTests(): void {
  active = null
  lastProgress = null
  statusMessage = null
  lastNotifyAt = 0
  listeners.clear()
}
