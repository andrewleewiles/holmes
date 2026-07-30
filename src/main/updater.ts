import { app, dialog } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createWriteStream } from 'fs'
import { mkdtemp, readdir, rename, rm } from 'fs/promises'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

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

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface Release {
  tag_name: string
  assets: ReleaseAsset[]
}

let updateInFlight = false

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

async function downloadAsset(asset: ReleaseAsset, dir: string): Promise<string> {
  const res = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'holmes-updater' },
  })
  if (!res.ok || !res.body) throw new Error(`asset download returned ${res.status}`)
  const zipPath = join(dir, asset.name)
  await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(zipPath))
  return zipPath
}

async function installUpdate(asset: ReleaseAsset, bundle: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'holmes-update-'))
  try {
    const zipPath = await downloadAsset(asset, work)
    // ditto, not a JS unzip: it preserves symlinks, permissions and the code
    // signature inside the bundle, all of which a naive extractor drops.
    const extracted = join(work, 'extracted')
    await execFileAsync('ditto', ['-x', '-k', zipPath, extracted])
    const appName = (await readdir(extracted)).find((f) => f.endsWith('.app'))
    if (!appName) throw new Error('no .app bundle inside the update zip')

    // Copy to a staging dir next to the installed bundle first: the final swap
    // must be two same-volume renames (atomic), and tmpdir is usually on a
    // different volume than the app.
    const staging = join(dirname(bundle), `.${basename(bundle)}.update`)
    await rm(staging, { recursive: true, force: true })
    await execFileAsync('ditto', [join(extracted, appName), staging])
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => undefined)

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
 * Check the GitHub latest release and offer to install it. Quiet unless
 * `interactive` — the startup/timer path only ever surfaces an actual update,
 * while the menu item also reports "up to date" and failures.
 */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!app.isPackaged || updateInFlight) return
  updateInFlight = true
  try {
    const release = await fetchLatestRelease()
    const current = app.getVersion()
    if (!release || !isNewerVersion(release.tag_name, current)) {
      if (interactive) {
        await dialog.showMessageBox({ message: `Holmes ${current} is up to date.` })
      }
      return
    }

    const version = release.tag_name.replace(/^v/, '')
    const asset = release.assets.find((a) => a.name.endsWith(`-mac-${process.arch}.zip`))
    const bundle = process.platform === 'darwin' ? currentBundlePath() : null
    // Outside a normal bundle (translocated, non-mac, no matching asset) fall
    // back to pointing at the releases page rather than attempting a swap.
    if (!asset || !bundle || bundle.includes('/AppTranslocation/')) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: `Holmes ${version} is available`,
        detail: 'This build cannot update itself in place. Download the new version from GitHub.',
        buttons: ['Open Releases Page', 'Later'],
        defaultId: 0,
      })
      if (response === 0) {
        const { shell } = await import('electron')
        await shell.openExternal(RELEASES_PAGE)
      }
      return
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Holmes ${version} is available`,
      detail: `You have ${current}. Download and install now?`,
      buttons: ['Install and Relaunch', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return

    await installUpdate(asset, bundle)
    app.relaunch()
    app.exit(0)
  } catch (err) {
    console.error('[updater]', err)
    if (interactive) {
      await dialog.showMessageBox({
        type: 'error',
        message: 'Update check failed',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  } finally {
    updateInFlight = false
  }
}
