import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-activity-db-'))
process.env.HOLMES_USER_DATA = dbDir
const electronStub = {
  app: { getPath: () => dbDir, isPackaged: false, getAppPath: () => dbDir },
}
const require = Module.createRequire(import.meta.url)
const moduleAlias = require('module')
const origResolve = moduleAlias._resolveFilename
moduleAlias._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') return request
  return origResolve.call(this, request, parent, isMain, options)
}
const ModuleLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return ModuleLoad.call(this, request, parent, isMain)
}

const Database = (await import('better-sqlite3')).default

const {
  initDatabase,
  closeDatabase,
  createProject,
  listProjects,
  listAllBrowserEvents,
  listAllYoutubeEvents,
  listAllEmailEvents,
  listAllAmazonEvents,
  listAllLocationEvents,
  listAllWeatherEvents,
  listAllSubscriptionEvents,
  getActivityEventsHash,
  getActivityRecord,
} = await import('./src/main/database.ts')
initDatabase()

const { setFileAccessScope, setSettings } = await import('./src/main/settings.ts')
setFileAccessScope({ mode: 'everywhere', roots: [] })

let projectList = listProjects()
let activityProject = projectList.find((p) => p.name === 'Activity')
if (!activityProject) {
  activityProject = createProject({
    name: 'Activity',
    icon: 'compass',
    color: '#8b5cf6',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    activityAnalysis: null,
    financesSummary: null,
  })
}
let financesProject = projectList.find((p) => p.name === 'Finances')
if (!financesProject) {
  financesProject = createProject({
    name: 'Finances',
    icon: 'sack-dollar',
    color: '#22c55e',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    activityAnalysis: null,
    financesSummary: null,
  })
}
const projectId = activityProject.id
const financesProjectId = financesProject.id

const {
  redactActivityContent,
  redactEmailContent,
  ingestBrowserHistory,
  ingestYouTubeHistory,
  ingestEmailMbox,
  ingestLocationHistory,
} = await import('./src/main/activity.ts')
const { redactAmazonContent, ingestAmazonOrdersCsv } = await import('./src/main/activityAmazon.ts')
const { fetchWeatherHistory, wmoCodeToCondition } = await import('./src/main/activityWeather.ts')
const { detectSubscriptionsFromEmail } = await import('./src/main/activitySubscriptions.ts')
const { parseActivityAnalysisResponse, emptyActivityAnalysis } = await import('./src/main/activityAnalysis.ts')
const { generateActivitySummary, shouldUpdateActivitySummary } = await import('./src/main/activitySummary.ts')

let passed = 0
let failed = 0
async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (err) {
    failed += 1
    console.error(`FAIL: ${name}`)
    console.error(`  ${err instanceof Error ? err.stack || err.message : String(err)}`)
  }
}

const CHROME_VISIT_TIME = (1685613600000 + 11644473600000) * 1000
const SAFARI_VISIT_TIME = 1685613600 - 978307200
const FIREFOX_VISIT_TIME = 1685613600 * 1_000_000

function makeChromeHistory(filePath) {
  const db = new Database(filePath)
  db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER)`)
  db.exec(`CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)`)
  db.prepare(`INSERT INTO urls (id, url, title, visit_count) VALUES (?, ?, ?, ?)`).run(1, 'https://example.com/page', 'Example Page', 1)
  db.prepare(`INSERT INTO visits (id, url, visit_time) VALUES (?, ?, ?)`).run(1, 1, CHROME_VISIT_TIME)
  db.close()
}

function makeSafariHistory(filePath) {
  const db = new Database(filePath)
  db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, title TEXT)`)
  db.exec(`CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time INTEGER)`)
  db.prepare(`INSERT INTO history_items (id, url, title) VALUES (?, ?, ?)`).run(1, 'https://safari.example.com', 'Safari Page')
  db.prepare(`INSERT INTO history_visits (id, history_item, visit_time) VALUES (?, ?, ?)`).run(1, 1, SAFARI_VISIT_TIME)
  db.close()
}

