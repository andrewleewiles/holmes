import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-recall-history-'))
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
  initDatabase,
  closeDatabase,
  insertRecallSearch,
  listRecallSearches,
  deleteRecallSearch,
  clearRecallSearches,
  MAX_RECALL_SEARCH_ROWS,
} = await import('./src/main/database.ts')
initDatabase()

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL  ${name}\n        ${error.message}`)
  }
}

const answered = insertRecallSearch({
  query: 'What are my favorite movies?',
  source: 'all',
  semantic: true,
  answer: 'Your highest rated films include Puss in Boots: The Last Wish and Saltburn.',
  answerModel: 'z-ai/glm-5.2',
  sources: [
    { resultId: 'file:/x/Media.xlsx', title: 'Media.xlsx', context: '/x', path: '/x/Media.xlsx' },
    { resultId: 'conversation:m1', title: 'Movie night', context: 'You message', conversationId: 'c1' },
  ],
  resultCount: 60,
  expandedQueries: ['movies', 'film ratings'],
  notices: [],
  durationMs: 5900,
})

check('round-trips the query, answer, and model', () => {
  assert.equal(answered.query, 'What are my favorite movies?')
  assert.equal(answered.answer, 'Your highest rated films include Puss in Boots: The Last Wish and Saltburn.')
  assert.equal(answered.answerModel, 'z-ai/glm-5.2')
  assert.equal(answered.semantic, true)
  assert.equal(answered.source, 'all')
  assert.equal(answered.resultCount, 60)
  assert.equal(answered.durationMs, 5900)
  assert.ok(answered.createdAt > 0)
})

check('keeps the cited sources so a past answer stays inspectable', () => {
  assert.equal(answered.sources.length, 2)
  assert.equal(answered.sources[0].path, '/x/Media.xlsx')
  assert.equal(answered.sources[1].conversationId, 'c1')
  assert.deepEqual(answered.expandedQueries, ['movies', 'film ratings'])
})

// A search that found things but produced no grounded answer is still history:
// the user asked the question, and that it went unanswered is worth seeing.
const unanswered = insertRecallSearch({
  query: 'when did I move apartments',
  source: 'files',
  semantic: false,
  answer: null,
  answerModel: null,
  sources: [],
  resultCount: 4,
  expandedQueries: [],
  notices: ['Part of the Spotlight search timed out.'],
  durationMs: 900,
})

check('stores a search that produced no answer', () => {
  assert.equal(unanswered.answer, null)
  assert.equal(unanswered.answerModel, null)
  assert.deepEqual(unanswered.sources, [])
  assert.equal(unanswered.semantic, false)
  assert.equal(unanswered.source, 'files')
  assert.deepEqual(unanswered.notices, ['Part of the Spotlight search timed out.'])
})

check('lists newest first', () => {
  const listed = listRecallSearches()
  assert.equal(listed.length, 2)
  assert.equal(listed[0].id, unanswered.id)
  assert.equal(listed[1].id, answered.id)
})

check('deletes one entry without touching the rest', () => {
  deleteRecallSearch(unanswered.id)
  const listed = listRecallSearches()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, answered.id)
})

check('deleting an unknown id is a no-op rather than an error', () => {
  deleteRecallSearch('does-not-exist')
  assert.equal(listRecallSearches().length, 1)
})

// The window has to hold: a history that grows without bound turns a personal
// record into a liability.
check('prunes to the retention window', () => {
  for (let index = 0; index < 12; index += 1) {
    insertRecallSearch({
      query: `filler ${index}`,
      source: 'all',
      semantic: true,
      answer: null,
      answerModel: null,
      sources: [],
      resultCount: 0,
      expandedQueries: [],
      notices: [],
      durationMs: 1,
    })
  }
  assert.ok(listRecallSearches().length <= MAX_RECALL_SEARCH_ROWS)
  assert.equal(listRecallSearches(5).length, 5)
})

check('clears everything', () => {
  const removed = clearRecallSearches()
  assert.ok(removed > 0)
  assert.deepEqual(listRecallSearches(), [])
})

closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} recall history check(s) failed`)
  process.exit(1)
}
console.log('\nRecall history storage checks passed')
