// Work tab checks.
//
// Today this covers the .pptx extractor and the wiring that makes a deck
// visible to the indexer and to Recall. The editor-embedding checks
// (holmes-office:// traversal, the two-policy CSP, the WORK IPC channels) land
// here as those milestones do.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate'
import { extractPptxText } from './src/main/documentText.ts'
import { DOCUMENT_EXTENSIONS } from './src/main/projectContext.ts'
import { execFileSync } from 'node:child_process'
import {
  WORK_DOCUMENT_TYPES,
  isWorkDocumentKind,
  workDocumentKindForExtension,
  workDocumentType,
} from './src/shared/workDocuments.ts'
import {
  WORK_ROLES,
  getWorkRole,
  isWorkRoleId,
  workRolesWithTools,
} from './src/shared/workRoles.ts'
import { WORK_TOOL_ICON_KEYS, workToolIcon } from './src/renderer/components/workToolIcons.ts'
import { resolveOfficeAssetPath } from './src/main/officeProtocol.ts'
import { applyPaperChoice, PAPER_FONT, PLAIN_FONT, PAPER_PAGE } from './src/main/workPaper.ts'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-work-'))

/** Builds a .pptx on disk from raw part XML, the way the docx/xlsx cases do. */
function writeDeck(name, parts) {
  const filePath = path.join(workDir, name)
  const entries = {}
  for (const [partName, xml] of Object.entries(parts)) entries[partName] = strToU8(xml)
  fs.writeFileSync(filePath, Buffer.from(zipSync(entries)))
  return filePath
}

const slide = (...paragraphs) => paragraphs.join('')
const para = (...runs) => `<a:p>${runs.map((r) => `<a:t>${r}</a:t>`).join('')}</a:p>`

console.log('\npptx extraction')

check('groups by slide and orders slides numerically, not lexically', () => {
  const deck = writeDeck('order.pptx', {
    'ppt/slides/slide1.xml': slide(para('First')),
    'ppt/slides/slide2.xml': slide(para('Second')),
    'ppt/slides/slide10.xml': slide(para('Tenth')),
  })
  const text = extractPptxText(deck, 10_000)
  // slide10 sorts before slide2 lexically — the regression this guards.
  assert.ok(text.indexOf('Second') < text.indexOf('Tenth'), 'slide 10 must follow slide 2')
  assert.match(text, /# Slide 1\n/)
  assert.match(text, /# Slide 10/)
})

check('joins runs inside a paragraph without a separator', () => {
  // PowerPoint splits a word across <a:t> runs when formatting changes mid-word.
  // Anything between them turns "Quarterly" into "Quart erly".
  const deck = writeDeck('runs.pptx', {
    'ppt/slides/slide1.xml': slide(para('Quart', 'erly', ' review')),
  })
  assert.match(extractPptxText(deck, 10_000), /Quarterly review/)
})

check('keeps one line per paragraph so a bullet stays a bullet', () => {
  const deck = writeDeck('bullets.pptx', {
    'ppt/slides/slide1.xml': slide(para('Revenue up'), para('Costs flat')),
  })
  const lines = extractPptxText(deck, 10_000).split('\n')
  assert.deepEqual(lines, ['# Slide 1', 'Revenue up', 'Costs flat'])
})

check('skips empty and whitespace-only paragraphs', () => {
  const deck = writeDeck('empty.pptx', {
    'ppt/slides/slide1.xml': slide(para('Real'), '<a:p></a:p>', para('   ')),
  })
  assert.deepEqual(extractPptxText(deck, 10_000).split('\n'), ['# Slide 1', 'Real'])
})

check('includes speaker notes but not the slide-number box', () => {
  const deck = writeDeck('notes.pptx', {
    'ppt/slides/slide1.xml': slide(para('The ask')),
    'ppt/notesSlides/notesSlide1.xml': slide(para('Why this number is defensible')),
    'ppt/slides/slide2.xml': slide(para('Next')),
    // The notes pane repeats the slide number as its own text box.
    'ppt/notesSlides/notesSlide2.xml': slide(para('2')),
  })
  const text = extractPptxText(deck, 10_000)
  assert.match(text, /Notes: Why this number is defensible/)
  assert.ok(!/Notes: 2/.test(text), 'the slide-number box is chrome, not content')
})

check('notes are matched to their own slide, not by zip order', () => {
  const deck = writeDeck('notes-order.pptx', {
    'ppt/slides/slide2.xml': slide(para('Second slide')),
    'ppt/notesSlides/notesSlide2.xml': slide(para('Second note')),
    'ppt/slides/slide1.xml': slide(para('First slide')),
    'ppt/notesSlides/notesSlide1.xml': slide(para('First note')),
  })
  const lines = extractPptxText(deck, 10_000).split('\n')
  assert.deepEqual(lines, [
    '# Slide 1', 'First slide', 'Notes: First note',
    '# Slide 2', 'Second slide', 'Notes: Second note',
  ])
})

check('decodes XML entities', () => {
  const deck = writeDeck('entities.pptx', {
    'ppt/slides/slide1.xml': slide(para('Q3 &amp; Q4 &lt;draft&gt;')),
  })
  assert.match(extractPptxText(deck, 10_000), /Q3 & Q4 <draft>/)
})

check('stops at maxChars instead of reading the whole deck', () => {
  const parts = {}
  for (let index = 1; index <= 50; index += 1) {
    parts[`ppt/slides/slide${index}.xml`] = slide(para('x'.repeat(200)))
  }
  const deck = writeDeck('long.pptx', parts)
  const text = extractPptxText(deck, 500)
  assert.ok(text.length < 2_000, `expected an early stop, got ${text.length} chars`)
  assert.ok(!/# Slide 50/.test(text), 'the tail must not be reached')
})

check('a deck with no slides is empty, not a throw', () => {
  const deck = writeDeck('none.pptx', { 'ppt/presentation.xml': '<p:presentation/>' })
  assert.equal(extractPptxText(deck, 10_000), '')
})

console.log('\nwiring')

check('.pptx is indexable as a document', () => {
  assert.ok(DOCUMENT_EXTENSIONS.has('.pptx'))
  // Sibling sets must not drift: a deck is a document, never a book.
  assert.ok(DOCUMENT_EXTENSIONS.has('.docx') && DOCUMENT_EXTENSIONS.has('.xlsx'))
})

check('readDocumentText dispatches .pptx to the extractor', () => {
  const source = fs.readFileSync(new URL('./src/main/documentContext.ts', import.meta.url), 'utf8')
  assert.match(source, /ext === '\.pptx'\) return extractPptxText/)
  assert.match(source, /import \{[^}]*extractPptxText[^}]*\} from '\.\/documentText'/)
})

