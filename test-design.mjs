// Design editor checks: the holmes-design:// protocol, the Graphite bridge,
// the design shell, the DesignEditorFrame, and the design_* tool surface.
//
// Same pattern as test-work.mjs: modules that are Electron-free (or whose
// electron import the strip-types resolver stubs) are imported and exercised
// directly; UI and main-process wiring is asserted from source text. tools.ts
// is deliberately NOT imported — its graph reaches the database through
// recall.ts, and better-sqlite3 is usually built for Electron's ABI here.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  DESIGN_SCHEME,
  GRAPHITE_COMMIT,
  GRAPHITE_VERSION,
  isDesignHost,
  resolveDesignAssetPath,
} from './src/main/designProtocol.ts'
import { WORK_DOCUMENT_TYPES, workDocumentKindForExtension, workDocumentType } from './src/shared/workDocuments.ts'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

console.log('\ndesign protocol')

check('resolveDesignAssetPath refuses everything outside the bundle', () => {
  const root = '/opt/holmes/design/graphite'
  assert.equal(resolveDesignAssetPath(root, '/index.html'), `${root}/index.html`)
  assert.equal(resolveDesignAssetPath(root, '/../../etc/passwd'), null)
  assert.equal(resolveDesignAssetPath(root, '/assets/../../etc/passwd'), null)
  // Decoded first, then resolved — an encoded traversal is still a traversal.
  assert.equal(resolveDesignAssetPath(root, '/%2e%2e/%2e%2e/etc/passwd'), null)
  // A NUL truncates at the syscall boundary, so it must never reach one.
  assert.equal(resolveDesignAssetPath(root, '/a\0/../../etc/passwd'), null)
  assert.equal(resolveDesignAssetPath(root, '/%zz'), null) // malformed escape
  assert.equal(resolveDesignAssetPath(root, '/'), null)
  // Leading slashes are stripped, but the result still has to stay inside.
  assert.equal(resolveDesignAssetPath(root, '//etc/passwd'), `${root}/etc/passwd`)
})

check('no deployment prefix is ever stripped — that rewrite is ONLYOFFICE-only', () => {
  const root = '/opt/holmes/design/graphite'
  assert.equal(resolveDesignAssetPath(root, '/9.4.0-129/x.js'), `${root}/9.4.0-129/x.js`)
  assert.equal(resolveDesignAssetPath(root, '/onlyoffice/9.4.0/x.js'), `${root}/onlyoffice/9.4.0/x.js`)
})

check('exactly one host answers, and the pin is a real commit', () => {
  assert.equal(DESIGN_SCHEME, 'holmes-design')
  assert.equal(isDesignHost('graphite'), true)
  assert.equal(isDesignHost('raster'), false)
  assert.equal(isDesignHost('editor'), false)
  assert.match(GRAPHITE_COMMIT, /^[0-9a-f]{40}$/)
  assert.equal(GRAPHITE_VERSION, GRAPHITE_COMMIT.slice(0, 8))
  const source = read('./src/main/designProtocol.ts')
  assert.match(source, /if \(!isDesignHost\(url\.hostname\)\) return new Response\('Not found', \{ status: 404 \}\)/)
})

check('the design frame gets wasm but never eval, and never the network', () => {
  const source = read('./src/main/designProtocol.ts')
  const csp = /const DESIGN_CSP = \[([\s\S]*?)\]\.join/.exec(source)
  assert.ok(csp, 'DESIGN_CSP moved — re-check this assertion')
  assert.ok(!/\bhttps?:/.test(csp[1]), 'the design frame must not be able to phone home')
  assert.ok(!/\bwss?:/.test(csp[1]), 'no websocket egress either')
  // Graphite is Rust-in-wasm: wasm compilation is allowed, JS eval is not.
  assert.match(csp[1], /'wasm-unsafe-eval'/)
  assert.ok(!/'unsafe-eval'/.test(csp[1]), 'no JS eval in the design frame')
  assert.match(csp[1], /object-src 'none'/)
  // Only documents carry the policy, and stored encodings never leak through.
  assert.match(source, /if \(contentType === 'text\/html'\) headers\.set\('Content-Security-Policy', DESIGN_CSP\)/)
  assert.match(source, /headers\.delete\('Content-Encoding'\)/)
})

