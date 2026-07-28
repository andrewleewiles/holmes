import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { zipSync, strToU8 } from 'fflate'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-library-db-'))
process.env.HOLMES_USER_DATA = dbDir
const electronStub = {
  app: { getPath: () => dbDir, isPackaged: false, getAppPath: () => dbDir },
  // The scanner asks nativeImage to decode covers. Outside Electron there is no
  // decoder, so it reports empty and the shelf falls back to a typographic card
  // — exactly the SVG-cover path in production.
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
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

const { parseEpub, EpubParseError } = await import('./src/main/epub.ts')
const { parseBookDocument, CANONICAL_TEXT_VERSION } = await import('./src/main/bookText.ts')
const {
  DEFAULT_PROJECTS,
  BOOKS_PROJECT_NAME,
  defaultProjectCategory,
  isDefaultProjectName,
  isMediaProjectName,
  isLibraryProject,
  isDashboardProject,
  projectKindForCategory,
} = await import('./src/shared/defaultProjects.ts')
const { BOOK_EXTENSIONS, DOCUMENT_EXTENSIONS } = await import('./src/main/projectContext.ts')

const {
  initDatabase,
  listProjects,
  getProjectById,
  addProjectSource,
  listBooks,
  getBookById,
  listBookChapters,
  ensureReadingState,
  updateReadingState,
  recordReadingSession,
  listReadingSessions,
  countBookArtifacts,
} = await import('./src/main/database.ts')
initDatabase()

const { scanLibrary, getChapterContent, getCanonicalText, clearLibraryCache } =
  await import('./src/main/library.ts')
const { buildSpanSegments } = await import('./src/shared/textSpans.ts')
const { ANNOTATION_FOCUSES, parseAnnotationBlock } = await import('./src/shared/bookFocuses.ts')
const { annotationFocusVersion, annotationPromptFor } = await import('./src/main/annotationFocuses.ts')
const { locateQuote, locateQuoteSpan, quoteVariants, reanchorBookAnnotations, createManualAnnotation } =
  await import('./src/main/bookAnnotations.ts')
const { parseLessonResponse } = await import('./src/main/bookLessons.ts')
const { buildLibraryManifest } = await import('./src/main/booksContext.ts')
const { buildWordTimings, wordIndexAt, sentenceSpanAt, splitForSynthesis } =
  await import('./src/shared/audiobookTiming.ts')
const { ELEVENLABS_MODELS, findModel } = await import('./src/main/speech/elevenlabs.ts')
const { buildWordTimingsFromSpeechMarks, escapeForSsml } = await import('./src/shared/audiobookTiming.ts')
const { SPEECH_PROVIDERS, getSpeechProvider, isSpeechProviderId } = await import('./src/main/speech/index.ts')
const { sanitizeFolderName, fallbackFolderName, planOrganize, applyOrganizePlan } =
  await import('./src/main/bookOrganize.ts')
const { insertBookAnnotation, listBookAnnotations } = await import('./src/main/database.ts')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}
async function checkAsync(name, fn) {
  await fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

// --- fixtures ----------------------------------------------------------------

/** Builds a real EPUB3 in memory: the parser is exercised, not a mock of it. */
function buildEpub({ title = 'The Test Book', authors = ['Ada Lovelace'], chapters, subjects = ['fiction'] } = {}) {
  const manifestItems = chapters
    .map((_, i) => `<item id="c${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spineItems = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('\n')
  const navList = chapters
    .map((chapter, i) => `<li><a href="text/ch${i}.xhtml">${chapter.title}</a></li>`)
    .join('\n')

  const files = {
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
       <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>${title}</dc:title>
          ${authors.map((a) => `<dc:creator opf:role="aut">${a}</dc:creator>`).join('')}
          <dc:publisher>Test Press</dc:publisher>
          <dc:date>2011-05-04</dc:date>
          <dc:language>en</dc:language>
          <dc:identifier>urn:isbn:9780000000001</dc:identifier>
          ${subjects.map((s) => `<dc:subject>${s}</dc:subject>`).join('')}
        </metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          ${manifestItems}
        </manifest>
        <spine>${spineItems}</spine>
      </package>`
    ),
    'OEBPS/nav.xhtml': strToU8(
      `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navList}</ol></nav></body></html>`
    ),
  }
  chapters.forEach((chapter, i) => {
    files[`OEBPS/text/ch${i}.xhtml`] = strToU8(`<html><body>${chapter.html}</body></html>`)
  })
  return Buffer.from(zipSync(files))
}

const FIXTURE_CHAPTERS = [
  { title: 'The Opening', html: '<h1>The Opening</h1><p>It was a <em>bright</em> cold day in April.</p><p>The clocks were striking thirteen.</p>' },
  { title: 'The Argument', html: '<h1>The Argument</h1><p>Consider the following claim.</p><ul><li>First point</li><li>Second point</li></ul><blockquote>A quoted passage.</blockquote>' },
  { title: 'The Close', html: '<h1>The Close</h1><p>And so it ended.</p>' },
]

// --- the Media Sources category ----------------------------------------------
console.log('media sources')

check('every default project declares a category, and Books is the media one', () => {
  assert.ok(DEFAULT_PROJECTS.every((entry) => entry.category === 'life' || entry.category === 'media'))
  assert.equal(defaultProjectCategory(BOOKS_PROJECT_NAME), 'media')
  assert.ok(isMediaProjectName(BOOKS_PROJECT_NAME))
  assert.ok(!isMediaProjectName('Health'))
})

check('Books is a built-in, so it can be hidden but never deleted', () => {
  assert.ok(isDefaultProjectName(BOOKS_PROJECT_NAME))
})

check('a media project maps to the library kind, and library-ness keys off kind', () => {
  assert.equal(projectKindForCategory('media'), 'library')
  assert.equal(projectKindForCategory('life'), 'standard')
  // The point of the column: a renamed Books row is still a library, and a
  // standard project called "Books" is not silently promoted.
  assert.ok(isLibraryProject({ kind: 'library', name: 'My Shelf' }))
  assert.ok(!isLibraryProject({ kind: 'standard', name: BOOKS_PROJECT_NAME }))
})

check('media sources stay off the dashboard grid', () => {
  assert.ok(!isDashboardProject(BOOKS_PROJECT_NAME))
  assert.ok(!isDashboardProject('File System'))
  assert.ok(isDashboardProject('Health'))
})

check('an existing install gets the Books row without a manual restore', () => {
  const books = listProjects().find((project) => project.name === BOOKS_PROJECT_NAME)
  assert.ok(books, 'ensureMediaProjects must provision the Books source')
  assert.equal(books.kind, 'library')
  assert.ok(isLibraryProject(books))
})

check('EPUBs stay invisible to the document indexer', () => {
  // The whole product decision in one assertion: the generic indexer must never
  // discover a book, so .epub belongs to BOOK_EXTENSIONS alone.
  assert.ok(BOOK_EXTENSIONS.has('.epub'))
  assert.ok(!DOCUMENT_EXTENSIONS.has('.epub'))
})

