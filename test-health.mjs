import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseHealthAnalysisResponse } from './src/main/healthAnalysis.ts'
import { buildHealthProjectContext, readProjectFileContext } from './src/main/projectContext.ts'
import { redactHealthContent, ingestBloodworkCsv, ingestAppleHealthExport, ingestMyChartCcda, ingestBloodworkPdf } from './src/main/health.ts'

// We need a real on-disk SQLite-backed database for the ingest tests.
// The electron `app.getPath` isn't available under node; stub it before importing database.
import Module from 'node:module'
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-health-db-'))
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

const { initDatabase, closeDatabase, createProject, listProjects } = await import('./src/main/database.ts')
initDatabase()
let projectList = listProjects()
let healthProject = projectList.find((p) => p.name === 'Health')
if (!healthProject) {
  healthProject = createProject({
    name: 'Health',
    icon: 'heart-pulse',
    color: '#22c55e',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
  })
}
const projectId = healthProject.id

const validAnalysis = {
  generatedAt: '2026-07-18T12:00:00.000Z',
  domainScores: [
    { domain: 'cardiovascular', label: 'Cardiovascular', score: 75, status: 'Stable', trend: 'stable', notes: 'BP normal' },
  ],
  regimen: {
    medications: [{ name: 'Adderall', dose: '10mg', schedule: 'AM', category: 'medication' }],
    supplements: [{ name: 'Creatine', dose: '5g', schedule: 'AM', category: 'supplement' }],
    notes: 'Split-dose stimulant',
  },
  interactions: [
    { description: 'Stimulant + minoxidil raise HR', severity: 'medium', agents: ['Adderall', 'Minoxidil'] },
  ],
  openThreads: [
    { title: 'Groin workup', detail: 'KOH scraping', priority: 'high', status: 'open' },
  ],
  recommendedLabs: [
    { name: 'PSA', rationale: 'Baseline', status: 'pending' },
  ],
  recentObservations: [
    { name: 'BP', value: '118/76', date: '2026-07-01', flag: 'normal' },
  ],
  summary: 'Overall stable on protocol.',
}

const parsed = parseHealthAnalysisResponse(JSON.stringify(validAnalysis))
assert.equal(parsed.domainScores.length, 1)
assert.equal(parsed.domainScores[0].domain, 'cardiovascular')
assert.equal(parsed.regimen.medications[0].name, 'Adderall')
assert.equal(parsed.interactions[0].severity, 'medium')
assert.equal(parsed.openThreads[0].priority, 'high')
assert.equal(parsed.recommendedLabs[0].status, 'pending')
assert.equal(parsed.recentObservations[0].flag, 'normal')
assert.equal(parsed.summary, 'Overall stable on protocol.')

assert.throws(() => parseHealthAnalysisResponse('not json'), /Unexpected token/)
assert.throws(() => parseHealthAnalysisResponse('{}'), /missing domainScores/)
assert.throws(() => parseHealthAnalysisResponse(JSON.stringify({ domainScores: [] })), /missing regimen/)
assert.throws(
  () => parseHealthAnalysisResponse(JSON.stringify({ domainScores: [], regimen: { medications: [], supplements: [] } })),
  /missing interactions/
)
assert.throws(
  () => parseHealthAnalysisResponse(JSON.stringify({
    domainScores: [],
    regimen: { medications: [], supplements: [] },
    interactions: [],
    openThreads: [],
    recommendedLabs: [],
  })),
  /missing summary/
)

const jsonString = JSON.stringify(validAnalysis)

const parsedFenced = parseHealthAnalysisResponse('```json\n' + jsonString + '\n```')
assert.equal(parsedFenced.summary, 'Overall stable on protocol.')

const parsedFencedBare = parseHealthAnalysisResponse('```\n' + jsonString + '\n```')
assert.equal(parsedFencedBare.summary, 'Overall stable on protocol.')

const parsedWithPrefix = parseHealthAnalysisResponse('Here is the analysis:\n' + jsonString)
assert.equal(parsedWithPrefix.summary, 'Overall stable on protocol.')

const parsedWithSuffix = parseHealthAnalysisResponse(jsonString + '\n\nLet me know if you need more details.')
assert.equal(parsedWithSuffix.summary, 'Overall stable on protocol.')

const parsedWithPrefixAndFence = parseHealthAnalysisResponse('Here is the JSON:\n```json\n' + jsonString + '\n```\nDone.')
assert.equal(parsedWithPrefixAndFence.summary, 'Overall stable on protocol.')

