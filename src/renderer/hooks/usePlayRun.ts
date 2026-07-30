import { useEffect, useState } from 'react'
import type { PlayRunState } from '@shared/types'

// One IPC subscription for the whole renderer, fanned out to every consumer —
// the same reason `useLibraryRun` and `useDocumentIndex` do it. The Play page,
// the sidebar strip and each card's archive button all want this state, and a
// listener per component crosses Node's 10-listener warning threshold. A test
// enforces that components use the hook rather than `play.onState` directly.

type StateListener = (state: PlayRunState) => void

const listeners = new Set<StateListener>()
let unsubscribe: (() => void) | null = null
let latestState: PlayRunState | null = null
let initialFetch: Promise<PlayRunState | null> | null = null

function fanOut(state: PlayRunState): void {
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
  if (!unsubscribe) unsubscribe = window.electronAPI.play.onState(fanOut)
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
function ensureInitialState(): Promise<PlayRunState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.play
      .getState()
      .then((state) => {
        if (state) fanOut(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function usePlayRun(): PlayRunState | null {
  const [state, setState] = useState<PlayRunState | null>(latestState)

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

export function resetPlayRunSubscriptionsForTests(): void {
  listeners.clear()
  unsubscribe?.()
  unsubscribe = null
  latestState = null
  initialFetch = null
}
