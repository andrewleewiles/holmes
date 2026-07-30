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
   - `holmes_new_document(name)` → `PortfolioMessage::NewDocumentWithName`.
     With persistence severed the editor boots with an EMPTY document list,
     which the frontend fills with its Welcome panel; a Work canvas must open
     onto a real blank document instead. Named here rather than through the
     new-document dialog, which would need a user click.
   - `holmes_save_document()` → `DocumentMessage::SaveDocument`. Unused by
     the v1 shell; it is the hook for saving the native `.graphite`/`.gdd`
     format later (the bytes arrive as `TriggerSaveDocument`).

3. **`frontend/src/components/widgets/labels/IconLabel.svelte` — icon names in
   the DOM.** The component renders `{@html ICON_SVG_STRINGS[icon]}` inside a
   row classed only `icon-label size-16`, so nothing downstream can tell one
   icon from another. The patch adds `holmes-icon-${icon}` to that class list,
   which is what lets the Font Awesome stylesheet target icons individually.
   One line; no behaviour change.

## Font Awesome Pro icons (build-time, licensed copy, never in this repo)

Where an equivalent exists, Graphite's icon is replaced by a Font Awesome Pro
glyph: the SVG is hidden and a `::before` glyph takes its place.
`src/design-shell/fa-icon-map.json` (147 entries) is the tracked side and holds
**only name→name pairs** — no glyph data, no codepoints. At build time
`scripts/build-design-shell.mjs` reads a licensed Pro copy
(`HOLMES_FA_PRO_DIR`, or a known local path), resolves each name to its glyph,
copies `fa-solid-900.woff2` into the bundle and generates `holmes/fa-icons.css`
there. Both outputs live only in the gitignored bundle.

**Font Awesome Pro is commercially licensed and must not be redistributed.** A
clone without a licensed copy simply keeps Graphite's icons — the build says so
and carries on. Note that a *packaged* Holmes build made on a machine with the
pack will contain the Pro webfont, which that licence governs.

The remaining ~75 Graphite icons stay as they are: they are vector-editor
concepts Font Awesome has never drawn (boolean operations, stroke caps, joins
and alignments, handle visibility, render modes, node types, gradient
reversal). Graphite recolours icons per state by overriding `fill`, which
paints an SVG but not a glyph, so the generated stylesheet mirrors those
states in `color`; a state missed there costs contrast on one icon, never a
missing icon.

## Standalone-app chrome, hidden in CSS (not patched)

The Graphite logo (the one `button` in the menu bar — every real menu beside
it is a `div.text-button-container`) and `.window-buttons` (in this embed:
the fullscreen button, which the iframe's permissions policy blocks anyway)
are hidden by the shell's injected stylesheet, alongside the palette. Kept out
of the patch set deliberately: it is presentation, and if Graphite renames a
class the chrome merely reappears rather than the build breaking.

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
