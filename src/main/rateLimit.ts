// Outbound request pacing for bulk indexing.
//
// OpenRouter enforces a per-key requests-per-minute ceiling. Without pacing, the
// document/photo indexer runs FILE_CONCURRENCY calls back to back (~60 rpm at 4
// workers), which is well over a 20 rpm allowance: the excess comes back as 429s,
// burns the retry budget, and lands failure rows on files that were fine.
//
// A sliding window is used rather than a fixed bucket so a burst at the end of
// one minute cannot be immediately followed by a full burst at the start of the
// next, which is what trips providers that measure a rolling 60s.

export const DEFAULT_REQUESTS_PER_MINUTE = 20

const WINDOW_MS = 60_000

export interface RateLimiter {
  acquire(signal?: AbortSignal): Promise<void>
  readonly requestsPerMinute: number
  pendingCount(): number
}

export function createRateLimiter(requestsPerMinute: number = DEFAULT_REQUESTS_PER_MINUTE): RateLimiter {
  const limit = Math.max(1, Math.floor(requestsPerMinute))
  // Timestamps of recently issued requests, oldest first.
  const issued: number[] = []
  // Serializes waiters so N concurrent workers cannot all observe the same free
  // slot and issue together.
  let chain: Promise<void> = Promise.resolve()

  const reserve = async (signal?: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw new Error('Request cancelled')
      const now = Date.now()
      while (issued.length > 0 && now - issued[0] >= WINDOW_MS) issued.shift()
      if (issued.length < limit) {
        issued.push(now)
        return
      }
      const waitMs = WINDOW_MS - (now - issued[0]) + 1
      await sleep(waitMs, signal)
    }
  }

  return {
    get requestsPerMinute() {
      return limit
    },
    pendingCount() {
      const now = Date.now()
      return issued.filter((at) => now - at < WINDOW_MS).length
    },
    acquire(signal?: AbortSignal): Promise<void> {
      const next = chain.then(() => reserve(signal))
      // Keep the chain alive even when one waiter rejects (abort), otherwise a
      // single cancellation would permanently wedge every later acquire.
      chain = next.catch(() => undefined)
      return next
    },
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Request cancelled'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new Error('Request cancelled'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// How long `calls` requests take once pacing dominates, which it does for any
// bulk run: at 20 rpm the limit sets the wall clock, not concurrency.
export function estimateSecondsForCalls(calls: number, requestsPerMinute: number, concurrency: number, secondsPerCall: number): number {
  if (calls <= 0) return 0
  const rateBoundSeconds = (calls / Math.max(1, requestsPerMinute)) * 60
  const concurrencyBoundSeconds = (calls * secondsPerCall) / Math.max(1, concurrency)
  return Math.round(Math.max(rateBoundSeconds, concurrencyBoundSeconds))
}
