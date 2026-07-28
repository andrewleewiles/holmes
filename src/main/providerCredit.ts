// The process-wide credit breaker for the configured text provider.
//
// The decisions live in shared/creditBreaker.ts; this is the single instance the
// app shares, plus the two questions the rest of the app asks it: "may I call?"
// (the fetch wrapper, in callLog.ts) and "is there any point starting?" (the
// background timers in main.ts).
import type { ProviderConfig } from '../shared/types'
import { hasProviderCredentials } from '../shared/providerConfig'
import {
  createCreditBreaker,
  isCreditExhaustedResponse,
  isProbeDue,
  type CreditBreakerState,
} from '../shared/creditBreaker'
import { describeProvider } from './providerEndpoint'

export { isCreditExhaustedResponse, type CreditBreakerState }

type Listener = (state: CreditBreakerState) => void

const listeners = new Set<Listener>()

const breaker = createCreditBreaker({
  onChange: (state) => {
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // A listener is a UI notification; it can never break a provider call.
      }
    }
  },
})

export function onProviderCreditChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProviderCreditState(): CreditBreakerState {
  return breaker.state()
}

/** True while calls are being refused locally. */
export function isProviderCreditBlocked(): boolean {
  return breaker.state().tripped
}

/**
 * Clears the block: a new key, a provider change, or the user pressing "Try
 * again" after topping the account up. The next call goes out for real.
 */
export function clearProviderCreditBlock(): void {
  breaker.reset()
}

/**
 * Asked by the fetch wrapper before every call to the text provider. Consumes
 * the cooldown probe when it hands one out, so a tripped breaker lets exactly
 * one call through per window however many workers are queued behind it.
 */
export function requestProviderCall(): { allowed: boolean; probe: boolean } {
  return breaker.requestCall(Date.now())
}

export function noteProviderResponse(status: number, body: string): void {
  if (isCreditExhaustedResponse(status, body)) {
    const state = breaker.state()
    breaker.noteCreditFailure(Date.now(), readProviderMessage(body) ?? `HTTP ${status}`)
    if (!state.tripped && breaker.state().tripped) {
      console.warn(
        `Provider is out of credit (HTTP ${status}). Holmes has stopped calling it; background work is paused until credit is added or the block is cleared in Settings.`
      )
    }
    return
  }
  // Only a real answer clears the streak. A network drop or a 500 in between two
  // 402s says nothing about the balance, so it must not reset the count.
  if (status >= 200 && status < 400) breaker.noteSuccess()
}

/** The error a blocked call fails with. Worded so the UI can show it verbatim. */
export function creditBlockedError(config: ProviderConfig): Error {
  const state = breaker.state()
  const detail = state.message ? ` ${describeProvider(config)} said: ${state.message}` : ''
  return new Error(
    `Paused: ${describeProvider(config)} refused the last calls for lack of credit, so Holmes stopped calling it.${detail} Add credit, then use "Try again" in Settings.`
  )
}

/**
 * The gate the background timers use. A key with no credit behind it is not a
 * usable key, so an hourly pass with nothing but model calls in it does not
 * start — that is the difference between a quiet app and one that walks a whole
 * photo library to collect a 402 per file.
 *
 * Once the cooldown is up a pass is allowed to start again, which is what lets a
 * topped-up account resume on its own. It costs one call to find out: the probe
 * is spent on the pass's first call, and if that is refused too every other call
 * in the pass is blocked before it reaches the network.
 */
export function canCallProvider(config: ProviderConfig): boolean {
  return hasProviderCredentials(config) && isProbeDue(breaker.state(), Date.now())
}

function readProviderMessage(body: string): string | null {
  if (!body.trim()) return null
  try {
    const parsed = JSON.parse(body) as Record<string, any>
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300)
  } catch {
    // Not JSON — the raw text is still the provider's own words.
  }
  return body.trim().slice(0, 300)
}
