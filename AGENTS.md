# AGENTS.md

Read this first. It tells you what Holmes is, where things live, what to mimic, and what to never break. Reference-style — pointers over prose.

## What Holmes is

Holmes is an Electron desktop AI harness (React + TypeScript + better-sqlite3 + Tailwind + zustand). It connects to OpenRouter or any custom OpenAI-compatible endpoint via `fetch` — **no AI SDK** (no `openai`, `anthropic`, or `langchain` dependency). Local-first: SQLite at `~/Library/Application Support/holmes/holmes.db`, `electron-store` for settings, no telemetry, no account, no cloud.

## Tech stack

| Layer | Technology | Version | Where |
|---|---|---|---|
| Runtime | Electron | 39.8.10 | package.json |
| UI framework | React | 18.3.1 | package.json |
| Language | TypeScript | 5.9.0 | package.json |
| Database | better-sqlite3 | 12.11.1 | `src/main/database.ts` |
| Build | electron-vite | 5.x | electron.vite.config.ts |
| Styling | Tailwind | 4.1.4 | `src/renderer/styles/` |
| State | zustand | 5.0.0 | `src/renderer/store/` |
| IDs | uuid | 11.1.0 | `src/main/database.ts` |
| Health ingestion | saxes, fast-xml-parser, pdfjs-dist | (Phase 2) | `src/main/health.ts` |

**Not present (do not assume):** `react-router` (manual section-state navigation), any UI library (MUI/Chakra/shadcn/Radix — hand-rolled Tailwind only), any LLM SDK (direct `fetch` to OpenRouter), `eslint` (script exists in package.json but binary not installed).

## Project layout

```
holmes/
├── src/
│   ├── main/                  # Electron main process — FLAT topic files, NO features/ subfolder
│   │   ├── main.ts            # App lifecycle, 3 background timers
│   │   ├── database.ts        # Schema, migrations, all CRUD (~1450 lines)
│   │   ├── ipc.ts             # All ipcMain.handle registrations (~1250 lines)
│   │   ├── ipcChannels.ts     # Channel string constants (single source of truth)
│   │   ├── settings.ts        # electron-store backed settings
│   │   ├── provider.ts        # OpenRouter/custom/Ollama API calls (fetch)
│   │   ├── callLog.ts         # Wraps fetch: records every provider call (input/output/cost)
│   │   ├── providerEndpoint.ts # THE endpoint resolver: getBaseUrl/getApiKey/getHeaders
│   │   ├── tools.ts           # Tool definitions + executor for model tool-calling
│   │   ├── fileScope.ts       # File access scope enforcement
│   │   ├── projectContext.ts  # File collection + Psychology/Health context builders
│   │   ├── memory.ts          # redactMemoryContent + memory parsing
│   │   ├── memoryContext.ts   # Builds system-prompt context (Detailed/Abridged/Anonymous)
│   │   ├── memorySources.ts   # Evidence collection (conversations, projects, files, iMessage)
│   │   ├── memorySummary.ts   # Rolling abridged summary generation/refresh
│   │   ├── memoryQueries.ts   # Recall query building per memory category
│   │   ├── conversationMemory.ts # Idle conversation memory extraction
│   │   ├── recall.ts          # Spotlight + conversation recall search/ranking
│   │   ├── productSearch.ts   # Product research prompt + response parsing
│   │   ├── claudeImport.ts    # Claude data import with memory extraction
│   │   ├── imessage.ts        # Reads macOS iMessage metadata
│   │   ├── psychologicalTestFiles.ts # Writes psychological test result files
│   │   ├── health.ts          # Phase 2 ingestion parsers + redactHealthContent
│   │   ├── healthAnalysis.ts  # Phase 1 HEALTH_ANALYSIS_SYSTEM_PROMPT + parser
│   │   ├── healthSummary.ts   # Phase 2 rolling synthesis
│   │   └── healthLive.ts       # Phase 3 Swift sidecar spawning
│   ├── preload/
│   │   └── preload.ts         # contextBridge.exposeInMainWorld('electronAPI', api) — single file
│   ├── renderer/              # React frontend
│   │   ├── App.tsx            # Root: section-state navigation, render cascade
│   │   ├── main.tsx           # React entry
│   │   ├── components/        # All UI components (flat folder, no subfolders)
│   │   ├── hooks/            # useChat.ts, useSettings.ts
│   │   ├── store/            # chatStore.ts, settingsStore.ts (zustand)
│   │   ├── types/            # images.d.ts, index.ts
│   │   ├── styles/
│   │   ├── assets/           # holmesSymbol.png, welcomeText.txt
│   │   └── projectIconRegistry.ts # ~450 FontAwesome icon name → IconDefinition map
│   └── shared/               # Code shared between main/preload/renderer
│       ├── types.ts          # ALL TypeScript types + ElectronAPI interface (single source of truth)
│       ├── assistantIdentity.ts # Configurable assistant name + prompt templating
│       ├── providerConfig.ts # hasProviderCredentials + Ollama default host
│       ├── memoryCatalog.ts  # 17-category, ~160-field memory catalog
│       ├── psychologicalTests.ts # 9 psychological test definitions
│       └── defaultProjects.ts # 5 default projects (Psychology, Health, Finances, Files, Training)
├── docs/
│   ├── memory.md             # Canonical Memory subsystem reference (362 lines)
│   └── ios-app.md            # PLANNED — not yet written
├── healthkit-sidecar/        # Phase 3 Swift package for live HealthKit
│   ├── Package.swift
│   ├── Sources/main.swift
│   ├── Info.plist
│   └── entitlements.plist
├── test-psychological-tests.mjs
├── test-product-search.mjs
├── test-recall.mjs
├── test-memory.mjs
├── test-health.mjs
├── test-health-bootstrap.mjs # ESM resolve hook + electron stub for strip-types
└── src/test/                 # Test helpers (strip-types-resolver.mjs, electron-stub.mjs)
```

## The 4-file IPC sync (CRITICAL — never break)

Adding a new IPC channel requires updating all 4 files in lockstep:

1. `src/main/ipcChannels.ts` — channel string constant
2. `src/main/ipc.ts` — `ipcMain.handle` registration
3. `src/preload/preload.ts` — `contextBridge` binding
4. `src/shared/types.ts` — `ElectronAPI` interface

Reference examples:
- `ipcChannels.ts:1` — `IPC` constant with 78 channels across 12 namespaces
- `ipc.ts:919` — PROJECTS handlers section
- `preload.ts:78` — `projects` namespace binding
- `types.ts:725` — `ElectronAPI` interface

## Database conventions

- Schema lives inline in `src/main/database.ts` `initDatabase()` (line 37). No ORM, no migrations folder — raw SQL via `better-sqlite3` prepared statements.
- **Migrations**: try/catch `ALTER TABLE` blocks (`database.ts:139-194`). When adding a column:
  1. Add to the `CREATE TABLE IF NOT EXISTS` statement (for fresh DBs)
  2. Add a try/catch `ALTER TABLE` block (for existing DBs)
  3. Update the mapper (`mapProject` at `database.ts:1422`, `mapConversation`, etc.)
  4. Update every row type annotation that `SELECT *`s that table (search for `as Array<{` and `as ... | undefined`)
- Mappers convert snake_case DB rows to camelCase TS types.
- CRUD functions: `listX`, `createX`, `updateX`, `deleteX`, `getXById` — see `database.ts:1378-1402` for project analysis updaters.

## Renderer conventions

- **NO router.** Navigation via boolean state flags in `App.tsx` (e.g., `showRecall`, `showProjects`, `showDashboard`, `psychologyProjectId`, `healthProjectId`).
- **Render cascade** at `App.tsx:508`: `psychologyProject` → `showRecall` → `showProductSearch` → `showMemory` → `showProjects` → `showDashboard` → `currentConversationId` → `WelcomeScreen`. When adding a new page, insert into this cascade and clear state in every other handler.
- **State-clearing pattern**: when adding a new page's `setPageId(null)` calls, use `replaceAll` on an existing `set<ExistingPage>Id(null)` line — there are ~10 handlers that clear state, all using 4-space indent.
- **Hand-rolled Tailwind UI.** No MUI, Chakra, shadcn, Radix. Reusable primitives: `PillDropdown.tsx`, `ProjectIcon.tsx`, `IconPicker.tsx`, `MarkdownRenderer.tsx`. Feature pages live in `src/renderer/components/`.
- **Shared IPC subscriptions**: components must NOT call `documents.onState` / `documents.onProgress` directly. Every `DocumentContextPanel` doing so meant one listener per connected project, and 9 projects + Sidebar + DataPage tripped Node's 10-listener `MaxListenersExceededWarning`. Use `useDocumentIndexState()` / `useDocumentIndexProgress()` from `src/renderer/hooks/useDocumentIndex.ts` — one IPC listener per channel app-wide, refcounted, with a deduped initial `getState`. A test fails the build if a component subscribes directly.
- **Styling tokens**: `bg-holmes-bg` (page bg), `bg-holmes-surface` (cards), `text-holmes-primary` / `text-holmes-primary-light` (accent), `border-white/10`, `text-white/40` (secondary text). Per-feature accents: Psychology = violet, Health = emerald.

## Verification commands (run after every change)

```bash
npm run typecheck              # MUST pass (electron + web)
pnpm test                      # Full suite (5 test files)
pnpm test:psychology           # src/shared/psychologicalTests.ts + projectContext.ts
pnpm test:product-search       # src/main/productSearch.ts
pnpm test:recall               # src/main/recall.ts
pnpm test:context-search       # src/main/contextSearch.ts + the FTS index (needs the node ABI — see landmines)
pnpm test:memory               # src/main/memory.ts + memoryCatalog.ts + imessage.ts
pnpm test:citations            # src/main/citations.ts + renderer/components/sourceMarkers.ts
pnpm test:health               # src/main/healthAnalysis.ts + health.ts + healthSummary.ts
pnpm test:health-live          # Phase 3 sidecar integration tests
pnpm test:timeline             # src/shared/timeline.ts + src/main/timeline.ts + dating.ts
pnpm test:call-history         # src/shared/callHistory.ts (provider response parsing)
pnpm test:credit-breaker       # src/shared/creditBreaker.ts (the 402 breaker)
pnpm test:tabloid                 # src/shared/tabloidFeed.ts (Tabloid feed parsers, durations, quota day)
pnpm run lint                  # WILL FAIL — eslint not installed (pre-existing)
```

All tests use `node --experimental-strip-types` (no build step). In `test-document-context.mjs`, `check()` is synchronous and will swallow an async assertion — use `await checkAsync(...)` for anything returning a promise. The `test:health` script requires the bootstrap loader — see landmine #3.

## Known landmines (read before writing code)

### 1. `test:memory` has a PRE-EXISTING failure

Fails at `test-memory.mjs:141` (`parseMemoryExtractionResponse` returning `undefined` instead of `2`). Unrelated to any current work — ignore unless you touched `src/main/memory.ts`. Do NOT try to fix it unless explicitly asked.

