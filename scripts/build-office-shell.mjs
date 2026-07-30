// Compiles the in-frame editor shell into the vendored ONLYOFFICE bundle.
//
// The shell cannot go through electron-vite: vite builds the renderer, which is
// served from file://, and this has to be served from holmes-office:// so that
// it is same-origin with the editor iframe it drives. So it is its own esbuild
// bundle, written next to the assets it loads.
//
//   node scripts/build-office-shell.mjs
//
// Output lands in the gitignored bundle directory, never in the repo.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ONLYOFFICE_VERSION = '9.4.0'
const bundleRoot = path.join(root, 'node_modules/.holmes/onlyoffice', ONLYOFFICE_VERSION)
const outDir = path.join(bundleRoot, 'holmes')

/** The Work tab's paper font — see installHolmesMinion() at the foot of this file. */
const FONT_FAMILY = 'Holmes Minion'
const FONT_FILE = 'holmes-minion'
const FONT_MARKER = '/* holmes-minion */'

if (!fs.existsSync(path.join(bundleRoot, 'sdkjs'))) {
  console.error(`ONLYOFFICE bundle not found at ${path.relative(root, bundleRoot)}`)
  console.error('Run the vendoring step first.')
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })

/**
 * The wrapper lazily imports exceljs on one path only: converting a complex CSV
 * to XLSX before handing it to x2t, because x2t's own CSV parser can crash. The
 * Work tab opens .docx/.xlsx/.pptx and never a CSV, so rather than ship a
 * megabyte of exceljs for a branch that cannot be reached, stub it with
 * something that says so if it ever is.
 */
const stubExcelJs = {
  name: 'stub-exceljs',
  setup(build) {
    build.onResolve({ filter: /^exceljs/ }, () => ({ path: 'exceljs', namespace: 'stub-exceljs' }))
    build.onLoad({ filter: /.*/, namespace: 'stub-exceljs' }, () => ({
      contents: `export default new Proxy({}, { get() {
        throw new Error('exceljs is not bundled: the Work tab does not open CSV files. See scripts/build-office-shell.mjs')
      } })`,
      loader: 'js',
    }))
  },
}

const result = await esbuild.build({
  plugins: [stubExcelJs],
  entryPoints: [
    path.join(root, 'src/office-shell/shell.ts'),
    // The x2t converter runs in its own module worker; see PATCHES.md #1.
    path.join(root, 'src/office-shell/vendor/internal/editor/x2t.worker.ts'),
  ],
  bundle: true,
  format: 'esm',
  // The editor frame is Chromium of a known version — no need to down-level.
  target: 'chrome120',
  outdir: outDir,
  // Both entries land flat beside each other: shell.js resolves the worker as
  // './x2t.worker.js', relative to its own URL.
  entryNames: '[name]',
  sourcemap: false,
  minify: true,
  // The vendored wrapper spawns its x2t worker from a separate chunk.
  splitting: false,
  logLevel: 'warning',
  metafile: true,
})

