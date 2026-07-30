// Tracks the one in-flight Play build so every window can show it.
//
// Modeled on `libraryRuns` rather than `documentIndexRuns`: a build has no pause
// or resume, because nothing is committed until the whole pipeline finishes, and
// a stopped build simply costs its calls and leaves the previous feed standing.
//
// Archive downloads are tracked in the SAME state object but NOT in the run
// slot. Archiving one video is the user's own decision and must not queue behind
// a four-minute feed refresh, so several can run alongside a build and each
// other, and the sidebar shows them together.

import type { PlayArchiveProgress, PlayRunProgress, PlayRunState } from '../shared/types'

export interface PlayRun {
  token: number
  origin: 'user'
  controller: AbortController
  signal: AbortSignal
}

const PROGRESS_NOTIFY_INTERVAL_MS = 400

let active: PlayRun | null = null
let lastProgress: PlayRunProgress | null = null
let statusMessage: string | null = null
let stopRequested = false
let nextToken = 1
let lastNotifyAt = 0

const archives = new Map<string, PlayArchiveProgress>()

type StateListener = (state: PlayRunState) => void
const listeners = new Set<StateListener>()

export function subscribePlayRunState(listener: StateListener): () => void {
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
  const state = getPlayRunState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch {
      /* A dead renderer must never break the run. */
    }
  }
}

export function getPlayRunState(): PlayRunState {
  return {
    status: active ? 'building' : 'idle',
    origin: active?.origin ?? null,
    progress: active ? lastProgress : null,
    message: active ? null : statusMessage,
    archives: [...archives.values()],
    updatedAt: new Date().toISOString(),
  }
}

export function isPlayRunActive(): boolean {
  return active !== null
}

export function beginPlayRun(): PlayRun {
  const controller = new AbortController()
  active = { token: nextToken, origin: 'user', controller, signal: controller.signal }
  nextToken += 1
  lastProgress = null
  statusMessage = null
  stopRequested = false
  notify(true)
  return active
}

export function reportPlayRunProgress(run: PlayRun, progress: PlayRunProgress): void {
  // A superseded run must not paint over the state of the run that replaced it.
  if (active?.token !== run.token) return
  lastProgress = progress
  notify(false)
}

/**
 * Distinguishes a build the user stopped from one that failed. Without it a stop
 * surfaces as "the feed could not be built", which blames the app for the user's
 * own click.
 */
export function requestPlayRunStop(): PlayRunState {
  if (active) {
    stopRequested = true
    active.controller.abort()
    notify(true)
  }
  return getPlayRunState()
}

export function wasPlayRunStopped(): boolean {
  return stopRequested
}

export function finishPlayRun(run: PlayRun, outcome?: { failed?: boolean; message?: string | null }): void {
  if (active?.token !== run.token) return
  active = null
  lastProgress = null
  statusMessage = outcome?.failed ? outcome.message ?? 'The feed could not be built.' : null
  notify(true)
}

export function reportPlayArchiveProgress(progress: PlayArchiveProgress): void {
  archives.set(progress.itemId, progress)
  // A finished download is announced immediately; a percentage tick is throttled
  // like any other progress.
  notify(progress.status === 'done' || progress.status === 'failed' || progress.status === 'queued')
}

/** Clears a finished download from the strip once the user has seen it land. */
export function clearPlayArchiveProgress(itemId: string): void {
  if (archives.delete(itemId)) notify(true)
}

export function isPlayArchiveActive(itemId: string): boolean {
  const entry = archives.get(itemId)
  return entry?.status === 'queued' || entry?.status === 'downloading'
}

export function resetPlayRunsForTests(): void {
  active = null
  lastProgress = null
  statusMessage = null
  stopRequested = false
  lastNotifyAt = 0
  archives.clear()
  listeners.clear()
}