check('recall parses a deck itself rather than shelling out', () => {
  const source = fs.readFileSync(new URL('./src/main/recall.ts', import.meta.url), 'utf8')
  // textutil cannot read .pptx at all, so it must never be the path that tries.
  const textutilFormats = /new Set\((\[[^\]]*\])\)\.has\(extension\)\) return ''/.exec(source)
  assert.ok(textutilFormats, 'the textutil format set moved — re-check this assertion')
  assert.ok(!/pptx/.test(textutilFormats[1]), '.pptx must not be routed to textutil')
  assert.match(source, /extension === '\.pptx'/)
  assert.ok(source.includes("'.pptx'"), '.pptx must be a personal document extension')
})

console.log('\nwork tab')

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

check('the five document kinds are defined once and shared', () => {
  assert.deepEqual(
    WORK_DOCUMENT_TYPES.map((type) => type.kind),
    ['document', 'spreadsheet', 'presentation', 'image', 'vector'],
  )
  assert.deepEqual(
    WORK_DOCUMENT_TYPES.map((type) => type.extension),
    ['.docx', '.xlsx', '.pptx', '.png', '.svg'],
  )
  // The sidebar entries are what the user asked for by name.
  assert.deepEqual(
    WORK_DOCUMENT_TYPES.map((type) => type.newLabel),
    ['New Document', 'New Spreadsheet', 'New Presentation', 'New Image', 'New Vector'],
  )
  assert.deepEqual(
    WORK_DOCUMENT_TYPES.map((type) => type.editor),
    ['office', 'office', 'office', 'graphite', 'graphite'],
  )
  // Every kind the text indexer can extract is a kind the office editor makes.
  // Design kinds are images: they reach the profile through the photo/VLM
  // paths, not through document text extraction.
  for (const type of WORK_DOCUMENT_TYPES) {
    if (type.editor === 'office') assert.ok(DOCUMENT_EXTENSIONS.has(type.extension))
    else assert.ok(!DOCUMENT_EXTENSIONS.has(type.extension))
  }
})

check('kind lookup is total, and unknown kinds fail loudly', () => {
  for (const type of WORK_DOCUMENT_TYPES) assert.equal(workDocumentType(type.kind).extension, type.extension)
  // Defaulting to 'document' here would silently create the wrong file.
  assert.throws(() => workDocumentType('memo'), /Unknown work document kind/)
  assert.equal(isWorkDocumentKind('spreadsheet'), true)
  assert.equal(isWorkDocumentKind('memo'), false)
})

check('an extension maps back to the kind that writes it', () => {
  assert.equal(workDocumentKindForExtension('.XLSX'), 'spreadsheet')
  assert.equal(workDocumentKindForExtension('.pptx'), 'presentation')
  assert.equal(workDocumentKindForExtension('.pdf'), null)
})

check('the Work pill is live and mode === work is a real branch', () => {
  const sidebar = read('./src/renderer/components/Sidebar.tsx')
  assert.ok(!/Work mode coming soon/.test(sidebar), 'the pill must no longer be disabled')
  assert.match(sidebar, /mode === 'work'/)
  assert.match(sidebar, /setMode\('work'\)/)
  assert.match(sidebar, /onWork/)
  // The nav entries come from the shared list rather than being retyped — and
  // only the office kinds: the design kinds are reached through the Work page.
  assert.match(sidebar, /WORK_DOCUMENT_TYPES\.filter\(\(type\) => type\.editor === 'office'\)\.map/)
})

check('the work-flavoured placeholders moved out of the life branch', () => {
  const sidebar = read('./src/renderer/components/Sidebar.tsx')
  // Casebook and Decision Room sat under Life only because Work did not exist.
  const workBranch = sidebar.slice(sidebar.indexOf("mode === 'work' ? ("))
  assert.ok(workBranch.includes('Casebook'), 'Casebook belongs to Work now')
  assert.ok(workBranch.includes('Decision Room'), 'Decision Room belongs to Work now')
  assert.equal((sidebar.match(/Casebook/g) ?? []).length, 2, 'one button, one title — not duplicated into both branches')
})

