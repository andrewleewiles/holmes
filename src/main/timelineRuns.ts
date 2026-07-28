import type { TimelineRebuildProgress, TimelineRunState } from '../shared/types'

/**
 * Tracks the one in-flight timeline rebuild so every window can show it.
 *
 * The rebuild's own progress events go to whichever window asked for the run, so
 * the sidebar could only ever see a rebuild started from the Timeline page in
 * that same window — and never the hourly background one, which has no sender at
 * all. This registry is the shared point both paths report through, mirroring
 * `documentIndexRuns` for document indexing.
 *
 * Deliberately smaller than that one: a rebuild has no pause or resume, because
 * every year it finishes is already committed and an interrupted rebuild simply
 * picks up the unbuilt years next time.
 */
export interface TimelineRun {
  token: number
  origin: 'user' | 'timer'
}

const PROGRESS_NOTIFY_INTERVAL_MS = 400

let active: TimelineRun | null = null
let lastProgress: TimelineRebuildProgress | null = null
let statusMessage: string | null = null
let nextToken = 1
let lastNotifyAt = 0

type StateListener = (state: TimelineRunState) => void
const listeners = new Set<StateListener>()

export function subscribeTimelineRunState(listener: StateListener): () => void {
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
  const state = getTimelineRunState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch { /* A dead renderer must never break the run. */ }
  }
}

export function getTimelineRunState(): TimelineRunState {
  return {
    status: active ? 'running' : 'idle',
    origin: active?.origin ?? null,
    progress: active ? lastProgress : null,
    message: active ? null : statusMessage,
    updatedAt: new Date().toISOString(),
  }
}

export function isTimelineRunActive(): boolean {
  return active !== null
}

export function beginTimelineRun(origin: 'user' | 'timer'): TimelineRun {
  active = { token: nextToken, origin }
  nextToken += 1
  lastProgress = null
  statusMessage = null
  notify(true)
  return active
}

export function reportTimelineRunProgress(run: TimelineRun, progress: TimelineRebuildProgress): void {
  // A superseded run must not paint over the state of the run that replaced it.
  if (active?.token !== run.token) return
  lastProgress = progress
  notify(false)
}

export function finishTimelineRun(run: TimelineRun, outcome?: { failed?: boolean; message?: string | null }): void {
  if (active?.token !== run.token) return
  active = null
  lastProgress = null
  statusMessage = outcome?.failed ? outcome.message ?? 'Timeline rebuild failed.' : null
  notify(true)
}

export function resetTimelineRunsForTests(): void {
  active = null
  lastProgress = null
  statusMessage = null
  lastNotifyAt = 0
  listeners.clear()
}
