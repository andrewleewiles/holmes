import { useEffect, useState } from 'react'
import type { ActivityRunState } from '@shared/types'

// One IPC subscription for the whole renderer, fanned out to every consumer —
// the same reason `useTimelineRun` does it: a listener per component crosses
// Node's 10-listener warning threshold once a few views are mounted.

type StateListener = (state: ActivityRunState) => void

const listeners = new Set<StateListener>()
let unsubscribe: (() => void) | null = null
let latestState: ActivityRunState | null = null
let initialFetch: Promise<ActivityRunState | null> | null = null

function fanOut(state: ActivityRunState): void {
  latestState = state
  for (const listener of [...listeners]) {
    try { listener(state) } catch { /* One bad listener must not stop the rest. */ }
  }
}

function subscribe(listener: StateListener): () => void {
  listeners.add(listener)
  if (!unsubscribe) unsubscribe = window.electronAPI.activity.onRunState(fanOut)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

// Deduped across consumers, and tolerant of a main process without the handler
// (a window running newer code than the app it is attached to).
function ensureInitialState(): Promise<ActivityRunState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.activity
      .getRunState()
      .then((state) => {
        if (state) fanOut(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function useActivityRunState(): ActivityRunState | null {
  const [state, setState] = useState<ActivityRunState | null>(latestState)

  useEffect(() => {
    let cancelled = false
    const unsub = subscribe((next) => {
      if (!cancelled) setState(next)
    })
    void ensureInitialState().then((initial) => {
      if (!cancelled && initial) setState((current) => current ?? initial)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return state
}

export function resetActivityRunSubscriptionsForTests(): void {
  listeners.clear()
  unsubscribe?.()
  unsubscribe = null
  latestState = null
  initialFetch = null
}
