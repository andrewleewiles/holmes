import { app, BrowserWindow, shell, Menu } from 'electron'
import { join } from 'path'
import type { DocumentContextProgress } from '../shared/types'
import {
  initDatabase,
  closeDatabase,
  listProjects,
  listConversationProjectIds,
  listSeparateContextConversationIds,
} from './database'
import { generateConversationContext } from './conversationContext'
import { broadcastSessionNoteAdded, registerIpcHandlers } from './ipc'
import { initRemoteServer, stopRemoteServer } from './remoteServer'
import { installProviderCallLog, withProviderCallFeature } from './callLog'
import { isAllowedExternalUrl } from './externalUrls'
import { isLibraryProject } from '../shared/defaultProjects'
import { installAudioProtocol, registerAudioScheme } from './audioProtocol'
import { OFFICE_SCHEME, installOfficeProtocol, registerOfficeScheme } from './officeProtocol'
import * as settings from './settings'
// Every background pass is gated on this rather than on the key alone: a key
// the provider is answering with 402 buys nothing, and a pass that starts anyway
// spends one refused call per item in its work list.
import { canCallProvider } from './providerCredit'
import { getAssistantName } from '../shared/assistantIdentity'
import { shouldUpdateAbridgedSummary, generateAbridgedSummary } from './memorySummary'
import { shouldUpdateHealthSummary, generateHealthSummary } from './healthSummary'
import { getIdleConversations, extractConversationMemory } from './conversationMemory'
import { conversationIdsWithSessionRoles, generateRoleSessionNote } from './roleSessions'
import { isSidecarAvailable, checkHealthKitAuthorization, syncHealthKitToProject } from './healthLive'
import { scanHealthDirectory } from './health'
import { migrateLegacySpeechKey, migrateLegacySecrets } from './keychain'
import { seedActivityAccounts, syncEnabledAccounts, scanAccountWatchFolders } from './activityAccounts'
import { ingestKnowledgeC } from './activityKnowledge'
import { syncAmazonOrdersGraphQL } from './activityAmazon'
import { detectSubscriptionsFromEmail } from './activitySubscriptions'
import { tickWeatherHourly } from './activityWeather'
import { shouldUpdateActivitySummary, generateActivitySummary } from './activitySummary'
import { shouldUpdateDocumentContexts, generateDocumentContexts, generateUserSuperContext } from './documentContext'
import {
  beginDocumentIndexRun,
  createIdleWatchdog,
  finishDocumentIndexRun,
  INDEX_IDLE_TIMEOUT_MINUTES,
  INDEX_IDLE_TIMEOUT_MS,
  isDocumentIndexPaused,
  isDocumentIndexRunActive,
  reportDocumentIndexProgress,
  setDocumentIndexRunProject,
} from './documentIndexRuns'
import { generateFinancesSummary } from './financesSummary'
import { rebuildTimeline } from './timeline'
import { beginTimelineRun, finishTimelineRun, isTimelineRunActive, reportTimelineRunProgress } from './timelineRuns'
import { rebuildPeople } from './people'
import { beginPeopleRun, finishPeopleRun, isPeopleRunActive, isPeopleRunPaused, reportPeopleRunProgress } from './peopleRuns'

let mainWindow: BrowserWindow | null = null
let summaryTimer: NodeJS.Timeout | null = null
let extractionTimer: NodeJS.Timeout | null = null
let healthSummaryTimer: NodeJS.Timeout | null = null
let activityIngestTimer: NodeJS.Timeout | null = null
let activityWeatherTimer: NodeJS.Timeout | null = null
let documentContextTimer: NodeJS.Timeout | null = null
let timelineTimer: NodeJS.Timeout | null = null
let peopleTimer: NodeJS.Timeout | null = null

// Must run before app ready: Chromium reads the privileged-scheme table when
// the renderer process is set up, not when the handler is installed.
registerAudioScheme()
registerOfficeScheme()

function createMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-chat'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+Shift+,',
          click: () => mainWindow?.webContents.send('menu:settings'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'OpenRouter',
          click: () => shell.openExternal('https://openrouter.ai'),
        },
      ],
    },
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: getAssistantName(),
    autoHideMenuBar: false,
    titleBarStyle: 'hiddenInset',
    // The traffic lights sit inside the sidebar enclosure, which is inset 6px
    // with a 1px border — so 21 leaves the same 14px of padding above them as
    // to their left. The toolbar icons in App.tsx are centred on this row.
    trafficLightPosition: { x: 21, y: 21 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault())
  // will-navigate is main-frame only, so neither line above constrains the
  // editor frame. This does: it may move around inside the bundle and nowhere
  // else, so a crafted document cannot navigate it off to a URL of its choosing.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (event.url.startsWith(`${OFFICE_SCHEME}://editor/`)) return
    event.preventDefault()
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Background ticks run under no IPC channel, so the call log has nothing to
// attribute their provider calls to. This names them, and is why the Call
// History page can tell an hourly index pass from one the user asked for.
const tick = (feature: string, run: () => Promise<void> | void) => (): void => {
  // The one gate over every background pass. Checked here rather than in each
  // tick body so a timer added later is covered without anyone remembering to,
  // and so a pause stops the local work too — a paused app should be idle, not
  // merely quiet on the network.
  if (settings.isAutomationPaused()) return
  void withProviderCallFeature(feature, async () => run())
}

