import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-ctxsearch-db-'))
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
  createProject,
  updateProject,
  upsertDocumentFileContext,
  upsertDocumentFolderContext,
  setProjectSuperContext,
  setDocumentSummaryMeta,
  setUserSuperContext,
  hasContextSearchIndex,
  searchDocumentFileContexts,
  searchDocumentFolderContexts,
  findDocumentContextsByPath,
  countGeneratedContexts,
} = await import('./src/main/database.ts')
initDatabase()

const {
  tokenizeContextQuery,
  buildContextMatchExpression,
  scoreContextMatch,
  selectDiverseHits,
  searchGeneratedContexts,
  getGeneratedContextForPath,
  hasGeneratedContexts,
} = await import('./src/main/contextSearch.ts')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

// --- query handling ----------------------------------------------------------
console.log('query handling')

check('a question is reduced to content words', () => {
  const terms = tokenizeContextQuery('What do you know about my marathon training?')
  assert.deepEqual(terms, ['know', 'marathon', 'training'])
})

check('duplicate and one-character words are dropped, order is kept', () => {
  assert.deepEqual(tokenizeContextQuery('running running a 5 x race'), ['running', 'race'])
})

// Every token quoted, ORed, and prefixed only from three characters up: an
// implicit AND would demand the answer contain the question's own filler words,
// and a prefix on "of"-sized tokens matches half the corpus.
check('the FTS expression quotes every token and ORs them', () => {
  assert.equal(
    buildContextMatchExpression(['marathon', 'training']),
    '"marathon"* OR "training"*'
  )
})

check('short tokens get no prefix wildcard', () => {
  assert.equal(buildContextMatchExpression(['5k', 'run']), '"5k" OR "run"*')
})

check('a quote in the query cannot escape into FTS syntax', () => {
  assert.equal(buildContextMatchExpression(['tra"in', 'a"']), '"train"* OR "a"')
})

// --- scoring -----------------------------------------------------------------
console.log('scoring')

check('coverage beats repetition', () => {
  const terms = ['marathon', 'training', 'diet']
  const broad = scoreContextMatch({ text: 'marathon training and diet notes', label: '' }, terms)
  const narrow = scoreContextMatch({ text: 'marathon marathon marathon marathon marathon', label: '' }, terms)
  assert.ok(broad > narrow, `${broad} should beat ${narrow}`)
})

check('a name match counts even when the prose never says the word', () => {
  const terms = ['training']
  const named = scoreContextMatch({ text: 'six sessions a week, progressive overload', label: 'Training/plan.md' }, terms)
  assert.ok(named > 0)
})

check('no matching term scores zero', () => {
  assert.equal(scoreContextMatch({ text: 'nothing relevant here', label: 'x' }, ['marathon']), 0)
})

check('one folder cannot fill the whole page of file hits', () => {
  const hit = (index, score) => ({
    level: 'file',
    path: `/data/same/file-${index}.txt`,
    label: `file-${index}.txt`,
    projectId: 'p',
    projectName: 'P',
    kind: 'text',
    context: '',
    contextShort: '',
    fileCount: 1,
    score,
    updatedAt: '',
    conversationId: null,
  })
  const other = { ...hit(99, 1), path: '/data/elsewhere/other.txt', label: 'other.txt' }
  const selected = selectDiverseHits([hit(1, 10), hit(2, 9), hit(3, 8), hit(4, 7), other], 4)
  assert.equal(selected.filter((entry) => entry.path.startsWith('/data/same/')).length, 3)
  assert.ok(selected.some((entry) => entry.path === '/data/elsewhere/other.txt'))
})

// --- the index ---------------------------------------------------------------
console.log('the index')

check('nothing indexed reads as empty rather than as no matches', () => {
  assert.equal(hasGeneratedContexts(), false)
  const outcome = searchGeneratedContexts('marathon')
  assert.equal(outcome.empty, true)
  assert.equal(outcome.hits.length, 0)
  assert.match(outcome.notice, /Nothing has been indexed/)
})

check('the FTS tables and triggers exist after initDatabase', () => {
  assert.equal(hasContextSearchIndex(), true)
})

const root = path.join(dbDir, 'sources', 'Training')
const project = createProject({ name: 'Training', icon: 'dumbbell', color: '#10b981', path: root, files: [] })
const planPath = path.join(root, 'plans', 'marathon-plan.md')
const dietPath = path.join(root, 'plans', 'diet.md')
const oldPath = path.join(root, 'plans', 'legacy.md')

