# Local modifications to the vendored wrapper

Keep this list short. Every entry is a maintenance cost on the next re-vendor.

## 1. `vendor/internal/editor/x2t.ts` — worker URL

Upstream: `new Worker(new URL("./x2t.worker.ts", import.meta.url))`
Here:     `new Worker(new URL("./x2t.worker.js", import.meta.url))`

Upstream builds under Next.js/Vite, which rewrite a `.ts` worker URL to the
built asset. esbuild does not, so the editor asked the protocol for
`/holmes/x2t.worker.ts` and got a 404 — surfacing only as
`Worker error: undefined` when an export was attempted.
`scripts/build-office-shell.mjs` emits `x2t.worker.js` beside `shell.js`.

## Deliberately NOT patched

- **Static resource root.** Set at runtime via `registerStaticResource()` in
  `shell.ts`; the protocol handler maps the deployment-shaped path back onto the
  flat bundle.
- **Brotli.** `x2t-assets.ts` already short-circuits when the wasm arrives
  already inflated (`isAlreadyDecompressed`), and Holmes inflates it in the main
  process, so the vendored JS decoder is never entered.
- **exceljs.** Stubbed at build time rather than in source — see
  `scripts/build-office-shell.mjs`.

## 2. `vendor/const/index.ts` — `resolveSiteUrl` scheme test

Upstream: `if (/^https?:\/\//i.test(path))`
Here:     `if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path))`

Upstream only treats `http(s)` as already-absolute. Under `holmes-office://`
the origin was prepended to an already-absolute URL — and the x2t worker
resolves its assets twice, so the result was
`holmes-office://editor/holmes-office://editor/holmes-office://editor/...`
and a 404 that surfaced only as `Worker error: undefined`.
This is a general correctness fix, not Holmes-specific.
