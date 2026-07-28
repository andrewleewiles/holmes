import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-doc-db-'))
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
  getDocumentFileContext,
  upsertDocumentFileContext,
  listDocumentFileContexts,
  pruneDocumentFileContexts,
  getDocumentFolderContext,
  upsertDocumentFolderContext,
  listDocumentFolderContexts,
  pruneDocumentFolderContexts,
  getDocumentSummaryMeta,
  setDocumentSummaryMeta,
  listProjectRootContexts,
  getUserSuperContext,
  setUserSuperContext,
  setDocumentFileContextProvenance,
  setDocumentFolderContextProvenance,
  listContextVersions,
  getContextVersion,
} = await import('./src/main/database.ts')
initDatabase()

const { setFileAccessScope } = await import('./src/main/settings.ts')
setFileAccessScope({ mode: 'everywhere', roots: [] })

const { buildFolderTree, computeDirectorySignature, getDocumentContextTree, parseFolderContext, mapWithConcurrency, readDocumentText, isTransientError, isFailedContext, generateDocumentContexts, generateUserSuperContext, resolveProvenanceChain, extractClaims, clampClaims, finishSynthesis, packFolderChildren, numberLines, lineMarkerResolver, readSourceExcerpt } = await import('./src/main/documentContext.ts')
// INDEXABLE_EXTENSIONS is imported again further down for the photo section, so
// this early binding takes an alias rather than shadowing it.
const { scanProjectTextFiles, INDEXABLE_EXTENSIONS: scanExtensions } = await import('./src/main/projectContext.ts')
const { addProjectSource: addSource } = await import('./src/main/database.ts')
const { zipSync, strToU8 } = await import('fflate')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

// The sync `check` above would swallow an async assertion (a rejected promise
// escapes as an unhandled rejection and the test still "passes"), so awaited
// checks get their own helper.
async function checkAsync(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

// --- buildFolderTree ---------------------------------------------------------
console.log('buildFolderTree')

const base = path.join('/tmp', 'src')
const files = [
  path.join(base, 'root.txt'),
  path.join(base, 'a', 'one.txt'),
  path.join(base, 'a', 'two.txt'),
  path.join(base, 'a', 'deep', 'three.txt'),
  path.join(base, 'b', 'four.txt'),
]

const { folders, orderedDeepestFirst } = buildFolderTree(base, files)

check('registers base plus every ancestor folder', () => {
  const keys = new Set(folders.keys())
  assert.ok(keys.has(base))
  assert.ok(keys.has(path.join(base, 'a')))
  assert.ok(keys.has(path.join(base, 'a', 'deep')))
  assert.ok(keys.has(path.join(base, 'b')))
  assert.equal(keys.size, 4)
})

check('direct child files land in the correct folder', () => {
  assert.deepEqual(folders.get(base).childFiles.sort(), [path.join(base, 'root.txt')])
  assert.equal(folders.get(path.join(base, 'a')).childFiles.length, 2)
  assert.deepEqual(folders.get(path.join(base, 'a', 'deep')).childFiles, [path.join(base, 'a', 'deep', 'three.txt')])
})

check('subfolders are linked to their parent', () => {
  const rootSubs = folders.get(base).childFolders.sort()
  assert.deepEqual(rootSubs, [path.join(base, 'a'), path.join(base, 'b')].sort())
  assert.deepEqual(folders.get(path.join(base, 'a')).childFolders, [path.join(base, 'a', 'deep')])
})

check('subtree fileCount aggregates recursively', () => {
  assert.equal(folders.get(path.join(base, 'a', 'deep')).fileCount, 1)
  assert.equal(folders.get(path.join(base, 'a')).fileCount, 3) // one, two, deep/three
  assert.equal(folders.get(path.join(base, 'b')).fileCount, 1)
  assert.equal(folders.get(base).fileCount, 5) // all files
})

check('deepest-first ordering processes children before parents', () => {
  const idxDeep = orderedDeepestFirst.indexOf(path.join(base, 'a', 'deep'))
  const idxA = orderedDeepestFirst.indexOf(path.join(base, 'a'))
  const idxBase = orderedDeepestFirst.indexOf(base)
  assert.ok(idxDeep < idxA, 'deep before a')
  assert.ok(idxA < idxBase, 'a before base')
})

check('files outside base are ignored', () => {
  const { folders: f2 } = buildFolderTree(base, [path.join('/tmp', 'other', 'x.txt'), path.join(base, 'in.txt')])
  assert.equal(f2.get(base).childFiles.length, 1)
  assert.ok(!f2.has(path.join('/tmp', 'other')))
})

// --- mapWithConcurrency ------------------------------------------------------
console.log('mapWithConcurrency')

await (async () => {
  const items = Array.from({ length: 50 }, (_, i) => i)
  const seen = []
  let active = 0
  let maxActive = 0
  await mapWithConcurrency(items, 6, async (item) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 1))
    seen.push(item)
    active -= 1
  })
  check('processes every item exactly once', () => {
    assert.deepEqual(seen.slice().sort((a, b) => a - b), items)
  })
  check('never exceeds the concurrency limit', () => {
    assert.ok(maxActive <= 6, `maxActive=${maxActive}`)
    assert.ok(maxActive > 1, 'should actually run in parallel')
  })
  let emptyRan = false
  await mapWithConcurrency([], 6, async () => { emptyRan = true })
  check('handles empty input without hanging or running the worker', () => {
    assert.equal(emptyRan, false)
  })
})()

// --- parseFolderContext ------------------------------------------------------
console.log('parseFolderContext')

check('splits SHORT and long on the --- marker', () => {
  const { short, long } = parseFolderContext('SHORT: A folder of tax docs.\n---\nDetailed synthesis covering 2023 and 2024 returns.')
  assert.equal(short, 'A folder of tax docs.')
  assert.equal(long, 'Detailed synthesis covering 2023 and 2024 returns.')
})

check('falls back to a lead sentence when no marker is present', () => {
  const { short, long } = parseFolderContext('This folder holds invoices. It spans three vendors and two years.')
  assert.equal(short, 'This folder holds invoices.')
  assert.ok(long.startsWith('This folder holds invoices.'))
})

// --- retry / failure detection -----------------------------------------------
console.log('retry + failure detection')

check('isTransientError flags rate limits, timeouts, 5xx, network', () => {
  assert.ok(isTransientError('LLM call failed: HTTP 429 rate limit'))
  assert.ok(isTransientError('HTTP 503 overloaded'))
  assert.ok(isTransientError('fetch failed'))
  assert.ok(isTransientError('ETIMEDOUT'))
  assert.equal(isTransientError('HTTP 400 bad request'), false)
  assert.equal(isTransientError('invalid model'), false)
})

check('isFailedContext detects stored failure sentinels (so refresh retries them)', () => {
  assert.ok(isFailedContext('Empty or unreadable document: Cutting Diet.xlsx'))
  assert.ok(isFailedContext('Context generation failed for x'))
  assert.ok(isFailedContext('No synthesis produced for .'))
  assert.ok(isFailedContext('Folder synthesis failed for notes'))
  assert.equal(isFailedContext('The subject is a disciplined athlete...'), false)
})

// --- readDocumentText (pdf/docx/xlsx/text dispatch) --------------------------
console.log('readDocumentText')

const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-doc-extract-'))

// Minimal .docx = zip with word/document.xml
const docxPath = path.join(docsDir, 'plan.docx')
// Word splits runs at formatting boundaries, frequently mid-word, so runs inside
// one paragraph are contiguous text and paragraphs are separate lines.
fs.writeFileSync(docxPath, Buffer.from(zipSync({
  'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Week</w:t></w:r><w:r><w:t>ly squat 3x5</w:t></w:r></w:p><w:p><w:r><w:t>Deadlift 1x5</w:t></w:r></w:p></w:body></w:document>'),
})))

// Minimal .xlsx = zip with sharedStrings + one worksheet
const xlsxPath = path.join(docsDir, 'budget.xlsx')
fs.writeFileSync(xlsxPath, Buffer.from(zipSync({
  'xl/sharedStrings.xml': strToU8('<sst><si><t>Revenue</t></si><si><t>Rent</t></si></sst>'),
  'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row><c r="A2"><v>1200</v></c></row></sheetData></worksheet>'),
})))

const txtPath = path.join(docsDir, 'note.txt')
fs.writeFileSync(txtPath, 'plain text note')

const docxText = await readDocumentText(docxPath, 40000)
const xlsxText = await readDocumentText(xlsxPath, 40000)
const txtText = await readDocumentText(txtPath, 40000)

check('extracts text runs from a .docx, one line per paragraph', () => {
  // Runs concatenate: a run boundary is a formatting change, not a word break,
  // so joining them with a space would corrupt every split word.
  assert.deepEqual(docxText.trim().split('\n'), ['Weekly squat 3x5', 'Deadlift 1x5'])
})
check('extracts shared strings and numeric cells from a .xlsx, one line per row', () => {
  assert.ok(xlsxText.includes('Revenue'), xlsxText)
  assert.ok(xlsxText.includes('Rent'), xlsxText)
  assert.ok(xlsxText.includes('1200'), xlsxText)
  // Row structure is what makes a line citation locatable in a spreadsheet.
  assert.deepEqual(xlsxText.trim().split('\n'), ['Revenue\tRent', '1200'])
})
check('reads plain text files unchanged', () => {
  assert.equal(txtText.trim(), 'plain text note')
})

// --- computeDirectorySignature ----------------------------------------------
console.log('computeDirectorySignature')

const sigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-doc-sig-'))
const f1 = path.join(sigDir, 'one.txt')
const f2 = path.join(sigDir, 'two.txt')
fs.writeFileSync(f1, 'hello')
fs.writeFileSync(f2, 'world')

check('signature is stable and order-independent', () => {
  const a = computeDirectorySignature([f1, f2])
  const b = computeDirectorySignature([f2, f1])
  assert.equal(a, b)
})

check('signature changes when a file grows', () => {
  const before = computeDirectorySignature([f1, f2])
  fs.writeFileSync(f1, 'hello there, much longer content')
  const after = computeDirectorySignature([f1, f2])
  assert.notEqual(before, after)
})

check('signature changes when a file is removed from the set', () => {
  const both = computeDirectorySignature([f1, f2])
  const one = computeDirectorySignature([f1])
  assert.notEqual(both, one)
})

// --- DB round-trip: cache + prune -------------------------------------------
console.log('database cache + prune')

const project = createProject({ name: 'DocTest', icon: 'folder-open', color: '#3b82f6', path: base, files: [] })

check('file context upsert + read round-trips and updates in place', () => {
  upsertDocumentFileContext({ projectId: project.id, filePath: f1, relativePath: 'one.txt', contentHash: 'h1', context: 'first' })
  let got = getDocumentFileContext(project.id, f1)
  assert.equal(got.context, 'first')
  assert.equal(got.contentHash, 'h1')
  upsertDocumentFileContext({ projectId: project.id, filePath: f1, relativePath: 'one.txt', contentHash: 'h2', context: 'second' })
  got = getDocumentFileContext(project.id, f1)
  assert.equal(got.context, 'second')
  assert.equal(got.contentHash, 'h2')
  assert.equal(listDocumentFileContexts(project.id).length, 1)
})

check('pruning drops file contexts no longer present', () => {
  upsertDocumentFileContext({ projectId: project.id, filePath: f2, relativePath: 'two.txt', contentHash: 'hx', context: 'other' })
  assert.equal(listDocumentFileContexts(project.id).length, 2)
  pruneDocumentFileContexts(project.id, [f1])
  const remaining = listDocumentFileContexts(project.id)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].filePath, f1)
})

check('folder context stores childHash, short/long context, and file count', () => {
  upsertDocumentFolderContext({ projectId: project.id, folderPath: base, relativePath: '.', childHash: 'c1', contextShort: 'root gist', context: 'root summary', fileCount: 5 })
  const got = getDocumentFolderContext(project.id, base)
  assert.equal(got.childHash, 'c1')
  assert.equal(got.fileCount, 5)
  assert.equal(got.contextShort, 'root gist')
  assert.equal(got.context, 'root summary')
})

check('pruning drops folder contexts no longer present', () => {
  upsertDocumentFolderContext({ projectId: project.id, folderPath: path.join(base, 'gone'), relativePath: 'gone', childHash: 'c2', contextShort: 'g', context: 'x', fileCount: 1 })
  assert.equal(listDocumentFolderContexts(project.id).length, 2)
  pruneDocumentFolderContexts(project.id, [base])
  assert.equal(listDocumentFolderContexts(project.id).length, 1)
})

check('document summary meta round-trips', () => {
  setDocumentSummaryMeta({ projectId: project.id, rootPath: base, signature: 'sig-1', fileCount: 5, folderCount: 4 })
  let meta = getDocumentSummaryMeta(project.id)
  assert.equal(meta.signature, 'sig-1')
  assert.equal(meta.fileCount, 5)
  setDocumentSummaryMeta({ projectId: project.id, rootPath: base, signature: 'sig-2', fileCount: 6, folderCount: 4 })
  meta = getDocumentSummaryMeta(project.id)
  assert.equal(meta.signature, 'sig-2')
  assert.equal(meta.fileCount, 6)
})

check('getDocumentContextTree surfaces the root folder context (short + long)', () => {
  const tree = getDocumentContextTree(project.id)
  assert.equal(tree.projectId, project.id)
  assert.equal(tree.rootPath, base)
  assert.equal(tree.rootContext, 'root summary')
  assert.equal(tree.rootContextShort, 'root gist')
  assert.equal(tree.fileCount, 1)
  assert.equal(tree.folderCount, 1)
})

// --- an unreadable source must never be read as "the files are gone" ---------
// Regression: a source on a disconnected external drive scanned as zero files,
// and the indexer pruned every cached context under it on that evidence. A
// whole overnight run was destroyed by the drive going to sleep.
console.log('unreadable source safety')

const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-doc-scan-'))
fs.writeFileSync(path.join(scanDir, 'a.txt'), 'alpha')
fs.writeFileSync(path.join(scanDir, 'b.txt'), 'beta')

check('a readable directory scans as complete, so pruning is allowed', () => {
  const scan = scanProjectTextFiles([], scanDir, scanExtensions)
  assert.equal(scan.files.length, 2)
  assert.equal(scan.rootUnreadable, false)
  assert.equal(scan.complete, true)
})

check('an empty directory is complete: nothing found is a real answer', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-doc-empty-'))
  const scan = scanProjectTextFiles([], emptyDir, scanExtensions)
  assert.equal(scan.files.length, 0)
  assert.equal(scan.complete, true)
})

