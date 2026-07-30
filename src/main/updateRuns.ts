// Tracks the update check / download / install so the sidebar can show it.
//
// Modeled on `tabloidRuns`: one slot, a listener set, and a throttled notify.
// The difference is that an update is not a job the user started — the check
// runs on a timer — so the state has an `available` status that exists purely
// to put a clickable strip in front of someone who never asked for one.
//
// The install is deliberately split from the restart. Swapping the bundle is
// safe while the app runs (the process keeps its open inodes), so the download
// can finish and sit at `ready` until the user chooses to relaunch, rather than
// yanking the window away mid-sentence.

import type { UpdateRunState, UpdateRunStatus } from '../shared/types'

const PROGRESS_NOTIFY_INTERVAL_MS = 250

let status: UpdateRunStatus = 'idle'
let version: string | null = null
let notes: string | null = null
let bytesDownloaded = 0
let bytesTotal: number | null = null
let message: string | null = null
let canInstallInPlace = true
let releasesUrl: string | null = null
let currentVersion = '0.0.0'
let lastNotifyAt = 0

type StateListener = (state: UpdateRunState) => void
const listeners = new Set<StateListener>()

export function subscribeUpdateRunState(listener: StateListener): () => void {
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
  const state = getUpdateRunState()
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch {
      /* A dead renderer must never break the install. */
    }
  }
}

/** Set once at startup so the strip can say "you have X, Y is available". */
export function setCurrentVersion(value: string): void {
  currentVersion = value
}

export function getUpdateRunState(): UpdateRunState {
  return {
    status,
    version,
    currentVersion,
    notes,
    bytesDownloaded,
    bytesTotal,
    // Computed here rather than in the renderer so every consumer — sidebar,
    // menu, a future dialog — agrees on what "half done" means.
    fraction: bytesTotal && bytesTotal > 0 ? Math.min(1, bytesDownloaded / bytesTotal) : null,
    message,
    canInstallInPlace,
    releasesUrl,
    updatedAt: new Date().toISOString(),
  }
}

export function isUpdateBusy(): boolean {
  return status === 'checking' || status === 'downloading' || status === 'installing'
}

/** The download is only offered from `available`, and only once. */
export function isUpdateAvailable(): boolean {
  return status === 'available'
}

export function reportUpdateChecking(): void {
  // A recheck must not wipe a finished download out from under the user.
  if (status === 'ready' || status === 'downloading' || status === 'installing') return
  status = 'checking'
  message = null
  notify(true)
}

export function reportUpdateIdle(): void {
  if (status === 'ready' || status === 'downloading' || status === 'installing') return
  status = 'idle'
  version = null
  notes = null
  message = null
  bytesDownloaded = 0
  bytesTotal = null
  notify(true)
}

export function reportUpdateAvailable(info: {
  version: string
  notes: string | null
  canInstallInPlace: boolean
  releasesUrl: string
}): void {
  if (status === 'ready' || status === 'downloading' || status === 'installing') return
  status = 'available'
  version = info.version
  notes = info.notes
  canInstallInPlace = info.canInstallInPlace
  releasesUrl = info.releasesUrl
  bytesDownloaded = 0
  bytesTotal = null
  message = null
  notify(true)
}

export function reportUpdateDownloadStarted(total: number | null): void {
  status = 'downloading'
  bytesDownloaded = 0
  bytesTotal = total
  message = null
  notify(true)
}

export function reportUpdateDownloadProgress(received: number): void {
  bytesDownloaded = received
  notify(false)
}

/**
 * The unzip-and-swap tail. It has no byte count of its own but takes long
 * enough on a 1.2GB bundle that a frozen progress bar would read as a hang.
 */
export function reportUpdateInstalling(detail: string): void {
  status = 'installing'
  message = detail
  notify(true)
}

export function reportUpdateReady(): void {
  status = 'ready'
  message = null
  notify(true)
}

export function reportUpdateFailed(detail: string): void {
  status = 'failed'
  message = detail
  notify(true)
}

export function resetUpdateRunsForTests(): void {
  status = 'idle'
  version = null
  notes = null
  bytesDownloaded = 0
  bytesTotal = null
  message = null
  canInstallInPlace = true
  releasesUrl = null
  currentVersion = '0.0.0'
  lastNotifyAt = 0
  listeners.clear()
}
