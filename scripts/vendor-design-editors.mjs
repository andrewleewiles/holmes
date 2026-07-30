// Builds the Graphite design editor from source and vendors the result.
//
//   node scripts/vendor-design-editors.mjs      (pnpm vendor:design)
//
// Unlike the office bundle (fetched prebuilt from a Docker image), Graphite
// has no published web build, and Holmes carries two small local patches that
// expose its command API to the design shell (src/design-shell/patches/).
// So vendoring here means: clone at the pinned commit, apply the patches,
// `cargo run build web`, and copy the dist into the gitignored tree that
// holmes-design:// serves.
//
// Requires a Rust toolchain (rustup with the wasm32-unknown-unknown target)
// and Node — a cold build takes tens of minutes; the clone is kept under
// .build/ so rebuilds are incremental.
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const designRoot = path.join(root, 'node_modules/.holmes/design')

// The single source of truth for the pinned commit is the protocol module.
const protocolSource = fs.readFileSync(path.join(root, 'src/main/designProtocol.ts'), 'utf8')
const COMMIT = /GRAPHITE_COMMIT = '([0-9a-f]{40})'/.exec(protocolSource)?.[1]
if (!COMMIT) throw new Error('GRAPHITE_COMMIT not found in src/main/designProtocol.ts')

const REPO = 'https://github.com/GraphiteEditor/Graphite.git'
const PATCH = path.join(root, 'src/design-shell/patches/graphite-holmes-bridge.patch')

const buildDir = path.join(designRoot, '.build/graphite')
const target = path.join(designRoot, 'graphite', COMMIT.slice(0, 8))

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const out = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()

if (fs.existsSync(path.join(target, 'index.html'))) {
  console.log(`graphite ${COMMIT.slice(0, 8)} already vendored, skipping`)
  process.exit(0)
}

// The build needs more than cargo: wasm-bindgen-cli must match the crate's
// wasm-bindgen (0.2.121 at this pin), and cargo-about must be 0.9.0 — 0.9.1
// removed the `no-clearly-defined` key Graphite's about.toml still sets.
try {
  out('cargo', ['--version'])
} catch {
  console.error('Graphite is built from source. Install the toolchain first:')
  console.error('  rustup target add wasm32-unknown-unknown')
  console.error('  cargo install -f wasm-bindgen-cli --version 0.2.121 --locked')
  console.error('  cargo install cargo-about --version 0.9.0 --locked --features cli')
  process.exit(1)
}

// Clone once, then reuse; the checkout is pinned so a reuse is deterministic.
if (!fs.existsSync(path.join(buildDir, '.git'))) {
  fs.mkdirSync(path.dirname(buildDir), { recursive: true })
  run('git', ['clone', REPO, buildDir])
}
run('git', ['fetch', 'origin', COMMIT], buildDir)
run('git', ['checkout', '--force', COMMIT], buildDir)
run('git', ['clean', '-fd', '--', 'frontend/src', 'frontend/wrapper/src'], buildDir)

// The Holmes bridge: a message tap and two export commands. Verified against
// the pinned commit; `git apply` failing here means the pin moved without the
// patch being re-derived — fix the patch, never hand-edit the clone.
run('git', ['apply', '--verbose', PATCH], buildDir)

run('cargo', ['run', 'build', 'web'], buildDir)

const dist = path.join(buildDir, 'frontend/dist')
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error(`Build finished but ${dist} has no index.html`)
}

fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(dist, target, { recursive: true })

// AppleDouble twins break codesign, and this volume creates one per file.
for (const entry of fs.readdirSync(target, { withFileTypes: true, recursive: true })) {
  if (entry.name.startsWith('._')) fs.rmSync(path.join(entry.parentPath, entry.name), { force: true })
}

const files = fs.readdirSync(target, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
const bytes = files.reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0)
console.log(`${path.relative(root, target)}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`)
console.log('done — next: pnpm build:design-shell')
