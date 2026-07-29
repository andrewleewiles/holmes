// Serving the vendored ONLYOFFICE web editors to the renderer.
//
// Same reasoning as audioProtocol.ts, with one difference that shapes the whole
// file: an audio URL carries an opaque segment id, so traversal is impossible by
// construction. The editor is a tree of ~3,600 interlinked files that fetch each
// other by relative path, so the URL has to carry a path — and the handler has
// to prove that path is inside the bundle rather than trust it.
//
// This is also the only place the editor's own CSP can be set. The bundle is
// third-party HTML we do not edit, and the app's meta CSP does not apply to a
// child document, so the policy travels as a response header from here. That is
// what keeps 'unsafe-eval' inside the editor frame instead of in Holmes.
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { app, net, protocol } from 'electron'

export const OFFICE_SCHEME = 'holmes-office'
/** The only host the scheme answers on; anything else is refused. */
const OFFICE_HOST = 'editor'

export const ONLYOFFICE_VERSION = '9.4.0'

let cachedRoot: string | null | undefined

/** Mirrors the sidecar lookup: packaged resources first, then the dev tree. */
export function officeBundleRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'onlyoffice', ONLYOFFICE_VERSION))
  }
  candidates.push(
    path.join(app.getAppPath(), 'node_modules', '.holmes', 'onlyoffice', ONLYOFFICE_VERSION),
    path.join(app.getAppPath(), '..', 'node_modules', '.holmes', 'onlyoffice', ONLYOFFICE_VERSION),
  )
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'sdkjs'))) {
        cachedRoot = fs.realpathSync(candidate)
        return cachedRoot
      }
    } catch { /* try the next candidate */ }
  }
  cachedRoot = null
  return null
}

/** True once `pnpm vendor:onlyoffice` has been run. The Work page asks first. */
export function isOfficeBundleInstalled(): boolean {
  return officeBundleRoot() !== null
}

/**
 * Resolves one URL path against the bundle root, or null if it escapes.
 *
 * Exported and free of Electron imports so the traversal cases can be asserted
 * in test-work.mjs without booting an app — the same reason documentText.ts is
 * kept import-free.
 */
export function resolveOfficeAssetPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null // a malformed %-escape is a refusal, never a guess
  }
  // A NUL truncates the path at the syscall boundary, so "a.js\0/../../etc"
  // would resolve as "a.js" here and as something else below us.
  if (decoded.includes('\0')) return null
  let relative = decoded.replace(/^\/+/, '')
  // The bundle is a flat tree on disk, but it is addressed the way a real
  // ONLYOFFICE install lays it out, and nginx resolves both of these there:
  //
  //   /onlyoffice/9.4.0/sdkjs/...   the packages layout the shell registers
  //   /9.4.0-129/web-apps/...       api.js's cache-busting version+hash
  //
  // Stripped in that order, since api.js appends its prefix beneath the first.
  // Both patterns are anchored and shaped so they can only match a deployment
  // prefix, never a real directory in the tree.
  relative = relative.replace(/^onlyoffice\/\d+(?:\.\d+)*(?:-[A-Za-z0-9]+)?\//, '')
  relative = relative.replace(/^\d+(?:\.\d+)*-[A-Za-z0-9]*\//, '')
  if (!relative) return null
  const resolved = path.resolve(root, relative)
  // The prefix check is the whole defence. `path.resolve` has already collapsed
  // every `..`, so anything still outside the root was trying to leave.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.otf': 'font/otf',
  '.xml': 'application/xml',
  // Five of the six .wasm files in the bundle are real modules and must be
  // application/wasm or instantiateStreaming refuses them and falls back to a
  // slower ArrayBuffer path. The sixth, x2t, never reaches here — see below.
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.cache': 'application/octet-stream',
}

/** x2t is the one wasm that ships Brotli-compressed rather than as a module. */
function isX2tWasm(filePath: string): boolean {
  return filePath.endsWith(`x2t${path.sep}x2t.wasm`)
}

let inflatedX2t: Buffer | null = null

/**
 * The editor frame's policy. Deliberately looser than the app's own — sdkjs
 * compiles formula and macro code, and x2t is a wasm module — and deliberately
 * closed at the edges: no http:, no https:, no ws:. The frame can reach the
 * bundle, blobs and data URLs, and nothing else. It cannot phone home, which is
 * what makes the 'unsafe-eval' below an acceptable trade rather than a hole.
 */
const EDITOR_CSP = [
  "default-src 'self' holmes-office:",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' holmes-office: blob:",
  "style-src 'self' 'unsafe-inline' holmes-office:",
  "img-src 'self' data: blob: holmes-office:",
  "font-src 'self' data: holmes-office:",
  "media-src 'self' data: blob: holmes-office:",
  "connect-src 'self' data: blob: holmes-office:",
  "worker-src 'self' blob: holmes-office:",
  "child-src 'self' blob: holmes-office:",
  "frame-src 'self' blob: holmes-office:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * Must run BEFORE app ready.
 *
 * `standard` gives the scheme a real (scheme, host) origin, which is what makes
 * Workers, blob URLs, storage and postMessage origin checks behave — and what
 * lets the shell page reach into the editor iframe it creates, since the two
 * then share an origin. `secure` puts it in a secure context, which WebAssembly
 * and the font cache both require.
 */
export function registerOfficeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: OFFICE_SCHEME,
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
    },
  ])
}

/** Must run AFTER app ready. */
export function installOfficeProtocol(): void {
  protocol.handle(OFFICE_SCHEME, async (request) => {
    const root = officeBundleRoot()
    if (!root) return new Response('Editor bundle is not installed', { status: 503 })

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (url.hostname !== OFFICE_HOST) return new Response('Not found', { status: 404 })

    const filePath = resolveOfficeAssetPath(root, url.pathname)
    if (!filePath) return new Response('Not found', { status: 404 })

    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Not found', { status: 404 })

    // x2t.wasm is 9 MB of Brotli on disk and 63 MB of wasm in memory. Electron's
    // protocol.handle bypasses Chromium's content decoding, so declaring
    // Content-Encoding: br does NOT work — the frame would receive the
    // compressed bytes. Main is Node, so inflate it here once and cache it,
    // rather than shipping a JS Brotli decoder into the renderer.
    if (isX2tWasm(filePath)) {
      if (!inflatedX2t) inflatedX2t = zlib.brotliDecompressSync(fs.readFileSync(filePath))
      return new Response(new Uint8Array(inflatedX2t), {
        status: 200,
        headers: {
          'Content-Type': 'application/wasm',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }

    const extension = path.extname(filePath).toLowerCase()
    // An extension-less font blob (fonts/054) is bytes, not a guess.
    const contentType = MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'

    // net.fetch over file:// streams the body and honours Range — the same
    // reason audioProtocol.ts uses it, and it matters here for the big sdk-all
    // bundles.
    const response = await net.fetch(`file://${filePath}`, {
      headers: request.headers,
      method: request.method,
    })
    const headers = new Headers(response.headers)
    headers.set('Content-Type', contentType)
    // The parent document embeds these; without this Chromium blocks them as
    // cross-origin subresources.
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
    headers.set('X-Content-Type-Options', 'nosniff')
    // Only documents carry a policy. Setting it on a subresource does nothing
    // useful and confuses anyone reading the headers later.
    if (contentType === 'text/html') headers.set('Content-Security-Policy', EDITOR_CSP)
    headers.delete('Content-Encoding')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}