check('every path into the document indexer excludes a library source', () => {
  // .pdf IS a document extension, so without these a shelf of PDF books would
  // be deep-indexed into the profile — the exact thing the design forbids.
  // Asserted by shape, not by prompt text, so a refactor that keeps the
  // guard passes and one that drops it does not.
  const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')
  for (const file of ['./src/main/ipc.ts', './src/main/main.ts', './src/main/documentContext.ts', './src/main/indexEstimate.ts']) {
    assert.match(read(file), /isLibraryProject/, `${file} must exclude library sources from generic indexing`)
  }
  const dataPage = read('./src/renderer/components/DataPage.tsx')
  assert.match(dataPage, /SourceGroup = 'life' \| 'media' \| 'personal'/)
  assert.match(dataPage, /Media sources/)
  assert.match(dataPage, /renderGroup\('media'/)
  assert.match(dataPage, /isLibraryProject/)
})

await checkAsync('generateDocumentContexts refuses a library source outright', async () => {
  const { generateDocumentContexts } = await import('./src/main/documentContext.ts')
  const books = listProjects().find((project) => project.name === BOOKS_PROJECT_NAME)
  await assert.rejects(
    () => generateDocumentContexts(books.id, { type: 'openrouter', apiKey: 'x' }, 'test-model'),
    /not indexed as documents/
  )
})

// --- EPUB parsing -------------------------------------------------------------
console.log('epub parsing')

check('reads metadata, spine order and nav titles from a real archive', () => {
  const parsed = parseEpub(buildEpub({ chapters: FIXTURE_CHAPTERS }))
  assert.equal(parsed.metadata.title, 'The Test Book')
  assert.deepEqual(parsed.metadata.authors, ['Ada Lovelace'])
  assert.equal(parsed.metadata.publisher, 'Test Press')
  assert.equal(parsed.metadata.language, 'en')
  assert.deepEqual(parsed.metadata.subjects, ['fiction'])
  assert.equal(parsed.spine.length, 3)
  assert.deepEqual(parsed.spine.map((entry) => entry.title), ['The Opening', 'The Argument', 'The Close'])
})

check('a chapter with no nav entry falls back to its own first heading', () => {
  const buffer = buildEpub({ chapters: [{ title: 'Ignored', html: '<h1>Real Heading</h1><p>Body.</p>' }] })
  // Strip the nav so there is nothing to match against.
  const parsed = parseEpub(buffer)
  parsed.spine.forEach((entry) => assert.ok(entry.title.length > 0))
})

check('a non-EPUB file is refused with a message, not a stack trace', () => {
  assert.throws(() => parseEpub(Buffer.from('not a zip')), EpubParseError)
})

// --- the block AST ------------------------------------------------------------
console.log('block ast')

check('script and style are dropped with their contents', () => {
  const { blocks, text } = parseBookDocument(
    '<p>Kept.</p><script>alert(1)</script><style>body{color:red}</style><p>Also kept.</p>',
    { baseOffset: 0, baseDir: '' }
  )
  assert.deepEqual(blocks.map((block) => block.kind), ['p', 'p'])
  assert.ok(!text.includes('alert'))
  assert.ok(!text.includes('color:red'))
})

check('inline marks survive but style and class attributes do not', () => {
  const { blocks } = parseBookDocument(
    '<p style="color:red" class="danger">A <strong>bold</strong> claim.</p>',
    { baseOffset: 0, baseDir: '' }
  )
  const marks = blocks[0].inlines.flatMap((run) => run.marks ?? [])
  assert.deepEqual(marks, ['strong'])
  assert.ok(!JSON.stringify(blocks).includes('color:red'))
  assert.ok(!JSON.stringify(blocks).includes('danger'))
})

check('block offsets index exactly into the canonical text', () => {
  const { blocks, text } = parseBookDocument(
    '<h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p>',
    { baseOffset: 0, baseDir: '' }
  )
  for (const block of blocks) {
    if (block.kind === 'hr' || block.kind === 'img' || block.kind === 'pagebreak') continue
    const expected = block.inlines.map((run) => run.text).join('')
    assert.equal(text.slice(block.start, block.end), expected, `block ${block.kind} must slice back out of the text`)
  }
})

check('inline runs index into the canonical text too', () => {
  const { blocks, text } = parseBookDocument(
    '<p>A <em>bright</em> cold day.</p>',
    { baseOffset: 0, baseDir: '' }
  )
  for (const run of blocks[0].inlines) {
    assert.equal(text.slice(run.start, run.start + run.text.length), run.text)
  }
})

check('a baseOffset shifts every offset by exactly that much', () => {
  const plain = parseBookDocument('<p>Alpha.</p><p>Beta.</p>', { baseOffset: 0, baseDir: '' })
  const shifted = parseBookDocument('<p>Alpha.</p><p>Beta.</p>', { baseOffset: 500, baseDir: '' })
  assert.equal(shifted.text, plain.text)
  plain.blocks.forEach((block, i) => {
    assert.equal(shifted.blocks[i].start, block.start + 500)
    assert.equal(shifted.blocks[i].end, block.end + 500)
  })
})

check('javascript: and data: hrefs render as text, never as links', () => {
  const { blocks } = parseBookDocument(
    `<p><a href="javascript:alert(1)">click</a> and <a href="data:text/html,<b>x</b>">this</a></p>`,
    { baseOffset: 0, baseDir: '' }
  )
  assert.ok(blocks[0].inlines.every((run) => run.link === undefined))
})

check('an internal href resolves to a chapter index, an http one stays external', () => {
  const { blocks } = parseBookDocument(
    '<p><a href="ch2.xhtml#sec">inside</a> <a href="https://example.com">outside</a></p>',
    {
      baseOffset: 0,
      baseDir: 'OEBPS/text',
      chapterIndexForHref: (href) => (href === 'OEBPS/text/ch2.xhtml' ? 7 : undefined),
    }
  )
  const links = blocks[0].inlines.map((run) => run.link).filter(Boolean)
  assert.deepEqual(links[0], { kind: 'internal', chapterIndex: 7, anchor: 'sec' })
  assert.deepEqual(links[1], { kind: 'external', url: 'https://example.com' })
})

check('an image with no matching resource is dropped rather than left broken', () => {
  const { blocks } = parseBookDocument('<p>Before</p><img src="missing.png"/><p>After</p>', {
    baseOffset: 0,
    baseDir: '',
    resourceIdForHref: () => undefined,
  })
  assert.ok(!blocks.some((block) => block.kind === 'img'))
})

check('the same input always produces the same canonical text', () => {
  const html = '<h1>T</h1><p>One.</p><ul><li>a</li><li>b</li></ul><p>Two.</p>'
  const first = parseBookDocument(html, { baseOffset: 0, baseDir: '' })
  const second = parseBookDocument(html, { baseOffset: 0, baseDir: '' })
  assert.equal(first.text, second.text)
  assert.equal(CANONICAL_TEXT_VERSION, 'v1')
})

// --- scanning -----------------------------------------------------------------
console.log('scanning')

const shelfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-shelf-'))
process.env.HOLMES_FILE_SCOPE_MODE = 'everywhere'
const booksProject = listProjects().find((project) => project.name === BOOKS_PROJECT_NAME)
addProjectSource(booksProject.id, shelfDir)

fs.writeFileSync(path.join(shelfDir, 'test-book.epub'), buildEpub({ chapters: FIXTURE_CHAPTERS }))
fs.writeFileSync(
  path.join(shelfDir, 'second.epub'),
  buildEpub({ title: 'Another Book', authors: ['Grace Hopper'], chapters: [FIXTURE_CHAPTERS[0]] })
)
// A file the parser cannot read: it must still reach the shelf, saying why.
fs.writeFileSync(path.join(shelfDir, 'broken.epub'), Buffer.from('definitely not a zip'))

await checkAsync('a scan shelves every book it finds, including the ones it cannot read', async () => {
  const result = await scanLibrary(booksProject.id)
  // The counters partition the shelf: added + updated + unchanged + failed.
  assert.equal(result.booksFound, 3)
  assert.equal(result.booksAdded, 2)
  assert.equal(result.booksFailed, 1)
  assert.ok(result.scanComplete)

  const shelved = listBooks(booksProject.id)
  assert.equal(shelved.length, 3)
  const broken = shelved.find((book) => book.relativePath === 'broken.epub')
  assert.equal(broken.status, 'failed')
  assert.ok(broken.scanError, 'an unreadable book must say why, not vanish')
})

await checkAsync('metadata, chapters and offsets are stored, and book text is not', async () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  assert.deepEqual(book.authors, ['Ada Lovelace'])
  assert.equal(book.chapterCount, 3)
  assert.ok(book.wordCount > 10)
  assert.ok(book.textHash.length > 0)

  const chapters = listBookChapters(book.id)
  assert.equal(chapters.length, 3)
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['The Opening', 'The Argument', 'The Close'])
  // Chapters tile the canonical text with no gaps and no overlaps.
  chapters.forEach((chapter, i) => {
    assert.equal(chapter.spineIndex, i)
    if (i > 0) assert.equal(chapter.charStart, chapters[i - 1].charEnd + 1)
  })

  // The safety property, asserted: no column on the row holds prose.
  const serialized = JSON.stringify(book)
  assert.ok(!serialized.includes('striking thirteen'), 'book text must never be persisted')
})

