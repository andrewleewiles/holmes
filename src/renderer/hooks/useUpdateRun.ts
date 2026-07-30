import { useEffect, useState } from 'react'
import type { UpdateRunState } from '@shared/types'

// One IPC subscription for the whole renderer, fanned out to every consumer —
// the same reason `useTabloidRun` and `useDocumentIndex` do it. A test enforces
// that components use the hook rather than `updater.onState` directly.

type StateListener = (state: UpdateRunState) => void

const listeners = new Set<StateListener>()
let unsubscribe: (() => void) | null = null
let latestState: UpdateRunState | null = null
let initialFetch: Promise<UpdateRunState | null> | null = null

function fanOut(state: UpdateRunState): void {
  latestState = state
  for (const listener of [...listeners]) {
    try {
      listener(state)
    } catch {
      /* One bad listener must not stop the rest. */
    }
  }
}

function subscribe(listener: StateListener): () => void {
  listeners.add(listener)
  if (!unsubscribe) unsubscribe = window.electronAPI.updater.onState(fanOut)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

// Deduped across consumers, and tolerant of a main process without the handler
// (a window running newer code than the app it is attached to) — which is the
// normal case here, since the whole point is that the app is out of date.
function ensureInitialState(): Promise<UpdateRunState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.updater
      .getState()
      .then((state) => {
        if (state) fanOut(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function useUpdateRun(): UpdateRunState | null {
  const [state, setState] = useState<UpdateRunState | null>(latestState)

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

export function resetUpdateRunSubscriptionsForTests(): void {
  listeners.clear()
  unsubscribe?.()
  unsubscribe = null
  latestState = null
  initialFetch = null
}