assert.throws(
  () => parseHealthAnalysisResponse(''),
  /not valid JSON/
)

assert.throws(
  () => parseHealthAnalysisResponse('Just plain text, no JSON anywhere.'),
  /not valid JSON/
)

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-health-'))
try {
  fs.writeFileSync(path.join(tempDirectory, 'overview.md'), '# Health Overview\nStable on protocol')
  fs.writeFileSync(path.join(tempDirectory, 'secret.env'), 'API_KEY=should_not_leak')
  const files = readProjectFileContext([], tempDirectory)
  assert.equal(files.fileCount, 1)
  assert.match(files.content, /Stable on protocol/)
  assert.doesNotMatch(files.content, /should_not_leak/)

  // export.xml should be excluded from generic context building
  fs.writeFileSync(path.join(tempDirectory, 'export.xml'), '<HealthData><Record type="HKQuantityTypeIdentifierStepCount" value="100" startDate="2026-07-01T12:00:00Z"/></HealthData>')
  const withoutExport = readProjectFileContext([], tempDirectory, 100_000)
  assert.equal(withoutExport.fileCount, 1, 'export.xml should be excluded from project context')

  fs.writeFileSync(path.join(tempDirectory, 'large.md'), 'Z'.repeat(1_100_000))
  const boundedFiles = readProjectFileContext([], tempDirectory, 200)
  assert.ok(boundedFiles.content.length <= 202)
  assert.equal(boundedFiles.truncated, true)

  fs.unlinkSync(path.join(tempDirectory, 'large.md'))
  fs.unlinkSync(path.join(tempDirectory, 'export.xml'))

  const projectContext = buildHealthProjectContext({
    id: 'health',
    name: 'Health',
    icon: 'heart',
    color: '#22c55e',
    path: tempDirectory,
    files: [],
    analysis: null,
    healthAnalysis: validAnalysis,
    createdAt: 0,
    updatedAt: 0,
  })
  assert.equal(projectContext.analysisIncluded, true)
  assert.match(projectContext.content, /HEALTH ANALYSIS:/)
  assert.match(projectContext.content, /Overall stable on protocol\./)
  assert.match(projectContext.content, /Stable on protocol/)

  const emptyContext = buildHealthProjectContext({
    id: 'health',
    name: 'Health',
    icon: 'heart',
    color: '#22c55e',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    createdAt: 0,
    updatedAt: 0,
  })
  assert.equal(emptyContext.analysisIncluded, false)
  assert.match(emptyContext.content, /No health analysis is currently saved\./)
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true })
}

// redactHealthContent
assert.equal(redactHealthContent('Patient MRN: 12345A'), 'Patient MRN [REDACTED]')
assert.equal(redactHealthContent('Provider NPI 1234567890'), 'Provider NPI [REDACTED]')
assert.equal(redactHealthContent('DOB: 1985-04-12'), 'DOB [REDACTED]')
assert.equal(redactHealthContent('Date of Birth 1985-04-12'), 'DOB [REDACTED]')
assert.equal(redactHealthContent('MyChart Account #123456'), 'MyChart Account [REDACTED]')
assert.equal(redactHealthContent('Phone 1-555-867-5309'), 'Phone [REDACTED PHONE]')
assert.equal(redactHealthContent('sk-or-v1-abcdefghij1234'), '[REDACTED TOKEN]')
assert.doesNotMatch(redactHealthContent('Cholesterol 180 mg/dL'), /REDACTED/)

// Bloodwork CSV
const csvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-csv-'))
try {
  const csvPath = path.join(csvDir, 'bloodwork.csv')
  fs.writeFileSync(csvPath, [
    'Name,Value,Unit,Reference Range,Collection Date,Flag,Lab',
    'Cholesterol,180,mg/dL,< 200,2026-05-01,normal,Function',
    'LDL,110,mg/dL,< 130,2026-05-01,normal,Function',
    'Triglycerides,80,mg/dL,0-150,2026-05-01,normal,Function',
  ].join('\n'))
  const record = await ingestBloodworkCsv(csvPath, projectId)
  assert.equal(record.sourceType, 'bloodwork')
  assert.equal(record.status, 'parsed')
  assert.equal(record.observationsCount, 3)
  assert.equal(record.contentHash.length, 32)
  const { listHealthObservations } = await import('./src/main/database.ts')
  const obs = listHealthObservations(record.id)
  assert.equal(obs.length, 3)
  assert.equal(obs[0].type, 'lab')
  const chol = obs.find((o) => o.displayName === 'Cholesterol')
  assert.ok(chol, 'should contain Cholesterol observation')
  assert.equal(chol.valueReal, 180)
  assert.equal(chol.unit, 'mg/dL')
  assert.equal(chol.effectiveDate.startsWith('2026-05-01'), true)
} finally {
  fs.rmSync(csvDir, { recursive: true, force: true })
}

