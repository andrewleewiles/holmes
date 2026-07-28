import type {
  PeopleRebuildProgress,
  PeopleIndexPauseRecord,
  PeopleRunOutcome,
  PeopleRunState,
  PeopleRunStatus,
} from '../shared/types'
import { getPeopleIndexPause, setPeopleIndexPause } from './settings'

/**
 * Tracks the one in-flight People rebuild so every window can show it, and owns
 * its pause/stop lifecycle.
 *
 * Modelled on `documentIndexRuns` rather than on `timelineRuns`, because People
 * has the property that makes pausing meaningful: the expensive half is one model
 * call per person, each committed as it is produced and gated on a hash of that
 * person's evidence. Interrupting therefore costs nothing already paid for, and
 * resuming is simply running again — the pass skips everyone already profiled.
 *
 * That same property is why the pause record here carries only a message, where
 * the document one carries a scope and a project: there is no cursor to store.
 */
export interface PeopleRun {
  token: number
  controller: AbortController
  signal: AbortSignal
  origin: 'user' | 'timer'
}

const PROGRESS_NOTIFY_INTERVAL_MS = 400

let active: PeopleRun | null = null
let pendingAction: 'pause' | 'stop' | null = null
let lastProgress: PeopleRebuildProgress | null = null
let statusMessage: string | null = null
let nextToken = 1
let lastNotifyAt = 0

type StateListener = (state: PeopleRunState) => void
const listeners = new Set<StateListener>()

export function subscribePeopleRunState(listener: StateListener): () => void {
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
  const state = getPeopleRunState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch { /* A dead renderer must never break the run. */ }
  }
}

export function getPeopleRunState(): PeopleRunState {
  const paused = active ? null : getPeopleIndexPause()
  let status: PeopleRunStatus = 'idle'
  if (active) status = pendingAction ? 'stopping' : 'running'
  else if (paused) status = 'paused'
  return {
    status,
    pendingAction,
    origin: active?.origin ?? null,
    progress: active ? lastProgress : null,
    message: active ? null : paused?.message ?? statusMessage,
    canResume: !active && Boolean(paused),
    updatedAt: new Date().toISOString(),
  }
}

export function isPeopleRunActive(): boolean {
  return active !== null
}

export function isPeopleRunPaused(): boolean {
  return !active && getPeopleIndexPause() !== null
}

export function getPeoplePauseRecord(): PeopleIndexPauseRecord | null {
  return getPeopleIndexPause()
}

// Starting a run always supersedes an in-flight one: People cannot rebuild
// concurrently with itself, so a new run aborts whatever was running before.
export function beginPeopleRun(origin: 'user' | 'timer' = 'user'): PeopleRun {
  active?.controller.abort()
  const controller = new AbortController()
  active = { token: nextToken, controller, signal: controller.signal, origin }
  nextToken += 1
  pendingAction = null
  lastProgress = null
  statusMessage = null
  // Starting clears any resume point: this run supersedes it.
  setPeopleIndexPause(null)
  notify(true)
  return active
}

export function reportPeopleRunProgress(run: PeopleRun, progress: PeopleRebuildProgress): void {
  // A superseded run must not paint over the state of the run that replaced it.
  if (active?.token !== run.token) return
  lastProgress = progress
  notify(false)
}

export function requestPeopleRunPause(): PeopleRunState {
  if (active) {
    pendingAction = 'pause'
    active.controller.abort()
    notify(true)
  }
  return getPeopleRunState()
}

// Stop doubles as "clear the pause": stopping a paused rebuild drops the resume
// point so neither the user nor the hourly timer picks it back up implicitly.
export function requestPeopleRunStop(): PeopleRunState {
  if (active) {
    pendingAction = 'stop'
    active.controller.abort()
  } else {
    const paused = getPeopleIndexPause()
    if (paused) {
      setPeopleIndexPause(null)
      statusMessage = `${paused.message.split('.')[0].replace(/^Paused/, 'Stopped')}. Finished profiles are saved.`
    }
  }
  notify(true)
  return getPeopleRunState()
}

export function describePeopleProgress(progress: PeopleRebuildProgress | null): string {
  if (progress && progress.phase === 'dossier' && progress.total) {
    const done = progress.current ?? 0
    return `after ${done} of ${progress.total} profile${progress.total === 1 ? '' : 's'}`
  }
  if (progress && progress.phase !== 'seed') return `during the ${progress.phase} pass`
  return 'before any profiles were written'
}

export function finishPeopleRun(
  run: PeopleRun,
  outcome?: { failed?: boolean; message?: string | null }
): PeopleRunOutcome {
  // A superseded run must not touch shared state — the newer run owns it now.
  if (active?.token !== run.token) return 'stopped'

  const action = pendingAction
  const progress = lastProgress
  active = null
  pendingAction = null
  lastProgress = null

  let result: PeopleRunOutcome
  if (action === 'pause') {
    result = 'paused'
    const message = `Paused ${describePeopleProgress(progress)}. People and their evidence are saved — resuming skips the profiles already written.`
    statusMessage = message
    setPeopleIndexPause({ message, pausedAt: new Date().toISOString() })
  } else if (action) {
    result = 'stopped'
    statusMessage = `Stopped ${describePeopleProgress(progress)}. People and their evidence are saved.`
  } else if (outcome?.failed) {
    result = 'failed'
    statusMessage = outcome.message ?? 'People rebuild failed.'
  } else {
    result = 'completed'
    statusMessage = outcome?.message ?? null
  }
  notify(true)
  return result
}

export function resetPeopleRunsForTests(): void {
  active = null
  pendingAction = null
  lastProgress = null
  statusMessage = null
  lastNotifyAt = 0
  listeners.clear()
  setPeopleIndexPause(null)
}
