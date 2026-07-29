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
import { strToU8, zipSync } from 'fflate'
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

check('the three document kinds are defined once and shared', () => {
  assert.deepEqual(WORK_DOCUMENT_TYPES.map((type) => type.kind), ['document', 'spreadsheet', 'presentation'])
  assert.deepEqual(WORK_DOCUMENT_TYPES.map((type) => type.extension), ['.docx', '.xlsx', '.pptx'])
  // The sidebar entries are what the user asked for by name.
  assert.deepEqual(
    WORK_DOCUMENT_TYPES.map((type) => type.newLabel),
    ['New Document', 'New Spreadsheet', 'New Presentation'],
  )
  // Every kind the indexer can extract is a kind the editor can make.
  for (const type of WORK_DOCUMENT_TYPES) assert.ok(DOCUMENT_EXTENSIONS.has(type.extension))
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
  // The nav entries come from the shared list rather than being retyped.
  assert.match(sidebar, /WORK_DOCUMENT_TYPES\.map/)
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
  assert.equal(work, library, 'Work must be cleared everywhere Library is')
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
  assert.match(main, /registerOfficeScheme\(\)/)
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

fs.rmSync(workDir, { recursive: true, force: true })
console.log(`\nAll ${passed} work checks passed.`)