### 2. `better-sqlite3` ABI rebuild dance

The native binary must match the runtime ABI:

- **For Electron** (`pnpm dev`): `pnpm rebuild:electron` (compiles for Electron's ABI, currently 140)
- **For Node tests** (`pnpm test`): `pnpm rebuild:node` (compiles for Node's ABI, currently 137 for Node 24)

Symptoms:
- `pnpm dev` fails with `NODE_MODULE_VERSION 137 vs 140` → you rebuilt for tests; run `pnpm rebuild:electron`
- `pnpm test` fails to load `better-sqlite3` → you're on Electron ABI; run `pnpm rebuild:node`

### 3. `test:health` requires a bootstrap loader

`pnpm test:health` script: `node --experimental-strip-types --import ./test-health-bootstrap.mjs test-health.mjs`

The bootstrap (`test-health-bootstrap.mjs` + `src/test/strip-types-resolver.mjs` + `src/test/electron-stub.mjs`) adds `.ts` extension resolution for relative imports and stubs the `electron` module. Required because `provider.ts` (and friends) use extensionless relative imports like `import { readProjectFileContext } from './projectContext'` which Node's `--experimental-strip-types` cannot resolve.

**When writing a new `test-*.mjs`** that imports from `src/main` files with extensionless relative imports: use the same `--import ./test-health-bootstrap.mjs` flag.

The older tests (`test-psychological-tests.mjs`, `test-product-search.mjs`, `test-recall.mjs`, `test-memory.mjs`) do NOT need the bootstrap because they only import from leaf files with type-only imports (which get stripped at runtime).

### 4. Swift sidecar build + HealthKit signing

**Build:** `pnpm build:sidecar` tries SwiftPM first, falls back to direct `swiftc` (SwiftPM is broken on some macOS Tahoe CLT installations — `PackageDescription` linker fails with `Undefined symbols for architecture x86_64`).

**HealthKit access limitation:** The sidecar uses HealthKit, which requires the `com.apple.developer.healthkit` entitlement. Ad-hoc signing (`codesign -s -`) cannot authorize HealthKit — macOS `amfid` SIGKILL's the binary (exit 137) when it tries to access HealthKit with an ad-hoc signed entitlement. The build script signs WITHOUT entitlements so the binary runs (reports `{"error":"HealthKit not available"}`), but live HealthKit access requires:
- A paid Apple Developer certificate, OR
- Xcode + a free Apple ID for development signing

Without proper signing, the Health page shows "HealthKit unavailable" and guides users to the Apple Health XML export alternative (Phase 2 ingestion).

**macOS Tahoe CLT module.modulemap issue (one-time fix):** If `swiftc` fails with `redefinition of module 'SwiftBridging'`, remove the stale duplicate: `sudo rm /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap`

### 5. AGENTS must never break redaction

- `redactMemoryContent` (`src/main/memory.ts:36`) strips API keys (`sk-`, `pk-`, `ghp-`, `xox-`, AWS keys), passwords in key-value pairs, SSNs, card numbers.
- `redactHealthContent` (`src/main/health.ts:17`) extends this with MRN, NPI, DOB, Epic/MyChart account numbers, US phone numbers.
- **Any new feature that sends user data to the AI provider MUST route through redaction first.**
- Sensitive memory categories (health, financial, contact, location, relationships) are gated behind `includeSensitive` flag in `MemoryExtractionRequest`. Never bypass.

### 6. A raw NUL byte makes a source file invisible to `grep`

`src/main/documentContext.ts` briefly contained a literal NUL (not the `\u0000` escape) as a composite-key separator. `file` then reports the source as `data`, and `grep`/`ripgrep` **silently skip it** — searches return nothing with exit 1, which reads exactly like "the code isn't there". This nearly caused a correct implementation to be "restored" over the top of itself.

If a `grep` you expect to match comes back empty, run `file <path>` before concluding anything. Write NUL separators as `\u0000`; the runtime value is identical (`charCodeAt` is still 0) and the file stays text.

### 7. `export.xml` exclusion

Apple Health's `export.xml` can be 100MB–2GB. `collectProjectTextFiles` (`src/main/projectContext.ts`) skips files named `export.xml` and any file >10MB. Do NOT remove this exclusion or context building will OOM.

### 8. Never hand-roll a provider endpoint again

Nine modules used to carry private copies of `getBaseUrl`/`getApiKey`/`getHeaders`. They all now import `src/main/providerEndpoint.ts`. A new copy is a bug: adding a provider (Ollama did this) would leave that subsystem calling OpenRouter while chat talks to the new one.

Likewise, **never gate a feature on `!config.openrouterApiKey && !config.customApiKey`** — Ollama is keyless, so that check disables every background feature for local users. Use `hasProviderCredentials(config)` (`src/shared/providerConfig.ts`, importable from renderer and main).

### 9. Leaf modules loaded by non-bootstrap tests must not gain runtime imports

`memory.ts`, `productSearch.ts`, and `psychologicalTests.ts` are imported by tests that run **without** `--import ./test-health-bootstrap.mjs`, so extensionless relative imports there fail to resolve at runtime. This is why `buildMemoryExtractionPrompt` takes `options.assistantName` instead of importing `getAssistantName()`. Pass values in; don't add the import.

### 9b. TypeScript parameter properties break the `strip-types` tests

`node --experimental-strip-types` rejects `constructor(private readonly x: T)`.
Any module a test loads must use explicit field declarations instead — this bit
`wsServer.ts`, which the remote test loads.

### 10. A CSS `mask-image` must be imported with `?inline`

Chromium enforces CORS on CSS mask images, and a packaged build serves the renderer through `loadFile` — i.e. from `file://`, whose origin is `null`. Every `file://` mask URL is therefore blocked and the element renders as **nothing**, while dev looks perfect because the vite dev server is an `http` origin. `data:` URLs are exempt, so any asset used as a mask must be imported `?inline` (see `AnimatedMark.tsx`); `*?inline` is declared in `src/renderer/types/images.d.ts`. Ordinary `<img>`/`background-image` are unaffected — this bites masks only.

### 11. Provider calls are logged in the fetch layer — do not log them per call site

`src/main/callLog.ts` wraps `globalThis.fetch` once (installed from `main.ts` before
`registerIpcHandlers()`) and records every request whose URL sits under
`getBaseUrl(config)`. A new provider call site therefore needs no logging code, and
adding some would double-count.

Two consequences to respect:

- **The wrapper must stay transparent.** It hands back a `Response` rebuilt around one
  half of `body.tee()`; teeing rather than buffering is what keeps a streamed chat
  streaming. Never make the logger `await` the body before returning.
- **Never fetch from inside the logger.** Pricing uses `peekPriceTable()`
  (`modelPricing.ts`), not `getPriceTable()`: the latter fetches `/models`, which is
  itself a logged provider call, which would price itself, which would fetch again.
  Rows logged with no price are backfilled by `backfillProviderCallCosts()` in `ipc.ts`
  when the page loads.

The feature label ("timeline:rebuild", "timer:people") comes from an `AsyncLocalStorage`
scope: `installProviderCallLog` wraps `ipcMain.handle` so every channel labels itself, and
`main.ts`'s `tick()` helper labels the background timers. A call made outside both shows
as "background".

### 12. The fetch layer can refuse to make a call, and there are two reasons it does

Both live in the same wrapper as the logging, for the same reason: eighteen call
sites cannot each be trusted to remember.

- **No credit.** `src/shared/creditBreaker.ts` counts consecutive credit refusals
  (402, plus the narrow body match in `isCreditExhaustedResponse` for endpoints
  that report it as 400/403/429). Three in a row and every billed call fails
  locally until one probe per 10-minute cooldown, a successful call, a credential
  change (`setProvider`), or the user's "Try again" in the banner clears it. Only
  **billed** calls are gated: `/models` is a GET that works on an empty account,
  so blocking it would break Settings, and a successful one must never be read as
  proof the balance is back. The background timers gate on `canCallProvider()`
  rather than `hasProviderCredentials()` so a pass with nothing but model calls in
  it does not start — a key with no credit behind it is not a usable key. That
  gate uses the read-only `isProbeDue`, never `requestCall`, so asking whether a
  pass is worth starting does not spend the one call that pass is allowed.
- **The user paused automation.** `settings.isAutomationPaused()`, set from the
  Call History page. `main.ts`'s `tick()` refuses to run any background pass, and
  the fetch layer refuses any call whose feature label starts with `timer:` —
  which is what catches work already in flight when the switch was flipped.
  User-initiated calls are never affected: the pause is about automation, not
  about the app.

## Feature subsystems (where to read for each)

| Subsystem | Primary files | Notes |
|---|---|---|
| Chat (streaming, branching) | `src/main/provider.ts:136` (`streamChatCompletion`), `src/main/ipc.ts:399` (CHAT handlers) | Single global `AbortController` (one stream at a time) |
| Memory (17 categories) | `src/shared/memoryCatalog.ts`, `src/main/memory.ts`, `memorySummary.ts` | `docs/memory.md` is the canonical reference |
| Memory modes (Detailed/Abridged/Anonymous) | `src/main/memoryContext.ts:90` (`buildMemoryContext`) | Abridged rolling summary: 24h + hash-change gate (`memorySummary.ts`) |
| Recall (Spotlight + conversations) | `src/main/recall.ts` | Mac-only (Spotlight); iOS will proxy to server |
| Context search (the generated corpus) | `src/main/contextSearch.ts`, `*_fts` tables + `searchDocument*Contexts` in `database.ts`, `search_contexts`/`get_context` in `tools.ts`, `rankRecallContexts` in `recall.ts` | FTS5 over `document_file_contexts` + `document_folder_contexts` (external content, trigger-maintained, backfilled once on upgrade); small tables scanned. One JS scorer ranks every level so bm25 and hand scores are never mixed. Hidden/library/video sources and failure sentinels are excluded |
| Projects + Psychology | `src/main/projectContext.ts:160` (`buildPsychologyProjectContext`), `src/renderer/components/PsychologyPage.tsx` | `projects.analysis` column stores `PsychologyAnalysis` JSON |
| Health Phase 1 (analysis) | `src/main/healthAnalysis.ts`, `src/main/provider.ts:819` (`analyzeHealth`) | Hybrid `HealthAnalysis` type |
| Health Phase 2 (ingestion) | `src/main/health.ts`, `healthSummary.ts` | 3 parsers: Apple Health XML (saxes), MyChart CCDA (fast-xml-parser), Bloodwork PDF (pdfjs-dist) |
| Health Phase 3 (live HealthKit) | `src/main/healthLive.ts`, `healthkit-sidecar/` | Swift sidecar binary, spawned via `child_process.execFile` |
| Timeline (dated life record) | `src/shared/timeline.ts`, `src/main/timeline.ts`, `src/main/dating.ts`, `src/renderer/components/TimelinePage.tsx` | Every generated context emits a `TIMELINE:` block; `timeline.ts` harvests, merges and stores them |
| Context version archive | `src/shared/contextVersions.ts`, `archiveContextVersion` in `database.ts` | Regeneration versions a context instead of overwriting it; every version lands on the timeline |
| Model tiers | `src/main/settings.ts` (`getTextModel`/`getVisionModel`), `SettingsPanel.tsx` | Budget/Mid/Frontier, each holding a text + a vision model. Replaced `systemModel` |
| Provider endpoints | `src/main/providerEndpoint.ts`, `src/shared/providerConfig.ts` | One resolver for OpenRouter/custom/Ollama. Ollama is keyless and gets no `reasoning` param |
| Assistant identity | `src/shared/assistantIdentity.ts`, `prompts/stable.txt`, `SettingsPanel.tsx` | User-set name + icon. `{{ASSISTANT_NAME}}` in the prompt template; icon reuses `IconPicker` |
| Welcome greetings | `src/renderer/welcomeLines.ts`, `SettingsPanel.tsx` | Bundled defaults; `settings.welcomeLines` overrides. Empty list means "use the defaults" |
| Conversation titles | `startAutoTitle` in `ipc.ts`, `generateConversationTitle` in `provider.ts` | Truncated title written synchronously, model title replaces it and broadcasts `CONVERSATIONS.UPDATED` |
| Photo indexing (VLM) | `src/main/photoContext.ts`, image branch in `documentContext.ts` | Images summarized by the tier's vision model in the per-file phase; folder/root synthesis unchanged |
| Index cost estimate | `src/main/indexEstimate.ts`, `src/main/modelPricing.ts`, `IndexEstimateBar.tsx` | Pre-flight token/cost/duration projection per run, priced from live OpenRouter pricing |
| Call history (every provider call) | `src/main/callLog.ts`, `src/shared/callHistory.ts`, `CallHistoryPage.tsx`, `provider_calls` table | Recorded by wrapping `fetch`, NOT per call site. Feature label comes from the IPC channel via `AsyncLocalStorage` |
| Tabloid feed (curated video) | `src/shared/tabloidFeed.ts` (parsers, leaf), `src/main/tabloidFeed.ts` (orchestrator), `tabloidPlanner.ts`, `tabloidRetrieval.ts`, `tabloidCurator.ts`, `youtubeSearch.ts`, `youtubeTranscript.ts`, `tabloidAnalysis.ts`, `tabloidArchive.ts`, `tabloidMedia.ts`, `tabloidProtocol.ts`, `tabloidReactions.ts`, `tabloidRuns.ts`, `TabloidPage.tsx` | Plan → retrieve → curate → review. Two mid-tier calls sandwiching **real** YouTube retrieval, then a transcript + fact/bias pass over the picks. Seven `tabloid_*` tables. Thumbnails via `holmes-media://`; playback via a `youtube-nocookie` iframe driven by raw postMessage |
| Tabloid transcripts + claim review | `src/main/youtubeTranscript.ts`, `tabloidAnalysis.ts`, `parseVtt`/`parseAnalysisResponse` in the leaf | Captions come from **yt-dlp**, because `captions.download` needs OAuth as the video's owner. **Pin `--sub-langs en-orig,en`** — a wildcard matches ~32 machine translations and the burst returns 429. YouTube's rolling caption format repeats every line 2-3x; `parseVtt` de-dupes per LINE (not per cue) and keeps the earliest timestamp |
| Product search | `src/main/productSearch.ts` | Server-side AI research |
| Claude import | `src/main/claudeImport.ts` | Multi-file archive ingest with progress events |
| iMessage relationship analysis | `src/main/imessage.ts`, `src/main/provider.ts:893` (`analyzeRelationships`) | Metadata only — no message bodies |
| Settings | `src/main/settings.ts` (electron-store) | `healthAnalysisEnabled`, `healthLiveSyncEnabled` flags gate AI calls |
| Remote access (iOS client) | `src/shared/remote.ts`, `src/main/remoteServer.ts`, `remoteCrypto.ts`, `remoteBridge.ts`, `wsServer.ts`, `mobile/` | `docs/ios-app.md` is the canonical reference. Channel access is **default-deny** and **per-device**: `MEDIA_CALLABLE_CHANNELS` ⊂ `OWNER_CALLABLE_CHANNELS`, chosen by `RemoteDevice.scope` |
| Guest redaction (media scope) | `src/shared/books.ts` (`redactBookForGuest`, `guestReadingState`, `redactLibraryBookForGuest`, `redactAudiobookForGuest`), Library handlers in `ipc.ts` | Pure helpers, applied **only** when `event.remote?.scope === 'media'`. A renderer or `owner` caller is unchanged |
| Bulk media over HTTP | `src/shared/remoteMedia.ts` (pure), `src/main/remoteMedia.ts`, `wsServer.ts` `onRequest` | Range-served from disk on the remote port. Addressed by **opaque id**, authenticated per request by an HMAC token bound to id + device + scope + expiry. Direct connections only |

## File map by responsibility

### `src/shared/` — the contract

- `types.ts` — ALL TypeScript types + `ElectronAPI` interface (single source of truth)
- `contextVersions.ts` — the context-archive contract: `isFailedContext` (sentinels that must not be archived or cached), `deriveContextShort`, `contextVersionTitle`
- `timeline.ts` — the dating/timeline contract: `timelinePromptSection` (the prompt every context generator appends), the tolerant `parseTimelineBlock` / `parseDateSpec` parsers, and the normalization + formatting helpers
- `memoryCatalog.ts` — 17 categories, ~160 fields, exports `MEMORY_CATALOG`, `MEMORY_CATEGORY_KEYS`, `MEMORY_FIELDS`
- `psychologicalTests.ts` — 9 tests: `mini_ipip_20`, `gad_7`, `phq_9`, `rosenberg_self_esteem`, `who_5`, `pss_10`, `pc_ptsd_5`, `audit_c`, `asrs_6`
- `defaultProjects.ts` — Psychology, Health, Finances, Files, Training
- `callHistory.ts` — reading a provider response back into text/model/usage (`parseProviderResponse`, `elideDataUrls`, cost formatting). Import-free leaf so `test-call-history.mjs` can load it.
- `remoteMedia.ts` — the bulk-media contract: `RemoteMediaKind`, the per-scope kind sets, the canonical token payload encoder, `parseRemoteMediaPathname`, `parseByteRange` and the header formatters. Import-free leaf, so `test-remote.mjs` can drive the range and token logic without a socket
- `books.ts` — the Library contract, plus the guest redaction helpers. Import-free leaf
- `creditBreaker.ts` — the 402 state machine (`createCreditBreaker`, `isCreditExhaustedResponse`, `CreditBreakerState`). Import-free leaf, `now` passed in rather than read, so `test-credit-breaker.mjs` can drive it without fake timers.

### `src/main/` — Electron main process

- `main.ts` — app lifecycle, background timers (hourly memory summary, 30-min idle conversation memory extraction, hourly health summary, hourly document index). The document timer passes `skipImages: true` — see "Photo indexing".
- `database.ts` — schema, migrations, all CRUD (~1450 lines). Key exports: `listConversations`, `createConversation`, `listProjects`, `updateProjectAnalysis`, `updateProjectHealthAnalysis`, `listMemoryFields`, `createHealthRecord`, `createHealthObservation`, `getHealthObservationsHash`, etc.
- `ipc.ts` — all 78 `ipcMain.handle` registrations across 12 namespaces (~1250 lines)
- `ipcChannels.ts` — channel string constants (single source of truth)
- `settings.ts` — `electron-store` backed. `AppSettings` includes `provider`, `theme`, `defaultModel`, `defaultEffort`, `modelTiers`, `defaultTier`, `memoryAutoExtractionEnabled`, `healthAnalysisEnabled`, `healthLiveSyncEnabled`, `fileAccessScope`, `requestsPerMinute`. **There is no `systemModel`** — it was replaced by tiers (see "Model tiers" below).
- `provider.ts` — `fetch`-based API calls. Key exports: `streamChatCompletion` (`:136`), `listModels` (`:283`), `analyzePsychology` (`:758`), `analyzeHealth` (`:819`), `analyzeRelationships` (`:893`), `extractMemoryCandidates` (`:548`), `researchProducts` (`:612`)
- `tools.ts` — tool definitions + executor for model tool-calling
- `fileScope.ts` — `assertPathAllowed`, `getResolvedRoots`, `isPathEverywhere`
- `projectContext.ts` — `collectProjectTextFiles` (takes an extension set + `{maxFiles, maxEntries}` limits), `readProjectFileContext`, `buildPsychologyProjectContext`, `buildHealthProjectContext`, `IMAGE_EXTENSIONS` / `INDEXABLE_EXTENSIONS`, `isImageExtension`, `isDerivativeDirectory`
- `photoContext.ts` — `encodeImageForVlm` (downscale + JPEG), `readImageMetadata` / `parseExifDate` (via `sips -g all`), `needsSipsDecode`, `estimateImageTokens`
- `modelPricing.ts` — live OpenRouter price table (cached 10 min), `priceCall`; unpriced models are absent from the table on purpose
- `callLog.ts` — `installProviderCallLog()` (wraps `fetch` + `ipcMain.handle`), `withProviderCallFeature`. Writes the `provider_calls` rows behind the Call History page; see landmine 11.
- `providerCredit.ts` — the process-wide credit breaker (`requestProviderCall`, `noteProviderResponse`, `canCallProvider`, `clearProviderCreditBlock`); decisions live in the leaf `src/shared/creditBreaker.ts`, tested by `test-credit-breaker.mjs`. See landmine 12.
- `remoteMedia.ts` — bulk media: `startRemoteMedia`/`stopRemoteMedia` (the per-run HMAC key), `mintMediaTicket`, `verifyMediaToken`, and `handleRemoteMediaRequest`, which is what `wsServer.ts`'s `onRequest` calls. Ids resolve through the database and are re-checked against the source roots and `fileScope`
- `indexEstimate.ts` — `computeIndexEstimate` (pure, testable), `estimateProjectIndex`, `combineEstimates`, `countFolders`
- `rateLimit.ts` — `createRateLimiter` (sliding window), `estimateSecondsForCalls`, `DEFAULT_REQUESTS_PER_MINUTE`
- Memory subsystem: `memory.ts`, `memoryContext.ts`, `memorySources.ts`, `memorySummary.ts`, `memoryQueries.ts`, `conversationMemory.ts`
- Recall: `recall.ts`
- Health: `health.ts`, `healthAnalysis.ts`, `healthSummary.ts`, `healthLive.ts`
- Timeline: `timeline.ts` (harvest → merge → store → era narrative, plus `buildTimelineContext` for chat), `dating.ts` (date evidence from file content, file names, and mtime)
- Other feature modules: `productSearch.ts`, `claudeImport.ts`, `imessage.ts`, `psychologicalTestFiles.ts`

### `src/preload/` — contextBridge

- `preload.ts` — single file. `contextBridge.exposeInMainWorld('electronAPI', api)`. The `api` object mirrors `ElectronAPI` in `types.ts`.

### `src/renderer/` — React

- `App.tsx` — root component, section-state navigation, render cascade at `:508`
- `components/` — flat folder, all UI components. Reusable primitives: `PillDropdown.tsx`, `ProjectIcon.tsx`, `IconPicker.tsx`, `MarkdownRenderer.tsx`. Feature pages: `Dashboard.tsx`, `DataPage.tsx`, `ProjectsPage.tsx`, `RecallPage.tsx`, `MemoryPage.tsx`, `ProductSearchPage.tsx`, `PsychologyPage.tsx`, `HealthPage.tsx`, `HealthSourcesPanel.tsx`, `SettingsPanel.tsx`, `WelcomeScreen.tsx`, `ChatView.tsx`, `HealthWidget.tsx`, `PsychologyWidget.tsx`
- Data page parts: `DataSourceRow.tsx` (one row), `ProjectVisibilityMenu.tsx` (header eye), `BulkIndexDialog.tsx`, `SourceDialog.tsx` (create/rename + icon + colour)
- `hooks/` — `useChat.ts`, `useSettings.ts`
- `store/` — `chatStore.ts`, `settingsStore.ts` (zustand)
- `projectIconRegistry.ts` — ~450 FontAwesome icon name → `IconDefinition` map

## Key interfaces to know

- `Project` (`types.ts:495`) — has `analysis`, `relationshipAnalysis`, `healthAnalysis` fields (all nullable)
- `HealthAnalysis` (`types.ts:395`) — `generatedAt`, `domainScores`, `regimen`, `interactions`, `openThreads`, `recommendedLabs`, `recentObservations`, `summary`
- `PsychologyAnalysis` (`types.ts:317`) — `bigFive`, `emotionalIntelligence`, `cognitiveStyle`, `wellBeing`, `summary`
- `AppSettings` (`types.ts:89`) — `provider`, `theme`, `defaultModel`, `defaultEffort`, `modelTiers`, `defaultTier`, `memoryAutoExtractionEnabled`, `healthAnalysisEnabled`, `healthLiveSyncEnabled`, `fileAccessScope`
- `ModelTierConfig` (`types.ts:91`) — `Record<'budget'|'mid'|'frontier', { textModel, visionModel }>`
- `IndexEstimate` (`types.ts:955`) — pre-flight cost projection for one index run
- `ElectronAPI` (`types.ts:725`) — the entire preload bridge contract. Namespaces: `conversations`, `chat`, `settings`, `models`, `productSearch`, `recall`, `memory`, `projects`, `app`, `importClaude`, `fs`, `health`

## Cross-references

- `docs/memory.md` — canonical Memory subsystem reference (362 lines). Read this for any Memory-related question.
- `docs/ios-app.md` — PLANNED, not yet written. Will document the iOS app architecture, sync protocol, developer setup, user guide, and roadmap.
- `healthkit-sidecar/` — Phase 3 Swift package. External protocol details live in OpenCircuit's repo (`https://github.com/perezjuanj/OpenCircuit`).
- The Comprehensive Health Overview document at `/Volumes/andrews-hdd/archives/claudeData/projects/019f0025-0267-7197-afe4-f44cda093f4f.json` is **external reference material**, NOT shipped in the repo. Used as a schema reference for the `HealthAnalysis` shape.

## Model tiers (there is no `systemModel`)

Every system feature resolves its model through a tier, not a flat setting:

- `ModelTier = 'budget' | 'mid' | 'frontier'`; each tier holds `{ textModel, visionModel }` (`AppSettings.modelTiers`).
- `settings.getTextModel(tier?)` / `settings.getVisionModel(tier?)` / `settings.getIndexVisionModel(tier?)` are the ONLY resolvers. With no argument they use `AppSettings.defaultTier`. An unfilled tier falls back to **mid**, then to `DEFAULT_SYSTEM_MODEL` — selecting an unconfigured tier degrades, it never fails the run.
- Empty `visionModel` is the meaningful "not configured" sentinel **for chat attachments only** — `resolveVisionModel` surfaces `NO_VISION_MODEL_ERROR` rather than silently sending images to a text-only model.
- **Indexing does not use that sentinel — it uses `getIndexVisionModel`, which falls through to `DEFAULT_VISION_MODEL`.** A connected source is mixed by nature, so a run must cover both halves: documents via the text model and photos via a vision model. With the bare sentinel, a user who had only ever set a text model got their documents indexed and every photo written as `Context generation failed … no vision model configured for this tier` — which reads as "photos aren't supported" rather than "finish your settings". The four indexing/estimate call sites (`ipc.ts` GENERATE / GENERATE_ALL / ESTIMATE / ESTIMATE_ALL) all resolve through it, so the estimate prices the same two halves the run performs.
- A one-time migration seeds `modelTiers.mid` from the legacy `systemModel` / `visionModel`, so background work keeps running on the model it already used. **Do not reintroduce `systemModel`.**
- An index run takes an explicit tier, so the tier fixes both what the run costs and how good it is.

## Photo indexing and the cost estimate

- `INDEXABLE_EXTENSIONS` = documents + images. The per-file phase branches on `isImageExtension`: images go to `indexImageFile` (vision model), everything else to the existing text path. **Folder, root and user super-contexts are unchanged** — they synthesize child text either way.
- `photoContext.ts` downscales every image to `PHOTO_MAX_EDGE` (768px) before encoding. This is the single biggest cost lever: a 4048x3036 original is ~16,000 image tokens, the same photo at 768px is ~590. It also makes per-image cost near-constant, which is what lets the estimate be accurate without opening every file. JPEG/PNG decode in-process via `nativeImage`; HEIC/HEIF/TIFF via `sips` (no new dependency).
- Image cache identity is a **stat hash** (path + size + mtime + max edge), not a content hash — reading 40k full-size photos just to detect cache hits would cost minutes of disk I/O per run. The cache is checked *before* any decode or API call.
- EXIF `creation` is a date stated inside the data, so it outranks file name and mtime in the dating chain. VLM output is redacted through `redactMemoryContent` before storage (landmine #5 — a vision model can transcribe text out of a photo).
- `.photoslibrary` bundles, `thumbs/` and `backups/` are excluded from the walk (`isDerivativeDirectory`): the bundle's hex UUID buckets would both double-count photos and produce folder super-contexts synthesized from 16 random shuffles of the user's life.
- **Cost is never fabricated.** `modelPricing.ts` omits unpriced models from the table entirely, so a custom endpoint that reports no pricing yields `costUsd: null` ("unknown"), never `$0`. Any unpriceable leg makes the whole total unknown rather than partial. `IndexEstimate` subtracts cache hits, so re-estimating an unchanged tree quotes ~zero.
- **The estimate is user-triggered, never automatic.** Estimating walks the entire directory; a Data page with nine connected projects firing scans on mount is tens of thousands of `statSync` calls on possibly external storage. `IndexEstimateBar` has an explicit "Estimate cost" button, and changing tier clears the stored estimate rather than showing a stale price for the wrong models.
- **An indexing run's watchdog measures silence, not duration.** Run length scales with the corpus — 236 documents took 55 minutes — so the old fixed caps (20 min per project, 45 min for a batch) aborted every real run before the folder-synthesis phase, which only starts once every file is done. `createIdleWatchdog` in `documentIndexRuns.ts` aborts only after `INDEX_IDLE_TIMEOUT_MINUTES` with no progress event, and `sendProgress` pings it; `fired()` distinguishes a stall from a user pause/stop so the message never blames the wrong thing. `fetch` has no default timeout, so the idle watchdog is the only thing standing between a dead socket and a run that hangs forever. The user-super-context refresh keeps a fixed cap on purpose: it is one call and emits no progress.
- **"Empty or unreadable document" means the FILE could not be read — never that a call came back empty.** The two were conflated, so 51 of 74 images in one project were recorded as unreadable when every one of them decoded fine at 768×768 and it was the vision model returning nothing. An empty response is `Context generation failed for …`, which names the real cause; the unreadable sentinel is reserved for `encodeImageForVlm` returning null or a document that extracted no text. Both are `isFailedContext` prefixes, so either way the next run retries.
- **An output cap a model exhausts reasoning returns as empty content.** This is the same failure as the timeline years, and at `maxTokens: 500` it hit most photo calls. `IMAGE_MAX_OUTPUT_TOKENS` is the headroom, not the answer length — stored text is capped separately by `MAX_IMAGE_CONTEXT_CHARS`, and output is billed per token produced, so headroom buys reliability rather than cost.
- **PDFs must be read through `loadPdfjs()` (`src/main/pdfjs.ts`).** `pdfjs-dist`'s default entry is the browser build and throws `ReferenceError: DOMMatrix is not defined` at document-open time in the Electron main process; the `legacy` build ships the shims for this environment. Importing the package directly is how **every PDF in the app** silently produced nothing — health records sat at `pending` with no `parse_error`, and the document indexer's per-file `catch` skipped them with no row at all. There is a test asserting no main-process file imports `pdfjs-dist` directly.
- **An ingest that throws must land on its record.** `ingestBloodworkPdf` marks the record `failed` with the message rather than leaving it `pending`; the scan's `errors[]` array is not a substitute, because nothing displays it and the row outlives the run.
- **Every folder-backed subsystem reads `database.listProjectSourcePaths`.** It is the single statement of the legacy fallback (a project carrying a `path` with no `project_sources` row still counts as source #1). Health ingestion previously read `project.path` directly, so a second connected folder was invisible to it while document indexing saw both; do not reintroduce a direct `project.path` read.
- **Health ingests from its connected folders, not from a file picker.** `scanHealthDirectory` walks every source path and is identity-gated by `healthFileIdentity` (realpath + size + mtime, stored on `health_records.identity_hash`) — stat-based because an Apple Health export is hundreds of megabytes and hashing it hourly is not an option. The identity resolves symlinks first: a folder scan yields realpath'd files while the picker yields whatever the user navigated to, and on macOS those differ under `/var`, which would ingest the same file twice. The hourly pass runs with `automatic: true`, which skips files that previously FAILED — a bloodwork PDF that cannot be parsed would otherwise be re-sent to the model every hour for the same answer — while an explicit "Scan now" retries them. `DirectoryScanResult.skipped` counts errors only; unchanged files are reported separately as `unchanged`.
- **Pruning requires a COMPLETE scan.** `pruneDocument{File,Folder}ContextsUnder` reads "the scan did not return this file" as "the file is gone", so it may only run when `scanProjectTextFiles` reports `complete` (root readable, no unreadable entries, not stopped at a cap). A source on an external drive scans as zero files the moment the drive sleeps or unmounts, and pruning on that evidence deleted an entire overnight indexing run — the contexts survived only in `context_versions`, and the next run re-paid for every one of them. An unreadable source root is skipped with its cache intact and, when no source could be read, surfaces as a thrown error rather than a silent no-op; the run also leaves `document_summary_meta` alone so a partial tree never becomes the signature baseline.
- **The hourly timer passes `skipImages: true`.** Photo indexing is priced, user-authorized work — a background timer must never begin it. The skip branch preserves an already-generated photo context *and re-registers its hash* so `pruneDocumentFileContexts` will not delete it, but registers nothing for an un-indexed photo so its parent folder still resynthesizes once it is indexed.
- The estimator must resolve its base through `fs.realpathSync` (matching `documentContext.resolveBase`). `collectProjectTextFiles` returns realpath'd files, so a symlinked root — every macOS tmpdir, via `/var` → `/private/var` — otherwise matches no folders and silently under-counts the run.
- Use `database.listIndexedFilePaths` (path-only SELECT) for the cache check, never `listDocumentFileContexts`: the latter pulls every context blob, which at photo-library scale is tens of MB of strings loaded purely to build a `Set` of paths.

## Multiple sources per project

- A project connects N directories via `project_sources` (`listProjectSources` / `addProjectSource` / `removeProjectSource`). **`projects.path` is not gone** — it mirrors the FIRST source, because Health, Activity, Psychology, memory evidence and psychological test-file writing all still read it. Keep it in sync (`syncPrimaryProjectPath`); do not let it drift from the head of the list.
- `createProject`/`updateProject` register a supplied `path` as a source themselves — the init-time backfill only covers projects that already existed, so without this a project created at runtime would show a directory it never indexes. `effectiveSources()` is the belt-and-braces fallback: a legacy `path` with no source row is still treated as source #1.
- `generateDocumentContexts` is an orchestrator; `indexProjectSource` does one directory. `options.sourcePath` narrows a run to a single source, `options.force` ignores every cache layer.
- **Pruning must be scoped** (`pruneDocumentFileContextsUnder` / `pruneDocumentFolderContextsUnder`). An unscoped prune after indexing one source deletes every OTHER source's rows, because they are legitimately absent from that run's keep-list.
- Removing a source deletes the contexts derived from it; leaving them would keep a disconnected directory feeding the project's synthesis forever.
- Explicit `project.files` entries belong to the project, not to any one source, so they ride along with the first source only and are never double-indexed.
- **The project-level synthesis**: with >1 source the source roots are combined into one project super-context (stored on `document_summary`); with exactly one source that source's root IS the project context, so **no extra LLM call**. Dropping back to one source clears the stale combined synthesis.
- `listProjectRootContexts` must return **exactly one row per project**. It selects `WHERE relative_path = '.'`, which is one row per source — a three-source project would otherwise outvote the rest of the profile three to one in the user super-context.

## The Data page is a list, not a stack of cards

- One compact row per source (`DataSourceRow.tsx`): status dot, icon, name, path, counts, then Index / Expand / Hide-or-Delete and a drag grip. Everything richer — directory management, tier + estimate, super-contexts, provenance, version history, and the Activity/Health ingest panels — lives in the row's expansion, not on the page.
- The unified user super-context lives at the top of the **Life Dashboard**, not on this page: the Data page is about sources, the Dashboard is about the life they add up to.
- Counts come from `documents:get-summaries` (`listProjectIndexSummaries`), which is `COUNT(*)` per project plus an `existsSync` per source. **Never render the list off `documents:get-tree`** — that materializes every stored context, i.e. thousands of rows of prose to print "326 files".
- Status dot: dim = no path, green = a path is attached but the source is **not fully indexed**, teal (the app accent) = fully indexed, red = a source directory is unreachable or the last index attempt failed. "Fully indexed" is `ProjectIndexSummary.fullyIndexed`: every connected source has its own root synthesis AND `document_summary.file_count` (written only by a run that finished over every source) still equals the current file-context count. A half-finished or interrupted run stays green — the accent colour never claims work that is outstanding.
- There is **no `Data` source**: the page is the view of every source, so a row for itself was redundant. The Dashboard's Data card is a plain card that calls `onOpenData()`, and `App.tsx` navigates with a `showData` boolean rather than a project id.
- **`File System`** (formerly `Files`) is not a folder the user picked — it stands for Holmes' file access scope. Its row shows `/` when the scope is `everywhere` (or the custom roots otherwise), its index button is disabled (it grants access, it is not a corpus), and its expansion carries `FileScopePanel`, which is the **only** place the scope is edited — Settings just points at it. The Dashboard skips this project entirely.
- `projects.visible` and `projects.sort_order` back the eye toggle and the drag order. **Hidden means hidden everywhere**: skipped by `GENERATE_ALL`/`ESTIMATE_ALL` and by the hourly `documentContextTimer`, and dropped from `ContextDropdown` and the Dashboard. The header eye menu is the only place a hidden source can be brought back.
- The list is two groups: the built-in life sources first, the user's personal projects below a divider. Reordering is confined to a group, and `persistOrder` always writes life ids, then personal ids, then hidden ones.
- Reordering is **pointer-driven, not HTML5 drag-and-drop** (`onDragHandleDown` → window pointermove/pointerup): the dragged row tracks the pointer with no transition while every row between its old and new index eases aside by exactly the dragged row's height plus the 8px gap. Row rects are measured once at drag start, and pointer moves are coalesced to one state update per animation frame.
- Row buttons: **play expands** the source, the document-search glyph **runs the index**. (They read the other way round at first and were swapped deliberately — don't "fix" them back.)
- User-created sources show a trash icon, built-ins (`DEFAULT_PROJECT_NAMES`) show the eye: a default can only be hidden, never deleted from the list.

## Provider rate limiting (the binding constraint at scale)

- OpenRouter enforces a per-key requests-per-minute ceiling (the user's is **20**). `FILE_CONCURRENCY = 4` at ~4s/call attempts ~60 rpm — 3x over — which comes back as 429s, burns the 3-attempt retry budget, and lands failure rows on files that were fine.
- `src/main/rateLimit.ts` paces every outbound indexing call. It is a **sliding window**, not a fixed bucket: a burst at the end of one minute must not be followed immediately by a full burst at the start of the next, which is what trips a rolling-60s enforcer. Waiters are serialized so N concurrent workers cannot all claim the same free slot, and an aborted waiter must not wedge the chain for later callers.
- **Pace every attempt, retries included.** The `acquire` sits inside `callLLM` before the `fetch`, not around the retry loop — a 429 retry that ignores the limit is exactly what turns a transient throttle into a permanent failure row.
- `AppSettings.requestsPerMinute` (default `DEFAULT_REQUESTS_PER_MINUTE = 20`) is the knob. One limiter is shared across a batch so "Index all" respects a single budget rather than resetting the window per project.
- **At scale the limit sets the wall clock, not concurrency.** `estimateSecondsForCalls` returns `max(rate-bound, concurrency-bound)`; 146k calls at 20 rpm is ~5 days no matter how many workers run. Raising `FILE_CONCURRENCY` to "go faster" is a no-op — and above the limit it is actively harmful.
- The limiter governs indexing only. Chat, memory extraction and timeline calls share the same key ungated, so a run at the full allowance will occasionally starve an interactive request; leave headroom if that matters.

## The timeline contract

Every context generator ends its output with a dated `TIMELINE:` block (or, for the JSON analyses, a `timeline` array). The shared contract lives in `src/shared/timeline.ts`:

- Prompt side: text prompts append `timelinePromptSection(maxEntries)`; JSON prompts embed `ANALYSIS_TIMELINE_JSON_FIELD` + `analysisTimelinePromptRule(maxEntries)`.
- Line format: `- <date> | <precision> | <category> | <title> | <detail>`, where `<date>` is `YYYY-MM-DD` / `YYYY-MM` / `YYYY` or a `start..end` range.
- **Dating priority is fixed**: a date stated inside the data, then a date in the file/source name, then the file's mtime (year precision only). Models are told never to invent a date — an undatable fact stays in the prose.
- `precision` may only be widened by a stated value, never sharpened (`coarsestPrecision`). Do not "fix" this: it is what keeps a year-precision fact from being narrated as a specific day.
- `src/main/timeline.ts` harvests these blocks from every file/folder/user context, health/activity/finances analysis and the memory summary, merges duplicates (exact key, then coarse-subsumed-by-precise), and stores them in `timeline_events`. Hand-added (`source_type = 'manual'`) rows survive every rebuild.
- **The chat block is carried by per-year super-contexts, not by the raw events.** The record outgrows any prompt budget — 5,300 events against a budget that fits about sixty lines — and rendering it oldest-first meant chat saw 1921–2009 and had no idea the later years existed. `generateYearContexts` compresses each calendar year into prose (`timeline_year_contexts`, hash-gated per year, so a rebuild that only touched 2026 regenerates 2026 alone), and `buildTimelineContext` lays them out as a chronological spine: every year gets at least its one-line summary, the most recent years are expanded to full prose while budget allows, and the raw dated record then fills what remains — **selected newest-first, displayed chronologically**, and labelled with what it left out. A year with fewer than `MIN_EVENTS_FOR_YEAR_SYNTHESIS` events is stored verbatim instead of summarized: it already fits, so a call would only lose information. Year contexts are global, so a project-scoped block leaves them out.
- **A dense year is packed by dropping detail, never by truncating the list** (`packYearEvents`). Cutting the list at a character budget drops the *end* of the year, so December would never reach the model; dropping the `detail` field first keeps every month represented, and if that still overflows the prompt states how many entries are missing so a partial year is never described as a whole one.
- **A failed year synthesis is counted and reported, never just swallowed.** A rebuild harvests and stores events regardless, so it returns success even when every model call failed — which made "all eighteen years errored" look identical to "nothing to do": two seconds, no change, no explanation. `generateYearContexts` returns `failed` + `firstError`, `rebuildTimeline` passes them up as `yearsFailed`/`yearsError`, the Timeline page shows them, and each failure is `console.error`'d. Year calls are also paced through `createRateLimiter(getRequestsPerMinute())` and retried via `synthesizeYearRetrying` — the module previously fired a burst of forty unthrottled calls with no retry, so one 429 silently cost that year until the next rebuild. **Retry BOTH failure modes** (landmine #4's shape): a transient error *and* an empty 200 body. Five of forty-odd years came back empty in one pass, and an empty synthesis throws a message no transient-error pattern matches, so a retry gated on `isTransientError` alone leaves exactly that case fatal. Keep the output cap generous for the same reason — these models spend tokens reasoning before they write, and a cap they exhaust first is returned as empty content.
- **A rebuild's status is broadcast, not sent to the caller.** `timelineRuns.ts` mirrors `documentIndexRuns` (minus pause/resume, which a rebuild does not need — each finished year is already committed): both the IPC handler and the hourly timer report through it, `ipc.ts` broadcasts `TIMELINE.STATE` to every window, and the sidebar subscribes via `useTimelineRunState`. The raw `TIMELINE.PROGRESS` channel still goes only to the window that started the run, which is why it alone could never show a background rebuild. The timer also refuses to start while `isTimelineRunActive()`, so a background pass cannot stack on a user's.
- **The timeline opens on the user's birth year.** `getTimelineBirthYear` reads `identity.birth_date` from Memory; earlier years hold real record (an inherited book's publication date, family papers) but are provenance rather than biography, so the Timeline page folds them behind a control instead of opening the list decades before the person existed. A missing or unparseable birth date yields `null` and every year is shown — never a guess.

## Project scope and index style

- `projects.context_scope` is `life` (default) or `separate`. **Separate means separate everywhere**: excluded from `listProjectRootContexts` (so it never reaches the apex prompt), from `memorySources` evidence and `extractConversationMemory`, from `populateMemoryFromSuperContext`, and from the life timeline. It is still fully indexed, still selectable as chat context, and **keeps its own timeline** — `lifeTimelineFilter()` excludes it, `listTimelineEvents({ projectIds: [id] })` is how its own record is read, and the Timeline page's scope selector does exactly that.
- `projects.index_style` is `behavioral` (default) / `work` / `reference`, and picks the lens for the file, folder, project and conversation prompts. **The behavioral prompts and their version strings are untouched** (`styleVersion` returns the base string for `behavioral`), so this feature costs nothing until a project is actually re-styled. Changing the style changes every prompt version for that project, which is what makes its next run regenerate — that is the mechanism, not a side effect.
- Non-behavioral prompts live in `src/main/indexStyles.ts`; the behavioral ones stay in `documentContext.ts`. `filePromptFor` / `folderPromptFor` / `projectPromptFor` resolve both prompt and version together — never hash one level's content against another level's version.

## Conversations are sources

- A conversation belongs to **every project its context selection stacks** (`conversation_projects`), with `conversations.project_id` mirroring the head the way `projects.path` mirrors source #1. `createConversation` and `updateConversationContext` both re-file through `setConversationProjects`, so pointing a chat at a project moves it out of General and into that project's sidebar list.
- `conversation_contexts` holds one summary per conversation — shared by every project it belongs to, keyed on a hash of the transcript plus the prompt version, so re-indexing an untouched conversation costs nothing. Written by `generateConversationContext`, both inside a project's index run and from the 30-minute idle timer.
- They feed `buildProjectSuperContext` alongside the source roots (capped at `MAX_PROJECT_CONVERSATIONS`, and the first thing the input budget drops). A one-source project with conversations now builds a real combined synthesis instead of passing its lone root through.
- `llmCall.ts` holds the outbound call, spend tracking and retry discipline — extracted from `documentContext.ts` so the conversation indexer can use it without a circular import. `documentContext` re-exports them for existing callers.

## Nothing generated is ever destroyed

- **Contexts are versioned, not overwritten.** Every write path (`upsertDocumentFileContext`, `upsertDocumentFolderContext`, `setUserSuperContext`, `setMemorySummary`, `updateProject{Health,Activity}Analysis`, `updateProjectFinancesSummary`) calls `archiveContextVersion` first, which numbers the new version and stamps `superseded_at` on the previous one in `context_versions`. Identical content is not a new version; failure sentinels (`isFailedContext`) are never archived. **A new context-producing feature must archive through the same choke point.**
- Each archived version becomes a `category = 'record'` timeline event dated to when it was generated, linked back by `context_version_id` so the UI can read the superseded text. `record` is not in `TIMELINE_CATEGORIES` (never offered to a model) and is filtered out of chat context.
- **Rebuilds merge, they do not replace.** `mergeDerivedTimelineEvents` updates rows in place and marks events whose source no longer reports them with `archived_at` instead of deleting them — the context was true when it was written. Re-harvesting clears the flag. Do not reintroduce a delete-then-insert rebuild.
- **When you change any context prompt, bump that module's `PROMPT_VERSION`** — the input-hash gates will otherwise keep serving stale output.

## Every derived node carries its provenance

The context tree is summaries built on summaries; by the user super-context it is layer four. Without stored pointers there is no path from a claim back to the file that supports it, so **every derived node records the exact inputs it was synthesized from** (`provenance_json` on `document_file_contexts`, `document_folder_contexts`, `user_super_context` and `context_versions`; `ContextProvenance` in `types.ts`).

- **Direct edges only, not transitive.** A node lists its own children; the full path to ground truth comes from walking those edges with `resolveProvenanceChain` (`documentContext.ts`, also on the bridge as `documents.getProvenance`). This keeps a root node's provenance the size of its child list rather than its whole subtree. `MAX_PROVENANCE_SOURCES` caps the list for a single flat folder of tens of thousands of photos; children that reached the prompt are recorded first and the remainder is counted in `unrecordedCount`.
- **Recorded at synthesis time, never re-derived.** Files get added, deleted, and dropped by input budgets, so a chain reconstructed later from the current file tree would describe inputs that did not produce the stored text. Each edge carries the child's hash as of that synthesis.
- **A dropped child stays visible.** `packFolderChildren` / `packApex` record `included: false` for children the input char budget excluded, and `truncated` on the parent. Silent omission is how a synthesis comes to look more complete than it is.
- **A leaf's chain terminates in itself** — the file path plus the content hash that produced the summary. `resolveProvenanceChain` records a file node and stops rather than following the self-reference.
- **Claim-level attribution on the two synthesis levels.** `citationPromptSection` tags each child in the prompt (`[F1]`, `[S2]`, `[P3]`, `[M1]`) and asks the model to end evidence-bearing sentences with the tag of the input carrying them. `extractClaims` then **strips the markers** and records `ContextProvenance.claims` as offset spans — the stored context stays clean prose, because it feeds chat, memory extraction and timeline harvesting, none of which should see markers. A marker with no matching child is dropped: only children that actually reached the prompt are given a tag, so a citation to a dropped child can only be a hallucination. Order is load-bearing — `finishSynthesis` extracts claims *before* truncating to the char cap, then clamps; the reverse would cut mid-marker and shift every offset after it. File contexts get no citations: every claim in one already traces to the single file it read.
- **Exact-line citations at the file level.** The file pass is the ONLY level whose model reads source text — a folder synthesis reads child summaries and has never seen a source line — so it is the only level that can cite one. `numberLines` prefixes every line before the prompt, the model cites `[L42]` / `[L42-58]`, and `lineMarkerResolver` rejects any range past the last line it was shown. `readSourceExcerpt` then re-derives the text through the **same** `readDocumentText` → `redactMemoryContent` pipeline the indexer used: that is what makes line N in a citation the same line N on screen, including for DOCX/XLSX where "lines" belong to the extracted text and have no counterpart in the raw bytes. It re-checks the content hash and refuses to show anything if the file changed since indexing. The excerpt is never model-generated — the model supplied only numbers.
- **It is surfaced, not just stored.** `ProvenanceExplorer.tsx` renders a node's chain and drills one layer per click (`maxDepth: 1` per fetch — never resolve a whole subtree to render a list of three folders). `ProvenanceText.tsx` renders the prose with cited spans hoverable, resolving each span's source labels from the node's own recorded edges so it can never show a source the synthesis was not built from. Both appear in the Data page on the root super-context, each folder super-context and the user super-context, and in the conversation page's system-prompt popup for any block carrying `SystemPromptEntry.provenanceRef`. A block that embeds a *condensed or truncated* context carries no `textOffset`, so its spans are not drawn at all rather than landing on the wrong words. `label` and `provenanceRef` are UI-only: `buildApiMessagesFromHistory` narrows system entries to `role` + `content` before they reach the provider.
- **Every write path passes provenance, including failure sentinels.** A failed node with no chain is worse than a failed node. Cache hits and pre-provenance rows are backfilled through `setDocument{File,Folder}ContextProvenance` / `setUserSuperContextProvenance`, which are hash-guarded so a chain can only ever land on the text it explains — this costs no LLM calls, so **do not bump a `PROMPT_VERSION` to force a provenance backfill.**

## A conversation answer cites what it read, as pills

Chat attributions are a separate mechanism from the context-tree provenance above: they cover what a *turn* read with its tools, not how a stored context was synthesized. The invariant is the same one, though — **ids are minted from Holmes's own tool results, never from the model.** The model can only point at a number it was handed, so a marker that resolves to nothing is provably invented (`src/main/citations.ts`, `sourceMarkers.ts`, `SourcePill.tsx`; `pnpm test:citations`).

- **Main numbers the sources; the model only refers to them.** After `executeToolCalls`, `runChatWithTools` runs each result through `citations.annotate`, which adds a `cite: "S3"` field to every citable entry and **rewrites the tool result content in place** — so the model, the stored `tool` message and the renderer all read one numbering. `web_search` cites by URL, `search_files` and `read_file` by absolute path; every other tool acts on the user's workspace rather than reporting a source, and cites nothing. A result that is not JSON, is an error, or has nothing citable is returned byte-for-byte unchanged.
- **Numbering is per conversation, not per turn.** The registry is seeded from the active branch's stored sources (`collectConversationSources`) and new sources number on from the highest existing id — including past ids whose entries were dropped as duplicates. The model can still see earlier turns' tool results in its replayed history and may re-cite an id from one; if each turn restarted at S1, that stale `[S1]` would resolve against a different page. **A citation pointing at the wrong source is worse than none, because it looks checked.**
- **The message stores its sources.** `messages.sources_json` → `Message.sources`, written for every assistant message in the turn, so pills still resolve after a reload or a branch switch. The intermediate (tool-calling) assistant message deliberately carries only what earlier rounds read — its prose was written before the coming results existed.
- **Unresolvable markers are dropped, and the gap is closed.** `rehypeSourcePills` replaces `[S1]` with a pill in the rendered hast tree — never in the stored text, which keeps what the model actually said and keeps a copied response carrying its attributions. A marker with no matching source is removed along with the space that preceded it, or "Confirmed [S9]." would render as "Confirmed ." and swap a fabrication for a typo. Markers inside `code`/`pre` are content, not citations, and are left alone.
- **No favicons.** A web pill shows its bare hostname. Fetching an icon would mean a request to the site (or a favicon service) for every source in every answer — a per-source disclosure of what the user is reading.
- **A pill can only open a file Holmes recorded.** `APP.OPEN_SOURCE_PATH` checks `isOpenableSourcePath` *and* `assertPathAllowed`, then reveals in Finder rather than launching the file. The path set is fed from tool results and from `CONVERSATIONS.GET_MESSAGES` — always from the database, never from a path the renderer names.
- The citing policy lives in `prompts/stable.txt` ("Citing Sources"). It is the only part of this that is advice rather than enforcement, which is why every rule above fails safe without it.

## What to NEVER do

- **NEVER commit provider API keys** — they live in `electron-store` at `~/Library/Application Support/holmes/holmes-settings/`, outside the repo.
- **NEVER remove the `export.xml` / >10MB exclusion** in `collectProjectTextFiles` (`src/main/projectContext.ts`).
- **NEVER add a channel to `OWNER_CALLABLE_CHANNELS` that writes to the filesystem, changes the file access scope, reads or sets credentials, spawns a sidecar, or starts a paid bulk run.** The list is default-deny and that is the only thing standing between "remote client" and "remote shell". `settings:get` is denied because it returns the provider API key; the phone gets `remote:client-settings` instead.
- **NEVER remove the scope branch in the `library:set-progress` handler without also removing the channel from `MEDIA_CALLABLE_CHANNELS`.** That branch is the only thing keeping a guest's reading off the owner's row, and the owner's row reaches the life timeline.
- **NEVER let a remote client take `serverStaticPub` from the wire on trust.** Pairing is protocol v2: the client verifies an HMAC bind tag against the pairing code *before* sealing anything to that key. Skipping the check reintroduces a permanent man-in-the-middle, which is the exact hole v2 closed. See `docs/ios-app.md`.
- **NEVER add a channel to `MEDIA_CALLABLE_CHANNELS` that returns anything derived from the user's life, or that writes anything.** That set is what a *guest* device reaches — the Library shelf and reader, read-only. Memory, health, conversations, chat, timeline, people, recall, roles, call history and `remote:client-settings` are all denied there on purpose, and so are the reading-record writers, because a guest's reading would be filed as the owner's and reaches the life timeline. When in doubt, leave it out.
- **NEVER give `isRemoteCallable` / `isRemoteEvent` a default scope.** The scope argument is required so an omission is a type error rather than a silent widening to owner.
- **NEVER let a media endpoint take a path, a path fragment, or anything that is joined to a root.** Bulk media (`src/main/remoteMedia.ts`) and the `holmes-audio://` protocol both address resources by **opaque id resolved through the database**, which is why traversal is impossible by construction rather than by sanitizing. After the id resolves to a path, re-check that path against the connected source roots and `fileScope.ts` — a book row outlives its source, and the file access scope can be narrowed after a scan.
- **NEVER accept a device id, or anything else a client simply holds, as an HTTP credential.** The WebSocket session proves identity; an HTTP request proves nothing. Bulk media mints a short-lived HMAC token bound to resource id + device id + scope + expiry, verified signature-first in constant time, with the device row re-read every request so revocation is immediate. No cookies, no long-lived bearers, and one identical `403` for every failure so nothing becomes an oracle.
- **NEVER route bulk media over the relay.** `docs/relay.md` section 6: relayed audiobook streaming would cost roughly twice the chat bill. Minted media URLs are absolute against the Mac's direct host and port on purpose, so the rule is a property of the URL rather than something to remember.
- **NEVER return an owner field to a `media`-scoped caller.** `library:*` payloads carry the owner's rating, notes, reading progress, dates and the Mac's absolute paths. Redaction lives in `src/shared/books.ts` and is gated on `event.remote?.scope === 'media'` — a renderer call has no `remote` and must keep its current behaviour exactly. A guest gets **no reading progress at all**; per-guest reading state does not exist and must not be invented casually.
- **NEVER register an IPC handler with `ipcMain.handle` directly** — use the local `handle()` in `ipc.ts`, or the channel exists for the renderer but not for the registry the remote server dispatches against.
- **NEVER break the IPC 4-file sync** — adding a channel = updating `ipcChannels.ts` + `ipc.ts` + `preload.ts` + `types.ts`.
- **NEVER reintroduce `systemModel`** — models resolve through `settings.getTextModel(tier?)` / `getVisionModel(tier?)` / `getIndexVisionModel(tier?)`.
- **NEVER resolve an indexing run's vision model with `getVisionModel`** — that is the chat sentinel, and it silently reduces a run to text-only. Indexing uses `getIndexVisionModel`.
- **NEVER store a derived context without its provenance** — a node with no path back to source files is exactly the drift the context tree is built to avoid.
- **NEVER quote a cost for an unpriced model** — absent pricing means unknown, not free (`modelPricing.ts`).
- **NEVER remove the photo downscale** in `photoContext.ts` — full-res images cost ~28x more per photo.
- **NEVER bypass the rate limiter** for a bulk call path, and never pace only the first attempt — retries count against the provider's limit too.
- **NEVER make the cost estimate run automatically** (on mount, on tier change, on a timer) — it walks the whole directory tree.
- **NEVER let a background timer start photo indexing** — it must pass `skipImages: true`.
- **NEVER prune document contexts unscoped** when a project can have several sources — use the `...Under(projectId, base, keep)` variants.
- **NEVER assert a literal prompt-version string in a test** — pin the *shape* (`FILE_PROMPT_VERSION = '<non-empty>'`), or every legitimate prompt revision breaks an unrelated suite.
- **NEVER rebuild native modules while the user has the app running** — rewriting `better_sqlite3.node` / `keytar.node` under a live process invalidates the code signature and macOS SIGKILLs it (`CODESIGNING` / `Invalid Page` in the .ips report). Re-sign after: `codesign --force --deep -s - node_modules/electron/dist/Electron.app`.
- **NEVER skip the try/catch `ALTER TABLE` migration pattern** when adding DB columns.
- **NEVER run `npm run lint`** — eslint is not installed; the script exists but will fail. This is pre-existing.
- **NEVER try to fix the pre-existing `test:memory` failure** unless explicitly asked.
- **NEVER add comments to code** unless explicitly asked.
- **NEVER add emojis** to code or docs unless explicitly asked.
- **NEVER let the Tabloid curator author a source ref.** The planner may cite only `[TAG]`s the prompt issued, and the curator may cite only intent ids; an item's `sourceRefs` are computed from the intents it cited. A ref a model wrote is a claim about the user's life that nothing can check — the same reasoning as "a marker with no matching child can only be a hallucination".
- **NEVER make a Tabloid refresh replace the feed.** `replaceTabloidFeedItems` adds a BATCH above the existing ones and the page renders `VISIBLE_BATCHES` of them, newest first — a set of suggestions the user has not got round to must not be thrown away by pressing Refresh. Two things follow: the function returns only the batch it wrote (the analysis pass iterates that return value, and returning the page would re-review every batch on every refresh), and `pruneTabloidItems` bounds the stack by BATCH rather than by row, because pruning a partial batch punches holes in a page the user is looking at. Reacted items are exempt from pruning wherever they sit — they are the taste record the next plan reads, so a dislike from months ago still has to keep that video out.
- **NEVER request YouTube captions with a wildcard language.** `--sub-langs "en.*"` matches the ~32 machine translations offered alongside the real track, yt-dlp requests them in a burst, and the whole thing comes back `429 Too Many Requests` with nothing downloaded. `en-orig,en` succeeds where the wildcard fails, and `en-orig` is the true auto-generated track (plain `en` may be a translation back into English).
- **NEVER de-duplicate YouTube captions per cue.** The rolling format holds the previous line AND the new one in the same cue, so a per-cue key makes every cue unique and the de-duplication does nothing — a 19-minute video goes to the model as 999 stuttering cues instead of 499 clean lines. De-dupe per LINE, keep the EARLIEST timestamp (that is when the words were spoken; the repeats are the caption scrolling).
- **NEVER widen `script-src` for the YouTube IFrame API.** The player runs with `enablejsapi=0` on purpose; driving it from JS would need `https://www.youtube.com` in `script-src`, and nothing in the feed tracks watch progress. The embed needs exactly two things: `https://www.youtube-nocookie.com` in `frame-src`, and the matching allowance in `will-frame-navigate` (`main.ts`) — **missing either one produces a blank frame with nothing in the console naming the cause**, because a `preventDefault` there is silent.
- **NEVER commit without running `npm run typecheck`** first.
- **NEVER rebuild `better-sqlite3` for one runtime and forget to rebuild for the other** (see landmine #2).

## Phase history (what's been built, in order)

1. **Original app**: Chat with streaming + branching, Memory (17 categories, auto-extraction, abridged summary), Recall (Spotlight + conversations), Projects (default + user-created), Psychology (tests + analysis), Product Search, iMessage relationship analysis, Claude import.
2. **Health Phase 1** (foundation): `HealthAnalysis` type, `HealthPage`, `HealthWidget`, `analyzeHealth`, Dashboard 2x2 card, `healthAnalysisEnabled` setting, `PROJECTS.ANALYZE_HEALTH` IPC, `buildHealthProjectContext`, `test-health.mjs`.
3. **Health Phase 2** (ingestion + rolling synthesis): `health_records` / `health_observations` / `health_summary` tables, 3 parsers (Apple Health XML via saxes, MyChart CCDA via fast-xml-parser, Bloodwork CSV/PDF via pdfjs-dist), `redactHealthContent`, `generateHealthSummary`, hourly background timer, `HealthSourcesPanel` + observations table UI, `IPC.HEALTH` namespace, `test-health-bootstrap.mjs`.
4. **Health Phase 3** (live HealthKit): Swift HealthKit sidecar (`healthkit-sidecar/`), `healthLive.ts` (spawning sidecar, parsing JSON, DB upsert), live status UI + "Sync now" button, `healthLiveSyncEnabled` setting, `IPC.HEALTH.LIVE_*` channels, hourly live sync timer.
5. **Context version archive**: `context_versions` table + `archiveContextVersion`, wired into every context write path; `timeline_events.archived_at` / `last_seen_at` / `context_version_id`; `mergeDerivedTimelineEvents` replaced the destructive rebuild; `IPC.CONTEXT_VERSIONS` namespace; Timeline page reads superseded contexts inline.
6. **Timeline**: every generated context now emits a dated `TIMELINE:` block built from real dating evidence (`dating.ts`); `timeline_events` / `timeline_summary` tables, `src/main/timeline.ts` (harvest, merge, era narrative), `IPC.TIMELINE` namespace, `TimelinePage` + sidebar entry, `timelineEnabled` setting (default on), hourly rebuild timer, and a "Timeline" chat context block. `test-timeline.mjs`.
7. **Model tiers + photo indexing + cost estimates**: `systemModel` replaced by `modelTiers` (budget/mid/frontier, each with a text and a vision model) plus `defaultTier`; `ModelInfo` widened to carry OpenRouter pricing and `input_modalities` (previously fetched and discarded); `photoContext.ts` (downscale + EXIF + HEIC via sips); image branch in the document-context file phase with a `kind` column on `document_file_contexts`; `indexEstimate.ts` + `modelPricing.ts` and `IPC.DOCUMENTS.ESTIMATE`/`ESTIMATE_ALL`; `IndexEstimateBar` (explicitly triggered) on the Data page and every project panel; `rateLimit.ts` pacing every indexing call to `AppSettings.requestsPerMinute` (default 20), which is what actually sets a bulk run's wall clock; `useDocumentIndex` hook collapsing the per-panel IPC subscriptions into one.
8. **Multi-source projects**: `project_sources` table with a backfill from `projects.path`; per-source indexing (`options.sourcePath`), forced re-index ignoring every cache (`options.force`), scoped pruning, a project-level synthesis combining source roots, `PROJECTS.ADD_SOURCE`/`REMOVE_SOURCE`/`LIST_SOURCES`, and a Data-page directory list with per-source Estimate/Index controls.
9. **Data page redesign (to `assets/dataPageMockup@2x.png`)**: one draggable row per source with inline expansion, header visibility menu + Bulk Index dialog, `Add New Source` dialog; `projects.visible` / `projects.sort_order` columns with `PROJECTS.REORDER` and `DOCUMENTS.GET_SUMMARIES` channels; sidebar dropped its Projects row (reachable from the conversations filter's "Manage projects…"), gained the project filter and mockup icons, and the title bar gained the Ko-fi heart.
10. **Per-project scope, style, and conversations as sources**: `projects.context_scope` (`life`/`separate`) and `projects.index_style` (`behavioral`/`work`/`reference`) with `indexStyles.ts` carrying the non-behavioral prompts; `conversation_projects` (a conversation belongs to every project its context stacks) and `conversation_contexts` (one summary per conversation, feeding each project's super-context) with `conversationContext.ts`; `llmCall.ts` extracted from `documentContext.ts`; separate projects excluded from the user super-context, memory and the life timeline while keeping their own timeline scope on the Timeline page.
11. **Source list cleanup**: the `Data` default project retired (the page navigates by a boolean, its Dashboard card is static); `Files` renamed to `File System`, standing for the file access scope with `FileScopePanel` moved out of Settings into its expansion; the user super-context moved to the top of the Life Dashboard; row buttons swapped (play expands, document-search indexes); pointer-driven drag reordering with the other rows animating aside; life sources grouped above personal ones; and `ProjectIndexSummary.fullyIndexed` reserving the accent dot for completely indexed sources.
12. **Remote access + iOS client (Phase 1)**: server mode in Holmes Mac — a hand-rolled WebSocket server (`wsServer.ts`, no dependency added) behind an X25519/HKDF/AES-GCM session (`remoteCrypto.ts`), single-use pairing codes, and per-device revocation (`remote_devices` table). `ipcMain.handle` calls were wrapped in a local `handle()` that also records each handler in a registry (`remoteBridge.ts`), so the 196 existing handlers serve a paired phone unmodified; the 25 `win.webContents.send` sites became `broadcast()`, which fans out to windows *and* devices. Access is gated by the callable sets in `src/shared/remote.ts` — **default-deny**. `mobile/` is a Capacitor + React workspace package importing `src/shared` directly. `docs/ios-app.md` is the canonical reference. `test-remote.mjs`.
13. **Per-device remote scopes (the media-server turn)**: `RemoteDevice.scope` (`'owner' | 'media'`) with a `scope` column on `remote_devices` defaulting existing rows to `owner`; `REMOTE_CALLABLE_CHANNELS` split into `MEDIA_CALLABLE_CHANNELS` (seven read-only Library channels) and `OWNER_CALLABLE_CHANNELS` (a superset); `isRemoteCallable(channel, scope)` / `isRemoteEvent(channel, scope)` with the scope **required**; the session carries the device's scope and `dispatch` checks it, and `forwardToDevices` re-checks per session so a guest never receives the owner's chat stream; `RemotePairingOffer.scope` chosen in the Settings panel (Full access / Media only, defaulting to media) and recorded by `createRemoteDevice`.
14. **Guest redaction + bulk media over HTTP**: the `media` scope stopped leaking the owner's Library payloads — `src/shared/books.ts` gained pure `redactBookForGuest` / `guestReadingState` / `redactLibraryBookForGuest` / `redactAudiobookForGuest`, applied in the `library:list-books` / `get-book` / `list-audiobooks` / `get-audiobook` handlers only when `event.remote?.scope === 'media'`. A second path on the remote port serves bulk bytes: `wsServer.ts` gained an `onRequest` hook, `src/shared/remoteMedia.ts` holds the pure contract (kinds, canonical token payload, RFC 7233 range parsing) and `src/main/remoteMedia.ts` the HMAC tokens, id-to-path resolution and streamed range serving (`206`/`416`/`HEAD`/`ETag`, `createReadStream`, never buffered). `library:get-media-url` is the only minter and is remote-only; media URLs are absolute against the Mac's direct address, so bulk media can never cross a relay.
15. **Pairing hardened to protocol v2**: the v1 exchange sent the pairing code and `serverStaticPub` in cleartext, because frame encryption only starts after pairing — so anything on the path could read the code and pair itself, or substitute its key for a permanent MITM. Now three steps: `pair-hello` (client ephemeral key) → `pair-offer` (`serverStaticPub` + `HMAC(code, label || serverStaticPub || clientEphemeralPub)`) → `pair` (payload sealed to the verified key), with a sealed reply. The code never crosses the wire. `pairingBindTag` / `derivePairingKeys` in `remoteCrypto.ts`, mirrored in `mobile/src/transport/crypto.ts`. This is what unblocks an untrusted relay.
16. **Tabloid feed**: the leisure tab gained a curated video feed built against the user's own record — `tabloid_feed` / `tabloid_items` / `tabloid_media` tables; a plan → retrieve → curate pipeline (`tabloidPlanner.ts` turns the profile into search intents, `youtubeSearch.ts` answers them through YouTube Data API v3, `tabloidCurator.ts` ranks and writes the one-line "because you…" per pick); provenance chips on every card resolved from the intents that produced it, never from model-authored refs; a `holmes-media://` scheme serving thumbnails cached under `userData` by opaque id; in-app playback through a `youtube-nocookie` iframe, which needed both a `frame-src` entry and a `will-frame-navigate` allowance; thumbs-up/not-for-me reactions that suppress future picks, feed both prompts, and offer a `preferences` memory candidate through `applyMemoryCandidates` (so a hand-typed field is never overwritten); `AppSettings.youtubeApiKey` with a Pacific-day quota ledger on the feed row. **YouTube calls do not appear in Call History** — `callLog.ts` matches only the provider base URL — which is why the page shows the unit ledger instead. `test-tabloid.mjs`.
17. **Tabloid: claim review, watch state, and archiving**: the refresh became a reported, cancellable, watchdogged run (`tabloidRuns.ts` + `useTabloidRun` + a sidebar strip, mirroring `libraryRuns`), because it now downloads a transcript and reviews it for every pick and takes minutes rather than seconds. Captions come from yt-dlp (`youtubeTranscript.ts`) since the Data API cannot read a stranger's; `parseVtt` turns YouTube's rolling auto-caption format into clean timestamped lines (999 cues → 499, 171KB → 19KB on a real file). `tabloidAnalysis.ts` flags unsupported/false/misleading/biased/outdated claims, each quoting the transcript verbatim and snapped to a real cue, rendered as a click-to-seek panel with marks on a ruler under the player. Playback position comes from the iframe's raw postMessage protocol — `enablejsapi=1` but **no** `iframe_api` script, so `script-src` stays closed — and is stored per VIDEO in `tabloid_watch_state` with a monotonic `furthest_seconds`, so progress survives the item leaving the feed. `tabloidArchive.ts` downloads at best available quality into a new `Videos` media source, which needed a third `ProjectKind` (`media` previously mapped to `library`, which would have scanned mp4s as e-books); archived video contributes its watch record to the life picture and never its transcript. A refresh **stacks**: `tabloid_items.feed_batch` groups each run's picks and the page shows the last six batches newest-first, so refreshing adds to the feed rather than discarding what you have not watched yet.
18. **Inline source pills in conversation**: answers grounded in a tool result now attribute themselves the way Claude does — a small pill after the claim, not a bibliography. `citations.ts` mints the ids in main from `web_search` / `search_files` / `read_file` results, writes each one back into the result as a `cite` field (which is how the model learns the number), and stores the list on every assistant message of the turn (`sources_json` / `Message.sources`). The model can only ever *point at* an id, never mint one, so **an id that resolves to nothing was invented and is dropped from the rendered prose** — same rule as the context-tree claim markers. Numbering is **per conversation, not per turn** (`createTurnCitations(known)` seeded from the active branch): the model still sees earlier turns' tool results in its replayed history and will re-cite an id from one, and a stale `[S1]` landing on a different page is worse than no citation. `sourceMarkers.ts` is a rehype pass that swaps complete `[S#]` markers for pills, skips `code`/`pre`, and closes the whitespace a dropped marker leaves behind; `SourcePill.tsx` shows a hostname (never a fetched favicon — that would disclose the user's reading to every site per answer) or a basename. File pills reveal in Finder through `APP.OPEN_SOURCE_PATH`, gated twice: the path must be one Holmes recorded as a source *and* still inside the file scope. `test-citations.mjs`.
19. **The transcript renders turns, not rows**: a tool-using answer is stored as several messages (prose+`tool_calls` → a `tool` row per result → the answering prose), and rendering one bubble per row broke one reply into several that each repeated the furniture — two marks, two `THINKING` labels, and a tool call sitting nowhere near its own result. `turnGrouping.ts` (pure, `test-chat-turns.mjs`) folds every non-user row up to the next user message into one `AssistantTurn` of ordered `segments`, pairing each result into the call that produced it; `toolStepsFromInteractions` builds the same shape from the live stream so one component renders both. `AssistantTurnBlock.tsx` draws it, `MessageBubble.tsx` is now the user row only, and `MessageToolbar.tsx` is shared so the two cannot drift. **Branch navigation and retry anchor on the turn's FIRST row** — retry regenerates the whole answer, so the branch point is the message hanging off the question. `ToolStepRow.tsx` is one quiet expandable row per call (past-tense label once done, arguments and result inside, payloads capped at 4k chars); `ThinkingDisclosure.tsx` is one sentence-case disclosure per turn that shimmers while reasoning arrives and collapses itself when prose starts, but never re-closes under a reader who opened it by hand. `messages.tool_error` is persisted because otherwise a failed call reads as successful after a reload, and a stored call with no stored result shows `no result` rather than spinning forever. **At most one Holmes mark is ever on screen**: the newest assistant turn wears it (the streaming block takes it while live) and every earlier turn leaves an equal-width empty gutter — repeating the mark down the transcript turned a signal into wallpaper.
20. **Planned**: OpenCircuitKit Swift package dependency for RingConn BLE, native HealthKit writes from the phone, MyChart FHIR, camera bloodwork capture. Each is a custom Swift Capacitor plugin; none needs the transport to change.

## When you're stuck

- For **any Memory question** → read `docs/memory.md` first
- For **Health feature questions** → read `src/main/healthAnalysis.ts` (system prompt + parser) and `src/main/health.ts` (ingestion) first
- For **IPC questions** → always start at `src/main/ipcChannels.ts`
- For **DB questions** → always start at `src/main/database.ts:37` (`initDatabase`)
- For **renderer questions** → always start at `src/renderer/App.tsx` (the render cascade at `:508`)
- For **provider/AI calls** → read `src/main/provider.ts` (all `fetch` calls live here)
- For **types** → read `src/shared/types.ts` (single source of truth)
- For **dates or the timeline** → read `src/shared/timeline.ts` first (the prompt contract and the parser are both there)
