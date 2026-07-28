import { useEffect, useState } from 'react'
import type { PeopleRunState } from '@shared/types'

// One IPC subscription for the whole renderer, fanned out to every consumer —
// the same reason `useDocumentIndex` and `useTimelineRun` do it: a listener per component crosses
// Node's 10-listener warning threshold once a few views are mounted.

type StateListener = (state: PeopleRunState) => void

const listeners = new Set<StateListener>()
let unsubscribe: (() => void) | null = null
let latestState: PeopleRunState | null = null
let initialFetch: Promise<PeopleRunState | null> | null = null

function fanOut(state: PeopleRunState): void {
  latestState = state
  for (const listener of [...listeners]) {
    try { listener(state) } catch { /* One bad listener must not stop the rest. */ }
  }
}

function subscribe(listener: StateListener): () => void {
  listeners.add(listener)
  if (!unsubscribe) unsubscribe = window.electronAPI.people.onState(fanOut)
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
function ensureInitialState(): Promise<PeopleRunState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.people
      .getState()
      .then((state) => {
        if (state) fanOut(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function usePeopleRunState(): PeopleRunState | null {
  const [state, setState] = useState<PeopleRunState | null>(latestState)

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

export function resetPeopleRunSubscriptionsForTests(): void {
  listeners.clear()
  unsubscribe?.()
  unsubscribe = null
  latestState = null
  initialFetch = null
}
