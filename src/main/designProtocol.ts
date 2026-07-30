// Serving the vendored design editor (Graphite) to the renderer.
//
// Same construction as officeProtocol.ts — a privileged scheme, a traversal-
// proof path resolver, and the frame's CSP delivered as a response header.
// The editor gets its own HOST under the scheme (the host table survived the
// earlier two-editor design and keeps a second app cheap to add), and the
// policy is tighter than the office one: wasm compiles here, JS never evals.
import fs from 'fs'
import path from 'path'
import { app, net, protocol } from 'electron'
import { MIME_BY_EXTENSION } from './officeProtocol'

export const DESIGN_SCHEME = 'holmes-design'

/** The pinned Graphite commit `pnpm vendor:design` builds from source. */
export const GRAPHITE_COMMIT = '5927eff0597b0caea7a1d808c909920ff9f90f9d'
export const GRAPHITE_VERSION = GRAPHITE_COMMIT.slice(0, 8)

export type DesignHost = 'graphite'

/** One bundle per host; a hostname outside this table is refused. */
const DESIGN_HOSTS: Record<DesignHost, { app: string; version: string; probe: string }> = {
  graphite: { app: 'graphite', version: GRAPHITE_VERSION, probe: 'index.html' },
}

export function isDesignHost(value: string): value is DesignHost {
  return value === 'graphite'
}

const cachedRoots = new Map<DesignHost, string | null>()

/** Mirrors officeBundleRoot(): packaged resources first, then the dev tree. */
export function designBundleRoot(host: DesignHost): string | null {
  const cached = cachedRoots.get(host)
  if (cached !== undefined) return cached
  const bundle = DESIGN_HOSTS[host]
  const relative = path.join('design', bundle.app, bundle.version)
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, relative))
  }
  candidates.push(
    path.join(app.getAppPath(), 'node_modules', '.holmes', relative),
    path.join(app.getAppPath(), '..', 'node_modules', '.holmes', relative),
  )
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, bundle.probe))) {
        const resolved = fs.realpathSync(candidate)
        cachedRoots.set(host, resolved)
        return resolved
      }
    } catch { /* try the next candidate */ }
  }
  cachedRoots.set(host, null)
  return null
}

/** True once `pnpm vendor:design` has been run. The frame asks before loading. */
export function isDesignBundleInstalled(host: DesignHost): boolean {
  return designBundleRoot(host) !== null
}

/**
 * Resolves one URL path against a bundle root, or null if it escapes.
 *
 * The traversal core of resolveOfficeAssetPath without the ONLYOFFICE
 * deployment-prefix rewrites: neither editor cache-busts its URLs, so a path
 * like /9.4.0-129/x.js must resolve literally here, never be rewritten.
 * Exported and free of Electron imports so test-design.mjs can assert the
 * traversal cases without booting an app.
 */
export function resolveDesignAssetPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null // a malformed %-escape is a refusal, never a guess
  }
  // A NUL truncates the path at the syscall boundary, so "a.js\0/../../etc"
  // would resolve as "a.js" here and as something else below us.
  if (decoded.includes('\0')) return null
  const relative = decoded.replace(/^\/+/, '')
  if (!relative) return null
  const resolved = path.resolve(root, relative)
  // The prefix check is the whole defence. `path.resolve` has already collapsed
  // every `..`, so anything still outside the root was trying to leave.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/**
 * The design frame's policy. Graphite is a Rust editor compiled to
 * WebAssembly, so 'wasm-unsafe-eval' is required — but never 'unsafe-eval':
 * wasm compilation is the concession, JS eval is not. The edges are as closed
 * as the office frame's: no http:, no https:, no ws:. A design document that
 * smuggles script in (an SVG event handler, say) can at worst run inside a
 * frame that cannot reach the network or Holmes.
 */
const DESIGN_CSP = [
  `default-src 'self' ${DESIGN_SCHEME}:`,
  `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' ${DESIGN_SCHEME}: blob:`,
  `style-src 'self' 'unsafe-inline' ${DESIGN_SCHEME}:`,
  `img-src 'self' data: blob: ${DESIGN_SCHEME}:`,
  `font-src 'self' data: ${DESIGN_SCHEME}:`,
  `media-src 'self' data: blob: ${DESIGN_SCHEME}:`,
  `connect-src 'self' data: blob: ${DESIGN_SCHEME}:`,
  `worker-src 'self' blob: ${DESIGN_SCHEME}:`,
  `child-src 'self' blob: ${DESIGN_SCHEME}:`,
  `frame-src 'self' blob: ${DESIGN_SCHEME}:`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * Handed to the single registerSchemesAsPrivileged call in main.ts. Same
 * privileges block as the office scheme, for the same reasons: `standard`
 * gives each (scheme, host) a real origin so the shell page and the editor
 * iframe it creates are same-origin, `secure` keeps the canvas APIs happy.
 */
export const DESIGN_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: DESIGN_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    // Named explicitly in the app's policy instead — same reasoning as
    // audioProtocol.ts.
    bypassCSP: false,
  },
}

/** Must run AFTER app ready. */
export function installDesignProtocol(): void {
  protocol.handle(DESIGN_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (!isDesignHost(url.hostname)) return new Response('Not found', { status: 404 })

    const root = designBundleRoot(url.hostname)
    if (!root) return new Response('Design bundle is not installed', { status: 503 })

    const filePath = resolveDesignAssetPath(root, url.pathname)
    if (!filePath) return new Response('Not found', { status: 404 })

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Not found', { status: 404 })

    const extension = path.extname(filePath).toLowerCase()
    const contentType = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'

    const response = await net.fetch(`file://${filePath}`, {
      headers: request.headers,
      method: request.method,
    })
    const headers = new Headers(response.headers)
    headers.set('Content-Type', contentType)
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    headers.set('X-Content-Type-Options', 'nosniff')
    // Only documents carry a policy — same rule as officeProtocol.ts.
    if (contentType === 'text/html') headers.set('Content-Security-Policy', DESIGN_CSP)
    headers.delete('Content-Encoding')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}
