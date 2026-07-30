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

## 3. `vendor/const/index.ts` + `vendor/core/editor-manager.ts` — editor logo

Upstream sets `customization.logo` to a Microsoft Office icon hosted on
jsdelivr. The editor CSP has no `https:` in `img-src`, so it was blocked and
drew as a broken image in the top-left of the toolbar. Allowing it would mean
the editor fetching from a CDN every time a document opens, which is exactly
what the frame's policy exists to prevent.

Now `{ visible: false }` — no logo at all.

## 4. `sdkjs/common/AllFonts.js` — the Holmes Minion entry

Not a source patch: `scripts/build-office-shell.mjs` appends one file name and
one font record to the two arrays in the bundle's generated `AllFonts.js`, and
writes the face itself to `fonts/holmes-minion`. The step keeps a pristine
`AllFonts.upstream.js` beside it and rebuilds from that every run, so it is
idempotent and a re-vendor resets the baseline automatically.

Two things about that file are worth knowing before touching it:

- **The binaries under `fonts/` are obfuscated.** `allfontsgen` XORs the first
  32 bytes of each with the fixed 16-byte key
  `a0 66 d6 20 14 96 47 fa 95 69 b8 50 b0 41 49 48`, and the loader undoes it on
  arrival (`sdkjs/word/sdk-all.js`, in the XHR handler ending
  `for(D=0;D<w;++D)v[D]^=x[D%16]`). Thirty-two bytes is the sfnt header and the
  first table record, so an un-obfuscated file is not a font at all.
- **Append, never insert.** `__fonts_ranges` addresses `__fonts_infos` by
  position, so shifting an existing entry repoints a whole Unicode range at the
  wrong font.

**Known incomplete.** The font is registered, listed in the toolbar, and its
file loads and parses (verified in the running app: status 0, 98,424-byte
stream). It is still not what gets drawn — text set in it renders in a fallback.
The remaining difference from every other font in the bundle is
`g_fonts_selection_bin`, the generated blob `allfontsgen` also writes, which the
layout engine reads through `AscFonts.cU` when it resolves a run's font to a
face. A font absent from it can be named but not picked. Adding a record there
is the next step.

## Which sdkjs file is live

`sdk-all-min.js` is the entry requirejs loads (`sdk: "../../sdkjs/word/sdk-all-min"`),
and it loads `sdk-all.js` at runtime for the engine. Both are live and they are
not the same build — `asc_putPageColor` and `asc_setContentDarkMode` exist only
in the minified one, the font bootstrap and the XOR key only in the other. Grep
both before concluding an API is missing.

## The plugin connector, and why it needs a handshake

`DocsAPI`'s `EditorConnector` serialises commands through a callback queue
(`web-apps/apps/api/documents/api.js`):

    this.callbacks.push(callback)
    if (1 !== this.callbacks.length) this.tasks.push(command)
    else this.sendMessage(command)

A command is only actually **sent** when it is the sole outstanding callback. So
the first command that never comes back leaves `callbacks` one entry deep for
good, and every command after it is parked in `tasks` and never sent — one
dropped reply wedges the connector for the life of the document.

What drops it is the handshake. `connect()` fires `{type:"register"}` at the
editor with no acknowledgement, so a register landing before the editor's plugin
runtime is listening is simply lost, and the first command then goes unanswered.
Opening a document is exactly when that race is live. `disconnect()` is no way
out: it removes the listener and sends `unregister` but leaves both queues as
they were, so a reconnected connector is still wedged — which is why the obvious
"disconnect and reconnect" fix does nothing.

`shell.ts` handles this in `liveConnector()`: clear both queues, re-send
`register` directly (not via `connect()`, which guards on `isConnected` and
would add a second `message` listener — and two listeners shift two callbacks
per reply), then prove the connector with a throwaway command before handing it
out. Any command that later times out drops the proven connector, so the next
call handshakes again. Verified in the app: `work_document_info`,
`work_insert_text` and `work_replace_text` all round-trip.

`Asc.editor.put_TextPrFontName` is not an alternative route for document
formatting: called from the shell it updates the toolbar without reaching a
single run (checked against `Liberation Serif` as a control, which also changed
nothing on the page). Paper mode sets its font from a template for that reason.
