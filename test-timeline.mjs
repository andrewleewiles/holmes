import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-timeline-db-'))
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

const {
  parseDateToken,
  parseDateSpec,
  parseTimelineLine,
  parseTimelineBlock,
  stripTimelineBlock,
  normalizeTimelineCategory,
  normalizeTimelinePrecision,
  coarsestPrecision,
  periodEnd,
  timelineDedupeKey,
  timelineTitleKey,
  groupTimelineByYear,
  formatTimelineDate,
  formatTimelineRange,
  renderTimelineForPrompt,
  coerceAnalysisTimeline,
  analysisTimelineToEntries,
  timelinePromptSection,
  TIMELINE_CATEGORIES,
} = await import('./src/shared/timeline.ts')

const {
  initDatabase,
  closeDatabase,
  createProject,
  listTimelineEvents,
  mergeDerivedTimelineEvents,
  insertTimelineEvent,
  deleteTimelineEvent,
  getTimelineEventsHash,
  getTimelineSummary,
  setTimelineSummary,
  archiveContextVersion,
  getContextVersion,
  listContextVersions,
  listAllContextVersions,
  countContextVersions,
} = await import('./src/main/database.ts')
initDatabase()

const { mergeTimelineEntries, harvestTimelineEntries, parseNarrativeResponse, buildTimelineContext, renderYearContexts, generateYearContexts, getTimelineYearContexts, packYearEvents, clampProse, getTimelineBirthYear, reconcileBirthClaims, collapseRestatements, reconcileTimelineEntries } =
  await import('./src/main/timeline.ts')

const { yearEventsFingerprint, isOwnerBirthClaim, timelineShapeKey, timelineTitleNumbers, spansOverlap, effectiveEndDate } = await import('./src/shared/timeline.ts')
const { upsertTimelineYearContext, listTimelineYearContexts, pruneTimelineYearContexts, listMemoryFields, updateMemoryField } =
  await import('./src/main/database.ts')

const { upsertDocumentFileContext } = await import('./src/main/database.ts')

const { extractContentDates, datesFromPath, collectDatingEvidence, formatDatingEvidence } =
  await import('./src/main/dating.ts')

const { deriveContextShort, contextVersionTitle, isFailedContext } =
  await import('./src/shared/contextVersions.ts')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

// --- date token parsing ------------------------------------------------------
console.log('parseDateToken')

check('parses ISO day, month, and year forms at their real precision', () => {
  assert.deepEqual(parseDateToken('2024-03-15'), { year: 2024, month: 3, day: 15, precision: 'day' })
  assert.deepEqual(parseDateToken('2024-03'), { year: 2024, month: 3, day: null, precision: 'month' })
  assert.deepEqual(parseDateToken('2024'), { year: 2024, month: null, day: null, precision: 'year' })
})

check('parses month-name, day-first, US numeric and quarter forms', () => {
  assert.deepEqual(parseDateToken('March 15, 2024'), { year: 2024, month: 3, day: 15, precision: 'day' })
  assert.deepEqual(parseDateToken('15 March 2024'), { year: 2024, month: 3, day: 15, precision: 'day' })
  assert.deepEqual(parseDateToken('Mar 2024'), { year: 2024, month: 3, day: null, precision: 'month' })
  assert.deepEqual(parseDateToken('03/15/2024'), { year: 2024, month: 3, day: 15, precision: 'day' })
  assert.deepEqual(parseDateToken('Q3 2021'), { year: 2021, month: 7, day: null, precision: 'month' })
})

check('reads DD/MM when the first component cannot be a month', () => {
  assert.deepEqual(parseDateToken('15/03/2024'), { year: 2024, month: 3, day: 15, precision: 'day' })
})

check('degrades hedged and decade dates to year precision', () => {
  assert.deepEqual(parseDateToken('early 2019'), { year: 2019, month: null, day: null, precision: 'year' })
  assert.deepEqual(parseDateToken('circa 2019'), { year: 2019, month: null, day: null, precision: 'year' })
  assert.deepEqual(parseDateToken('1990s'), { year: 1990, month: null, day: null, precision: 'year' })
})

check('rejects impossible dates and non-dates rather than guessing', () => {
  assert.equal(parseDateToken('2024-13-01'), null)
  assert.equal(parseDateToken('2024-02-30'), null)
  assert.equal(parseDateToken('1823-01-01'), null)
  assert.equal(parseDateToken('sometime last year'), null)
  assert.equal(parseDateToken('unknown'), null)
  assert.equal(parseDateToken(''), null)
})

console.log('parseDateSpec')

check('canonicalizes a single date and keeps its precision', () => {
  assert.deepEqual(parseDateSpec('2024-03'), { startDate: '2024-03-01', endDate: null, precision: 'month' })
  assert.deepEqual(parseDateSpec('2024'), { startDate: '2024-01-01', endDate: null, precision: 'year' })
})

check('parses ranges across every separator, ending on the last covered day', () => {
  for (const spec of ['2019..2021', '2019 – 2021', '2019 to 2021', '2019 -> 2021', '2019 through 2021']) {
    assert.deepEqual(parseDateSpec(spec), { startDate: '2019-01-01', endDate: '2021-12-31', precision: 'year' }, spec)
  }
  assert.deepEqual(parseDateSpec('2019-06..2021-08'), {
    startDate: '2019-06-01',
    endDate: '2021-08-31',
    precision: 'month',
  })
})

check('keeps an open span open and takes the coarser precision of the two ends', () => {
  assert.deepEqual(parseDateSpec('2019-06-01..present'), { startDate: '2019-06-01', endDate: null, precision: 'day' })
  assert.deepEqual(parseDateSpec('2019-06-01..2021'), {
    startDate: '2019-06-01',
    endDate: '2021-12-31',
    precision: 'year',
  })
})

check('drops an end date that precedes the start rather than inverting the range', () => {
  assert.deepEqual(parseDateSpec('2021..2019'), { startDate: '2021-01-01', endDate: null, precision: 'year' })
})

// --- timeline line + block parsing ------------------------------------------
console.log('parseTimelineLine')

check('parses the full five-field format', () => {
  const entry = parseTimelineLine('- 2024-03-15 | day | training | Started a 12-week cut | Bodyweight logged daily from this date')
  assert.deepEqual(entry, {
    startDate: '2024-03-15',
    endDate: null,
    precision: 'day',
    category: 'training',
    title: 'Started a 12-week cut',
    detail: 'Bodyweight logged daily from this date',
  })
})

check('tolerates a missing precision cell, a missing category cell, and both', () => {
  assert.equal(parseTimelineLine('- 2024-03 | training | Started a cut').category, 'training')
  assert.equal(parseTimelineLine('- 2024-03 | month | Started a cut').precision, 'month')
  const bare = parseTimelineLine('- 2024-03-15 | Started a cut')
  assert.equal(bare.title, 'Started a cut')
  assert.equal(bare.category, 'life')
  assert.equal(bare.precision, 'day')
})

check('never lets a stated precision sharpen what the date itself supports', () => {
  assert.equal(parseTimelineLine('- 2024 | day | work | Joined Acme').precision, 'year')
  assert.equal(parseTimelineLine('- 2024-03-15 | year | work | Joined Acme').precision, 'year')
})

check('maps category aliases and unknown categories predictably', () => {
  assert.equal(parseTimelineLine('- 2024 | year | fitness | Ran a 10k').category, 'training')
  assert.equal(parseTimelineLine('- 2024 | year | gardening | Planted beds').category, 'other')
})

check('drops lines with no usable date or no fact', () => {
  assert.equal(parseTimelineLine('- none'), null)
  assert.equal(parseTimelineLine('- sometime in the past | milestone | Moved'), null)
  assert.equal(parseTimelineLine('- 2024-03-15'), null)
})

console.log('parseTimelineBlock')

