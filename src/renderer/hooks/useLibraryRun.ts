import { useEffect, useState } from 'react'
import type { LibraryRunState } from '@shared/types'

// One IPC subscription for the whole renderer, fanned out to every consumer —
// the same reason `useDocumentIndex` and `useTimelineRun` do it: a listener per
// component crosses Node's 10-listener warning threshold once the Library page,
// the reader and the Data row are all mounted. Components must call this hook
// rather than `library.onState` directly; a test enforces it.

type StateListener = (state: LibraryRunState) => void

const listeners = new Set<StateListener>()
let unsubscribe: (() => void) | null = null
let latestState: LibraryRunState | null = null
let initialFetch: Promise<LibraryRunState | null> | null = null

function fanOut(state: LibraryRunState): void {
  latestState = state
  for (const listener of [...listeners]) {
    try { listener(state) } catch { /* One bad listener must not stop the rest. */ }
  }
}

function subscribe(listener: StateListener): () => void {
  listeners.add(listener)
  if (!unsubscribe) unsubscribe = window.electronAPI.library.onState(fanOut)
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
function ensureInitialState(): Promise<LibraryRunState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.library
      .getState()
      .then((state) => {
        if (state) fanOut(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function useLibraryRun(): LibraryRunState | null {
  const [state, setState] = useState<LibraryRunState | null>(latestState)

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

export function resetLibraryRunSubscriptionsForTests(): void {
  listeners.clear()
  unsubscribe?.()
  unsubscribe = null
  latestState = null
  initialFetch = null
}