upsertDocumentFileContext({
  projectId: project.id,
  filePath: planPath,
  relativePath: 'plans/marathon-plan.md',
  contentHash: 'h1',
  context: 'Runs six days a week on a progressive marathon build, long run on Sunday.',
})
upsertDocumentFileContext({
  projectId: project.id,
  filePath: dietPath,
  relativePath: 'plans/diet.md',
  contentHash: 'h2',
  context: 'Tracks protein and a calorie deficit while cutting, weighs food daily.',
})
// A failure sentinel is still a row in the tree, and must never be offered as an
// answer — it would read as a finding about the user.
upsertDocumentFileContext({
  projectId: project.id,
  filePath: oldPath,
  relativePath: 'plans/legacy.md',
  contentHash: 'h3',
  context: 'Context generation failed for plans/legacy.md: marathon marathon marathon',
})
upsertDocumentFolderContext({
  projectId: project.id,
  folderPath: path.join(root, 'plans'),
  relativePath: 'plans',
  childHash: 'c1',
  contextShort: 'Disciplined endurance training with tracked nutrition.',
  context: 'Across these plans the person trains for a marathon and controls diet precisely.',
  fileCount: 3,
})
upsertDocumentFolderContext({
  projectId: project.id,
  folderPath: root,
  relativePath: '.',
  childHash: 'c2',
  contextShort: 'An athlete who plans and measures.',
  context: 'The whole source shows sustained marathon preparation alongside deliberate eating.',
  fileCount: 3,
})

check('the triggers indexed rows written after table creation', () => {
  const hits = searchDocumentFileContexts('"marathon"*', 10)
  assert.ok(hits.some((hit) => hit.path === planPath))
  const folders = searchDocumentFolderContexts('"marathon"*', 10)
  assert.equal(folders.length, 2)
})

check('an updated context replaces its old text in the index', () => {
  upsertDocumentFileContext({
    projectId: project.id,
    filePath: dietPath,
    relativePath: 'plans/diet.md',
    contentHash: 'h2b',
    context: 'Now eats at maintenance and lifts three times a week.',
  })
  const stale = searchDocumentFileContexts('"deficit"*', 10)
  assert.equal(stale.filter((hit) => hit.path === dietPath).length, 0)
  const fresh = searchDocumentFileContexts('"maintenance"*', 10)
  assert.equal(fresh.filter((hit) => hit.path === dietPath).length, 1)
})

check('counts report every level', () => {
  const counts = countGeneratedContexts()
  assert.equal(counts.files, 3)
  assert.equal(counts.folders, 2)
  assert.equal(hasGeneratedContexts(), true)
})

// --- searching ---------------------------------------------------------------
console.log('searching')

check('a topic question finds the file, the folder and the source root', () => {
  const outcome = searchGeneratedContexts('marathon training', { limit: 10 })
  assert.equal(outcome.empty, false)
  const levels = outcome.hits.map((hit) => hit.level)
  assert.ok(levels.includes('file'))
  assert.ok(levels.includes('folder'))
  assert.ok(levels.includes('sourceRoot'))
})

check('a failed context is never a search result', () => {
  const outcome = searchGeneratedContexts('marathon', { limit: 20 })
  assert.equal(outcome.hits.filter((hit) => hit.path === oldPath).length, 0)
})

check('levels narrow the search', () => {
  const outcome = searchGeneratedContexts('marathon', { limit: 10, levels: ['file'] })
  assert.ok(outcome.hits.length > 0)
  assert.ok(outcome.hits.every((hit) => hit.level === 'file'))
})

check('the source root reads as a root, not as a folder called "."', () => {
  const outcome = searchGeneratedContexts('marathon', { limit: 10, levels: ['sourceRoot'] })
  assert.equal(outcome.hits.length, 1)
  assert.equal(outcome.hits[0].level, 'sourceRoot')
  assert.match(outcome.hits[0].label, /^Training — /)
})

check('project and user syntheses are searchable too', () => {
  setDocumentSummaryMeta({ projectId: project.id, rootPath: root, signature: 'sig', fileCount: 3, folderCount: 2 })
  setProjectSuperContext({
    projectId: project.id,
    contextShort: 'A methodical trainer.',
    context: 'Combining the sources, the person periodises marathon blocks and logs every meal.',
    inputHash: 'p1',
  })
  setUserSuperContext({
    contextShort: 'Measures everything.',
    context: 'The unified picture is of someone whose marathon training organises the rest of the week.',
    inputHash: 'u1',
    projectCount: 1,
  })
  const outcome = searchGeneratedContexts('marathon', { limit: 20 })
  assert.ok(outcome.hits.some((hit) => hit.level === 'project'))
  assert.ok(outcome.hits.some((hit) => hit.level === 'user'))
})

check('a project-scoped search excludes the apex', () => {
  const outcome = searchGeneratedContexts('marathon', { limit: 20, projectId: project.id })
  assert.ok(outcome.hits.length > 0)
  assert.ok(outcome.hits.every((hit) => hit.level !== 'user'))
})