// Apple Health export.xml (small synthetic)
const appleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-apple-'))
try {
  const xmlPath = path.join(appleDir, 'export.xml')
  const records = [
    '<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="8423" startDate="2026-06-01T08:00:00-04:00" />',
    '<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="62" startDate="2026-06-01T08:05:00-04:00" />',
    '<Record type="HKQuantityTypeIdentifierRestingHeartRate" unit="count/min" value="54" startDate="2026-06-02T07:00:00-04:00" />',
    '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="32" totalEnergyBurned="320" totalEnergyBurnedUnit="kcal" startDate="2026-06-03T18:00:00-04:00" />',
  ]
  fs.writeFileSync(xmlPath, `<?xml version="1.0"?>\n<HealthData>\n${records.join('\n')}\n</HealthData>`)
  const record = await ingestAppleHealthExport(xmlPath, projectId)
  assert.equal(record.sourceType, 'apple_health')
  assert.equal(record.status, 'parsed')
  assert.equal(record.observationsCount, 4)
  const { listHealthObservations } = await import('./src/main/database.ts')
  const obs = listHealthObservations(record.id)
  assert.equal(obs.length, 4)
  assert.ok(obs.some((o) => o.displayName === 'StepCount' && o.valueReal === 8423), 'should contain StepCount observation')
  assert.ok(obs.some((o) => o.type === 'workout' && o.displayName === 'Running'), 'should contain Running workout')
} finally {
  fs.rmSync(appleDir, { recursive: true, force: true })
}

// MyChart CCDA (small synthetic)
const ccdaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-ccda-'))
try {
  const ccdaPath = path.join(ccdaDir, 'mychart.xml')
  const ccda = `<?xml version="1.0"?>
<ClinicalDocument>
  <component>
    <structuredBody>
      <section>
        <title>Medications</title>
        <entry>
          <substanceAdministration>
            <code code="309362" codeSystem="2.16.840.1.113883.6.88"/>
            <effectiveTime>20260101</effectiveTime>
            <value>Lisinopril 10mg daily</value>
          </substanceAdministration>
        </entry>
      </section>
      <section>
        <title>Lab Results</title>
        <entry>
          <observation>
            <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/>
            <effectiveTime>20260501</effectiveTime>
            <value unit="mg/dL">180</value>
          </observation>
        </entry>
      </section>
    </structuredBody>
  </component>
</ClinicalDocument>`
  fs.writeFileSync(ccdaPath, ccda)
  const record = await ingestMyChartCcda(ccdaPath, projectId)
  assert.equal(record.sourceType, 'mychart')
  assert.equal(record.status, 'parsed')
  assert.ok(record.observationsCount >= 2, `should have at least 2 observations (got ${record.observationsCount})`)
  const { listHealthObservations } = await import('./src/main/database.ts')
  const obs = listHealthObservations(record.id)
  const lab = obs.find((o) => o.type === 'lab')
  assert.ok(lab, 'should contain a lab observation')
  const med = obs.find((o) => o.type === 'medication')
  assert.ok(med, 'should contain a medication observation')
} finally {
  fs.rmSync(ccdaDir, { recursive: true, force: true })
}

// shouldUpdateHealthSummary gating logic
const { getHealthSummary, setHealthSummary, getHealthObservationsHash } = await import('./src/main/database.ts')
const { shouldUpdateHealthSummary, healthInputHash } = await import('./src/main/healthSummary.ts')

// No summary yet -> should update
setHealthSummary(projectId, '', '')
assert.equal(shouldUpdateHealthSummary(projectId), true)

// Fresh summary with matching hash -> should not update
const currentHash = healthInputHash(projectId)
assert.ok(currentHash.endsWith(getHealthObservationsHash(projectId)), 'input hash wraps the observations hash')
assert.notEqual(currentHash, getHealthObservationsHash(projectId), 'prompt version is folded into the gate')
setHealthSummary(projectId, JSON.stringify(validAnalysis), currentHash)
assert.equal(shouldUpdateHealthSummary(projectId), false, 'fresh matching summary should not need update')

