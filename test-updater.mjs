import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  getUpdateRunState,
  isUpdateAvailable,
  isUpdateBusy,
  reportUpdateAvailable,
  reportUpdateChecking,
  reportUpdateDownloadProgress,
  reportUpdateDownloadStarted,
  reportUpdateFailed,
  reportUpdateIdle,
  reportUpdateInstalling,
  reportUpdateReady,
  resetUpdateRunsForTests,
  setCurrentVersion,
  subscribeUpdateRunState,
} from './src/main/updateRuns.ts'

// `updateRuns` is deliberately free of electron imports so it can be exercised
// here; `updater.ts` itself cannot be, so its contract is asserted on source.

const AVAILABLE = {
  version: '0.3.0',
  notes: 'Notes',
  canInstallInPlace: true,
  releasesUrl: 'https://github.com/andrewleewiles/holmes/releases',
}

// --- the state machine -------------------------------------------------------

resetUpdateRunsForTests()
setCurrentVersion('0.2.0')

assert.equal(getUpdateRunState().status, 'idle')
assert.equal(getUpdateRunState().currentVersion, '0.2.0')

reportUpdateChecking()
assert.equal(getUpdateRunState().status, 'checking')
assert.equal(isUpdateBusy(), true, 'a check in flight blocks a second one')

// A check that finds nothing goes quiet rather than leaving a strip up.
reportUpdateIdle()
assert.equal(getUpdateRunState().status, 'idle')
assert.equal(isUpdateAvailable(), false)

reportUpdateAvailable(AVAILABLE)
const available = getUpdateRunState()
assert.equal(available.status, 'available')
assert.equal(available.version, '0.3.0')
assert.equal(available.currentVersion, '0.2.0', 'the strip names both versions')
assert.equal(available.notes, 'Notes')
assert.equal(available.fraction, null, 'nothing downloaded yet')
assert.equal(isUpdateAvailable(), true)
// `available` is not work in progress — a later timer check may still run.
assert.equal(isUpdateBusy(), false)

// --- download progress -------------------------------------------------------

reportUpdateDownloadStarted(1000)
assert.equal(getUpdateRunState().status, 'downloading')
assert.equal(getUpdateRunState().bytesTotal, 1000)
assert.equal(getUpdateRunState().fraction, 0)

reportUpdateDownloadProgress(250)
assert.equal(getUpdateRunState().fraction, 0.25)
assert.equal(getUpdateRunState().bytesDownloaded, 250)

// A server that overshoots content-length must not paint a bar past its box.
reportUpdateDownloadProgress(1200)
assert.equal(getUpdateRunState().fraction, 1)

// No content-length means no bar at all rather than a bar stuck at zero.
reportUpdateDownloadStarted(null)
reportUpdateDownloadProgress(500)
assert.equal(getUpdateRunState().fraction, null)
assert.equal(getUpdateRunState().bytesDownloaded, 500)

// --- the download must not be interrupted ------------------------------------

// The 6-hourly timer keeps firing while a 1.2GB download runs. None of these
// may knock the strip off the state the user is watching.
reportUpdateChecking()
assert.equal(getUpdateRunState().status, 'downloading', 'a timer check cannot reset a live download')
reportUpdateIdle()
assert.equal(getUpdateRunState().status, 'downloading')
reportUpdateAvailable({ ...AVAILABLE, version: '0.4.0' })
assert.equal(getUpdateRunState().version, '0.3.0', 'a newer release mid-download does not swap the target')

reportUpdateInstalling('Unpacking…')
assert.equal(getUpdateRunState().status, 'installing')
assert.equal(getUpdateRunState().message, 'Unpacking…')
assert.equal(isUpdateBusy(), true)

reportUpdateChecking()
assert.equal(getUpdateRunState().status, 'installing', 'a timer check cannot interrupt the bundle swap')

reportUpdateReady()
assert.equal(getUpdateRunState().status, 'ready')
assert.equal(getUpdateRunState().message, null)

// Ready outlives every later check: the bundle on disk is already replaced, so
// forgetting it would strand the user on the old app with no way back to the
// restart button.
reportUpdateChecking()
assert.equal(getUpdateRunState().status, 'ready')
reportUpdateIdle()
assert.equal(getUpdateRunState().status, 'ready')
reportUpdateAvailable(AVAILABLE)
assert.equal(getUpdateRunState().status, 'ready')

// --- failure -----------------------------------------------------------------

resetUpdateRunsForTests()
reportUpdateAvailable(AVAILABLE)
reportUpdateFailed('network died')
assert.equal(getUpdateRunState().status, 'failed')
assert.equal(getUpdateRunState().message, 'network died')
// A failure is recoverable: the next check takes over cleanly.
reportUpdateChecking()
assert.equal(getUpdateRunState().status, 'checking')

// --- subscribers -------------------------------------------------------------

resetUpdateRunsForTests()
const seen = []
const unsubscribe = subscribeUpdateRunState((state) => seen.push(state.status))
reportUpdateAvailable(AVAILABLE)
reportUpdateDownloadStarted(10)
assert.deepEqual(seen, ['available', 'downloading'])

// A listener that throws must not take the install down with it.
subscribeUpdateRunState(() => {
  throw new Error('bad listener')
})
reportUpdateReady()
assert.equal(seen.at(-1), 'ready', 'a throwing listener does not stop the rest')