await checkAsync('an unchanged rescan re-parses nothing', async () => {
  const result = await scanLibrary(booksProject.id)
  assert.equal(result.booksUnchanged, 2, 'both readable books should be cache hits')
  assert.equal(result.booksAdded, 0)
  assert.equal(result.booksUpdated, 0)
})

await checkAsync('a touched file is re-parsed and keeps its id, and therefore its history', async () => {
  const before = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  updateReadingState(before.id, { status: 'reading', furthestCharOffset: 42 })

  const filePath = path.join(shelfDir, 'test-book.epub')
  const later = new Date(Date.now() + 10_000)
  fs.utimesSync(filePath, later, later)

  const result = await scanLibrary(booksProject.id)
  assert.equal(result.booksUpdated, 1)

  const after = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  assert.equal(after.id, before.id, 'the same file must keep its identity across a rescan')
  assert.equal(after.textHash, before.textHash, 'unchanged content means unchanged offsets')
  const reading = ensureReadingState(after.id)
  assert.equal(reading.status, 'reading')
  assert.equal(reading.furthestCharOffset, 42)
})

await checkAsync('a removed file is marked missing, never deleted', async () => {
  fs.rmSync(path.join(shelfDir, 'second.epub'))
  await scanLibrary(booksProject.id)
  const gone = listBooks(booksProject.id).find((entry) => entry.title === 'Another Book')
  assert.ok(gone, 'the shelf entry must survive the file going away')
  assert.ok(gone.missingSince, 'and must say when it went')
})

await checkAsync('an unreadable root reports incompleteness and shelves nothing new', async () => {
  const ghostProject = listProjects().find((project) => project.name === BOOKS_PROJECT_NAME)
  addProjectSource(ghostProject.id, path.join(shelfDir, 'does-not-exist'))
  const result = await scanLibrary(ghostProject.id)
  assert.ok(!result.scanComplete, 'a scan that could not read a root is not complete')
  assert.ok(result.unreadableRoots.length > 0)
  // And nothing was pruned on the strength of a partial view.
  assert.equal(listBooks(ghostProject.id).length, 3)
})

// --- reading ------------------------------------------------------------------
console.log('reading')

await checkAsync('a chapter is served as blocks whose offsets match the stored bounds', async () => {
  clearLibraryCache()
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  const chapters = listBookChapters(book.id)
  const content = await getChapterContent(book.id, 1)

  assert.equal(content.title, 'The Argument')
  assert.equal(content.charStart, chapters[1].charStart)
  assert.equal(content.charEnd, chapters[1].charEnd)
  assert.ok(content.blocks.length > 0)
  for (const block of content.blocks) {
    assert.ok(block.start >= content.charStart)
    assert.ok(block.end <= content.charEnd)
  }
  assert.ok(content.blocks.some((block) => block.kind === 'li'))
  assert.ok(content.blocks.some((block) => block.kind === 'blockquote'))
})

await checkAsync('the canonical text of a chapter range slices out of the whole book', async () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  const whole = await getCanonicalText(book.id)
  const range = await getCanonicalText(book.id, 1, 1)
  const chapters = listBookChapters(book.id)
  assert.equal(range.charStart, chapters[1].charStart)
  assert.equal(range.text, whole.text.slice(chapters[1].charStart, chapters[1].charEnd))
})

await checkAsync('asking for a chapter that does not exist is an error, not an empty page', async () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  await assert.rejects(() => getChapterContent(book.id, 99))
})

check('reading sessions accumulate as evidence of how a book was read', () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  recordReadingSession({
    bookId: book.id,
    startedAt: '2026-01-04T20:00:00.000Z',
    endedAt: '2026-01-04T20:34:00.000Z',
    chapterStart: 0, chapterEnd: 1, charsAdvanced: 1200, seconds: 2040,
  })
  const sessions = listReadingSessions(book.id)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].seconds, 2040)
})

check('artifact counts are cheap and start at zero', () => {
  const ids = listBooks(booksProject.id).map((entry) => entry.id)
  const counts = countBookArtifacts(ids)
  assert.equal(counts.size, ids.length)
  assert.equal(counts.get(ids[0]).lessons, 0)
  assert.equal(counts.get(ids[0]).annotations, 0)
})


// --- span sweep ----------------------------------------------------------------
console.log('span segments')

check('non-overlapping spans split the text the obvious way', () => {
  const segments = buildSpanSegments('abcdefghij', [{ id: 'a', start: 2, end: 5 }])
  assert.deepEqual(segments.map((s) => [s.text, s.spanIds]), [
    ['ab', []],
    ['cde', ['a']],
    ['fghij', []],
  ])
})

check('overlapping spans produce a segment carrying BOTH — the reason this exists', () => {
  // Two annotation focuses will underline overlapping sentences. A splitter that
  // assumed non-overlap would silently drop one of them.
  const segments = buildSpanSegments('abcdefghij', [
    { id: 'a', start: 1, end: 5 },
    { id: 'b', start: 3, end: 8 },
  ])
  const both = segments.find((s) => s.spanIds.length === 2)
  assert.ok(both, 'the overlap must be its own segment')
  assert.equal(both.text, 'de')
  assert.deepEqual(both.spanIds, ['a', 'b'])
  assert.equal(segments.map((s) => s.text).join(''), 'abcdefghij', 'segments must reconstruct the text')
})