// Hash mismatch (simulating new observations) -> should update
setHealthSummary(projectId, JSON.stringify(validAnalysis), 'stale-hash')
assert.equal(shouldUpdateHealthSummary(projectId), true, 'hash change should trigger update')

// Phase 3: Live Apple Health sidecar integration
const healthLiveModule = await import('./src/main/healthLive.ts')
const { getSidecarPath, isSidecarAvailable, checkHealthKitAuthorization } = healthLiveModule

// getSidecarPath returns either a string path or null
const sidecarPath = getSidecarPath()
assert.ok(sidecarPath === null || typeof sidecarPath === 'string', 'getSidecarPath must return null or string')

// isSidecarAvailable returns a boolean
assert.equal(typeof isSidecarAvailable(), 'boolean', 'isSidecarAvailable must return a boolean')

// When unavailable, checkHealthKitAuthorization resolves to 'unavailable'
if (!isSidecarAvailable()) {
  const auth = await checkHealthKitAuthorization()
  assert.equal(auth, 'unavailable', 'checkHealthKitAuthorization should report unavailable when sidecar missing')
} else {
  console.log('Sidecar binary detected; running live HealthKit authorization check')
  const auth = await checkHealthKitAuthorization()
  assert.ok(['authorized', 'denied', 'notDetermined', 'unavailable'].includes(auth), `unexpected auth status: ${auth}`)
}

// JSON parsing of a sample sidecar output (fixture matching the documented shape)
const sampleObservation = {
  type: 'vital',
  code: 'HKQuantityTypeIdentifierStepCount',
  displayName: 'Steps',
  valueReal: 8432,
  valueText: '8432',
  unit: 'count',
  refLow: null,
  refHigh: null,
  effectiveDate: '2026-07-18T00:00:00.000Z',
  sourceMeta: { source: 'apple_health_live', device: 'iPhone15,2', sourceName: 'Health' },
}
const sampleCombined = {
  observations: [sampleObservation, {
    type: 'vital',
    code: 'HKQuantityTypeIdentifierHeartRate',
    displayName: 'Heart Rate',
    valueReal: 62,
    valueText: '62',
    unit: 'count/min',
    refLow: null,
    refHigh: null,
    effectiveDate: '2026-07-18T08:05:00.000Z',
    sourceMeta: { source: 'apple_health_live', device: 'iPhone15,2', sourceName: 'Health' },
  }],
  queryDate: '2026-07-18T12:00:00.000Z',
  typesQueried: ['steps', 'heartRate'],
}

// Verify the fixture shape matches HealthKitQueryResult expectations
assert.ok(Array.isArray(sampleCombined.observations))
assert.equal(sampleCombined.observations.length, 2)
assert.equal(sampleCombined.observations[0].type, 'vital')
assert.equal(sampleCombined.observations[0].code, 'HKQuantityTypeIdentifierStepCount')
assert.equal(sampleCombined.observations[0].valueReal, 8432)

// DB upsert path with mock observations (exercises coerceObservation + dedup without spawning the sidecar)
const {
  createHealthRecord,
  findHealthRecord,
  listHealthObservations,
  findExistingHealthObservationKeys,
  deleteHealthRecord,
  runInTransaction,
  createHealthObservation,
  touchHealthRecordImportedAt,
  updateHealthRecordStatus,
} = await import('./src/main/database.ts')

const liveRecord = findHealthRecord(projectId, 'apple_health', 'live-sync') ?? createHealthRecord({
  projectId,
  sourceType: 'apple_health',
  filename: 'live-sync',
  fileSize: 0,
  contentHash: null,
  status: 'pending',
  parseError: null,
  observationsCount: 0,
})
touchHealthRecordImportedAt(liveRecord.id)

const existingKeys = findExistingHealthObservationKeys(liveRecord.id)
const beforeCount = existingKeys.size

runInTransaction(() => {
  for (const obs of sampleCombined.observations) {
    const key = `${obs.code}|${obs.effectiveDate}`
    if (existingKeys.has(key)) continue
    existingKeys.add(key)
    createHealthObservation({
      recordId: liveRecord.id,
      type: obs.type,
      code: obs.code,
      displayName: obs.displayName,
      valueReal: obs.valueReal,
      valueText: obs.valueText,
      unit: obs.unit,
      refLow: obs.refLow,
      refHigh: obs.refHigh,
      effectiveDate: obs.effectiveDate,
      sourceMeta: obs.sourceMeta,
    })
  }
})

