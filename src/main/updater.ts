import { app, dialog, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createWriteStream } from 'fs'
import { mkdtemp, readdir, rename, rm } from 'fs/promises'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import type { UpdateRunState } from '../shared/types'
import {
  getUpdateRunState,
  isUpdateBusy,
  reportUpdateAvailable,
  reportUpdateChecking,
  reportUpdateDownloadProgress,
  reportUpdateDownloadStarted,
  reportUpdateFailed,
  reportUpdateIdle,
  reportUpdateInstalling,
  reportUpdateReady,
  setCurrentVersion,
} from './updateRuns'

const execFileAsync = promisify(execFile)

const UPDATE_REPO = 'andrewleewiles/holmes'
const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`

// The app is ad-hoc signed (no Developer ID on the build machine), and
// Squirrel.Mac refuses to install an update into anything but a
// properly-signed bundle — which rules out electron-updater here. Instead the
// zip asset is downloaded and the .app bundle swapped in place: rename the
// running bundle aside, move the new one in, relaunch. The running process
// keeps its open inodes, so replacing the bundle underneath it is safe.
//
// Nothing here opens a dialog on its own any more. The check reports into
// `updateRuns` and the sidebar puts a strip up; download and restart are things
// the user clicks. The menu item is the one exception — an explicit "Check for
// Updates…" that finds nothing has to say so somehow, and a strip that never
// appears is not an answer.

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface Release {
  tag_name: string
  body?: string | null
  assets: ReleaseAsset[]
}

/** The release the last check found, held for the download click that follows. */
let pendingAsset: ReleaseAsset | null = null
let pendingBundle: string | null = null

/** Numeric-part semver compare; returns true when candidate is newer. */
function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

async function fetchLatestRelease(): Promise<Release | null> {
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'holmes-updater' },
  })
  // 404 = the repo has no releases yet; that is "up to date", not an error.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub releases API returned ${res.status}`)
  return (await res.json()) as Release
}

/** .../Holmes.app/Contents/MacOS/Holmes -> .../Holmes.app, or null outside a bundle. */
function currentBundlePath(): string | null {
  const bundle = dirname(dirname(dirname(app.getPath('exe'))))
  return bundle.endsWith('.app') ? bundle : null
}

/**
 * Streams the asset to disk, reporting bytes as they land. The byte count is
 * counted here rather than taken from the file size because the write stream
 * lags the socket, and a progress bar that trails the download by a hundred
 * megabytes looks stalled.
 */
async function downloadAsset(asset: ReleaseAsset, dir: string): Promise<string> {
  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'holmes-updater' },
  })
  if (!res.ok || !res.body) throw new Error(`asset download returned ${res.status}`)
  const header = res.headers.get('content-length')
  const total = header ? parseInt(header, 10) : NaN
  reportUpdateDownloadStarted(Number.isFinite(total) && total > 0 ? total : null)

  const zipPath = join(dir, asset.name)
  let received = 0
  const source = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    reportUpdateDownloadProgress(received)
  })
  await pipeline(source, createWriteStream(zipPath))
  return zipPath
}

async function installUpdate(asset: ReleaseAsset, bundle: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'holmes-update-'))
  try {
    const zipPath = await downloadAsset(asset, work)
    // ditto, not a JS unzip: it preserves symlinks, permissions and the code
    // signature inside the bundle, all of which a naive extractor drops.
    reportUpdateInstalling('Unpacking…')
    const extracted = join(work, 'extracted')
    await execFileAsync('ditto', ['-x', '-k', zipPath, extracted])
    const appName = (await readdir(extracted)).find((f) => f.endsWith('.app'))
    if (!appName) throw new Error('no .app bundle inside the update zip')

    // Copy to a staging dir next to the installed bundle first: the final swap
    // must be two same-volume renames (atomic), and tmpdir is usually on a
    // different volume than the app.
    reportUpdateInstalling('Staging the new version…')
    const staging = join(dirname(bundle), `.${basename(bundle)}.update`)
    await rm(staging, { recursive: true, force: true })
    await execFileAsync('ditto', [join(extracted, appName), staging])
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => undefined)

    reportUpdateInstalling('Swapping in the new version…')
    const old = `${bundle}.old`
    await rm(old, { recursive: true, force: true })
    await rename(bundle, old)
    try {
      await rename(staging, bundle)
    } catch (err) {
      await rename(old, bundle) // roll back so the user still has a launchable app
      throw err
    }
    await rm(old, { recursive: true, force: true })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Check the GitHub latest release and, if there is one, put it in front of the
 * user as a sidebar strip. `interactive` is the menu item: it also reports "up
 * to date" in a dialog, which the timer path stays quiet about.
 *
 * `surfaceFailure` is separate because the 6-hourly check runs whether or not
 * there is a network. A laptop that spends the evening offline must not collect
 * a red strip nobody asked for; a check the user clicked has to say something.
 */
export async function checkForUpdates(
  interactive: boolean,
  surfaceFailure: boolean = interactive,
): Promise<UpdateRunState> {
  if (!app.isPackaged || isUpdateBusy()) return getUpdateRunState()
  setCurrentVersion(app.getVersion())
  reportUpdateChecking()
  try {
    const release = await fetchLatestRelease()
    const current = app.getVersion()
    if (!release || !isNewerVersion(release.tag_name, current)) {
      reportUpdateIdle()
      if (interactive) {
        await dialog.showMessageBox({ message: `Holmes ${current} is up to date.` })
      }
      return getUpdateRunState()
    }

    const version = release.tag_name.replace(/^v/, '')
    const asset = release.assets.find((a) => a.name.endsWith(`-mac-${process.arch}.zip`))
    const bundle = process.platform === 'darwin' ? currentBundlePath() : null
    // Outside a normal bundle (translocated, non-mac, no matching asset) the
    // strip links to the releases page rather than attempting a swap.
    const installable = Boolean(asset && bundle && !bundle.includes('/AppTranslocation/'))
    pendingAsset = installable ? asset ?? null : null
    pendingBundle = installable ? bundle : null

    reportUpdateAvailable({
      version,
      notes: release.body?.trim() || null,
      canInstallInPlace: installable,
      releasesUrl: RELEASES_PAGE,
    })
    return getUpdateRunState()
  } catch (err) {
    console.error('[updater]', err)
    if (surfaceFailure) reportUpdateFailed(err instanceof Error ? err.message : String(err))
    else reportUpdateIdle()
    if (interactive) {
      await dialog.showMessageBox({
        type: 'error',
        message: 'Update check failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
    return getUpdateRunState()
  }
}

/**
 * Download the pending release and swap the bundle. Stops at `ready` rather
 * than relaunching: the user asked to download, not to lose what is on screen.
 */
export async function downloadUpdate(): Promise<UpdateRunState> {
  if (!pendingAsset || !pendingBundle) {
    reportUpdateFailed('No update is ready to download. Check again.')
    return getUpdateRunState()
  }
  const state = getUpdateRunState()
  // Re-entrancy: two clicks on the strip must not run two bundle swaps.
  if (state.status === 'downloading' || state.status === 'installing') return state
  try {
    await installUpdate(pendingAsset, pendingBundle)
    reportUpdateReady()
  } catch (err) {
    console.error('[updater]', err)
    reportUpdateFailed(err instanceof Error ? err.message : String(err))
  }
  return getUpdateRunState()
}

/** Relaunch into the bundle `downloadUpdate` already put in place. */
export function restartForUpdate(): void {
  app.relaunch()
  app.exit(0)
}

export async function openReleasesPage(): Promise<void> {
  await shell.openExternal(RELEASES_PAGE)
}