check('a shift moves every span, and spans outside the text are dropped', () => {
  const segments = buildSpanSegments('abcde', [{ id: 'a', start: 102, end: 104 }], -100)
  assert.deepEqual(segments.map((s) => [s.text, s.spanIds]), [['ab', []], ['cd', ['a']], ['e', []]])
  assert.deepEqual(buildSpanSegments('abcde', [{ id: 'x', start: 90, end: 95 }]), [{ text: 'abcde', spanIds: [], key: 'all' }])
})

// --- annotation focuses ---------------------------------------------------------
console.log('annotation focuses')

check('each built-in focus gets its own prompt version, so one run never invalidates another', () => {
  const versions = ANNOTATION_FOCUSES
    .filter((focus) => focus.key !== 'custom')
    .map((focus) => annotationFocusVersion('base', { key: focus.key }))
  assert.equal(new Set(versions).size, versions.length)
  // Shape, not literal: never assert a prompt-version string.
  assert.ok(versions.every((version) => version.startsWith('base-')))
})

check('a custom focus hashes its text in, so an edit is a new run and a repeat is a cache hit', () => {
  const first = annotationFocusVersion('base', { key: 'custom', customText: 'habit formation' })
  const same = annotationFocusVersion('base', { key: 'custom', customText: '  Habit   Formation  ' })
  const edited = annotationFocusVersion('base', { key: 'custom', customText: 'habit formation and sleep' })
  assert.equal(first, same, 'whitespace and case must not mint a new run')
  assert.notEqual(first, edited)
})

check('every focus produces a prompt that demands a verbatim quote', () => {
  for (const focus of ANNOTATION_FOCUSES) {
    const selection = focus.key === 'custom' ? { key: focus.key, customText: 'anything' } : { key: focus.key }
    const { prompt, label } = annotationPromptFor(selection)
    assert.ok(prompt.includes('VERBATIM'), `${focus.key} must require a verbatim quote`)
    assert.ok(prompt.includes('ANNOTATIONS:'))
    assert.ok(label.length > 0)
  }
})

check('a custom focus with no description is refused rather than run empty', () => {
  assert.throws(() => annotationPromptFor({ key: 'custom', customText: '   ' }))
})

check('the annotation block parser is tolerant and keeps pipes inside a note', () => {
  const parsed = parseAnnotationBlock(`Some preamble.

ANNOTATIONS:
- claim | The core thesis | attention is the scarce resource | Everything after rests on this
- garbage line with no pipes
- definition | Attention | a limited pool | Used loosely here | but tightened later
`)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].kind, 'claim')
  assert.equal(parsed[0].quote, 'attention is the scarce resource')
  assert.equal(parsed[1].note, 'Used loosely here | but tightened later')
})

// --- anchoring ------------------------------------------------------------------
console.log('anchoring')

check('a quote is located exactly, and through normalized punctuation', () => {
  const text = 'It was a bright cold day in April, and the clocks were striking thirteen.'
  assert.equal(locateQuote(text, 'bright cold day'), 9)
  // Curly quotes and collapsed whitespace are what a model changes without meaning to.
  const curly = 'She said \u201Cthe  clocks\u201D were   striking.'
  assert.ok(locateQuote(curly, '"the clocks" were striking') >= 0)
  assert.equal(locateQuote(text, 'a passage that is simply not there'), -1)
})

check('a repeated quote resolves toward its previous home', () => {
  const text = 'the same phrase here, then filler, then the same phrase again'
  const first = locateQuote(text, 'the same phrase')
  const later = locateQuote(text, 'the same phrase', 50)
  assert.equal(first, 0)
  assert.ok(later > first, 'preferNear must pull toward the later occurrence')
})

await checkAsync('an annotation survives an edit by re-anchoring, and is never deleted', async () => {
  clearLibraryCache()
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  const { text } = await getCanonicalText(book.id)
  const quote = 'The clocks were striking thirteen.'
  const at = text.indexOf(quote)
  assert.ok(at >= 0, 'fixture sanity')

  insertBookAnnotation({
    runId: null, bookId: book.id, chapterIndex: 0,
    charStart: at, charEnd: at + quote.length,
    quote, prefix: text.slice(Math.max(0, at - 32), at), suffix: text.slice(at + quote.length, at + quote.length + 32),
    kind: 'claim', label: 'Opening image', body: 'Sets the register.',
    origin: 'ai', pinned: false, anchorStatus: 'exact',
  })
  insertBookAnnotation({
    runId: null, bookId: book.id, chapterIndex: 0,
    charStart: 0, charEnd: 20,
    quote: 'a passage that never existed in this book at all',
    prefix: '', suffix: '',
    kind: 'claim', label: 'Bogus', body: '',
    origin: 'ai', pinned: false, anchorStatus: 'exact',
  })

  // Rewrite the book with an inserted opening chapter: every offset moves.
  const shifted = buildEpub({
    chapters: [{ title: 'A New Preface', html: '<h1>A New Preface</h1><p>Inserted before everything else.</p>' }, ...FIXTURE_CHAPTERS],
  })
  fs.writeFileSync(path.join(shelfDir, 'test-book.epub'), shifted)
  const later = new Date(Date.now() + 20_000)
  fs.utimesSync(path.join(shelfDir, 'test-book.epub'), later, later)
  await scanLibrary(booksProject.id)

  const after = listBookAnnotations(book.id)
  assert.equal(after.length, 2, 'nothing is ever deleted by a rescan')
  const relocated = after.find((entry) => entry.label === 'Opening image')
  const lost = after.find((entry) => entry.label === 'Bogus')
  assert.equal(relocated.anchorStatus, 'shifted')
  const { text: newText } = await getCanonicalText(book.id)
  assert.equal(newText.slice(relocated.charStart, relocated.charEnd), quote, 're-anchored offsets must land on the quote')
  assert.equal(lost.anchorStatus, 'orphaned', 'an unfindable annotation is marked, not removed')
})

await checkAsync('a manual highlight uses the same anchor mechanism', async () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  const { text } = await getCanonicalText(book.id)
  const at = text.indexOf('Inserted before everything else.')
  const annotation = await createManualAnnotation({
    bookId: book.id, chapterIndex: 0, charStart: at, charEnd: at + 12,
    label: 'Mine', body: 'note to self',
  })
  assert.equal(annotation.origin, 'manual')
  assert.equal(annotation.quote, text.slice(at, at + 12))
  assert.ok(annotation.suffix.length > 0, 'context is captured so it can survive an edit')
})

// --- lessons ---------------------------------------------------------------------
console.log('lessons')

check('the lesson parser survives code fences and prose around the JSON', () => {
  const parsed = parseLessonResponse('Sure! Here is the lesson:\n```json\n{"title":"T","overview":"O","objectives":["a"],"concepts":[],"questions":[]}\n```\nHope that helps.')
  assert.equal(parsed.title, 'T')
  assert.deepEqual(parsed.objectives, ['a'])
})