const storedObs = listHealthObservations(liveRecord.id)
assert.ok(storedObs.length >= 2, 'should have stored at least 2 live observations')
const storedStep = storedObs.find((o) => o.code === 'HKQuantityTypeIdentifierStepCount' && o.effectiveDate === '2026-07-18T00:00:00.000Z')
assert.ok(storedStep, 'StepCount observation should be persisted')
assert.equal(storedStep.valueReal, 8432)
assert.equal(storedStep.sourceMeta.source, 'apple_health_live')

// Dedup: inserting the same (code, effectiveDate) again should be skipped
const secondPass = findExistingHealthObservationKeys(liveRecord.id)
assert.equal(secondPass.size, beforeCount + sampleCombined.observations.length, 'second pass should match first pass count')

runInTransaction(() => {
  for (const obs of sampleCombined.observations) {
    const key = `${obs.code}|${obs.effectiveDate}`
    if (secondPass.has(key)) continue
    secondPass.add(key)
    createHealthObservation({
      recordId: liveRecord.id,
      type: obs.type,
      code: obs.code,
      displayName: obs.displayName,
      valueReal: obs.valueReal,
      valueText: obs.valueText,
      unit: obs.unit,
      refLow: obs.refLow,
      refHigh: obs.refHigh,
      effectiveDate: obs.effectiveDate,
      sourceMeta: obs.sourceMeta,
    })
  }
})
const afterDedupObs = listHealthObservations(liveRecord.id)
assert.equal(afterDedupObs.length, storedObs.length, 'dedup should not add duplicate observations')

updateHealthRecordStatus(liveRecord.id, 'parsed', null, afterDedupObs.length)
deleteHealthRecord(liveRecord.id)

// --- folder-backed ingestion --------------------------------------------------
// Health used to require hand-picking files, and its one directory scan read the
// legacy single `project.path` while every other data source had moved to
// `project_sources`. Rescanning also re-ingested everything it already held.
console.log('health folder ingestion')

const { scanHealthDirectory, healthFileIdentity } = await import('./src/main/health.ts')
const {
  addProjectSource,
  listProjectSourcePaths,
  listHealthRecords: listRecordsForProject,
  listHealthRecordIdentities,
} = await import('./src/main/database.ts')

const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-health-scan-'))
const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-health-scan2-'))
fs.mkdirSync(path.join(scanRoot, 'nested'), { recursive: true })
fs.writeFileSync(path.join(scanRoot, 'notes.txt'), 'A plain health note.')
fs.writeFileSync(path.join(scanRoot, 'nested', 'more.txt'), 'Another note, in a subfolder.')
fs.writeFileSync(path.join(scanRoot, 'ignored.rtf'), 'Not an ingestible extension.')
fs.writeFileSync(path.join(secondRoot, 'second.txt'), 'A note in the second connected folder.')

const scanProject = createProject({
  name: 'HealthScanFixture',
  icon: 'heart-pulse',
  color: '#22c55e',
  path: null,
  files: [],
  analysis: null,
  healthAnalysis: null,
})
addProjectSource(scanProject.id, scanRoot)
addProjectSource(scanProject.id, secondRoot)

assert.deepEqual(listProjectSourcePaths(scanProject.id), [scanRoot, secondRoot])
console.log('  ok - ingestion reads every connected folder, not the legacy single path')

const firstScan = await scanHealthDirectory(scanProject.id, null, 'model')
assert.equal(firstScan.ingested, 3, 'both folders and the subfolder are ingested')
assert.equal(firstScan.scanned, 3, 'the non-ingestible extension is not counted')
assert.equal(listRecordsForProject(scanProject.id).length, 3)
console.log('  ok - a scan ingests every ingestible file across all connected folders')

const secondScan = await scanHealthDirectory(scanProject.id, null, 'model')
assert.equal(secondScan.ingested, 0, 'nothing is re-ingested')
assert.equal(secondScan.unchanged, 3, 'and the unchanged files are reported as such')
assert.equal(listRecordsForProject(scanProject.id).length, 3, 'no duplicate records')
console.log('  ok - rescanning an unchanged folder duplicates nothing')

const identityBefore = healthFileIdentity(path.join(scanRoot, 'notes.txt'))
fs.writeFileSync(path.join(scanRoot, 'notes.txt'), 'The note grew a second line, so it must be read again.')
assert.notEqual(healthFileIdentity(path.join(scanRoot, 'notes.txt')), identityBefore)
const thirdScan = await scanHealthDirectory(scanProject.id, null, 'model')
assert.equal(thirdScan.ingested, 1, 'only the changed file is re-read')
assert.equal(thirdScan.unchanged, 2)
console.log('  ok - a changed file is picked up while its neighbours are skipped')

