// Stops the app calling a provider that has already said it has no credit.
//
// OpenRouter answers an exhausted key with HTTP 402, and nothing in the app used
// to treat that differently from any other failure: the hourly timers kept
// firing, each pass walked its whole work list, and every item spent a request
// to be told the same thing again. A day of that is thousands of pointless
// calls.
//
// So a 402 streak trips a breaker and the calls stop. Kept here — import-free,
// with `now` passed in rather than read — because the wiring around it sits in
// the fetch layer, where a mistake breaks every call the app makes; the part
// with the decisions in it is a leaf a test can load on its own.

/** Consecutive credit refusals before calls stop. */
export const DEFAULT_TRIP_AFTER = 3

/**
 * How long the breaker stays closed before letting one call through. Short
 * enough that topping the account up is noticed without the user doing
 * anything, long enough that a still-empty account costs ~6 calls an hour
 * instead of thousands.
 */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

export interface CreditBreakerState {
  /** True once the streak tripped it — calls are being refused locally. */
  tripped: boolean
  /** Consecutive credit refusals since the last successful call. */
  failures: number
  trippedAt: number | null
  /** Earliest time a probe call is allowed through. */
  retryAt: number | null
  /** What the provider said, for the UI to quote rather than paraphrase. */
  message: string | null
}

export interface CreditBreaker {
  /**
   * Asked immediately before every provider call. `allowed: false` means the
   * call must not be made; the caller fails it locally instead. Not a pure
   * read — the probe it hands out is consumed, so N concurrent workers cannot
   * all take the same one.
   */
  requestCall(now: number): { allowed: boolean; probe: boolean }
  /** A response that means "no credit". Third one in a row trips the breaker. */
  noteCreditFailure(now: number, message: string | null): void
  /** Any successful provider response: the account is live, so start over. */
  noteSuccess(): void
  /** A new key, a different provider, or the user asking to try again. */
  reset(): void
  state(): CreditBreakerState
}

export interface CreditBreakerOptions {
  tripAfter?: number
  cooldownMs?: number
  /** Called whenever the state a UI would render changes. */
  onChange?: (state: CreditBreakerState) => void
}

export function createCreditBreaker(options: CreditBreakerOptions = {}): CreditBreaker {
  const tripAfter = Math.max(1, Math.floor(options.tripAfter ?? DEFAULT_TRIP_AFTER))
  const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)

  let failures = 0
  let trippedAt: number | null = null
  let retryAt: number | null = null
  let message: string | null = null

  const snapshot = (): CreditBreakerState => ({
    tripped: trippedAt !== null,
    failures,
    trippedAt,
    retryAt,
    message,
  })

  const emit = (): void => {
    options.onChange?.(snapshot())
  }

  return {
    requestCall(now: number) {
      if (trippedAt === null) return { allowed: true, probe: false }
      if (retryAt !== null && now < retryAt) return { allowed: false, probe: false }
      // The probe is spent on being handed out, not on coming back: a call that
      // hangs must not leave the door open for every other worker behind it.
      retryAt = now + cooldownMs
      emit()
      return { allowed: true, probe: true }
    },

    noteCreditFailure(now: number, failureMessage: string | null) {
      failures += 1
      if (failureMessage) message = failureMessage
      if (failures >= tripAfter) {
        // Re-tripping on a failed probe restarts the cooldown from now, so the
        // window between probes never collapses while the account stays empty.
        trippedAt = trippedAt ?? now
        retryAt = now + cooldownMs
      }
      emit()
    },

    noteSuccess() {
      if (failures === 0 && trippedAt === null) return
      failures = 0
      trippedAt = null
      retryAt = null
      message = null
      emit()
    },

    reset() {
      if (failures === 0 && trippedAt === null && message === null) return
      failures = 0
      trippedAt = null
      retryAt = null
      message = null
      emit()
    },

    state: snapshot,
  }
}

/**
 * Whether the next call would be let through as the cooldown's probe. A
 * read-only question — it consumes nothing — so a caller deciding whether a
 * whole background pass is worth starting can ask it without spending the one
 * call that pass is allowed.
 */
export function isProbeDue(state: CreditBreakerState, now: number): boolean {
  if (!state.tripped) return true
  return state.retryAt === null || now >= state.retryAt
}

/**
 * Whether a provider response means "you have no credit", as opposed to any
 * other failure. 402 is the whole answer for OpenRouter; the text match is for
 * OpenAI-compatible endpoints that report the same condition as a 400 or 403
 * with the reason only in the body.
 *
 * Deliberately narrow: a false positive here stops the app working on an
 * account that is fine, which is worse than the 402 storm this exists to end.
 */
export function isCreditExhaustedResponse(status: number, body: string): boolean {
  if (status === 402) return true
  if (status !== 400 && status !== 403 && status !== 429) return false
  return /insufficient (credit|balance|fund|quota)|not enough credit|exceeded your current quota|billing_hard_limit|add (more )?credits/i.test(
    body
  )
}