unsubscribe()
reportUpdateFailed('after unsubscribe')
assert.equal(seen.at(-1), 'ready', 'an unsubscribed listener stops hearing')

resetUpdateRunsForTests()

// --- the updater contract ----------------------------------------------------

const updaterSource = fs.readFileSync(new URL('./src/main/updater.ts', import.meta.url), 'utf8')

// The download and the relaunch are separate calls on purpose: swapping the
// bundle is safe while the app runs, so the user chooses when to lose the
// window rather than having it yanked away mid-sentence.
assert.ok(/export async function downloadUpdate/.test(updaterSource))
assert.ok(/export function restartForUpdate/.test(updaterSource))
assert.ok(
  !/app\.relaunch\(\)/.test(updaterSource.split('export function restartForUpdate')[0]),
  'nothing relaunches before the user asks for it',
)

// The asset name suffix the release must carry — see the release recipe. A
// rename on the electron-builder side silently breaks every installed copy.
assert.ok(/-mac-\$\{process\.arch\}\.zip/.test(updaterSource))

// ditto, not a JS unzip: it is the only extractor that preserves the symlinks,
// permissions and signature inside the bundle.
assert.ok(/'ditto', \['-x', '-k'/.test(updaterSource))
// The final swap is two same-volume renames with a rollback between them.
assert.ok(/await rename\(old, bundle\)/.test(updaterSource), 'a failed swap rolls the old bundle back')

// Progress is counted off the socket, not the file: the write stream lags far
// enough behind on a gigabyte to look stalled.
assert.ok(/source\.on\('data'/.test(updaterSource))
assert.ok(/content-length/.test(updaterSource))

// A laptop that spends the evening offline runs the 6-hourly check against no
// network several times. None of those may leave a red strip behind.
assert.ok(/surfaceFailure: boolean = interactive/.test(updaterSource))
assert.ok(/if \(surfaceFailure\) reportUpdateFailed/.test(updaterSource))
const ipcSource = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
assert.ok(
  /checkForUpdates\(false, true\)/.test(ipcSource),
  'a check the user clicked reports its own failure',
)
const mainSource = fs.readFileSync(new URL('./src/main/main.ts', import.meta.url), 'utf8')
assert.ok(/checkForUpdates\(false\)/.test(mainSource), 'the timer check stays quiet on failure')

// --- remote safety -----------------------------------------------------------

const remoteSource = fs.readFileSync(new URL('./src/shared/remote.ts', import.meta.url), 'utf8')
assert.ok(
  !/IPC\.UPDATER\./.test(remoteSource),
  'a paired phone must not be able to relaunch the desktop app',
)

// --- wiring ------------------------------------------------------------------

const preloadSource = fs.readFileSync(new URL('./src/preload/preload.ts', import.meta.url), 'utf8')
for (const call of ['getState', 'check', 'download', 'restart', 'openReleases', 'onState']) {
  assert.ok(new RegExp(`${call}: `).test(preloadSource.split('updater: {')[1].split('},')[0]), `preload exposes ${call}`)
}

const typesSource = fs.readFileSync(new URL('./src/shared/types.ts', import.meta.url), 'utf8')
assert.ok(/export interface UpdateRunState/.test(typesSource))
assert.ok(/updater: \{/.test(typesSource), 'ElectronAPI carries the updater surface')

// --- renderer subscription discipline ----------------------------------------

// Same rule, and the same reason, as the tabloid/library run states: one IPC
// listener app-wide, fanned out.
const componentsDir = new URL('./src/renderer/components/', import.meta.url)
const offenders = fs
  .readdirSync(componentsDir)
  .filter((name) => name.endsWith('.tsx'))
  .filter((name) => /updater\.onState\(/.test(fs.readFileSync(new URL(name, componentsDir), 'utf8')))
assert.deepEqual(offenders, [], 'components must subscribe via the useUpdateRun hook, not directly')

const hookSource = fs.readFileSync(new URL('./src/renderer/hooks/useUpdateRun.ts', import.meta.url), 'utf8')
assert.equal((hookSource.match(/updater\.onState\(/g) ?? []).length, 1, 'exactly one onState subscription app-wide')
assert.ok(/listeners\.size === 0 && unsubscribe/.test(hookSource), 'torn down when the last consumer unmounts')
assert.ok(/if \(!initialFetch\)/.test(hookSource), 'the initial getState is deduped across consumers')

// --- the sidebar strip -------------------------------------------------------

const sidebarSource = fs.readFileSync(new URL('./src/renderer/components/Sidebar.tsx', import.meta.url), 'utf8')
assert.ok(/useUpdateRun\(\)/.test(sidebarSource))
// Clicking through a download would fire a second bundle swap.
assert.ok(
  /disabled=\{updateStatus === 'downloading' \|\| updateStatus === 'installing'\}/.test(sidebarSource),
  'the strip is inert while the download runs',
)
// Restarting throws away whatever is on screen, so it is confirmed first.
assert.ok(/window\.confirm\(`Restart Holmes/.test(sidebarSource))
// A build that cannot swap itself in place still has somewhere to send people.
assert.ok(/updater\.openReleases\(\)/.test(sidebarSource))

console.log('updater: all assertions passed')