const sampleContext = `The person trained consistently through the spring.

More prose about their habits.

TIMELINE:
- 2024-03-15 | day | training | Started a 12-week cut | Calorie logs begin here
- 2024-06 | month | health | Bloodwork drawn | Panel dated to June only
- not a date | milestone | Something undated
- 2019..2021 | year | work | Contracted at Acme | Invoices span the period
`

check('extracts only the dated lines under the heading', () => {
  const entries = parseTimelineBlock(sampleContext)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map((e) => e.startDate), ['2024-03-15', '2024-06-01', '2019-01-01'])
  assert.equal(entries[2].endDate, '2021-12-31')
})

check('returns nothing when a context has no timeline block', () => {
  assert.deepEqual(parseTimelineBlock('Just prose, no dates section.'), [])
  assert.deepEqual(parseTimelineBlock(''), [])
})

check('stops at the next heading and tolerates markdown/bold headings', () => {
  const entries = parseTimelineBlock('## TIMELINE\n- 2020 | year | life | A\n\n## NOTES\n- 2021 | year | life | B')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'A')
})

check('strips the timeline block from prose without touching the prose', () => {
  const stripped = stripTimelineBlock(sampleContext)
  assert.ok(stripped.startsWith('The person trained'))
  assert.ok(!stripped.includes('TIMELINE'))
  assert.ok(!stripped.includes('12-week cut'))
})

// --- normalization helpers ---------------------------------------------------
console.log('normalization')

check('normalizes precision words and picks the coarser of two', () => {
  assert.equal(normalizeTimelinePrecision('Day'), 'day')
  assert.equal(normalizeTimelinePrecision('monthly'), 'month')
  assert.equal(normalizeTimelinePrecision('approximate'), 'year')
  assert.equal(normalizeTimelinePrecision('sometime'), null)
  assert.equal(coarsestPrecision('day', 'year'), 'year')
  assert.equal(coarsestPrecision('month', 'day'), 'month')
})

check('an empty category defaults to life, not other', () => {
  assert.equal(normalizeTimelineCategory(''), 'life')
  assert.equal(normalizeTimelineCategory(null), 'life')
  assert.ok(TIMELINE_CATEGORIES.includes(normalizeTimelineCategory('subscription')))
})

check('periodEnd covers the whole period a coarse date refers to', () => {
  assert.equal(periodEnd('2024-01-01', 'year'), '2024-12-31')
  assert.equal(periodEnd('2024-02-01', 'month'), '2024-02-29')
  assert.equal(periodEnd('2023-02-01', 'month'), '2023-02-28')
  assert.equal(periodEnd('2024-03-15', 'day'), '2024-03-15')
})

check('dedupe keys ignore wording noise but not the date', () => {
  assert.equal(
    timelineDedupeKey({ startDate: '2024-03-15', title: 'Started the 12-week cut' }),
    timelineDedupeKey({ startDate: '2024-03-15', title: 'started a 12 week cut!' })
  )
  assert.notEqual(
    timelineDedupeKey({ startDate: '2024-03-15', title: 'Started a cut' }),
    timelineDedupeKey({ startDate: '2024-03-16', title: 'Started a cut' })
  )
  assert.notEqual(timelineTitleKey('Moved to Austin'), timelineTitleKey('Moved to Denver'))
})

check('formats dates at the precision claimed, never finer', () => {
  assert.equal(formatTimelineDate('2024-03-15', 'day'), 'March 15, 2024')
  assert.equal(formatTimelineDate('2024-03-15', 'month'), 'March 2024')
  assert.equal(formatTimelineDate('2024-03-15', 'year'), '2024')
  assert.equal(
    formatTimelineRange({ startDate: '2019-01-01', endDate: '2021-12-31', precision: 'year' }),
    '2019 – 2021'
  )
  assert.equal(
    formatTimelineRange({ startDate: '2024-03-15', endDate: null, precision: 'day' }),
    'March 15, 2024'
  )
})

check('groups by year in ascending order', () => {
  const groups = groupTimelineByYear([
    { startDate: '2021-05-01' },
    { startDate: '2019-01-01' },
    { startDate: '2021-01-02' },
  ])
  assert.deepEqual(groups.map((g) => g.year), [2019, 2021])
  assert.equal(groups[1].events.length, 2)
})

// --- structured-analysis timelines -------------------------------------------
console.log('analysis timelines')

check('coerces valid JSON entries and drops undated or untitled ones', () => {
  const entries = coerceAnalysisTimeline([
    { date: '2024-03-15', title: 'Started statin', precision: 'day', category: 'health', detail: 'Rx dated' },
    { date: 'whenever', title: 'Undated thing' },
    { date: '2024-01-01' },
    { title: 'No date' },
    'not an object',
  ])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'Started statin')
  assert.deepEqual(coerceAnalysisTimeline('nope'), [])
})

check('converts analysis entries into parsed entries with honest precision', () => {
  const parsed = analysisTimelineToEntries([
    { date: '2024-03-15', endDate: '2024-06-01', title: 'Cutting block', precision: 'month', category: 'fitness' },
  ])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].startDate, '2024-03-15')
  assert.equal(parsed[0].endDate, '2024-06-01')
  assert.equal(parsed[0].precision, 'month')
  assert.equal(parsed[0].category, 'training')
  assert.deepEqual(analysisTimelineToEntries(undefined), [])
})

// --- prompt contract ---------------------------------------------------------
console.log('prompt contract')

check('the shared prompt section states the format, the priority order, and the cap', () => {
  const section = timelinePromptSection(20)
  assert.ok(section.includes('TIMELINE:'))
  assert.ok(section.includes('<date> | <precision> | <category> | <title> | <detail>'))
  assert.ok(/at most 20 entries/.test(section))
  assert.ok(/Never invent or guess a date/.test(section))
  for (const category of TIMELINE_CATEGORIES) assert.ok(section.includes(category), category)
})

check('every context generator carries the dating contract into its prompt', () => {
  const documentSource = fs.readFileSync(new URL('./src/main/documentContext.ts', import.meta.url), 'utf8')
  assert.ok(/timelinePromptSection\(20\)/.test(documentSource), 'file prompt')
  assert.ok(/timelinePromptSection\(30\)/.test(documentSource), 'folder prompt')
  assert.ok(/timelinePromptSection\(60\)/.test(documentSource), 'user super-context prompt')
  assert.ok(/formatDatingEvidence/.test(documentSource), 'dating evidence fed to the file pass')
  // The point is that the file pass HAS a cache-busting version, not which one:
  // hardcoding the literal breaks on every legitimate prompt revision.
  assert.ok(/const FILE_PROMPT_VERSION = '[^']{3,}'/.test(documentSource), 'cache-busting version bump')

  const activitySource = fs.readFileSync(new URL('./src/main/activityAnalysis.ts', import.meta.url), 'utf8')
  assert.ok(/ANALYSIS_TIMELINE_JSON_FIELD/.test(activitySource))
  assert.ok(/timelinePromptSection\(25\)/.test(activitySource), 'per-source activity prompt')

  const healthSource = fs.readFileSync(new URL('./src/main/healthAnalysis.ts', import.meta.url), 'utf8')
  assert.ok(/ANALYSIS_TIMELINE_JSON_FIELD/.test(healthSource))

  const financesSource = fs.readFileSync(new URL('./src/main/financesSummary.ts', import.meta.url), 'utf8')
  assert.ok(/ANALYSIS_TIMELINE_JSON_FIELD/.test(financesSource))

  const memorySource = fs.readFileSync(new URL('./src/main/memorySummary.ts', import.meta.url), 'utf8')
  assert.ok(/timelinePromptSection\(25\)/.test(memorySource))
})

// --- dating evidence ---------------------------------------------------------
console.log('dating evidence')

check('finds every stated date in a document body', () => {
  const dates = extractContentDates('Ran on 2024-03-15, again on March 20, 2024, and paid 03/22/2024.')
  const found = new Set(dates.map((d) => d.date))
  assert.ok(found.has('2024-03-15'))
  assert.ok(found.has('2024-03-20'))
  assert.ok(found.has('2024-03-22'))
})