check('every page handler clears the Work flag', () => {
  const app = read('./src/renderer/App.tsx')
  // A page left uncleared renders underneath another page's nav.
  const work = (app.match(/setShowWork\(false\)/g) ?? []).length
  const library = (app.match(/setShowLibrary\(false\)/g) ?? []).length
  // Every page handler that clears Library must clear Work too. Work has one
  // extra caller — the workspace's own Close button — so this is >=, not ==.
  assert.ok(work >= library, `Work cleared ${work}x, Library ${library}x — a handler is missing one`)
  assert.match(app, /onClose=\{\(\) => setShowWork\(false\)\}/, 'the extra clear should be Close')
  assert.match(app, /showWork \? \(/, 'Work is in the render cascade')
  assert.match(app, /showWork\s*\n?\s*\? 'work'/, 'Work is in the activeSection ternary')
})

check('the render cascade was not broken by the flag-clearing sweep', () => {
  const app = read('./src/renderer/App.tsx')
  // A concise arrow body cannot hold two statements; the sweep that added
  // setShowWork(false) everywhere is exactly how that gets introduced.
  assert.ok(
    !/=>\s*set[A-Za-z]+\((?:false|null)\)\s*\n\s*setShow/.test(app),
    'an inline arrow gained a second statement without braces',
  )
})

console.log('\nwork roles')

check('the catalog is generated from every role row in the sheet', () => {
  assert.deepEqual(
    WORK_ROLES.map((role) => role.role),
    ['General', 'Therapist', '3D Modeler', 'Designer', 'Data Analyst', 'Programmer', 'Game Studio', 'Writer'],
  )
  // The character behind each role travels with it, as the sheet pairs them.
  assert.equal(getWorkRole('3d-modeler')?.character, 'Geppetto')
  assert.equal(getWorkRole('therapist')?.character, 'Seward')
  for (const role of WORK_ROLES) assert.match(role.color, /^#[0-9a-f]{3,8}$/i)
})

check('tool lists split on Numbers line separators, not just \\n', () => {
  // The Game Studio row uses U+2028 where its neighbours use \n. Splitting on
  // \n alone collapses it into one 86-character "tool" — the bug this guards.
  const gameStudio = getWorkRole('game-studio')
  assert.equal(gameStudio.tools.length, 10)
  assert.equal(gameStudio.tools[0], 'New Project')
  assert.equal(gameStudio.tools[1], 'Design Doc')
  assert.equal(gameStudio.tools.at(-1), 'Build')
  for (const tool of gameStudio.tools) {
    assert.ok(tool.length < 30, `"${tool}" looks like an unsplit run`)
  }
})

check('every tool list opens with its own "New …"', () => {
  // This is what lets a role's tools stand in for New Conversation/New Document.
  for (const role of workRolesWithTools()) {
    assert.match(role.tools[0], /^New /, `${role.role} should open with a "New …" action`)
  }
})

check('a role with no authored tools keeps the default actions', () => {
  // Four rows carry a stray number in the Tools column rather than a list.
  for (const id of ['general', 'therapist', 'programmer', 'writer']) {
    assert.deepEqual(getWorkRole(id).tools, [], `${id} should have no tools`)
  }
  assert.equal(workRolesWithTools().length, 4)
  // A bare number must never become a button labelled "33".
  for (const role of WORK_ROLES) {
    for (const tool of role.tools) assert.ok(!/^\d+$/.test(tool), `numeric tool leaked: ${tool}`)
  }
})

check('unknown role ids resolve to null rather than throwing', () => {
  assert.equal(getWorkRole('nope'), null)
  assert.equal(getWorkRole(null), null)
  assert.equal(isWorkRoleId('designer'), true)
  assert.equal(isWorkRoleId('nope'), false)
})

check('the generated catalog is in sync with the spreadsheet', () => {
  // Regenerating must be a no-op; if this fails, run
  // `node scripts/generate-work-roles.mjs` and commit the result.
  const before = read('./src/shared/workRoles.ts')
  execFileSync('node', ['scripts/generate-work-roles.mjs'], { cwd: process.cwd(), stdio: 'pipe' })
  assert.equal(read('./src/shared/workRoles.ts'), before, 'workRoles.ts is stale — regenerate it')
})

check('the role dropdown mirrors the project filter it sits above', () => {
  const sidebar = read('./src/renderer/components/Sidebar.tsx')
  assert.match(sidebar, /WORK_ROLES\.map/, 'the dropdown lists the catalog')
  assert.match(sidebar, /setWorkRoleId/)
  // Same trigger chrome as the project filter — if one is restyled, so is this.
  const trigger = /h-\[26px\] w-full items-center gap-2 rounded-md border border-\[#56544f\] bg-\[#3a3733\]/g
  assert.equal((sidebar.match(trigger) ?? []).length, 2, 'role trigger must match the filter trigger')
  // And the same panel chrome.
  const panel = /absolute left-0 right-0 top-full z-50 mt-1 max-h-72/g
  assert.equal((sidebar.match(panel) ?? []).length, 2, 'role panel must match the filter panel')
})

check('selecting a role replaces the action list with its tools', () => {
  const sidebar = read('./src/renderer/components/Sidebar.tsx')
  assert.match(sidebar, /roleTools\.length > 0 \?/, 'tools take over the list')
  assert.match(sidebar, /roleTools\.map/)
  assert.match(sidebar, /onWorkTool\(tool, workRole!\.id\)/)
  // The dropdown is rendered before the action list, per the design.
  assert.ok(
    sidebar.indexOf('Choose a working role') < sidebar.indexOf('New Conversation'),
    'the role picker must sit above New Conversation',
  )
})

check('every role tool has its own icon', () => {
  // A tool added to the sheet without an icon still renders, but it renders as
  // the neutral fallback — which looks like a bug next to eleven real icons.
  const missing = []
  for (const role of workRolesWithTools()) {
    for (const tool of role.tools) {
      if (tool.startsWith('New ')) continue // always the New Conversation icon
      if (!WORK_TOOL_ICON_KEYS.includes(`${role.id}:${tool}`)) missing.push(`${role.id}:${tool}`)
    }
  }
  assert.deepEqual(missing, [], 'add these to workToolIcons.ts')
})

check('the icon map carries no entries for tools that no longer exist', () => {
  const live = new Set()
  for (const role of workRolesWithTools()) {
    for (const tool of role.tools) live.add(`${role.id}:${tool}`)
  }
  const stale = WORK_TOOL_ICON_KEYS.filter((key) => !live.has(key))
  assert.deepEqual(stale, [], 'these were removed from the sheet — drop them')
})

check('tools that collide across roles are keyed separately', () => {
  // "Model" is a mesh to Geppetto and a statistical model to Gradgrind. Keying
  // by tool name alone would give them the same icon.
  assert.ok(WORK_TOOL_ICON_KEYS.includes('3d-modeler:Model'))
  assert.ok(WORK_TOOL_ICON_KEYS.includes('data-analyst:Model'))
  assert.notEqual(workToolIcon('3d-modeler', 'Model'), workToolIcon('data-analyst', 'Model'))
})

check('every "New …" tool shares the New Conversation icon', () => {
  const newIcons = workRolesWithTools().map((role) => workToolIcon(role.id, role.tools[0]))
  for (const icon of newIcons) assert.equal(icon, newIcons[0])
  // An unmapped tool falls back rather than crashing the nav.
  assert.ok(workToolIcon('designer', 'Nonexistent Tool'))
})

check('the sidebar renders tool icons the way the other navs do', () => {
  const sidebar = read('./src/renderer/components/Sidebar.tsx')
  assert.match(sidebar, /workToolIcon\(workRole!\.id, tool\)/)
  // Same icon slot as every other nav entry, so the labels line up.
  assert.match(sidebar, /icon=\{workToolIcon\(workRole!\.id, tool\)\} className="w-4 shrink-0"/)
  assert.ok(!/h-1\.5 w-1\.5 rounded-full/.test(sidebar), 'the placeholder dots should be gone')
})

console.log('\noffice protocol')

check('resolveOfficeAssetPath refuses everything outside the bundle', () => {
  const root = '/opt/holmes/onlyoffice'
  assert.equal(resolveOfficeAssetPath(root, '/sdkjs/word/sdk-all.js'), `${root}/sdkjs/word/sdk-all.js`)
  assert.equal(resolveOfficeAssetPath(root, '/../../etc/passwd'), null)
  assert.equal(resolveOfficeAssetPath(root, '/sdkjs/../../etc/passwd'), null)
  // Decoded first, then resolved — an encoded traversal is still a traversal.
  assert.equal(resolveOfficeAssetPath(root, '/%2e%2e/%2e%2e/etc/passwd'), null)
  // A NUL truncates at the syscall boundary, so it must never reach one.
  assert.equal(resolveOfficeAssetPath(root, '/a\0/../../etc/passwd'), null)
  assert.equal(resolveOfficeAssetPath(root, '/%zz'), null) // malformed escape
  assert.equal(resolveOfficeAssetPath(root, '/'), null)
  // Leading slashes are stripped, but the result still has to stay inside.
  assert.equal(resolveOfficeAssetPath(root, '//etc/passwd'), `${root}/etc/passwd`)
})

check('the cache-busting version prefix is stripped, and only that', () => {
  const root = '/opt/holmes/onlyoffice'
  // api.js asks for /9.4.0-129/web-apps/... ; a real deployment strips it in nginx.
  assert.equal(
    resolveOfficeAssetPath(root, '/9.4.0-129/web-apps/apps/api/documents/api.js'),
    `${root}/web-apps/apps/api/documents/api.js`,
  )
  assert.equal(resolveOfficeAssetPath(root, '/9.4.0-/sdkjs/word/sdk-all.js'), `${root}/sdkjs/word/sdk-all.js`)
  // It must not eat a real directory that merely contains a dash or digits.
  assert.equal(resolveOfficeAssetPath(root, '/x2t/x2t.wasm'), `${root}/x2t/x2t.wasm`)
  assert.equal(resolveOfficeAssetPath(root, '/core-fonts/liberation/LiberationSans-Regular.ttf'),
    `${root}/core-fonts/liberation/LiberationSans-Regular.ttf`)
  // And stripping it must not open a traversal.
  assert.equal(resolveOfficeAssetPath(root, '/9.4.0-129/../../etc/passwd'), null)
})

check('the editor frame gets a policy that cannot reach the network', () => {
  const source = read('./src/main/officeProtocol.ts')
  const csp = /const EDITOR_CSP = \[([\s\S]*?)\]\.join/.exec(source)
  assert.ok(csp, 'EDITOR_CSP moved — re-check this assertion')
  assert.ok(!/\bhttps?:/.test(csp[1]), 'the editor frame must not be able to phone home')
  assert.ok(!/\bwss?:/.test(csp[1]), 'no websocket egress either')
  assert.match(csp[1], /'wasm-unsafe-eval'/)
  assert.match(csp[1], /worker-src/)
})

check('the renderer never gains unsafe-eval, and can frame the editor', () => {
  const html = read('./src/renderer/index.html')
  // sdkjs's eval belongs in the editor frame, not in Holmes.
  assert.ok(!/unsafe-eval/.test(html), 'unsafe-eval must stay out of the renderer')
  assert.match(html, /frame-src holmes-office:/)
  assert.match(html, /worker-src/)
})

check('x2t.wasm is inflated in main rather than served compressed', () => {
  const source = read('./src/main/officeProtocol.ts')
  // protocol.handle bypasses Chromium content decoding, so Content-Encoding: br
  // would hand the frame 9MB of brotli it cannot instantiate.
  assert.match(source, /brotliDecompressSync/)
  assert.match(source, /'\.wasm': 'application\/wasm'/)
  assert.match(source, /headers\.delete\('Content-Encoding'\)/)
})

check('the editor frame is pinned to the bundle', () => {
  const main = read('./src/main/main.ts')
  // will-navigate is main-frame only, so the frame needs its own guard.
  assert.match(main, /will-frame-navigate/)
  // One registerSchemesAsPrivileged call for all schemes: a second call strips
  // privileges granted by the first (Electron 39), so per-scheme register
  // functions must never come back.
  assert.strictEqual(main.match(/registerSchemesAsPrivileged\(/g)?.length, 1)
  assert.match(main, /OFFICE_SCHEME_PRIVILEGES,/)
  assert.match(main, /installOfficeProtocol\(\)/)
})

console.log('\neditor embedding')

check('all ONLYOFFICE code runs in the frame, never in the renderer', () => {
  // The whole containment story: Holmes' own origin must not load api.js, the
  // wrapper, or anything else from the bundle.
  const frame = read('./src/renderer/components/OfficeEditorFrame.tsx')
  assert.match(frame, /holmes-office:\/\/editor\/holmes\/shell\.html/)
  assert.match(frame, /postMessage/)
  for (const file of ['./src/renderer/App.tsx', './src/renderer/components/WorkPage.tsx', './src/renderer/components/Sidebar.tsx']) {
    const source = read(file)
    assert.ok(!/DocsAPI|onlyoffice-web-comp|api\.js/.test(source), `${file} must not touch ONLYOFFICE directly`)
  }
  // The frame is driven only through the shell's message protocol.
  assert.ok(!/contentDocument|contentWindow\.document/.test(frame), 'the renderer must not reach into the frame')
})

check('the shell talks to the vendored wrapper, not to sdkjs directly', () => {
  const shell = read('./src/office-shell/shell.ts')
  assert.match(shell, /OnlyOfficeManager/)
  assert.match(shell, /registerStaticResource/)
  // Real OOXML comes from exportAsBlob; exportDocument returns the internal bin.
  assert.match(shell, /exportAsBlob/)
  assert.ok(!/exportDocument\(\)/.test(shell), 'exportDocument returns Editor.bin, not office bytes')
  // Upstream defaults the UI to Chinese.
  assert.equal((shell.match(/lang: 'en'/g) ?? []).length, 2)
})

check('the two vendor patches are present and documented', () => {
  const patches = read('./src/office-shell/PATCHES.md')
  // #1 — the worker URL. Upstream names the .ts source, which esbuild leaves as
  // a .ts URL, and the 404 surfaces only as "Worker error: undefined".
  const x2t = read('./src/office-shell/vendor/internal/editor/x2t.ts')
  assert.match(x2t, /x2t\.worker\.js/)
  assert.ok(!/new URL\("\.\/x2t\.worker\.ts"/.test(x2t))
  assert.match(patches, /x2t\.worker\.js/)

  // #2 — resolveSiteUrl must treat any scheme as absolute, or holmes-office://
  // URLs get the origin prepended repeatedly.
  const constants = read('./src/office-shell/vendor/const/index.ts')
  const resolver = /export function resolveSiteUrl[\s\S]*?\n}/.exec(constants)
  assert.ok(resolver, 'resolveSiteUrl moved')
  assert.ok(!/\^https\?:/.test(resolver[0]), 'must not special-case http(s) only')
  assert.match(resolver[0], /\[a-z\]\[a-z0-9\+\.-\]\*/)
  assert.match(patches, /resolveSiteUrl/)
})

check('the build step emits both entries flat, beside each other', () => {
  const build = read('./scripts/build-office-shell.mjs')
  // shell.js resolves the worker as './x2t.worker.js', relative to its own URL.
  assert.match(build, /entryNames: '\[name\]'/)
  assert.match(build, /x2t\.worker\.ts/)
  // A real Document Server generates these; the static bundle has neither.
  assert.match(build, /plugins\.json/)
  assert.match(build, /themes\.json/)
  // Shipping exceljs for a CSV path the Work tab never takes is dead weight.
  assert.match(build, /stub-exceljs/)
})

check('vendored source is tracked but its build output is not', () => {
  assert.ok(fs.existsSync(new URL('./src/office-shell/vendor/UPSTREAM.md', import.meta.url)), 'provenance must be recorded')
  const pkg = JSON.parse(read('./package.json'))
  assert.ok(pkg.scripts['build:office-shell'], 'the build step must be a script')
  assert.ok(pkg.devDependencies.esbuild, 'esbuild is used directly, so it is a direct dependency')
})

check('the editor is skinned to the Holmes palette', () => {
  const shell = read('./src/office-shell/shell.ts')
  const css = read('./src/renderer/styles/index.css')
  // Every colour in the skin must be one the app actually uses, so the two
  // cannot drift into "nearly the same dark grey".
  const palette = Object.fromEntries(
    [...css.matchAll(/--color-(holmes-[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]),
  )
  assert.equal(palette['holmes-bg'], '#20201e')
  assert.equal(palette['holmes-primary'], '#47a08f')

  const skin = /const HOLMES_SKIN: Record<string, string> = \{([\s\S]*?)\n\}/.exec(shell)
  assert.ok(skin, 'HOLMES_SKIN moved — re-check this assertion')
  assert.match(skin[1], /'--background-pane': '#20201e'/)
  assert.match(skin[1], /'--background-accent-button': '#47a08f'/)
  // The active-tab underline is per-editor; missing one leaves a blue ribbon.
  for (const editor of ['document', 'spreadsheet', 'presentation', 'pdf', 'visio']) {
    assert.match(skin[1], new RegExp(`'--highlight-toolbar-tab-underline-${editor}': '#47a08f'`))
  }
  // No ONLYOFFICE blue should survive anywhere in the skin.
  assert.ok(!/#4[aA]7[bB][eE]0|#446995/.test(skin[1]), 'an ONLYOFFICE blue is still in the skin')
})

check('the skin is applied inline, not as a stylesheet', () => {
  const shell = read('./src/office-shell/shell.ts')
  // The editor loads its theme CSS lazily, so an injected <style> lands EARLIER
  // in the cascade than the rules it must beat and silently does nothing. This
  // was observed: the tag was present and every value was still the default.
  assert.match(shell, /setProperty\(name, value, 'important'\)/)
  assert.ok(!/createElement\('style'\)/.test(shell), 'a <style> tag loses the cascade here')
  // Re-applied because the wrapper remounts the frame on document/theme change.
  assert.match(shell, /setInterval/)
  assert.match(shell, /OFFICE_THEME\.NIGHT/)
})

check('the editor loads no remote assets', () => {
  // Upstream sets customization.logo to a Microsoft Office icon on jsdelivr.
  // The editor CSP has no https: in img-src, so it drew as a broken image —
  // and allowing it would mean a CDN fetch every time a document opens.
  const constants = read('./src/office-shell/vendor/const/index.ts')
  const manager = read('./src/office-shell/vendor/core/editor-manager.ts')
  assert.match(constants, /OFFICE_EDITOR_LOGO = \{ visible: false \}/)
  assert.ok(!/cdn\.jsdelivr|simple-icons/.test(constants), 'no CDN URL may remain')
  assert.ok(!/OFFICE_EDITOR_LOGO\.image/.test(manager), 'the logo image must not be passed through')
  // Nothing anywhere in the shell or its vendor tree should reach the network.
  const shell = read('./src/office-shell/shell.ts')
  assert.ok(!/https?:\/\//.test(shell.replace(/^\s*\/\/.*$/gm, '')), 'the shell must not name a remote URL')
})

console.log('\nsaving')

check('the save target comes from the sidebar project filter', () => {
  // The filter was Sidebar-local; it now lives in App because it decides more
  // than the conversation list.
  const sidebar = read('./src/renderer/components/Sidebar.tsx')
  const app = read('./src/renderer/App.tsx')
  assert.ok(!/useState<string \| null>\(null\)\s*\n\s*const \[filterOpen/.test(sidebar), 'the filter must not own its own state')
  assert.match(sidebar, /filterProjectId,\n\s*onFilterProjectChange,/)
  assert.match(app, /const \[filterProjectId, setFilterProjectId\]/)
  // The same value reaches the sidebar, and is what the save request carries.
  assert.match(app, /filterProjectId=\{filterProjectId\}/)
  assert.match(app, /saveDocument\(\{\s*\n?\s*projectId: filterProjectId,/)
})

check('the save handler resolves a folder, or asks', () => {
  const ipc = read('./src/main/ipc.ts')
  assert.match(ipc, /IPC\.WORK\.SAVE_DOCUMENT/)
  // A project folder first; General has none, so that is the case that asks.
  assert.match(ipc, /function workSaveDirectory/)
  assert.match(ipc, /dialog\.showSaveDialog/)
  // Only the basename is used — a name carrying separators must not be able to
  // walk out of the project folder before the scope check sees it.
  assert.match(ipc, /const fileName = path\.basename\(request\.fileName\.trim\(\)\)/)
  assert.match(ipc, /assertPathAllowed\(target\)/)
  // Write-then-rename, so a crash cannot truncate an existing document.
  assert.match(ipc, /holmes-tmp/)
  assert.match(ipc, /await rename\(temporary, target\)/)
  // Only real office documents.
  assert.match(ipc, /WORK_SAVE_EXTENSIONS = new Set\(\['\.docx', '\.xlsx', '\.pptx', '\.png', '\.svg'\]\)/)
})

check('a first save uniquifies, a re-save overwrites', () => {
  const ipc = read('./src/main/ipc.ts')
  const app = read('./src/renderer/App.tsx')
  // Without uniquifying, a second New Document silently replaces the first.
  assert.match(ipc, /function uniqueFilePath/)
  assert.match(ipc, /existingPath/)
  // App remembers where it saved, so Save twice does not leave a trail.
  assert.match(app, /workSavedPath \? \{ existingPath: workSavedPath \} : \{\}/)
  // ...but a torn-down workspace must not carry its path into the next one.
  assert.match(app, /setWorkSavedPath\(null\)/)
})

check('the four-file IPC contract is kept in step', () => {
  // channel -> handler -> preload -> renderer types, all naming the same thing.
  assert.match(read('./src/main/ipcChannels.ts'), /SAVE_DOCUMENT: 'work:save-document'/)
  assert.match(read('./src/main/ipc.ts'), /handle\(IPC\.WORK\.SAVE_DOCUMENT/)
  assert.match(read('./src/preload/preload.ts'), /saveDocument: \(request: WorkSaveRequest\)/)
  assert.match(read('./src/shared/types.ts'), /saveDocument: \(request: WorkSaveRequest\) => Promise<WorkSaveResult>/)
})

console.log('\nAI bridge')

check('model output is data, never code', () => {
  // callCommand stringifies the function you give it and evaluates it in the
  // editor frame, but JSON-serialises Asc.scope separately. So every command
  // must be a LITERAL and everything variable must travel through the scope.
  // Concatenating model output into a command body would hand code execution to
  // whatever the model last read — including a .docx from an untrusted source.
  const shell = read('./src/office-shell/shell.ts')
  assert.ok(!/callCommand\(\s*[`'"]/.test(shell), 'a string command is evaluated verbatim — never')
  assert.ok(!/callCommand\([^)]*\+/.test(shell), 'no concatenation into a command')
  assert.ok(!/new Function/.test(shell), 'no dynamic function construction')
  assert.match(shell, /Asc\.scope/, 'payloads must cross through Asc.scope')
  // Every command function passed to runCommand is written inline here.
  const commands = shell.match(/runCommand\(/g) ?? []
  assert.ok(commands.length >= 4, `expected the literal commands, found ${commands.length}`)
})

check('the tools are gated on a document actually being open', () => {
  const tools = read('./src/main/tools.ts')
  const ipc = read('./src/main/ipc.ts')
  const frame = read('./src/renderer/components/OfficeEditorFrame.tsx')
  assert.match(tools, /WORK_TOOL_NAMES/)
  assert.match(tools, /workEditorOpen/)
  // What is open decides which editor tool set exists — office or design.
  assert.match(ipc, /workEditorOpen: openEditor === 'office'/)
  assert.match(ipc, /designEditorKind: openEditor === 'image' \|\| openEditor === 'vector' \? openEditor : null/)
  // The frame is what reports it, and must clear it on unmount or the tools
  // stay offered for a document that has gone.
  assert.match(frame, /setEditorOpen\(true\)/)
  assert.match(frame, /setEditorOpen\(false\)/)
})

check('the bridge fails closed rather than hanging', () => {
  const bridge = read('./src/main/officeBridge.ts')
  // No editor, no request — rather than a 30s wait for nothing.
  assert.match(bridge, /if \(!editorOpen\) return Promise\.reject/)
  assert.match(bridge, /EDITOR_REQUEST_TIMEOUT_MS/)
  // Closing the document must strand nothing.
  assert.match(bridge, /The document was closed before the edit could be applied/)
  // A late answer to a timed-out request is not an error.
  assert.match(bridge, /if \(!entry\) return/)
})

check('only the editor frames subscribe to the editor channel', () => {
  // The lesson useDocumentIndex and usePeopleRun already learned: one
  // subscriber, or every mounted copy answers the same request. The two frame
  // components are the whole allow-list — and only one of them is ever
  // mounted, because workKind is single-valued.
  const dir = new URL('./src/renderer/components/', import.meta.url)
  const subscribers = []
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue
    if (/work\.onEditorRequest\(/.test(fs.readFileSync(new URL(file, dir), 'utf8'))) subscribers.push(file)
  }
  assert.deepEqual(subscribers.sort(), ['DesignEditorFrame.tsx', 'OfficeEditorFrame.tsx'])
})

check('every work tool the model can call has a shell action', () => {
  const tools = read('./src/main/tools.ts')
  const shell = read('./src/office-shell/shell.ts')
  const names = [...tools.matchAll(/name: '(work_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 7, `expected the work tools, found ${names.length}`)
  for (const name of names) {
    assert.ok(tools.includes(`case '${name}':`), `${name} has no dispatch in tools.ts`)
    // work_create_document is the one that does not reach the editor: there is
    // no editor yet when it runs. App handles it and opens one.
    if (name === 'work_create_document') {
      assert.match(tools, /openWorkDocument\(/)
      continue
    }
    assert.ok(shell.includes(`case '${name}':`), `${name} has no action in the shell`)
  }
})

check('the open effect cannot be retriggered by its own callback', () => {
  // Regression: WorkPage passes onStateChange as an inline arrow, so it has a
  // new identity every render. When `move` depended on it, `move` changed every
  // render too — and the open effect depends on `move`, so the document
  // reopened in a loop: render -> new callback -> effect -> setState -> render.
  const frame = read('./src/renderer/components/OfficeEditorFrame.tsx')
  assert.match(frame, /onStateChangeRef/, 'the callback must be held in a ref')
  const move = /const move = useCallback\(\(next: ShellState\) => \{[\s\S]*?\}, \[([^\]]*)\]\)/.exec(frame)
  assert.ok(move, 'move moved — re-check this assertion')
  assert.equal(move[1].trim(), '', 'move must have no dependencies, or the open effect loops')
  // And the effect that opens must not depend on anything render-scoped.
  const open = /window\.setTimeout\(tick, step\)\s*\n\s*return \(\) => \{ cancelled = true \}\s*\n\s*\}, \[([^\]]*)\]\)/.exec(frame)
  assert.ok(open, 'the open effect moved — re-check this assertion')
  for (const dep of open[1].split(',').map((d) => d.trim()).filter(Boolean)) {
    assert.ok(['kind', 'openToken', 'call', 'move'].includes(dep), `unexpected dep in the open effect: ${dep}`)
  }
})

check('Holmes can open a document from anywhere, then fill it', () => {
  const tools = read('./src/main/tools.ts')
  const bridge = read('./src/main/officeBridge.ts')
  const app = read('./src/renderer/App.tsx')
  // The tool that MAKES a document open must not be gated on one being open.
  assert.match(tools, /name: 'work_create_document'/)
  assert.ok(!/'work_create_document'/.test(/WORK_TOOL_NAMES = new Set\(\[([\s\S]*?)\]\)/.exec(tools)[1]),
    'work_create_document must stay ungated or the model can never start')
  // Opening is handled by App — the editor frame does not exist yet.
  assert.match(bridge, /openWorkDocument/)
  assert.match(app, /onOpenDocument/)
  // It must resolve only once the editor is editable, or the model's next call
  // races a cold start.
  assert.match(app, /pendingWorkOpen/)
  assert.match(app, /respondToEditor\(\{ requestId, ok: true/)
  assert.match(bridge, /EDITOR_OPEN_TIMEOUT_MS/)
})

check('a booting editor is not reported as a closed one', () => {
  // Regression, found in the conversation record: the frame reported
  // setEditorOpen(false) while state was still 'loading', which told main the
  // document had CLOSED — rejecting the very open request that was waiting for
  // it. work_create_document returned "The document was closed before the edit
  // could be applied" seven times and burned the whole tool budget.
  const frame = read('./src/renderer/components/OfficeEditorFrame.tsx')
  assert.ok(!/setEditorOpen\(state === 'ready'\)/.test(frame), 'must not report false while booting')
  assert.match(frame, /if \(state !== 'ready'\) return/)
  // Closing is still reported — but only on unmount.
  assert.match(frame, /useEffect\(\(\) => \(\) => \{ void window\.electronAPI\.work\.setEditorOpen\(false\) \}, \[\]\)/)
})

check('an open request is never cancelled by "not open"', () => {
  // It is waiting for the editor to appear; that is its whole purpose.
  const bridge = read('./src/main/officeBridge.ts')
  assert.match(bridge, /cancelWhenClosed/)
  assert.match(bridge, /if \(!entry\.cancelWhenClosed\) continue/)
  assert.match(bridge, /IPC\.WORK\.OPEN_DOCUMENT, 'open', \{ kind, name \}, EDITOR_OPEN_TIMEOUT_MS, false\)/)
  assert.match(bridge, /IPC\.WORK\.EDITOR_REQUEST, action, payload, EDITOR_REQUEST_TIMEOUT_MS, true\)/)
})

check('main knows the editor is live before the tool call is answered', () => {
  // getToolDefinitions is recomputed each round on isEditorOpen(). Answering
  // before main is told would start the next round with no editing tools.
  const app = read('./src/renderer/App.tsx')
  const ready = /const handleWorkEditorReady[\s\S]*?\n  \}/.exec(app)
  assert.ok(ready, 'handleWorkEditorReady moved — re-check this assertion')
  assert.ok(
    ready[0].indexOf('setEditorOpen(true)') < ready[0].indexOf('respondToEditor'),
    'setEditorOpen must be awaited before the tool call is answered',
  )
})

console.log('\nworkspace lifecycle')

check('the workspace outlives navigation only while a task is in flight', () => {
  const app = read('./src/renderer/App.tsx')
  // Unmounting destroys the iframe and kills a run Holmes is midway through —
  // but keeping a 63 MB wasm heap alive for an idle document is waste.
  assert.match(app, /const workBusy = isStreaming \|\| workSaving/)
  assert.match(app, /\{workKind && \(showWork \|\| workBusy\) && \(/)
  // It must be mounted OUTSIDE the page cascade, or navigation unmounts it
  // regardless of what the condition says.
  const cascade = app.indexOf('showWork ? (')
  const host = app.indexOf('{workKind && (showWork || workBusy) && (')
  assert.ok(host > cascade, 'the host must sit outside the cascade it is meant to survive')
})

check('unsaved changes count as work in flight', () => {
  const app = read('./src/renderer/App.tsx')
  const shell = read('./src/office-shell/shell.ts')
  const frame = read('./src/renderer/components/OfficeEditorFrame.tsx')
  // Navigating away from a document with unsaved edits must not discard them.
  assert.match(app, /const workBusy = isStreaming \|\| workSaving \|\| workDirty/)
  // The editor's own document-state tracking is the source of truth; the shell
  // only forwards the transitions.
  assert.match(shell, /editorManagerFactory\.get\(CONTAINER_ID\)\.isDirty\(\)/)
  assert.match(shell, /post\(\{ type: 'dirty', dirty \}\)/)
  assert.match(frame, /data\.type === 'dirty'/)
  // A successful save means it IS on disk. Without clearing here the workspace
  // would count as busy forever and never tear down.
  assert.match(app, /setWorkSavedPath\(result\.path\)\s*\n\s*setWorkDirty\(false\)/)
})

check('a hidden workspace is hidden without being collapsed', () => {
  const app = read('./src/renderer/App.tsx')
  // display:none collapses the editor to zero and it returns blank until
  // something resizes it; visibility keeps its box.
  assert.match(app, /pointer-events-none invisible absolute inset-0/)
  assert.ok(!/showWork \? '[^']*' : 'hidden'/.test(app), 'must not use display:none to hide it')
})

check('a torn-down workspace does not come back as a blank impostor', () => {
  const app = read('./src/renderer/App.tsx')
  // Without this, returning to Work remounts and opens a NEW empty document
  // that looks exactly like the one that was there.
  assert.match(app, /if \(showWork \|\| workBusy \|\| !workKind\) return/)
  assert.match(app, /setWorkKind\(null\)/)
})

check('the picker does not render underneath an open document', () => {
  const app = read('./src/renderer/App.tsx')
  // It did, and its header intercepted clicks meant for the workspace above it.
  assert.match(app, /workKind \? null : \(/)
  const page = read('./src/renderer/components/WorkPage.tsx')
  // The picker is now only a picker: no editor, no save, no document state.
  assert.ok(!/OfficeEditorFrame|saveDocument|useState/.test(page), 'WorkPage must be the picker alone')
})

check('the routed conversation travels with the document', () => {
  const app = read('./src/renderer/App.tsx')
  const workspace = read('./src/renderer/components/WorkspaceView.tsx')
  // Whatever the user was talking in when Holmes opened the document.
  assert.match(app, /setWorkConversationId\(useChatStore\.getState\(\)\.currentConversationId\)/)
  assert.match(app, /conversation=\{workConversationId \? workConversationPanel : undefined\}/)
  // Rendered as the ordinary conversation view, not a bespoke transcript.
  assert.match(app, /const workConversationPanel = \(\n\s*<ChatView/)
  assert.match(workspace, /conversation\?: ReactNode/)
})


console.log('\npaper mode')

/** A .docx shaped the way x2t writes one, in Holmes Minion. */
function paperDocx(overrides = {}) {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:rPr>' +
        `<w:rFonts w:ascii="${PAPER_FONT}" w:hAnsi="${PAPER_FONT}"/></w:rPr>` +
        '<w:t>Hello</w:t></w:r></w:p></w:body></w:document>',
    ),
    'word/styles.xml': strToU8(
      '<?xml version="1.0"?><w:styles xmlns:w="w"><w:docDefaults><w:rPrDefault><w:rPr>' +
        `<w:rFonts w:ascii="${PAPER_FONT}" w:hAnsi="${PAPER_FONT}"/>` +
        '</w:rPr></w:rPrDefault></w:docDefaults></w:styles>',
    ),
    'word/settings.xml': strToU8('<?xml version="1.0"?><w:settings xmlns:w="w"><w:zoom/></w:settings>'),
    ...overrides,
  })
}

const partOf = (bytes, name) => strFromU8(unzipSync(bytes)[name])

check('the committed template is a .docx that names the paper font', () => {
  const parts = unzipSync(new Uint8Array(fs.readFileSync('./src/office-shell/templates/paper.docx')))
  const styles = strFromU8(parts['word/styles.xml'])
  // Both, because docDefaults alone loses to the Normal style and the toolbar
  // ends up naming a font the page is not set in.
  assert.match(styles, /<w:rPrDefault>[\s\S]*?Holmes Minion/)
  assert.match(styles, /w:styleId="Normal"[\s\S]*?Holmes Minion/)
  // w:eastAsia left to the theme is what put new documents in DengXian.
  assert.match(styles, /w:eastAsia="Holmes Minion"/)
  assert.ok(parts['word/document.xml'], 'the template needs a document part')
})

check('saving plain leaves no trace of the paper font', () => {
  const out = applyPaperChoice(paperDocx(), 'plain')
  for (const [name, part] of Object.entries(unzipSync(out))) {
    if (!name.endsWith('.xml')) continue
    // Not just styles.xml: x2t writes the font onto the runs too, and a half
    // converted document is worse than either whole answer.
    assert.ok(!strFromU8(part).includes(PAPER_FONT), `${name} still names the paper font`)
  }
  assert.match(partOf(out, 'word/styles.xml'), new RegExp(PLAIN_FONT))
})

check('keeping the look writes a page colour Word will actually draw', () => {
  const out = applyPaperChoice(paperDocx(), 'keep')
  const document = partOf(out, 'word/document.xml')
  // w:background is only valid before w:body; anywhere else Word rejects the part.
  assert.match(document, new RegExp(`<w:background w:color="${PAPER_PAGE}"/><w:body`))
  // Without this Word parses the background and declines to draw it — which
  // would leave exactly the white-on-white document the option exists to avoid.
  assert.match(partOf(out, 'word/settings.xml'), /<w:settings[^>]*><w:displayBackgroundShape\/>/)
  // White for real: automatic resolves to black against a page Word thinks is
  // white, so the text would be invisible in the reader that honours one and
  // not the other.
  assert.match(partOf(out, 'word/styles.xml'), /<w:rPrDefault><w:rPr><w:color w:val="FFFFFF"\/>/)
  // The font stays — keeping the look means keeping it.
  assert.ok(partOf(out, 'word/styles.xml').includes(PAPER_FONT))
})

check('a second save does not stack a second background', () => {
  const once = applyPaperChoice(paperDocx(), 'keep')
  const twice = applyPaperChoice(once, 'keep')
  assert.equal(partOf(twice, 'word/document.xml').match(/<w:background/g).length, 1)
  assert.equal(partOf(twice, 'word/styles.xml').match(/<w:color w:val="FFFFFF"/g).length, 1)
})

check('a save is never lost to a document the rewrite cannot read', () => {
  // A .xlsx, a design export, or anything else that is not a Word document
  // comes back untouched rather than throwing the save away.
  const notAZip = new Uint8Array([1, 2, 3, 4])
  assert.equal(applyPaperChoice(notAZip, 'plain'), notAZip)
  const notWord = zipSync({ 'xl/workbook.xml': strToU8('<x/>') })
  assert.equal(applyPaperChoice(notWord, 'keep'), notWord)
})

check('the shell and main agree on what paper mode is', () => {
  const shell = read('./src/office-shell/shell.ts')
  const paper = read('./src/main/workPaper.ts')
  // Three copies of the same two constants — the font name and the page colour
  // — in the template, the shell and the rewrite. A drift here shows up as a
  // document that saves in a font nothing else in Holmes has heard of.
  assert.ok(shell.includes(`const PAPER_FONT = '${PAPER_FONT}'`))
  assert.ok(paper.includes(`export const PAPER_FONT = '${PAPER_FONT}'`))
  assert.ok(shell.includes(`const PAPER_PAGE_HEX = '#${PAPER_PAGE.toLowerCase()}'`))
})

check('only new text documents are shown as Holmes', () => {
  const shell = read('./src/office-shell/shell.ts')
  // A spreadsheet's cells and a slide's shapes carry their own fills, so the
  // treatment would leave black text on a dark grid.
  assert.match(shell, /const template = kind === 'document' \? await paperTemplate\(\) : null/)
  // A document off disk is someone else's formatting, and darkening the page
  // under their black text makes it unreadable.
  assert.match(shell, /async function openFile[\s\S]*?startPaperMode\(false\)/)
})

check('a page colour the user picks turns the treatment off', () => {
  const shell = read('./src/office-shell/shell.ts')
  // Layout > Page Color is the user saying what the page should look like.
  assert.match(shell, /if \(paperMode && pageColorIsSet\(api\)\) \{\s*\n\s*paperMode = false/)
})

check('saving asks before it writes, not after', () => {
  const app = read('./src/renderer/App.tsx')
  // exportDocument runs the in-memory document through x2t, so the answer has
  // to be known before the export, not applied to it afterwards.
  assert.match(app, /const paper = await workEditorRef\.current\.paperState\?\.\(\)/)
  assert.match(app, /if \(paper\?\.paper && !paper\.settled\) \{\s*\n\s*setWorkPaperPrompt\(paper\)\s*\n\s*return/)
  // And every later save of the same document carries the same answer.
  assert.match(app, /\.\.\.\(paper \? \{ paper \} : \{\}\)/)
})

check('a shell that cannot answer does not block the save', () => {
  const frame = read('./src/renderer/components/OfficeEditorFrame.tsx')
  // Failing closed here means writing the document, not hanging behind a dialog
  // whose question nobody can answer.
  assert.match(frame, /catch \{\s*\n\s*return \{ paper: false, settled: true, font: '' \}/)
})

check('a lost reply cannot wedge the editor connector', () => {
  const shell = read('./src/office-shell/shell.ts')
  // DocsAPI only SENDS a command when it is the sole outstanding callback, so
  // one unanswered reply parks every later command in `tasks` forever. Both
  // queues have to be cleared, and the connector proven, before it is used.
  assert.match(shell, /function drainQueues[\s\S]*?target\.callbacks\.length = 0[\s\S]*?target\.tasks\.length = 0/)
  assert.match(shell, /function probe\(target: ConnectorLike\)/)
  // Re-registering directly rather than through connect(): connect() guards on
  // isConnected and would add a second message listener, and two listeners
  // shift two callbacks off the queue for every one reply.
  assert.match(shell, /candidate\.sendMessage\?\.\(\{ type: 'register' \}\)/)
  assert.ok(!/\.connect\(\)/.test(shell), 'the shell must not call connect() itself')
  // And a command that times out throws the connector away rather than letting
  // the next one queue up behind it.
  assert.match(shell, /dropConnector\(\)\s*\n\s*drainQueues\(target\)/)
})

check('a new document starts from a connector nobody has proven yet', () => {
  const shell = read('./src/office-shell/shell.ts')
  // A remount builds a fresh editor and a fresh connector; whatever answered
  // for the last document says nothing about this one.
  assert.match(shell, /async function loadFile[\s\S]*?dropConnector\(\)/)
})

fs.rmSync(workDir, { recursive: true, force: true })
console.log(`\nAll ${passed} work checks passed.`)