check('the scheme registers once, with every other privileged scheme', () => {
  const main = read('./src/main/main.ts')
  // A second registerSchemesAsPrivileged call strips privileges granted by the
  // first (verified on Electron 39), so all schemes go through one call.
  assert.equal(main.match(/registerSchemesAsPrivileged\(/g)?.length, 1)
  assert.match(main, /DESIGN_SCHEME_PRIVILEGES,/)
  assert.match(main, /installDesignProtocol\(\)/)
  assert.match(main, /`\$\{DESIGN_SCHEME\}:\/\/graphite\/`/)
  const protocol = read('./src/main/designProtocol.ts')
  assert.match(protocol, /standard: true/)
  assert.match(protocol, /secure: true/)
  assert.match(protocol, /bypassCSP: false/)
})

check('the renderer can frame the design editor and still never eval', () => {
  const html = read('./src/renderer/index.html')
  assert.match(html, /frame-src[^;]*holmes-design:/)
  assert.ok(!/unsafe-eval/.test(html), 'unsafe-eval must stay out of the renderer')
})

console.log('\nvendoring')

check('vendoring builds from source at the protocol\'s pinned commit', () => {
  const script = read('./scripts/vendor-design-editors.mjs')
  // The commit lives in ONE place; the vendor and shell-build scripts read it.
  assert.match(script, /designProtocol\.ts/)
  assert.ok(!/sha256|codeload|registry\.npmjs/.test(script), 'no tarball fetching remains — this is a source build')
  assert.match(script, /'apply', '--verbose', PATCH/)
  assert.match(script, /cargo.*build.*web|'build', 'web'/)
  assert.match(script, /startsWith\('\._'\)/)
  const build = read('./scripts/build-design-shell.mjs')
  assert.match(build, /designProtocol\.ts/)
  assert.match(build, /process\.exit\(1\)/)
  const pkg = JSON.parse(read('./package.json'))
  assert.equal(pkg.scripts['vendor:design'], 'node scripts/vendor-design-editors.mjs')
  assert.equal(pkg.scripts['build:design-shell'], 'node scripts/build-design-shell.mjs')
  assert.match(pkg.scripts.test, /test:design/)
})

check('the patch ledger and provenance say what they must', () => {
  const upstream = read('./src/design-shell/UPSTREAM.md')
  assert.match(upstream, /Apache-2\.0/)
  assert.match(upstream, /GRAPHITE_COMMIT/)
  const patches = read('./src/design-shell/PATCHES.md')
  // The four patched commands, each with its reason on record.
  assert.match(patches, /holmes_export_document/)
  assert.match(patches, /holmes_mark_saved/)
  assert.match(patches, /holmes_new_document/)
  assert.match(patches, /holmes_save_document/)
  assert.match(patches, /TriggerSaveFile/)
  const patch = read('./src/design-shell/patches/graphite-holmes-bridge.patch')
  assert.match(patch, /holmesTap/)
  assert.match(patch, /holmesEditor/)
  assert.match(patch, /fn holmes_export_document/)
  assert.match(patch, /fn holmes_mark_saved/)
  assert.match(patch, /fn holmes_new_document/)
})

check('a new canvas opens a blank document, never the Welcome panel', () => {
  const shell = read('./src/design-shell/graphite.ts')
  // Persistence is severed, so the document list boots empty and the frontend
  // would show Welcome; open must create the document itself.
  assert.match(shell, /api\.holmesNewDocument\(openFileName\.replace/)
})

check('Font Awesome Pro is used by name only — no licensed data in the repo', () => {
  const map = JSON.parse(read('./src/design-shell/fa-icon-map.json'))
  const entries = Object.entries(map)
  assert.ok(entries.length > 100, `expected a substantial map, got ${entries.length}`)
  for (const [graphiteIcon, faName] of entries) {
    // Graphite's registry keys are PascalCase; FA names are kebab-case.
    assert.match(graphiteIcon, /^[A-Z][A-Za-z0-9]*$/, `${graphiteIcon} is not a Graphite icon key`)
    assert.match(faName, /^[a-z0-9-]+$/, `${faName} is not a Font Awesome icon name`)
  }
  // Glyph data (codepoints, font binaries, path data) must never be committed:
  // Pro is non-redistributable and Holmes is public AGPL.
  const raw = read('./src/design-shell/fa-icon-map.json')
  assert.ok(!/\\[a-f0-9]{4}|<svg|woff/.test(raw), 'the map must hold names only')
  const build = read('./scripts/build-design-shell.mjs')
  assert.match(build, /HOLMES_FA_PRO_DIR/)
  assert.match(build, /Font Awesome Pro/)
  // Absent pack must degrade to Graphite's own icons rather than failing.
  assert.match(build, /keeping Graphite's own icons/)
  assert.match(build, /__HOLMES_FA_ICONS__/)
})

check('the icon swap is wired through the patched class, not guesswork', () => {
  const patch = read('./src/design-shell/patches/graphite-holmes-bridge.patch')
  // IconLabel renders {@html ...} into a row that otherwise carries no icon
  // identity, so the class is the only per-icon hook.
  assert.match(patch, /holmes-icon-\$\{icon\}/)
  const build = read('./scripts/build-design-shell.mjs')
  assert.match(build, /\.icon-label\.holmes-icon-\$\{graphiteIcon\} > svg \{ display: none; \}/)
  // Graphite recolours by fill, which does not paint a glyph.
  assert.match(build, /color: var\(--color-2-mildblack\)/)
  const shell = read('./src/design-shell/graphite.ts')
  assert.match(shell, /if \(__HOLMES_FA_ICONS__\)/)
  assert.match(shell, /fa-icons\.css/)
})

check('standalone-app chrome is hidden in the injected skin', () => {
  const shell = read('./src/design-shell/graphite.ts')
  // The logo is the only `button` among the menu bar's widgets; the real
  // menus are div.text-button-container and must survive.
  assert.match(shell, /\.menu-bar \.widget-span\.row > button\.text-button\.flush \{ display: none; \}/)
  assert.match(shell, /\.title-bar \.window-buttons \{ display: none; \}/)
  assert.ok(!/text-button-container[^\n]*display: none/.test(shell), 'the File/Edit/… menus must stay')
  // Injected during the readiness poll so the chrome never flashes unstyled.
  assert.match(shell, /if \(win\.document\?\.head\) applySkin\(win\)/)
})

console.log('\ndesign kinds')

check('both design kinds open the one graphite editor', () => {
  assert.equal(workDocumentType('image').editor, 'graphite')
  assert.equal(workDocumentType('image').extension, '.png')
  assert.equal(workDocumentType('vector').editor, 'graphite')
  assert.equal(workDocumentType('vector').extension, '.svg')
  assert.equal(workDocumentKindForExtension('.svg'), 'vector')
  assert.equal(workDocumentKindForExtension('.PNG'), 'image')
  // The office kinds did not move.
  for (const kind of ['document', 'spreadsheet', 'presentation']) {
    assert.equal(WORK_DOCUMENT_TYPES.find((t) => t.kind === kind)?.editor, 'office')
  }
})

check('the workspace picks the frame by editor, not by kind list', () => {
  const view = read('./src/renderer/components/WorkspaceView.tsx')
  assert.match(view, /type\?\.editor === 'office' \? \(/)
  assert.match(view, /<DesignEditorFrame/)
})

console.log('\nthe design frame')

check('the frame talks holmesDesign and points both kinds at graphite', () => {
  const frame = read('./src/renderer/components/DesignEditorFrame.tsx')
  assert.match(frame, /image: 'holmes-design:\/\/graphite\/holmes\/shell\.html'/)
  assert.match(frame, /vector: 'holmes-design:\/\/graphite\/holmes\/shell\.html'/)
  assert.match(frame, /holmesDesign: true/)
  assert.ok(!/holmesOffice/.test(frame), 'the two message protocols must not mix')
})

check('the frame reports open-with-kind on ready, closed only on unmount', () => {
  const frame = read('./src/renderer/components/DesignEditorFrame.tsx')
  // The office frame's lesson: reporting false during boot cancels the very
  // open request that is waiting.
  assert.match(frame, /setEditorOpen\(true, kind\)/)
  assert.match(frame, /useEffect\(\(\) => \(\) => \{ void window\.electronAPI\.work\.setEditorOpen\(false\) \}, \[\]\)/)
  assert.match(frame, /sandbox="allow-scripts allow-same-origin/)
})

console.log('\nthe contract')

check('setEditorOpen carries the kind through all four files', () => {
  assert.match(read('./src/preload/preload.ts'), /setEditorOpen: \(open: boolean, kind\?: WorkDocumentKind\)/)
  assert.match(read('./src/shared/types.ts'), /setEditorOpen: \(open: boolean, kind\?: WorkDocumentKind\)/)
  assert.match(read('./src/main/ipc.ts'), /setEditorOpen\(Boolean\(open\), typeof kind === 'string' \? kind : undefined\)/)
  const bridge = read('./src/main/officeBridge.ts')
  assert.match(bridge, /export function setEditorOpen\(open: boolean, kind\?: string\)/)
  assert.match(bridge, /export function editorKind\(\)/)
  // A design kind that is neither canvas falls back to office, never to a crash.
  assert.match(bridge, /kind === 'image' \|\| kind === 'vector' \? kind : 'office'/)
})

console.log('\ndesign tools')

check('the design tools are gated on an open canvas, and design_create on nothing', () => {
  const tools = read('./src/main/tools.ts')
  const ipc = read('./src/main/ipc.ts')
  assert.match(tools, /DESIGN_TOOL_NAMES = new Set\(\[\s*'design_document_info', 'design_read_svg', 'design_paste_svg', 'design_generate_image_layer',\s*\]\)/)
  assert.match(tools, /DESIGN_TOOL_NAMES\.has\(name\)\) return options\.designEditorKind != null/)
  assert.ok(!/DESIGN_TOOL_NAMES = new Set\(\[[^\]]*design_create/.test(tools))
  assert.match(tools, /case 'design_create':/)
  assert.match(ipc, /designEditorKind: openEditor === 'image' \|\| openEditor === 'vector' \? openEditor : null/)
})

check('every design tool the model can call has a shell action', () => {
  const tools = read('./src/main/tools.ts')
  const shell = read('./src/design-shell/graphite.ts')
  const names = [...tools.matchAll(/name: '(design_[a-z_]+)'/g)].map((m) => m[1])
  assert.ok(names.length >= 5, `expected the design tools, found ${names.length}`)
  for (const name of names) {
    if (name === 'design_create') continue // handled by App, not the shell
    if (name === 'design_generate_image_layer') {
      // Generation runs in main; only the finished layer crosses to the shell.
      assert.match(shell, /case 'design_add_image_layer':/)
      continue
    }
    assert.ok(shell.includes(`case '${name}':`), `${name} has no shell action`)
  }
})

check('model output crosses the design shell as data, never as code', () => {
  for (const file of ['shared.ts', 'graphite.ts']) {
    const source = read(`./src/design-shell/${file}`)
    assert.ok(!/\beval\(/.test(source), `${file}: no eval`)
    assert.ok(!/new Function/.test(source), `${file}: no dynamic function construction`)
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), `${file}: no markup injection`)
  }
  const shell = read('./src/design-shell/graphite.ts')
  // SVG enters only through the editor's parser; pixels only as decoded RGBA.
  assert.match(shell, /api\.pasteSvg\(name, svg\)/)
  assert.match(shell, /api\.pasteImage\(name, pixels, width, height\)/)
  assert.match(shell, /startsWith\('data:image\/'\)/)
})

check('the shell keeps Holmes sessions stateless and reads capped', () => {
  const shell = read('./src/design-shell/graphite.ts')
  // Every mount boots blank: the persistence triggers are consumed.
  assert.match(shell, /case 'TriggerPersistenceReadState':/)
  assert.match(shell, /case 'TriggerPersistenceWriteDocument':/)
  // Exports become bytes for Holmes, not downloads.
  assert.match(shell, /case 'TriggerSaveFile':/)
  // A huge design must not blow the tool budget.
  assert.match(shell, /READ_CAP = 60_000/)
  assert.match(shell, /truncated: svg\.length > READ_CAP/)
})

check('generated layers keep their pixels out of the model context', () => {
  const tools = read('./src/main/tools.ts')
  // The data URL goes to the editor; the tool result is a summary.
  assert.match(tools, /requestEditor\('design_add_image_layer', \{ name, dataUrl: media\.dataUrl \}\)/)
  assert.match(tools, /approxBytes/)
  assert.ok(!/result = JSON\.stringify\(media/.test(tools), 'the media object must never be the tool result')
  // The prompt is redacted before it leaves, like every generation path.
  assert.match(tools, /generateImage\(getProvider\(\), model, redactMemoryContent\(prompt\), signal\)/)
})

console.log('\nrole document')

check('the Designer role knows the canvas, and the prompt version did not move', () => {
  const roles = read('./src/shared/roles.ts')
  assert.match(roles, /design_create/)
  assert.match(roles, /design_read_svg/)
  assert.match(roles, /design_paste_svg/)
  // Editing a work-role document must never bump the version: it would
  // regenerate every therapy note at provider expense (roles.ts:66-74).
  assert.match(roles, /ROLE_PROMPT_VERSION = 'v1-therapist'/)
  // Honesty about raster: the model still cannot judge embedded pixels.
  assert.match(roles, /cannot judge|cannot see/i)
})

console.log(`\nAll ${passed} design checks passed.`)