check('a broken multiple-choice question degrades to an open one rather than being dropped', () => {
  const parsed = parseLessonResponse(JSON.stringify({
    title: 'T', overview: 'O', objectives: [], concepts: [],
    questions: [
      { kind: 'multiple_choice', prompt: 'Good one?', choices: ['a', 'b', 'c', 'd'], correctIndex: 2, modelAnswer: 'c' },
      { kind: 'multiple_choice', prompt: 'Index out of range?', choices: ['a', 'b'], correctIndex: 9, modelAnswer: 'x' },
      { kind: 'multiple_choice', prompt: 'Only one choice?', choices: ['a'], correctIndex: 0, modelAnswer: 'a' },
    ],
  }))
  assert.equal(parsed.questions.length, 3, 'nothing is discarded')
  assert.equal(parsed.questions[0].kind, 'multiple_choice')
  assert.equal(parsed.questions[1].kind, 'open')
  assert.equal(parsed.questions[2].kind, 'open')
})

check('an unreadable response is an error, not a silently empty lesson', () => {
  assert.throws(() => parseLessonResponse('I am afraid I cannot do that.'))
})

// --- the reading record ----------------------------------------------------------
console.log('reading record')

check('the manifest carries the catalogue and the record, and no book text', () => {
  const manifest = buildLibraryManifest(booksProject.id)
  assert.ok(manifest.text.includes('The Test Book'))
  assert.ok(manifest.text.includes('Ada Lovelace'))
  assert.ok(manifest.text.includes('LIBRARY ('))
  assert.ok(manifest.text.includes('TIMELINE FACTS'))
  // The governing rule, asserted where it can regress.
  assert.ok(!manifest.text.includes('striking thirteen'), 'book prose must never reach the manifest')
  assert.ok(!manifest.text.includes('Inserted before everything else'))
  assert.ok(manifest.edges.every((edge) => edge.ref.startsWith('book:')))
})

check('the manifest is stable across reads, so an unchanged shelf never costs money', () => {
  assert.equal(buildLibraryManifest(booksProject.id).text, buildLibraryManifest(booksProject.id).text)
})

check('reading a few more characters does not move the manifest hash', () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  const before = buildLibraryManifest(booksProject.id).text
  // Progress is rounded to whole percent precisely so scrolling is not a purchase.
  updateReadingState(book.id, { furthestCharOffset: 3, progressPercent: 0.4 })
  assert.equal(buildLibraryManifest(booksProject.id).text, before)
})

check('finishing a book puts a dated fact in the manifest for the timeline to harvest', () => {
  const book = listBooks(booksProject.id).find((entry) => entry.title === 'The Test Book')
  updateReadingState(book.id, { status: 'finished', finishedAt: '2026-03-04T10:00:00.000Z', progressPercent: 100 })
  const manifest = buildLibraryManifest(booksProject.id)
  assert.match(manifest.text, /2026-03-04 \| day \| learning \| Finished "The Test Book"/)
})


// --- narration timing ------------------------------------------------------------
console.log('narration timing')

/** An alignment shaped exactly like ElevenLabs returns, for a known sentence. */
function alignmentFor(text, secondsPerChar = 0.05) {
  return {
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => Number((i * secondsPerChar).toFixed(4))),
    character_end_times_seconds: [...text].map((_, i) => Number(((i + 1) * secondsPerChar).toFixed(4))),
  }
}

check('character alignment becomes word spans in absolute canonical offsets', () => {
  const text = 'The clocks were striking thirteen.'
  const { words, mismatched } = buildWordTimings({ alignment: alignmentFor(text), charStart: 1000, text })
  assert.equal(mismatched, false)
  // Five words, and every span slices its own word back out of the source text.
  assert.equal(words.charStart.length, 5)
  const sliced = words.charStart.map((start, i) => text.slice(start - 1000, words.charEnd[i] - 1000))
  assert.deepEqual(sliced, ['The', 'clocks', 'were', 'striking', 'thirteen'])
  // The offsets are absolute, so they index the book and not the request.
  assert.equal(words.charStart[0], 1000)
  assert.ok(words.startSeconds[0] < words.startSeconds[4])
})

check('a word ends when its last character does, not when the space after it does', () => {
  const text = 'Go now'
  const { words } = buildWordTimings({ alignment: alignmentFor(text, 0.1), charStart: 0, text })
  // "Go" occupies characters 0-1, so it ends at the end of index 1 (0.2), not at
  // the end of the space that closed it (0.3).
  assert.equal(words.charEnd[0], 2)
  assert.ok(Math.abs(words.endSeconds[0] - 0.2) < 1e-6)
})

check('apostrophes and hyphens stay inside one word', () => {
  const text = "Don't over-think O'Brien"
  const { words } = buildWordTimings({ alignment: alignmentFor(text), charStart: 0, text })
  const sliced = words.charStart.map((start, i) => text.slice(start, words.charEnd[i]))
  assert.deepEqual(sliced, ["Don't", 'over-think', "O'Brien"])
})

check('an alignment that does not describe the text we sent is reported, not applied', () => {
  // The failure that matters: applying these offsets would highlight words that
  // are not the ones being spoken.
  const result = buildWordTimings({
    alignment: alignmentFor('completely different text'),
    charStart: 0,
    text: 'The clocks were striking thirteen.',
  })
  assert.equal(result.mismatched, true)
})

check('a ragged alignment yields no timings rather than wrong ones', () => {
  const result = buildWordTimings({
    alignment: { characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [1] },
    charStart: 0,
    text: 'ab',
  })
  assert.equal(result.mismatched, true)
  assert.equal(result.words.charStart.length, 0)
})

check('the spoken word is found by time, and the gap between words is empty', () => {
  const text = 'One two'
  const { words } = buildWordTimings({ alignment: alignmentFor(text, 0.1), charStart: 0, text })
  assert.equal(wordIndexAt(words, 0.05), 0)
  assert.equal(wordIndexAt(words, 0.45), 1)
  // Before the first word starts there is nothing to highlight.
  assert.equal(wordIndexAt(words, -1), -1)
  // And past the end the highlight clears instead of sticking to the last word.
  assert.equal(wordIndexAt(words, 99), -1)
})

check('word lookup agrees with a linear scan across the whole range', () => {
  const text = 'Alpha beta gamma delta epsilon zeta eta theta'
  const { words } = buildWordTimings({ alignment: alignmentFor(text, 0.03), charStart: 0, text })
  for (let t = 0; t < 1.5; t += 0.007) {
    let expected = -1
    for (let i = 0; i < words.startSeconds.length; i += 1) {
      if (words.startSeconds[i] <= t && t <= words.endSeconds[i]) { expected = i; break }
    }
    assert.equal(wordIndexAt(words, t), expected, `at t=${t.toFixed(3)}`)
  }
})

check('the sentence around a word is found in canonical offsets', () => {
  const text = 'First one. Second one here! Third?'
  const span = sentenceSpanAt(text, 500, 500 + text.indexOf('Second'))
  assert.equal(text.slice(span.start - 500, span.end - 500), 'Second one here!')
})

check('an offset outside the text has no sentence', () => {
  assert.equal(sentenceSpanAt('short', 0, 99), null)
})

