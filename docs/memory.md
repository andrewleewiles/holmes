# Memory

Holmes Memory is a local, user-controlled profile database that personalizes conversations. It stores facts, preferences, relationships, and context about the user in a SQLite database on disk. Memory is never uploaded except as bounded excerpts sent to your configured AI provider during auto-fill or extraction.

## Memory Modes

Each conversation can select a memory mode from the dropdown in the chat header:

### Detailed

Injects the full contents of all filled Memory fields into the system prompt, organized by category. Each field includes its value, confidence score, and origin (manual or AI). This gives the model maximum context but consumes more tokens.

### Abridged

Uses a rolling AI-generated summary of the user's profile instead of raw field data. The summary is natural-language prose (3-6 paragraphs) covering who the user is, their context, what's on their mind, and key preferences.

**Rolling summary behavior:**

- The summary is stored in the `memory_summaries` table alongside a hash of all non-null field values.
- On first use with Abridged mode, the summary is generated synchronously (the user waits ~5-15 seconds for the first response).
- The summary is refreshed when both conditions are met:
  1. At least 24 hours have passed since the last update.
  2. The field hash differs from the last summary (meaning memory fields have changed).
- Instead of regenerating from scratch, the existing summary is sent to the model along with the current field values. The model updates the summary to incorporate new information and remove anything stale. If the changes are irrelevant to a user summary, the summary is returned with minimal or no edits.
- A background timer checks hourly whether a refresh is needed.

### Anonymous

No memory is injected into the system prompt. The model has no knowledge of the user's profile, preferences, or history.

## Memory Catalog

Memory is organized into 17 categories with ~160 default fields:

| Category | Examples |
|---|---|
| Identity | Full name, preferred name, pronouns, birth date, birthplace, biography |
| Contact | Primary email, phone, addresses, emergency contact |
| Household | Members, partner, living arrangement, home ownership |
| Relationships | Close family, friends, colleagues, communication preferences |
| Health | Allergies, medications, conditions, clinicians, fitness baseline |
| Work | Employer, job title, skills, career history, current projects |
| Education | Institutions, degrees, certifications, learning goals |
| Finances | Currency, income range, budget, savings goals, subscriptions |
| Pets | Pets, breeds, veterinarian, care instructions |
| Preferences | Foods, drinks, music, books, hobbies, clothing sizes |
| Routines | Wake time, sleep time, working hours, exercise, meals |
| Goals | Active goals, short-term, long-term, career, financial goals |
| Travel | Home airport, destinations, loyalty programs, preferences |
| Technology | Devices, operating systems, apps, AI provider, smart home |
| Vehicles | Vehicles, license plates, insurance, maintenance |
| Possessions | Properties, important items, warranties, serial numbers |
| Important Dates | Birthdays, anniversaries, renewals, appointments, deadlines |

### Custom Fields

Users can create custom fields that don't fit the default catalog. Custom fields are marked with a "Custom" badge and can be deleted (unlike default catalog fields). They are created:

- Manually via the "Add field" button on the Memory page.
- Automatically by the idle conversation extraction agent when it finds information that doesn't fit any existing field. The agent selects an appropriate category, label, and value type, then creates and fills the field directly.

## Memory Sources

Auto-fill can extract facts from these local sources:

| Source | What's included | Scope |
|---|---|---|
| Conversations | Recall-ranked user message excerpts | Your Holmes chat history |
| Projects | Text files, psychology analyses, relationship analyses | Files in Holmes projects |
| Entire filesystem | Spotlight-ranked file excerpts | Any file on this Mac |
| iMessage metadata | Contact names, handles, aggregate activity | Not message bodies |
| Account & settings | OS username, timezone, platform, model preferences | Non-secret only |
| Super-contexts | Freshly generated project and user super-context syntheses | Only when "Populate Memory from super-contexts" is on |

All sources are locally redacted for credentials and payment identifiers before being sent to the AI provider. The total context is capped at 90,000 characters.

## Auto-fill & Suggestions

### Auto-fill

Triggered from the Memory page. Collects evidence from selected sources, sends bounded excerpts to the configured AI provider, and extracts candidate facts.

