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

// AppleDouble twins break codesign, and this volume creates one per file.
for (const name of fs.readdirSync(outDir)) {
  if (name.startsWith('._')) fs.rmSync(path.join(outDir, name), { force: true })
}

for (const [file, out] of Object.entries(result.metafile.outputs)) {
  console.log(`  ${path.relative(root, file).padEnd(58)} ${(out.bytes / 1024).toFixed(0)} KB`)
}
