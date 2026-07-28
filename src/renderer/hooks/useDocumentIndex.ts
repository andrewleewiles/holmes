import { useEffect, useRef, useState } from 'react'
import type { DocumentContextProgress, DocumentIndexState } from '@shared/types'

// One IPC subscription per channel for the whole renderer, fanned out to every
// component that wants it. Each DocumentContextPanel used to open its own pair,
// so a user with 9 connected projects crossed Node's 10-listener warning
// threshold on `documents:state` (Sidebar + DataPage + one per panel).

type StateListener = (state: DocumentIndexState) => void
type ProgressListener = (progress: DocumentContextProgress) => void

const stateListeners = new Set<StateListener>()
const progressListeners = new Set<ProgressListener>()

let unsubscribeState: (() => void) | null = null
let unsubscribeProgress: (() => void) | null = null
let latestState: DocumentIndexState | null = null
let initialFetch: Promise<DocumentIndexState | null> | null = null

function fanOutState(state: DocumentIndexState): void {
  latestState = state
  for (const listener of [...stateListeners]) {
    try { listener(state) } catch { /* One bad listener must not stop the rest. */ }
  }
}

function subscribeState(listener: StateListener): () => void {
  stateListeners.add(listener)
  if (!unsubscribeState) {
    unsubscribeState = window.electronAPI.documents.onState(fanOutState)
  }
  return () => {
    stateListeners.delete(listener)
    if (stateListeners.size === 0 && unsubscribeState) {
      unsubscribeState()
      unsubscribeState = null
    }
  }
}

function subscribeProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener)
  if (!unsubscribeProgress) {
    unsubscribeProgress = window.electronAPI.documents.onProgress((progress) => {
      for (const registered of [...progressListeners]) {
        try { registered(progress) } catch { /* Ignore a single bad listener. */ }
      }
    })
  }
  return () => {
    progressListeners.delete(listener)
    if (progressListeners.size === 0 && unsubscribeProgress) {
      unsubscribeProgress()
      unsubscribeProgress = null
    }
  }
}

// Deduped across every consumer — mounting ten panels must not fire ten
// getState round-trips.
function ensureInitialState(): Promise<DocumentIndexState | null> {
  if (!initialFetch) {
    initialFetch = window.electronAPI.documents
      .getState()
      .then((state) => {
        if (state) fanOutState(state)
        return state
      })
      .catch(() => null)
  }
  return initialFetch
}

export function useDocumentIndexState(): DocumentIndexState | null {
  const [state, setState] = useState<DocumentIndexState | null>(latestState)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeState((next) => {
      if (!cancelled) setState(next)
    })
    void ensureInitialState().then((initial) => {
      if (!cancelled && initial) setState((current) => current ?? initial)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}

// Handler-based so callers keep their own filtering (a project panel only wants
// progress while the active run belongs to it).
export function useDocumentIndexProgress(handler: ProgressListener): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => subscribeProgress((progress) => handlerRef.current(progress)), [])
}

export function resetDocumentIndexSubscriptionsForTests(): void {
  stateListeners.clear()
  progressListeners.clear()
  unsubscribeState?.()
  unsubscribeProgress?.()
  unsubscribeState = null
  unsubscribeProgress = null
  latestState = null
  initialFetch = null
}