// The shell page itself. Kept here rather than as a file to copy so the markup
// and the script that fills it cannot drift apart.
const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Holmes office editor</title>
<style>
  html, body { margin: 0; height: 100%; background: #20201e; overflow: hidden; }
  #holmes-office-editor { position: absolute; inset: 0; }
</style></head>
<body><div id="holmes-office-editor"></div>
<script type="module" src="./shell.js"></script>
</body></html>
`
fs.writeFileSync(path.join(outDir, 'shell.html'), html)

// A real Document Server generates these two at its web root; the static bundle
// has neither, and the editor logs a parse failure without them. Both are
// deliberately empty: plugins are third-party code we do not want loading
// inside the editor frame, and the UI theme is set through `customization`.
fs.writeFileSync(path.join(bundleRoot, 'plugins.json'), JSON.stringify({ url: '', pluginsData: [] }))
fs.writeFileSync(path.join(bundleRoot, 'themes.json'), JSON.stringify({ themes: [] }))

// The blank document paper mode opens (see scripts/build-paper-template.py).
// Served beside shell.js so the shell can fetch it as './paper.docx'.
fs.copyFileSync(path.join(root, 'src/office-shell/templates/paper.docx'), path.join(outDir, 'paper.docx'))

installHolmesMinion()

// AppleDouble twins break codesign, and this volume creates one per file.
for (const name of fs.readdirSync(outDir)) {
  if (name.startsWith('._')) fs.rmSync(path.join(outDir, name), { force: true })
}

for (const [file, out] of Object.entries(result.metafile.outputs)) {
  console.log(`  ${path.relative(root, file).padEnd(58)} ${(out.bytes / 1024).toFixed(0)} KB`)
}

/**
 * Registers Holmes Minion as a real ONLYOFFICE font.
 *
 * The Work tab's paper mode sets documents in Minion, and the editor draws every
 * glyph itself onto a canvas from a font it has parsed — a CSS `@font-face` is
 * invisible to it. So the face has to join the bundle's own font list, which is
 * two things: the binary under `fonts/`, and the entry in `sdkjs/common/AllFonts.js`
 * that names it and says which file it lives in.
 *
 * The binary is not stored plainly. `allfontsgen` XORs the first 32 bytes of each
 * file with a fixed 16-byte key and the loader undoes it on arrival
 * (`sdk-all.js`, in the XHR handler that ends `for(D=0;D<w;++D)v[D]^=x[D%16]`).
 * Thirty-two bytes is exactly the sfnt header and the first table record, so an
 * un-obfuscated file is not a slightly-wrong font — it is not a font at all, and
 * fails as a silent blank run of text.
 *
 * The source .ttf is committed (see scripts/build-holmes-minion.py); this step
 * only installs it, so no font tooling is needed to build Holmes.
 */
function installHolmesMinion() {
  const source = path.join(root, 'src/office-shell/fonts/HolmesMinion-Regular.ttf')
  if (!fs.existsSync(source)) {
    console.warn('  Holmes Minion is missing; the Work tab will fall back to Liberation Serif.')
    return
  }

  const KEY = [160, 102, 214, 32, 20, 150, 71, 250, 149, 105, 184, 80, 176, 65, 73, 72]
  const bytes = fs.readFileSync(source)
  for (let i = 0; i < Math.min(32, bytes.length); i++) bytes[i] ^= KEY[i % 16]
  // Named rather than numbered. Every other entry is a three-digit index because
  // allfontsgen counts, but the loader just concatenates the string onto the
  // fonts URL — so a name that says what it is keeps this file from ever
  // colliding with a re-vendored bundle's numbering.
  fs.writeFileSync(path.join(bundleRoot, 'fonts', FONT_FILE), bytes)

  const allFonts = path.join(bundleRoot, 'sdkjs/common/AllFonts.js')
  const pristine = path.join(bundleRoot, 'sdkjs/common/AllFonts.upstream.js')
  let source_js = fs.readFileSync(allFonts, 'utf8')
  if (source_js.includes(FONT_MARKER)) {
    // Already patched by an earlier run: go back to the copy taken before it, so
    // this stays idempotent rather than appending the font again every build.
    source_js = fs.readFileSync(pristine, 'utf8')
  } else {
    // Also the re-vendor path — a fresh AllFonts.js has no marker, so it becomes
    // the new pristine copy and the stale one is replaced.
    fs.writeFileSync(pristine, source_js)
  }

  const files = readArray(source_js, '__fonts_files')
  const index = files.count
  let patched = source_js
  // Appended, never inserted: `__fonts_ranges` addresses `__fonts_infos` by
  // position, so shifting an existing entry would repoint a whole Unicode range
  // at the wrong font.
  patched = patched.slice(0, files.end) + `,\n"${FONT_FILE}"` + patched.slice(files.end)
  const infos = readArray(patched, '__fonts_infos')
  const entry = `,\n["${FONT_FAMILY}",${index},0,-1,-1,-1,-1,-1,-1]`
  patched = patched.slice(0, infos.end) + entry + patched.slice(infos.end)
  fs.writeFileSync(allFonts, `${FONT_MARKER}\n${patched}`)

  console.log(`  ${path.relative(root, source)}`.padEnd(60) + ` ${(bytes.length / 1024).toFixed(0)} KB  -> fonts/${FONT_FILE} as "${FONT_FAMILY}"`)
}

/** Where a `window["…"] = [ … ]` literal ends, and how many entries it holds. */
function readArray(text, name) {
  const opening = text.indexOf(`window["${name}"] = [`)
  if (opening === -1) throw new Error(`${name} is not in AllFonts.js — the bundle layout changed`)
  const end = text.indexOf('\n];', opening)
  if (end === -1) throw new Error(`${name} in AllFonts.js is not terminated as expected`)
  const body = text.slice(opening, end)
  return { end, count: body.split('\n').filter((line) => line.startsWith('"') || line.startsWith('[')).length }
}