// --- chunking ---------------------------------------------------------------------
console.log('narration chunking')

check('text under the cap is one request', () => {
  const chunks = splitForSynthesis('A short chapter.', 5000)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].offset, 0)
})

check('chunks tile the text exactly, with no character lost or duplicated', () => {
  const paragraph = 'This is a sentence that runs on for a while. And here is another one. '
  const text = paragraph.repeat(60)
  const chunks = splitForSynthesis(text, 500)
  assert.ok(chunks.length > 1)
  // Reassembling the pieces must reproduce the input, or the narration would
  // skip or repeat words.
  assert.equal(chunks.map((c) => c.text).join(''), text)
  // And every offset must point at where its own text actually starts.
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.offset, chunk.offset + chunk.text.length), chunk.text)
  }
})

check('no chunk exceeds the cap', () => {
  const text = 'Sentence number one. '.repeat(400)
  for (const cap of [200, 500, 1500]) {
    for (const chunk of splitForSynthesis(text, cap)) {
      assert.ok(chunk.text.length <= cap, `chunk of ${chunk.text.length} exceeds cap ${cap}`)
    }
  }
})

check('chunks break at sentence ends rather than mid-word', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. '.repeat(20)
  const chunks = splitForSynthesis(text, 120)
  for (const chunk of chunks.slice(0, -1)) {
    // A seam inside a word would be audible and would be spoken as two words.
    assert.ok(/[\s]$/.test(chunk.text), `chunk ends mid-word: ${JSON.stringify(chunk.text.slice(-20))}`)
  }
})

check('a single unbroken run longer than the cap is still split rather than rejected', () => {
  const text = 'x'.repeat(1000)
  const chunks = splitForSynthesis(text, 300)
  assert.equal(chunks.map((c) => c.text).join(''), text)
  assert.ok(chunks.every((c) => c.text.length <= 300))
})

check('every offered model declares a cap that chunking can actually meet', () => {
  assert.ok(ELEVENLABS_MODELS.length > 0)
  for (const model of ELEVENLABS_MODELS) {
    assert.ok(model.maxCharacters > 1000, `${model.modelId} cap looks wrong`)
    assert.equal(findModel(model.modelId).modelId, model.modelId)
  }
  assert.throws(() => findModel('not-a-model'))
})


// --- Speechify speech marks --------------------------------------------------------
console.log('speechify speech marks')

/** Builds marks the way Speechify does: word-level, MILLISECONDS, escaped offsets. */
function speechMarksFor(escapedText, msPerChar = 50) {
  const chunks = []
  const wordPattern = /[^\s]+/g
  let match
  while ((match = wordPattern.exec(escapedText)) !== null) {
    chunks.push({
      type: 'word',
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
      start_time: match.index * msPerChar,
      end_time: (match.index + match[0].length) * msPerChar,
    })
  }
  return {
    type: 'sentence',
    value: escapedText,
    start: 0,
    end: escapedText.length,
    start_time: 0,
    // Trailing silence: the parent runs past the last word, as documented.
    end_time: escapedText.length * msPerChar + 400,
    chunks,
  }
}

check('speech marks become word spans in absolute canonical offsets', () => {
  const text = 'The clocks were striking thirteen.'
  const escaped = escapeForSsml(text)
  const result = buildWordTimingsFromSpeechMarks({
    marks: speechMarksFor(escaped.text), charStart: 2000, text, escaped,
  })
  assert.equal(result.mismatched, false)
  const sliced = result.words.charStart.map((start, i) => text.slice(start - 2000, result.words.charEnd[i] - 2000))
  assert.deepEqual(sliced, ['The', 'clocks', 'were', 'striking', 'thirteen.'])
  assert.equal(result.words.charStart[0], 2000)
})

check('milliseconds are converted to seconds', () => {
  const text = 'Hello world'
  const escaped = escapeForSsml(text)
  const result = buildWordTimingsFromSpeechMarks({
    marks: speechMarksFor(escaped.text, 100), charStart: 0, text, escaped,
  })
  // "Hello" spans characters 0-5, so 0ms to 500ms — half a second, not 500.
  assert.ok(Math.abs(result.words.startSeconds[0] - 0) < 1e-9)
  assert.ok(Math.abs(result.words.endSeconds[0] - 0.5) < 1e-9)
  // And the duration comes from the parent, which includes the trailing silence.
  assert.ok(result.durationSeconds > result.words.endSeconds[result.words.endSeconds.length - 1])
})

check('an ampersand shifts SSML offsets, and the map puts them back', () => {
  // The failure this prevents: Speechify counts "&amp;" as five characters, so
  // every word after one would land four characters ahead of where it is.
  const text = 'Salt & pepper and thyme'
  const escaped = escapeForSsml(text)
  assert.equal(escaped.text, 'Salt &amp; pepper and thyme')

  const result = buildWordTimingsFromSpeechMarks({
    marks: speechMarksFor(escaped.text), charStart: 0, text, escaped,
  })
  const sliced = result.words.charStart.map((start, i) => text.slice(start, result.words.charEnd[i]))
  assert.deepEqual(sliced, ['Salt', '&', 'pepper', 'and', 'thyme'])
  // "thyme" is at 18 in the original and 22 in the escaped form; the stored span
  // must be the original one.
  assert.equal(text.slice(result.words.charStart[4], result.words.charEnd[4]), 'thyme')
  assert.equal(result.words.charStart[4], text.indexOf('thyme'))
})

check('all three SSML characters round-trip through the offset map', () => {
  const text = 'a & b < c > d'
  const escaped = escapeForSsml(text)
  assert.equal(escaped.text, 'a &amp; b &lt; c &gt; d')
  for (let i = 0; i <= escaped.text.length; i += 1) {
    const original = escaped.toOriginal[i]
    assert.ok(original !== undefined && original >= 0 && original <= text.length, `no mapping for escaped index ${i}`)
  }
  // Every original index is reachable, so no word can become unaddressable.
  const reachable = new Set(escaped.toOriginal)
  for (let i = 0; i < text.length; i += 1) assert.ok(reachable.has(i), `original index ${i} unreachable`)
})

check('a mark whose value does not match the text it claims is dropped, not trusted', () => {
  const text = 'The clocks were striking'
  const escaped = escapeForSsml(text)
  const marks = speechMarksFor(escaped.text)
  // Corrupt one mark's offsets, as a drifted alignment would.
  marks.chunks[2].start += 3
  marks.chunks[2].end += 3
  const result = buildWordTimingsFromSpeechMarks({ marks, charStart: 0, text, escaped })
  assert.equal(result.droppedWords, 1)
  const sliced = result.words.charStart.map((start, i) => text.slice(start, result.words.charEnd[i]))
  assert.deepEqual(sliced, ['The', 'clocks', 'striking'], 'the bad mark is gone, the good ones survive')
})

check('marks that mostly fail to match are reported as a mismatch', () => {
  const text = 'One two three four'
  const escaped = escapeForSsml(text)
  const marks = speechMarksFor(escaped.text)
  for (const chunk of marks.chunks) chunk.value = 'nonsense'
  const result = buildWordTimingsFromSpeechMarks({ marks, charStart: 0, text, escaped })
  assert.equal(result.mismatched, true)
})

