// Compiles the design shell into the vendored Graphite bundle.
//
// Same reasoning as build-office-shell.mjs: the shell cannot go through
// electron-vite, because the renderer is served from file:// and this page
// has to be served from holmes-design:// so it is same-origin with the
// editor iframe it drives. So it is its own esbuild bundle, written next to
// the editor it wraps.
//
//   node scripts/build-design-shell.mjs      (pnpm build:design-shell)
//
// There is no worker entry point here — Graphite's own wasm worker wiring is
// inside its vite build — so the esbuild worker-URL gotcha (office PATCHES.md
// #1) does not apply. Do not re-add a worker entry without re-reading that note.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as esbuild from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// The version directory is the pinned commit's short hash — read it from the
// protocol module so the two cannot drift.
const protocolSource = fs.readFileSync(path.join(root, 'src/main/designProtocol.ts'), 'utf8')
const commit = /GRAPHITE_COMMIT = '([0-9a-f]{40})'/.exec(protocolSource)?.[1]
if (!commit) {
  console.error('GRAPHITE_COMMIT not found in src/main/designProtocol.ts')
  process.exit(1)
}

const bundleRoot = path.join(root, 'node_modules/.holmes/design/graphite', commit.slice(0, 8))
if (!fs.existsSync(path.join(bundleRoot, 'index.html'))) {
  console.error(`Graphite bundle not found at ${path.relative(root, bundleRoot)}`)
  console.error('Run `pnpm vendor:design` first.')
  process.exit(1)
}
const outDir = path.join(bundleRoot, 'holmes')
fs.mkdirSync(outDir, { recursive: true })

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/design-shell/graphite.ts')],
  bundle: true,
  format: 'esm',
  // The frame is Chromium of a known version — no need to down-level.
  target: 'chrome120',
  outfile: path.join(outDir, 'shell.js'),
  sourcemap: false,
  minify: true,
  logLevel: 'warning',
  metafile: true,
})

// The shell page itself. Kept here rather than as a file to copy so the
// markup and the script that fills it cannot drift apart.
const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Holmes design editor</title>
<style>
  html, body { margin: 0; height: 100%; background: #20201e; overflow: hidden; }
  #holmes-design-root { position: absolute; inset: 0; }
  #holmes-design-root iframe { border: 0; width: 100%; height: 100%; }
</style></head>
<body><div id="holmes-design-root"></div>
<script type="module" src="./shell.js"></script>
</body></html>
`
fs.writeFileSync(path.join(outDir, 'shell.html'), html)

// AppleDouble twins break codesign, and this volume creates one per file.
for (const name of fs.readdirSync(outDir)) {
  if (name.startsWith('._')) fs.rmSync(path.join(outDir, name), { force: true })
}

for (const [file, out] of Object.entries(result.metafile.outputs)) {
  console.log(`  ${path.relative(root, file).padEnd(70)} ${(out.bytes / 1024).toFixed(0)} KB`)
}