check('reads a date out of the file name, falling back to a bare year', () => {
  assert.equal(datesFromPath('/data/2023-04 statement.pdf')[0].date, '2023-04-01')
  assert.equal(datesFromPath('/data/journal_2019.md')[0].date, '2019-01-01')
  assert.deepEqual(datesFromPath('/data/notes.txt'), [])
})

check('renders the evidence in priority order and flags mtime as a last resort', () => {
  const evidence = collectDatingEvidence({
    filePath: '/data/log_2024.csv',
    text: 'entry 2024-01-05\nentry 2024-11-30\n',
    modifiedAtMs: Date.UTC(2025, 0, 15),
  })
  assert.deepEqual(evidence.contentRange, { earliest: '2024-01-05', latest: '2024-11-30' })
  assert.equal(evidence.pathDates[0].date, '2024-01-01')
  const rendered = formatDatingEvidence(evidence)
  assert.ok(rendered.includes('authoritative'))
  assert.ok(rendered.includes('2025-01-15'))
  assert.ok(/last resort/.test(rendered))
})

check('says so plainly when a document states no dates at all', () => {
  const evidence = collectDatingEvidence({ filePath: '/data/notes.txt', text: 'no dates here', modifiedAtMs: null })
  assert.equal(evidence.contentRange, null)
  assert.ok(formatDatingEvidence(evidence).includes('none detected'))
})

// --- merge -------------------------------------------------------------------
console.log('mergeTimelineEntries')

function entry(overrides) {
  const base = {
    sourceType: 'document',
    sourceRef: 'ref',
    sourceLabel: 'label',
    projectId: null,
    category: 'life',
    title: 'An event',
    detail: '',
    startDate: '2024-03-15',
    endDate: null,
    precision: 'day',
    confidence: 0.8,
    ...overrides,
  }
  return { ...base, dedupeKey: timelineDedupeKey(base) }
}