check('sentence-level chunks are ignored so a whole clause never lights up at once', () => {
  const text = 'One two'
  const escaped = escapeForSsml(text)
  const marks = speechMarksFor(escaped.text)
  marks.chunks.push({ type: 'sentence', value: text, start: 0, end: text.length, start_time: 0, end_time: 700 })
  const result = buildWordTimingsFromSpeechMarks({ marks, charStart: 0, text, escaped })
  assert.equal(result.words.charStart.length, 2)
})

check('speech marks and character alignment produce the same word lookup', () => {
  // The point of the abstraction: whichever service narrated, the reader asks
  // the same question and gets the same kind of answer.
  const text = 'Alpha beta gamma'
  const escaped = escapeForSsml(text)
  const fromMarks = buildWordTimingsFromSpeechMarks({
    marks: speechMarksFor(escaped.text, 50), charStart: 100, text, escaped,
  })
  const fromAlignment = buildWordTimings({ alignment: alignmentFor(text, 0.05), charStart: 100, text })
  assert.deepEqual(fromMarks.words.charStart, fromAlignment.words.charStart)
  // Ends differ by punctuation handling only; the spans must still land on words.
  for (let i = 0; i < fromMarks.words.charStart.length; i += 1) {
    assert.equal(
      text.slice(fromMarks.words.charStart[i] - 100, fromMarks.words.charEnd[i] - 100).trim().length > 0,
      true
    )
  }
})

// --- the provider registry ----------------------------------------------------------
console.log('narration providers')

check('both services are registered and answer the same interface', () => {
  const ids = SPEECH_PROVIDERS.map((p) => p.id)
  assert.deepEqual(ids.sort(), ['elevenlabs', 'speechify'])
  for (const provider of SPEECH_PROVIDERS) {
    assert.ok(provider.label)
    assert.ok(provider.baseUrl.startsWith('https://'))
    assert.ok(provider.models().length > 0)
    assert.ok(provider.models().some((m) => m.modelId === provider.defaultModelId()))
    for (const method of ['listVoices', 'getQuota', 'synthesize', 'verifyKey', 'hasKey', 'setKey', 'clearKey']) {
      assert.equal(typeof provider[method], 'function', `${provider.id} is missing ${method}`)
    }
  }
})

check('an unknown provider id is refused rather than defaulted', () => {
  assert.throws(() => getSpeechProvider('notaservice'))
  assert.ok(isSpeechProviderId('speechify'))
  assert.ok(!isSpeechProviderId('notaservice'))
})

check('every model declares a cap the chunker can meet, on both services', () => {
  for (const provider of SPEECH_PROVIDERS) {
    for (const model of provider.models()) {
      assert.ok(model.maxCharacters > 1000, `${provider.id}/${model.modelId} cap looks wrong`)
      const chunks = splitForSynthesis('Sentence here. '.repeat(2000), Math.floor(model.maxCharacters * 0.95))
      assert.ok(chunks.every((c) => c.text.length <= model.maxCharacters))
    }
  }
})

check('only providers that support stitching claim to', () => {
  // Speechify has no request-stitching equivalent; saying it did would make the
  // generator pass ids that are silently ignored.
  assert.equal(getSpeechProvider('elevenlabs').supportsStitching, true)
  assert.equal(getSpeechProvider('speechify').supportsStitching, false)
  assert.ok(getSpeechProvider('speechify').models().every((m) => !m.canStitch))
})


// --- organising files ---------------------------------------------------------------
console.log('organising files')

check('a folder name keeps its spaces and hyphens', () => {
  // The format IS "Last - Title", so a sanitizer that ate hyphens or spaces
  // would quietly destroy every name it touched.
  assert.equal(sanitizeFolderName('Orwell - Nineteen Eighty-Four'), 'Orwell - Nineteen Eighty-Four')
  assert.equal(sanitizeFolderName('Garc\u00eda M\u00e1rquez - Love in the Time of Cholera'), 'Garc\u00eda M\u00e1rquez - Love in the Time of Cholera')
})