- **Empty fields** are auto-filled directly (origin: `ai`, confidence recorded).
- **Fields with existing values** create review suggestions rather than overwriting.

### Merge Strategies

Each candidate declares how it relates to the existing value:

- **Replace** — The existing value is wrong or stale. Discard it and use the new value.
- **Merge** — The existing value is valid but incomplete. The returned value is the fully combined result (existing + new woven together). Used for text/multiline fields.
- **Supplement** — The existing value is valid and should be preserved. The returned value is the complete combined list (old + new items, deduplicated). Used for list fields.

For boolean, number, and date fields, merge is always `replace` (these types cannot be merged).

### Suggestion Review

When a candidate conflicts with an existing value, a suggestion card appears on the Memory page showing:

- The proposed value, the current value, and the merge strategy badge
- Confidence percentage and rationale
- Source citations
- **Merge** button (if mergeable) — combines existing + new
- **Replace** button — overwrites existing entirely
- **Reject** button — discards the suggestion

Placeholder values ("Not specified", "Unknown", "N/A", etc.) are filtered out server-side and never become suggestions.

## Idle Conversation Analysis

When enabled in Settings, Holmes automatically analyzes conversations that have been idle for approximately 5 hours and extracts new facts into Memory.

**How it works:**

1. A background timer runs every 30 minutes.
2. It queries for conversations where `updated_at` is older than 5 hours AND `memory_extracted_at` is NULL or older than `updated_at` (meaning there are new messages since the last extraction).
3. For each idle conversation, the last ~24K characters of user + assistant messages are sent to the System Model.
4. The model extracts facts using the same extraction system as auto-fill, with one key difference: **it can create custom fields** when it finds information that doesn't fit any existing field.
5. Extracted facts are auto-filled directly into Memory (no suggestions created for idle extraction — values go in directly).
6. The conversation's `memory_extracted_at` timestamp is updated to prevent re-extraction of the same messages.

**Custom field creation during idle extraction:**

The extraction schema includes a `newFields` array where the model can propose new fields:

```json
{
  "newFields": [
    {
      "category": "preferences",
      "label": "Coffee order",
      "valueType": "text",
      "value": "Oat milk latte with vanilla",
      "confidence": 0.9,
      "rationale": "User mentions this order repeatedly across conversations",
      "sourceIds": ["source-1"]
    }
  ]
}
```

Each proposed field is created via `createMemoryField` and then filled with the extracted value. Duplicate labels (case-insensitive) are filtered out.

**Enabling:**

Toggle "Auto-extract from conversations" in Settings. Requires an API key and System Model to be configured. The setting is off by default.

## Super-context Memory Population

When Document context is enabled, each project's root super-context and the unified user super-context can also feed Memory.

**How it works:**

1. `generateDocumentContexts()` produces a project's root super-context. If the root was actually regenerated (its child-hash changed), the synthesis is passed to `extractSuperContextMemory()`.
2. `generateUserSuperContext()` does the same after it writes a new unified user super-context. Its input-hash gate means an unchanged input returns the stored value without any extraction.
3. The synthesis text is passed through `redactMemoryContent()` and capped at 24,000 characters, then sent to the System Model through the same `extractMemoryCandidates` path used by auto-fill and idle conversation extraction, with `allowCustomFields: true` so the model can propose new fields.
4. Candidates are applied via `applyMemoryCandidates()` — empty fields are filled directly, conflicting fields become suggestions, and identical values are skipped, so re-running never duplicates.
5. Provenance is recorded as a `super-context` memory source with a label identifying the origin (`Super-context: <project name>` or `User super-context (all data sources)`), visible on the field's source chips on the Memory page.

**Sensitive gating:** fields flagged `sensitive` are excluded, and model-proposed new fields in the `contact`, `health`, `finances`, `relationships`, and `household` categories are dropped. This mirrors `includeSensitive: false` and is not bypassable from this path.

**Failure behavior:** extraction is entirely best-effort. Any error is captured and returned, never thrown — a Memory failure can never abort or fail super-context generation.

**Enabling:** toggle "Populate Memory from super-contexts" in Settings (`superContextMemoryEnabled`, off by default, only configurable when "Document context" is on).

## Abridged Summary Architecture

### Storage

The `memory_summaries` table is a singleton (row id = 1):

