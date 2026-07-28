/**
 * Shared machinery for cookie-authenticated connectors.
 *
 * Several accounts in the registry have no read API at all, and the only way to
 * get at them programmatically is to drive the same web endpoints the browser
 * does, carrying the user's pasted session cookies. That is what `activityAmazon`
 * already does; this module factors out the parts that are not Amazon-specific
 * so a second connector is an endpoint definition rather than another copy of
 * the fetch, header, expiry-detection and redaction code.
 *
 * What this module deliberately does NOT do is pretend a connector exists when
 * it does not. Instagram, Facebook, TikTok and LinkedIn are all marked
 * cookie-capable in the registry because that is the only live shape available
 * to them, but their endpoints are bot-defended in ways that need per-site
 * reverse engineering (signed headers, JS challenges, rotating app ids) and
 * none is implemented yet. `hasCookieConnector` reports that truthfully so the
 * UI can point at the export instead of running a sync that finds nothing.
 */

import { getSecret } from './keychain'
import type { ActivityProviderId } from '../shared/types'

/**
 * A browser-shaped UA. Not evasion: several of these endpoints return a
 * different response shape entirely to non-browser clients, so the request has
 * to look like the one the site expects to answer.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface CookieRequest {
  url: string
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

export class SessionExpiredError extends Error {
  constructor(provider: ActivityProviderId) {
    super(`The stored ${provider} session is no longer valid — paste fresh cookies to reconnect`)
    this.name = 'SessionExpiredError'
  }
}

/**
 * Signals a dead session. These endpoints answer an expired cookie with a 401,
 * a 302 to a login page, or — most annoyingly — a 200 whose body is the login
 * page, so the status code alone is not enough.
 */
export function looksLikeLoginWall(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true
  if (status >= 300 && status < 400) return true
  const head = body.slice(0, 4000).toLowerCase()
  return (
    head.includes('name="password"') ||
    head.includes('signin') && head.includes('<form') ||
    head.includes('"loginrequired"') ||
    head.includes('please log in')
  )
}

/**
 * Performs one authenticated request for a provider. Throws
 * `SessionExpiredError` when the session is dead, so callers can turn that into
 * a `needs_reauth` state instead of a generic failure.
 */
export async function cookieFetch(
  provider: ActivityProviderId,
  request: CookieRequest
): Promise<{ status: number; body: string }> {
  const cookies = await getSecret(provider, 'cookie')
  if (!cookies) throw new SessionExpiredError(provider)

  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    body: request.body,
    signal: request.signal,
    redirect: 'manual',
    headers: {
      cookie: cookies,
      'user-agent': BROWSER_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      ...(request.headers ?? {}),
    },
  })

  const body = await response.text()
  if (looksLikeLoginWall(response.status, body)) throw new SessionExpiredError(provider)

  return { status: response.status, body }
}

/**
 * Providers with a cookie connector that actually runs today.
 *
 * Amazon is the only one. It is here rather than inferred from the registry
 * because `live: 'cookie'` in the registry describes the only live path a
 * provider *could* have, not the one that is built — conflating the two is how
 * a UI ends up offering a Connect button that leads nowhere.
 */
const IMPLEMENTED_COOKIE_CONNECTORS = new Set<ActivityProviderId>(['amazon'])

export function hasCookieConnector(provider: ActivityProviderId): boolean {
  return IMPLEMENTED_COOKIE_CONNECTORS.has(provider)
}
