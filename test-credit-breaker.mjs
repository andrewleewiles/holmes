import assert from 'node:assert/strict'
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_TRIP_AFTER,
  createCreditBreaker,
  isCreditExhaustedResponse,
  isProbeDue,
} from './src/shared/creditBreaker.ts'

// --- what counts as "no credit" ---------------------------------------------

// OpenRouter's answer to an empty account, whatever the body says.
assert.equal(isCreditExhaustedResponse(402, ''), true)
assert.equal(isCreditExhaustedResponse(402, '{"error":{"message":"Insufficient credits"}}'), true)

// Endpoints that report the same condition with a different status put the
// reason in the body.
assert.equal(isCreditExhaustedResponse(403, 'insufficient credits for this request'), true)
assert.equal(isCreditExhaustedResponse(429, 'You exceeded your current quota'), true)
assert.equal(isCreditExhaustedResponse(400, '{"error":{"message":"Please add credits to continue"}}'), true)

// Everything else is an ordinary failure: a rate limit, an overload, a bad
// request. Stopping the app on any of these would be far worse than the 402
// storm this exists to end.
assert.equal(isCreditExhaustedResponse(429, 'Rate limit exceeded'), false)
assert.equal(isCreditExhaustedResponse(500, 'Internal server error'), false)
assert.equal(isCreditExhaustedResponse(400, 'model not found'), false)
assert.equal(isCreditExhaustedResponse(200, 'insufficient credits'), false)

// --- tripping ---------------------------------------------------------------

const COOLDOWN = 10_000
const changes = []
const breaker = createCreditBreaker({
  tripAfter: 3,
  cooldownMs: COOLDOWN,
  onChange: (state) => changes.push(state),
})

// A first refusal does not stop anything — one 402 can be a blip.
assert.deepEqual(breaker.requestCall(0), { allowed: true, probe: false })
breaker.noteCreditFailure(0, 'Insufficient credits')
assert.equal(breaker.state().tripped, false)
assert.deepEqual(breaker.requestCall(1), { allowed: true, probe: false })
breaker.noteCreditFailure(1, null)
assert.equal(breaker.state().tripped, false)

// The third in a row is a pattern, and the calls stop.
breaker.noteCreditFailure(2, null)
assert.equal(breaker.state().tripped, true)
assert.equal(breaker.state().failures, 3)
assert.equal(breaker.state().trippedAt, 2)
// The provider's own words are kept for the UI to quote.
assert.equal(breaker.state().message, 'Insufficient credits')

assert.deepEqual(breaker.requestCall(3), { allowed: false, probe: false })
assert.deepEqual(breaker.requestCall(COOLDOWN + 1), { allowed: false, probe: false })

// --- the cooldown probe -----------------------------------------------------

// One call is let through once the window is up, so a topped-up account
// resumes on its own.
assert.deepEqual(breaker.requestCall(2 + COOLDOWN), { allowed: true, probe: true })
// And exactly one: the queued workers behind it do not all inherit the probe.
assert.deepEqual(breaker.requestCall(2 + COOLDOWN), { allowed: false, probe: false })
assert.deepEqual(breaker.requestCall(2 + COOLDOWN + 1), { allowed: false, probe: false })

// A probe that comes back 402 restarts the window rather than shortening it.
breaker.noteCreditFailure(2 + COOLDOWN, 'Insufficient credits')
assert.equal(breaker.state().retryAt, 2 + COOLDOWN * 2)
assert.deepEqual(breaker.requestCall(2 + COOLDOWN * 2 - 1), { allowed: false, probe: false })

// A probe that succeeds clears everything.
assert.deepEqual(breaker.requestCall(2 + COOLDOWN * 2), { allowed: true, probe: true })
breaker.noteSuccess()
assert.deepEqual(breaker.state(), {
  tripped: false,
  failures: 0,
  trippedAt: null,
  retryAt: null,
  message: null,
})
assert.deepEqual(breaker.requestCall(2 + COOLDOWN * 2), { allowed: true, probe: false })

// The UI is told about every one of those transitions.
assert.ok(changes.length >= 6)
assert.equal(changes[changes.length - 1].tripped, false)

// --- asking without spending ------------------------------------------------

// The background timers ask whether a pass is worth starting. The question must
// not consume the probe that pass would need.
const idle = createCreditBreaker({ tripAfter: 1, cooldownMs: COOLDOWN })
assert.equal(isProbeDue(idle.state(), 0), true)
idle.noteCreditFailure(0, null)
assert.equal(isProbeDue(idle.state(), 1), false)
assert.equal(isProbeDue(idle.state(), COOLDOWN), true)
// Asked twice, still true — and the call itself still gets the probe.
assert.equal(isProbeDue(idle.state(), COOLDOWN), true)
assert.deepEqual(idle.requestCall(COOLDOWN), { allowed: true, probe: true })

// --- streaks are consecutive credit refusals, not failures in general -------

const streak = createCreditBreaker({ tripAfter: 3, cooldownMs: COOLDOWN })
streak.noteCreditFailure(0, null)
streak.noteCreditFailure(1, null)
// A success in between says the account is live, so the count starts over.
streak.noteSuccess()
streak.noteCreditFailure(2, null)
streak.noteCreditFailure(3, null)
assert.equal(streak.state().tripped, false)
streak.noteCreditFailure(4, null)
assert.equal(streak.state().tripped, true)

// A manual reset — the user saying they have added credit — beats the cooldown.
streak.reset()
assert.equal(streak.state().tripped, false)
assert.deepEqual(streak.requestCall(5), { allowed: true, probe: false })

// --- defaults ---------------------------------------------------------------

assert.equal(DEFAULT_TRIP_AFTER, 3)
assert.equal(DEFAULT_COOLDOWN_MS, 10 * 60 * 1000)

// A tripAfter of 1 stops on the first refusal; nothing lower is meaningful.
const strict = createCreditBreaker({ tripAfter: 0, cooldownMs: 0 })
strict.noteCreditFailure(0, null)
assert.equal(strict.state().tripped, true)
// With no cooldown every call is a probe — the breaker still never lies about
// its state, it just never blocks.
assert.deepEqual(strict.requestCall(0), { allowed: true, probe: true })

console.log('credit breaker tests passed')
