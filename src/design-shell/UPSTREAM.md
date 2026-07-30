# Design editor bundle

One vendored editor, **built from source** by `pnpm vendor:design`
(`scripts/vendor-design-editors.mjs`) into the gitignored
`node_modules/.holmes/design/graphite/<commit8>/` tree and served from
`holmes-design://graphite/`.

## Graphite

- Source: https://github.com/GraphiteEditor/Graphite, pinned to the commit in
  `GRAPHITE_COMMIT` (src/main/designProtocol.ts — the single source of truth
  the vendor and shell-build scripts both read).
- License: Apache-2.0 (compatible one-way with Holmes' AGPL-3.0-or-later).
- No published web build exists, so vendoring is a source build:
  Rust → wasm32 (wasm-bindgen 0.2.121) → Vite. `cargo-about` must be 0.9.0 —
  0.9.1 removed a config key Graphite's `about.toml` still uses. A cold build
  is tens of minutes; the clone persists under `.build/` for incremental runs.
- ~48 MB built (one wasm binary + Svelte frontend + fonts). Rendering is
  WebGPU (vello) and works in a hidden window; no SharedArrayBuffer, so no
  COOP/COEP — only `'wasm-unsafe-eval'` in the frame CSP.

## Why Graphite carries local patches (unlike the office bundle)

Graphite has no embed or automation API. Its frontend drives the editor
through a generated command surface (`EditorWrapper`) and receives
`FrontendMessage`s back — both internal. The patch set
(`patches/graphite-holmes-bridge.patch`, applied by the vendor script) exposes
exactly that pair to the shell page, which is what makes the AI collaboration
tools possible: `pasteSvg`/`pasteImage` in, layer structure and rendered
SVG/PNG out. See PATCHES.md for the ledger.

## History

The first iteration of this feature embedded miniPaint (raster) and SVG-Edit
(vector) as two unpatched bundles. Replaced 2026-07-29/30 by Graphite covering
both kinds in one procedural editor — the bridge above gives it a strictly
stronger AI surface than either predecessor (the whole canvas, raster layers
included, reads back as SVG).