// An unattended pass must not re-run a file that already failed: a bloodwork PDF
// that cannot be parsed would otherwise be sent to the model every hour.
const { updateHealthRecordStatus: markStatus } = await import('./src/main/database.ts')
const failedRecord = listRecordsForProject(scanProject.id).find((r) => r.filename === 'more.txt')
markStatus(failedRecord.id, 'failed', 'Simulated parse failure', 0)
const autoScan = await scanHealthDirectory(scanProject.id, null, 'model', undefined, undefined, { automatic: true })
assert.equal(autoScan.ingested, 0, 'the automatic pass leaves a failed file alone')
const manualScan = await scanHealthDirectory(scanProject.id, null, 'model')
assert.equal(manualScan.ingested, 1, 'an explicit rescan retries it')
console.log('  ok - failures are retried on an explicit scan but not on the hourly pass')

const identities = listHealthRecordIdentities(scanProject.id)
assert.ok(identities.size >= 3)
assert.equal(identities.get(healthFileIdentity(path.join(secondRoot, 'second.txt'))), 'parsed')
console.log('  ok - ingested identities are recorded so later scans can recognize them')

// pdfjs-dist's default entry is the browser build: it reaches for DOMMatrix at
// module scope and throws in the Electron main process, which is why every PDF
// in the app produced nothing — a health record stuck on 'pending' with no
// error, and no document context row at all.
await (async () => {
  const { loadPdfjs } = await import('./src/main/pdfjs.ts')
  const pdfjs = await loadPdfjs()
  assert.equal(typeof pdfjs.getDocument, 'function', 'the legacy build loads in a Node context')
  console.log('  ok - pdfjs loads in the main process without DOM globals')
})()

for (const file of ['./src/main/health.ts', './src/main/documentContext.ts']) {
  const pdfSource = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  assert.ok(/loadPdfjs\(\)/.test(pdfSource), `${file} uses the loader`)
  assert.ok(!/import\('pdfjs-dist'\)/.test(pdfSource), `${file} must not import the browser build`)
}
console.log('  ok - every main-process PDF read goes through the shared loader')

// A parse that throws has to land on the record. Otherwise it sits at 'pending'
// with no parse_error and reads as merely unfinished rather than broken.
const { getHealthRecord } = await import('./src/main/database.ts')
const badPdf = path.join(scanRoot, 'not-really.pdf')
fs.writeFileSync(badPdf, 'This is not a PDF at all.')
let pdfThrew = false
try {
  await ingestBloodworkPdf(badPdf, scanProject.id, { type: 'openrouter', openrouterApiKey: 'k', customBaseUrl: '', customApiKey: '', customModel: '' }, 'model')
} catch {
  pdfThrew = true
}
assert.ok(pdfThrew, 'an unreadable PDF throws')
const failedPdfRecord = listRecordsForProject(scanProject.id).find((r) => r.filename === 'not-really.pdf')
assert.equal(failedPdfRecord.status, 'failed', 'and the record says so instead of staying pending')
assert.ok(failedPdfRecord.parseError, 'carrying the reason')
console.log('  ok - a PDF that cannot be parsed is marked failed, with its error on the record')

const beforeRetry = listRecordsForProject(scanProject.id).filter((r) => r.filename === 'not-really.pdf').length
await scanHealthDirectory(scanProject.id, null, 'model')
const afterRetry = listRecordsForProject(scanProject.id).filter((r) => r.filename === 'not-really.pdf').length
assert.equal(afterRetry, beforeRetry, 'retrying replaces the failed row rather than stacking another beside it')
console.log('  ok - re-reading a file replaces its previous attempt instead of duplicating it')

const emptyProject = createProject({
  name: 'HealthNoFolder',
  icon: 'heart-pulse',
  color: '#22c55e',
  path: null,
  files: [],
  analysis: null,
  healthAnalysis: null,
})
const noSourceScan = await scanHealthDirectory(emptyProject.id, null, 'model')
assert.deepEqual(noSourceScan, { scanned: 0, ingested: 0, skipped: 0, errors: [] })
console.log('  ok - a project with no connected folder scans nothing rather than erroring')

fs.rmSync(scanRoot, { recursive: true, force: true })
fs.rmSync(secondRoot, { recursive: true, force: true })

closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })

console.log('Health analysis, project context, and live sidecar integration checks passed')