function makeFirefoxHistory(filePath) {
  const db = new Database(filePath)
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT)`)
  db.exec(`CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER)`)
  db.prepare(`INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)`).run(1, 'https://firefox.example.com', 'Firefox Page')
  db.prepare(`INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (?, ?, ?)`).run(1, 1, FIREFOX_VISIT_TIME)
  db.close()
}

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-activity-'))

await run('browser history chrome parser', async () => {
  const filePath = path.join(fixtureDir, 'History')
  makeChromeHistory(filePath)
  const record = await ingestBrowserHistory(filePath, projectId, 'chrome')
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 1)
  const events = listAllBrowserEvents(projectId)
  const visit = events.find((e) => e.url === 'https://example.com/page')
  assert.ok(visit, 'chrome visit event should be stored')
  assert.equal(visit.title, 'Example Page')
  assert.equal(visit.occurredAt, '2023-06-01T10:00:00.000Z')
})

await run('browser history safari parser', async () => {
  const filePath = path.join(fixtureDir, 'History.db')
  makeSafariHistory(filePath)
  const record = await ingestBrowserHistory(filePath, projectId, 'safari')
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 1)
  const events = listAllBrowserEvents(projectId)
  const visit = events.find((e) => e.url === 'https://safari.example.com')
  assert.ok(visit, 'safari visit event should be stored')
  assert.equal(visit.occurredAt, '2023-06-01T10:00:00.000Z')
})

await run('browser history firefox parser', async () => {
  const filePath = path.join(fixtureDir, 'places.sqlite')
  makeFirefoxHistory(filePath)
  const record = await ingestBrowserHistory(filePath, projectId, 'firefox')
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 1)
  const events = listAllBrowserEvents(projectId)
  const visit = events.find((e) => e.url === 'https://firefox.example.com')
  assert.ok(visit, 'firefox visit event should be stored')
  assert.equal(visit.occurredAt, '2023-06-01T10:00:00.000Z')
})

await run('youtube history parser', async () => {
  const filePath = path.join(fixtureDir, 'watch-history.json')
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      { header: 'YouTube', title: 'Watched Video A', titleUrl: 'https://www.youtube.com/watch?v=abc', time: '2023-06-01T10:00:00Z', subtitles: [{ name: 'Channel X' }] },
      { header: 'YouTube', title: 'Watched Video B', titleUrl: 'https://www.youtube.com/watch?v=def', time: '2023-06-02T11:00:00Z', subtitles: [{ name: 'Channel Y' }] },
    ])
  )
  const record = await ingestYouTubeHistory(filePath, projectId)
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 2)
  const events = listAllYoutubeEvents(projectId)
  const a = events.find((e) => e.url === 'https://www.youtube.com/watch?v=abc')
  assert.ok(a, 'youtube event A should be stored')
  assert.equal(a.title, 'Video A')
  assert.equal(a.channel, 'Channel X')
  assert.equal(a.occurredAt, '2023-06-01T10:00:00.000Z')
})

await run('email mbox parser', async () => {
  const filePath = path.join(fixtureDir, 'inbox.mbox')
  fs.writeFileSync(
    filePath,
    [
      'From sender@example.com Fri Jun 01 12:00:00 2023',
      'Date: Fri, 01 Jun 2023 12:00:00 +0000',
      'From: sender@example.com',
      'To: recipient@example.com',
      'Subject: Test Email 1',
      '',
      'This is the body of email 1.',
      '',
      'From sender2@example.com Fri Jun 02 13:00:00 2023',
      'Date: Fri, 02 Jun 2023 13:00:00 +0000',
      'From: sender2@example.com',
      'To: recipient@example.com',
      'Subject: Test Email 2',
      '',
      'Body of email 2.',
      '',
    ].join('\n')
  )
  const record = await ingestEmailMbox(filePath, projectId)
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 2)
  const events = listAllEmailEvents(projectId).filter((e) => e.subject === 'Test Email 1' || e.subject === 'Test Email 2')
  assert.equal(events.length, 2)
  const first = events.find((e) => e.subject === 'Test Email 1')
  assert.equal(first.fromAddress, 'sender@example.com')
  assert.deepEqual(first.toAddresses, ['recipient@example.com'])
  assert.equal(first.kind, 'received')
  assert.ok(first.bodyExcerpt.includes('body of email 1'))
})

await run('location history parser', async () => {
  const filePath = path.join(fixtureDir, 'Records.json')
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      locations: [
        { latitudeE7: 37500000, longitudeE7: -122000000, timestamp: '2023-06-01T12:00:00Z', accuracy: 10 },
        { latitudeE7: 38000000, longitudeE7: -122100000, timestamp: '2023-06-01T13:00:00Z', accuracy: 25 },
      ],
    })
  )
  const record = await ingestLocationHistory(filePath, projectId)
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 2)
  const events = listAllLocationEvents(projectId)
  const first = events.find((e) => e.lat === 3.75)
  assert.ok(first, 'first location point should be stored')
  assert.equal(first.lat, 3.75)
  assert.equal(first.lng, -12.2)
  assert.equal(first.accuracyM, 10)
  assert.equal(first.occurredAt, '2023-06-01T12:00:00.000Z')
})

await run('amazon csv parser', async () => {
  const filePath = path.join(fixtureDir, 'amazon-orders.csv')
  fs.writeFileSync(
    filePath,
    [
      'Order ID,Order Date,Item Title,Quantity,Item Price,Order Total',
      '112-3456789-7654321,2023-06-01,Widget,2,12.50,25.00',
      '222-9876543-2109876,2023-06-15,Book,1,15.00,15.00',
    ].join('\n')
  )
  const record = await ingestAmazonOrdersCsv(filePath, projectId)
  assert.equal(record.status, 'parsed')
  assert.equal(record.eventsCount, 2)
  const events = listAllAmazonEvents(projectId)
  const widget = events.find((e) => e.orderId === '112-3456789-7654321')
  assert.ok(widget, 'amazon widget order should be stored')
  assert.equal(widget.totalCents, 2500)
  assert.equal(widget.items.length, 1)
  assert.equal(widget.items[0].title, 'Widget')
  assert.equal(widget.items[0].quantity, 2)
  assert.equal(widget.items[0].priceCents, 1250)
  assert.equal(widget.occurredAt.startsWith('2023-06-01'), true)
})

await run('amazon order id redaction', async () => {
  const redacted = redactAmazonContent('Order 112-3456789-7654321 confirmed')
  assert.doesNotMatch(redacted, /112-3456789-7654321/)
  assert.match(redacted, /\[REDACTED/)
})

await run('activity content redaction', async () => {
  const email = redactActivityContent('contact me at user@example.com and visit https://site.com?utm_source=email')
  assert.doesNotMatch(email, /user@example\.com/)
  assert.match(email, /\[REDACTED EMAIL\]/)
  assert.doesNotMatch(email, /utm_source=email/)
  assert.match(email, /https:\/\/site\.com/)

  const token = redactActivityContent('Authorization: Bearer abc123def456')
  assert.doesNotMatch(token, /abc123def456/)
  assert.match(token, /REDACTED/)

  const ip = redactActivityContent('IP 192.168.1.1')
  assert.doesNotMatch(ip, /192\.168\.1\.1/)
  assert.match(ip, /\[REDACTED IP\]/)
})

await run('email redaction with allowlist', async () => {
  const redacted = redactEmailContent('From me@mine.com and them@theirs.com', 'me@mine.com')
  assert.doesNotMatch(redacted, /them@theirs\.com/)
  assert.match(redacted, /me@mine\.com/)
  assert.match(redacted, /REDACTED/)
})

await run('weather parser mock fetch', async () => {
  const sampleResp = {
    hourly: {
      time: ['2023-06-01T00:00:00', '2023-06-01T01:00:00'],
      temperature_2m: [15.0, 16.0],
      relative_humidity_2m: [50, 55],
      precipitation: [0, 0.5],
      wind_speed_10m: [10, 12],
      weather_code: [0, 1],
    },
  }
  const origFetch = globalThis.fetch
  let fetchCalled = 0
  globalThis.fetch = async () => {
    fetchCalled += 1
    return { ok: true, status: 200, statusText: 'OK', json: async () => sampleResp, text: async () => JSON.stringify(sampleResp) }
  }
  try {
    const record = await fetchWeatherHistory(projectId, 37.5, -122.0, 7)
    assert.equal(fetchCalled, 1)
    assert.equal(record.status, 'parsed')
    assert.equal(record.eventsCount, 2)
    assert.equal(wmoCodeToCondition(0), 'Clear')
    assert.equal(wmoCodeToCondition(45), 'Fog')
    const events = listAllWeatherEvents(projectId)
    assert.ok(events.length >= 2)
  } finally {
    globalThis.fetch = origFetch
  }
})

await run('subscription detection from email', async () => {
  const filePath = path.join(fixtureDir, 'subs.mbox')
  fs.writeFileSync(
    filePath,
    [
      'From info@netflix.com Fri Jun 01 12:00:00 2023',
      'Date: Fri, 01 Jun 2023 12:00:00 +0000',
      'From: info@netflix.com',
      'To: me@mine.com',
      'Subject: Your Netflix subscription renewed - $159.99 yearly',
      '',
      'Renewal body',
      '',
      'From billing@spotify.com Fri Jun 02 12:00:00 2023',
      'Date: Fri, 02 Jun 2023 12:00:00 +0000',
      'From: billing@spotify.com',
      'To: me@mine.com',
      'Subject: Receipt from Spotify - $9.99 monthly',
      '',
      'Receipt body',
      '',
    ].join('\n')
  )
  await ingestEmailMbox(filePath, financesProjectId)
  const record = await detectSubscriptionsFromEmail(financesProjectId)
  assert.equal(record.status, 'parsed')
  const subs = listAllSubscriptionEvents(financesProjectId)
  const netflix = subs.find((s) => s.provider === 'netflix.com')
  assert.ok(netflix, 'netflix subscription event should be detected')
  assert.equal(netflix.amountCents, 15999)
  assert.equal(netflix.cadence, 'yearly')
  const spotify = subs.find((s) => s.provider === 'spotify.com')
  assert.ok(spotify, 'spotify subscription event should be detected')
  assert.equal(spotify.amountCents, 999)
  assert.equal(spotify.cadence, 'monthly')
})

await run('knowledgec returns needs_permission on inaccessible db', async () => {
  const origHomedir = os.homedir
  const fakeHome = path.join(fixtureDir, 'knowledge-home')
  fs.mkdirSync(path.join(fakeHome, 'Library', 'Application Support', 'Knowledge'), { recursive: true })
  os.homedir = () => fakeHome
  try {
    const { ingestKnowledgeC } = await import('./src/main/activityKnowledge.ts')
    const fresh = createProject({
      name: 'KnowledgeTest',
      icon: 'brain',
      color: '#6366f1',
      path: null,
      files: [],
      analysis: null,
      healthAnalysis: null,
      activityAnalysis: null,
      financesSummary: null,
    })
    const record = await ingestKnowledgeC(fresh.id)
    assert.equal(record.status, 'needs_permission')
    assert.ok(record.parseError)
  } finally {
    os.homedir = origHomedir
  }
})

await run('photos stub needs_permission', async () => {
  const { syncPhotosMetadata } = await import('./src/main/activityPhotos.ts')
  const fresh = createProject({
    name: 'PhotosTest',
    icon: 'image',
    color: '#ec4899',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    activityAnalysis: null,
    financesSummary: null,
  })
  const record = await syncPhotosMetadata(fresh.id)
  assert.equal(record.status, 'needs_permission')
  assert.match(record.parseError ?? '', /sidecar/)
})

await run('summary analysis parser', async () => {
  const text = '```json\n{"topInterests":["coding"],"mediaConsumption":[],"spendingPatterns":[],"communicationPatterns":[],"digitalBehavior":[],"locationPatterns":[],"weatherMoodCorrelations":[],"openThreads":[],"summary":"Test"}\n```'
  const parsed = parseActivityAnalysisResponse(text)
  assert.deepEqual(parsed.topInterests, ['coding'])
  assert.equal(parsed.summary, 'Test')
  assert.ok(parsed.generatedAt && parsed.generatedAt.length > 0)

  const empty = emptyActivityAnalysis('nothing here')
  assert.equal(empty.summary, 'nothing here')
  assert.deepEqual(empty.topInterests, [])

  assert.throws(() => parseActivityAnalysisResponse('not json'), /not valid JSON|Unexpected token|Activity analysis/)
})

await run('activity analysis empty short-circuit', async () => {
  const fresh = createProject({
    name: 'EmptyActivity',
    icon: 'circle',
    color: '#64748b',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    activityAnalysis: null,
    financesSummary: null,
  })
  const config = {
    type: 'openrouter',
    openrouterApiKey: 'test-key',
    customBaseUrl: '',
    customApiKey: '',
    customModel: '',
  }
  let fetchCalled = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalled += 1
    throw new Error('fetch should not be called for empty project')
  }
  try {
    const result = await generateActivitySummary(fresh.id, config, 'test-model')
    assert.equal(fetchCalled, 0)
    assert.deepEqual(result.topInterests, [])
    assert.match(result.summary, /Add activity sources/)
  } finally {
    globalThis.fetch = origFetch
  }
})

await run('dedup via contentHash', async () => {
  const filePath = path.join(fixtureDir, 'dedup-history')
  makeChromeHistory(filePath)
  const first = await ingestBrowserHistory(filePath, projectId, 'chrome')
  assert.equal(first.status, 'parsed')
  const beforeEvents = listAllBrowserEvents(projectId).filter((e) => e.url === 'https://example.com/page').length
  const second = await ingestBrowserHistory(filePath, projectId, 'chrome')
  assert.equal(second.id, first.id)
  const afterEvents = listAllBrowserEvents(projectId).filter((e) => e.url === 'https://example.com/page').length
  assert.equal(afterEvents, beforeEvents)
})

await run('getActivityEventsHash format', async () => {
  const hash = getActivityEventsHash(projectId)
  assert.match(hash, /^\d+\|.+/)
})

await run('file size caps', async () => {
  const youtubePath = path.join(fixtureDir, 'big-youtube.json')
  fs.writeFileSync(youtubePath, JSON.stringify([]))
  const origStat = fs.statSync
  fs.statSync = function (p, opts) {
    if (p === youtubePath) return { size: 60 * 1024 * 1024 }
    return origStat.call(this, p, opts)
  }
  try {
    await assert.rejects(() => ingestYouTubeHistory(youtubePath, projectId), /too large/)
  } finally {
    fs.statSync = origStat
  }

  const emailPath = path.join(fixtureDir, 'big-email.mbox')
  fs.writeFileSync(emailPath, 'From a@b.com\n\nbody\n')
  fs.statSync = function (p, opts) {
    if (p === emailPath) return { size: 20 * 1024 * 1024 }
    return origStat.call(this, p, opts)
  }
  try {
    await assert.rejects(() => ingestEmailMbox(emailPath, projectId), /too large/)
  } finally {
    fs.statSync = origStat
  }

  const locationPath = path.join(fixtureDir, 'big-location.json')
  fs.writeFileSync(locationPath, JSON.stringify({ locations: [] }))
  fs.statSync = function (p, opts) {
    if (p === locationPath) return { size: 120 * 1024 * 1024 }
    return origStat.call(this, p, opts)
  }
  try {
    await assert.rejects(() => ingestLocationHistory(locationPath, projectId), /too large/)
  } finally {
    fs.statSync = origStat
  }
})

await run('shouldUpdateActivitySummary gating', async () => {
  const fresh = createProject({
    name: 'SummaryGate',
    icon: 'clock',
    color: '#f59e0b',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    activityAnalysis: null,
    financesSummary: null,
  })
  assert.equal(shouldUpdateActivitySummary(fresh.id), true)
})

fs.rmSync(fixtureDir, { recursive: true, force: true })
closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })

console.log(`Activity tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