| Column | Type | Description |
|---|---|---|
| `summary` | TEXT | The natural-language summary text |
| `field_hash` | TEXT | Hash of all non-null field values at last update |
| `updated_at` | INTEGER | Epoch ms of last update |

### Generation Flow

1. `shouldUpdateAbridgedSummary()` checks: no summary exists OR (`updated_at` > 24h old AND `field_hash` differs from current).
2. If no existing summary: generate from scratch using all current non-null field values.
3. If existing summary: send the old summary + current field values to the model with instructions to update incorporating changes and remove stale info.
4. The updated summary is stored with the new field hash and timestamp.
5. If generation fails and a stale summary exists, the stale summary is used as a fallback.

### Background Refresh

An hourly `setInterval` in the main process calls `shouldUpdateAbridgedSummary()` and regenerates if needed. This ensures the summary is fresh when the user starts an Abridged conversation without waiting for synchronous generation.

## Privacy & Security

- Memory is stored locally in an unencrypted SQLite database (`holmes.db` in the app's userData directory).
- All evidence sent to the AI provider is passed through `redactMemoryContent()`, which strips:
  - Private keys (OpenSSH, PEM)
  - Bearer tokens
  - API keys (`sk-`, `pk-`, `ghp-`, `xox[baprs]-` patterns)
  - AWS access keys
  - Credentials in key-value pairs (password, secret, token, etc.)
  - SSNs, payment card numbers
- Sensitive fields (health, financial, contact, location) are excluded from extraction unless the user explicitly enables "Include sensitive fields."
- Nothing is uploaded to any server except bounded excerpts sent to your configured AI provider during auto-fill, idle extraction, or Claude import.
- Memory never includes passwords, API keys, authentication tokens, payment security codes, bank account numbers, or government ID numbers — these are filtered by both the prompt instructions and server-side validation.

## File Locations

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | `MemoryMode`, `MemoryField`, `MemoryCandidate`, `MemorySuggestion` types |
| `src/shared/memoryCatalog.ts` | The 17-category field catalog |
| `src/main/database.ts` | Memory field/suggestion/summary CRUD, idle conversation queries |
| `src/main/memory.ts` | Extraction prompt, schema, response parsing, value validation |
| `src/main/memoryContext.ts` | Builds system prompt context for Detailed/Abridged/Anonymous modes |
| `src/main/memorySummary.ts` | Rolling abridged summary generation and refresh logic |
| `src/main/memorySources.ts` | Evidence collection from conversations, projects, files, iMessage |
| `src/main/conversationMemory.ts` | Idle conversation memory extraction with custom field creation |
| `src/main/superContextMemory.ts` | Memory population from generated super-contexts (gating, redaction, custom field creation) |
| `src/main/documentContext.ts` | Calls super-context Memory population after the root and user super-contexts are regenerated |
| `src/main/provider.ts` | `extractMemoryCandidates` — the API call to the System Model |
| `src/main/ipc.ts` | IPC handlers for Memory auto-fill, suggestions, review |
| `src/main/main.ts` | Background timers for summary refresh and idle extraction |
| `src/main/claudeImport.ts` | Claude data import with memory extraction |
| `src/renderer/components/MemoryPage.tsx` | Memory page UI with auto-fill, suggestions, field editing |
| `src/renderer/components/MemoryDropdown.tsx` | Memory mode dropdown in chat header |
| `src/renderer/components/SettingsPanel.tsx` | Auto-extraction toggle and Claude import UI |

## Health data

The Health feature (Phase 2+) introduces a separate, structured ingestion pipeline for clinical and wearable data. Health data lives in its own tables (`health_records`, `health_observations`, `health_summary`) and is not mixed with Memory fields.

### Where data is stored

| Table | Purpose |
|---|---|
| `health_records` | One row per ingested source file (Apple Health `export.xml`, MyChart CCDA/PDF, bloodwork CSV/PDF). Includes status (`pending`/`parsed`/`failed`), observation count, content hash. |
| `health_observations` | Individual data points extracted from a record — labs, vitals, workouts, medications, conditions, generic observations. Includes value, unit, reference range, effective date, and source metadata. |
| `health_summary` | One row per Health project. Stores the latest `HealthAnalysis` JSON, the observations hash used for change detection, and the timestamp of the last refresh. |

All three tables are stored locally in the same unencrypted `holmes.db` SQLite database as Memory. Deleting a project cascades to its health records and summary.

### What is transmitted to the AI provider

Ingestion (parsing Apple Health XML, MyChart CCDA, bloodwork CSV) is **local-only** and does not require an API key. The only stage that sends data to the AI provider is:

1. **Bloodwork PDF extraction** — the PDF is parsed locally with `pdfjs-dist`, and only the extracted structured lab rows are sent to the System Model (after passing through `redactHealthContent()`). Raw PDF text is never transmitted.
2. **Rolling summary generation** — observations from the local DB are formatted and redacted, then sent to the System Model with `HEALTH_ANALYSIS_SYSTEM_PROMPT` to produce an updated `HealthAnalysis` JSON. This is gated by the `healthAnalysisEnabled` setting and the 24h + hash-change gating logic in `shouldUpdateHealthSummary()`.

### What the setting controls

The **"Health AI analysis"** toggle in Settings (off by default) gates:
- The Phase 1 `Analyze with AI` button on the Health page (sends project documents to the AI provider).
- The Phase 2 bloodwork PDF extraction.
- The Phase 2 rolling summary auto-refresh (the hourly background timer and the post-ingest trigger both check this setting before calling the AI).

When the setting is off, you can still import sources and store observations — no AI calls are made. The rolling summary timer skips work entirely.

### Redaction

`redactHealthContent()` (in `src/main/health.ts`) extends `redactMemoryContent()` with medical-specific patterns: MRN, NPI, DOB, Epic/MyChart account numbers, EHN identifiers, and US phone numbers. It is applied to:

- Structured lab rows before they leave the local DB for bloodwork PDF AI extraction.
- Formatted observation strings before they leave for summary generation.

### Rolling summary architecture

Mirrors the Abridged Memory summary pattern but stores one summary per Health project (not a singleton):

1. `shouldUpdateHealthSummary(projectId)` returns true if (i) `healthAnalysisEnabled` is on AND (ii) no summary exists yet OR the observations hash differs from the stored hash OR a new record was ingested AND (iii) ≥24h have passed since the last refresh OR no summary exists yet.
2. `generateHealthSummary(projectId, config, model, signal)` collects up to 2,000 observations, formats and redacts them, sends them to the System Model with `HEALTH_ANALYSIS_SYSTEM_PROMPT`, parses the response via `parseHealthAnalysisResponse()`, stores it via `updateProjectHealthAnalysis()` (so the same `HealthAnalysis` is surfaced in the Health page and Dashboard widget), and updates `health_summary` with the new hash + timestamp.
3. A background interval in `src/main/main.ts` checks hourly for any project named `Health` and refreshes if needed. After a successful ingest, the IPC handler triggers `generateHealthSummary()` immediately when the setting is enabled.

### Phase 2 file locations

| File | Responsibility |
|---|---|
| `src/shared/types.ts` | `HealthRecord`, `HealthObservation`, `HealthSummary`, `HealthIngestProgress` types + `ElectronAPI.health` namespace |
| `src/main/database.ts` | Health records/observations/summary CRUD, `runInTransaction` helper |
| `src/main/health.ts` | Apple Health (saxes) / MyChart CCDA (fast-xml-parser) / Bloodwork CSV+PDF (pdfjs-dist) parsers, `redactHealthContent`, `ingestHealthFile` dispatcher |
| `src/main/healthSummary.ts` | Rolling synthesis: `shouldUpdateHealthSummary`, `generateHealthSummary` |
| `src/main/ipc.ts` | `HEALTH.INGEST/ABORT/LIST_*/DELETE/REFRESH_SUMMARY/GET_SUMMARY` handlers |
| `src/main/main.ts` | Hourly background timer for the rolling summary |
| `src/main/projectContext.ts` | Excludes `export.xml` and files >10 MB from generic project context building |
| `src/renderer/components/HealthSourcesPanel.tsx` | File import UI, progress bar, record list, delete/re-ingest actions |
| `src/renderer/components/HealthPage.tsx` | Hosts the sources panel + filterable observations table + analyzes with AI |
| `src/renderer/components/HealthWidget.tsx` | Shows recent observations in both compact and full modes |
| `src/renderer/components/Dashboard.tsx` | Shows "N sources · M observations" line on the Health card |

### Live Apple Health sync (Phase 3)

Phase 3 adds a Swift CLI sidecar that queries HealthKit on macOS for live health data. The sidecar is a separate Swift binary spawned as a child process; it outputs JSON to stdout, which the Holmes main process parses and upserts into the existing `health_observations` table.

#### Architecture

```
[ Holmes main process ]
    │
    ├─ child_process.execFile("healthkit-sidecar.app/Contents/MacOS/healthkit-sidecar", ["--type", "all", "--days", "7", "--json"])
    │
    ▼
[ Swift sidecar binary ]
    │
    ├─ HKHealthStore.isHealthDataAvailable()
    ├─ HKHealthStore.requestAuthorization(toShare: [], read: types)
    ├─ HKStatisticsCollectionQuery (cumulative types) / HKSampleQuery (discrete, category, workout, ECG)
    │
    ▼
[ JSON to stdout → parsed in healthLive.ts → upserted into health_observations ]
```

The sidecar is built via `pnpm build:sidecar`, which:
1. Runs `swift build -c release` (SwiftPM, declared in `healthkit-sidecar/Package.swift`).
2. Falls back to direct `swiftc` if SwiftPM's manifest API is unavailable (some macOS Tahoe CLT betas ship a broken `libPackageDescription.dylib`).
3. Stages the binary into a minimal `.app` bundle at `node_modules/.holmes/healthkit-sidecar.app/` (not shipped in git; `.gitignore` covers it).
4. Copies `Info.plist` (with `NSHealthShareUsageDescription`/`NSHealthUpdateUsageDescription`) and ad-hoc signs the bundle with `com.apple.developer.healthkit` entitlements.

The signed `.app` bundle is also added to `electron-builder.yml`'s `extraResources` so packaged builds ship it under `process.resourcesPath/healthkit-sidecar.app/`.

#### Authorization flow

1. The first time `queryHealthKit()` is called, the sidecar invokes `HKHealthStore.requestAuthorization`, which triggers the macOS Health permission prompt.
2. The user must open System Settings → Privacy & Security → Health and grant access to "Holmes HealthKit Sidecar".
3. Subsequent queries use the stored authorization. `checkHealthKitAuthorization()` runs a minimal `steps` query for 1 day to detect the current state and caches the result for 30 seconds.
4. If authorization is denied or the sidecar is unavailable, the UI shows the appropriate status and disables "Sync now".

#### What gets synced

`--type all` queries the following HealthKit types over the last 7 days (configurable via `--days`):

- Cumulative (daily sum): `stepCount`, `activeEnergyBurned`, `appleExerciseTime`, `flightsClimbed`, `distanceWalkingRunning`, `dietaryEnergyConsumed`, `dietaryCaffeine`, `dietaryWater`.
- Discrete samples: `heartRate`, `restingHeartRate`, `heartRateVariabilitySDNN`, `bloodPressureSystolic`, `bloodPressureDiastolic`, `oxygenSaturation`, `bodyMass`, `bodyMassIndex`, `bodyFatPercentage`, `bloodGlucose`.
- Category: `sleepAnalysis` (grouped by sleep phase with total minutes), `appleStandHour` (count).
- Workout: each `HKWorkout` becomes one observation with duration, distance, and energy in `valueText`.
- Electrocardiogram: each `HKElectrocardiogram` becomes one observation with its classification (Sinus Rhythm, AFib, etc.).

Each query result is shaped as a `HealthObservation`-compatible object and upserted into `health_observations` against a per-project live-sync `health_record` (`source_type='apple_health'`, `filename='live-sync'`). Deduplication is by `(record_id, code, effective_date)` — re-syncing the same window does not duplicate rows.

#### What the setting controls

The **"Auto-sync Apple Health"** toggle in Settings (off by default; only enabled when "Health AI analysis" is also on) gates the hourly background timer's live-sync step:

- When on AND the sidecar is built AND authorization is `authorized`, the hourly timer calls `syncHealthKitToProject(projectId)` for the Health project before checking `shouldUpdateHealthSummary()`.
- New observations flow into the rolling summary hash, which then triggers `generateHealthSummary()` on its normal 24h + hash-change cadence.
- When off, the timer skips live sync entirely; the user can still click "Sync now" on the Health page.

Live sync never sends data to the AI provider directly. The only AI call is the existing rolling summary, which is independently gated by "Health AI analysis" and uses `redactHealthContent()`.

#### Phase 3 file locations

| File | Responsibility |
|---|---|
| `healthkit-sidecar/Package.swift` | SwiftPM manifest targeting macOS 13+ |
| `healthkit-sidecar/Sources/main.swift` | CLI entry point: arg parsing, HealthKit authorization + queries, JSON output |
| `healthkit-sidecar/Info.plist` | Bundle ID, `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription` |
| `healthkit-sidecar/entitlements.plist` | `com.apple.developer.healthkit` entitlement for ad-hoc signing |
| `src/main/healthLive.ts` | `getSidecarPath`, `isSidecarAvailable`, `queryHealthKit`, `checkHealthKitAuthorization`, `syncHealthKitToProject`, `getLiveStatus` |
| `src/main/database.ts` | `findHealthRecord`, `touchHealthRecordImportedAt`, `findExistingHealthObservationKeys` (Phase 3 helpers) |
| `src/main/ipcChannels.ts` | `HEALTH.LIVE_STATUS`, `LIVE_SYNC`, `LIVE_SYNC_ABORT`, `LIVE_SYNC_PROGRESS` channels |
| `src/main/ipc.ts` | Live IPC handlers with per-webContents AbortController map; triggers `generateHealthSummary` after a successful sync when `healthAnalysisEnabled` is on |
| `src/main/main.ts` | Hourly timer calls `syncHealthKitToProject` for the Health project when `healthLiveSyncEnabled` is on and the sidecar is available + authorized |
| `src/shared/types.ts` | `HealthLiveStatus`, `HealthLiveSyncProgress`, `HealthKitQueryResult`, `HealthSyncResult`, `HealthKitObservationInput` types + `ElectronAPI.health.live*` methods |
| `src/preload/preload.ts` | `liveStatus`, `liveSync`, `liveAbort`, `onLiveSyncProgress` bindings |
| `src/renderer/components/HealthPage.tsx` | "Live Apple Health" section with status badge, Build/Connect/Sync now buttons, progress indicator, connect help |
| `src/renderer/components/HealthSourcesPanel.tsx` | "Live" badge + refresh button on the live-sync `health_record` row |
| `src/renderer/components/Dashboard.tsx` | Green pulse dot on the Health card title when live sync is connected |
| `src/renderer/components/SettingsPanel.tsx` | "Auto-sync Apple Health" toggle (gated by "Health AI analysis") |
| `test-health.mjs` | Live sidecar integration tests: `getSidecarPath`, `isSidecarAvailable`, JSON fixture parsing, DB upsert + dedup with mock observations |
| `electron-builder.yml` | Stages `healthkit-sidecar.app` as an extraResource for packaged builds |

#### Known environment issue (macOS Tahoe CLT beta)

Some macOS 26.x (Tahoe) Command Line Tools betas ship a broken Swift toolchain:

1. `libPackageDescription.dylib` is missing the `Package` class symbols, so `swift build` fails at link time when compiling `Package.swift`.
2. `/Library/Developer/CommandLineTools/usr/include/swift/` contains a stale duplicate `module.modulemap` (from Aug 2023) alongside the correct `bridging.modulemap` (from Dec 2024). Both define the `SwiftBridging` module, which causes `swiftc` to fail with `error: redefinition of module 'SwiftBridging'` on any Swift compilation that imports Foundation.

The `build:sidecar` script detects the duplicate-modulemap case and tries direct `swiftc` with explicit `-fmodule-map-file` overrides and `-fno-implicit-module-maps`, but this workaround is not always sufficient because the implicit scan still runs first. The permanent fix is:

```
sudo rm /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap
```

(the duplicate Aug 2023 file). After removal, both SwiftPM and direct `swiftc` work normally. The TypeScript integration, IPC, UI, and tests are unaffected — they all run without the Swift binary.