// The cap has a floor of 200 characters: a caller asking for twenty would get a
// result too short to be evidence of anything.
check('contexts are capped, not returned whole', () => {
  const long = 'marathon '.repeat(60)
  upsertDocumentFileContext({
    projectId: project.id,
    filePath: path.join(root, 'plans', 'long.md'),
    relativePath: 'plans/long.md',
    contentHash: 'h4',
    context: long,
  })
  const outcome = searchGeneratedContexts('marathon', { limit: 20, maxContextChars: 200 })
  assert.ok(outcome.hits.every((hit) => hit.context.length <= 201))
  assert.ok(outcome.hits.some((hit) => hit.context.endsWith('…')))
})

// A hidden source is hidden from search too: the eye toggle would otherwise be a
// Data-page decoration while the model went on quoting the source.
check('a hidden source disappears from search', () => {
  updateProject(project.id, { visible: false })
  const outcome = searchGeneratedContexts('marathon', { limit: 20 })
  assert.equal(outcome.hits.filter((hit) => hit.projectId === project.id).length, 0)
  updateProject(project.id, { visible: true })
  assert.ok(searchGeneratedContexts('marathon', { limit: 20 }).hits.length > 0)
})

check('a query of nothing but stop words says so', () => {
  const outcome = searchGeneratedContexts('what about the')
  assert.equal(outcome.hits.length, 0)
  assert.match(outcome.notice, /no searchable words/)
})

// --- path lookup -------------------------------------------------------------
console.log('path lookup')

check('a trailing path fragment finds the file', () => {
  const result = getGeneratedContextForPath('plans/marathon-plan.md')
  assert.equal(result.found, true)
  assert.equal(result.node.path, planPath)
  assert.equal(result.node.level, 'file')
  assert.match(result.node.context, /progressive marathon build/)
})

check('the enclosing folder summaries come back with it', () => {
  const result = getGeneratedContextForPath(planPath)
  const paths = result.ancestors.map((ancestor) => ancestor.path)
  assert.deepEqual(paths, [path.join(root, 'plans'), root])
  assert.equal(result.ancestors[1].level, 'sourceRoot')
})

check('a folder can be asked about directly', () => {
  const result = getGeneratedContextForPath('sources/Training/plans')
  assert.equal(result.found, true)
  assert.equal(result.node.level, 'folder')
  assert.match(result.node.context, /trains for a marathon/)
})

check('an unindexed path is reported, not guessed at', () => {
  const result = getGeneratedContextForPath('plans/nothing-here.md')
  assert.equal(result.found, false)
  assert.equal(result.node, null)
  assert.match(result.notice, /No generated context is stored/)
})

check('a hidden source hides its paths from lookup as well', () => {
  updateProject(project.id, { visible: false })
  assert.equal(getGeneratedContextForPath(planPath).found, false)
  updateProject(project.id, { visible: true })
})

// Two sources can index the same folder — a project and a broader one above it —
// and a run that ran out of credits leaves a failure marker where the summary
// should be. Asking about the path must land on the real summary.
check('a real summary beats another source\'s failure marker for the same path', () => {
  const shared = createProject({ name: 'Shared', icon: 'folder-open', color: '#f59e0b', path: path.dirname(root), files: [] })
  upsertDocumentFileContext({
    projectId: shared.id,
    filePath: planPath,
    relativePath: 'Training/plans/marathon-plan.md',
    contentHash: 'h9',
    context: 'Context generation failed for Training/plans/marathon-plan.md: LLM call failed',
  })
  const result = getGeneratedContextForPath(planPath)
  assert.equal(result.found, true)
  assert.match(result.node.context, /progressive marathon build/)
  assert.equal(result.notice, undefined)
  // The duplicate path is not offered back as a separate candidate.
  assert.equal(result.candidates.filter((entry) => entry.path === planPath).length, 0)
})

check('a path whose every copy failed says so instead of passing the marker off as a finding', () => {
  const failedPath = path.join(root, 'plans', 'broken.md')
  upsertDocumentFileContext({
    projectId: project.id,
    filePath: failedPath,
    relativePath: 'plans/broken.md',
    contentHash: 'h10',
    context: 'Context generation failed for plans/broken.md: LLM call failed',
  })
  const result = getGeneratedContextForPath(failedPath)
  assert.equal(result.found, true)
  assert.match(result.notice, /failed to generate/)
})

check('the LIKE pattern treats wildcards in the query as literal text', () => {
  assert.equal(findDocumentContextsByPath('%plan%', 10).length, 0)
  assert.ok(findDocumentContextsByPath('marathon-plan.md', 10).length > 0)
})

closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })
console.log(`\nContext search: ${passed} checks passed`)