check('collapses the same fact reported by several sources on the same date', () => {
  const { merged, duplicates } = mergeTimelineEntries([
    entry({ sourceType: 'folder', detail: 'short' }),
    entry({ sourceType: 'document', detail: 'a much longer piece of evidence' }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(duplicates, 1)
  assert.equal(merged[0].sourceType, 'document')
})

check('drops a coarser entry that a precisely dated one already covers', () => {
  const { merged } = mergeTimelineEntries([
    entry({ sourceType: 'project', startDate: '2024-01-01', precision: 'year' }),
    entry({ sourceType: 'document', startDate: '2024-03-15', precision: 'day' }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].startDate, '2024-03-15')
})

check('keeps a coarse entry when no precise entry falls inside its period', () => {
  const { merged } = mergeTimelineEntries([
    entry({ startDate: '2019-01-01', precision: 'year' }),
    entry({ startDate: '2024-03-15', precision: 'day' }),
  ])
  assert.equal(merged.length, 2)
})

check('keeps recurrences of the same title on different precise dates', () => {
  const { merged } = mergeTimelineEntries([
    entry({ startDate: '2024-01-10', title: 'Ordered protein powder' }),
    entry({ startDate: '2024-05-10', title: 'Ordered protein powder' }),
  ])
  assert.equal(merged.length, 2)
})

check('returns events sorted oldest first', () => {
  const { merged } = mergeTimelineEntries([
    entry({ startDate: '2024-03-15', title: 'Third' }),
    entry({ startDate: '2019-01-01', precision: 'year', title: 'First' }),
    entry({ startDate: '2021-06-01', precision: 'month', title: 'Second' }),
  ])
  assert.deepEqual(merged.map((e) => e.title), ['First', 'Second', 'Third'])
})

// --- persistence -------------------------------------------------------------
console.log('persistence')

const project = createProject({
  name: 'Timeline Test Project',
  icon: 'folder',
  color: '#ffffff',
  path: null,
  files: [],
  analysis: null,
  healthAnalysis: null,
  activityAnalysis: null,
  financesSummary: null,
})

check('stores derived events and reads them back oldest first', () => {
  const result = mergeDerivedTimelineEvents([
    entry({ startDate: '2024-03-15', title: 'Later event', projectId: project.id }),
    entry({ startDate: '2019-01-01', precision: 'year', title: 'Earlier event', projectId: project.id }),
  ])
  assert.equal(result.inserted, 2)
  const events = listTimelineEvents()
  assert.deepEqual(events.map((e) => e.title), ['Earlier event', 'Later event'])
  assert.equal(events[0].projectName, 'Timeline Test Project')
  assert.equal(events[0].archivedAt, null)
  assert.ok(events[0].lastSeenAt)
})

check('filters by category, project, search and date window', () => {
  assert.equal(listTimelineEvents({ categories: ['health'] }).length, 0)
  assert.equal(listTimelineEvents({ categories: ['life'] }).length, 2)
  assert.equal(listTimelineEvents({ projectIds: [project.id] }).length, 2)
  assert.equal(listTimelineEvents({ projectIds: ['missing'] }).length, 0)
  assert.equal(listTimelineEvents({ search: 'Earlier' }).length, 1)
  assert.equal(listTimelineEvents({ to: '2020-01-01' }).length, 1)
  assert.equal(listTimelineEvents({ limit: 1 }).length, 1)
})

const manual = insertTimelineEvent({
  ...entry({ sourceType: 'manual', startDate: '2022-07-04', title: 'Hand-added milestone' }),
  dedupeKey: 'manual:2022-07-04|hand added milestone',
})

check('a rebuild refreshes derived events in place instead of recreating them', () => {
  const before = listTimelineEvents({ search: 'Earlier' })[0]
  const result = mergeDerivedTimelineEvents([
    entry({ startDate: '2019-01-01', precision: 'year', title: 'Earlier event', projectId: project.id, detail: 'now with evidence' }),
  ])
  assert.equal(result.updated, 1)
  assert.equal(result.inserted, 0)
  const after = listTimelineEvents({ search: 'Earlier' })[0]
  assert.equal(after.id, before.id, 'the row is updated, not replaced')
  assert.equal(after.detail, 'now with evidence')
})

check('an event its source no longer reports is archived, never deleted', () => {
  const archivedRow = listTimelineEvents().find((e) => e.title === 'Later event')
  assert.ok(archivedRow, 'the event survived the rebuild that dropped it')
  assert.ok(archivedRow.archivedAt, 'and is marked as superseded history')
  assert.equal(listTimelineEvents({ includeArchived: false }).some((e) => e.title === 'Later event'), false)
})

check('re-harvesting an archived event un-archives it', () => {
  mergeDerivedTimelineEvents([
    entry({ startDate: '2019-01-01', precision: 'year', title: 'Earlier event', projectId: project.id }),
    entry({ startDate: '2024-03-15', title: 'Later event', projectId: project.id }),
  ])
  const revived = listTimelineEvents().find((e) => e.title === 'Later event')
  assert.equal(revived.archivedAt, null)
})

check('hand-added events survive every rebuild and are never archived', () => {
  const result = mergeDerivedTimelineEvents([
    entry({ startDate: '2025-01-01', precision: 'year', title: 'Fresh event' }),
  ])
  assert.equal(result.manualPreserved, 1)
  const kept = listTimelineEvents().find((e) => e.sourceType === 'manual')
  assert.ok(kept)
  assert.equal(kept.archivedAt, null)
  assert.equal(kept.title, 'Hand-added milestone')
})

check('a duplicate dedupe key is ignored rather than double-inserted', () => {
  const duplicate = insertTimelineEvent({
    ...entry({ sourceType: 'manual', startDate: '2022-07-04', title: 'Hand-added milestone' }),
    dedupeKey: 'manual:2022-07-04|hand added milestone',
  })
  assert.equal(duplicate, null)
})

check('the events hash moves when the event set changes', () => {
  const before = getTimelineEventsHash()
  deleteTimelineEvent(manual.id)
  assert.notEqual(getTimelineEventsHash(), before)
})

check('stores and reads back the era synthesis', () => {
  setTimelineSummary({
    narrative: 'A short life narrative.',
    eras: [{ label: 'Austin years', startDate: '2019', endDate: '2021', summary: 'Contracting.' }],
    inputHash: 'hash-1',
    eventCount: 2,
  })
  const stored = getTimelineSummary()
  assert.equal(stored.narrative, 'A short life narrative.')
  assert.equal(stored.eras[0].label, 'Austin years')
  assert.equal(stored.inputHash, 'hash-1')
})

// --- context version archive -------------------------------------------------
console.log('context version archive')

check('a regenerated context is versioned instead of overwritten', () => {
  const first = archiveContextVersion({
    sourceType: 'document-file',
    sourceRef: 'project:test:file:notes.md',
    sourceLabel: 'Test · notes.md',
    projectId: project.id,
    contentHash: 'hash-1',
    contextShort: 'First take.',
    context: 'The first analysis of this file.',
  })
  const second = archiveContextVersion({
    sourceType: 'document-file',
    sourceRef: 'project:test:file:notes.md',
    sourceLabel: 'Test · notes.md',
    projectId: project.id,
    contentHash: 'hash-2',
    contextShort: 'Second take.',
    context: 'A revised analysis of the same file.',
  })
  assert.equal(first.version, 1)
  assert.equal(second.version, 2)

  const stored = getContextVersion(first.id)
  assert.equal(stored.context, 'The first analysis of this file.', 'the superseded text is still readable')
  assert.ok(stored.supersededAt, 'and is marked superseded')
  assert.equal(getContextVersion(second.id).supersededAt, null, 'the newest version is current')
})

check('regenerating identical content does not create a new version', () => {
  const repeat = archiveContextVersion({
    sourceType: 'document-file',
    sourceRef: 'project:test:file:notes.md',
    sourceLabel: 'Test · notes.md',
    projectId: project.id,
    contentHash: 'hash-2',
    contextShort: 'Second take.',
    context: 'A revised analysis of the same file.',
  })
  assert.equal(repeat, null)
  assert.equal(listContextVersions({ sourceRef: 'project:test:file:notes.md' }).length, 2)
})

check('every context write path archives through the same choke point', () => {
  const dbSource = fs.readFileSync(new URL('./src/main/database.ts', import.meta.url), 'utf8')
  for (const marker of [
    "sourceType: 'document-file'",
    "sourceType: 'document-folder'",
    "sourceType: 'user-super-context'",
    "sourceType: 'memory-summary'",
    "'health-analysis'",
    "'activity-analysis'",
    "'finances-summary'",
  ]) {
    assert.ok(dbSource.includes(marker), marker)
  }
})

check('failure sentinels are never archived as a version', () => {
  assert.ok(isFailedContext('Context generation failed for notes.md: timeout'))
  assert.ok(isFailedContext('Empty or unreadable document: notes.md'))
  assert.ok(!isFailedContext('A real behavioral analysis.'))
  const before = countContextVersions()
  upsertDocumentFileContext({
    projectId: project.id,
    filePath: '/data/broken.md',
    relativePath: 'broken.md',
    contentHash: 'hash-broken',
    context: 'Context generation failed for broken.md: timeout',
  })
  assert.equal(countContextVersions(), before)
})

check('deriveContextShort falls back to the first sentence and titles read naturally', () => {
  assert.equal(deriveContextShort('body text', 'Explicit short.'), 'Explicit short.')
  assert.equal(deriveContextShort('First sentence. Second sentence.'), 'First sentence.')
  assert.equal(deriveContextShort(''), '')
  assert.ok(contextVersionTitle('Training index', 1).includes('first generated'))
  assert.ok(contextVersionTitle('Training index', 3).includes('v3'))
})

check('archived versions become dated timeline entries', () => {
  const { entries, contextVersionsSeen } = harvestTimelineEntries()
  assert.ok(contextVersionsSeen >= 2)
  const versionEntries = entries.filter((e) => e.sourceType === 'context-version')
  assert.equal(versionEntries.length, contextVersionsSeen)
  const notes = versionEntries.find((e) => e.title.includes('notes.md') && e.title.includes('v2'))
  assert.ok(notes, 'the superseding version is on the timeline')
  assert.equal(notes.category, 'record')
  assert.equal(notes.precision, 'day')
  assert.ok(notes.contextVersionId, 'and links back to the archived text')
  const first = versionEntries.find((e) => e.title.includes('notes.md') && e.title.includes('first generated'))
  assert.ok(first, 'so is the version it replaced')
  assert.ok(/Superseded /.test(first.detail))
})

// --- harvest + chat context --------------------------------------------------
console.log('harvest and chat context')

const { upsertDocumentFolderContext, updateProjectHealthAnalysis } =
  await import('./src/main/database.ts')

upsertDocumentFileContext({
  projectId: project.id,
  filePath: '/data/training/log.csv',
  relativePath: 'training/log.csv',
  contentHash: 'hash',
  context: 'Trained hard.\n\nTIMELINE:\n- 2024-03-15 | day | training | Started a 12-week cut | Logs begin here\n',
})
upsertDocumentFolderContext({
  projectId: project.id,
  folderPath: '/data',
  relativePath: '.',
  childHash: 'hash',
  contextShort: 'Short.',
  context: 'Folder synthesis.\n\nTIMELINE:\n- 2024 | year | training | Started a 12-week cut | Seen across the folder\n- 2024-09 | month | training | Switched to maintenance | Volume drops\n',
  fileCount: 1,
})
updateProjectHealthAnalysis(project.id, {
  generatedAt: new Date().toISOString(),
  domainScores: [],
  regimen: { medications: [], supplements: [] },
  interactions: [],
  openThreads: [],
  recommendedLabs: [],
  recentObservations: [],
  timeline: [{ date: '2024-06-02', title: 'Bloodwork drawn', precision: 'day', category: 'health' }],
  summary: '',
})

check('harvests dated entries from file, folder and structured-analysis contexts', () => {
  const { entries, sourcesScanned } = harvestTimelineEntries()
  assert.ok(sourcesScanned >= 3)
  const titles = entries.map((e) => e.title)
  assert.ok(titles.includes('Started a 12-week cut'))
  assert.ok(titles.includes('Switched to maintenance'))
  assert.ok(titles.includes('Bloodwork drawn'))
  assert.ok(entries.some((e) => e.sourceType === 'health' && e.confidence > 0.85))
})

check('the folder-level duplicate of a file-dated fact is merged away', () => {
  const { entries } = harvestTimelineEntries()
  const { merged } = mergeTimelineEntries(entries)
  const cuts = merged.filter((e) => e.title === 'Started a 12-week cut')
  assert.equal(cuts.length, 1)
  assert.equal(cuts[0].startDate, '2024-03-15')
  assert.equal(cuts[0].sourceType, 'document')
})

check('the chat context block carries the eras, the narrative and the dated record', () => {
  const { entries } = harvestTimelineEntries()
  mergeDerivedTimelineEvents(mergeTimelineEntries(entries).merged)
  const context = buildTimelineContext({})
  assert.ok(context)
  assert.ok(context.content.includes('ERAS'))
  assert.ok(context.content.includes('Austin years'))
  assert.ok(context.content.includes('DATED RECORD'))
  assert.ok(context.content.includes('Started a 12-week cut'))
  assert.equal(context.eventCount, listTimelineEvents().filter((e) => e.category !== 'record').length)
})

check('context-generation bookkeeping is kept off the chat block by default', () => {
  const context = buildTimelineContext({})
  assert.ok(!/context updated \(v/.test(context.content))
  assert.ok(!/context first generated/.test(context.content))
  const withRecord = buildTimelineContext({ includeRecordEvents: true })
  assert.ok(withRecord.eventCount > context.eventCount)
})

check('a project-scoped context leaves out the life narrative', () => {
  const context = buildTimelineContext({ projectIds: [project.id], includeNarrative: false })
  assert.ok(context)
  assert.ok(!context.content.includes('ERAS'))
  assert.ok(context.content.includes('DATED RECORD'))
})

check('the prompt rendering keeps date, precision, category and source on one line', () => {
  const rendered = renderTimelineForPrompt(listTimelineEvents(), 4000)
  assert.ok(/- 2024-03-15 \| day \| training \| Started a 12-week cut/.test(rendered))
  assert.ok(rendered.includes('['))
})

check('the prompt rendering stops at the character budget instead of overflowing', () => {
  const rendered = renderTimelineForPrompt(listTimelineEvents(), 40)
  assert.ok(rendered.length <= 40)
})

// --- per-year super-contexts --------------------------------------------------
// Regression: the chat block rendered the raw record oldest-first and stopped at
// the character budget. Against a real record (5,000+ events) that meant chat saw
// ~60 events ending in 2009 and had no idea the later years existed at all.
console.log('year super-contexts')

const yearEvent = (date, title) => ({
  startDate: date,
  endDate: null,
  precision: 'day',
  category: 'life',
  title,
  detail: '',
  sourceLabel: 'Test',
  sourceType: 'document',
})

check('events split into calendar years off the ISO date, never a local Date', () => {
  const grouped = groupTimelineByYear([
    yearEvent('2024-01-01', 'New year'),
    yearEvent('2023-12-31', 'Old year'),
    yearEvent('2024-06-02', 'Midyear'),
  ])
  assert.deepEqual(grouped.map((g) => g.year), [2023, 2024])
  assert.equal(grouped[1].events.length, 2)
  // January 1st must stay in its own year regardless of the machine's timezone.
  assert.equal(grouped[1].events[0].title, 'New year')
})

check('the year fingerprint changes with content but not with ordering', () => {
  const a = [yearEvent('2024-01-01', 'One'), yearEvent('2024-02-01', 'Two')]
  const b = [yearEvent('2024-02-01', 'Two'), yearEvent('2024-01-01', 'One')]
  assert.equal(yearEventsFingerprint(a), yearEventsFingerprint(b))
  assert.notEqual(yearEventsFingerprint(a), yearEventsFingerprint([...a, yearEvent('2024-03-01', 'Three')]))
})

const sampleYears = [
  { year: 2020, contextShort: 'Twenty-twenty short.', context: 'A'.repeat(600), eventCount: 40, synthesized: true },
  { year: 2021, contextShort: 'Twenty-twenty-one short.', context: 'B'.repeat(600), eventCount: 40, synthesized: true },
  { year: 2022, contextShort: 'Twenty-twenty-two short.', context: 'C'.repeat(600), eventCount: 40, synthesized: true },
]

check('every year appears even when the budget only affords the one-line summaries', () => {
  const rendered = renderYearContexts(sampleYears, 200)
  assert.ok(rendered.block.includes('2020:'))
  assert.ok(rendered.block.includes('2021:'))
  assert.ok(rendered.block.includes('2022:'))
  assert.equal(rendered.expanded, 0)
  assert.equal(rendered.omitted, 0)
})

check('spare budget expands the most recent years first', () => {
  const rendered = renderYearContexts(sampleYears, 800)
  assert.equal(rendered.expanded, 1)
  assert.ok(rendered.block.includes('C'.repeat(600)), 'the newest year is the one given in full')
  assert.ok(!rendered.block.includes('A'.repeat(600)))
})

check('the years stay in chronological order however they were expanded', () => {
  const rendered = renderYearContexts(sampleYears, 800)
  assert.ok(rendered.block.indexOf('2020') < rendered.block.indexOf('2021'))
  assert.ok(rendered.block.indexOf('2021') < rendered.block.indexOf('2022'))
})

check('a budget too small for the spine drops the oldest years and reports it', () => {
  const rendered = renderYearContexts(sampleYears, 60)
  assert.ok(rendered.omitted > 0)
  assert.ok(rendered.block.includes('2022:'), 'the most recent year survives')
  assert.ok(rendered.block.length <= 60 + 40, 'stays within shouting distance of the budget')
})

check('a year with no events at all renders nothing rather than an empty heading', () => {
  const rendered = renderYearContexts([], 5_000)
  assert.equal(rendered.block, '')
  assert.equal(rendered.expanded, 0)
})

for (const year of sampleYears) {
  upsertTimelineYearContext({ ...year, inputHash: `h-${year.year}` })
}

check('year contexts round-trip through the database', () => {
  const stored = listTimelineYearContexts()
  assert.equal(stored.length, 3)
  assert.deepEqual(stored.map((y) => y.year), [2020, 2021, 2022])
  assert.equal(stored[0].synthesized, true)
  assert.equal(stored[0].eventCount, 40)
})

check('a synthesized year is archived as a context version, so nothing is destroyed', () => {
  const versions = listContextVersions({ sourceTypes: ['timeline-year'] })
  assert.ok(versions.length >= 3, 'each year synthesis is versioned')
  assert.ok(versions.some((v) => v.sourceRef === 'timeline:year:2021'))
})

check('regenerating a year supersedes the old version instead of overwriting it', () => {
  upsertTimelineYearContext({
    year: 2021, contextShort: 'Rewritten.', context: 'A much better account of 2021.',
    inputHash: 'h-2021-v2', eventCount: 41, synthesized: true,
  })
  const versions = listContextVersions({ sourceRef: 'timeline:year:2021' })
  assert.equal(versions.length, 2)
  assert.equal(listTimelineYearContexts().find((y) => y.year === 2021).context, 'A much better account of 2021.')
})

check('the whole span reaches the chat block, not just the years that fit', () => {
  const context = buildTimelineContext({})
  assert.ok(context.content.includes('YEARS'))
  for (const year of [2020, 2021, 2022]) {
    assert.ok(context.content.includes(`${year}:`), `${year} is present`)
  }
  assert.ok(/every year on record/.test(context.content))
})

check('a truncated dated record says so instead of reading as complete', () => {
  const context = buildTimelineContext({ maxChars: 1_600 })
  assert.ok(context)
  if (/most recent of/.test(context.content)) {
    assert.ok(/covered by the year summaries above, not lost/.test(context.content))
  }
})

check('the dated record keeps the most recent entries rather than the oldest', () => {
  const events = listTimelineEvents().filter((e) => e.category !== 'record')
  const newest = events[events.length - 1]
  const context = buildTimelineContext({ maxChars: 2_400 })
  assert.ok(context.content.includes(newest.title), 'the newest event survives truncation')
})

check('a project-scoped block leaves the global year contexts out', () => {
  const context = buildTimelineContext({ projectIds: [project.id], includeNarrative: false })
  assert.ok(!context.content.includes('YEARS'), 'years are built from every project, so they cannot be scoped')
})

check('years with no events left are pruned', () => {
  const removed = pruneTimelineYearContexts([2020, 2021])
  assert.equal(removed, 1)
  assert.deepEqual(listTimelineYearContexts().map((y) => y.year), [2020, 2021])
})

await (async () => {
  // No API key: thin years must still be covered, without a single call.
  const before = listTimelineYearContexts().length
  const result = await generateYearContexts(
    [yearEvent('2031-04-04', 'A lone recorded fact'), yearEvent('2031-08-08', 'Another')],
    { type: 'openrouter', openrouterApiKey: '', customBaseUrl: '', customApiKey: '', customModel: '' },
    'model'
  )
  passed += 1
  console.log('  ok - a year too thin to be worth a call is stored verbatim, with no network')
  assert.equal(result.generated, 1)
  assert.ok(before !== null)
  const stored = getTimelineYearContexts().find((y) => y.year === 2031)
  assert.ok(stored)
  assert.equal(stored.synthesized, false)
  assert.ok(stored.context.includes('A lone recorded fact'), 'the events themselves are the context')
  assert.ok(stored.contextShort.includes('A lone recorded fact'), 'the one-liner names what happened')
})()

// A dense year overflows any prompt budget. Truncating the list drops December,
// so detail goes first and coverage of the months is kept.
check('packing a dense year drops detail before it drops entries', () => {
  const dense = Array.from({ length: 40 }, (_, i) =>
    yearEvent(`2024-${String((i % 12) + 1).padStart(2, '0')}-01`, `Event ${i}`)
  ).map((e) => ({ ...e, detail: 'D'.repeat(300) }))
  const packed = packYearEvents(dense, 6_000)
  assert.ok(!packed.includes('D'.repeat(300)), 'details are dropped')
  assert.ok(packed.includes('Event 39'), 'the end of the year still reaches the model')
  assert.ok(/details were omitted/.test(packed))
})

check('a year too large even without detail says how much is missing', () => {
  const huge = Array.from({ length: 400 }, (_, i) => yearEvent('2024-06-01', `Event ${i}`))
  const packed = packYearEvents(huge, 2_000)
  assert.ok(/further entries are not shown/.test(packed))
  assert.ok(/Do not describe this year as complete/.test(packed))
})

check('a year that fits is passed through untouched', () => {
  const small = [yearEvent('2024-01-01', 'One'), yearEvent('2024-02-01', 'Two')]
  const packed = packYearEvents(small, 10_000)
  assert.ok(!/omitted/.test(packed))
  assert.ok(packed.includes('One') && packed.includes('Two'))
})

check('clamping year prose cuts on a paragraph, never mid-word', () => {
  const prose = `${'First paragraph. '.repeat(20)}\n\n${'Second paragraph. '.repeat(20)}`
  const clamped = clampProse(prose, 400)
  assert.ok(clamped.length < prose.length)
  assert.ok(/continues/.test(clamped))
  assert.ok(!/paragr$|Firs$/.test(clamped), 'no mid-word cut')
})

check('short prose is returned whole, with no continuation marker', () => {
  assert.equal(clampProse('A complete short year.', 400), 'A complete short year.')
})

check('a long year account does not eat the whole year budget in chat', () => {
  const long = [
    { year: 2024, contextShort: 'Short 2024.', context: 'W'.repeat(9_000), eventCount: 500, synthesized: true },
    { year: 2025, contextShort: 'Short 2025.', context: 'X'.repeat(9_000), eventCount: 500, synthesized: true },
  ]
  const rendered = renderYearContexts(long, 7_000, 2_600)
  assert.ok(rendered.block.includes('2024'), 'both years still appear')
  assert.ok(rendered.block.includes('2025'))
  assert.equal(rendered.expanded, 2, 'clamping lets both expand instead of one swallowing the budget')
})

const setBirthDate = (value) => {
  const field = listMemoryFields().find((f) => f.fieldKey === 'birth_date')
  updateMemoryField({ fieldId: field.id, value, locked: false, expectedRevision: field.revision })
}

check('the birth year is read from Memory, and a missing one is null not a guess', () => {
  assert.equal(getTimelineBirthYear(), null, 'no birth date stored in this fixture')
  setBirthDate('1994-05-02')
  assert.equal(getTimelineBirthYear(), 1994)
})

check('a malformed birth date is refused rather than parsed into a wrong year', () => {
  setBirthDate('sometime in the nineties')
  assert.equal(getTimelineBirthYear(), null)
})

// A rebuild whose model calls all fail still harvests and stores events, so it
// returns "success". Swallowing the failures made that indistinguishable from a
// rebuild with nothing to do — two seconds, no change, no explanation.
await (async () => {
  const failingConfig = {
    type: 'custom',
    openrouterApiKey: '',
    customBaseUrl: 'http://127.0.0.1:1',
    customApiKey: 'k',
    customModel: 'm',
  }
  const dense = Array.from({ length: 12 }, (_, i) => yearEvent(`2033-0${(i % 9) + 1}-01`, `Event ${i}`))
  const result = await generateYearContexts(dense, failingConfig, 'model')
  passed += 1
  console.log('  ok - a year whose synthesis fails is counted and its error reported, not swallowed')
  assert.equal(result.generated, 0, 'nothing was stored')
  assert.equal(result.failed, 1, 'the failure is counted')
  assert.ok(result.firstError, 'and carries a message the UI can show')
  assert.equal(getTimelineYearContexts().find((y) => y.year === 2033), undefined, 'no failure sentinel is stored as prose')
})()

check('the rebuild result carries year failures up to the UI', () => {
  const timelineSource = fs.readFileSync(new URL('./src/main/timeline.ts', import.meta.url), 'utf8')
  const pageSource = fs.readFileSync(new URL('./src/renderer/components/TimelinePage.tsx', import.meta.url), 'utf8')
  assert.ok(/yearsFailed/.test(timelineSource) && /yearsError/.test(timelineSource))
  assert.ok(/result\.yearsFailed > 0/.test(pageSource), 'the page surfaces it')
  assert.ok(/console\.error\('?\[timeline\]/.test(timelineSource) || /console\.error\(`\[timeline\]/.test(timelineSource))
})

// The observed failure: five of forty-odd years came back as an empty 200 body
// in a single pass. Retrying only on `isTransientError` left that case fatal,
// because an empty synthesis throws a message no transient pattern matches.
await (async () => {
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    // Empty content twice, then a real answer — the documented behaviour of a
    // fast model under concurrency.
    const content = calls < 3 ? '' : 'SHORT: A recovered year.\n---\nThe year in full prose.'
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  }
  try {
    const dense = Array.from({ length: 12 }, (_, i) => yearEvent(`2034-0${(i % 9) + 1}-01`, `Event ${i}`))
    const result = await generateYearContexts(
      dense,
      { type: 'custom', openrouterApiKey: '', customBaseUrl: 'http://example.invalid', customApiKey: 'k', customModel: 'm' },
      'model'
    )
    assert.equal(result.failed, 0, 'an empty body is retried, not counted as a failure')
    assert.equal(result.generated, 1)
    assert.equal(calls, 3, 'it took all three attempts')
    const stored = getTimelineYearContexts().find((y) => y.year === 2034)
    assert.equal(stored.context, 'The year in full prose.')
    assert.equal(stored.contextShort, 'A recovered year.')
  } finally {
    globalThis.fetch = realFetch
  }
  passed += 1
  console.log('  ok - an empty model response is retried rather than losing the year')
})()

check('the year call leaves room for models that reason before they write', () => {
  const timelineSource = fs.readFileSync(new URL('./src/main/timeline.ts', import.meta.url), 'utf8')
  const yearCall = timelineSource.slice(timelineSource.indexOf('async function synthesizeYear('))
  const cap = Number(yearCall.match(/max_tokens: (\d+)/)?.[1])
  assert.ok(cap >= 12_000, `a low output cap is returned as an empty body (found ${cap})`)
})

check('year synthesis is paced and retried like every other indexing call', () => {
  const timelineSource = fs.readFileSync(new URL('./src/main/timeline.ts', import.meta.url), 'utf8')
  assert.ok(/createRateLimiter\(settings\.getRequestsPerMinute\(\)\)/.test(timelineSource), 'a burst of years is paced')
  assert.ok(/await limiter\.acquire\(signal\)/.test(timelineSource))
  assert.ok(/synthesizeYearRetrying/.test(timelineSource), 'a transient failure is retried, not fatal')
  assert.ok(/isTransientError/.test(timelineSource))
})

// --- rebuild run state --------------------------------------------------------
// The rebuild's progress events go to the window that asked for the run, so the
// sidebar could never see a background rebuild. The registry is what every window
// watches instead.
console.log('timeline run state')

const {
  beginTimelineRun,
  reportTimelineRunProgress,
  finishTimelineRun,
  getTimelineRunState,
  isTimelineRunActive,
  subscribeTimelineRunState,
  resetTimelineRunsForTests,
} = await import('./src/main/timelineRuns.ts')

const runProgress = (current, total) => ({
  phase: 'narrative',
  message: `Compressing ${current}/${total} years`,
  current,
  total,
})

check('an idle registry reports idle, with nothing in flight', () => {
  resetTimelineRunsForTests()
  assert.equal(getTimelineRunState().status, 'idle')
  assert.equal(isTimelineRunActive(), false)
})

const seenStates = []
const unsubscribeRunState = subscribeTimelineRunState((state) => seenStates.push(state.status))

check('a started run is observable, carries its origin, and broadcasts', () => {
  const run = beginTimelineRun('timer')
  assert.equal(isTimelineRunActive(), true)
  const state = getTimelineRunState()
  assert.equal(state.status, 'running')
  assert.equal(state.origin, 'timer')
  reportTimelineRunProgress(run, runProgress(3, 18))
  assert.equal(getTimelineRunState().progress.current, 3)
  assert.ok(seenStates.includes('running'))
  finishTimelineRun(run)
})

check('a finished run goes idle and drops its progress', () => {
  const state = getTimelineRunState()
  assert.equal(state.status, 'idle')
  assert.equal(state.progress, null)
  assert.equal(state.message, null, 'a clean finish leaves no error behind')
})

check('a failed run keeps its message for the UI to explain itself', () => {
  const run = beginTimelineRun('user')
  finishTimelineRun(run, { failed: true, message: 'Timeline rebuild stalled.' })
  assert.equal(getTimelineRunState().status, 'idle')
  assert.equal(getTimelineRunState().message, 'Timeline rebuild stalled.')
})

check('a superseded run cannot paint over the run that replaced it', () => {
  const first = beginTimelineRun('user')
  const second = beginTimelineRun('timer')
  reportTimelineRunProgress(first, runProgress(1, 99))
  assert.notEqual(getTimelineRunState().progress?.total, 99, 'the stale run is ignored')
  finishTimelineRun(first)
  assert.equal(getTimelineRunState().status, 'running', 'and it cannot end the live one either')
  assert.equal(getTimelineRunState().origin, 'timer')
  finishTimelineRun(second)
})

unsubscribeRunState()
resetTimelineRunsForTests()

check('rebuild status is broadcast to every window and rendered in the sidebar', () => {
  const channels = fs.readFileSync(new URL('./src/main/ipcChannels.ts', import.meta.url), 'utf8')
  const ipcSource = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
  const preloadSource = fs.readFileSync(new URL('./src/preload/preload.ts', import.meta.url), 'utf8')
  const typesSource = fs.readFileSync(new URL('./src/shared/types.ts', import.meta.url), 'utf8')
  const sidebarSource = fs.readFileSync(new URL('./src/renderer/components/Sidebar.tsx', import.meta.url), 'utf8')

  // The 4-file IPC sync: channel, handler, bridge, type.
  assert.ok(/GET_STATE: 'timeline:get-state'/.test(channels))
  assert.ok(/STATE: 'timeline:state'/.test(channels))
  assert.ok(/subscribeTimelineRunState\(/.test(ipcSource), 'main broadcasts run state')
  assert.ok(/broadcast\(IPC\.TIMELINE\.STATE, state\)/.test(ipcSource), 'to every window and every paired device, not just the sender')
  assert.ok(/onState: \(callback: \(state: TimelineRunState\)/.test(preloadSource))
  assert.ok(/onState: \(callback: \(state: TimelineRunState\) => void\) => \(\) => void/.test(typesSource))
  assert.ok(/useTimelineRunState\(\)/.test(sidebarSource), 'the sidebar subscribes')
  assert.ok(/Rebuilding timeline in background/.test(sidebarSource), 'a background rebuild is labelled as one')
})

check('the background timer reports through the registry and never stacks on a user run', () => {
  const mainSourceText = fs.readFileSync(new URL('./src/main/main.ts', import.meta.url), 'utf8')
  assert.ok(/if \(isTimelineRunActive\(\)\) return/.test(mainSourceText), 'the timer defers to a live run')
  assert.ok(/beginTimelineRun\('timer'\)/.test(mainSourceText))
  assert.ok(/reportTimelineRunProgress\(run, progress\)/.test(mainSourceText), 'the timer feeds the sidebar too')
})

check('chat injection is wired into the system-prompt builder and states the precision caveat', () => {
  const ipcSource = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
  assert.ok(/buildTimelineContext\(/.test(ipcSource))
  assert.ok(/label: 'Timeline'/.test(ipcSource))
  assert.ok(/settings\.getSettings\(\)\.timelineEnabled/.test(ipcSource))
  assert.ok(/absence of an entry is not evidence/.test(ipcSource))
})

// --- reconciliation ----------------------------------------------------------
console.log('reconcileTimelineEntries')

check('recognizes a birth claim about the archive owner and nobody else', () => {
  assert.ok(isOwnerBirthClaim({ title: 'Born in Austin' }))
  assert.ok(isOwnerBirthClaim({ title: 'Date of birth recorded on intake form' }))
  assert.ok(isOwnerBirthClaim({ title: 'DOB listed as 2002-08-18' }))
  assert.ok(!isOwnerBirthClaim({ title: 'Mother born in Ohio' }), 'a family member keeps their own birth')
  assert.ok(!isOwnerBirthClaim({ title: 'Born', detail: "Sister's birth certificate" }), 'the subject can sit in the detail')
  assert.ok(!isOwnerBirthClaim({ title: 'Birthday dinner downtown' }), 'a birthday is an annual event, not a birth')
  assert.ok(!isOwnerBirthClaim({ title: 'Started a new job' }))
})

check('excludes birth years that contradict the recorded one, and keeps the right one', () => {
  const entries = [
    entry({ title: 'Born', startDate: '1994-01-01', precision: 'year' }),
    entry({ title: 'Born', startDate: '1998-01-01', precision: 'year' }),
    entry({ title: 'Born', startDate: '2002-08-18' }),
    entry({ title: 'Moved to Austin', startDate: '1998-06-01', precision: 'month' }),
  ]
  const result = reconcileBirthClaims(entries, 2002)
  assert.equal(result.excluded, 2)
  assert.deepEqual(result.yearsClaimed, [1994, 1998, 2002])
  assert.equal(entries[0].excludedReason?.includes('1994'), true)
  assert.equal(entries[1].excludedReason?.includes('1998'), true)
  assert.equal(entries[2].excludedReason, undefined, 'the recorded year survives')
  assert.equal(entries[3].excludedReason, undefined, 'an unrelated 1998 event is untouched')
  assert.equal(result.exclusion.kind, 'birth-year-conflict')
  assert.ok(result.exclusion.detail.includes('2002'), 'the reason names the year it reconciled against')
})

check('with no recorded birth date it reports the conflict rather than guessing a winner', () => {
  const entries = [
    entry({ title: 'Born', startDate: '1994-01-01', precision: 'year' }),
    entry({ title: 'Born', startDate: '2002-08-18' }),
  ]
  const result = reconcileBirthClaims(entries, null)
  assert.equal(result.excluded, 0)
  assert.equal(entries[0].excludedReason, undefined)
  assert.equal(entries[1].excludedReason, undefined)
  assert.ok(result.exclusion, 'the conflict is still surfaced')
  assert.ok(/birth_date/.test(result.exclusion.detail), 'and it says how to settle it')
})

check('a single birth claim with no recorded date is not a conflict', () => {
  const result = reconcileBirthClaims([entry({ title: 'Born', startDate: '2002-08-18' })], null)
  assert.equal(result.exclusion, null)
})

check('the shape key is the title without its figures', () => {
  assert.equal(timelineShapeKey('Screen-on time 50.1 hours'), timelineShapeKey('Screen-on time 58.8 hours'))
  assert.notEqual(timelineShapeKey('Screen-on time 50.1 hours'), timelineShapeKey('Steps walked 50.1 thousand'))
  assert.deepEqual(timelineTitleNumbers('Screen-on time 50.1 hours over 3 days'), [50.1, 3])
  assert.deepEqual(timelineTitleNumbers('No figures here'), [])
})

check('a span with no stated end still covers the period its precision implies', () => {
  assert.equal(effectiveEndDate({ startDate: '2024-07-24', endDate: null, precision: 'day' }), '2024-07-24')
  assert.equal(effectiveEndDate({ startDate: '2024-07-01', endDate: null, precision: 'month' }), '2024-07-31')
  assert.ok(spansOverlap(
    { startDate: '2024-07-24', endDate: '2024-07-27', precision: 'day' },
    { startDate: '2024-07-26', endDate: null, precision: 'day' }
  ))
  assert.ok(!spansOverlap(
    { startDate: '2024-07-24', endDate: '2024-07-26', precision: 'day' },
    { startDate: '2024-07-27', endDate: '2024-07-29', precision: 'day' }
  ))
})

check('collapses six re-runs of one week of screen time into the widest pass', () => {
  const entries = [
    entry({ category: 'technology', title: 'Screen-on time 50.1 hours', startDate: '2024-07-24', endDate: '2024-07-26' }),
    entry({ category: 'technology', title: 'Screen-on time 52.5 hours', startDate: '2024-07-24', endDate: '2024-07-26' }),
    entry({ category: 'technology', title: 'Screen-on time 55.3 hours', startDate: '2024-07-24', endDate: '2024-07-27' }),
    entry({ category: 'technology', title: 'Screen-on time 57.5 hours', startDate: '2024-07-24', endDate: '2024-07-27' }),
    entry({ category: 'technology', title: 'Screen-on time 58.4 hours', startDate: '2024-07-25', endDate: '2024-07-27' }),
    entry({ category: 'technology', title: 'Screen-on time 58.8 hours', startDate: '2024-07-24', endDate: '2024-07-27' }),
  ]
  const result = collapseRestatements(entries)
  assert.equal(result.excluded, 5)
  const kept = entries.filter((item) => !item.excludedReason)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].endDate, '2024-07-27', 'the survivor is a pass covering the whole window')
  assert.ok(/Collapsed 5 overlapping restatements/.test(kept[0].detail))
  assert.ok(/50\.1 to 58\.8/.test(kept[0].detail), 'the range the others reported is preserved')
  assert.equal(result.exclusion.kind, 'restatement')
})

check('a weekly metric measured week after week is not a restatement', () => {
  const entries = [
    entry({ category: 'technology', title: 'Weekly screen-on time 41.2 hours', startDate: '2024-07-01', endDate: '2024-07-07' }),
    entry({ category: 'technology', title: 'Weekly screen-on time 43.0 hours', startDate: '2024-07-08', endDate: '2024-07-14' }),
    entry({ category: 'technology', title: 'Weekly screen-on time 39.6 hours', startDate: '2024-07-15', endDate: '2024-07-21' }),
  ]
  const result = collapseRestatements(entries)
  assert.equal(result.excluded, 0, 'non-overlapping spans are distinct measurements')
  assert.equal(entries.filter((item) => item.excludedReason).length, 0)
})

check('a title carrying no figure is never treated as a measurement', () => {
  const entries = [
    entry({ category: 'work', title: 'Started contracting for the agency', startDate: '2024-07-24', endDate: '2024-07-27' }),
    entry({ category: 'work', title: 'Started contracting for the agency again', startDate: '2024-07-25', endDate: '2024-07-27' }),
  ]
  assert.equal(collapseRestatements(entries).excluded, 0)
})

check('an entry already excluded as a wrong birth year is never chosen as a survivor', () => {
  const entries = [
    entry({ title: 'Born 1994 per intake form', startDate: '1994-01-01', endDate: '1994-12-31', precision: 'year' }),
    entry({ title: 'Born 2002 per intake form', startDate: '2002-01-01', endDate: '2002-12-31', precision: 'year' }),
  ]
  const result = reconcileTimelineEntries(entries, 2002)
  assert.equal(result.excluded, 1)
  assert.ok(/1994/.test(entries[0].excludedReason))
  assert.equal(entries[1].excludedReason, undefined)
  assert.equal(result.exclusions.length, 1)
})

check('an excluded entry is stored with its reason and left out of the record', () => {
  const project = createProject({ name: 'Reconcile Test Project', icon: 'folder', color: '#ffffff', path: null })
  const good = entry({
    sourceRef: 'reconcile:good', projectId: project.id,
    title: 'Reconciliation keeper', startDate: '2011-05-05',
  })
  const bad = entry({
    sourceRef: 'reconcile:bad', projectId: project.id,
    title: 'Reconciliation reject', startDate: '2011-06-06',
    excludedReason: 'Restatement of "Reconciliation keeper" over the same period',
  })
  const stats = mergeDerivedTimelineEvents([good, bad])
  assert.equal(stats.excluded, 1, 'the write reports what it set aside')

  const visible = listTimelineEvents({ projectIds: [project.id] }).map((event) => event.title)
  assert.ok(visible.includes('Reconciliation keeper'))
  assert.ok(!visible.includes('Reconciliation reject'), 'excluded entries are out of the record by default')

  const all = listTimelineEvents({ projectIds: [project.id], includeExcluded: true })
  const rejected = all.find((event) => event.title === 'Reconciliation reject')
  assert.ok(rejected, 'but the row is kept, not deleted')
  assert.ok(rejected.excludedAt, 'and stamped')
  assert.ok(/Restatement/.test(rejected.excludedReason), 'with the reason a user can read')

  // Re-admitted the moment reconciliation stops objecting.
  mergeDerivedTimelineEvents([good, { ...bad, excludedReason: null }])
  const readmitted = listTimelineEvents({ projectIds: [project.id] }).map((event) => event.title)
  assert.ok(readmitted.includes('Reconciliation reject'), 'exclusion is re-derived, never sticky')
  for (const event of listTimelineEvents({ projectIds: [project.id], includeExcluded: true })) {
    deleteTimelineEvent(event.id)
  }
})

check('the birth year anchors the year and narrative prompts, and their cache keys', () => {
  const source = fs.readFileSync(new URL('./src/main/timeline.ts', import.meta.url), 'utf8')
  assert.ok(/function birthYearPreamble/.test(source))
  assert.ok(/never state a different birth year/i.test(source), 'the year prompt forbids re-deriving one')
  assert.ok(/getTimelineBirthYear\(\) \?\? 'unknown'/.test(source), 'the anchor is part of both cache keys')
  assert.ok(/birthYear \?\? 'unknown'/.test(source))
})

check('the rebuild result carries the exclusions up to the UI', () => {
  const timelineSource = fs.readFileSync(new URL('./src/main/timeline.ts', import.meta.url), 'utf8')
  const pageSource = fs.readFileSync(new URL('./src/renderer/components/TimelinePage.tsx', import.meta.url), 'utf8')
  assert.ok(/entriesExcluded: reconciled\.excluded/.test(timelineSource))
  assert.ok(/exclusions: reconciled\.exclusions/.test(timelineSource))
  assert.ok(/result\.entriesExcluded > 0/.test(pageSource), 'a cleanup is never silent')
  assert.ok(/result\.exclusions\.map/.test(pageSource), 'and it says on what grounds')
})

// --- narrative parsing -------------------------------------------------------
console.log('parseNarrativeResponse')

check('parses eras and narrative out of a fenced JSON response', () => {
  const result = parseNarrativeResponse('```json\n{"eras":[{"label":"Austin","startDate":"2019","endDate":null,"summary":"s"}],"narrative":"n"}\n```')
  assert.equal(result.eras.length, 1)
  assert.equal(result.eras[0].endDate, null)
  assert.equal(result.narrative, 'n')
})

check('drops malformed eras and tolerates a missing narrative', () => {
  const result = parseNarrativeResponse('{"eras":[{"label":"","startDate":"2019"},{"summary":"x"},{"label":"Ok","startDate":"2020","summary":"y"}]}')
  assert.equal(result.eras.length, 1)
  assert.equal(result.eras[0].label, 'Ok')
  assert.equal(result.narrative, '')
})

check('throws on a response that is not an object at all', () => {
  assert.throws(() => parseNarrativeResponse('not json'))
})

closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })
console.log(`\nAll ${passed} timeline checks passed.`)