app.whenReady().then(() => {
  initDatabase()
  // After the database: the handler resolves a segment id through it, so it must
  // not be able to answer a request before there is anything to resolve against.
  installAudioProtocol()
  installOfficeProtocol()
  // Before the handlers: installing it wraps ipcMain.handle, so a channel
  // registered earlier would go unlabelled.
  installProviderCallLog()
  registerIpcHandlers()
  createMenu()
  createWindow()

  // Move the pre-registry Amazon cookie key onto the per-provider layout. Runs
  // detached: a keychain hiccup must not delay the window.
  void migrateLegacySecrets()
  // Move the pre-multi-service narration key onto the per-service layout.
  void migrateLegacySpeechKey()
  // Give every registry provider a row on the Activity project so the Data page
  // has something to render before anything is configured.
  void seedActivityAccounts()
  // Only listens if the user turned remote access on. Detached: binding a port
  // must not delay the window.
  void initRemoteServer()

  // Background: refresh abridged summary hourly (actual regeneration is gated by 24h + field-hash change)
  summaryTimer = setInterval(tick('timer:memory-summary', async () => {
    try {
      if (shouldUpdateAbridgedSummary()) {
        const config = settings.getProvider()
        const model = settings.getTextModel()
        if (canCallProvider(config)) {
          await generateAbridgedSummary(config, model, new AbortController().signal)
        }
      }
    } catch {
      // Background summary refresh failed; will retry on next tick
    }
  }), 60 * 60 * 1000)

  // Background: read idle conversations every 30 minutes — extract memory from
  // them, summarize them into the contexts of whichever projects they are filed
  // under, and write the session note for any conversation held under a role
  // that produces one. A conversation in a separate-context project is
  // summarized for that project but never allowed to populate memory.
  extractionTimer = setInterval(tick('timer:conversation-memory', async () => {
    try {
      const appSettings = settings.getSettings()
      const memoryEnabled = appSettings.memoryAutoExtractionEnabled
      const contextsEnabled = appSettings.documentContextEnabled
      const idle = getIdleConversations()
      // Session notes are not gated on either toggle: choosing a role that
      // writes one IS the opt-in, and the note is the point of that choice.
      const sessionRoleIds = new Set(conversationIdsWithSessionRoles(idle.map((conv) => conv.id)))
      if (!memoryEnabled && !contextsEnabled && sessionRoleIds.size === 0) return
      const config = settings.getProvider()
      const model = settings.getTextModel()
      if (!canCallProvider(config)) return

      const separate = new Set(listSeparateContextConversationIds())
      for (const conv of idle) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 120_000)
        try {
          if (contextsEnabled && listConversationProjectIds(conv.id).length > 0) {
            await generateConversationContext(conv.id, config, model, controller.signal)
          }
          // A role-led conversation gets its formal session note here: the same
          // idle signal means the same thing — the session is over. Hash-gated,
          // so a conversation already written up costs nothing per pass, and a
          // failure must not cost the conversation its memory extraction.
          if (sessionRoleIds.has(conv.id)) {
            try {
              const note = await generateRoleSessionNote(conv.id, config, model, controller.signal)
              if (note.outcome === 'generated') broadcastSessionNoteAdded()
            } catch {
              // Retried on the next cycle.
            }
          }
          if (memoryEnabled && !separate.has(conv.id)) {
            await extractConversationMemory(conv.id, config, model, controller.signal)
          }
        } catch {
          // Skip failed conversations; will retry next cycle
        } finally {
          clearTimeout(timeout)
        }
      }
    } catch {
      // Background extraction failed; will retry on next tick
    }
  }), 30 * 60 * 1000)

  // Background: refresh rolling health summary hourly (actual regeneration is gated by 24h + observation-hash change)
  healthSummaryTimer = setInterval(tick('timer:health', async () => {
    try {
      if (!settings.getSettings().healthAnalysisEnabled) return
      const config = settings.getProvider()
      const model = settings.getTextModel()
      if (!canCallProvider(config)) return
      const projects = listProjects()
      for (const project of projects) {
        if (project.name !== 'Health') continue
        if (settings.getSettings().healthLiveSyncEnabled && isSidecarAvailable()) {
          try {
            const authorized = await checkHealthKitAuthorization()
            if (authorized === 'authorized') {
              const controller = new AbortController()
              const timeout = setTimeout(() => controller.abort(), 90_000)
              try {
                await syncHealthKitToProject(project.id, undefined, controller.signal)
              } catch {
                // Live sync failed; will retry on next tick
              } finally {
                clearTimeout(timeout)
              }
            }
          } catch {
            // Sidecar check failed; will retry on next tick
          }
        }
        // Health is a folder-backed data source like the others: new files in a
        // connected folder are picked up on their own rather than waiting to be
        // hand-imported. Identity-gated, so an unchanged folder costs one stat
        // per file and no model calls; `automatic` leaves previously failed
        // files alone so a PDF that cannot be parsed is not re-sent every hour.
        const scanController = new AbortController()
        const scanTimeout = setTimeout(() => scanController.abort(), 600_000)
        try {
          await scanHealthDirectory(project.id, config, model, scanController.signal, undefined, { automatic: true })
        } catch {
          // Background health ingest failed; will retry on next tick
        } finally {
          clearTimeout(scanTimeout)
        }

        if (!shouldUpdateHealthSummary(project.id)) continue
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 600_000)
        try {
          await generateHealthSummary(project.id, config, model, controller.signal)
        } catch {
          // Background summary refresh failed; will retry on next tick
        } finally {
          clearTimeout(timeout)
        }
      }
    } catch {
      // Background health summary refresh failed; will retry on next tick
    }
  }), 60 * 60 * 1000)

  // Background: poll Activity ingestion sources every 15 minutes (live sync + summary regeneration)
  activityIngestTimer = setInterval(tick('timer:activity', async () => {
    try {
      const appSettings = settings.getSettings()
      const syncEnabled = appSettings.activitySyncEnabled
      const analysisEnabled = appSettings.activityIngestEnabled
      if (!syncEnabled && !analysisEnabled) return

      const projects = listProjects()
      const activityProject = projects.find((p) => p.name === 'Activity')
      if (!activityProject) return

      // Syncing does not need model credentials — only the analysis pass does.
      // These used to share one gate, so turning off AI analysis also stopped
      // every source from syncing.
      if (syncEnabled) {
        try {
          await syncEnabledAccounts(activityProject.id)
        } catch (err) {
          console.error('Activity ingest: account sync pass failed', err)
        }

        try {
          const ingested = await scanAccountWatchFolders(activityProject.id)
          if (ingested > 0) {
            console.log(`Activity ingest: picked up ${ingested} new export(s) from watched folders`)
          }
        } catch (err) {
          console.error('Activity ingest: watched-folder scan failed', err)
        }
      }

      const config = settings.getProvider()
      const model = settings.getTextModel()
      if (!analysisEnabled || !canCallProvider(config)) return

      const knowledgeController = new AbortController()
      const knowledgeTimeout = setTimeout(() => knowledgeController.abort(), 90_000)
      try {
        await ingestKnowledgeC(activityProject.id, knowledgeController.signal)
      } catch (err) {
        console.error('Activity ingest: knowledge-c sync failed', err)
      } finally {
        clearTimeout(knowledgeTimeout)
      }

      const amazonController = new AbortController()
      const amazonTimeout = setTimeout(() => amazonController.abort(), 90_000)
      try {
        await syncAmazonOrdersGraphQL(activityProject.id, amazonController.signal)
      } catch (err) {
        console.error('Activity ingest: Amazon GraphQL sync failed', err)
      } finally {
        clearTimeout(amazonTimeout)
      }

      const subsController = new AbortController()
      const subsTimeout = setTimeout(() => subsController.abort(), 90_000)
      try {
        await detectSubscriptionsFromEmail(activityProject.id, subsController.signal)
      } catch (err) {
        console.error('Activity ingest: subscription detection failed', err)
      } finally {
        clearTimeout(subsTimeout)
      }

      if (shouldUpdateActivitySummary(activityProject.id)) {
        const summaryController = new AbortController()
        const summaryTimeout = setTimeout(() => summaryController.abort(), 600_000)
        try {
          await generateActivitySummary(activityProject.id, config, model, summaryController.signal, 'timer')
        } catch (err) {
          console.error('Activity ingest: summary regeneration failed', err)
        } finally {
          clearTimeout(summaryTimeout)
        }
      }

      const financesProject = projects.find((p) => p.name === 'Finances')
      if (financesProject) {
        const financesController = new AbortController()
        const financesTimeout = setTimeout(() => financesController.abort(), 600_000)
        try {
          await generateFinancesSummary(financesProject.id, config, model, financesController.signal, activityProject.id)
        } catch (err) {
          console.error('Activity ingest: Finances summary regeneration failed', err)
        } finally {
          clearTimeout(financesTimeout)
        }
      }
    } catch (err) {
      console.error('Activity ingest tick failed', err)
    }
  }), 15 * 60 * 1000)

  // Background: fetch hourly weather for the configured Activity location
  activityWeatherTimer = setInterval(tick('timer:weather', async () => {
    try {
      if (!settings.getSettings().activityWeatherEnabled) return
      const s = settings.getSettings()
      if (s.activityLocationLatitude == null || s.activityLocationLongitude == null) return
      const projects = listProjects()
      const activityProject = projects.find((p) => p.name === 'Activity')
      if (!activityProject) return
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 90_000)
      try {
        await tickWeatherHourly(activityProject.id, controller.signal)
      } catch (err) {
        console.error('Activity weather hourly tick failed', err)
      } finally {
        clearTimeout(timeout)
      }
    } catch (err) {
      console.error('Activity weather tick failed', err)
    }
  }), 60 * 60 * 1000)

  // Background: refresh hierarchical document contexts hourly for projects with a data-source path
  // (regeneration is gated by 24h + directory-signature change, and per-file/folder content-hash caching).
  documentContextTimer = setInterval(tick('timer:document-index', async () => {
    try {
      if (!settings.getSettings().documentContextEnabled) return
      const config = settings.getProvider()
      const model = settings.getTextModel()
      if (!canCallProvider(config)) return
      // An explicit user pause outranks the timer: never silently resume indexing
      // behind their back, and never stomp a run the user started themselves.
      if (isDocumentIndexPaused() || isDocumentIndexRunActive()) return
      const projects = listProjects()
      const run = beginDocumentIndexRun({ scope: 'all', origin: 'timer' })
      // Idle, not total: a background pass over a large corpus can legitimately
      // outlast any fixed cap, and killing it mid-way loses the folder syntheses
      // that only run once every file is done.
      const watchdog = createIdleWatchdog(run.controller, INDEX_IDLE_TIMEOUT_MS)
      const onTimerProgress = (p: DocumentContextProgress): void => {
        watchdog.ping()
        reportDocumentIndexProgress(run, p)
      }
      try {
        for (const project of projects) {
          if (run.signal.aborted) break
          if (!project.path) continue
          // A source the user hid stops costing them money in the background too.
          if (!project.visible) continue
          // A library's books are read in the Library and never indexed here.
          if (isLibraryProject(project)) continue
          if (!shouldUpdateDocumentContexts(project.id)) continue
          setDocumentIndexRunProject(run, project.id, project.name)
          try {
            // skipImages: photo indexing costs real money at photo-library scale
            // and must stay an explicit, estimated, user-authorized action.
            await generateDocumentContexts(project.id, config, model, run.signal, onTimerProgress, { skipImages: true })
          } catch {
            // Background document context refresh failed; will retry on next tick
          }
        }
        // Roll all project super-contexts up into the unified user super-context (hash-gated).
        // Skipped entirely when the run was paused/stopped or stalled out.
        if (!run.signal.aborted) {
          watchdog.ping()
          try {
            await generateUserSuperContext(config, model, run.signal)
          } catch {
            // Background user super-context refresh failed; will retry on next tick
          }
        }
      } finally {
        watchdog.cancel()
        finishDocumentIndexRun(
          run,
          watchdog.fired()
            ? { failed: true, message: `Background indexing stalled — nothing finished in ${INDEX_IDLE_TIMEOUT_MINUTES} minutes. It retries on the next hourly tick.` }
            : undefined
        )
      }
    } catch {
      // Background document context tick failed; will retry on next tick
    }
  }), 60 * 60 * 1000)

  // Background: rebuild the life timeline hourly. Harvesting is local and cheap;
  // the era narrative behind it is input-hash gated, so an unchanged event set
  // costs nothing.
  timelineTimer = setInterval(tick('timer:timeline', async () => {
    try {
      if (!settings.getSettings().timelineEnabled) return
      const config = settings.getProvider()
      const model = settings.getTextModel()
      // Never stack a background rebuild on a run the user started: they would
      // both harvest and both compress the same years.
      if (isTimelineRunActive()) return
      const controller = new AbortController()
      // Idle, not total — same reason as the user-triggered rebuild: the work
      // scales with the number of years, and each finished year is already saved.
      const watchdog = createIdleWatchdog(controller, INDEX_IDLE_TIMEOUT_MS)
      const run = beginTimelineRun('timer')
      try {
        const hasKey = canCallProvider(config)
        // Year super-contexts follow the same rule as the narrative: hash-gated,
        // so a tick with an unchanged record costs nothing, and skipped outright
        // when there is no key to call with.
        await rebuildTimeline(config, model, controller.signal, (progress) => {
          watchdog.ping()
          reportTimelineRunProgress(run, progress)
        }, { skipNarrative: !hasKey, skipYears: !hasKey })
        finishTimelineRun(run)
      } catch (err) {
        // Background timeline rebuild failed; will retry on next tick
        finishTimelineRun(run, { failed: true, message: err instanceof Error ? err.message : 'Timeline rebuild failed.' })
      } finally {
        watchdog.cancel()
      }
    } catch {
      // Background timeline tick failed; will retry on next tick
    }
  }), 60 * 60 * 1000)

  // People. Harvesting and resolution are entirely local, and the dossiers behind
  // them are hash-gated, so a tick with unchanged evidence costs nothing.
  //
  // Offset half an hour from the timeline tick on purpose: both read the same
  // generated contexts and both draw on the same provider rate-limit budget, and
  // running them together makes each take twice as long for no benefit.
  peopleTimer = setInterval(tick('timer:people', () => {
    setTimeout(async () => {
      try {
        if (!settings.getSettings().peopleEnabled) return
        const config = settings.getProvider()
        const model = settings.getTextModel()
        // Never stack on a run the user started, and never race the indexer or the
        // timeline: all three read the same contexts.
        if (isPeopleRunActive() || isTimelineRunActive() || isDocumentIndexRunActive()) return
        // A rebuild the user paused stays paused: the timer must not quietly
        // restart work they stopped on purpose.
        if (isPeopleRunPaused()) return
        const run = beginPeopleRun('timer')
        const watchdog = createIdleWatchdog(run.controller, INDEX_IDLE_TIMEOUT_MS)
        try {
          const hasKey = canCallProvider(config)
          await rebuildPeople(config, model, run.signal, (progress) => {
            watchdog.ping()
            reportPeopleRunProgress(run, progress)
          }, { skipDossiers: !hasKey })
          finishPeopleRun(run)
        } catch (err) {
          // Background People rebuild failed; will retry on next tick. An abort is
          // a pause or a stop, and the registry reports it as such.
          finishPeopleRun(run, {
            failed: !run.signal.aborted,
            message: err instanceof Error ? err.message : 'People rebuild failed.',
          })
        } finally {
          watchdog.cancel()
        }
      } catch {
        // Background People tick failed; will retry on next tick
      }
    }, 30 * 60 * 1000)
  }), 60 * 60 * 1000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (summaryTimer) clearInterval(summaryTimer)
  if (extractionTimer) clearInterval(extractionTimer)
  if (healthSummaryTimer) clearInterval(healthSummaryTimer)
  if (activityIngestTimer) clearInterval(activityIngestTimer)
  if (activityWeatherTimer) clearInterval(activityWeatherTimer)
  if (documentContextTimer) clearInterval(documentContextTimer)
  if (timelineTimer) clearInterval(timelineTimer)
  if (peopleTimer) clearInterval(peopleTimer)
  void stopRemoteServer()
  closeDatabase()
})
