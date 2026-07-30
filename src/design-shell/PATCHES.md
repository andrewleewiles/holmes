# Local patches to the vendored Graphite build

One patch file — `patches/graphite-holmes-bridge.patch` — applied by the
vendor script before building. Regenerate it with `git diff` inside the build
clone; never hand-edit the clone without re-deriving the patch.

1. **`frontend/src/App.svelte` — the bridge exposure.** The editor window
   publishes `window.holmesEditor` (the generated command API) and offers
   every `FrontendMessage` to `window.holmesTap` before the frontend's own
   subscription router. A truthy return consumes the message — that is how an
   export the shell requested becomes bytes for Holmes instead of a browser
   download, and how persistence is severed (below). Symptom without it: no
   programmatic surface at all.
2. **`frontend/wrapper/src/editor_commands.rs` — three Holmes commands.**
   - `holmes_export_document(file_type, scale_factor)` → dispatches
     `PortfolioMessage::SubmitDocumentExport`. Only the export dialog could
     trigger a render otherwise. The finished bytes arrive as
     `TriggerSaveFile` (the editor renders SVG and rasterizes PNG itself, on
     the GPU) — NOT as `TriggerExportImage`, which this path no longer uses.
   - `holmes_mark_saved()` → `DocumentMessage::MarkAsSaved`. Web documents
     have no filesystem path, so the editor's own save flow never clears
     their unsaved flag; without this, the workspace stays "busy" forever
     after a Holmes save.
   - `holmes_save_document()` → `DocumentMessage::SaveDocument`. Unused by
     the v1 shell; it is the hook for saving the native `.graphite`/`.gdd`
     format later (the bytes arrive as `TriggerSaveDocument`).

## Deliberately NOT patched

- **Service worker registration fails on `holmes-design://`** ("URL protocol
  not supported") and logs one console error. Harmless: the SW only provides
  offline caching, which a local bundle does not need.
- **Persistence (IndexedDB restore/auto-save)** is not patched out of the
  frontend — the shell's tap consumes the `TriggerPersistence*` messages
  instead, so every Holmes mount boots a blank document and Holmes owns
  durability through Save. Verified: with the read consumed and storage
  untouched, the editor falls through to its blank-document boot.
- **`loadDemoArtwork`** only fires behind a `#demo/` URL hash the shell never
  sets.
