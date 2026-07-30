import { useEffect, useState } from 'react'
import type { TabloidRunState } from '@shared/types'

// One IPC subscription for the whole renderer, fanned out to every consumer —
// the same reason `useLibraryRun` and `useDocumentIndex` do it. The Tabloid page,
// the sidebar strip and each card's archive button all want this state, and a
// listener per component crosses Node's 10-listener warning threshold. A test
// enforces that components use the hook rather than `tabloid.onState` directly.

type StateListener = (state: TabloidRunState) => void

const listeners = new Set<StateListener>()
let unsubscribe: (() => void) | null = null
let latestState: TabloidRunState | null = null
let initialFetch: Promise<TabloidRunState | null> | null = null

function fanOut(state: TabloidRunState): void {
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
  if (!unsubscribe) unsubscribe = window.electronAPI.tabloid.onState(fanOut)
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
function ensureInitialState(): Promise<TabloidRunState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.tabloid
      .getState()
      .then((state) => {
        if (state) fanOut(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function useTabloidRun(): TabloidRunState | null {
  const [state, setState] = useState<TabloidRunState | null>(latestState)

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

export function resetTabloidRunSubscriptionsForTests(): void {
  listeners.clear()
  unsubscribe?.()
  unsubscribe = null
  latestState = null
  initialFetch = null
}