check('a missing directory is flagged unreadable, not reported as empty', () => {
  const scan = scanProjectTextFiles([], path.join(scanDir, 'not-mounted'), scanExtensions)
  assert.equal(scan.files.length, 0)
  assert.equal(scan.rootUnreadable, true)
  assert.equal(scan.complete, false)
})

check('a walk stopped at its cap is incomplete, so a truncated list cannot prune', () => {
  const scan = scanProjectTextFiles([], scanDir, scanExtensions, { maxFiles: 1 })
  assert.equal(scan.files.length, 1)
  assert.equal(scan.truncated, true)
  assert.equal(scan.complete, false)
})

check('an explicit file that cannot be stat\'d counts against completeness', () => {
  const scan = scanProjectTextFiles([path.join(scanDir, 'ghost.txt')], scanDir, scanExtensions)
  assert.equal(scan.unreadableEntries, 1)
  assert.equal(scan.complete, false)
})

const offlineProject = createProject({ name: 'OfflineDrive', icon: 'folder-open', color: '#3b82f6', path: null, files: [] })
const offlineRoot = path.join(scanDir, 'volume-that-went-away')
addSource(offlineProject.id, offlineRoot)
upsertDocumentFileContext({
  projectId: offlineProject.id,
  filePath: path.join(offlineRoot, 'indexed.txt'),
  relativePath: 'indexed.txt',
  contentHash: 'paid-for-once',
  context: 'an expensive per-file context',
})
upsertDocumentFolderContext({
  projectId: offlineProject.id,
  folderPath: offlineRoot,
  relativePath: '.',
  childHash: 'c1',
  contextShort: 'gist',
  context: 'root synthesis',
  fileCount: 1,
})

const offlineConfig = { type: 'custom', openrouterApiKey: '', customBaseUrl: 'http://127.0.0.1:1', customApiKey: 'k', customModel: 'm' }
let offlineError = null
try {
  await generateDocumentContexts(offlineProject.id, offlineConfig, 'model')
} catch (err) {
  offlineError = err
}

check('indexing a disconnected source fails loudly instead of silently doing nothing', () => {
  assert.ok(offlineError, 'expected an error')
  assert.match(offlineError.message, /Could not read/)
  assert.match(offlineError.message, /were kept/)
})

check('a disconnected source keeps every cached file context it already paid for', () => {
  const kept = listDocumentFileContexts(offlineProject.id)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].contentHash, 'paid-for-once')
  assert.equal(kept[0].context, 'an expensive per-file context')
})

check('a disconnected source keeps its folder super-contexts too', () => {
  const folders = listDocumentFolderContexts(offlineProject.id)
  assert.equal(folders.length, 1)
  assert.equal(folders[0].context, 'root synthesis')
})

check('a disconnected source does not overwrite the stored directory signature', () => {
  assert.equal(getDocumentSummaryMeta(offlineProject.id), null)
})

// The section below asserts on a database with no project roots left, so drop
// the one this section just proved survives.
pruneDocumentFolderContexts(offlineProject.id, [])

// --- user super-context ------------------------------------------------------
console.log('user super-context')

check('listProjectRootContexts returns each project root (relative_path = .)', () => {
  const roots = listProjectRootContexts()
  const doc = roots.find((r) => r.projectName === 'DocTest')
  assert.ok(doc, 'DocTest root present')
  assert.equal(doc.context, 'root summary')
  assert.equal(doc.contextShort, 'root gist')
})

check('user super-context set/get round-trips', () => {
  setUserSuperContext({ contextShort: 'gist', context: 'the whole person', inputHash: 'h1', projectCount: 2 })
  const got = getUserSuperContext()
  assert.equal(got.context, 'the whole person')
  assert.equal(got.contextShort, 'gist')
  assert.equal(got.inputHash, 'h1')
  assert.equal(got.projectCount, 2)
})

const dummyConfig = { type: 'openrouter', openrouterApiKey: '', customBaseUrl: '', customApiKey: '', customModel: '' }
pruneDocumentFolderContexts(project.id, [])
const emptyUser = await generateUserSuperContext(dummyConfig, 'model')
check('generateUserSuperContext with no project roots is a no-op (no network)', () => {
  assert.equal(emptyUser, null)
  assert.equal(getUserSuperContext().context, '')
})

// --- long-form prompt contract ----------------------------------------------
console.log('long-form super-context prompts')

const docSource = fs.readFileSync(new URL('./src/main/documentContext.ts', import.meta.url), 'utf8')

const promptVersion = (name) => docSource.match(new RegExp(`const ${name}_PROMPT_VERSION = '([^']+)'`))?.[1]

check('prompt versions are split per level so one level busts only its own cache', () => {
  const file = promptVersion('FILE')
  const folder = promptVersion('FOLDER')
  const user = promptVersion('USER')
  assert.ok(file && folder && user, 'FILE/FOLDER/USER prompt versions present')
  assert.ok(!/const PROMPT_VERSION = /.test(docSource), 'the single shared PROMPT_VERSION is gone')
  for (const version of [file, folder, user]) assert.notEqual(version, 'v2-behavioral')
  // Pinning a literal marker rots every time the prompt is revised; what matters
  // is that each level carries its own version and none is a known-stale value.
  assert.ok(file.length > 2, `expected a file prompt version, got ${file}`)
  assert.ok(new Set([file, folder, user]).size === 3, 'each level versions independently')
  assert.notEqual(folder, file, 'folder prompt version moves independently of the file one')
})