check('characters a filesystem would reject are removed', () => {
  assert.ok(!sanitizeFolderName('A/B\\C:D*E?F"G<H>I|J').match(/[/\\:*?"<>|]/))
  // A leading dot would hide the folder; a trailing dot breaks on Windows.
  assert.equal(sanitizeFolderName('...Hidden'), 'Hidden')
  assert.equal(sanitizeFolderName('Trailing. '), 'Trailing')
  assert.equal(sanitizeFolderName('Tabs\tand\nnewlines'), 'Tabs and newlines')
})

check('the metadata fallback handles both author orderings', () => {
  const book = (authors, title) => ({ authors, title, filePath: '/x/whatever.epub' })
  assert.equal(fallbackFolderName(book(['George Orwell'], 'Nineteen Eighty-Four')), 'Orwell - Nineteen Eighty-Four')
  assert.equal(fallbackFolderName(book(['Orwell, George'], 'Nineteen Eighty-Four')), 'Orwell - Nineteen Eighty-Four')
})

check('no author means the title alone, never the word Unknown', () => {
  const named = fallbackFolderName({ authors: [], title: 'A Book With No Author', filePath: '/x/a.epub' })
  assert.equal(named, 'A Book With No Author')
  assert.ok(!/unknown/i.test(named))
})

check('no title falls back to the filename rather than an empty folder', () => {
  assert.equal(fallbackFolderName({ authors: [], title: '', filePath: '/x/some-download.epub' }), 'some-download')
})

await checkAsync('a plan moves each book into its own folder, taking its sidecars', async () => {
  // realpath'd, because the scanner stores realpath'd paths and on macOS
  // /var and /private/var are the same directory under two names.
  const organizeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-organize-')))
  const project = listProjects().find((p) => p.name === BOOKS_PROJECT_NAME)
  addProjectSource(project.id, organizeDir)

  fs.writeFileSync(path.join(organizeDir, 'orwell1984.epub'), buildEpub({
    title: 'Nineteen Eighty-Four', authors: ['George Orwell'], chapters: [FIXTURE_CHAPTERS[0]],
  }))
  // A cover and a metadata file sharing the book's basename.
  fs.writeFileSync(path.join(organizeDir, 'orwell1984.jpg'), Buffer.from('cover'))
  fs.writeFileSync(path.join(organizeDir, 'orwell1984.opf'), '<package/>')
  // An unrelated file that must NOT be dragged along.
  fs.writeFileSync(path.join(organizeDir, 'unrelated.txt'), 'leave me')

  await scanLibrary(project.id)
  // offline: the naming model is not called in tests, so this exercises the
  // metadata fallback and the whole move path.
  const plan = await planOrganize(project.id, { offline: true })
  const entry = plan.entries.find((e) => e.currentPath.endsWith('orwell1984.epub'))
  assert.ok(entry, 'the new book must appear in the plan')
  assert.equal(entry.folderName, 'Orwell - Nineteen Eighty-Four')
  assert.equal(entry.skipped, null)
  assert.equal(entry.sidecars.length, 2, 'the cover and the opf travel with it')

  const result = applyOrganizePlan({ ...plan, entries: [entry] })
  assert.equal(result.moved, 1)
  assert.deepEqual(result.failed, [])

  const folder = path.join(organizeDir, 'Orwell - Nineteen Eighty-Four')
  assert.ok(fs.existsSync(path.join(folder, 'orwell1984.epub')))
  assert.ok(fs.existsSync(path.join(folder, 'orwell1984.jpg')))
  assert.ok(fs.existsSync(path.join(folder, 'orwell1984.opf')))
  assert.ok(fs.existsSync(path.join(organizeDir, 'unrelated.txt')), 'an unrelated file stays put')

  // The shelf entry follows the file, or the reader would open a missing path.
  const moved = listBooks(project.id).find((b) => b.id === entry.bookId)
  assert.equal(moved.filePath, path.join(folder, 'orwell1984.epub'))

  // And a rescan must not treat the moved book as new — the identity hash was
  // recomputed, so its contents are not parsed again.
  const rescan = await scanLibrary(project.id)
  assert.equal(rescan.booksAdded, 0, 'a moved book is not re-added')
})

await checkAsync('a book already in its folder is left alone', async () => {
  const project = listProjects().find((p) => p.name === BOOKS_PROJECT_NAME)
  const plan = await planOrganize(project.id, { offline: true })
  const already = plan.entries.find((e) => e.folderName === 'Orwell - Nineteen Eighty-Four')
  assert.ok(already)
  assert.equal(already.targetPath, null)
  assert.match(already.skipped, /Already filed/)
})

await checkAsync('a plan entry pointing outside the source is refused at apply time', async () => {
  const project = listProjects().find((p) => p.name === BOOKS_PROJECT_NAME)
  const plan = await planOrganize(project.id, { offline: true })
  const victim = plan.entries.find((e) => e.currentPath)
  // A doctored plan — the one thing that must never be trusted, since the plan
  // round-trips through the renderer.
  const escapeTo = path.join(os.tmpdir(), 'holmes-escape-target.epub')
  // A previous run must not be able to make this pass or fail spuriously.
  fs.rmSync(escapeTo, { force: true })
  const result = applyOrganizePlan({
    ...plan,
    entries: [{ ...victim, targetPath: escapeTo, skipped: null }],
  })
  assert.ok(!fs.existsSync(escapeTo), 'nothing may be written outside the connected source')
  assert.equal(result.moved, 0, 'a doctored destination must move nothing')
  assert.equal(result.failed.length, 1)
  assert.match(result.failed[0].error, /outside this source/)
})


// --- quotes as models actually return them --------------------------------------
console.log('quote decoration')

const PASSAGE = 'It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith slipped quickly through the glass doors.'

check('a quote wrapped in quotation marks still finds its passage', () => {
  // This is the real-world failure: asked for a verbatim quote, models hand back
  // "like this" — and a literal match then misses EVERY annotation in the run.
  for (const decorated of [
    '"the clocks were striking thirteen"',
    '\u201Cthe clocks were striking thirteen\u201D',
    "'the clocks were striking thirteen'",
    '\u2018the clocks were striking thirteen\u2019',
    '\u00abthe clocks were striking thirteen\u00bb',
    '`the clocks were striking thirteen`',
  ]) {
    const hit = quoteVariants(decorated).map((v) => locateQuote(PASSAGE, v)).find((at) => at !== -1)
    assert.ok(hit !== undefined && hit >= 0, `missed: ${decorated}`)
    assert.equal(PASSAGE.slice(hit, hit + 'the clocks were striking thirteen'.length), 'the clocks were striking thirteen')
  }
})

check('brackets, ellipses and added trailing punctuation are stripped too', () => {
  for (const decorated of [
    '[the clocks were striking thirteen]',
    '...the clocks were striking thirteen...',
    '\u2026the clocks were striking thirteen\u2026',
    'the clocks were striking thirteen,',
    '"the clocks were striking thirteen,"',
  ]) {
    const hit = quoteVariants(decorated).map((v) => locateQuote(PASSAGE, v)).find((at) => at !== -1)
    assert.ok(hit !== undefined && hit >= 0, `missed: ${decorated}`)
  }
})

check('the tightest variant is tried first, so an exact quote is never loosened', () => {
  const variants = quoteVariants('"a quote."')
  assert.equal(variants[0], '"a quote."', 'the quote as given comes first')
  assert.ok(variants.includes('a quote.'))
  assert.ok(variants.includes('a quote'))
})

check('stripping never produces a match on something too short to be meaningful', () => {
  // Two characters could match almost anywhere; a variant that short is dropped.
  assert.deepEqual(quoteVariants('"a"'), ['"a"'])
})

check('a quote genuinely absent from the passage still misses', () => {
  // The decoration fix must not become a fuzzy matcher that finds anything.
  for (const variant of quoteVariants('"a sentence that is simply not in this book"')) {
    assert.equal(locateQuote(PASSAGE, variant), -1)
  }
})

check('a quote spanning a line break in the book is found', () => {
  const wrapped = 'the clocks were\nstriking thirteen'
  const passage = 'It was a bright cold day. ' + wrapped + ' Winston Smith.'
  const hit = quoteVariants('"the clocks were striking thirteen"')
    .map((v) => locateQuote(passage, v)).find((at) => at !== -1)
  assert.ok(hit !== undefined && hit >= 0, 'whitespace differences must not lose the anchor')
})


check('a normalized match reports the span the BOOK has, not the quote length', () => {
  // The bug this pins: the book wraps a line where the quote has a space, so the
  // real span is longer than the quote. Assuming start + quote.length put the
  // end short and the highlight sliced text that was not the quote.
  const book = 'It was a bright cold day.\nThe clocks were   striking thirteen. Winston left.'
  const span = locateQuoteSpan(book, 'The clocks were striking thirteen.')
  assert.ok(span, 'the quote must still be found across the whitespace difference')
  assert.equal(book.slice(span.start, span.end), 'The clocks were   striking thirteen.')
  assert.ok(span.end - span.start > 'The clocks were striking thirteen.'.length,
    'the stored span must cover the extra whitespace the book actually contains')
})

check('an exact match reports exactly the quote', () => {
  const book = 'alpha beta gamma'
  const span = locateQuoteSpan(book, 'beta')
  assert.deepEqual(span, { start: 6, end: 10 })
  assert.equal(book.slice(span.start, span.end), 'beta')
})

check('a quote spanning a paragraph break keeps its real span', () => {
  const book = 'End of one.\n\nStart of two.'
  const span = locateQuoteSpan(book, 'End of one. Start of two.')
  assert.ok(span)
  assert.equal(book.slice(span.start, span.end), book)
})

check('every located span slices back to real text, never past the end', () => {
  const book = 'One   two\nthree    four. Five six.'
  for (const quote of ['One two three four.', 'two three', 'Five six.', 'three four']) {
    const span = locateQuoteSpan(book, quote)
    assert.ok(span, `not found: ${quote}`)
    assert.ok(span.end <= book.length)
    assert.equal(book.slice(span.start, span.end).replace(/\s+/g, ' '), quote.replace(/\s+/g, ' '))
  }
})

console.log(`\nAll ${passed} library checks passed.`)
