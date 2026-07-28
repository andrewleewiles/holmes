import type { ActivityAnalysisProgress, ActivityRunState } from '../shared/types'

/**
 * Tracks the one in-flight activity analysis so every window can show it.
 *
 * Mirrors `timelineRuns` for the same reason: the analysis's own progress goes
 * to whichever window asked for it, so the sidebar could only see a run started
 * from the Activity page in that window — never the fifteen-minute background
 * one, which has no sender at all.
 *
 * This matters more for the analysis than for most runs. Reading every event
 * chunks a large library into dozens of sequential calls and takes minutes, so
 * without a shared indicator the app looks idle while it is spending real money.
 *
 * Like the timeline registry and unlike document indexing, there is no pause or
 * resume: source analyses already finished are held in memory for the run, and
 * an interrupted analysis simply starts over.
 */
export interface ActivityRun {
  token: number
  origin: 'user' | 'timer'
}

const PROGRESS_NOTIFY_INTERVAL_MS = 400

let active: ActivityRun | null = null
let lastProgress: ActivityAnalysisProgress | null = null
let statusMessage: string | null = null
let nextToken = 1
let lastNotifyAt = 0

type StateListener = (state: ActivityRunState) => void
const listeners = new Set<StateListener>()

export function subscribeActivityRunState(listener: StateListener): () => void {
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
  const state = getActivityRunState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch { /* A dead renderer must never break the run. */ }
  }
}

export function getActivityRunState(): ActivityRunState {
  return {
    status: active ? 'running' : 'idle',
    origin: active?.origin ?? null,
    progress: active ? lastProgress : null,
    message: active ? null : statusMessage,
    updatedAt: new Date().toISOString(),
  }
}

export function isActivityRunActive(): boolean {
  return active !== null
}

export function beginActivityRun(origin: 'user' | 'timer'): ActivityRun {
  active = { token: nextToken, origin }
  nextToken += 1
  lastProgress = null
  statusMessage = null
  notify(true)
  return active
}

export function reportActivityRunProgress(run: ActivityRun, progress: ActivityAnalysisProgress): void {
  // A superseded run must not paint over the state of the run that replaced it.
  if (active?.token !== run.token) return
  lastProgress = progress
  notify(false)
}

export function finishActivityRun(
  run: ActivityRun,
  outcome?: { failed?: boolean; message?: string | null }
): void {
  if (active?.token !== run.token) return
  active = null
  lastProgress = null
  statusMessage = outcome?.failed ? outcome.message ?? 'Activity analysis failed.' : null
  notify(true)
}

export function resetActivityRunsForTests(): void {
  active = null
  lastProgress = null
  statusMessage = null
  lastNotifyAt = 0
  listeners.clear()
}