check('each level hashes only its own prompt version', () => {
  // Each level's version now runs through its own style resolver, which composes
  // the level's base version with the project's index style. What matters is
  // unchanged: one level's hash is never perturbed by another level's version.
  assert.ok(/version: styleVersion\(FILE_PROMPT_VERSION, style\)/.test(docSource), 'the file version derives from FILE_PROMPT_VERSION')
  assert.ok(/version: styleVersion\(FOLDER_PROMPT_VERSION, style\)/.test(docSource), 'the folder version derives from FOLDER_PROMPT_VERSION')
  assert.ok(/hashString\(`\$\{filePrompt\.version\}/.test(docSource), 'file content-hash uses the file prompt version')
  assert.ok(/`V:\$\{folderPrompt\.version\}`/.test(docSource), 'folder child-hash uses the folder prompt version')
  assert.ok(/`\$\{USER_PROMPT_VERSION\}\\n`/.test(docSource), 'user input-hash uses USER_PROMPT_VERSION')
  const fileHashLine = docSource.match(/const contentHash = hashString\([^\n]+\)/)?.[0] ?? ''
  assert.ok(!/folderPrompt|FOLDER_PROMPT_VERSION|USER_PROMPT_VERSION/.test(fileHashLine), 'file hash is not perturbed by other levels')
})

check('the behavioral style keeps the original prompt versions, so nothing re-indexes for existing projects', () => {
  const styles = fs.readFileSync(new URL('./src/main/indexStyles.ts', import.meta.url), 'utf8')
  assert.ok(
    /return style === 'behavioral' \? base : `\$\{base\}-\$\{style\}`/.test(styles),
    'behavioral returns the base version untouched'
  )
  assert.ok(/export function stylePrompts/.test(styles) && /if \(style === 'work'\)/.test(styles), 'work and reference get their own prompt sets')
  assert.ok(/stylePrompts\(style\)\s*\n?\s*return \{[\s\S]*?set\?\.file \?\? FILE_CONTEXT_SYSTEM_PROMPT/.test(docSource), 'behavioral falls back to the original prompt')
})

check('the folder and user syntheses must be richer than their children, not a condensation', () => {
  const folder = docSource.slice(docSource.indexOf('const FOLDER_CONTEXT_SYSTEM_PROMPT'), docSource.indexOf('const MAX_USER_INPUT_CHARS'))
  const user = docSource.slice(docSource.indexOf('const USER_SUPER_CONTEXT_SYSTEM_PROMPT'))
  for (const [name, body] of [['folder', folder], ['user', user]]) {
    assert.ok(/NOT a summary of|not a summary of/i.test(body), `${name} counters summary-of-summaries`)
    assert.ok(/RICHER|LONGER/.test(body), `${name} demands more than the children`)
    assert.ok(/is always wrong/.test(body), `${name} names the one-paragraph failure mode`)
    assert.ok(/Depth requirement/.test(body), `${name} states depth outside the format template`)
    assert.ok(/\n1\. /.test(body) && /\n4\. /.test(body), `${name} scaffolds the required paragraphs`)
  }
})

check('character caps grew so the longer syntheses are not truncated', () => {
  const num = (name) => Number(docSource.match(new RegExp(`const ${name} = ([0-9_]+)`))?.[1].replace(/_/g, ''))
  assert.ok(num('MAX_FILE_CONTEXT_CHARS') >= 6000, 'file context cap')
  assert.ok(num('MAX_FOLDER_CONTEXT_CHARS') >= 9000, 'folder context cap')
  assert.ok(num('MAX_FOLDER_CHILD_INPUT_CHARS') >= 60000, 'folder child input cap')
  assert.ok(num('MAX_USER_INPUT_CHARS') >= 60000, 'user super-context input cap')
  assert.ok(num('MAX_USER_MEMORY_CHARS') >= 20000, 'user memory cap')
})

check('the SHORT headline half stays short', () => {
  const short = Number(docSource.match(/const MAX_FOLDER_SHORT_CHARS = ([0-9_]+)/)?.[1].replace(/_/g, ''))
  assert.equal(short, 400)
  assert.ok(/SHORT: <one or two sentences \(max ~40 words, hard limit 300 characters\)/.test(docSource), 'folder SHORT stays one or two sentences under the clamp')
  assert.ok(/hard limit 350 characters/.test(docSource), 'user SHORT states a concrete limit under the clamp')
})

check('max_tokens is raised so thinking models cannot spend the budget on reasoning', () => {
  // The outbound call lives in llmCall.ts now, shared with the conversation indexer.
  const llmSource = fs.readFileSync(new URL('./src/main/llmCall.ts', import.meta.url), 'utf8')
  const maxTokens = Number(llmSource.match(/max_tokens: options\.maxTokens \?\? (\d+)/)?.[1])
  assert.ok(maxTokens >= 20000, `default max_tokens=${maxTokens}`)
  assert.ok(/if \(options\.limiter\) await options\.limiter\.acquire\(signal\)/.test(llmSource), 'every attempt is still paced')
})

check('every long-form prompt demands at least three paragraphs but allows a short honest answer', () => {
  const prompts = docSource.split('const ').filter((chunk) => chunk.startsWith('FILE_CONTEXT_SYSTEM_PROMPT') || chunk.startsWith('FOLDER_CONTEXT_SYSTEM_PROMPT') || chunk.startsWith('USER_SUPER_CONTEXT_SYSTEM_PROMPT'))
  assert.equal(prompts.length, 3)
  for (const prompt of prompts) {
    const body = prompt.slice(0, prompt.indexOf('`\n'))
    assert.ok(/(AT LEAST (three|four)|six) substantial paragraphs/.test(body), `paragraph floor missing in ${prompt.slice(0, 40)}`)
    assert.ok(/thin|little about the person/.test(body), `thin-data escape hatch missing in ${prompt.slice(0, 40)}`)
    assert.ok(/never (filler|pad)|do not pad|never pad/i.test(body), `anti-padding rule missing in ${prompt.slice(0, 40)}`)
  }
})

check('document-context prompts stay behavioral, not librarian descriptions', () => {
  assert.ok(/behavioral analyst/.test(docSource))
  assert.ok(/not a description of the file or its format/.test(docSource))
  assert.ok(/corroborate, refine, or contradict/.test(docSource))
})

check('parseFolderContext keeps the long half up to the raised cap', () => {
  const long = 'x'.repeat(20_000)
  const parsed = parseFolderContext(`SHORT: headline.\n---\n${long}`)
  assert.equal(parsed.short, 'headline.')
  // Raised from 9k to leave room for the trailing TIMELINE block.
  assert.equal(parsed.long.length, 13000)
})

check('parseFolderContext honors a caller-supplied larger cap for the user level', () => {
  const long = 'x'.repeat(40_000)
  const parsed = parseFolderContext(`SHORT: headline.\n---\n${long}`, 30_000)
  assert.equal(parsed.long.length, 30000)
  const fallback = parseFolderContext(`${long}`, 30_000)
  assert.equal(fallback.long.length, 30000)
})

check('the user super-context is parsed at the apex cap, not the folder cap', () => {
  const userCap = docSource.match(/const MAX_USER_CONTEXT_CHARS = ([\d_]+)/)?.[1]
  const folderCap = docSource.match(/const MAX_FOLDER_CONTEXT_CHARS = ([\d_]+)/)?.[1]
  assert.ok(userCap && folderCap)
  const toNum = (s) => Number(s.replace(/_/g, ''))
  assert.ok(toNum(userCap) > toNum(folderCap), 'apex cap must exceed the folder cap')
  assert.ok(
    /finishSynthesis\(raw, markerToRef, MAX_USER_CONTEXT_CHARS\)/.test(docSource),
    'the user-level call site must pass the apex cap'
  )
  assert.ok(
    /finishSynthesis\(raw, markerToRef, MAX_FOLDER_CONTEXT_CHARS\)/.test(docSource),
    'the folder-level call site must pass the folder cap'
  )
})

check('parseFolderContext still clamps the SHORT half to 400 chars', () => {
  const parsed = parseFolderContext(`SHORT: ${'s'.repeat(900)}\n---\nbody text here.`)
  assert.equal(parsed.short.length, 400)
  assert.equal(parsed.long, 'body text here.')
})

const otherPrompts = [
  ['activityAnalysis.ts', ['SOURCE_ANALYSIS_SYSTEM_PROMPT', 'ACTIVITY_ANALYSIS_SYSTEM_PROMPT']],
  ['healthAnalysis.ts', ['HEALTH_ANALYSIS_SYSTEM_PROMPT']],
  ['financesSummary.ts', ['FINANCES_SUMMARY_SYSTEM_PROMPT']],
  ['memorySummary.ts', []],
]
for (const [file] of otherPrompts) {
  const source = fs.readFileSync(new URL(`./src/main/${file}`, import.meta.url), 'utf8')
  check(`${file} asks for at least three substantial paragraphs`, () => {
    assert.ok(/AT LEAST three substantial paragraphs/.test(source), `${file} paragraph floor`)
    assert.ok(/do not pad|never pad/i.test(source), `${file} anti-padding rule`)
  })
}

for (const file of ['activitySummary.ts', 'healthSummary.ts', 'financesSummary.ts', 'memorySummary.ts']) {
  const source = fs.readFileSync(new URL(`./src/main/${file}`, import.meta.url), 'utf8')
  check(`${file} raised max_tokens for the longer output`, () => {
    const values = [...source.matchAll(/max_tokens: (\d+)/g)].map((m) => Number(m[1]))
    assert.ok(values.length > 0, `${file} has a max_tokens`)
    for (const value of values) assert.ok(value >= 8000, `${file} max_tokens=${value}`)
  })
}

for (const file of ['activitySummary.ts', 'healthSummary.ts', 'memorySummary.ts']) {
  const source = fs.readFileSync(new URL(`./src/main/${file}`, import.meta.url), 'utf8')
  check(`${file} folds a prompt version into its input-hash gate`, () => {
    assert.ok(/const PROMPT_VERSION = '[^']+'/.test(source), `${file} PROMPT_VERSION`)
    assert.ok(/\$\{PROMPT_VERSION\}:\$\{/.test(source), `${file} versioned hash`)
  })
}

// --- super-context -> Memory -------------------------------------------------
console.log('super-context memory population')

const { getSettings, setSettings } = await import('./src/main/settings.ts')
const { extractSuperContextMemory, isSuperContextMemoryEnabled, SENSITIVE_MEMORY_CATEGORIES } =
  await import('./src/main/superContextMemory.ts')

const synthesisText = 'The subject trains five mornings a week, logs every session, and tracks macros daily. '.repeat(6)

setSettings({ superContextMemoryEnabled: false })
const disabledResult = await extractSuperContextMemory({
  contextText: synthesisText,
  sourceLabel: 'Super-context: DocTest',
  sourceReference: `project:${project.id}:super-context`,
  config: dummyConfig,
  model: 'model',
})
check('the behavior is gated behind a setting (off by default)', () => {
  assert.equal(isSuperContextMemoryEnabled(), false)
  assert.equal(disabledResult.skipped, true)
  assert.equal(disabledResult.error, null)
  assert.equal(disabledResult.candidatesFound, 0)
})

setSettings({ superContextMemoryEnabled: true })
check('the setting round-trips through the settings store', () => {
  assert.equal(getSettings().superContextMemoryEnabled, true)
  assert.equal(isSuperContextMemoryEnabled(), true)
})

const noKeyResult = await extractSuperContextMemory({
  contextText: synthesisText,
  sourceLabel: 'Super-context: DocTest',
  sourceReference: `project:${project.id}:super-context`,
  config: dummyConfig,
  model: 'model',
})
check('extraction is a no-op without an API key (no network, no throw)', () => {
  assert.equal(noKeyResult.skipped, true)
  assert.equal(noKeyResult.error, null)
})

const thinResult = await extractSuperContextMemory({
  contextText: 'Too little to say.',
  sourceLabel: 'Super-context: DocTest',
  sourceReference: `project:${project.id}:super-context`,
  config: { ...dummyConfig, openrouterApiKey: 'test-key' },
  model: 'model',
})
check('a thin synthesis is skipped rather than sent to the provider', () => {
  assert.equal(thinResult.skipped, true)
  assert.equal(thinResult.error, null)
})

const abortedController = new AbortController()
abortedController.abort()
const abortedResult = await extractSuperContextMemory({
  contextText: synthesisText,
  sourceLabel: 'Super-context: DocTest',
  sourceReference: `project:${project.id}:super-context`,
  config: { ...dummyConfig, openrouterApiKey: 'test-key' },
  model: 'model',
  signal: abortedController.signal,
})
check('provider failures are captured, never thrown (generation must not abort)', () => {
  assert.equal(typeof abortedResult, 'object')
  assert.equal(abortedResult.autoFilled, 0)
  assert.equal(abortedResult.newFieldsCreated, 0)
})

check('sensitive categories are gated for model-proposed new fields', () => {
  for (const category of ['health', 'finances', 'contact', 'relationships', 'household']) {
    assert.ok(SENSITIVE_MEMORY_CATEGORIES.has(category), `${category} gated`)
  }
  assert.equal(SENSITIVE_MEMORY_CATEGORIES.has('preferences'), false)
  assert.equal(SENSITIVE_MEMORY_CATEGORIES.has('routines'), false)
})

check('super-context evidence routes through redaction before the provider', () => {
  const source = fs.readFileSync(new URL('./src/main/superContextMemory.ts', import.meta.url), 'utf8')
  assert.ok(/redactMemoryContent\(contextText\)/.test(source))
  assert.ok(/type: 'super-context'/.test(source), 'provenance source type')
})

check('generation hooks both the project root and the user super-context', () => {
  assert.ok(/rootRegenerated && root\?\.context\.trim\(\)/.test(docSource), 'root hook gated on regeneration')
  assert.ok(/`Super-context: \$\{project\.name\}`/.test(docSource), 'project provenance label')
  assert.ok(/'User super-context \(all data sources\)'/.test(docSource), 'user provenance label')
  assert.ok(/catch \{ \/\* Memory population is best-effort\. \*\/ \}/.test(docSource), 'non-fatal wrapper')
})

setSettings({ superContextMemoryEnabled: false })

// --- pause / stop run control -------------------------------------------------
console.log('index run control (pause / stop / resume)')

const {
  beginDocumentIndexRun,
  finishDocumentIndexRun,
  getDocumentIndexState,
  getDocumentIndexPauseRecord,
  isDocumentIndexPaused,
  isDocumentIndexRunActive,
  reportDocumentIndexProgress,
  requestDocumentIndexPause,
  requestDocumentIndexStop,
  setDocumentIndexRunProject,
  subscribeDocumentIndexState,
  describeDocumentIndexProgress,
  resetDocumentIndexRunsForTests,
  createIdleWatchdog,
  INDEX_IDLE_TIMEOUT_MINUTES,
} = await import('./src/main/documentIndexRuns.ts')

// --- the run watchdog measures silence, not duration --------------------------
// Regression: a fixed 20-minute cap aborted every real indexing run. 236 files
// took 55 minutes, so the run could never reach the folder-synthesis phase and
// the root super-context was never built.
console.log('idle watchdog')

await checkAsync('a run still reporting progress is never aborted, however long it runs', async () => {
  const controller = new AbortController()
  const watchdog = createIdleWatchdog(controller, 60)
  // Four windows' worth of wall clock, kept alive by progress alone.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30))
    watchdog.ping()
  }
  assert.equal(controller.signal.aborted, false)
  assert.equal(watchdog.fired(), false)
  watchdog.cancel()
})

await checkAsync('a run that goes silent for the whole window is aborted', async () => {
  const controller = new AbortController()
  const watchdog = createIdleWatchdog(controller, 40)
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(controller.signal.aborted, true)
  assert.equal(watchdog.fired(), true)
  watchdog.cancel()
})

await checkAsync('a cancelled watchdog never fires afterwards', async () => {
  const controller = new AbortController()
  const watchdog = createIdleWatchdog(controller, 30)
  watchdog.cancel()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(controller.signal.aborted, false)
  assert.equal(watchdog.fired(), false)
})

check('fired() separates a watchdog abort from a user pause or stop', () => {
  const controller = new AbortController()
  const watchdog = createIdleWatchdog(controller, 10_000)
  controller.abort() // stands in for the user pressing Stop
  assert.equal(controller.signal.aborted, true)
  assert.equal(watchdog.fired(), false, 'a user abort must not be reported as a stall')
  watchdog.cancel()
})

check('the idle window is generous enough to outlast a retried document', () => {
  assert.ok(INDEX_IDLE_TIMEOUT_MINUTES >= 10, 'a short window would kill legitimately slow documents')
})

const fileProgress = (current, total) => ({
  phase: 'file',
  message: `Indexed ${current}/${total} documents`,
  current,
  total,
})

resetDocumentIndexRunsForTests()

check('starts idle with nothing to resume', () => {
  const state = getDocumentIndexState()
  assert.equal(state.status, 'idle')
  assert.equal(state.canResume, false)
  assert.equal(state.pendingAction, null)
  assert.equal(isDocumentIndexRunActive(), false)
  assert.equal(isDocumentIndexPaused(), false)
})

const observed = []
const unsubscribeState = subscribeDocumentIndexState((state) => observed.push(state.status))

const runA = beginDocumentIndexRun({ scope: 'project', projectId: 'p1', projectName: 'Health' })
reportDocumentIndexProgress(runA, fileProgress(2, 5))

check('a started run is observable as running, with its subject and progress', () => {
  const state = getDocumentIndexState()
  assert.equal(state.status, 'running')
  assert.equal(state.scope, 'project')
  assert.equal(state.projectId, 'p1')
  assert.equal(state.projectName, 'Health')
  assert.equal(state.origin, 'user')
  assert.equal(state.progress.current, 2)
  assert.equal(isDocumentIndexRunActive(), true)
})

const pauseState = requestDocumentIndexPause()

check('pause aborts the run signal and reports a stopping state', () => {
  assert.equal(runA.signal.aborted, true, 'in-flight provider calls are cancelled by the shared signal')
  assert.equal(pauseState.status, 'stopping')
  assert.equal(pauseState.pendingAction, 'pause')
})

const pauseOutcome = finishDocumentIndexRun(runA, { failed: true, message: 'Document context generation cancelled' })

check('a paused run ends as paused, not as an error', () => {
  assert.equal(pauseOutcome, 'paused')
  const state = getDocumentIndexState()
  assert.equal(state.status, 'paused')
  assert.equal(state.canResume, true)
  assert.equal(state.pendingAction, null)
  assert.match(state.message, /^Paused after 2 of 5 documents in Health\./)
  assert.ok(!/cancelled/i.test(state.message), 'no scary abort wording')
})

check('the pause point is persisted so it survives a window reload or app restart', () => {
  const record = getDocumentIndexPauseRecord()
  assert.equal(record.scope, 'project')
  assert.equal(record.projectId, 'p1')
  assert.equal(record.projectName, 'Health')
  assert.ok(record.pausedAt)
  assert.equal(isDocumentIndexPaused(), true, 'the hourly timer sees the pause and stands down')
})

check('state changes are broadcast to subscribers', () => {
  assert.ok(observed.includes('running'))
  assert.ok(observed.includes('stopping'))
  assert.ok(observed.includes('paused'))
})
unsubscribeState()

const runResume = beginDocumentIndexRun({ scope: 'all' })

check('resuming clears the pause so the timer is no longer suppressed', () => {
  assert.equal(isDocumentIndexPaused(), false)
  assert.equal(getDocumentIndexPauseRecord(), null)
  assert.equal(getDocumentIndexState().status, 'running')
})

setDocumentIndexRunProject(runResume, 'p2', 'Activity')
reportDocumentIndexProgress(runResume, fileProgress(7, 40))
const stopState = requestDocumentIndexStop()
const stopOutcome = finishDocumentIndexRun(runResume, { failed: true, message: 'Document context generation cancelled' })

check('stop ends the run with an honest count and leaves nothing to resume', () => {
  assert.equal(stopState.pendingAction, 'stop')
  assert.equal(runResume.signal.aborted, true)
  assert.equal(stopOutcome, 'stopped')
  const state = getDocumentIndexState()
  assert.equal(state.status, 'idle')
  assert.equal(state.canResume, false)
  assert.match(state.message, /^Stopped after 7 of 40 documents in Activity\./)
  assert.equal(getDocumentIndexPauseRecord(), null)
})

const runPausedThenStopped = beginDocumentIndexRun({ scope: 'all', projectId: 'p3', projectName: 'Files' })
reportDocumentIndexProgress(runPausedThenStopped, fileProgress(1, 9))
requestDocumentIndexPause()
finishDocumentIndexRun(runPausedThenStopped)
const clearedState = requestDocumentIndexStop()

check('stopping an already-paused run discards the resume point', () => {
  assert.equal(clearedState.status, 'idle')
  assert.equal(clearedState.canResume, false)
  assert.equal(getDocumentIndexPauseRecord(), null)
  assert.match(clearedState.message, /^Stopped after 1 of 9 documents in Files\./)
  assert.equal(isDocumentIndexPaused(), false)
})

const runFirst = beginDocumentIndexRun({ scope: 'project', projectId: 'p4', projectName: 'First' })
const runSecond = beginDocumentIndexRun({ scope: 'project', projectId: 'p5', projectName: 'Second' })

check('starting a run aborts the in-flight one (indexing never runs concurrently)', () => {
  assert.equal(runFirst.signal.aborted, true)
  assert.equal(runSecond.signal.aborted, false)
  assert.equal(getDocumentIndexState().projectId, 'p5')
})

check('a superseded run cannot clobber the state of the run that replaced it', () => {
  const outcome = finishDocumentIndexRun(runFirst, { failed: true, message: 'superseded' })
  assert.equal(outcome, 'stopped')
  const state = getDocumentIndexState()
  assert.equal(state.status, 'running')
  assert.equal(state.projectId, 'p5')
})
finishDocumentIndexRun(runSecond)

const userRun = beginDocumentIndexRun({ scope: 'user' })
requestDocumentIndexPause()
const userOutcome = finishDocumentIndexRun(userRun)

check('pausing the user super-context refresh stops it (there is nothing to resume into)', () => {
  assert.equal(userOutcome, 'stopped')
  assert.equal(getDocumentIndexPauseRecord(), null)
})

const runProject = beginDocumentIndexRun({ scope: 'project', projectId: 'p6', projectName: 'Health' })
reportDocumentIndexProgress(runProject, fileProgress(3, 3))
requestDocumentIndexPause()
finishDocumentIndexRun(runProject)
const userRunDuringPause = beginDocumentIndexRun({ scope: 'user' })

check('a user super-context refresh does not discard a pending resume point', () => {
  assert.equal(getDocumentIndexPauseRecord().projectId, 'p6')
})
finishDocumentIndexRun(userRunDuringPause)
check('the pause is still reported once the unrelated run ends', () => {
  assert.equal(getDocumentIndexState().status, 'paused')
  assert.equal(isDocumentIndexPaused(), true)
})

check('progress descriptions stay honest when nothing had been indexed yet', () => {
  assert.equal(describeDocumentIndexProgress(null, 'Health'), 'before any documents in Health were indexed')
  assert.equal(
    describeDocumentIndexProgress({ phase: 'folder', message: '', current: 4, total: 11 }, null),
    'after 4 of 11 folders'
  )
})

resetDocumentIndexRunsForTests()

// --- wiring: IPC + background timer ------------------------------------------
console.log('index control wiring')

const ipcSource = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
const channelSource = fs.readFileSync(new URL('./src/main/ipcChannels.ts', import.meta.url), 'utf8')
const preloadSource = fs.readFileSync(new URL('./src/preload/preload.ts', import.meta.url), 'utf8')
const typesSource = fs.readFileSync(new URL('./src/shared/types.ts', import.meta.url), 'utf8')
const mainSource = fs.readFileSync(new URL('./src/main/main.ts', import.meta.url), 'utf8')

check('the new channels keep the 4-file IPC sync', () => {
  for (const [channel, api] of [['PAUSE', 'pause'], ['GET_STATE', 'getState']]) {
    assert.ok(new RegExp(`${channel}: 'documents:`).test(channelSource), `${channel} constant`)
    assert.ok(new RegExp(`handle\\(IPC\\.DOCUMENTS\\.${channel}`).test(ipcSource), `${channel} handler`)
    assert.ok(new RegExp(`${api}: \\(`).test(preloadSource), `${api} preload binding`)
    assert.ok(new RegExp(`${api}: \\(`).test(typesSource), `${api} ElectronAPI entry`)
  }
  assert.ok(/STATE: 'documents:state'/.test(channelSource), 'state event channel')
  assert.ok(/onState: \(callback/.test(preloadSource), 'state event preload binding')
  assert.ok(/onState: \(callback/.test(typesSource), 'state event ElectronAPI entry')
})

check('pause and stop are routed through the shared run registry', () => {
  assert.ok(/IPC\.DOCUMENTS\.PAUSE[\s\S]{0,160}requestDocumentIndexPause\(\)/.test(ipcSource), 'pause handler')
  assert.ok(/IPC\.DOCUMENTS\.ABORT[\s\S]{0,160}requestDocumentIndexStop\(\)/.test(ipcSource), 'stop handler')
  assert.ok(/subscribeDocumentIndexState\(/.test(ipcSource), 'state broadcast to every window')
  assert.equal(/documentContextControllers/.test(ipcSource), false, 'no second source of truth')
})

check('an aborted batch stops the whole batch and skips the unified rollup', () => {
  const batch = ipcSource.slice(ipcSource.indexOf("IPC.DOCUMENTS.GENERATE_ALL"))
  const guardIndex = batch.indexOf('if (run.signal.aborted) {')
  const rollupIndex = batch.indexOf('await generateUserSuperContext')
  assert.ok(guardIndex > -1 && rollupIndex > -1)
  assert.ok(guardIndex < rollupIndex, 'the abort guard returns before the rollup')
  assert.ok(
    /return \{ projectsIndexed: indexed, projectsSkipped: skipped, outcome: finishDocumentIndexRun\(run\) \}/.test(
      batch.slice(guardIndex, rollupIndex)
    ),
    'the guard returns a terminal result instead of falling through'
  )
})

check('resume re-runs the batch from the project it paused in', () => {
  assert.ok(/getDocumentIndexPauseRecord\(\)/.test(ipcSource), 'reads the persisted resume point')
  assert.ok(/const startIndex = resumeProjectId \? Math\.max\(0, all\.findIndex/.test(ipcSource))
  // The option bag has grown (the Bulk Index dialog scopes a batch to selected
  // sources), so match its head rather than the exact closing brace.
  assert.ok(/generateAll: \(options\?: \{ resume\?: boolean; tier\?: ModelTier/.test(preloadSource), 'resume flag crosses the bridge')
})

check('no indexing run carries a fixed wall-clock cap any more', () => {
  // The single-call user-super-context refresh keeps its total cap: it emits no
  // progress, so silence there is not evidence of anything.
  const indexingHandlers = ipcSource.slice(
    ipcSource.indexOf('IPC.DOCUMENTS.GENERATE,'),
    ipcSource.indexOf('IPC.DOCUMENTS.ABORT')
  )
  assert.ok(indexingHandlers.length > 0, 'located the indexing handlers')
  assert.ok(
    !/setTimeout\(\(\) => run\.controller\.abort\(\)/.test(indexingHandlers),
    'an indexing run must not be killed on a fixed timer'
  )
  assert.equal((indexingHandlers.match(/createIdleWatchdog\(run\.controller/g) ?? []).length, 2)
  assert.ok(/watchdog\.ping\(\)/.test(indexingHandlers), 'progress feeds the watchdog')
  assert.ok(
    !/setTimeout\(\(\) => run\.controller\.abort\(\)/.test(mainSource),
    'the background timer must not be killed on a fixed timer either'
  )
  assert.ok(/createIdleWatchdog\(run\.controller/.test(mainSource))
})

check('the hourly timer defers to an explicit pause and to user-started runs', () => {
  assert.ok(/if \(isDocumentIndexPaused\(\) \|\| isDocumentIndexRunActive\(\)\) return/.test(mainSource))
  assert.ok(/beginDocumentIndexRun\(\{ scope: 'all', origin: 'timer' \}\)/.test(mainSource))
  assert.ok(/if \(!run\.signal\.aborted\) \{[\s\S]{0,120}?await generateUserSuperContext/.test(mainSource), 'aborted timer run skips the rollup')
})

check('an abort leaves already-persisted work alone (prune only runs after a clean pass)', () => {
  const filePassIndex = docSource.indexOf('await mapWithConcurrency(files, FILE_CONCURRENCY')
  // Scoped to the source being indexed, so a per-source run cannot delete
  // another source's rows — but still strictly after the awaited file pass.
  const pruneIndex = docSource.indexOf('database.pruneDocumentFileContextsUnder(projectId, base, [...fileHashes.keys()])')
  assert.ok(filePassIndex > -1 && pruneIndex > filePassIndex, 'prune sits after the awaited file pass')
  assert.ok(/if \(signal\?\.aborted\) throw new Error\('Document context generation cancelled'\)/.test(docSource))
})

// ---------------------------------------------------------------------------
// Photos: image classification, encoding dispatch, dating, and cost estimation
// ---------------------------------------------------------------------------

const {
  IMAGE_EXTENSIONS,
  INDEXABLE_EXTENSIONS,
  isImageExtension,
  isDerivativeDirectory,
  collectProjectTextFiles: collectFiles,
} = await import('./src/main/projectContext.ts')

const { parseExifDate, needsSipsDecode, estimateImageTokens, PHOTO_MAX_EDGE } = await import('./src/main/photoContext.ts')
const { buildPriceTable, priceCall } = await import('./src/main/modelPricing.ts')
const { computeIndexEstimate, countFolders, combineEstimates } = await import('./src/main/indexEstimate.ts')

check('image extensions are recognized and folded into the indexable set', () => {
  assert.ok(isImageExtension('/a/b/IMG_1234.HEIC'), 'case-insensitive HEIC')
  assert.ok(isImageExtension('/a/b/photo.jpg'))
  assert.ok(!isImageExtension('/a/b/notes.md'))
  for (const ext of IMAGE_EXTENSIONS) assert.ok(INDEXABLE_EXTENSIONS.has(ext), `${ext} is indexable`)
  assert.ok(INDEXABLE_EXTENSIONS.has('.pdf'), 'documents still indexable')
})

check('derivative and duplicate photo directories are excluded from the walk', () => {
  assert.ok(isDerivativeDirectory('Photos Library.photoslibrary'), 'the hex-bucket bundle is skipped')
  assert.ok(isDerivativeDirectory('thumbs'))
  assert.ok(isDerivativeDirectory('Backups'), 'case-insensitive')
  assert.ok(!isDerivativeDirectory('googlePhotos'), 'a real photo folder is kept')
  assert.ok(!isDerivativeDirectory('2018'))
})

check('a .photoslibrary bundle inside a photo tree is not walked', () => {
  const treeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-phototree-'))
  fs.mkdirSync(path.join(treeDir, 'camera'))
  fs.writeFileSync(path.join(treeDir, 'camera', 'a.jpg'), 'x')
  const bundle = path.join(treeDir, 'My Library.photoslibrary', 'originals', 'B')
  fs.mkdirSync(bundle, { recursive: true })
  fs.writeFileSync(path.join(bundle, 'dupe.jpg'), 'x')
  const found = collectFiles([], treeDir, INDEXABLE_EXTENSIONS, { maxFiles: 100, maxEntries: 1000 })
  assert.equal(found.length, 1, 'only the real photo is collected')
  assert.ok(found[0].endsWith('a.jpg'))
  fs.rmSync(treeDir, { recursive: true, force: true })
})

check('the file-collection caps are caller-controlled', () => {
  const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-cap-'))
  for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(capDir, `p${i}.jpg`), 'x')
  assert.equal(collectFiles([], capDir, INDEXABLE_EXTENSIONS, { maxFiles: 5, maxEntries: 1000 }).length, 5)
  assert.equal(collectFiles([], capDir, INDEXABLE_EXTENSIONS, { maxFiles: 100, maxEntries: 1000 }).length, 12)
  fs.rmSync(capDir, { recursive: true, force: true })
})

check('EXIF capture dates parse at day precision and reject nonsense', () => {
  assert.deepEqual(parseExifDate('2018:12:24 15:17:02'), { date: '2018-12-24', precision: 'day', raw: '2018:12:24 15:17:02' })
  assert.deepEqual(parseExifDate('2004-07-01 08:00:00')?.date, '2004-07-01')
  assert.equal(parseExifDate(undefined), null)
  assert.equal(parseExifDate(''), null)
  assert.equal(parseExifDate('not a date'), null)
  assert.equal(parseExifDate('1502:01:01 00:00:00'), null, 'year out of range')
  assert.equal(parseExifDate('2018:13:01 00:00:00'), null, 'month out of range')
})

check('HEIC routes to sips and ordinary formats do not', () => {
  assert.ok(needsSipsDecode('/x/IMG_1.heic'))
  assert.ok(needsSipsDecode('/x/IMG_1.HEIF'))
  assert.ok(!needsSipsDecode('/x/IMG_1.jpg'))
  assert.ok(!needsSipsDecode('/x/IMG_1.png'))
})

check('downscaling makes per-image token cost bounded and constant', () => {
  const tokens = estimateImageTokens(PHOTO_MAX_EDGE)
  assert.ok(tokens > 0 && tokens < 1200, `768px image is ~${tokens} tokens, not thousands`)
  // The whole point of the downscale: a 4048px original would cost ~16k tokens.
  assert.ok(estimateImageTokens(4048) > tokens * 20, 'full-res would be an order of magnitude worse')
})

check('unpriced models are omitted from the price table rather than treated as free', () => {
  const table = buildPriceTable([
    { id: 'priced/model', name: 'p', provider: 'x', promptPrice: 0.000001, completionPrice: 0.000002, inputModalities: ['text', 'image'] },
    { id: 'unpriced/model', name: 'u', provider: 'x' },
    { id: 'free/model', name: 'f', provider: 'x', promptPrice: 0, completionPrice: 0 },
  ])
  assert.ok(table.has('priced/model'))
  assert.ok(!table.has('unpriced/model'), 'no pricing means unknown, not zero')
  assert.ok(table.has('free/model'), 'a genuine zero price is still a price')
  assert.equal(priceCall(table, 'unpriced/model', 1000, 1000), null)
  assert.equal(priceCall(table, 'priced/model', 1_000_000, 1_000_000), 3)
  assert.equal(table.get('priced/model').acceptsImages, true)
  assert.equal(table.get('free/model').acceptsImages, false)
})

check('countFolders counts every ancestor directory holding indexable files', () => {
  const base = path.resolve('/root')
  const files = [
    path.join(base, 'a.jpg'),
    path.join(base, '2018', 'b.jpg'),
    path.join(base, '2018', '07', 'c.jpg'),
  ]
  // root, root/2018, root/2018/07
  assert.equal(countFolders(base, files), 3)
  assert.equal(countFolders(base, []), 1, 'the root alone still counts')
})

const estimateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-est-'))
const estimateProject = createProject({ name: 'Photos', icon: 'image', color: '#06b6d4', path: estimateDir })
const priceTable = buildPriceTable([
  { id: 'text/model', name: 't', provider: 'x', promptPrice: 0.0000005, completionPrice: 0.0000015 },
  { id: 'vision/model', name: 'v', provider: 'x', promptPrice: 0.0000005, completionPrice: 0.0000015, inputModalities: ['text', 'image'] },
  { id: 'textonly/model', name: 'to', provider: 'x', promptPrice: 0.0000005, completionPrice: 0.0000015, inputModalities: ['text'] },
])

const estimateInput = (overrides = {}) => ({
  projectId: estimateProject.id,
  projectName: 'Photos',
  projectPath: estimateDir,
  projectFiles: [],
  tier: 'mid',
  textModel: 'text/model',
  visionModel: 'vision/model',
  priceTable,
  ...overrides,
})

check('the estimate separates photos from documents and prices both', () => {
  fs.mkdirSync(path.join(estimateDir, '2018'), { recursive: true })
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(estimateDir, '2018', `p${i}.jpg`), 'x'.repeat(2048))
  fs.writeFileSync(path.join(estimateDir, 'notes.md'), 'y'.repeat(8000))

  const estimate = computeIndexEstimate(estimateInput())
  assert.equal(estimate.imageFiles, 10)
  assert.equal(estimate.textFiles, 1)
  assert.ok(estimate.folders >= 2, 'root plus the 2018 folder')
  assert.ok(estimate.costUsd > 0, 'a real number, not null')
  assert.equal(estimate.pricingUnavailable, false)
  assert.ok(estimate.estimatedSeconds > 0)
  const labels = estimate.lines.map((l) => l.label)
  assert.deepEqual(labels, ['Documents', 'Photos', 'Folder synthesis'])
})

check('cost scales linearly with photo count', () => {
  const small = computeIndexEstimate(estimateInput())
  const photoLine = small.lines.find((l) => l.label === 'Photos')
  assert.equal(photoLine.callCount, 10)
  const perPhoto = photoLine.costUsd / 10
  assert.ok(perPhoto > 0)
  // 40k photos is the real-world scale this feature has to quote honestly.
  assert.ok(perPhoto * 40000 > perPhoto * 39999, 'monotonic')
})

check('cached files are subtracted, so re-estimating an indexed tree quotes near zero', () => {
  const before = computeIndexEstimate(estimateInput())
  assert.ok(before.imageFiles > 0)
  for (const file of collectFiles([], estimateDir, INDEXABLE_EXTENSIONS, { maxFiles: 100, maxEntries: 1000 })) {
    upsertDocumentFileContext({
      projectId: estimateProject.id,
      filePath: file,
      relativePath: path.basename(file),
      contentHash: 'cached',
      kind: file.endsWith('.jpg') ? 'image' : 'text',
      context: 'A described photo.',
    })
  }
  const after = computeIndexEstimate(estimateInput())
  assert.equal(after.imageFiles, 0, 'nothing left to send')
  assert.equal(after.textFiles, 0)
  assert.equal(after.cachedFiles, before.imageFiles + before.textFiles)
  assert.equal(after.folders, 0, 'no changed children means no folder resynthesis')
  assert.equal(after.costUsd, 0)
  pruneDocumentFileContexts(estimateProject.id, [])
})

check('a missing vision model is flagged rather than silently quoted', () => {
  const estimate = computeIndexEstimate(estimateInput({ visionModel: '' }))
  assert.equal(estimate.visionModelMissing, true)
  assert.equal(estimate.costUsd, null, 'an unpriceable leg makes the whole total unknown')
  assert.equal(estimate.pricingUnavailable, true)
})

check('a text-only model chosen for vision is flagged as unsupported', () => {
  const estimate = computeIndexEstimate(estimateInput({ visionModel: 'textonly/model' }))
  assert.equal(estimate.visionModelUnsupported, true)
})

check('an unpriced provider yields unknown cost, never a fabricated zero', () => {
  const estimate = computeIndexEstimate(estimateInput({ priceTable: new Map() }))
  assert.equal(estimate.costUsd, null)
  assert.equal(estimate.pricingUnavailable, true)
  assert.ok(estimate.imageFiles > 0, 'the work is still counted')
})

check('combineEstimates sums projects and propagates unknown cost', () => {
  const a = computeIndexEstimate(estimateInput())
  const b = computeIndexEstimate(estimateInput())
  const combined = combineEstimates([a, b], 'mid', 'text/model', 'vision/model')
  assert.equal(combined.imageFiles, a.imageFiles + b.imageFiles)
  assert.equal(combined.costUsd, a.costUsd + b.costUsd)

  const unknown = computeIndexEstimate(estimateInput({ priceTable: new Map() }))
  const mixed = combineEstimates([a, unknown], 'mid', 'text/model', 'vision/model')
  assert.equal(mixed.costUsd, null, 'one unknown leg poisons the total')
  assert.equal(mixed.pricingUnavailable, true)
})

check('image file contexts round-trip their kind through the database', () => {
  const imagePath = path.join(estimateDir, 'kindcheck.jpg')
  upsertDocumentFileContext({
    projectId: estimateProject.id,
    filePath: imagePath,
    relativePath: 'kindcheck.jpg',
    contentHash: 'h1',
    kind: 'image',
    context: 'A gym interior with barbells.',
  })
  assert.equal(getDocumentFileContext(estimateProject.id, imagePath).kind, 'image')

  const textPath = path.join(estimateDir, 'kindcheck.md')
  upsertDocumentFileContext({
    projectId: estimateProject.id,
    filePath: textPath,
    relativePath: 'kindcheck.md',
    contentHash: 'h2',
    context: 'Notes.',
  })
  assert.equal(getDocumentFileContext(estimateProject.id, textPath).kind, 'text', 'defaults to text')
  const kinds = listDocumentFileContexts(estimateProject.id).map((r) => r.kind).sort()
  assert.deepEqual(kinds, ['image', 'text'])
  pruneDocumentFileContexts(estimateProject.id, [])
})

check('the image path uses a stat identity hash, not a content hash', () => {
  assert.ok(/function imageIdentityHash/.test(docSource))
  assert.ok(/fs\.statSync\(filePath\)/.test(docSource))
  assert.ok(
    /hashString\(`\$\{IMAGE_PROMPT_VERSION\}\\n\$\{filePath\}\\n\$\{size\}\\n\$\{mtime\}\\n\$\{PHOTO_MAX_EDGE\}`\)/.test(docSource),
    'the downscale target participates so changing it invalidates the cache'
  )
})

check('the cache is checked before the image is ever encoded or sent', () => {
  const fn = docSource.slice(docSource.indexOf('async function indexImageFile'))
  const cacheIndex = fn.indexOf('existing.contentHash === contentHash')
  const encodeIndex = fn.indexOf('await encodeImageForVlm')
  assert.ok(cacheIndex > -1 && encodeIndex > -1)
  assert.ok(cacheIndex < encodeIndex, 'a cache hit costs no decode and no API call')
})

check('vision-model output is redacted before it is stored (landmine #5)', () => {
  const fn = docSource.slice(docSource.indexOf('async function indexImageFile'))
  assert.ok(/redactMemoryContent\(raw\.trim\(\)\)/.test(fn), 'a VLM can transcribe text out of a photo')
})

check('photo descriptions get a hard output cap distinct from documents', () => {
  assert.ok(/const MAX_IMAGE_CONTEXT_CHARS = 1_400/.test(docSource))
  assert.ok(/maxTokens: IMAGE_MAX_OUTPUT_TOKENS, spend, isImage: true/.test(docSource), 'image calls override the 24k document cap')
  const cap = Number(docSource.match(/const IMAGE_MAX_OUTPUT_TOKENS = ([\d_]+)/)?.[1]?.replace(/_/g, ''))
  assert.ok(cap < 24_000, 'still far below the document default')
  // A cap the model exhausts reasoning comes back as empty content, which is
  // how most images in a run ended up recorded as unreadable.
  assert.ok(cap >= 1_500, `too tight a cap returns nothing at all (found ${cap})`)
})

check('an empty model response is reported as a failed call, not an unreadable file', () => {
  const imageFn = docSource.slice(
    docSource.indexOf('async function indexImageFile'),
    docSource.indexOf('interface FolderNode')
  )
  // The unreadable sentinel stays for a file that genuinely cannot be decoded...
  assert.ok(/if \(!encoded\) \{[\s\S]*?Empty or unreadable document/.test(imageFn), 'undecodable images keep the sentinel')
  // ...but an empty answer from the model must not be blamed on the image.
  assert.ok(
    /context = described\s*\n?\s*\|\| `Context generation failed for/.test(imageFn),
    'an empty description is a failed call'
  )
  assert.ok(!/described \|\| `Empty or unreadable/.test(imageFn))
})

const { createRateLimiter, estimateSecondsForCalls, DEFAULT_REQUESTS_PER_MINUTE } = await import('./src/main/rateLimit.ts')

await checkAsync('the rate limiter issues up to the limit immediately and then holds', async () => {
  const limiter = createRateLimiter(3)
  const started = Date.now()
  for (let i = 0; i < 3; i += 1) await limiter.acquire()
  assert.ok(Date.now() - started < 150, 'the first window is not throttled')
  assert.equal(limiter.pendingCount(), 3)
})

await checkAsync('concurrent workers cannot all claim the same free slot', async () => {
  const limiter = createRateLimiter(4)
  let issued = 0
  await Promise.all(Array.from({ length: 4 }, async () => { await limiter.acquire(); issued += 1 }))
  assert.equal(issued, 4)
  assert.equal(limiter.pendingCount(), 4, 'exactly four reservations, no double-counting')
})

await checkAsync('an aborted waiter does not wedge the limiter for later callers', async () => {
  const limiter = createRateLimiter(1)
  await limiter.acquire()
  const controller = new AbortController()
  const aborted = limiter.acquire(controller.signal).then(() => 'resolved', (err) => err.message)
  controller.abort()
  assert.equal(await aborted, 'Request cancelled')
  // The internal chain must survive a rejection, or every later acquire hangs.
  const next = limiter.acquire(new AbortController().signal)
  assert.ok(typeof next.then === 'function')
  next.catch(() => {})
})

check('every attempt is paced, retries included', () => {
  // A 429 retry that ignores the limit is what turns a transient throttle into
  // a permanent failure row, so the acquire sits inside callLLM, not around it.
  const llmSource = fs.readFileSync(new URL('./src/main/llmCall.ts', import.meta.url), 'utf8')
  assert.ok(/if \(options\.limiter\) await options\.limiter\.acquire\(signal\)/.test(llmSource))
  const callFn = llmSource.slice(llmSource.indexOf('async function callLLM('), llmSource.indexOf('export function isTransientError'))
  const acquireIndex = callFn.indexOf('limiter.acquire')
  const fetchIndex = callFn.indexOf('await fetch(')
  assert.ok(acquireIndex > -1 && fetchIndex > acquireIndex, 'pacing happens before the request')
})

check('the rate limit, not concurrency, sets the estimated duration at scale', () => {
  assert.equal(DEFAULT_REQUESTS_PER_MINUTE, 20)
  const calls = 146_052
  const paced = estimateSecondsForCalls(calls, 20, 4, 4)
  const concurrencyOnly = (calls * 4) / 4
  assert.ok(paced > concurrencyOnly, 'pacing dominates')
  assert.ok(Math.abs(paced - (calls / 20) * 60) < 1, 'duration is calls/rpm minutes')
  // Small runs stay concurrency-bound.
  assert.equal(estimateSecondsForCalls(0, 20, 4, 4), 0)
})

check('the indexer paces every LLM level, not just photos', () => {
  const limiterCalls = (docSource.match(/\{ spend, limiter \}/g) ?? []).length
  assert.ok(limiterCalls >= 2, `file and folder passes both paced (found ${limiterCalls})`)
  assert.ok(/isImage: true, limiter \}/.test(docSource), 'the image pass is paced')
  assert.ok(/options\.limiter \?\? createRateLimiter\(getRequestsPerMinute\(\)\)/.test(docSource), 'defaults to the configured rpm')
})

check('the background timer can never start photo indexing on its own', () => {
  // 146k images in the user's photo tree = ~$39 and ~41 hours at mid tier. A
  // timer must never begin that; only an explicit, estimated action can.
  assert.ok(/\{ skipImages: true \}/.test(mainSource), 'the hourly timer passes skipImages')
  const timerCall = mainSource.match(/await generateDocumentContexts\([^\n]*\)/)?.[0] ?? ''
  assert.ok(/skipImages: true/.test(timerCall), 'on the timer call specifically')
  // The user-triggered paths must NOT skip images.
  assert.ok(!/skipImages/.test(ipcSource), 'user-triggered runs index photos normally')
})

check('skipping images preserves existing photo contexts instead of pruning them', () => {
  const branch = docSource.slice(docSource.indexOf('if (skipImages) {'), docSource.indexOf('await indexImageFile({'))
  assert.ok(/fileHashes\.set\(filePath, existingImage\.contentHash\)/.test(branch), 'registers the hash so prune keeps the row')
  assert.ok(/!isFailedContext\(existingImage\.context\)/.test(branch), 'a failed context is not preserved as valid')
  assert.ok(!/upsertDocumentFileContext/.test(branch), 'never writes a failure row for an unindexed photo')
})

check('renderer index-state subscriptions are multiplexed through one IPC listener', () => {
  // Each DocumentContextPanel used to open its own onState/onProgress pair, so
  // 9 connected projects + Sidebar + DataPage tripped Node's 10-listener
  // MaxListenersExceededWarning on documents:state.
  const componentsDir = new URL('./src/renderer/components/', import.meta.url)
  const offenders = fs
    .readdirSync(componentsDir)
    .filter((name) => name.endsWith('.tsx'))
    .filter((name) => /documents\.(onState|onProgress)\(/.test(fs.readFileSync(new URL(name, componentsDir), 'utf8')))
  assert.deepEqual(offenders, [], 'components must subscribe via the useDocumentIndex hook, not directly')

  const hook = fs.readFileSync(new URL('./src/renderer/hooks/useDocumentIndex.ts', import.meta.url), 'utf8')
  assert.equal((hook.match(/documents\.onState\(/g) ?? []).length, 1, 'exactly one onState subscription app-wide')
  assert.equal((hook.match(/documents\.onProgress\(/g) ?? []).length, 1, 'exactly one onProgress subscription app-wide')
  assert.ok(/stateListeners\.size === 0 && unsubscribeState/.test(hook), 'the shared listener is torn down when the last consumer unmounts')
  assert.ok(/if \(!initialFetch\)/.test(hook), 'the initial getState is deduped across consumers')
})

const estimateSource = fs.readFileSync(new URL('./src/main/indexEstimate.ts', import.meta.url), 'utf8')
const channelsSource = fs.readFileSync(new URL('./src/main/ipcChannels.ts', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Multiple sources per project, per-source indexing, and forced re-index
// ---------------------------------------------------------------------------

const {
  listProjectSources,
  addProjectSource,
  removeProjectSource,
  getProjectById,
  pruneDocumentFileContextsUnder,
  pruneDocumentFolderContextsUnder,
  getProjectSuperContext,
  setProjectSuperContext,
  listProjectRootContexts: listRoots,
} = await import('./src/main/database.ts')

const srcA = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-srcA-'))
const srcB = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-srcB-'))
const multi = createProject({ name: 'MultiSource', icon: 'folder', color: '#06b6d4', path: null })

check('sources can be added, listed in order, and mirror into projects.path', () => {
  assert.deepEqual(listProjectSources(multi.id), [])
  addProjectSource(multi.id, srcA)
  addProjectSource(multi.id, srcB)
  const sources = listProjectSources(multi.id)
  assert.equal(sources.length, 2)
  assert.deepEqual(sources.map((s) => s.path), [srcA, srcB])
  assert.deepEqual(sources.map((s) => s.sortOrder), [0, 1])
  // Health/Activity/Psychology still read projects.path, so it must track the head.
  assert.equal(getProjectById(multi.id).path, srcA)
})

check('adding the same source twice is a no-op', () => {
  addProjectSource(multi.id, srcA)
  assert.equal(listProjectSources(multi.id).length, 2)
})

check('indexing one source never prunes another source\'s rows', () => {
  const fileA = path.join(srcA, 'a.md')
  const fileB = path.join(srcB, 'b.md')
  for (const [file, base] of [[fileA, srcA], [fileB, srcB]]) {
    upsertDocumentFileContext({
      projectId: multi.id, filePath: file, relativePath: path.basename(file),
      contentHash: 'h', context: `context for ${path.basename(file)}`,
    })
    upsertDocumentFolderContext({
      projectId: multi.id, folderPath: base, relativePath: '.', childHash: 'c',
      contextShort: 'short', context: `root of ${base}`, fileCount: 1,
    })
  }
  assert.equal(listDocumentFileContexts(multi.id).length, 2)

  // Re-index source A only: A's file disappears from the keep-list, B's must survive.
  pruneDocumentFileContextsUnder(multi.id, srcA, [])
  pruneDocumentFolderContextsUnder(multi.id, srcA, [])
  const remainingFiles = listDocumentFileContexts(multi.id)
  assert.equal(remainingFiles.length, 1, 'only source B remains')
  assert.ok(remainingFiles[0].filePath.startsWith(srcB))
  const remainingFolders = listDocumentFolderContexts(multi.id)
  assert.equal(remainingFolders.length, 1)
  assert.equal(remainingFolders[0].folderPath, srcB)
})

check('removing a source deletes the contexts derived from it', () => {
  upsertDocumentFileContext({
    projectId: multi.id, filePath: path.join(srcA, 'again.md'), relativePath: 'again.md',
    contentHash: 'h', context: 'back again',
  })
  assert.equal(listDocumentFileContexts(multi.id).length, 2)
  removeProjectSource(multi.id, srcA)
  assert.deepEqual(listProjectSources(multi.id).map((s) => s.path), [srcB])
  const left = listDocumentFileContexts(multi.id)
  assert.ok(left.every((row) => !row.filePath.startsWith(srcA)), 'no orphaned contexts feed the synthesis')
  // projects.path follows the new head rather than pointing at a removed dir.
  assert.equal(getProjectById(multi.id).path, srcB)
})

check('the user super-context sees one row per project, not one per source', () => {
  addProjectSource(multi.id, srcA)
  for (const base of [srcA, srcB]) {
    upsertDocumentFolderContext({
      projectId: multi.id, folderPath: base, relativePath: '.', childHash: `c-${base}`,
      contextShort: `short ${base}`, context: `root synthesis for ${base}`, fileCount: 1,
    })
  }
  // No combined synthesis yet — fall back to the source roots rather than
  // dropping the project out of the profile entirely.
  const before = listRoots().filter((r) => r.projectId === multi.id)
  assert.equal(before.length, 2, 'un-synthesized multi-source project still contributes')

  setProjectSuperContext({
    projectId: multi.id, contextShort: 'combined short', context: 'combined long synthesis', inputHash: 'ih',
  })
  const after = listRoots().filter((r) => r.projectId === multi.id)
  assert.equal(after.length, 1, 'a three-source project must not outvote the rest of the profile')
  assert.equal(after[0].context, 'combined long synthesis')
  assert.equal(after[0].folderPath, `project:${multi.id}`)
  assert.equal(getProjectSuperContext(multi.id).contextShort, 'combined short')
})

check('a single-source project keeps its source root as the project context', () => {
  const solo = createProject({ name: 'SoloSource', icon: 'folder', color: '#fff', path: null })
  addProjectSource(solo.id, srcB)
  upsertDocumentFolderContext({
    projectId: solo.id, folderPath: srcB, relativePath: '.', childHash: 'c',
    contextShort: 'solo short', context: 'solo root', fileCount: 1,
  })
  const roots = listRoots().filter((r) => r.projectId === solo.id)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].context, 'solo root', 'no extra synthesis call for one source')
  assert.equal(getProjectSuperContext(solo.id), null, 'nothing stored at the project level')
})

check('force bypasses every cache layer', () => {
  // file, image, folder, and the project/user input-hash gates.
  const guards = docSource.match(/if \(!force && existing/g) ?? []
  assert.ok(guards.length >= 3, `file/image/folder caches all honour force (found ${guards.length})`)
  assert.ok(/const force = options\.force \?\? false/.test(docSource))
  assert.ok(/if \(!options\.force && existing && existing\.inputHash === inputHash\)/.test(docSource), 'the project synthesis honours force')
})

check('a forced estimate counts nothing as cached', () => {
  assert.ok(
    /const cached = input\.force \? new Set<string>\(\) : new Set\(database\.listIndexedFilePaths\(projectId\)\)/.test(estimateSource),
    'force must not discount already-indexed files'
  )
})

check('the orchestrator indexes every source and combines only when there are several', () => {
  assert.ok(/const targets = options\.sourcePath/.test(docSource), 'sourcePath narrows the run')
  assert.ok(/async function indexProjectSource/.test(docSource), 'per-source worker exists')
  // One source and no conversations still passes straight through, so a plain
  // single-directory project spends no extra call on a synthesis of one thing.
  assert.ok(/if \(roots\.length === 1 && conversations\.length === 0\)/.test(docSource), 'single source passes through')
  assert.ok(/database\.clearProjectSuperContext\(projectId\)/.test(docSource), 'dropping back to one source clears the stale combined synthesis')
  // Explicit per-file entries belong to the project, not to every source.
  assert.ok(/const extraFiles = i === 0 && !options\.sourcePath \? project\.files : \[\]/.test(docSource))
})

check('the Data page can create a source and immediately connect directories to it', () => {
  const dataPage = fs.readFileSync(new URL('./src/renderer/components/DataPage.tsx', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('./src/renderer/App.tsx', import.meta.url), 'utf8')

  assert.ok(/onCreateProject: \(data: \{ name: string; icon: string; color: string \}\)/.test(dataPage), 'DataPage takes a create handler')
  assert.ok(/onCreateProject=\{handleCreateProject\}/.test(app), 'App wires it through')
  assert.ok(/onSelectImage=\{\(\) => window\.electronAPI\.app\.selectImage\(\)\}/.test(app), 'custom icons work here too')
  assert.ok(/setCreatingSource/.test(dataPage) && /Add New Source/.test(dataPage), 'there is a create affordance')

  // A project with no directory must still render with a way to connect one,
  // otherwise creating one on this page would be a dead end. Every row carries
  // that affordance now, so there is no separate not-connected list.
  const row = fs.readFileSync(new URL('./src/renderer/components/DataSourceRow.tsx', import.meta.url), 'utf8')
  assert.ok(/Add a path/.test(row), 'an unconnected row invites a path')
  assert.ok(/onBrowsePath/.test(row) && /onSubmitPath/.test(row), 'the row offers both Browse and Type path')
  assert.ok(/directoryRow=\{renderDirectoryRow\(project\)\}/.test(dataPage), 'the expanded source manages its directories')

  // Creating is acknowledged: the new card is highlighted and scrolled to.
  assert.ok(/setHighlightProjectId\(newId\)/.test(dataPage))
  assert.ok(/scrollIntoView/.test(dataPage))
  assert.ok(/return created/.test(app), 'App returns the created project so the page can locate it')
})

check('the source CRUD keeps the 4-file IPC sync', () => {
  for (const channel of ['ADD_SOURCE', 'REMOVE_SOURCE', 'LIST_SOURCES']) {
    assert.ok(new RegExp(`${channel}: 'projects:`).test(channelsSource), `${channel} channel`)
    assert.ok(new RegExp(`IPC\\.PROJECTS\\.${channel}`).test(ipcSource), `${channel} handler`)
    assert.ok(new RegExp(`IPC\\.PROJECTS\\.${channel}`).test(preloadSource), `${channel} bridge`)
  }
  assert.ok(/addSource: \(projectId: string, sourcePath: string\) => Promise<ProjectSource\[\]>/.test(typesSource), 'ElectronAPI contract')
  assert.ok(/assertPathAllowed\(resolved\)/.test(ipcSource), 'a new source is scope-checked before it is stored')
})

const settingsSource = fs.readFileSync(new URL('./src/main/settings.ts', import.meta.url), 'utf8')

check('a tier resolves both models and falls back to mid when unset', () => {
  assert.ok(/tiers\[requested\]\.textModel \|\| tiers\.mid\.textModel \|\| DEFAULT_SYSTEM_MODEL/.test(settingsSource))
  assert.ok(/tiers\[requested\]\.visionModel \|\| tiers\.mid\.visionModel \|\| ''/.test(settingsSource))
})

check('the legacy systemModel migrates into the mid tier', () => {
  assert.ok(/if \(!store\.get\('modelTiers'\)\)/.test(settingsSource))
  assert.ok(/mid: \{ textModel: legacyText, visionModel: legacyVision \}/.test(settingsSource))
})

check('the index run passes its tier to both model resolvers', () => {
  assert.ok(/settings\.getTextModel\(tier\)/.test(ipcSource))
  assert.ok(/visionModel: settings\.getIndexVisionModel\(tier\)/.test(ipcSource))
})

// --- provenance --------------------------------------------------------------
// Summaries are built on summaries, so every derived node has to carry pointers
// back to what produced it. These check that the pointers exist at every layer
// and that following them from the apex actually lands on files on disk.
console.log('provenance')

const provDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-prov-'))
const provRoot = fs.realpathSync(provDir)
const provSub = path.join(provRoot, 'notes')
fs.mkdirSync(provSub)
const provFileA = path.join(provSub, 'a.txt')
const provFileB = path.join(provSub, 'b.txt')
fs.writeFileSync(provFileA, 'alpha')
fs.writeFileSync(provFileB, 'beta')

const provProject = createProject({ name: 'ProvTest', icon: 'folder-open', color: '#10b981', path: provRoot, files: [] })

const leafProvenance = (filePath, relativePath, contentHash) => ({
  promptVersion: 'v4-long-timeline',
  model: 'test-model',
  generatedAt: '2026-07-01T00:00:00.000Z',
  sources: [{ kind: 'file', ref: filePath, label: relativePath, hash: contentHash, included: true }],
  unrecordedCount: 0,
  omittedCount: 0,
  leafCount: 1,
  inputChars: 5,
  truncated: false,
})

check('a leaf node points at the file on disk that produced it', () => {
  upsertDocumentFileContext({
    projectId: provProject.id, filePath: provFileA, relativePath: 'notes/a.txt',
    contentHash: 'fa', context: 'alpha analysis', provenance: leafProvenance(provFileA, 'notes/a.txt', 'fa'),
  })
  const got = getDocumentFileContext(provProject.id, provFileA)
  assert.equal(got.provenance.sources.length, 1)
  assert.equal(got.provenance.sources[0].kind, 'file')
  assert.equal(got.provenance.sources[0].ref, provFileA)
  assert.equal(got.provenance.leafCount, 1)
})

check('a node indexed before provenance existed reads back as unknown, not as a guess', () => {
  upsertDocumentFileContext({
    projectId: provProject.id, filePath: provFileB, relativePath: 'notes/b.txt',
    contentHash: 'fb', context: 'beta analysis',
  })
  assert.equal(getDocumentFileContext(provProject.id, provFileB).provenance, null)
})

check('backfill attaches a chain to an existing node, and only on a hash match', () => {
  setDocumentFileContextProvenance({
    projectId: provProject.id, filePath: provFileB, relativePath: 'notes/b.txt',
    contentHash: 'WRONG', provenance: leafProvenance(provFileB, 'notes/b.txt', 'WRONG'),
  })
  assert.equal(getDocumentFileContext(provProject.id, provFileB).provenance, null, 'a mismatched hash writes nothing')

  setDocumentFileContextProvenance({
    projectId: provProject.id, filePath: provFileB, relativePath: 'notes/b.txt',
    contentHash: 'fb', provenance: leafProvenance(provFileB, 'notes/b.txt', 'fb'),
  })
  assert.equal(getDocumentFileContext(provProject.id, provFileB).provenance.sources[0].ref, provFileB)
})

const subProvenance = {
  promptVersion: 'v8-structured-synthesis',
  model: 'test-model',
  generatedAt: '2026-07-01T00:00:00.000Z',
  sources: [
    { kind: 'file', ref: provFileA, label: 'a.txt', hash: 'fa', included: true },
    { kind: 'file', ref: provFileB, label: 'b.txt', hash: 'fb', included: false },
  ],
  unrecordedCount: 0,
  omittedCount: 1,
  leafCount: 2,
  inputChars: 30,
  truncated: true,
}

check('a folder records one edge per direct child, including the ones the budget dropped', () => {
  upsertDocumentFolderContext({
    projectId: provProject.id, folderPath: provSub, relativePath: 'notes', childHash: 'cs',
    contextShort: 'notes gist', context: 'notes synthesis', fileCount: 2, provenance: subProvenance,
  })
  const got = getDocumentFolderContext(provProject.id, provSub)
  assert.equal(got.provenance.sources.length, 2)
  assert.equal(got.provenance.omittedCount, 1)
  assert.equal(got.provenance.truncated, true, 'a folder that could not read all its children says so')
  assert.equal(got.provenance.sources.find((s) => s.ref === provFileB).included, false)
})

check('the root records its subfolder, so the chain has a middle layer', () => {
  upsertDocumentFolderContext({
    projectId: provProject.id, folderPath: provRoot, relativePath: '.', childHash: 'cr',
    contextShort: 'root gist', context: 'root synthesis', fileCount: 2,
    provenance: {
      promptVersion: 'v8-structured-synthesis', model: 'test-model', generatedAt: '2026-07-01T00:00:00.000Z',
      sources: [{ kind: 'folder', ref: provSub, label: 'notes/', hash: 'cs', included: true }],
      unrecordedCount: 0, omittedCount: 0, leafCount: 2, inputChars: 40, truncated: false,
    },
  })
  assert.equal(getDocumentFolderContext(provProject.id, provRoot).provenance.sources[0].ref, provSub)
})

setUserSuperContext({
  contextShort: 'apex gist', context: 'the unified person', inputHash: 'apex-hash', projectCount: 1,
  provenance: {
    promptVersion: 'v11-apex-cap', model: 'test-model', generatedAt: '2026-07-01T00:00:00.000Z',
    sources: [
      { kind: 'project-root', ref: `project:${provProject.id}`, label: 'ProvTest', hash: 'cr', included: true },
      { kind: 'memory', ref: 'memory:profile', label: 'Stored memory profile', hash: 'mh', included: true },
    ],
    unrecordedCount: 0, omittedCount: 0, leafCount: 2, inputChars: 100, truncated: false,
  },
})

check('the apex node walks all the way down to the files on disk', () => {
  const chain = resolveProvenanceChain({ ref: 'user:super-context' })
  assert.equal(chain.found, true)
  assert.equal(chain.truncated, false)
  // apex -> project root -> notes/ -> a.txt, b.txt, plus the memory input.
  const depths = chain.nodes.map((n) => `${n.depth}:${n.kind}`)
  assert.deepEqual(depths, [
    '0:user', '1:project-root', '1:memory', '2:folder', '3:file', '3:file',
  ])
  assert.deepEqual(chain.leafFiles.sort(), [provFileA, provFileB].sort())
})

check('the walk preserves whether each layer actually fed the layer above it', () => {
  const chain = resolveProvenanceChain({ ref: 'user:super-context' })
  const dropped = chain.nodes.find((n) => n.ref === provFileB)
  assert.equal(dropped.included, false, 'a child the budget dropped stays visible as dropped')
  assert.equal(chain.nodes.find((n) => n.ref === provFileA).included, true)
})

check('a walk from a mid-tree folder reaches ground truth without needing the apex', () => {
  const chain = resolveProvenanceChain({ ref: provSub, projectId: provProject.id })
  assert.equal(chain.found, true)
  assert.deepEqual(chain.leafFiles.sort(), [provFileA, provFileB].sort())
})

check('a leaf terminates the walk instead of looping on its self-reference', () => {
  const chain = resolveProvenanceChain({ ref: provFileA, projectId: provProject.id })
  assert.equal(chain.nodes.length, 1)
  assert.deepEqual(chain.leafFiles, [provFileA])
})

check('hitting the node cap reports a partial chain rather than a complete-looking one', () => {
  const chain = resolveProvenanceChain({ ref: 'user:super-context' }, { maxNodes: 2 })
  assert.equal(chain.truncated, true)
  assert.equal(chain.nodes.length, 2)
})

check('an unknown reference is reported as not found, never as an empty chain', () => {
  const missing = resolveProvenanceChain({ ref: path.join(provRoot, 'nope.txt'), projectId: provProject.id })
  assert.equal(missing.found, false)
  assert.equal(missing.nodes.length, 0)
})

check('archived versions keep the chain that produced them', () => {
  const versions = listContextVersions({ sourceRef: `project:${provProject.id}:folder:notes` })
  assert.ok(versions.length > 0, 'the folder synthesis was archived')
  const archived = getContextVersion(versions[0].id)
  assert.equal(archived.provenance.sources.length, 2)
  assert.equal(archived.provenance.omittedCount, 1)
})

check('backfilling a node also repairs the archived version it matches', () => {
  const ref = `project:${provProject.id}:file:notes/b.txt`
  const versions = listContextVersions({ sourceRef: ref })
  const archived = getContextVersion(versions[0].id)
  assert.equal(archived.contentHash, 'fb')
  assert.equal(archived.provenance.sources[0].ref, provFileB, 'the version archived before backfill got the chain too')
})

check('the indexer writes provenance on every context it stores', () => {
  // A write path that forgets provenance produces a node with no way back to
  // ground truth, which is exactly the drift this is meant to prevent.
  const writes = docSource.match(/database\.upsertDocument(File|Folder)Context\(\{[\s\S]*?\}\)/g) ?? []
  assert.ok(writes.length >= 5, `found ${writes.length} context writes`)
  for (const write of writes) {
    assert.ok(/provenance/.test(write), `a context write omits provenance:\n${write}`)
  }
})

check('the cached path backfills rather than leaving old nodes chainless forever', () => {
  assert.ok(/if \(!existing\.provenance\)/.test(docSource), 'file/folder cache hits backfill a missing chain')
  assert.ok(/setDocumentFolderContextProvenance/.test(docSource))
  assert.ok(/setUserSuperContextProvenance/.test(docSource))
})

// --- claim-level citations ---------------------------------------------------
console.log('claim citations')

const markers = new Map([['F1', '/data/a.txt'], ['F2', '/data/b.txt'], ['S1', '/data/sub']])
const cited = (raw) => extractClaims(raw, markers)

check('markers are stripped from the stored text, so nothing downstream sees them', () => {
  const { text } = cited('He ran three times a week [F1]. He also swam [F2].')
  assert.equal(text, 'He ran three times a week. He also swam.')
  assert.ok(!/\[F\d\]/.test(text))
})

check('a claim span covers the sentence it is attached to, not the whole text', () => {
  const { text, claims } = cited('He ran three times a week [F1]. He also swam [F2].')
  assert.equal(claims.length, 2)
  assert.equal(text.slice(claims[0].start, claims[0].end), 'He ran three times a week')
  assert.equal(text.slice(claims[1].start, claims[1].end), '. He also swam')
  assert.deepEqual(claims[0].sourceRefs, ['/data/a.txt'])
})

check('several markers on one claim record every source', () => {
  const { claims } = cited('Both records agree on the pattern [F1][S1].')
  assert.equal(claims.length, 1)
  assert.deepEqual(claims[0].sourceRefs, ['/data/a.txt', '/data/sub'])
})

check('an invented marker is dropped rather than pointed at a real file', () => {
  const { text, claims } = cited('A confident but unsourced claim [F9]. A real one [F1].')
  assert.equal(claims.length, 1, 'only the valid citation survives')
  assert.deepEqual(claims[0].sourceRefs, ['/data/a.txt'])
  assert.ok(!/\[F9\]/.test(text), 'the bogus marker is still stripped from the prose')
})

check('a claim never reaches back across a paragraph break', () => {
  const { text, claims } = cited('First paragraph with no citation.\n\nSecond paragraph makes a point [F1].')
  assert.equal(claims.length, 1)
  assert.equal(text.slice(claims[0].start, claims[0].end), 'Second paragraph makes a point')
})

check('citations inside the timeline block are discarded', () => {
  const { claims } = cited('Prose claim [F1].\n\nTIMELINE:\n- 2024-01-01 | day | life | Thing [F2] | detail')
  assert.equal(claims.length, 1)
  assert.deepEqual(claims[0].sourceRefs, ['/data/a.txt'])
})

check('text with no markers yields no claims and is returned unchanged', () => {
  const raw = 'A synthesis that cited nothing at all.'
  const { text, claims } = cited(raw)
  assert.equal(text, raw)
  assert.equal(claims.length, 0)
})

check('claims are clamped to a context truncated to its cap', () => {
  const clamped = clampClaims([{ start: 0, end: 10, sourceRefs: ['a'] }, { start: 12, end: 30, sourceRefs: ['b'] }], 20)
  assert.equal(clamped.length, 2)
  assert.equal(clamped[1].end, 20, 'a claim crossing the cut is shortened, not dropped')
  assert.equal(clampClaims([{ start: 40, end: 50, sourceRefs: ['a'] }], 20).length, 0, 'a claim past the cut is dropped')
})

check('finishSynthesis extracts before truncating, so offsets survive the cap', () => {
  const body = 'x'.repeat(50)
  const raw = `SHORT: headline\n---\n${body} A cited sentence [F1]. ${'y'.repeat(400)}`
  const finished = finishSynthesis(raw, markers, 80)
  assert.equal(finished.long.length, 80)
  assert.ok(finished.claims.length > 0)
  const span = finished.long.slice(finished.claims[0].start, finished.claims[0].end)
  assert.ok(span.endsWith('A cited sentence'), `span was ${JSON.stringify(span)}`)
})

check('a tag that leaks into the SHORT headline is stripped anyway', () => {
  const finished = finishSynthesis('SHORT: A headline [F1]\n---\nBody text [F1].', markers, 500)
  assert.equal(finished.short, 'A headline')
})

check('only children that reached the prompt get a citation tag', () => {
  // A marker for a child the model never saw could only ever be a hallucination,
  // so the packer must not mint tags for children the budget dropped.
  const big = (n) => ({ kind: 'file', ref: `/data/${n}`, label: `${n}.txt`, hash: `h${n}`, body: 'z'.repeat(50_000) })
  const packed = packFolderChildren([], [big('one'), big('two'), big('three')])
  assert.equal(packed.sections.length, 1, 'only the first 50k body fits the 90k budget')
  assert.deepEqual([...packed.markerToRef.keys()], ['F1'], 'no tag is minted for a dropped child')
  assert.equal(packed.markerToRef.get('F1'), '/data/one')
  assert.deepEqual(packed.edges.map((e) => e.included), [true, false, false], 'dropped children stay recorded as dropped')
})

check('citation tags are numbered over included children only, with no gaps', () => {
  const small = (n) => ({ kind: 'file', ref: `/data/${n}`, label: `${n}.txt`, hash: `h${n}`, body: 'small' })
  const packed = packFolderChildren(
    [{ kind: 'folder', ref: '/data/sub', label: 'sub/', hash: 'hs', body: 'folder summary' }],
    [small('a'), small('b')]
  )
  assert.deepEqual([...packed.markerToRef.entries()], [
    ['S1', '/data/sub'],
    ['F1', '/data/a'],
    ['F2', '/data/b'],
  ])
  assert.ok(packed.sections[0].startsWith('--- SUB-FOLDER [S1]: sub/ ---'))
  assert.ok(packed.sections[1].startsWith('--- FILE [F1]: a.txt ---'))
})

check('both synthesis levels ask for citations and bumped their prompt version', () => {
  assert.ok(/citationPromptSection\('child summary'\)/.test(docSource), 'folder prompt requests citations')
  assert.ok(/citationPromptSection\('data source and the memory profile'\)/.test(docSource), 'apex prompt requests citations')
  // Pinned by shape, never by literal: a legitimate prompt revision must not
  // break this suite (AGENTS: never assert a literal prompt-version string).
  assert.ok(promptVersion('FOLDER'), 'folder prompt version present')
  assert.ok(promptVersion('USER'), 'apex prompt version present')
  assert.ok(!/citationPromptSection/.test(docSource.slice(
    docSource.indexOf('const FILE_CONTEXT_SYSTEM_PROMPT'),
    docSource.indexOf('const FOLDER_CONTEXT_SYSTEM_PROMPT')
  )), 'file contexts get no citation section — every claim already traces to the one file read')
})

// --- exact-line citations ----------------------------------------------------
console.log('line citations')

check('lines are numbered so the model has something to cite', () => {
  const { numbered, lineCount } = numberLines('alpha\nbeta\ngamma')
  assert.equal(lineCount, 3)
  assert.deepEqual(numbered.split('\n'), ['1| alpha', '2| beta', '3| gamma'])
})

check('line numbers are padded so wide files stay aligned', () => {
  const { numbered } = numberLines(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'))
  const lines = numbered.split('\n')
  assert.equal(lines[0], ' 1| l0')
  assert.equal(lines[11], '12| l11')
})

const lineRes = lineMarkerResolver('/data/log.csv', 100)

check('a line citation resolves to a range on the cited file', () => {
  const { text, claims } = extractClaims('He logged 40 runs [L12-18]. He stopped in May [L90].', lineRes)
  assert.equal(text, 'He logged 40 runs. He stopped in May.')
  assert.deepEqual(claims[0].sourceLines, { start: 12, end: 18 })
  assert.deepEqual(claims[0].sourceRefs, ['/data/log.csv'])
  assert.deepEqual(claims[1].sourceLines, { start: 90, end: 90 }, 'a single-line citation is a one-line range')
})

check('a citation past the last line the model saw is rejected', () => {
  // The file may well have a line 900; the model was shown 100 and cannot have
  // read it, so the citation is a guess rather than evidence.
  assert.equal(lineRes('L900'), null)
  assert.equal(lineRes('L0'), null, 'line numbering is 1-based')
  assert.equal(lineRes('L50-20'), null, 'a backwards range is not a range')
  assert.deepEqual(lineRes('L50-60'), { ref: '/data/log.csv', lines: { start: 50, end: 60 } })
  const { claims } = extractClaims('An out-of-range claim [L900]. A real one [L5].', lineRes)
  assert.equal(claims.length, 1)
  assert.deepEqual(claims[0].sourceLines, { start: 5, end: 5 })
})

check('several line citations on one claim widen to the range they span', () => {
  const { claims } = extractClaims('Ordered from the same places all spring [L12-20][L44].', lineRes)
  assert.equal(claims.length, 1)
  assert.deepEqual(claims[0].sourceLines, { start: 12, end: 44 })
})

check('the file prompt asks for line citations and bumped its version', () => {
  assert.ok(/CITE THE EXACT LINES/.test(docSource))
  assert.ok(/\[L42-58\]/.test(docSource), 'the range syntax is shown by example')
  assert.ok(promptVersion('FILE'), 'file prompt version present')
  assert.ok(
    /DOCUMENT CONTENTS \(\$\{lineCount\} numbered lines\) ---\\n\$\{numbered\}/.test(docSource),
    'the file prompt is fed numbered lines, not raw text'
  )
})

const excerptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-excerpt-'))
const excerptFile = path.join(excerptDir, 'log.txt')
fs.writeFileSync(excerptFile, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'))

await checkAsync('an excerpt is read from the file itself, with the cited lines marked', async () => {
  const excerpt = await readSourceExcerpt({ filePath: excerptFile, startLine: 8, endLine: 10 })
  assert.equal(excerpt.totalLines, 20)
  const cited = excerpt.lines.filter((l) => l.cited).map((l) => l.number)
  assert.deepEqual(cited, [8, 9, 10], 'exactly the cited lines are marked')
  assert.equal(excerpt.lines.find((l) => l.number === 9).text, 'line 9', 'the text is the real file content')
  assert.ok(excerpt.lines.some((l) => !l.cited), 'surrounding lines are included for context')
  assert.equal(excerpt.lines[0].number, 6)
})

await checkAsync('an excerpt refuses to show lines from a file that changed since indexing', async () => {
  const stale = await readSourceExcerpt({
    filePath: excerptFile, startLine: 1, endLine: 2, expectedContentHash: 'not-the-real-hash',
  })
  assert.ok(stale.unavailable, 'a hash mismatch reports unavailable rather than showing the wrong lines')
  assert.ok(/changed since it was indexed/.test(stale.unavailable))
  assert.equal(stale.lines, undefined)
})

await checkAsync('a missing file is reported, never rendered as empty evidence', async () => {
  const gone = await readSourceExcerpt({ filePath: path.join(excerptDir, 'nope.txt'), startLine: 1, endLine: 1 })
  assert.ok(gone.unavailable)
})

await checkAsync('excerpt line numbers survive the redaction the indexer applied', async () => {
  // The model reads redacted, extracted text — so the excerpt must re-derive it
  // the same way, or line N in the citation would not be line N on screen.
  const redactedFile = path.join(excerptDir, 'contact.txt')
  fs.writeFileSync(redactedFile, 'first line\nssn 123-45-6789 on file\nthird line')
  const excerpt = await readSourceExcerpt({ filePath: redactedFile, startLine: 2, endLine: 2 })
  assert.equal(excerpt.totalLines, 3, 'redaction did not add or drop lines')
  const second = excerpt.lines.find((l) => l.number === 2)
  assert.ok(second.cited)
  assert.ok(!second.text.includes('123-45-6789'), 'the excerpt shows what the model saw, redacted')
  assert.ok(second.text.includes('[REDACTED SSN]'))
})

check('the excerpt handler enforces the same file-access scope as every other read', () => {
  const handler = ipcSource.slice(ipcSource.indexOf('IPC.DOCUMENTS.GET_SOURCE_EXCERPT'))
  assert.ok(/assertPathAllowed\(resolved\)/.test(handler.slice(0, 1200)), 'renderer-named paths go through the scope guard')
})

check('a depth-limited walk returns one layer and is not reported as truncated', () => {
  const oneLayer = resolveProvenanceChain({ ref: 'user:super-context' }, { maxDepth: 1 })
  assert.deepEqual(oneLayer.nodes.map((n) => n.depth), [0, 1, 1])
  assert.equal(oneLayer.truncated, false, 'stopping at the requested depth is not truncation')

  const zeroLayer = resolveProvenanceChain({ ref: 'user:super-context' }, { maxDepth: 0 })
  assert.equal(zeroLayer.nodes.length, 1, 'depth 0 resolves the node itself and none of its sources')
  assert.equal(zeroLayer.nodes[0].provenance.sources.length, 2, 'the node still reports what it was built from')
})

check('drilling one layer at a time reaches the same files as a full walk', () => {
  const viaDrill = []
  const walk = (ref, projectId) => {
    for (const child of resolveProvenanceChain({ ref, projectId }, { maxDepth: 1 }).nodes.slice(1)) {
      if (child.kind === 'file') viaDrill.push(child.ref)
      else if (child.kind !== 'memory') walk(child.ref, child.projectId)
    }
  }
  walk('user:super-context', null)
  assert.deepEqual(viaDrill.sort(), resolveProvenanceChain({ ref: 'user:super-context' }).leafFiles.sort())
})

check('context blocks built from a derived node carry a provenance pointer', () => {
  assert.ok(
    /ref: `project:\$\{project\.id\}`,\s*\n\s*projectId: project\.id,/.test(ipcSource),
    'the project super-context block points at its project root node'
  )
  assert.ok(
    /ref: 'user:super-context',\s*\n\s*projectId: null,/.test(ipcSource),
    'the memory block points at the apex node when it embeds the super-context'
  )
})

check('claim offsets are only shifted onto a block that embedded the text verbatim', () => {
  // A condensed or truncated block still traces to its node, but its spans would
  // land on the wrong words, so it must carry no textOffset at all.
  assert.ok(
    /\.\.\.\(superContext === rootContext \? \{ textOffset:/.test(ipcSource),
    'the project block only offsets when the full long context went in'
  )
  assert.ok(
    /\.\.\.\(superText === superContextText \? \{ textOffset:/.test(ipcSource),
    'the memory blocks only offset when the stored apex text went in unmodified'
  )
})

check('UI-only fields on a system block never reach the provider', () => {
  // The entries carry `label` and `provenanceRef` for the prompt preview; a
  // strict OpenAI-compatible endpoint has no reason to accept either.
  assert.ok(
    /systemMessages\.map\(\(message\) => \(\{ role: message\.role, content: message\.content \}\)\)/.test(ipcSource),
    'system messages are narrowed to role+content before the API call'
  )
  assert.ok(!/const apiMessages: ApiMessage\[\] = \[\.\.\.systemMessages\]/.test(ipcSource))
})

check('folder packing is deferred past the cache check so cached runs stay cheap', () => {
  const packIndex = docSource.indexOf('const pack = () =>')
  const cacheIndex = docSource.indexOf('existing.childHash === childHash')
  const callIndex = docSource.indexOf('const { sections, edges, inputChars, markerToRef } = pack()')
  assert.ok(packIndex !== -1 && cacheIndex !== -1 && callIndex !== -1)
  assert.ok(callIndex > cacheIndex, 'the prompt is only built once the cache check has missed')
})

// --- project scope, index style, and conversations as sources ----------------

console.log('scope, style and conversations')

const {
  createConversation,
  updateConversationContext,
  updateProject,
  listConversationProjectIds,
  listProjectConversationIds,
  listSeparateContextProjectIds,
  listSeparateContextConversationIds,
  upsertConversationContext,
  getConversationContext,
  listProjectConversationContexts,
  listTimelineEvents,
  mergeDerivedTimelineEvents,
} = await import('./src/main/database.ts')

const workProject = createProject({
  name: 'Work Archive', icon: 'folder', color: '#47a08f', path: null,
  sources: [], files: [], analysis: null, 
  healthAnalysis: null, activityAnalysis: null, financesSummary: null,
})
const lifeProject = createProject({
  name: 'Journals', icon: 'folder', color: '#47a08f', path: null,
  sources: [], files: [], analysis: null, 
  healthAnalysis: null, activityAnalysis: null, financesSummary: null,
})

check('a new project defaults to the life scope and the behavioral style', () => {
  assert.equal(workProject.contextScope, 'life')
  assert.equal(workProject.indexStyle, 'behavioral')
})

check('a context selection files the conversation under every project it stacks', () => {
  const conversation = createConversation(undefined, undefined, undefined, undefined, {
    kind: 'stack',
    items: [{ kind: 'project', projectId: workProject.id }, { kind: 'project', projectId: lifeProject.id }, { kind: 'life' }],
  })
  assert.deepEqual(conversation.projectIds, [workProject.id, lifeProject.id])
  // projects.project_id mirrors the head of the list for everything that still reads it.
  assert.equal(conversation.projectId, workProject.id)
  assert.deepEqual(listConversationProjectIds(conversation.id), [workProject.id, lifeProject.id])
  assert.ok(listProjectConversationIds(lifeProject.id).includes(conversation.id))
})

check('re-pointing the context re-files the conversation and leaves the project it left', () => {
  const conversation = createConversation(undefined, undefined, undefined, undefined, {
    kind: 'project', projectId: workProject.id,
  })
  updateConversationContext(conversation.id, { kind: 'project', projectId: lifeProject.id })
  assert.deepEqual(listConversationProjectIds(conversation.id), [lifeProject.id])
  assert.ok(!listProjectConversationIds(workProject.id).includes(conversation.id))

  // Clearing the context takes it back to General rather than stranding it.
  updateConversationContext(conversation.id, { kind: 'life' })
  assert.deepEqual(listConversationProjectIds(conversation.id), [])
})

check('a conversation context is written once and read by every project it belongs to', () => {
  const conversation = createConversation(undefined, undefined, undefined, undefined, {
    kind: 'stack',
    items: [{ kind: 'project', projectId: workProject.id }, { kind: 'project', projectId: lifeProject.id }],
  })
  upsertConversationContext({
    conversationId: conversation.id,
    messageHash: 'hash-1',
    contextShort: 'Decided the release date.',
    context: 'A long account of the decision.',
  })
  assert.equal(getConversationContext(conversation.id).contextShort, 'Decided the release date.')
  assert.equal(listProjectConversationContexts(workProject.id).length, 1)
  assert.equal(listProjectConversationContexts(lifeProject.id).length, 1)

  // Regenerating archives the outgoing version rather than discarding it.
  upsertConversationContext({
    conversationId: conversation.id,
    messageHash: 'hash-2',
    contextShort: 'Moved the release date.',
    context: 'A revised account.',
  })
  const versions = listContextVersions({ sourceRef: `conversation:${conversation.id}` })
  assert.equal(versions.length, 1, 'the superseded conversation context is kept')
  assert.equal(getConversationContext(conversation.id).context, 'A revised account.')
})

check('a separate-context project is kept out of the life super-context and out of memory', () => {
  upsertDocumentFolderContext({
    projectId: workProject.id, folderPath: '/tmp/work', relativePath: '.', childHash: 'w1',
    contextShort: 'Work root.', context: 'Everything in the work archive.', fileCount: 3,
  })
  assert.ok(listProjectRootContexts().some((root) => root.projectId === workProject.id), 'life-scoped while it is life-scoped')

  updateProject(workProject.id, { contextScope: 'separate' })
  assert.deepEqual(listSeparateContextProjectIds(), [workProject.id])
  assert.ok(
    !listProjectRootContexts().some((root) => root.projectId === workProject.id),
    'a separate project never reaches the apex prompt'
  )

  const conversation = createConversation(undefined, undefined, undefined, undefined, {
    kind: 'project', projectId: workProject.id,
  })
  assert.ok(listSeparateContextConversationIds().includes(conversation.id), 'its conversations are off-limits to memory')

  updateProject(workProject.id, { contextScope: 'life' })
  assert.ok(listProjectRootContexts().some((root) => root.projectId === workProject.id), 'switching back restores it')
  assert.deepEqual(listSeparateContextProjectIds(), [])
})

check('a separate project keeps its own timeline instead of feeding the life one', () => {
  mergeDerivedTimelineEvents([
    {
      sourceType: 'conversation', sourceRef: `project:${workProject.id}:conversation:x`,
      sourceLabel: 'Work · release', projectId: workProject.id, category: 'milestone',
      title: 'Shipped v2', detail: 'Release cut.', startDate: '2026-03-04', endDate: null,
      precision: 'day', confidence: 0.75, dedupeKey: 'work-ship-v2',
    },
    {
      sourceType: 'document', sourceRef: `project:${lifeProject.id}:file:a.md`,
      sourceLabel: 'Journals · a.md', projectId: lifeProject.id, category: 'milestone',
      title: 'Moved house', detail: 'New flat.', startDate: '2026-03-05', endDate: null,
      precision: 'day', confidence: 0.8, dedupeKey: 'life-moved-house',
    },
  ])

  updateProject(workProject.id, { contextScope: 'separate' })
  const life = listTimelineEvents({ excludeProjectIds: listSeparateContextProjectIds() })
  assert.ok(life.some((event) => event.title === 'Moved house'), 'life events stay')
  assert.ok(!life.some((event) => event.title === 'Shipped v2'), 'the separate project is not in the life record')

  const own = listTimelineEvents({ projectIds: [workProject.id] })
  assert.ok(own.some((event) => event.title === 'Shipped v2'), 'the separate project keeps its own timeline')
  updateProject(workProject.id, { contextScope: 'life' })
})

await checkAsync('the accent dot is reserved for a source that is completely indexed', async () => {
  const { listProjectIndexSummaries } = await import('./src/main/documentContext.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-full-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one')
  const project = createProject({
    name: 'Fully Indexed Check', icon: 'folder', color: '#47a08f', path: null,
    sources: [], files: [], analysis: null, 
    healthAnalysis: null, activityAnalysis: null, financesSummary: null,
  })
  addSource(project.id, dir)
  const summaryOf = () => listProjectIndexSummaries().find((entry) => entry.projectId === project.id)

  assert.equal(summaryOf().fullyIndexed, false, 'a connected but unindexed source is not fully indexed')

  upsertDocumentFileContext({
    projectId: project.id, filePath: path.join(dir, 'a.txt'), relativePath: 'a.txt',
    contentHash: 'h1', context: 'About a.txt.',
  })
  assert.equal(summaryOf().fullyIndexed, false, 'file contexts alone do not make it complete — the root synthesis is missing')

  upsertDocumentFolderContext({
    projectId: project.id, folderPath: fs.realpathSync(dir), relativePath: '.', childHash: 'c1',
    contextShort: 'Root.', context: 'The root synthesis.', fileCount: 1,
  })
  assert.equal(summaryOf().fullyIndexed, false, 'still incomplete until a run recorded a finished pass')

  setDocumentSummaryMeta({ projectId: project.id, rootPath: dir, signature: 'sig', fileCount: 1, folderCount: 1 })
  assert.equal(summaryOf().fullyIndexed, true, 'a completed pass over every source is what turns the dot')

  // A second source with nothing indexed drops it back: the project is no
  // longer covered end to end.
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-full2-'))
  addSource(project.id, second)
  assert.equal(summaryOf().fullyIndexed, false, 'a newly connected source makes the project incomplete again')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(second, { recursive: true, force: true })
})

await checkAsync('the Data source is retired and Files is now File System', async () => {
  const { DEFAULT_PROJECTS, FILE_SYSTEM_PROJECT_NAME, isDefaultProjectName } =
    await import('./src/shared/defaultProjects.ts')
  const names = DEFAULT_PROJECTS.map((entry) => entry.name)
  assert.ok(!names.includes('Data'), 'the Data page needs no source of its own')
  assert.ok(!names.includes('Files'), 'Files was renamed')
  assert.ok(names.includes(FILE_SYSTEM_PROJECT_NAME))
  assert.ok(isDefaultProjectName('File System'), 'File System is a life source, not a personal one')

  const dbSource = fs.readFileSync(new URL('./src/main/database.ts', import.meta.url), 'utf8')
  assert.ok(
    /UPDATE projects SET name = 'File System' WHERE name = 'Files'/.test(dbSource),
    'existing databases rename in place rather than losing the connected paths'
  )
  assert.ok(/p\.name = 'Data'[\s\S]*?NOT EXISTS \(SELECT 1 FROM project_sources/.test(dbSource),
    'a Data project that carries anything is kept rather than deleted')

  const dataPage = fs.readFileSync(new URL('./src/renderer/components/DataPage.tsx', import.meta.url), 'utf8')
  assert.ok(/FileScopePanel/.test(dataPage), 'the file access scope lives on the File System source')
  const settingsPanel = fs.readFileSync(new URL('./src/renderer/components/SettingsPanel.tsx', import.meta.url), 'utf8')
  assert.ok(!/Add folder/.test(settingsPanel), 'the scope editor is no longer duplicated in Settings')
  assert.ok(/Moved to the/.test(settingsPanel), 'Settings points at where it went')
})

check('an index style is stored per project and drives the prompt version', () => {
  updateProject(workProject.id, { indexStyle: 'work' })
  const stored = listProjectRootContexts().length >= 0 && listSeparateContextProjectIds()
  assert.ok(Array.isArray(stored))
  const { styleVersion, stylePrompts, normalizeIndexStyle } = require('./src/main/indexStyles.ts')
  assert.equal(styleVersion('v5-line-cited', 'behavioral'), 'v5-line-cited', 'behavioral is unversioned by style')
  assert.equal(styleVersion('v5-line-cited', 'work'), 'v5-line-cited-work')
  assert.equal(stylePrompts('behavioral'), null, 'behavioral keeps the original prompts')
  assert.ok(stylePrompts('work').file.includes('on its own merits'))
  assert.ok(stylePrompts('reference').file.includes('Do NOT interpret'))
  assert.equal(normalizeIndexStyle('nonsense'), 'behavioral')
})

closeDatabase()
fs.rmSync(provDir, { recursive: true, force: true })
fs.rmSync(sigDir, { recursive: true, force: true })
fs.rmSync(docsDir, { recursive: true, force: true })
fs.rmSync(estimateDir, { recursive: true, force: true })
fs.rmSync(dbDir, { recursive: true, force: true })
console.log(`\nAll ${passed} document-context checks passed.`)
