import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { deriveContextShort, isFailedContext } from '../shared/contextVersions'
import { getAssistantName } from '../shared/assistantIdentity'
import type {
  ChatAttachment,
  Conversation,
  Message,
  SearchResult,
  ReasoningEffort,
  Project,
  PsychologyAnalysis,
  HealthAnalysis,
  HealthRecord,
  HealthObservation,
  HealthObservationType,
  HealthSourceType,
  HealthSummary,
  ActivitySourceType,
  ActivityRecord,
  ActivityAnalysis,
  ActivitySummary,
  SourceAnalysis,
  DocumentFileContext,
  DocumentFileKind,
  ProjectSource,
  ProjectInput,
  DocumentFolderContext,
  ContextProvenance,
  UserSuperContext,
  ContextVersion,
  ContextVersionFilter,
  ContextVersionSourceType,
  ContextVersionSummary,
  RoleSessionNote,
  RoleSessionNoteSection,
  TimelineEvent,
  TimelineEventInput,
  TimelineEra,
  TimelineFilter,
  TimelineCategory,
  TimelinePrecision,
  TimelineSourceType,
  TimelineYearContext,
  Person,
  PersonAlias,
  PersonAliasKind,
  PersonAliasOrigin,
  PersonMention,
  PersonOverride,
  PersonOverrideKind,
  PersonRelation,
  PersonSeed,
  PersonPlatform,
  PersonSeedSource,
  PersonSourceType,
  PersonYearContext,
  PersonStatus,
  PeopleFilter,
  FinancesSummary,
  BrowserEvent,
  YoutubeEvent,
  AmazonEvent,
  EmailEvent,
  KnowledgeEvent,
  PhotoEvent,
  LocationEvent,
  WeatherEvent,
  SubscriptionEvent,
  AccountEvent,
  AccountEventKind,
  ActivityAccount,
  ActivityAccountConfig,
  ActivityAccountSource,
  ActivityAccountSyncStatus,
  ActivityAccountUpdate,
  ActivityCredentialKind,
  ActivityProviderId,
  MemoryCandidate,
  MemoryCreateFieldRequest,
  MemoryField,
  MemoryMergeStrategy,
  MemoryOrigin,
  MemorySource,
  MemorySuggestion,
  MemorySuggestionReviewRequest,
  MemoryUpdateRequest,
  MemoryValue,
  MemoryValueType,
  ContextSelection,
  MemoryMode,
  ToolCall,
  Book,
  BookChapter,
  BookFormat,
  BookReadingState,
  BookReadingStatus,
  BookReadingSession,
  BookScanStatus,
  BookAnnotation,
  BookAnnotationRun,
  AnnotationAnchorStatus,
  BookLesson,
  BookLessonAttempt,
  BookLessonConcept,
  BookLessonQuestion,
  BookLessonStep,
  BookConversationLink,
  Audiobook,
  AudiobookStatus,
  AudiobookWordTimings,
  SpeechProviderId,
  ProviderCall,
  ProviderCallCostSource,
  ProviderCallFilter,
  ProviderCallStats,
  ProviderCallSummary,
  ProviderType,
  CalledService,
} from '../shared/types'
import type { RemoteDevice } from '../shared/remote'
import { BOOK_READING_STATUSES } from '../shared/books'
import { MEMORY_FIELDS } from '../shared/memoryCatalog'
import { flattenContextSelection, normalizeContextSelection } from '../shared/contextSelection'
import {
  BOOKS_PROJECT_NAME,
  DEFAULT_PROJECTS,
  projectKindForCategory,
} from '../shared/defaultProjects'

let db: Database.Database

export function initDatabase(): void {
  const dbPath = path.join(app.getPath('userData'), 'holmes.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT,
      system_prompt TEXT DEFAULT '',
      project_id TEXT,
      reasoning_effort TEXT DEFAULT 'medium',
      memory_mode TEXT DEFAULT 'detailed',
      context TEXT,
      role_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      token_count INTEGER,
      model TEXT,
      reasoning TEXT,
      parent_id TEXT,
      is_active INTEGER DEFAULT 1,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      attachments_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'folder',
      color TEXT NOT NULL DEFAULT '#47a08f',
      path TEXT,
      kind TEXT NOT NULL DEFAULT 'standard',
      analysis TEXT,
      relationship_analysis TEXT,
      health_analysis TEXT,
      activity_analysis TEXT,
      finances_summary TEXT,
      visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      context_scope TEXT NOT NULL DEFAULT 'life' CHECK(context_scope IN ('life','separate')),
      index_style TEXT NOT NULL DEFAULT 'behavioral' CHECK(index_style IN ('behavioral','work','reference')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (project_id, path)
    );

    -- A conversation can sit in several projects at once: its context selection
    -- may stack them, and it belongs to every one it was pointed at.
    -- conversations.project_id mirrors the first, the way projects.path mirrors
    -- the first source.
    CREATE TABLE IF NOT EXISTS conversation_projects (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (conversation_id, project_id)
    );

    -- What a conversation itself contributed, summarized once and reused by
    -- every project it belongs to. Keyed on the message hash so an untouched
    -- conversation costs nothing to re-index.
    CREATE TABLE IF NOT EXISTS conversation_contexts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      message_hash TEXT NOT NULL,
      context_short TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL,
      provenance_json TEXT,
      updated_at TEXT NOT NULL
    );

    -- The formal analysis written from one role-led conversation. One row per
    -- conversation: continuing a session regenerates the note, and the outgoing
    -- text is archived in context_versions rather than lost.
    CREATE TABLE IF NOT EXISTS role_session_notes (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL,
      project_id TEXT,
      session_date TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      model TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      risk TEXT NOT NULL DEFAULT 'none' CHECK(risk IN ('none','monitor','urgent')),
      sections_json TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      generated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_role_session_notes_generated
      ON role_session_notes(generated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_fields (
      id TEXT PRIMARY KEY,
      field_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK(value_type IN ('text','multiline','number','boolean','date','list')),
      value_json TEXT,
      origin TEXT CHECK(origin IS NULL OR origin IN ('manual','ai')),
      confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
      sensitive INTEGER NOT NULL DEFAULT 0 CHECK(sensitive IN (0,1)),
      custom INTEGER NOT NULL DEFAULT 0 CHECK(custom IN (0,1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      sources_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_suggestions (
      id TEXT PRIMARY KEY,
      field_id TEXT NOT NULL REFERENCES memory_fields(id) ON DELETE CASCADE,
      value_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      rationale TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
      base_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_memory_fields_category
      ON memory_fields(category, sort_order);

    CREATE INDEX IF NOT EXISTS idx_memory_suggestions_status
      ON memory_suggestions(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_summaries (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      summary TEXT NOT NULL DEFAULT '',
      field_hash TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS health_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK(source_type IN ('apple_health','mychart','bloodwork','other')),
      filename TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      imported_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','parsed','failed')),
      parse_error TEXT,
      observations_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS health_observations (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES health_records(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('lab','vital','workout','medication','observation','condition')),
      code TEXT,
      display_name TEXT NOT NULL,
      value_real REAL,
      value_text TEXT,
      unit TEXT,
      ref_low REAL,
      ref_high REAL,
      effective_date TEXT,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_health_records_project
      ON health_records(project_id, imported_at DESC);

    CREATE INDEX IF NOT EXISTS idx_health_observations_record
      ON health_observations(record_id);

    CREATE INDEX IF NOT EXISTS idx_health_observations_type_date
      ON health_observations(type, effective_date DESC);

    CREATE TABLE IF NOT EXISTS health_summary (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      summary TEXT,
      field_hash TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- source_type deliberately carries no CHECK constraint: the valid set is
    -- enforced by isActivitySourceType() in shared/types.ts, and a CHECK here
    -- means a full table rebuild every time a source type is added. See the
    -- one-time constraint-drop migration below for the install that already
    -- has the old constrained table.
    CREATE TABLE IF NOT EXISTS activity_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      filename TEXT,
      file_size INTEGER,
      content_hash TEXT,
      imported_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','parsed','failed','needs_permission')),
      parse_error TEXT,
      events_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS browser_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('visit','bookmark','download')),
      occurred_at TEXT NOT NULL,
      title TEXT,
      url TEXT,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS youtube_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      title TEXT,
      channel TEXT,
      url TEXT,
      duration_seconds INTEGER,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS amazon_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      order_id TEXT,
      title TEXT,
      total_cents INTEGER,
      items_json TEXT NOT NULL DEFAULT '[]',
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('received','sent')),
      occurred_at TEXT NOT NULL,
      from_address TEXT,
      to_addresses_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT,
      body_excerpt TEXT,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      bundle_id TEXT,
      app_name TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('app_open','screen_on','notification')),
      duration_seconds INTEGER,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      asset_kind TEXT,
      location_name TEXT,
      faces_json TEXT NOT NULL DEFAULT '[]',
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS location_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      lat_real REAL,
      lng_real REAL,
      accuracy_m REAL,
      source TEXT,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS weather_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      temp_c REAL,
      humidity_pct REAL,
      precip_mm REAL,
      wind_kph REAL,
      conditions TEXT,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscription_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      provider TEXT,
      plan_name TEXT,
      amount_cents INTEGER,
      currency TEXT,
      cadence TEXT NOT NULL CHECK (cadence IN ('weekly','monthly','yearly','unknown')),
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    -- One row per external account the user has configured on the Activity
    -- source. Credentials live in the keychain; only the fact that one exists
    -- is recorded here so the UI can render "connected" without a keychain hit.
    CREATE TABLE IF NOT EXISTS activity_accounts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      watch_path TEXT,
      credential_stored INTEGER NOT NULL DEFAULT 0 CHECK (credential_stored IN (0,1)),
      credential_kind TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      last_sync_at TEXT,
      last_sync_status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      last_export_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, provider)
    );

    -- An account can watch several folders, the same way a project connects
    -- several directories. Exports arrive in batches — one per request, one per
    -- service, one per year — and pinning an account to a single folder means
    -- re-picking it every time. activity_accounts.watch_path mirrors source #1,
    -- exactly as projects.path mirrors the first project source.
    CREATE TABLE IF NOT EXISTS activity_account_sources (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES activity_accounts(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (account_id, path)
    );

    -- The generic event table for accounts with no dedicated shape. Gmail,
    -- YouTube and Amazon keep their own tables; everything else lands here.
    CREATE TABLE IF NOT EXISTS account_events (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES activity_records(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      title TEXT,
      detail TEXT,
      counterparty TEXT,
      url TEXT,
      source_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_summary (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      summary TEXT,
      source_analyses_json TEXT NOT NULL DEFAULT '[]',
      field_hash TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_file_contexts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      context TEXT NOT NULL,
      provenance_json TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS document_folder_contexts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      folder_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      child_hash TEXT NOT NULL,
      context_short TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, folder_path)
    );

    CREATE TABLE IF NOT EXISTS document_summary (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      root_path TEXT,
      signature TEXT,
      context_short TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      input_hash TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      folder_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_super_context (
      id TEXT PRIMARY KEY,
      context_short TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      input_hash TEXT,
      project_count INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_label TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'life',
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL,
      end_date TEXT,
      precision TEXT NOT NULL DEFAULT 'day',
      confidence REAL,
      dedupe_key TEXT NOT NULL UNIQUE,
      archived_at TEXT,
      last_seen_at TEXT,
      context_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_versions (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_label TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      context_short TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL,
      provenance_json TEXT,
      generated_at TEXT NOT NULL,
      superseded_at TEXT,
      UNIQUE (source_ref, version)
    );

    CREATE TABLE IF NOT EXISTS timeline_year_contexts (
      year INTEGER PRIMARY KEY,
      context_short TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      input_hash TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      synthesized INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_summary (
      id TEXT PRIMARY KEY,
      narrative TEXT NOT NULL DEFAULT '',
      eras_json TEXT NOT NULL DEFAULT '[]',
      input_hash TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- People. person_key is derived and stable ('contact:<pk>' survives forever),
    -- which is what lets a generated dossier outlive the rebuild that recomputes
    -- everything else about the person.
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      person_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'unknown',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unverified',
      is_pseudonym INTEGER NOT NULL DEFAULT 0,
      is_self INTEGER NOT NULL DEFAULT 0,
      seed_source TEXT,
      mention_count INTEGER NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      days_active INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT,
      last_seen TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      project_ids_json TEXT NOT NULL DEFAULT '[]',
      platforms_json TEXT NOT NULL DEFAULT '[]',
      dossier_short TEXT NOT NULL DEFAULT '',
      dossier TEXT NOT NULL DEFAULT '',
      dossier_hash TEXT,
      dossier_updated_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- A mention is an immutable fact about what one source said. person_id is
    -- ON DELETE SET NULL, not CASCADE: dropping a person must never destroy the
    -- evidence that produced them.
    CREATE TABLE IF NOT EXISTS people_mentions (
      id TEXT PRIMARY KEY,
      person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
      mention_key TEXT NOT NULL UNIQUE,
      raw_name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      handle_key TEXT,
      relation TEXT NOT NULL DEFAULT 'unknown',
      role TEXT NOT NULL DEFAULT '',
      aka_json TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_label TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      confidence REAL NOT NULL DEFAULT 0.6,
      resolution_rule TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS people_aliases (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'name',
      origin TEXT NOT NULL DEFAULT 'derived',
      created_at TEXT NOT NULL,
      UNIQUE (person_id, alias_key, kind)
    );

    -- User corrections. Read as an INPUT to every rebuild rather than written as
    -- an UPDATE, so a correction can never be silently undone by the next pass.
    -- One year of one person's message history, compressed. The middle layer that
    -- makes 29,000 messages fit a 30,000-character dossier.
    CREATE TABLE IF NOT EXISTS people_year_contexts (
      id TEXT PRIMARY KEY,
      person_key TEXT NOT NULL,
      year INTEGER NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      sampled_count INTEGER NOT NULL DEFAULT 0,
      input_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (person_key, year)
    );

    CREATE TABLE IF NOT EXISTS people_overrides (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      target TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (kind, subject)
    );

    -- One row per e-book found under a library-kind project's sources.
    --
    -- There is deliberately NO book text in this table or any table below it.
    -- Chapter text is re-derived from the file on disk whenever it is needed,
    -- which keeps book prose out of the database entirely: memory, recall and
    -- the document indexer have nothing here to stumble into. That absence is
    -- the feature, not an omission — do not add a text column.
    --
    -- identity_hash is stat-based (realpath+size+mtime), not a content hash:
    -- re-hashing a 400 MB shelf on every scan is minutes of disk I/O for a
    -- question stat already answers. text_hash IS content-based, and is the
    -- gate that tells annotations whether their offsets still mean anything.
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      format TEXT NOT NULL,
      identity_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      subtitle TEXT,
      authors_json TEXT NOT NULL DEFAULT '[]',
      publisher TEXT,
      published_date TEXT,
      language TEXT,
      identifier TEXT,
      subjects_json TEXT NOT NULL DEFAULT '[]',
      description TEXT,
      cover_data_url TEXT,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      scan_error TEXT,
      missing_since TEXT,
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (project_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS book_chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      spine_index INTEGER NOT NULL,
      href TEXT NOT NULL,
      anchor TEXT,
      title TEXT NOT NULL DEFAULT '',
      nav_depth INTEGER NOT NULL DEFAULT 0,
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0,
      page_start INTEGER,
      page_end INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (book_id, spine_index)
    );

    CREATE TABLE IF NOT EXISTS book_reading_state (
      book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'unread',
      last_chapter_index INTEGER NOT NULL DEFAULT 0,
      last_char_offset INTEGER NOT NULL DEFAULT 0,
      furthest_char_offset INTEGER NOT NULL DEFAULT 0,
      progress_percent REAL NOT NULL DEFAULT 0,
      rating INTEGER,
      started_at TEXT,
      finished_at TEXT,
      seconds_read INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    -- The evidence booksContext summarizes. A single progress number says what
    -- was read; sessions say how it was read, which is the behavior worth
    -- recording.
    CREATE TABLE IF NOT EXISTS book_reading_sessions (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      chapter_start INTEGER NOT NULL DEFAULT 0,
      chapter_end INTEGER NOT NULL DEFAULT 0,
      chars_advanced INTEGER NOT NULL DEFAULT 0,
      seconds INTEGER NOT NULL DEFAULT 0
    );

    -- Lessons and annotations are USER ARTIFACTS, not derived contexts, so they
    -- deliberately do not go through archiveContextVersion: nothing in them
    -- reaches chat, memory or the timeline. The one Books artifact that does —
    -- the root folder context in booksContext.ts — is archived by
    -- upsertDocumentFolderContext for free.
    CREATE TABLE IF NOT EXISTS book_lessons (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_start INTEGER NOT NULL,
      chapter_end INTEGER NOT NULL,
      title TEXT NOT NULL,
      overview TEXT NOT NULL DEFAULT '',
      objectives_json TEXT NOT NULL DEFAULT '[]',
      concepts_json TEXT NOT NULL DEFAULT '[]',
      questions_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      prompt_version TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      cost_usd REAL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT NOT NULL,
      UNIQUE (book_id, chapter_start, chapter_end)
    );

    -- Every attempt is kept, not just the latest: answering the same question
    -- three times is itself the record of learning.
    CREATE TABLE IF NOT EXISTS book_lesson_attempts (
      id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL REFERENCES book_lessons(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      choice_index INTEGER,
      correct INTEGER,
      self_rating INTEGER,
      revealed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- prompt_version carries the focus, so re-running the same focus is a cache
    -- hit on this UNIQUE while an edited custom focus is a new run. Same
    -- mechanism as styleVersion() in indexStyles.ts.
    CREATE TABLE IF NOT EXISTS book_annotation_runs (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      focus_key TEXT NOT NULL,
      focus_label TEXT NOT NULL,
      custom_focus TEXT,
      prompt_version TEXT NOT NULL,
      chapter_start INTEGER NOT NULL,
      chapter_end INTEGER NOT NULL,
      text_hash TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      annotation_count INTEGER NOT NULL DEFAULT 0,
      dropped_count INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (book_id, chapter_start, chapter_end, prompt_version)
    );

    -- quote + prefix + suffix is the W3C TextQuoteSelector: offsets alone cannot
    -- survive a re-edited EPUB, and an annotation that was true when written is
    -- never deleted — it becomes 'orphaned' and says so.
    CREATE TABLE IF NOT EXISTS book_annotations (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES book_annotation_runs(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      quote TEXT NOT NULL,
      prefix TEXT NOT NULL DEFAULT '',
      suffix TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'note',
      label TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'ai',
      pinned INTEGER NOT NULL DEFAULT 0,
      anchor_status TEXT NOT NULL DEFAULT 'exact',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Book discussions are deliberately NOT filed under the Books project: a
    -- project's conversations are summarized into conversation_contexts, which
    -- feed buildProjectSuperContext and the timeline — book prose in the life
    -- picture by the back door. This table is how the Library still finds them.
    CREATE TABLE IF NOT EXISTS book_conversations (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      chapter_index INTEGER,
      lesson_id TEXT,
      step_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (book_id, conversation_id)
    );

    -- One narration of one chapter. Audio lives on disk (megabytes each); what
    -- is stored here is the recipe and the timing.
    CREATE TABLE IF NOT EXISTS audiobook_chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_index INTEGER NOT NULL,
      -- Which service narrated. Recorded per chapter, not globally: a book part
      -- narrated before a key was swapped must still say who made it.
      provider TEXT NOT NULL DEFAULT 'elevenlabs',
      voice_id TEXT NOT NULL,
      voice_name TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      -- The canonical-text hash the timings were measured against. If the book
      -- is re-scanned and its text moves, these offsets no longer mean anything
      -- and the narration is stale rather than silently wrong.
      text_hash TEXT NOT NULL DEFAULT '',
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      character_count INTEGER NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (book_id, chapter_index)
    );

    -- One request's worth of audio. A chapter is several, because every model has
    -- a per-request character cap. They are kept as separate files rather than
    -- concatenated: MP3 frames do not join seamlessly, and a re-encode would put
    -- the reported timings out of step with the audio they describe.
    CREATE TABLE IF NOT EXISTS audiobook_segments (
      id TEXT PRIMARY KEY,
      audiobook_id TEXT NOT NULL REFERENCES audiobook_chapters(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
      byte_size INTEGER NOT NULL DEFAULT 0,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      /* Seconds of audio before this segment across the chapter. */
      offset_seconds REAL NOT NULL DEFAULT 0,
      request_id TEXT,
      -- Parallel arrays: absolute canonical offsets and segment-relative times.
      -- Stored as JSON rather than a row per word because a chapter has
      -- thousands of them and they are only ever read all at once.
      words_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE (audiobook_id, segment_index)
    );

    CREATE INDEX IF NOT EXISTS idx_audiobook_chapters_book
      ON audiobook_chapters(book_id, chapter_index);
    CREATE INDEX IF NOT EXISTS idx_audiobook_segments_book
      ON audiobook_segments(audiobook_id, segment_index);

    CREATE INDEX IF NOT EXISTS idx_books_project
      ON books(project_id, title);
    CREATE INDEX IF NOT EXISTS idx_book_chapters_book
      ON book_chapters(book_id, spine_index);
    CREATE INDEX IF NOT EXISTS idx_book_sessions_book
      ON book_reading_sessions(book_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_book_annotations_book
      ON book_annotations(book_id, chapter_index, char_start);
    CREATE INDEX IF NOT EXISTS idx_book_lesson_attempts
      ON book_lesson_attempts(lesson_id, question_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_activity_records_project
      ON activity_records(project_id);

    CREATE INDEX IF NOT EXISTS idx_browser_events_record
      ON browser_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_browser_events_occurred
      ON browser_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_youtube_events_record
      ON youtube_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_youtube_events_occurred
      ON youtube_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_amazon_events_record
      ON amazon_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_events_occurred
      ON amazon_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_email_events_record
      ON email_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_email_events_occurred
      ON email_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_events_record
      ON knowledge_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_events_occurred
      ON knowledge_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_photo_events_record
      ON photo_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_photo_events_occurred
      ON photo_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_location_events_record
      ON location_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_location_events_occurred
      ON location_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_weather_events_record
      ON weather_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_weather_events_occurred
      ON weather_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_subscription_events_record
      ON subscription_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_subscription_events_occurred
      ON subscription_events(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_account_events_record
      ON account_events(record_id);
    CREATE INDEX IF NOT EXISTS idx_account_events_provider
      ON account_events(provider, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_activity_accounts_project
      ON activity_accounts(project_id);
    CREATE INDEX IF NOT EXISTS idx_activity_account_sources_account
      ON activity_account_sources(account_id);

    CREATE INDEX IF NOT EXISTS idx_document_file_contexts_project
      ON document_file_contexts(project_id);
    CREATE INDEX IF NOT EXISTS idx_document_folder_contexts_project
      ON document_folder_contexts(project_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_events_start
      ON timeline_events(start_date);
    CREATE INDEX IF NOT EXISTS idx_timeline_events_source
      ON timeline_events(source_type);
    CREATE INDEX IF NOT EXISTS idx_timeline_events_project
      ON timeline_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_context_versions_ref
      ON context_versions(source_ref);
    CREATE INDEX IF NOT EXISTS idx_context_versions_generated
      ON context_versions(generated_at);
    CREATE INDEX IF NOT EXISTS idx_people_status
      ON people(status, score DESC);
    CREATE INDEX IF NOT EXISTS idx_people_relation
      ON people(relation);
    CREATE INDEX IF NOT EXISTS idx_people_mentions_person
      ON people_mentions(person_id);
    CREATE INDEX IF NOT EXISTS idx_people_mentions_name
      ON people_mentions(name_key);
    CREATE INDEX IF NOT EXISTS idx_people_mentions_project
      ON people_mentions(project_id);
    CREATE INDEX IF NOT EXISTS idx_people_mentions_source
      ON people_mentions(source_ref);
    CREATE INDEX IF NOT EXISTS idx_people_aliases_key
      ON people_aliases(alias_key, kind);
    CREATE INDEX IF NOT EXISTS idx_people_year_contexts_person
      ON people_year_contexts(person_key);
    -- The People seed layer groups 200k iMessage rows by counterparty on every
    -- rebuild; without this that is a full scan each time.
    CREATE INDEX IF NOT EXISTS idx_account_events_counterparty
      ON account_events(counterparty);

    -- Every outbound call to the connected provider, written by callLog.ts from
    -- the fetch layer. Bodies are stored truncated and the table is pruned to
    -- MAX_PROVIDER_CALL_ROWS, because a photo index run alone makes thousands of
    -- calls carrying a downscaled image each.
    CREATE TABLE IF NOT EXISTS provider_calls (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      feature TEXT,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      url TEXT NOT NULL,
      model TEXT,
      streamed INTEGER NOT NULL DEFAULT 0,
      status INTEGER,
      ok INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      cost_source TEXT,
      request TEXT NOT NULL DEFAULT '',
      request_truncated INTEGER NOT NULL DEFAULT 0,
      response TEXT NOT NULL DEFAULT '',
      response_truncated INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_provider_calls_created
      ON provider_calls(created_at DESC);

    -- One row per paired mobile client. public_key is the device's long-term
    -- X25519 key: deleting the row is what revocation means, so a revoked
    -- device can no longer complete a session handshake.
    CREATE TABLE IF NOT EXISTS remote_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      public_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
  `)

  seedDefaultProjects()
  migrateProjectIcons()
  seedMemoryFields()
  db.prepare("DELETE FROM memory_suggestions WHERE status != 'pending'").run()

  // Migrations for existing databases
  try {
    db.exec("ALTER TABLE people ADD COLUMN platforms_json TEXT NOT NULL DEFAULT '[]'")
  } catch { /* column already exists */ }

  // No CHECK constraint on `kind`, for the reason spelled out on
  // activity_records.source_type: the valid set is enforced by ProjectKind in
  // shared/defaultProjects.ts, and a CHECK here would mean a full table rebuild
  // every time a kind is added.
  try {
    db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard'")
  } catch { /* column already exists */ }
  // Idempotent backfill for a database that already held a hand-made Books row.
  db.prepare("UPDATE projects SET kind = 'library' WHERE name = ? AND kind = 'standard'")
    .run(BOOKS_PROJECT_NAME)

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN book_discussion INTEGER NOT NULL DEFAULT 0')
  } catch { /* column already exists */ }

  // Speech is billed per character, not per token. Storing that count in
  // input_tokens would have been a lie the UI then had to decode.
  try {
    db.exec('ALTER TABLE provider_calls ADD COLUMN char_count INTEGER')
  } catch { /* column already exists */ }

  try {
    db.exec("ALTER TABLE audiobook_chapters ADD COLUMN provider TEXT NOT NULL DEFAULT 'elevenlabs'")
  } catch { /* column already exists */ }
  try {
    db.exec("ALTER TABLE audiobook_segments ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'audio/mpeg'")
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT DEFAULT \'medium\'')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN system_prompt TEXT DEFAULT \'\'')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN memory_extracted_at INTEGER')
  } catch { /* column already exists */ }

  try {
    db.exec("ALTER TABLE conversations ADD COLUMN memory_mode TEXT DEFAULT 'detailed'")
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN context TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN role_id TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN analysis TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN path TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN relationship_analysis TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN health_analysis TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN activity_analysis TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN finances_summary TEXT')
  } catch { /* column already exists */ }

  // The Data page is an ordered list the user arranges by hand, and a source can
  // be hidden without being deleted. Existing rows default to visible; their
  // order seeds from the alphabetical listing they had before.
  try {
    db.exec('ALTER TABLE projects ADD COLUMN visible INTEGER NOT NULL DEFAULT 1')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    db.exec(`
      UPDATE projects SET sort_order = (
        SELECT COUNT(*) FROM projects AS earlier WHERE earlier.name < projects.name
      )
    `)
  } catch { /* column already exists */ }

  // A project can be kept out of the life picture entirely, and can be read as
  // something other than evidence about the person. Both default to today's
  // behavior, so an existing project is unchanged until the user says otherwise.
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN context_scope TEXT NOT NULL DEFAULT 'life'`)
  } catch { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE projects ADD COLUMN index_style TEXT NOT NULL DEFAULT 'behavioral'`)
  } catch { /* column already exists */ }

  // "Files" became "File System": the source that stands for what Holmes may
  // read, rooted at /. Renamed rather than replaced so its connected paths and
  // generated contexts survive.
  try {
    db.prepare(`UPDATE projects SET name = 'File System' WHERE name = 'Files'`).run()
  } catch { /* already renamed, or a 'File System' row already exists */ }

  // The "Data" project was a row for the page you are already looking at. It is
  // only removed when it carries nothing — a user who attached folders to it
  // keeps it, as an ordinary project they can delete themselves.
  try {
    const redundant = db
      .prepare(
        `SELECT p.id FROM projects AS p
         WHERE p.name = 'Data'
           AND p.path IS NULL
           AND NOT EXISTS (SELECT 1 FROM project_sources WHERE project_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM project_files WHERE project_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM document_file_contexts WHERE project_id = p.id)`
      )
      .get() as { id: string } | undefined
    if (redundant) {
      db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(redundant.id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(redundant.id)
    }
  } catch { /* nothing to retire */ }

  // Conversations gained a project *list*; the single column becomes the mirror
  // of its head. Existing rows seed the join table so nothing loses its project.
  try {
    db.exec(`
      INSERT OR IGNORE INTO conversation_projects (id, conversation_id, project_id, sort_order, created_at)
      SELECT lower(hex(randomblob(16))), c.id, c.project_id, 0, c.created_at
      FROM conversations AS c
      WHERE c.project_id IS NOT NULL
    `)
  } catch { /* the join table is new or already seeded */ }

  // Health ingestion used to record only a basename, so a rescan could not tell
  // an already-ingested file from a new one with the same name in another
  // folder — every scan re-ingested everything. The path plus a stat identity
  // makes a file recognizable across scans without re-reading it (an Apple
  // Health export is hundreds of megabytes; hashing it hourly is not an option).
  try {
    db.exec('ALTER TABLE health_records ADD COLUMN source_path TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE health_records ADD COLUMN identity_hash TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE activity_summary ADD COLUMN source_analyses_json TEXT NOT NULL DEFAULT \'[]\'')
  } catch { /* column already exists */ }

  // An account used to watch exactly one folder, stored on the account row.
  // That column is now the mirror of source #1, so any folder already set
  // becomes the account's first source. Idempotent via UNIQUE(account_id, path).
  try {
    db.exec(`
      INSERT OR IGNORE INTO activity_account_sources (id, account_id, path, sort_order, created_at)
      SELECT lower(hex(randomblob(16))), a.id, a.watch_path, 0, strftime('%s', 'now') * 1000
      FROM activity_accounts AS a
      WHERE a.watch_path IS NOT NULL AND TRIM(a.watch_path) != ''
    `)
  } catch { /* the sources table is new, or already seeded */ }

  // activity_records.source_type used to be pinned by a CHECK to the nine
  // source types that existed before the account registry. SQLite cannot alter
  // a CHECK, so adding a tenth would mean rebuilding the table — and so would
  // the eleventh. Rebuild once to drop the constraint entirely instead; the
  // valid set is enforced by isActivitySourceType() on the way in.
  //
  // The nine event tables reference this table with ON DELETE CASCADE. With
  // foreign_keys off, DROP + RENAME leaves those references pointing at the
  // new table, which is why the order below matters and why the result is
  // checked before the pragma goes back on.
  try {
    const existing = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'activity_records'")
      .get() as { sql: string } | undefined

    if (existing?.sql?.includes('CHECK (source_type')) {
      const before = (db.prepare('SELECT COUNT(*) AS n FROM activity_records').get() as { n: number }).n

      db.pragma('foreign_keys = OFF')
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE activity_records_new (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              source_type TEXT NOT NULL,
              filename TEXT,
              file_size INTEGER,
              content_hash TEXT,
              imported_at TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('pending','parsed','failed','needs_permission')),
              parse_error TEXT,
              events_count INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO activity_records_new
              SELECT id, project_id, source_type, filename, file_size, content_hash,
                     imported_at, status, parse_error, events_count
              FROM activity_records;
            DROP TABLE activity_records;
            ALTER TABLE activity_records_new RENAME TO activity_records;
            CREATE INDEX IF NOT EXISTS idx_activity_records_project
              ON activity_records(project_id);
          `)
        })()

        const after = (db.prepare('SELECT COUNT(*) AS n FROM activity_records').get() as { n: number }).n
        if (after !== before) {
          throw new Error(`activity_records rebuild lost rows: ${before} before, ${after} after`)
        }
        const violations = db.pragma('foreign_key_check') as unknown[]
        if (violations.length > 0) {
          throw new Error(`activity_records rebuild broke ${violations.length} foreign key(s)`)
        }
      } finally {
        db.pragma('foreign_keys = ON')
      }
    }
  } catch (err) {
    // Leaving the CHECK in place only blocks the new `account` source type; it
    // does not corrupt anything, so a failure here must not stop startup.
    console.error('Migration: could not drop the activity_records source_type CHECK', err)
  }

  try {
    db.exec('ALTER TABLE document_folder_contexts ADD COLUMN context_short TEXT NOT NULL DEFAULT \'\'')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE document_file_contexts ADD COLUMN kind TEXT NOT NULL DEFAULT \'text\'')
  } catch { /* column already exists */ }

  for (const column of ["context_short TEXT NOT NULL DEFAULT ''", "context TEXT NOT NULL DEFAULT ''", 'input_hash TEXT']) {
    try {
      db.exec(`ALTER TABLE document_summary ADD COLUMN ${column}`)
    } catch { /* column already exists */ }
  }

  // Backfill: every project that already had a directory becomes source #1, so
  // an existing install keeps indexing exactly what it indexed before. Idempotent
  // via the UNIQUE(project_id, path) constraint.
  try {
    const legacy = db
      .prepare("SELECT id, path FROM projects WHERE path IS NOT NULL AND TRIM(path) != ''")
      .all() as Array<{ id: string; path: string }>
    const insert = db.prepare(
      'INSERT OR IGNORE INTO project_sources (id, project_id, path, sort_order, created_at) VALUES (?, ?, ?, 0, ?)'
    )
    for (const row of legacy) insert.run(uuidv4(), row.id, row.path, Date.now())
  } catch { /* Backfill is best-effort; the table may not exist on a partial init. */ }

  // Provenance: nullable everywhere, so contexts indexed before this existed
  // read back as "chain unknown" rather than as a fabricated chain. The indexer
  // backfills them from cached child hashes on its next pass — no LLM calls.
  for (const table of ['document_file_contexts', 'document_folder_contexts', 'user_super_context', 'context_versions']) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN provenance_json TEXT`)
    } catch { /* column already exists */ }
  }

  try {
    db.exec('ALTER TABLE timeline_events ADD COLUMN archived_at TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE timeline_events ADD COLUMN last_seen_at TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE timeline_events ADD COLUMN context_version_id TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec("ALTER TABLE memory_suggestions ADD COLUMN merge_strategy TEXT NOT NULL DEFAULT 'replace'")
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN reasoning TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN is_active INTEGER DEFAULT 1')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN tool_calls_json TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT')
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN tool_name TEXT')
  } catch { /* column already exists */ }

  // Widen the role CHECK constraint to allow 'tool' messages.
  // SQLite can't ALTER a CHECK in place, so rebuild the table if the old constraint is present.
  try {
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get() as { sql: string } | undefined)?.sql || ''
    if (tableSql.includes("CHECK(role IN ('user','assistant','system'))")) {
      // Drop FTS triggers and external-content table first; they'll be recreated below.
      db.exec(`
        DROP TRIGGER IF EXISTS messages_fts_insert;
        DROP TRIGGER IF EXISTS messages_fts_delete;
        DROP TRIGGER IF EXISTS messages_fts_update;
        DROP TABLE IF EXISTS messages_fts;
      `)
      db.exec(`
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          token_count INTEGER,
          model TEXT,
          reasoning TEXT,
          parent_id TEXT,
          is_active INTEGER DEFAULT 1,
          tool_calls_json TEXT,
          tool_call_id TEXT,
          tool_name TEXT
        );
        INSERT INTO messages_new (id, conversation_id, role, content, created_at, token_count, model, reasoning, parent_id, is_active, tool_calls_json, tool_call_id, tool_name)
        SELECT id, conversation_id, role, content, created_at, token_count, model, reasoning, parent_id, is_active, tool_calls_json, tool_call_id, tool_name FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
      `)
    }
  } catch { /* table already has widened constraint or rebuild failed */ }

  // Runs after the role-CHECK rebuild above so the rebuild's explicit column list can't drop it.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN attachments_json TEXT')
  } catch { /* column already exists */ }

  // Backfill parent_id for existing messages: chain by created_at within each conversation
  const convIds = db.prepare('SELECT DISTINCT conversation_id FROM messages WHERE parent_id IS NULL').all() as Array<{ conversation_id: string }>
  for (const { conversation_id } of convIds) {
    const msgs = db.prepare('SELECT id, parent_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation_id) as Array<{ id: string, parent_id: string | null }>
    let prevId: string | null = null
    for (const msg of msgs) {
      if (!msg.parent_id && prevId) {
        db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run(prevId, msg.id)
      }
      prevId = msg.id
    }
  }

  // Enable FTS for message search
  try {
    const existingTriggerCount = (db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('messages_fts_insert', 'messages_fts_delete', 'messages_fts_update')"
    ).get() as { count: number }).count
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content=messages, content_rowid=rowid);

      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `)
    if (existingTriggerCount < 3) {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')")
    }
  } catch {
    // FTS table may already exist
  }

  // After the migrations, not with seedDefaultProjects: this inserts a `kind`,
  // and on an existing database that column only exists once the ALTER above
  // has run.
  ensureMediaProjects()
}

export function runInTransaction<T>(fn: () => T): T {
  const tx = db.transaction(fn)
  return tx()
}

export function closeDatabase(): void {
  if (db) db.close()
}

// Conversation CRUD
export function listConversations(): Conversation[] {
  const rows = db
    .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
    .all() as Array<{
    id: string
    title: string
    model: string | null
    system_prompt: string
    project_id: string | null
    reasoning_effort: string
    memory_mode: string | null
    context: string | null
    role_id: string | null
    created_at: number
    updated_at: number
  }>
  // One query for every membership rather than one per conversation: the sidebar
  // lists hundreds of these.
  const memberships = db
    .prepare('SELECT conversation_id, project_id FROM conversation_projects ORDER BY sort_order ASC')
    .all() as Array<{ conversation_id: string; project_id: string }>
  const byConversation = new Map<string, string[]>()
  for (const row of memberships) {
    const list = byConversation.get(row.conversation_id)
    if (list) list.push(row.project_id)
    else byConversation.set(row.conversation_id, [row.project_id])
  }
  return rows.map((row) => mapConversation(row, byConversation.get(row.id)))
}

export function createConversation(
  model?: string,
  effort?: ReasoningEffort,
  projectId?: string,
  memoryMode?: MemoryMode,
  context?: ContextSelection,
  roleId?: string | null
): Conversation {
  const id = uuidv4()
  const now = Date.now()
  const normalizedContext = context ? normalizeContextSelection(context) : null
  const contextJson = normalizedContext ? JSON.stringify(normalizedContext) : null
  db.prepare(
    'INSERT INTO conversations (id, title, model, project_id, reasoning_effort, memory_mode, context, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'New Chat', model || null, projectId || null, effort || 'medium', memoryMode || 'detailed', contextJson, roleId || null, now, now)
  // A conversation belongs to every project its context points at — the one
  // passed in explicitly stays the head of that list.
  const contextProjectIds = projectsFromContextSelection(normalizedContext)
  const projectIds = projectId ? [projectId, ...contextProjectIds] : contextProjectIds
  if (projectIds.length > 0) setConversationProjects(id, projectIds)
  return {
    id,
    title: 'New Chat',
    model: model || null,
    systemPrompt: '',
    projectId: projectIds[0] ?? projectId ?? null,
    projectIds,
    reasoningEffort: (effort as ReasoningEffort) || 'medium',
    memoryMode: (memoryMode as MemoryMode) || 'detailed',
    context: normalizedContext || { kind: 'none' },
    roleId: roleId || null,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateConversationRole(id: string, roleId: string | null): void {
  db.prepare('UPDATE conversations SET role_id = ?, updated_at = ? WHERE id = ?').run(roleId || null, Date.now(), id)
}

export function deleteConversation(id: string): void {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function listConversationProjectIds(conversationId: string): string[] {
  const rows = db
    .prepare('SELECT project_id FROM conversation_projects WHERE conversation_id = ? ORDER BY sort_order ASC')
    .all(conversationId) as Array<{ project_id: string }>
  return rows.map((row) => row.project_id)
}

export function listProjectConversationIds(projectId: string): string[] {
  const rows = db
    .prepare(
      `SELECT cp.conversation_id AS id
       FROM conversation_projects AS cp
       JOIN conversations AS c ON c.id = cp.conversation_id
       WHERE cp.project_id = ?
       ORDER BY c.updated_at DESC`
    )
    .all(projectId) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

// The whole membership list in one write. `conversations.project_id` mirrors the
// head of it, because Psychology, memory evidence and the older queries all
// still read that column.
export function setConversationProjects(conversationId: string, projectIds: string[]): void {
  const unique: string[] = []
  for (const projectId of projectIds) {
    if (projectId && !unique.includes(projectId)) unique.push(projectId)
  }
  const insert = db.prepare(
    'INSERT OR IGNORE INTO conversation_projects (id, conversation_id, project_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const now = Date.now()
  runInTransaction(() => {
    db.prepare('DELETE FROM conversation_projects WHERE conversation_id = ?').run(conversationId)
    unique.forEach((projectId, index) => insert.run(uuidv4(), conversationId, projectId, index, now))
    db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(unique[0] ?? null, conversationId)
  })
}

export function conversationExists(id: string): boolean {
  const row = db.prepare('SELECT 1 AS hit FROM conversations WHERE id = ?').get(id) as { hit: number } | undefined
  return Boolean(row?.hit)
}

export function importConversation(record: {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  projectId?: string | null
}): boolean {
  const existing = db.prepare('SELECT 1 AS hit FROM conversations WHERE id = ?').get(record.id) as { hit: number } | undefined
  if (existing?.hit) return false
  db.prepare(
    'INSERT INTO conversations (id, title, model, system_prompt, project_id, reasoning_effort, memory_mode, context, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)'
  ).run(
    record.id,
    record.title || 'Imported from Claude',
    '',
    record.projectId || null,
    'medium',
    'detailed',
    record.createdAt,
    record.updatedAt
  )
  return true
}

export function importMessage(record: {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}): boolean {
  const existing = db.prepare('SELECT 1 AS hit FROM messages WHERE id = ?').get(record.id) as { hit: number } | undefined
  if (existing?.hit) return false
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at, token_count, model) VALUES (?, ?, ?, ?, ?, NULL, NULL)'
  ).run(record.id, record.conversationId, record.role, record.content, record.createdAt)
  return true
}

export function renameConversation(id: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    Date.now(),
    id
  )
}

export function updateConversationModel(id: string, model: string): void {
  db.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?').run(
    model,
    Date.now(),
    id
  )
}

export function updateConversationEffort(id: string, effort: ReasoningEffort): void {
  db.prepare('UPDATE conversations SET reasoning_effort = ?, updated_at = ? WHERE id = ?').run(
    effort,
    Date.now(),
    id
  )
}

export function updateConversationMemoryMode(id: string, mode: MemoryMode): void {
  db.prepare('UPDATE conversations SET memory_mode = ?, updated_at = ? WHERE id = ?').run(
    mode,
    Date.now(),
    id
  )
}

// Which projects a context selection points at, in the order it stacks them and
// filtered to projects that still exist.
export function projectsFromContextSelection(context: ContextSelection | null | undefined): string[] {
  const items = flattenContextSelection(context)
  const ids = items.flatMap((item) => (item.kind === 'project' ? [item.projectId] : []))
  if (ids.length === 0) return []
  const existing = new Set(
    (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((row) => row.id)
  )
  return ids.filter((id) => existing.has(id))
}

export function updateConversationContext(id: string, context: ContextSelection): void {
  const normalized = normalizeContextSelection(context)
  db.prepare('UPDATE conversations SET context = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(normalized),
    Date.now(),
    id
  )
  // Re-pointing a conversation's context re-files it: it lives under whichever
  // projects it now draws on, and leaves the ones it no longer does.
  setConversationProjects(id, projectsFromContextSelection(normalized))
}

export function updateConversationSystemPrompt(id: string, prompt: string): void {
  db.prepare('UPDATE conversations SET system_prompt = ?, updated_at = ? WHERE id = ?').run(
    prompt,
    Date.now(),
    id
  )
}

// Messages
export function getMessages(conversationId: string): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as Array<{
    id: string
    conversation_id: string
    role: string
    content: string
    reasoning: string | null
    parent_id: string | null
    is_active: number
    created_at: number
    token_count: number | null
    model: string | null
    tool_calls_json: string | null
    tool_call_id: string | null
    tool_name: string | null
    attachments_json: string | null
  }>

  const allMessages = rows.map(mapMessage)

  // Build children map: parent_id (null for roots) -> children
  const childrenMap = new Map<string | null, Message[]>()
  for (const msg of allMessages) {
    const parentKey = msg.parentId || null
    const list = childrenMap.get(parentKey) || []
    list.push(msg)
    childrenMap.set(parentKey, list)
  }

  // Traverse active path from roots
  const result: Message[] = []
  let currentLevel: Message[] | undefined = childrenMap.get(null)

  while (currentLevel && currentLevel.length > 0) {
    const active = currentLevel.find((m) => {
      const row = rows.find((r) => r.id === m.id)
      return row?.is_active === 1
    }) || currentLevel[0]

    active.siblingCount = currentLevel.length
    active.siblingIndex = currentLevel.indexOf(active)
    active.siblingIds = currentLevel.map((m) => m.id)

    result.push(active)
    currentLevel = childrenMap.get(active.id)
  }

  return result
}

export function addMessage(message: Omit<Message, 'id' | 'createdAt'>): Message {
  const id = uuidv4()
  const now = Date.now()
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, reasoning, created_at, token_count, model, parent_id, is_active, tool_calls_json, tool_call_id, tool_name, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    message.conversationId,
    message.role,
    message.content,
    message.reasoning || null,
    now,
    message.tokenCount || null,
    message.model || null,
    message.parentId || null,
    1,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    message.toolCallId || null,
    message.toolName || null,
    message.attachments && message.attachments.length > 0 ? JSON.stringify(message.attachments) : null,
  )

  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, message.conversationId)
  return { ...message, id, createdAt: now }
}

export function getMessageById(messageId: string): Message | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | {
        id: string
        conversation_id: string
        role: string
        content: string
        reasoning: string | null
        parent_id: string | null
        is_active: number
        created_at: number
        token_count: number | null
        model: string | null
        tool_calls_json: string | null
        tool_call_id: string | null
        tool_name: string | null
        attachments_json: string | null
      }
    | undefined
  return row ? mapMessage(row) : null
}

export function findRetryTargetUserMessage(messageId: string): Message | null {
  let current = getMessageById(messageId)
  const seen = new Set<string>([messageId])
  while (current) {
    if (current.role === 'user') return current
    if (!current.parentId || seen.has(current.parentId)) return null
    seen.add(current.parentId)
    current = getMessageById(current.parentId)
  }
  return null
}

export function getMessagesUpTo(conversationId: string, messageId: string): Message[] {
  const messages = getMessages(conversationId)
  const index = messages.findIndex((m) => m.id === messageId)
  return index === -1 ? messages : messages.slice(0, index + 1)
}

export function deactivateMessage(messageId: string): void {
  db.prepare('UPDATE messages SET is_active = 0 WHERE id = ?').run(messageId)
}

export function deactivateChildren(parentId: string): void {
  db.prepare('UPDATE messages SET is_active = 0 WHERE parent_id = ?').run(parentId)
}

export function setActiveBranch(messageId: string): void {
  const msg = db.prepare('SELECT conversation_id, parent_id FROM messages WHERE id = ?').get(messageId) as
    | { conversation_id: string, parent_id: string | null }
    | undefined
  if (!msg) return

  if (msg.parent_id) {
    db.prepare('UPDATE messages SET is_active = 0 WHERE parent_id = ? AND conversation_id = ?').run(msg.parent_id, msg.conversation_id)
  } else {
    db.prepare('UPDATE messages SET is_active = 0 WHERE parent_id IS NULL AND conversation_id = ?').run(msg.conversation_id)
  }
  db.prepare('UPDATE messages SET is_active = 1 WHERE id = ?').run(messageId)
}

export function searchConversations(query: string): SearchResult[] {
  const rows = db
    .prepare(
      `SELECT m.id as messageId, m.conversation_id as conversationId, m.content, c.title as conversationTitle
       FROM messages m
       INNER JOIN messages_fts fts ON m.rowid = fts.rowid
       LEFT JOIN conversations c ON m.conversation_id = c.id
       WHERE messages_fts MATCH ?
       ORDER BY m.created_at DESC
       LIMIT 20`
    )
    .all(query) as Array<{
    messageId: string
    conversationId: string
    content: string
    conversationTitle: string
  }>
  return rows.map((r) => ({
    messageId: r.messageId,
    conversationId: r.conversationId,
    content: r.content,
    conversationTitle: r.conversationTitle,
  }))
}

export interface RecallConversationDocument {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: Message['role']
  content: string
  createdAt: number
}

export function searchRecallConversationDocuments(
  terms: string[],
  limit: number = 1000
): RecallConversationDocument[] {
  const normalizedTerms = [...new Set(terms
    .map((term) => term.normalize('NFKC').trim())
    .filter((term) => term.length > 0))]
    .slice(0, 24)

  if (normalizedTerms.length === 0) return []

  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000))
  const ftsQuery = normalizedTerms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ')
  const rows = db.prepare(
    `WITH matched_messages AS (
       SELECT
         m.id AS messageId,
         m.conversation_id AS conversationId,
         c.title AS conversationTitle,
         m.role,
         m.content,
         m.created_at AS createdAt,
         messages_fts.rank AS searchRank
       FROM messages_fts
       INNER JOIN messages m ON m.rowid = messages_fts.rowid
       INNER JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ?
       ORDER BY messages_fts.rank ASC
       LIMIT 3000
     ), ranked_messages AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY conversationId
         ORDER BY searchRank ASC, createdAt DESC
       ) AS matchPosition
       FROM matched_messages
     )
     SELECT messageId, conversationId, conversationTitle, role, content, createdAt
     FROM ranked_messages
     WHERE matchPosition <= 3
     ORDER BY searchRank ASC, createdAt DESC
     LIMIT ?`
  ).all(ftsQuery, safeLimit) as Array<{
    messageId: string
    conversationId: string
    conversationTitle: string
    role: Message['role']
    content: string
    createdAt: number
  }>

  const loweredTerms = normalizedTerms.map((term) => term.toLocaleLowerCase())
  const titleConversationIds = (db.prepare(
    'SELECT id, title FROM conversations ORDER BY updated_at DESC LIMIT 5000'
  ).all() as Array<{
    id: string
    title: string
  }>)
    .filter((conversation) => {
      const title = conversation.title.normalize('NFKC').toLocaleLowerCase()
      return loweredTerms.some((term) => title.includes(term))
    })
    .map((conversation) => conversation.id)
    .slice(0, 100)

  if (titleConversationIds.length === 0) return rows
  const placeholders = titleConversationIds.map(() => '?').join(', ')
  const titleRows = db.prepare(
    `WITH ranked_messages AS (
       SELECT
         m.id AS messageId,
         m.conversation_id AS conversationId,
         c.title AS conversationTitle,
         m.role,
         m.content,
         m.created_at AS createdAt,
         ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC) AS messagePosition
       FROM messages m
       INNER JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id IN (${placeholders})
     )
     SELECT messageId, conversationId, conversationTitle, role, content, createdAt
     FROM ranked_messages
     WHERE messagePosition = 1`
  ).all(...titleConversationIds) as RecallConversationDocument[]

  const seenMessageIds = new Set(rows.map((row) => row.messageId))
  return [...rows, ...titleRows.filter((row) => !seenMessageIds.has(row.messageId))]
}

export function searchMemoryConversationDocuments(
  terms: string[],
  limit: number = 60
): RecallConversationDocument[] {
  const normalizedTerms = [...new Set(terms
    .map((term) => term.normalize('NFKC').trim())
    .filter((term) => term.length > 0))]
    .slice(0, 24)
  if (normalizedTerms.length === 0) return []

  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100))
  const ftsQuery = normalizedTerms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ')
  return db.prepare(
    `SELECT
       m.id AS messageId,
       m.conversation_id AS conversationId,
       c.title AS conversationTitle,
       m.role,
       m.content,
       m.created_at AS createdAt
     FROM messages_fts
     INNER JOIN messages m ON m.rowid = messages_fts.rowid
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE messages_fts MATCH ? AND m.role = 'user'
       -- Memory never reads a conversation filed under a separate-context project.
       AND NOT EXISTS (
         SELECT 1 FROM conversation_projects cp
         JOIN projects p ON p.id = cp.project_id
         WHERE cp.conversation_id = m.conversation_id AND p.context_scope = 'separate'
       )
     ORDER BY messages_fts.rank ASC, m.created_at DESC
     LIMIT ?`
  ).all(ftsQuery, safeLimit) as RecallConversationDocument[]
}

export function getRecallConversationContext(messageId: string): string {
  const rows = db.prepare(
    `WITH target AS (
       SELECT conversation_id, created_at
       FROM messages
       WHERE id = ?
     ), nearest AS (
       SELECT m.role, m.content, m.created_at AS createdAt
       FROM messages m, target
       WHERE m.conversation_id = target.conversation_id
       ORDER BY ABS(m.created_at - target.created_at) ASC
       LIMIT 5
     )
     SELECT role, content, createdAt
     FROM nearest
     ORDER BY createdAt ASC`
  ).all(messageId) as Array<{
    role: Message['role']
    content: string
    createdAt: number
  }>

  return rows.map((row) => {
    const speaker = row.role === 'assistant' ? getAssistantName() : row.role === 'user' ? 'You' : 'System'
    return `${speaker}: ${row.content}`
  }).join('\n\n')
}

export function searchMessages(query: string): Message[] {
  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       INNER JOIN messages_fts fts ON m.id = fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY m.created_at DESC
       LIMIT 50`
    )
    .all(query) as Array<{
    id: string
    conversation_id: string
    role: string
    content: string
    reasoning: string | null
    parent_id: string | null
    is_active: number
    created_at: number
    token_count: number | null
    model: string | null
    tool_calls_json: string | null
    tool_call_id: string | null
    tool_name: string | null
    attachments_json: string | null
  }>
  return rows.map(mapMessage)
}

const INSERT_DEFAULT_PROJECT_SQL =
  'INSERT INTO projects (id, name, icon, color, kind, path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

export function restoreDefaultProjects(): void {
  const existing = db.prepare('SELECT name FROM projects').all() as Array<{ name: string }>
  const existingNames = new Set(existing.map((r) => r.name))

  const defaults = DEFAULT_PROJECTS.map((p) => ({ ...p }))

  const now = Date.now()
  const tail = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM projects').get() as { max: number }
  let position = tail.max
  const insert = db.prepare(INSERT_DEFAULT_PROJECT_SQL)
  for (const p of defaults) {
    if (!existingNames.has(p.name)) {
      position += 1
      insert.run(uuidv4(), p.name, p.icon, p.color, projectKindForCategory(p.category), null, position, now, now)
    }
  }
}

function seedDefaultProjects(): void {
  const count = db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }
  if (count.count > 0) return

  const defaults = DEFAULT_PROJECTS.map((p) => ({ ...p, path: null, files: [] as string[] }))
  const now = Date.now()
  const insert = db.prepare(INSERT_DEFAULT_PROJECT_SQL)
  // Seeded in declaration order, which is the order the Data page shows first.
  defaults.forEach((p, index) => {
    insert.run(uuidv4(), p.name, p.icon, p.color, projectKindForCategory(p.category), null, index, now, now)
  })
}

/**
 * Media sources arrived after the life ones, so every existing install has no
 * Books row and no reason to press "Restore defaults" to get one.
 *
 * Narrow on purpose: only the media category is auto-provisioned. The life
 * defaults keep their restore-on-demand semantics, and a Books row the user
 * HID is not re-inserted — hidden is a state of an existing row, not absence.
 */
function ensureMediaProjects(): void {
  const media = DEFAULT_PROJECTS.filter((p) => p.category === 'media')
  if (media.length === 0) return

  const existing = db.prepare('SELECT name FROM projects').all() as Array<{ name: string }>
  const existingNames = new Set(existing.map((r) => r.name))
  const missing = media.filter((p) => !existingNames.has(p.name))
  if (missing.length === 0) return

  const now = Date.now()
  const tail = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM projects').get() as { max: number }
  let position = tail.max
  const insert = db.prepare(INSERT_DEFAULT_PROJECT_SQL)
  for (const p of missing) {
    position += 1
    insert.run(uuidv4(), p.name, p.icon, p.color, projectKindForCategory(p.category), null, position, now, now)
  }
}

function migrateProjectIcons(): void {
  const legacyIcons = [
    [String.fromCodePoint(0x1f4c1), 'folder'],
    [String.fromCodePoint(0x1f9e0), 'brain'],
    [String.fromCodePoint(0x1f49a), 'heart'],
    [String.fromCodePoint(0x1f4b0), 'sack-dollar'],
    [String.fromCodePoint(0x1f4c2), 'folder-open'],
    [String.fromCodePoint(0x1f3cb, 0xfe0f), 'dumbbell'],
    [String.fromCodePoint(0x1f3cb), 'dumbbell'],
  ] as const
  const update = db.prepare('UPDATE projects SET icon = ? WHERE icon = ?')

  for (const [legacyIcon, icon] of legacyIcons) {
    update.run(icon, legacyIcon)
  }
}

function seedMemoryFields(): void {
  const now = Date.now()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_fields (
      id, field_key, category, label, value_type, value_json, origin, confidence,
      locked, sensitive, custom, sort_order, sources_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, 0, ?, '[]', 0, ?, ?)`
  )
  const seed = db.transaction(() => {
    for (const field of MEMORY_FIELDS) {
      insert.run(
        field.key,
        field.key,
        field.category,
        field.label,
        field.valueType,
        field.sensitive ? 1 : 0,
        field.sortOrder,
        now,
        now
      )
    }
  })
  seed()
}

interface MemoryFieldRow {
  id: string
  field_key: string
  category: string
  label: string
  value_type: MemoryValueType
  value_json: string | null
  origin: MemoryOrigin | null
  confidence: number | null
  locked: number
  sensitive: number
  custom: number
  sort_order: number
  sources_json: string
  revision: number
  created_at: number
  updated_at: number
}

function parseStoredJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function mapMemoryField(row: MemoryFieldRow): MemoryField {
  return {
    id: row.id,
    fieldKey: row.field_key,
    category: row.category,
    label: row.label,
    valueType: row.value_type,
    value: parseStoredJson<MemoryValue | null>(row.value_json, null),
    origin: row.origin,
    confidence: row.confidence,
    locked: Boolean(row.locked),
    sensitive: Boolean(row.sensitive),
    custom: Boolean(row.custom),
    sortOrder: row.sort_order,
    sources: parseStoredJson<MemorySource[]>(row.sources_json, []),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listMemoryFields(): MemoryField[] {
  return (db.prepare(
    'SELECT * FROM memory_fields ORDER BY sort_order ASC, label COLLATE NOCASE ASC'
  ).all() as MemoryFieldRow[]).map(mapMemoryField)
}

export function getMemoryFieldValue(category: string, fieldKey: string): MemoryValue | null {
  const row = db.prepare('SELECT * FROM memory_fields WHERE category = ? AND field_key = ?').get(category, fieldKey) as MemoryFieldRow | undefined
  return row ? mapMemoryField(row).value : null
}

export function updateMemoryField(request: MemoryUpdateRequest): MemoryField[] {
  const current = db.prepare('SELECT * FROM memory_fields WHERE id = ?').get(request.fieldId) as MemoryFieldRow | undefined
  if (!current) throw new Error('Memory field not found')
  if (current.revision !== request.expectedRevision) throw new Error('Memory field changed; reload and try again')

  const valueJson = request.value === null ? null : JSON.stringify(request.value)
  const valueChanged = valueJson !== current.value_json
  const now = Date.now()
  const origin = valueChanged ? (request.value === null ? null : 'manual') : current.origin
  const confidence = valueChanged ? null : current.confidence
  const sources = valueChanged
    ? (request.value === null ? [] : [{
        type: 'manual' as const,
        reference: current.field_key,
        label: 'Entered by you',
        capturedAt: now,
      }])
    : parseStoredJson<MemorySource[]>(current.sources_json, [])

  const update = db.transaction(() => {
    const result = db.prepare(
      `UPDATE memory_fields
       SET value_json = ?, origin = ?, confidence = ?, locked = ?, sources_json = ?,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`
    ).run(
      valueJson,
      origin,
      confidence,
      request.locked ? 1 : 0,
      JSON.stringify(sources),
      now,
      request.fieldId,
      request.expectedRevision
    )
    if (result.changes !== 1) throw new Error('Memory field changed; reload and try again')
    db.prepare("DELETE FROM memory_suggestions WHERE field_id = ? AND status = 'pending'")
      .run(request.fieldId)
  })
  update()
  return listMemoryFields()
}

export function createMemoryField(request: MemoryCreateFieldRequest): MemoryField[] {
  const id = uuidv4()
  const now = Date.now()
  const maxSort = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS value FROM memory_fields WHERE category = ?'
  ).get(request.category) as { value: number }
  db.prepare(
    `INSERT INTO memory_fields (
      id, field_key, category, label, value_type, value_json, origin, confidence,
      locked, sensitive, custom, sort_order, sources_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, 1, ?, '[]', 0, ?, ?)`
  ).run(
    id,
    `custom_${id.replace(/-/g, '')}`,
    request.category,
    request.label,
    request.valueType,
    request.sensitive ? 1 : 0,
    maxSort.value + 1,
    now,
    now
  )
  return listMemoryFields()
}

export function deleteMemoryField(fieldId: string): MemoryField[] {
  const result = db.prepare('DELETE FROM memory_fields WHERE id = ? AND custom = 1').run(fieldId)
  if (result.changes !== 1) throw new Error('Only custom Memory fields can be deleted')
  return listMemoryFields()
}

interface MemorySuggestionRow {
  id: string
  field_id: string
  field_key: string
  field_label: string
  category: string
  value_json: string
  confidence: number
  rationale: string
  sources_json: string
  base_revision: number
  created_at: number
  merge_strategy: string
}

export function listMemorySuggestions(): MemorySuggestion[] {
  const rows = db.prepare(
    `SELECT
       s.id, s.field_id, f.field_key, f.label AS field_label, f.category,
       s.value_json, s.confidence, s.rationale, s.sources_json,
       s.base_revision, s.created_at, s.merge_strategy
     FROM memory_suggestions s
     INNER JOIN memory_fields f ON f.id = s.field_id
     WHERE s.status = 'pending'
     ORDER BY s.created_at DESC`
  ).all() as MemorySuggestionRow[]
  return rows.map((row) => ({
    id: row.id,
    fieldId: row.field_id,
    fieldKey: row.field_key,
    fieldLabel: row.field_label,
    category: row.category,
    value: parseStoredJson<MemoryValue>(row.value_json, ''),
    confidence: row.confidence,
    rationale: row.rationale,
    sources: parseStoredJson<MemorySource[]>(row.sources_json, []),
    baseRevision: row.base_revision,
    createdAt: row.created_at,
    mergeStrategy: (row.merge_strategy || 'replace') as MemoryMergeStrategy,
  }))
}

export function applyMemoryCandidates(candidates: MemoryCandidate[]): {
  autoFilled: number
  suggestionsCreated: number
} {
  let autoFilled = 0
  let suggestionsCreated = 0
  const getField = db.prepare('SELECT * FROM memory_fields WHERE field_key = ?')
  const fillField = db.prepare(
    `UPDATE memory_fields
     SET value_json = ?, origin = 'ai', confidence = ?, sources_json = ?,
         revision = revision + 1, updated_at = ?
     WHERE id = ? AND revision = ? AND locked = 0 AND value_json IS NULL`
  )
  const deleteSuggestions = db.prepare(
    "DELETE FROM memory_suggestions WHERE field_id = ? AND status = 'pending'"
  )
  const insertSuggestion = db.prepare(
    `INSERT INTO memory_suggestions (
      id, field_id, value_json, confidence, rationale, sources_json,
      status, base_revision, created_at, reviewed_at, merge_strategy
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?)`
  )

  const apply = db.transaction(() => {
    for (const candidate of candidates) {
      const field = getField.get(candidate.fieldKey) as MemoryFieldRow | undefined
      if (!field || field.locked) continue
      const valueJson = JSON.stringify(candidate.value)
      if (field.value_json === valueJson) {
        deleteSuggestions.run(field.id)
        continue
      }
      const now = Date.now()
      if (field.value_json === null) {
        const result = fillField.run(
          valueJson,
          candidate.confidence,
          JSON.stringify(candidate.sources),
          now,
          field.id,
          field.revision
        )
        if (result.changes === 1) {
          deleteSuggestions.run(field.id)
          autoFilled += 1
        }
        continue
      }

      deleteSuggestions.run(field.id)
      insertSuggestion.run(
        uuidv4(),
        field.id,
        valueJson,
        candidate.confidence,
        candidate.rationale,
        JSON.stringify(candidate.sources),
        field.revision,
        now,
        candidate.mergeStrategy || 'replace'
      )
      suggestionsCreated += 1
    }
  })
  apply()
  return { autoFilled, suggestionsCreated }
}

export function reviewMemorySuggestion(request: MemorySuggestionReviewRequest): {
  fields: MemoryField[]
  suggestions: MemorySuggestion[]
} {
  const suggestion = db.prepare(
    `SELECT s.*, f.revision AS field_revision, f.locked AS field_locked, f.origin AS field_origin,
            f.value_json AS field_value_json, f.value_type AS field_value_type, f.sources_json AS field_sources_json
     FROM memory_suggestions s
     INNER JOIN memory_fields f ON f.id = s.field_id
     WHERE s.id = ? AND s.status = 'pending'`
  ).get(request.suggestionId) as (MemorySuggestionRow & {
    value_json: string
    field_revision: number
    field_locked: number
    field_origin: MemoryOrigin | null
    field_value_json: string | null
    field_value_type: MemoryValueType
    field_sources_json: string
  }) | undefined
  if (!suggestion) throw new Error('Memory suggestion not found')

  const now = Date.now()
  if (request.decision === 'reject') {
    db.prepare('DELETE FROM memory_suggestions WHERE id = ?').run(request.suggestionId)
    return { fields: listMemoryFields(), suggestions: listMemorySuggestions() }
  }
  if (suggestion.field_locked) throw new Error('Unlock this Memory field before accepting a suggestion')
  if (suggestion.field_revision !== request.expectedRevision || suggestion.base_revision !== request.expectedRevision) {
    throw new Error('Memory field changed; review the latest value before accepting')
  }
  if (suggestion.field_origin === 'manual' && !request.confirmOverwriteManual) {
    throw new Error('Confirm replacing the value you entered manually')
  }

  const candidateValue = parseStoredJson<MemoryValue>(suggestion.value_json, '')
  const strategy = request.applyAsMerge
    ? 'merge'
    : (suggestion.merge_strategy || 'replace') as MemoryMergeStrategy
  const currentValue = suggestion.field_value_json
    ? parseStoredJson<MemoryValue | null>(suggestion.field_value_json, null)
    : null
  const finalValue = (strategy === 'merge' || strategy === 'supplement') && currentValue !== null
    ? mergeMemoryValue(currentValue, candidateValue, suggestion.field_value_type)
    : candidateValue
  const finalValueJson = JSON.stringify(finalValue)
  const candidateSources = parseStoredJson<MemorySource[]>(suggestion.sources_json, [])
  const existingSources = parseStoredJson<MemorySource[]>(suggestion.field_sources_json, [])
  const finalSources = strategy === 'replace'
    ? candidateSources
    : dedupeMemorySources([...existingSources, ...candidateSources])

  const accept = db.transaction(() => {
    const update = db.prepare(
      `UPDATE memory_fields
       SET value_json = ?, origin = 'ai', confidence = ?, sources_json = ?,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ? AND locked = 0`
    ).run(
      finalValueJson,
      suggestion.confidence,
      JSON.stringify(finalSources),
      now,
      suggestion.field_id,
      request.expectedRevision
    )
    if (update.changes !== 1) throw new Error('Memory field changed; reload and try again')
    db.prepare('DELETE FROM memory_suggestions WHERE field_id = ?').run(suggestion.field_id)
  })
  accept()
  return { fields: listMemoryFields(), suggestions: listMemorySuggestions() }
}

function dedupeMemorySources(sources: MemorySource[]): MemorySource[] {
  const seen = new Set<string>()
  const result: MemorySource[] = []
  for (const source of sources) {
    const key = `${source.type}:${source.reference}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(source)
  }
  return result
}

function mergeMemoryValue(current: MemoryValue, incoming: MemoryValue, valueType: MemoryValueType): MemoryValue {
  if (valueType === 'list') {
    const currentList = Array.isArray(current) ? current : [String(current)]
    const incomingList = Array.isArray(incoming) ? incoming : [String(incoming)]
    return [...new Set([...currentList, ...incomingList])]
  }
  if (valueType === 'multiline') {
    const currentText = typeof current === 'string' ? current : String(current)
    const incomingText = typeof incoming === 'string' ? incoming : String(incoming)
    if (currentText.trim() === incomingText.trim()) return currentText
    if (currentText.includes(incomingText)) return currentText
    if (incomingText.includes(currentText)) return incomingText
    return `${currentText}\n\n${incomingText}`
  }
  if (valueType === 'text') {
    const currentText = typeof current === 'string' ? current : String(current)
    const incomingText = typeof incoming === 'string' ? incoming : String(incoming)
    if (currentText.trim() === incomingText.trim()) return currentText
    if (currentText.toLocaleLowerCase().includes(incomingText.toLocaleLowerCase())) return currentText
    if (incomingText.toLocaleLowerCase().includes(currentText.toLocaleLowerCase())) return incomingText
    return `${currentText}; ${incomingText}`
  }
  return incoming
}

export interface MemoryConversationEvidence {
  id: string
  title: string
  content: string
  createdAt: number
}

export function listMemoryConversationEvidence(limit: number = 300): MemoryConversationEvidence[] {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500))
  return db.prepare(
    `SELECT m.id, c.title, m.content, m.created_at AS createdAt
     FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE m.role = 'user' AND TRIM(m.content) != ''
     ORDER BY m.created_at DESC
     LIMIT ?`
  ).all(safeLimit) as MemoryConversationEvidence[]
}

export function getMemorySummary(): { summary: string; fieldHash: string; updatedAt: number } {
  const row = db.prepare('SELECT summary, field_hash, updated_at FROM memory_summaries WHERE id = 1').get() as
    | { summary: string; field_hash: string; updated_at: number }
    | undefined
  return {
    summary: row?.summary ?? '',
    fieldHash: row?.field_hash ?? '',
    updatedAt: row?.updated_at ?? 0,
  }
}

export function setMemorySummary(summary: string, fieldHash: string): void {
  const now = Date.now()
  if (summary.trim()) {
    archiveContextVersion({
      sourceType: 'memory-summary',
      sourceRef: 'memory:summary',
      sourceLabel: 'Memory summary',
      projectId: null,
      contentHash: fieldHash,
      contextShort: deriveContextShort(summary),
      context: summary,
    })
  }
  db.prepare(
    `INSERT INTO memory_summaries (id, summary, field_hash, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, field_hash = excluded.field_hash, updated_at = excluded.updated_at`
  ).run(summary, fieldHash, now)
}

export function computeMemoryFieldHash(): string {
  const fields = listMemoryFields().filter((f) => f.value !== null && f.value !== undefined)
  const parts = fields.map((f) => `${f.fieldKey}:${JSON.stringify(f.value)}`)
  return parts.join('|')
}

export interface IdleConversation {
  id: string
  title: string
  updatedAt: number
  memoryExtractedAt: number | null
}

export function listIdleConversations(idleSinceMs: number, limit: number = 10): IdleConversation[] {
  const cutoff = Date.now() - idleSinceMs
  const rows = db.prepare(
    `SELECT id, title, updated_at, memory_extracted_at
     FROM conversations
     WHERE updated_at < ?
       AND (memory_extracted_at IS NULL OR memory_extracted_at < updated_at)
       -- A book discussion carries chapter text in its system prompt and the
       -- assistant's replies quote it back. Extracting memory from that would
       -- put book prose into the profile by the back door, which is the one
       -- thing the Library is built to avoid.
       AND book_discussion = 0
     ORDER BY updated_at ASC
     LIMIT ?`
  ).all(cutoff, limit) as Array<{
    id: string
    title: string
    updated_at: number
    memory_extracted_at: number | null
  }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updated_at,
    memoryExtractedAt: r.memory_extracted_at,
  }))
}

export function updateConversationMemoryExtractedAt(conversationId: string): void {
  db.prepare('UPDATE conversations SET memory_extracted_at = ? WHERE id = ?').run(Date.now(), conversationId)
}

// Projects CRUD
export function listProjects(): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY sort_order ASC, name ASC')
    .all() as Array<{
    id: string
    name: string
    icon: string
    color: string
    path: string | null
    kind: string | null
    analysis: string | null
    relationship_analysis: string | null
    health_analysis: string | null
    activity_analysis: string | null
    finances_summary: string | null
    visible: number
    sort_order: number
    context_scope: string
    index_style: string
    created_at: number
    updated_at: number
  }>
  return rows.map(mapProject)
}

// The Data page reorders by dragging: it hands back the whole list in its new
// order rather than a single moved id, so one write settles every position.
export function setProjectOrder(orderedIds: string[]): void {
  const statement = db.prepare('UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  db.transaction(() => {
    orderedIds.forEach((id, index) => statement.run(index, now, id))
  })()
}

export function addProjectFile(projectId: string, filePath: string): void {
  const id = uuidv4()
  db.prepare(
    'INSERT INTO project_files (id, project_id, path, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, projectId, filePath, Date.now())
}

export function removeProjectFile(projectId: string, filePath: string): void {
  db.prepare('DELETE FROM project_files WHERE project_id = ? AND path = ?').run(projectId, filePath)
}

export function listProjectSources(projectId: string): ProjectSource[] {
  const rows = db
    .prepare('SELECT id, project_id, path, sort_order, created_at FROM project_sources WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(projectId) as Array<{ id: string; project_id: string; path: string; sort_order: number; created_at: number }>
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }))
}

// `projects.path` mirrors the first source. Every pre-multi-source consumer
// (health, activity, psychology, memory evidence, test-file writing) still reads
// it, so it must never drift from the head of the list.
function syncPrimaryProjectPath(projectId: string): void {
  const first = db
    .prepare('SELECT path FROM project_sources WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 1')
    .get(projectId) as { path: string } | undefined
  db.prepare('UPDATE projects SET path = ?, updated_at = ? WHERE id = ?').run(first?.path ?? null, Date.now(), projectId)
}

/**
 * Every folder connected to a project, in order.
 *
 * A project may still carry a legacy `path` with no `project_sources` row —
 * created before the backfill, or written directly — so that path counts as
 * source #1 rather than silently disappearing. Every subsystem that reads a
 * project's folders goes through here, so none of them can drift back to
 * reading `project.path` alone and missing the other connected folders.
 */
export function listProjectSourcePaths(projectId: string): string[] {
  const sources = listProjectSources(projectId)
  if (sources.length > 0) return sources.map((source) => source.path)
  const legacy = getProjectById(projectId)?.path
  return legacy ? [legacy] : []
}

export function addProjectSource(projectId: string, sourcePath: string): ProjectSource[] {
  const trimmed = sourcePath.trim()
  if (!trimmed) return listProjectSources(projectId)
  const next = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM project_sources WHERE project_id = ?')
    .get(projectId) as { next: number }
  db.prepare(
    'INSERT OR IGNORE INTO project_sources (id, project_id, path, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), projectId, trimmed, next.next, Date.now())
  syncPrimaryProjectPath(projectId)
  return listProjectSources(projectId)
}

// Removing a source also drops the contexts derived from it: leaving them would
// keep a disconnected directory feeding the project's synthesis forever.
export function removeProjectSource(projectId: string, sourcePath: string): ProjectSource[] {
  const trimmed = sourcePath.trim()
  runInTransaction(() => {
    db.prepare('DELETE FROM project_sources WHERE project_id = ? AND path = ?').run(projectId, trimmed)
    const prefix = `${trimmed}%`
    db.prepare('DELETE FROM document_file_contexts WHERE project_id = ? AND file_path LIKE ?').run(projectId, prefix)
    db.prepare('DELETE FROM document_folder_contexts WHERE project_id = ? AND folder_path LIKE ?').run(projectId, prefix)
  })
  syncPrimaryProjectPath(projectId)
  return listProjectSources(projectId)
}

function getProjectFiles(projectId: string): string[] {
  const rows = db
    .prepare('SELECT path FROM project_files WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as Array<{ path: string }>
  return rows.map((r) => r.path)
}

export function createProject(data: ProjectInput): Project {
  const id = uuidv4()
  const now = Date.now()
  // A new source lands at the bottom of the Data list, where the user just
  // clicked "Add New Source" — not wherever its name happens to sort.
  const tail = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM projects').get() as { max: number }
  const sortOrder = data.sortOrder ?? tail.max + 1
  const visible = data.visible === false ? 0 : 1
  const contextScope = data.contextScope ?? 'life'
  const indexStyle = data.indexStyle ?? 'behavioral'
  db.prepare(
    'INSERT INTO projects (id, name, icon, color, path, visible, sort_order, context_scope, index_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, data.name, data.icon, data.color, data.path || null, visible, sortOrder, contextScope, indexStyle, now, now)
  if (data.path) {
    db.prepare('INSERT OR IGNORE INTO project_sources (id, project_id, path, sort_order, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(uuidv4(), id, data.path, now)
  }
  // Always `standard` — see the note on ProjectInput. The library kind belongs
  // to the seeder, so no user-created source can skip document indexing.
  return { id, ...data, path: data.path || null, kind: 'standard', visible: visible === 1, sortOrder, contextScope, indexStyle, sources: listProjectSources(id), files: [], analysis: null, healthAnalysis: null, activityAnalysis: null, financesSummary: null, createdAt: now, updatedAt: now }
}

export function projectExistsById(id: string): boolean {
  const row = db.prepare('SELECT 1 AS hit FROM projects WHERE id = ?').get(id) as { hit: number } | undefined
  return Boolean(row?.hit)
}

export function getProjectById(id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | {
        id: string
        name: string
        icon: string
        color: string
        path: string | null
        kind: string | null
        analysis: string | null
        relationship_analysis: string | null
        health_analysis: string | null
        activity_analysis: string | null
        finances_summary: string | null
        visible: number
        sort_order: number
        context_scope: string
        index_style: string
        created_at: number
        updated_at: number
      }
    | undefined
  return row ? mapProject(row) : null
}

export function importProject(record: {
  id: string
  name: string
  icon: string
  color: string
  path?: string | null
  createdAt: number
  updatedAt: number
}): boolean {
  const existing = db.prepare('SELECT 1 AS hit FROM projects WHERE id = ?').get(record.id) as { hit: number } | undefined
  if (existing?.hit) return false
  const tail = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM projects').get() as { max: number }
  db.prepare(
    'INSERT INTO projects (id, name, icon, color, path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(record.id, record.name, record.icon, record.color, record.path || null, tail.max + 1, record.createdAt, record.updatedAt)
  return true
}

export function updateProjectAnalysis(projectId: string, analysis: PsychologyAnalysis): void {
  db.prepare('UPDATE projects SET analysis = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(analysis),
    Date.now(),
    projectId
  )
}

export function updateProjectHealthAnalysis(projectId: string, analysis: HealthAnalysis): void {
  archiveAnalysisVersion('health-analysis', projectId, 'health analysis', analysis, analysis.summary)
  db.prepare('UPDATE projects SET health_analysis = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(analysis),
    Date.now(),
    projectId
  )
}

export function updateProject(id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>): void {
  const fields: string[] = []
  const values: unknown[] = []
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name) }
  if (data.icon !== undefined) { fields.push('icon = ?'); values.push(data.icon) }
  if (data.color !== undefined) { fields.push('color = ?'); values.push(data.color) }
  if (data.path !== undefined) { fields.push('path = ?'); values.push(data.path) }
  if (data.visible !== undefined) { fields.push('visible = ?'); values.push(data.visible ? 1 : 0) }
  if (data.sortOrder !== undefined) { fields.push('sort_order = ?'); values.push(data.sortOrder) }
  if (data.contextScope !== undefined) { fields.push('context_scope = ?'); values.push(data.contextScope) }
  if (data.indexStyle !== undefined) { fields.push('index_style = ?'); values.push(data.indexStyle) }
  // Setting a path directly still has to register it as a source, or the project
  // would show a directory it never indexes.
  if (data.path) {
    db.prepare('INSERT OR IGNORE INTO project_sources (id, project_id, path, sort_order, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(uuidv4(), id, data.path, Date.now())
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteProject(id: string): void {
  db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id)
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

// Mappers
function mapProject(row: {
  id: string
  name: string
  icon: string
  color: string
  path: string | null
  kind?: string | null
  analysis: string | null
  relationship_analysis: string | null
  health_analysis: string | null
  activity_analysis: string | null
  finances_summary: string | null
  visible?: number
  sort_order?: number
  context_scope?: string
  index_style?: string
  created_at: number
  updated_at: number
}): Project {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    path: row.path,
    kind: row.kind === 'library' ? 'library' : 'standard',
    visible: row.visible === undefined ? true : row.visible === 1,
    sortOrder: row.sort_order ?? 0,
    contextScope: row.context_scope === 'separate' ? 'separate' : 'life',
    indexStyle: row.index_style === 'work' || row.index_style === 'reference' ? row.index_style : 'behavioral',
    sources: listProjectSources(row.id),
    files: getProjectFiles(row.id),
    analysis: row.analysis ? JSON.parse(row.analysis) as PsychologyAnalysis : null,
    healthAnalysis: row.health_analysis ? JSON.parse(row.health_analysis) as HealthAnalysis : null,
    activityAnalysis: row.activity_analysis ? JSON.parse(row.activity_analysis) as ActivityAnalysis : null,
    financesSummary: row.finances_summary ? JSON.parse(row.finances_summary) as FinancesSummary : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapConversation(row: {
  id: string
  title: string
  model: string | null
  system_prompt: string
  project_id: string | null
  reasoning_effort: string
  memory_mode: string | null
  context: string | null
  role_id: string | null
  created_at: number
  updated_at: number
}, projectIds?: string[]): Conversation {
  let context: ContextSelection = { kind: 'none' }
  if (row.context) {
    try {
      const parsed = JSON.parse(row.context) as ContextSelection
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
        context = normalizeContextSelection(parsed)
      }
    } catch {
      // Invalid context JSON; fall back to none.
    }
  }
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: row.system_prompt,
    projectId: row.project_id,
    projectIds: projectIds ?? listConversationProjectIds(row.id),
    reasoningEffort: (row.reasoning_effort as Conversation['reasoningEffort']) || 'medium',
    memoryMode: (row.memory_mode as Conversation['memoryMode']) || 'detailed',
    context,
    // A role removed from the catalog leaves its id on old rows; the resolver in
    // `roles.ts` returns null for it, which is the right degradation.
    roleId: row.role_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row: {
  id: string
  conversation_id: string
  role: string
  content: string
  reasoning: string | null
  parent_id: string | null
  is_active: number
  created_at: number
  token_count: number | null
  model: string | null
  tool_calls_json: string | null
  tool_call_id: string | null
  tool_name: string | null
  attachments_json?: string | null
}): Message {
  let toolCalls: ToolCall[] | undefined
  if (row.tool_calls_json) {
    try {
      const parsed = JSON.parse(row.tool_calls_json)
      if (Array.isArray(parsed) && parsed.every((c: unknown) => c && typeof c === 'object' && 'id' in c && 'name' in c)) {
        toolCalls = parsed as ToolCall[]
      }
    } catch { /* malformed tool_calls_json */ }
  }
  let attachments: ChatAttachment[] | undefined
  if (row.attachments_json) {
    try {
      const parsed = JSON.parse(row.attachments_json)
      if (Array.isArray(parsed) && parsed.every((a: unknown) => a && typeof a === 'object' && 'dataUrl' in a && 'kind' in a)) {
        attachments = parsed as ChatAttachment[]
      }
    } catch { /* malformed attachments_json */ }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Message['role'],
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    createdAt: row.created_at,
    tokenCount: row.token_count ?? undefined,
    model: row.model ?? undefined,
    parentId: row.parent_id ?? undefined,
    toolCalls,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    attachments,
  }
}

interface HealthRecordRow {
  id: string
  project_id: string
  source_type: HealthSourceType
  filename: string
  file_size: number
  content_hash: string | null
  source_path: string | null
  identity_hash: string | null
  imported_at: number
  status: 'pending' | 'parsed' | 'failed'
  parse_error: string | null
  observations_count: number
}

function mapHealthRecord(row: HealthRecordRow): HealthRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type,
    filename: row.filename,
    fileSize: row.file_size,
    contentHash: row.content_hash,
    sourcePath: row.source_path ?? null,
    identityHash: row.identity_hash ?? null,
    importedAt: row.imported_at,
    status: row.status,
    parseError: row.parse_error,
    observationsCount: row.observations_count,
  }
}

interface HealthObservationRow {
  id: string
  record_id: string
  type: HealthObservationType
  code: string | null
  display_name: string
  value_real: number | null
  value_text: string | null
  unit: string | null
  ref_low: number | null
  ref_high: number | null
  effective_date: string | null
  source_meta_json: string
  created_at: number
}

function mapHealthObservation(row: HealthObservationRow): HealthObservation {
  return {
    id: row.id,
    recordId: row.record_id,
    type: row.type,
    code: row.code,
    displayName: row.display_name,
    valueReal: row.value_real,
    valueText: row.value_text,
    unit: row.unit,
    refLow: row.ref_low,
    refHigh: row.ref_high,
    effectiveDate: row.effective_date,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface ActivityRecordRow {
  id: string
  project_id: string
  source_type: string
  filename: string | null
  file_size: number | null
  content_hash: string | null
  imported_at: string
  status: string
  parse_error: string | null
  events_count: number
}

function mapActivityRecord(row: ActivityRecordRow): ActivityRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type as ActivitySourceType,
    filename: row.filename,
    fileSize: row.file_size,
    contentHash: row.content_hash,
    importedAt: row.imported_at,
    status: row.status as ActivityRecord['status'],
    parseError: row.parse_error,
    eventsCount: row.events_count,
  }
}

interface BrowserEventRow {
  id: string
  record_id: string
  kind: string
  occurred_at: string
  title: string | null
  url: string | null
  source_meta_json: string
  created_at: string
}

function mapBrowserEvent(row: BrowserEventRow): BrowserEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    kind: row.kind as BrowserEvent['kind'],
    occurredAt: row.occurred_at,
    title: row.title,
    url: row.url,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface YoutubeEventRow {
  id: string
  record_id: string
  occurred_at: string
  title: string | null
  channel: string | null
  url: string | null
  duration_seconds: number | null
  source_meta_json: string
  created_at: string
}

function mapYoutubeEvent(row: YoutubeEventRow): YoutubeEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    title: row.title,
    channel: row.channel,
    url: row.url,
    durationSeconds: row.duration_seconds,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface AmazonEventRow {
  id: string
  record_id: string
  occurred_at: string
  order_id: string | null
  title: string | null
  total_cents: number | null
  items_json: string
  source_meta_json: string
  created_at: string
}

function mapAmazonEvent(row: AmazonEventRow): AmazonEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    orderId: row.order_id,
    title: row.title,
    totalCents: row.total_cents,
    items: parseStoredJson<Array<{ title: string; quantity: number; priceCents: number | null }>>(row.items_json, []),
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface EmailEventRow {
  id: string
  record_id: string
  kind: string
  occurred_at: string
  from_address: string | null
  to_addresses_json: string
  subject: string | null
  body_excerpt: string | null
  source_meta_json: string
  created_at: string
}

function mapEmailEvent(row: EmailEventRow): EmailEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    kind: row.kind as EmailEvent['kind'],
    occurredAt: row.occurred_at,
    fromAddress: row.from_address,
    toAddresses: parseStoredJson<string[]>(row.to_addresses_json, []),
    subject: row.subject,
    bodyExcerpt: row.body_excerpt,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface KnowledgeEventRow {
  id: string
  record_id: string
  occurred_at: string
  bundle_id: string | null
  app_name: string | null
  event_type: string
  duration_seconds: number | null
  source_meta_json: string
  created_at: string
}

function mapKnowledgeEvent(row: KnowledgeEventRow): KnowledgeEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    bundleId: row.bundle_id,
    appName: row.app_name,
    eventType: row.event_type as KnowledgeEvent['eventType'],
    durationSeconds: row.duration_seconds,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface PhotoEventRow {
  id: string
  record_id: string
  occurred_at: string
  asset_kind: string | null
  location_name: string | null
  faces_json: string
  source_meta_json: string
  created_at: string
}

function mapPhotoEvent(row: PhotoEventRow): PhotoEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    assetKind: row.asset_kind,
    locationName: row.location_name,
    faces: parseStoredJson<string[]>(row.faces_json, []),
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface LocationEventRow {
  id: string
  record_id: string
  occurred_at: string
  lat_real: number | null
  lng_real: number | null
  accuracy_m: number | null
  source: string | null
  source_meta_json: string
  created_at: string
}

function mapLocationEvent(row: LocationEventRow): LocationEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    lat: row.lat_real,
    lng: row.lng_real,
    accuracyM: row.accuracy_m,
    source: row.source,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface WeatherEventRow {
  id: string
  record_id: string
  occurred_at: string
  temp_c: number | null
  humidity_pct: number | null
  precip_mm: number | null
  wind_kph: number | null
  conditions: string | null
  source_meta_json: string
  created_at: string
}

function mapWeatherEvent(row: WeatherEventRow): WeatherEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    tempC: row.temp_c,
    humidityPct: row.humidity_pct,
    precipMm: row.precip_mm,
    windKph: row.wind_kph,
    conditions: row.conditions,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface SubscriptionEventRow {
  id: string
  record_id: string
  occurred_at: string
  provider: string | null
  plan_name: string | null
  amount_cents: number | null
  currency: string | null
  cadence: string
  source_meta_json: string
  created_at: string
}

function mapSubscriptionEvent(row: SubscriptionEventRow): SubscriptionEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredAt: row.occurred_at,
    provider: row.provider,
    planName: row.plan_name,
    amountCents: row.amount_cents,
    currency: row.currency,
    cadence: row.cadence as SubscriptionEvent['cadence'],
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface AccountEventRow {
  id: string
  record_id: string
  provider: string
  kind: string
  occurred_at: string
  title: string | null
  detail: string | null
  counterparty: string | null
  url: string | null
  source_meta_json: string
  created_at: string
}

function mapAccountEvent(row: AccountEventRow): AccountEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    provider: row.provider as ActivityProviderId,
    kind: row.kind as AccountEventKind,
    occurredAt: row.occurred_at,
    title: row.title,
    detail: row.detail,
    counterparty: row.counterparty,
    url: row.url,
    sourceMeta: parseStoredJson<Record<string, unknown>>(row.source_meta_json, {}),
    createdAt: row.created_at,
  }
}

interface ActivityAccountRow {
  id: string
  project_id: string
  provider: string
  enabled: number
  watch_path: string | null
  credential_stored: number
  credential_kind: string | null
  config_json: string
  last_sync_at: string | null
  last_sync_status: string
  last_error: string | null
  last_export_at: string | null
  created_at: string
}

function mapActivityAccount(row: ActivityAccountRow, eventsCount: number): ActivityAccount {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider as ActivityProviderId,
    enabled: row.enabled === 1,
    watchPath: row.watch_path,
    sources: listActivityAccountSources(row.id),
    credentialStored: row.credential_stored === 1,
    credentialKind: (row.credential_kind as ActivityCredentialKind | null) ?? null,
    config: parseStoredJson<ActivityAccountConfig>(row.config_json, {}),
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: (row.last_sync_status as ActivityAccountSyncStatus) || 'idle',
    lastError: row.last_error,
    lastExportAt: row.last_export_at,
    createdAt: row.created_at,
    eventsCount,
  }
}

export function createHealthRecord(record: Omit<HealthRecord, 'id' | 'importedAt'>): HealthRecord {
  const id = uuidv4()
  const importedAt = Date.now()
  db.prepare(
    `INSERT INTO health_records (
      id, project_id, source_type, filename, file_size, content_hash,
      source_path, identity_hash, imported_at, status, parse_error, observations_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    record.projectId,
    record.sourceType,
    record.filename,
    record.fileSize,
    record.contentHash,
    record.sourcePath ?? null,
    record.identityHash ?? null,
    importedAt,
    record.status,
    record.parseError,
    record.observationsCount
  )
  return { ...record, id, importedAt }
}

/**
 * What a scan has already ingested, keyed by file identity.
 *
 * Returned as identity → status so a scan can tell "already parsed" from "tried
 * and failed" — the automatic pass must not re-run a failing PDF through the
 * model every hour, while an explicit rescan is allowed to retry it.
 */
export function listHealthRecordIdentities(projectId: string): Map<string, HealthRecord['status']> {
  const rows = db
    .prepare("SELECT identity_hash, status FROM health_records WHERE project_id = ? AND identity_hash IS NOT NULL")
    .all(projectId) as Array<{ identity_hash: string; status: HealthRecord['status'] }>
  const identities = new Map<string, HealthRecord['status']>()
  for (const row of rows) {
    // A file ingested more than once keeps its best outcome: one parsed run is
    // enough to consider it done, whatever a later failed attempt said.
    const existing = identities.get(row.identity_hash)
    if (existing === 'parsed') continue
    identities.set(row.identity_hash, row.status)
  }
  return identities
}

/**
 * Clears the rows a re-ingest of these files is about to replace.
 *
 * Two kinds, both carrying no data: a previous attempt at the same file identity
 * (retrying used to append a row rather than replace one, so two PDFs had grown
 * eight records), and rows written before identities existed, which no scan can
 * recognize and which would otherwise duplicate forever. Records that actually
 * parsed observations are never touched — only empty placeholders.
 */
export function clearSupersededHealthRecords(projectId: string, identities: string[], filenames: string[]): number {
  let removed = 0
  runInTransaction(() => {
    const byIdentity = db.prepare(
      "DELETE FROM health_records WHERE project_id = ? AND identity_hash = ? AND observations_count = 0"
    )
    for (const identity of identities) removed += byIdentity.run(projectId, identity).changes
    const legacy = db.prepare(
      "DELETE FROM health_records WHERE project_id = ? AND identity_hash IS NULL AND observations_count = 0 AND filename = ?"
    )
    for (const filename of filenames) removed += legacy.run(projectId, filename).changes
  })
  return removed
}

export function listHealthRecords(projectId: string): HealthRecord[] {
  const rows = db
    .prepare('SELECT * FROM health_records WHERE project_id = ? ORDER BY imported_at DESC')
    .all(projectId) as HealthRecordRow[]
  return rows.map(mapHealthRecord)
}

export function findHealthRecord(
  projectId: string,
  sourceType: HealthSourceType,
  filename: string
): HealthRecord | null {
  const row = db
    .prepare('SELECT * FROM health_records WHERE project_id = ? AND source_type = ? AND filename = ? ORDER BY imported_at DESC LIMIT 1')
    .get(projectId, sourceType, filename) as HealthRecordRow | undefined
  return row ? mapHealthRecord(row) : null
}

export function touchHealthRecordImportedAt(id: string): void {
  db.prepare('UPDATE health_records SET imported_at = ? WHERE id = ?').run(Date.now(), id)
}

export function findExistingHealthObservationKeys(recordId: string): Set<string> {
  const rows = db
    .prepare('SELECT code, effective_date FROM health_observations WHERE record_id = ?')
    .all(recordId) as Array<{ code: string | null; effective_date: string | null }>
  return new Set(rows.map((r) => `${r.code ?? ''}|${r.effective_date ?? ''}`))
}

export function getHealthRecord(id: string): HealthRecord | null {
  const row = db.prepare('SELECT * FROM health_records WHERE id = ?').get(id) as HealthRecordRow | undefined
  return row ? mapHealthRecord(row) : null
}

export function deleteHealthRecord(id: string): void {
  db.prepare('DELETE FROM health_records WHERE id = ?').run(id)
}

export function updateHealthRecordStatus(
  id: string,
  status: 'pending' | 'parsed' | 'failed',
  parseError: string | null,
  observationsCount: number
): void {
  db.prepare(
    'UPDATE health_records SET status = ?, parse_error = ?, observations_count = ? WHERE id = ?'
  ).run(status, parseError, observationsCount, id)
}

export function createHealthObservation(obs: Omit<HealthObservation, 'id' | 'createdAt'>): HealthObservation {
  const id = uuidv4()
  const createdAt = Date.now()
  db.prepare(
    `INSERT INTO health_observations (
      id, record_id, type, code, display_name, value_real, value_text,
      unit, ref_low, ref_high, effective_date, source_meta_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    obs.recordId,
    obs.type,
    obs.code,
    obs.displayName,
    obs.valueReal,
    obs.valueText,
    obs.unit,
    obs.refLow,
    obs.refHigh,
    obs.effectiveDate,
    JSON.stringify(obs.sourceMeta || {}),
    createdAt
  )
  return { ...obs, id, createdAt }
}

export function listHealthObservations(recordId: string): HealthObservation[] {
  const rows = db
    .prepare('SELECT * FROM health_observations WHERE record_id = ? ORDER BY effective_date DESC, created_at DESC')
    .all(recordId) as HealthObservationRow[]
  return rows.map(mapHealthObservation)
}

export function listAllHealthObservations(
  projectId: string,
  opts?: { type?: string; limit?: number }
): HealthObservation[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  if (opts?.type) {
    const rows = db
      .prepare(
        `SELECT o.* FROM health_observations o
         INNER JOIN health_records r ON r.id = o.record_id
         WHERE r.project_id = ? AND o.type = ?
         ORDER BY o.effective_date DESC, o.created_at DESC
         LIMIT ?`
      )
      .all(projectId, opts.type, limit) as HealthObservationRow[]
    return rows.map(mapHealthObservation)
  }
  const rows = db
    .prepare(
      `SELECT o.* FROM health_observations o
       INNER JOIN health_records r ON r.id = o.record_id
       WHERE r.project_id = ?
       ORDER BY o.effective_date DESC, o.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as HealthObservationRow[]
  return rows.map(mapHealthObservation)
}

export function getHealthObservationsHash(projectId: string): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, MAX(o.effective_date) AS latest
       FROM health_observations o
       INNER JOIN health_records r ON r.id = o.record_id
       WHERE r.project_id = ?`
    )
    .get(projectId) as { count: number; latest: string | null } | undefined
  const count = row?.count ?? 0
  const latest = row?.latest ?? ''
  return `${count}|${latest}`
}

export function getHealthSummary(projectId: string): HealthSummary | null {
  const row = db
    .prepare('SELECT id, project_id, summary, field_hash, updated_at FROM health_summary WHERE project_id = ?')
    .get(projectId) as
    | { id: string; project_id: string; summary: string | null; field_hash: string | null; updated_at: number }
    | undefined
  if (!row) return null
  return {
    projectId: row.project_id,
    summary: row.summary ?? '',
    fieldHash: row.field_hash ?? '',
    updatedAt: row.updated_at ?? 0,
  }
}

export function setHealthSummary(projectId: string, summary: string, hash: string): void {
  const existing = db.prepare('SELECT id FROM health_summary WHERE project_id = ?').get(projectId) as
    | { id: string }
    | undefined
  const now = Date.now()
  if (existing) {
    db.prepare('UPDATE health_summary SET summary = ?, field_hash = ?, updated_at = ? WHERE project_id = ?').run(
      summary,
      hash,
      now,
      projectId
    )
  } else {
    db.prepare(
      'INSERT INTO health_summary (id, project_id, summary, field_hash, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuidv4(), projectId, summary, hash, now)
  }
}

export function createActivityRecord(input: { projectId: string; sourceType: ActivitySourceType; filename: string | null; fileSize: number | null; contentHash: string | null }): ActivityRecord {
  const id = uuidv4()
  const importedAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO activity_records (
      id, project_id, source_type, filename, file_size, content_hash,
      imported_at, status, parse_error, events_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0)`
  ).run(
    id,
    input.projectId,
    input.sourceType,
    input.filename,
    input.fileSize,
    input.contentHash,
    importedAt
  )
  return {
    id,
    projectId: input.projectId,
    sourceType: input.sourceType,
    filename: input.filename,
    fileSize: input.fileSize,
    contentHash: input.contentHash,
    importedAt,
    status: 'pending',
    parseError: null,
    eventsCount: 0,
  }
}

export function completeActivityRecord(recordId: string, eventsCount: number): void {
  db.prepare(
    "UPDATE activity_records SET status = 'parsed', events_count = ?, parse_error = NULL WHERE id = ?"
  ).run(eventsCount, recordId)
}

export function failActivityRecord(recordId: string, message: string): void {
  db.prepare(
    "UPDATE activity_records SET status = 'failed', parse_error = ? WHERE id = ?"
  ).run(message, recordId)
}

export function needsPermissionActivityRecord(recordId: string, message: string): void {
  db.prepare(
    "UPDATE activity_records SET status = 'needs_permission', parse_error = ? WHERE id = ?"
  ).run(message, recordId)
}

export function listActivityRecords(projectId: string): ActivityRecord[] {
  const rows = db
    .prepare('SELECT * FROM activity_records WHERE project_id = ? ORDER BY imported_at DESC')
    .all(projectId) as ActivityRecordRow[]
  return rows.map(mapActivityRecord)
}

export function pruneDuplicateActivityRecords(projectId: string): void {
  const all = listActivityRecords(projectId)
  const latestByKey = new Map<string, ActivityRecord>()
  for (const record of all) {
    const key = `${record.sourceType}:${record.filename ?? ''}`
    const existing = latestByKey.get(key)
    if (!existing || record.importedAt > existing.importedAt) {
      latestByKey.set(key, record)
    }
  }
  const keepIds = new Set([...latestByKey.values()].map((r) => r.id))
  const toDelete = all.filter((r) => !keepIds.has(r.id))
  for (const record of toDelete) {
    deleteActivityRecord(record.id)
  }
}

export function getActivityRecord(recordId: string): ActivityRecord | null {
  const row = db.prepare('SELECT * FROM activity_records WHERE id = ?').get(recordId) as ActivityRecordRow | undefined
  return row ? mapActivityRecord(row) : null
}

export function deleteActivityRecord(recordId: string): void {
  db.prepare('DELETE FROM activity_records WHERE id = ?').run(recordId)
}

export function touchActivityRecordImportedAt(recordId: string): void {
  db.prepare('UPDATE activity_records SET imported_at = ? WHERE id = ?').run(new Date().toISOString(), recordId)
}

export function findLiveActivityRecord(projectId: string, sourceType: string, filename: string): ActivityRecord | undefined {
  return listActivityRecords(projectId).find((r) => r.sourceType === sourceType && r.filename === filename)
}

export function resetActivityRecord(recordId: string): void {
  const tables = [
    'browser_events', 'youtube_events', 'amazon_events', 'email_events',
    'knowledge_events', 'photo_events', 'location_events', 'weather_events',
    'subscription_events', 'account_events',
  ]
  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table} WHERE record_id = ?`).run(recordId)
    }
    db.prepare(
      "UPDATE activity_records SET status = 'pending', events_count = 0, parse_error = NULL WHERE id = ?"
    ).run(recordId)
  })()
}

export function findActivityRecord(
  projectId: string,
  sourceType: ActivitySourceType,
  contentHash: string
): ActivityRecord | null {
  const row = db
    .prepare('SELECT * FROM activity_records WHERE project_id = ? AND source_type = ? AND content_hash = ? ORDER BY imported_at DESC LIMIT 1')
    .get(projectId, sourceType, contentHash) as ActivityRecordRow | undefined
  return row ? mapActivityRecord(row) : null
}

export function createBrowserEvent(input: { recordId: string; kind: BrowserEvent['kind']; occurredAt: string; title: string | null; url: string | null; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO browser_events (id, record_id, kind, occurred_at, title, url, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.kind, input.occurredAt, input.title, input.url, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listBrowserEvents(recordId: string, opts?: { limit?: number }): BrowserEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM browser_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as BrowserEventRow[]
  return rows.map(mapBrowserEvent)
}

export function listAllBrowserEvents(projectId: string, opts?: { limit?: number }): BrowserEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM browser_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as BrowserEventRow[]
  return rows.map(mapBrowserEvent)
}

export function findExistingBrowserEventKeys(recordId: string, keys: Array<{ occurredAt: string; url: string | null }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at, url FROM browser_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string; url: string | null }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}|${r.url ?? ''}`))
  return new Set(keys.map((k) => `${k.occurredAt}|${k.url ?? ''}`).filter((k) => existing.has(k)))
}

export function createYoutubeEvent(input: { recordId: string; occurredAt: string; title: string | null; channel: string | null; url: string | null; durationSeconds: number | null; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO youtube_events (id, record_id, occurred_at, title, channel, url, duration_seconds, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.title, input.channel, input.url, input.durationSeconds, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listYoutubeEvents(recordId: string, opts?: { limit?: number }): YoutubeEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM youtube_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as YoutubeEventRow[]
  return rows.map(mapYoutubeEvent)
}

export function listAllYoutubeEvents(projectId: string, opts?: { limit?: number }): YoutubeEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM youtube_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as YoutubeEventRow[]
  return rows.map(mapYoutubeEvent)
}

export function findExistingYoutubeEventKeys(recordId: string, keys: Array<{ occurredAt: string; url: string | null }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at, url FROM youtube_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string; url: string | null }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}|${r.url ?? ''}`))
  return new Set(keys.map((k) => `${k.occurredAt}|${k.url ?? ''}`).filter((k) => existing.has(k)))
}

export function createAmazonEvent(input: { recordId: string; occurredAt: string; orderId: string | null; title: string | null; totalCents: number | null; items: Array<{ title: string; quantity: number; priceCents: number | null }>; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO amazon_events (id, record_id, occurred_at, order_id, title, total_cents, items_json, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.orderId, input.title, input.totalCents, JSON.stringify(input.items || []), JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listAmazonEvents(recordId: string, opts?: { limit?: number }): AmazonEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM amazon_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as AmazonEventRow[]
  return rows.map(mapAmazonEvent)
}

export function listAllAmazonEvents(projectId: string, opts?: { limit?: number }): AmazonEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM amazon_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as AmazonEventRow[]
  return rows.map(mapAmazonEvent)
}

export function findExistingAmazonEventKeys(projectId: string, keys: Array<{ orderId: string | null }>): Set<string> {
  const rows = db
    .prepare(
      `SELECT e.order_id FROM amazon_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?`
    )
    .all(projectId) as Array<{ order_id: string | null }>
  const existing = new Set(rows.map((r) => `${r.order_id ?? ''}`))
  return new Set(keys.map((k) => `${k.orderId ?? ''}`).filter((k) => existing.has(k)))
}

export function createEmailEvent(input: { recordId: string; kind: EmailEvent['kind']; occurredAt: string; fromAddress: string | null; toAddresses: string[]; subject: string | null; bodyExcerpt: string | null; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO email_events (id, record_id, kind, occurred_at, from_address, to_addresses_json, subject, body_excerpt, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.kind, input.occurredAt, input.fromAddress, JSON.stringify(input.toAddresses || []), input.subject, input.bodyExcerpt, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listEmailEvents(recordId: string, opts?: { limit?: number }): EmailEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM email_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as EmailEventRow[]
  return rows.map(mapEmailEvent)
}

export function listAllEmailEvents(projectId: string, opts?: { limit?: number }): EmailEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM email_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as EmailEventRow[]
  return rows.map(mapEmailEvent)
}

export function findExistingEmailEventKeys(recordId: string, keys: Array<{ occurredAt: string; subject: string | null; fromAddress: string | null }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at, subject, from_address FROM email_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string; subject: string | null; from_address: string | null }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}|${r.subject ?? ''}|${r.from_address ?? ''}`))
  return new Set(keys.map((k) => `${k.occurredAt}|${k.subject ?? ''}|${k.fromAddress ?? ''}`).filter((k) => existing.has(k)))
}

export function createKnowledgeEvent(input: { recordId: string; occurredAt: string; bundleId: string | null; appName: string | null; eventType: KnowledgeEvent['eventType']; durationSeconds: number | null; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO knowledge_events (id, record_id, occurred_at, bundle_id, app_name, event_type, duration_seconds, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.bundleId, input.appName, input.eventType, input.durationSeconds, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listKnowledgeEvents(recordId: string, opts?: { limit?: number }): KnowledgeEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM knowledge_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as KnowledgeEventRow[]
  return rows.map(mapKnowledgeEvent)
}

export function listAllKnowledgeEvents(projectId: string, opts?: { limit?: number }): KnowledgeEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM knowledge_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as KnowledgeEventRow[]
  return rows.map(mapKnowledgeEvent)
}

export function findExistingKnowledgeEventKeys(recordId: string, keys: Array<{ occurredAt: string; bundleId: string | null; eventType: KnowledgeEvent['eventType'] }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at, bundle_id, event_type FROM knowledge_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string; bundle_id: string | null; event_type: string }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}|${r.bundle_id ?? ''}|${r.event_type}`))
  return new Set(keys.map((k) => `${k.occurredAt}|${k.bundleId ?? ''}|${k.eventType}`).filter((k) => existing.has(k)))
}

export function createPhotoEvent(input: { recordId: string; occurredAt: string; assetKind: string | null; locationName: string | null; faces: string[]; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO photo_events (id, record_id, occurred_at, asset_kind, location_name, faces_json, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.assetKind, input.locationName, JSON.stringify(input.faces || []), JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listPhotoEvents(recordId: string, opts?: { limit?: number }): PhotoEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM photo_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as PhotoEventRow[]
  return rows.map(mapPhotoEvent)
}

export function listAllPhotoEvents(projectId: string, opts?: { limit?: number }): PhotoEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM photo_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as PhotoEventRow[]
  return rows.map(mapPhotoEvent)
}

export function findExistingPhotoEventKeys(recordId: string, keys: Array<{ occurredAt: string; locationName: string | null }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at, location_name FROM photo_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string; location_name: string | null }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}|${r.location_name ?? ''}`))
  return new Set(keys.map((k) => `${k.occurredAt}|${k.locationName ?? ''}`).filter((k) => existing.has(k)))
}

export function createLocationEvent(input: { recordId: string; occurredAt: string; lat: number | null; lng: number | null; accuracyM: number | null; source: string | null; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO location_events (id, record_id, occurred_at, lat_real, lng_real, accuracy_m, source, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.lat, input.lng, input.accuracyM, input.source, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listLocationEvents(recordId: string, opts?: { limit?: number }): LocationEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM location_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as LocationEventRow[]
  return rows.map(mapLocationEvent)
}

export function listAllLocationEvents(projectId: string, opts?: { limit?: number }): LocationEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM location_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as LocationEventRow[]
  return rows.map(mapLocationEvent)
}

export function findExistingLocationEventKeys(recordId: string, keys: Array<{ occurredAt: string; lat: number | null; lng: number | null }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at, lat_real, lng_real FROM location_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string; lat_real: number | null; lng_real: number | null }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}|${r.lat_real ?? ''}|${r.lng_real ?? ''}`))
  return new Set(keys.map((k) => `${k.occurredAt}|${k.lat ?? ''}|${k.lng ?? ''}`).filter((k) => existing.has(k)))
}

export function createWeatherEvent(input: { recordId: string; occurredAt: string; tempC: number | null; humidityPct: number | null; precipMm: number | null; windKph: number | null; conditions: string | null; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO weather_events (id, record_id, occurred_at, temp_c, humidity_pct, precip_mm, wind_kph, conditions, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.tempC, input.humidityPct, input.precipMm, input.windKph, input.conditions, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listWeatherEvents(recordId: string, opts?: { limit?: number }): WeatherEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM weather_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as WeatherEventRow[]
  return rows.map(mapWeatherEvent)
}

export function listAllWeatherEvents(projectId: string, opts?: { limit?: number }): WeatherEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM weather_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as WeatherEventRow[]
  return rows.map(mapWeatherEvent)
}

export function findExistingWeatherEventKeys(recordId: string, keys: Array<{ occurredAt: string }>): Set<string> {
  const rows = db
    .prepare('SELECT occurred_at FROM weather_events WHERE record_id = ?')
    .all(recordId) as Array<{ occurred_at: string }>
  const existing = new Set(rows.map((r) => `${r.occurred_at}`))
  return new Set(keys.map((k) => `${k.occurredAt}`).filter((k) => existing.has(k)))
}

export function createSubscriptionEvent(input: { recordId: string; occurredAt: string; provider: string | null; planName: string | null; amountCents: number | null; currency: string | null; cadence: SubscriptionEvent['cadence']; sourceMeta: Record<string, unknown> }): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO subscription_events (id, record_id, occurred_at, provider, plan_name, amount_cents, currency, cadence, source_meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.recordId, input.occurredAt, input.provider, input.planName, input.amountCents, input.currency, input.cadence, JSON.stringify(input.sourceMeta || {}), createdAt)
}

export function listSubscriptionEvents(recordId: string, opts?: { limit?: number }): SubscriptionEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM subscription_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as SubscriptionEventRow[]
  return rows.map(mapSubscriptionEvent)
}

export function listAllSubscriptionEvents(projectId: string, opts?: { limit?: number }): SubscriptionEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare(
      `SELECT e.* FROM subscription_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       ORDER BY e.occurred_at DESC, e.created_at DESC
       LIMIT ?`
    )
    .all(projectId, limit) as SubscriptionEventRow[]
  return rows.map(mapSubscriptionEvent)
}

export function findExistingSubscriptionEventKeys(recordId: string, keys: Array<{ provider: string | null; planName: string | null }>): Set<string> {
  const rows = db
    .prepare('SELECT provider, plan_name FROM subscription_events WHERE record_id = ?')
    .all(recordId) as Array<{ provider: string | null; plan_name: string | null }>
  const existing = new Set(rows.map((r) => `${r.provider ?? ''}|${r.plan_name ?? ''}`))
  return new Set(keys.map((k) => `${k.provider ?? ''}|${k.planName ?? ''}`).filter((k) => existing.has(k)))
}

/**
 * Ceiling on one event query. The activity analysis reads every event when it
 * chunks a source, and the old 10,000 clamp silently truncated a 200,000-message
 * history to its most recent 5% — the caller had no way to tell it had been cut.
 */
const MAX_EVENT_QUERY_ROWS = 1_000_000

export function createAccountEvent(input: {
  recordId: string
  provider: ActivityProviderId
  kind: AccountEventKind
  occurredAt: string
  title: string | null
  detail: string | null
  counterparty: string | null
  url: string | null
  sourceMeta: Record<string, unknown>
}): void {
  const id = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO account_events (id, record_id, provider, kind, occurred_at, title, detail, counterparty, url, source_meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.recordId,
    input.provider,
    input.kind,
    input.occurredAt,
    input.title,
    input.detail,
    input.counterparty,
    input.url,
    JSON.stringify(input.sourceMeta || {}),
    createdAt
  )
}

export function listAccountEvents(recordId: string, opts?: { limit?: number }): AccountEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = db
    .prepare('SELECT * FROM account_events WHERE record_id = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?')
    .all(recordId, limit) as AccountEventRow[]
  return rows.map(mapAccountEvent)
}

export function listAllAccountEvents(
  projectId: string,
  opts?: { limit?: number; provider?: ActivityProviderId }
): AccountEvent[] {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, MAX_EVENT_QUERY_ROWS))
  const rows = opts?.provider
    ? (db
        .prepare(
          `SELECT e.* FROM account_events e
           INNER JOIN activity_records r ON r.id = e.record_id
           WHERE r.project_id = ? AND e.provider = ?
           ORDER BY e.occurred_at DESC, e.created_at DESC
           LIMIT ?`
        )
        .all(projectId, opts.provider, limit) as AccountEventRow[])
    : (db
        .prepare(
          `SELECT e.* FROM account_events e
           INNER JOIN activity_records r ON r.id = e.record_id
           WHERE r.project_id = ?
           ORDER BY e.occurred_at DESC, e.created_at DESC
           LIMIT ?`
        )
        .all(projectId, limit) as AccountEventRow[])
  return rows.map(mapAccountEvent)
}

/**
 * Event counts per provider for the Data page. Counts every table an account
 * can write to, not just `account_events`, so Gmail and Amazon report honestly.
 */
export function countAccountEventsByProvider(projectId: string): Record<string, number> {
  const counts: Record<string, number> = {}

  const generic = db
    .prepare(
      `SELECT e.provider AS provider, COUNT(*) AS n FROM account_events e
       INNER JOIN activity_records r ON r.id = e.record_id
       WHERE r.project_id = ?
       GROUP BY e.provider`
    )
    .all(projectId) as Array<{ provider: string; n: number }>
  for (const row of generic) counts[row.provider] = row.n

  // Accounts that reuse a pre-registry table are counted through the record's
  // source type, which is the only link back to them.
  const typed: Array<[string, string]> = [
    ['gmail', 'email_events'],
    ['youtube', 'youtube_events'],
    ['amazon', 'amazon_events'],
  ]
  for (const [provider, table] of typed) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${table} e
         INNER JOIN activity_records r ON r.id = e.record_id
         WHERE r.project_id = ?`
      )
      .get(projectId) as { n: number } | undefined
    if (row?.n) counts[provider] = (counts[provider] ?? 0) + row.n
  }

  return counts
}

export function listActivityAccounts(projectId: string): ActivityAccount[] {
  const rows = db
    .prepare('SELECT * FROM activity_accounts WHERE project_id = ? ORDER BY provider ASC')
    .all(projectId) as ActivityAccountRow[]
  const counts = countAccountEventsByProvider(projectId)
  return rows.map((row) => mapActivityAccount(row, counts[row.provider] ?? 0))
}

export function getActivityAccount(accountId: string): ActivityAccount | null {
  const row = db.prepare('SELECT * FROM activity_accounts WHERE id = ?').get(accountId) as
    | ActivityAccountRow
    | undefined
  if (!row) return null
  const counts = countAccountEventsByProvider(row.project_id)
  return mapActivityAccount(row, counts[row.provider] ?? 0)
}

export function findActivityAccount(projectId: string, provider: ActivityProviderId): ActivityAccount | null {
  const row = db
    .prepare('SELECT * FROM activity_accounts WHERE project_id = ? AND provider = ?')
    .get(projectId, provider) as ActivityAccountRow | undefined
  if (!row) return null
  const counts = countAccountEventsByProvider(projectId)
  return mapActivityAccount(row, counts[provider] ?? 0)
}

/**
 * Creates the row for a provider if it is missing. Idempotent — the UNIQUE
 * constraint means seeding on every startup costs one no-op insert per account.
 */
export function ensureActivityAccount(projectId: string, provider: ActivityProviderId): ActivityAccount {
  db.prepare(
    `INSERT OR IGNORE INTO activity_accounts (id, project_id, provider, enabled, created_at)
     VALUES (?, ?, ?, 0, ?)`
  ).run(uuidv4(), projectId, provider, new Date().toISOString())
  const account = findActivityAccount(projectId, provider)
  if (!account) throw new Error(`Failed to create activity account for ${provider}`)
  return account
}

export function listActivityAccountSources(accountId: string): ActivityAccountSource[] {
  const rows = db
    .prepare(
      'SELECT id, account_id, path, sort_order, created_at FROM activity_account_sources WHERE account_id = ? ORDER BY sort_order ASC, created_at ASC'
    )
    .all(accountId) as Array<{
    id: string
    account_id: string
    path: string
    sort_order: number
    created_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    path: row.path,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  }))
}

/**
 * `activity_accounts.watch_path` mirrors the first source, the same way
 * `projects.path` mirrors the first project source, so anything still reading
 * the single column keeps working.
 */
function syncPrimaryWatchPath(accountId: string): void {
  const first = listActivityAccountSources(accountId)[0]
  db.prepare('UPDATE activity_accounts SET watch_path = ? WHERE id = ?').run(first?.path ?? null, accountId)
}

export function addActivityAccountSource(accountId: string, sourcePath: string): ActivityAccountSource[] {
  const trimmed = sourcePath.trim()
  if (!trimmed) return listActivityAccountSources(accountId)
  const next = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM activity_account_sources WHERE account_id = ?')
    .get(accountId) as { next: number }
  db.prepare(
    'INSERT OR IGNORE INTO activity_account_sources (id, account_id, path, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), accountId, trimmed, next.next, Date.now())
  syncPrimaryWatchPath(accountId)
  return listActivityAccountSources(accountId)
}

/**
 * Removing a folder stops it being watched. Events already imported from it are
 * left alone — they are the user's history, not a cache of the directory, and a
 * removed export folder is usually a tidied-up download, not a retraction.
 */
export function removeActivityAccountSource(accountId: string, sourcePath: string): ActivityAccountSource[] {
  db.prepare('DELETE FROM activity_account_sources WHERE account_id = ? AND path = ?').run(
    accountId,
    sourcePath.trim()
  )
  syncPrimaryWatchPath(accountId)
  return listActivityAccountSources(accountId)
}

export function updateActivityAccount(accountId: string, update: ActivityAccountUpdate): void {
  const sets: string[] = []
  const values: unknown[] = []
  if (update.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(update.enabled ? 1 : 0)
  }
  if (update.watchPath !== undefined) {
    sets.push('watch_path = ?')
    values.push(update.watchPath)
  }
  if (update.config !== undefined) {
    sets.push('config_json = ?')
    values.push(JSON.stringify(update.config))
  }
  if (sets.length === 0) return
  values.push(accountId)
  db.prepare(`UPDATE activity_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function setActivityAccountCredential(
  accountId: string,
  kind: ActivityCredentialKind | null
): void {
  db.prepare('UPDATE activity_accounts SET credential_stored = ?, credential_kind = ? WHERE id = ?').run(
    kind ? 1 : 0,
    kind,
    accountId
  )
}

export function recordActivityAccountSync(
  accountId: string,
  status: ActivityAccountSyncStatus,
  error: string | null
): void {
  db.prepare('UPDATE activity_accounts SET last_sync_at = ?, last_sync_status = ?, last_error = ? WHERE id = ?').run(
    new Date().toISOString(),
    status,
    error,
    accountId
  )
}

export function touchActivityAccountExport(accountId: string): void {
  db.prepare('UPDATE activity_accounts SET last_export_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    accountId
  )
}

export function getActivityEventsHash(projectId: string): string {
  const eventTables = [
    'browser_events',
    'youtube_events',
    'amazon_events',
    'email_events',
    'knowledge_events',
    'photo_events',
    'location_events',
    'weather_events',
    'subscription_events',
    'account_events',
  ]
  let count = 0
  let latest = ''
  for (const table of eventTables) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(e.occurred_at) AS latest
         FROM ${table} e
         INNER JOIN activity_records r ON r.id = e.record_id
         WHERE r.project_id = ?`
      )
      .get(projectId) as { count: number; latest: string | null } | undefined
    count += row?.count ?? 0
    const l = row?.latest ?? ''
    if (l > latest) latest = l
  }
  return `${count}|${latest}`
}

export function getActivitySummary(projectId: string): ActivitySummary | null {
  const row = db
    .prepare('SELECT id, project_id, summary, source_analyses_json, field_hash, updated_at FROM activity_summary WHERE project_id = ?')
    .get(projectId) as
    | { id: string; project_id: string; summary: string | null; source_analyses_json: string | null; field_hash: string | null; updated_at: string }
    | undefined
  if (!row) return null
  return {
    projectId: row.project_id,
    summary: row.summary ? parseStoredJson<ActivityAnalysis | null>(row.summary, null) : null,
    sourceAnalyses: parseStoredJson<SourceAnalysis[]>(row.source_analyses_json, []),
    fieldHash: row.field_hash,
    updatedAt: row.updated_at,
  }
}

export function setActivitySummary(projectId: string, summary: ActivityAnalysis | null, fieldHash: string | null, sourceAnalyses: SourceAnalysis[] = []): void {
  const existing = db.prepare('SELECT id FROM activity_summary WHERE project_id = ?').get(projectId) as
    | { id: string }
    | undefined
  const now = new Date().toISOString()
  const summaryJson = summary ? JSON.stringify(summary) : null
  const sourceAnalysesJson = JSON.stringify(sourceAnalyses)
  if (existing) {
    db.prepare('UPDATE activity_summary SET summary = ?, source_analyses_json = ?, field_hash = ?, updated_at = ? WHERE project_id = ?').run(
      summaryJson,
      sourceAnalysesJson,
      fieldHash,
      now,
      projectId
    )
  } else {
    db.prepare(
      'INSERT INTO activity_summary (id, project_id, summary, source_analyses_json, field_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), projectId, summaryJson, sourceAnalysesJson, fieldHash, now)
  }
}

export interface StoredFolderContext extends DocumentFolderContext {
  childHash: string
}

function parseProvenance(json: string | null): ContextProvenance | null {
  if (!json) return null
  return parseStoredJson<ContextProvenance | null>(json, null)
}

export function getDocumentFileContext(projectId: string, filePath: string): DocumentFileContext | null {
  const row = db
    .prepare('SELECT file_path, relative_path, content_hash, kind, context, provenance_json, updated_at FROM document_file_contexts WHERE project_id = ? AND file_path = ?')
    .get(projectId, filePath) as
    | { file_path: string; relative_path: string; content_hash: string; kind: string; context: string; provenance_json: string | null; updated_at: string }
    | undefined
  if (!row) return null
  return {
    filePath: row.file_path,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    kind: row.kind === 'image' ? 'image' : 'text',
    context: row.context,
    provenance: parseProvenance(row.provenance_json),
    updatedAt: row.updated_at,
  }
}

// Path-only projection for the cost estimator. The full lister pulls every
// context blob (up to 9KB each), which for a 40k-photo project is tens of MB of
// strings loaded purely to build a Set of paths.
export function listIndexedFilePaths(projectId: string): string[] {
  const rows = db
    .prepare("SELECT file_path FROM document_file_contexts WHERE project_id = ? AND context NOT LIKE 'Context generation failed for%'")
    .all(projectId) as Array<{ file_path: string }>
  return rows.map((row) => row.file_path)
}

// `kind` narrows in SQL rather than in the caller: the People harvest wants text
// only, and this project's image rows outnumber its text rows three to one, so
// filtering afterwards would load megabytes of photo contexts to discard them.
export function listDocumentFileContexts(projectId: string, options?: { kind?: DocumentFileKind }): DocumentFileContext[] {
  const kindClause = options?.kind ? ' AND kind = ?' : ''
  const params: unknown[] = options?.kind ? [projectId, options.kind] : [projectId]
  const rows = db
    .prepare(`SELECT file_path, relative_path, content_hash, kind, context, provenance_json, updated_at FROM document_file_contexts WHERE project_id = ?${kindClause} ORDER BY relative_path`)
    .all(...params) as Array<{ file_path: string; relative_path: string; content_hash: string; kind: string; context: string; provenance_json: string | null; updated_at: string }>
  return rows.map((row) => ({
    filePath: row.file_path,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    kind: row.kind === 'image' ? 'image' : 'text',
    context: row.context,
    provenance: parseProvenance(row.provenance_json),
    updatedAt: row.updated_at,
  }))
}

export function upsertDocumentFileContext(input: {
  projectId: string
  filePath: string
  relativePath: string
  contentHash: string
  context: string
  kind?: DocumentFileKind
  provenance?: ContextProvenance | null
}): void {
  const kind: DocumentFileKind = input.kind === 'image' ? 'image' : 'text'
  const now = new Date().toISOString()
  const provenanceJson = input.provenance ? JSON.stringify(input.provenance) : null
  if (!isFailedContext(input.context)) {
    archiveContextVersion({
      sourceType: 'document-file',
      sourceRef: `project:${input.projectId}:file:${input.relativePath}`,
      sourceLabel: labelWithProject(input.projectId, input.relativePath),
      projectId: input.projectId,
      contentHash: input.contentHash,
      contextShort: deriveContextShort(input.context),
      context: input.context,
      provenance: input.provenance ?? null,
    })
  }
  const existing = db
    .prepare('SELECT id FROM document_file_contexts WHERE project_id = ? AND file_path = ?')
    .get(input.projectId, input.filePath) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE document_file_contexts SET relative_path = ?, content_hash = ?, kind = ?, context = ?, provenance_json = ?, updated_at = ? WHERE id = ?').run(
      input.relativePath,
      input.contentHash,
      kind,
      input.context,
      provenanceJson,
      now,
      existing.id
    )
  } else {
    db.prepare(
      'INSERT INTO document_file_contexts (id, project_id, file_path, relative_path, content_hash, kind, context, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), input.projectId, input.filePath, input.relativePath, input.contentHash, kind, input.context, provenanceJson, now)
  }
}

// Attaches provenance to a node whose context was NOT regenerated — the cached
// path, and the backfill route for anything indexed before provenance existed.
// Guarded on the hash so a chain is never stapled onto text it did not produce.
export function setDocumentFileContextProvenance(input: {
  projectId: string
  filePath: string
  relativePath: string
  contentHash: string
  provenance: ContextProvenance
}): void {
  const changed = db
    .prepare('UPDATE document_file_contexts SET provenance_json = ? WHERE project_id = ? AND file_path = ? AND content_hash = ?')
    .run(JSON.stringify(input.provenance), input.projectId, input.filePath, input.contentHash).changes
  if (changed === 0) return
  backfillContextVersionProvenance(
    `project:${input.projectId}:file:${input.relativePath}`,
    input.contentHash,
    input.provenance
  )
}

// Scoped variants: with several sources on one project, an unscoped prune after
// indexing one source would delete every OTHER source's rows, because they are
// legitimately absent from this run's keep-list.
function isUnder(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

export function pruneDocumentFileContextsUnder(projectId: string, base: string, keepPaths: string[]): void {
  const keep = new Set(keepPaths)
  const rows = db.prepare('SELECT id, file_path FROM document_file_contexts WHERE project_id = ?').all(projectId) as Array<{ id: string; file_path: string }>
  const stale = rows.filter((row) => isUnder(base, row.file_path) && !keep.has(row.file_path)).map((row) => row.id)
  if (stale.length === 0) return
  const stmt = db.prepare('DELETE FROM document_file_contexts WHERE id = ?')
  runInTransaction(() => {
    for (const id of stale) stmt.run(id)
  })
}

export function pruneDocumentFolderContextsUnder(projectId: string, base: string, keepPaths: string[]): void {
  const keep = new Set(keepPaths)
  const rows = db.prepare('SELECT id, folder_path FROM document_folder_contexts WHERE project_id = ?').all(projectId) as Array<{ id: string; folder_path: string }>
  const stale = rows.filter((row) => isUnder(base, row.folder_path) && !keep.has(row.folder_path)).map((row) => row.id)
  if (stale.length === 0) return
  const stmt = db.prepare('DELETE FROM document_folder_contexts WHERE id = ?')
  runInTransaction(() => {
    for (const id of stale) stmt.run(id)
  })
}

export function pruneDocumentFileContexts(projectId: string, keepPaths: string[]): void {
  const keep = new Set(keepPaths)
  const rows = db.prepare('SELECT id, file_path FROM document_file_contexts WHERE project_id = ?').all(projectId) as Array<{ id: string; file_path: string }>
  const stale = rows.filter((row) => !keep.has(row.file_path)).map((row) => row.id)
  if (stale.length === 0) return
  const stmt = db.prepare('DELETE FROM document_file_contexts WHERE id = ?')
  runInTransaction(() => {
    for (const id of stale) stmt.run(id)
  })
}

export function getDocumentFolderContext(projectId: string, folderPath: string): StoredFolderContext | null {
  const row = db
    .prepare('SELECT folder_path, relative_path, child_hash, context_short, context, file_count, provenance_json, updated_at FROM document_folder_contexts WHERE project_id = ? AND folder_path = ?')
    .get(projectId, folderPath) as
    | { folder_path: string; relative_path: string; child_hash: string; context_short: string; context: string; file_count: number; provenance_json: string | null; updated_at: string }
    | undefined
  if (!row) return null
  return {
    folderPath: row.folder_path,
    relativePath: row.relative_path,
    childHash: row.child_hash,
    contextShort: row.context_short,
    context: row.context,
    fileCount: row.file_count,
    provenance: parseProvenance(row.provenance_json),
    updatedAt: row.updated_at,
  }
}

export function listDocumentFolderContexts(projectId: string): DocumentFolderContext[] {
  const rows = db
    .prepare('SELECT folder_path, relative_path, context_short, context, file_count, provenance_json, updated_at FROM document_folder_contexts WHERE project_id = ? ORDER BY relative_path')
    .all(projectId) as Array<{ folder_path: string; relative_path: string; context_short: string; context: string; file_count: number; provenance_json: string | null; updated_at: string }>
  return rows.map((row) => ({
    folderPath: row.folder_path,
    relativePath: row.relative_path,
    contextShort: row.context_short,
    context: row.context,
    fileCount: row.file_count,
    provenance: parseProvenance(row.provenance_json),
    updatedAt: row.updated_at,
  }))
}

export function upsertDocumentFolderContext(input: {
  projectId: string
  folderPath: string
  relativePath: string
  childHash: string
  contextShort: string
  context: string
  fileCount: number
  provenance?: ContextProvenance | null
}): void {
  const now = new Date().toISOString()
  const provenanceJson = input.provenance ? JSON.stringify(input.provenance) : null
  if (!isFailedContext(input.context)) {
    const isRoot = input.relativePath === '.'
    archiveContextVersion({
      sourceType: 'document-folder',
      sourceRef: `project:${input.projectId}:folder:${input.relativePath}`,
      sourceLabel: isRoot
        ? `${getProjectName(input.projectId) ?? 'Project'} index`
        : labelWithProject(input.projectId, `${input.relativePath}/`),
      projectId: input.projectId,
      contentHash: input.childHash,
      contextShort: deriveContextShort(input.context, input.contextShort),
      context: input.context,
      provenance: input.provenance ?? null,
    })
  }
  const existing = db
    .prepare('SELECT id FROM document_folder_contexts WHERE project_id = ? AND folder_path = ?')
    .get(input.projectId, input.folderPath) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE document_folder_contexts SET relative_path = ?, child_hash = ?, context_short = ?, context = ?, file_count = ?, provenance_json = ?, updated_at = ? WHERE id = ?').run(
      input.relativePath,
      input.childHash,
      input.contextShort,
      input.context,
      input.fileCount,
      provenanceJson,
      now,
      existing.id
    )
  } else {
    db.prepare(
      'INSERT INTO document_folder_contexts (id, project_id, folder_path, relative_path, child_hash, context_short, context, file_count, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), input.projectId, input.folderPath, input.relativePath, input.childHash, input.contextShort, input.context, input.fileCount, provenanceJson, now)
  }
}

// Cached-path / backfill writer for folders. See setDocumentFileContextProvenance.
export function setDocumentFolderContextProvenance(input: {
  projectId: string
  folderPath: string
  relativePath: string
  childHash: string
  provenance: ContextProvenance
}): void {
  const changed = db
    .prepare('UPDATE document_folder_contexts SET provenance_json = ? WHERE project_id = ? AND folder_path = ? AND child_hash = ?')
    .run(JSON.stringify(input.provenance), input.projectId, input.folderPath, input.childHash).changes
  if (changed === 0) return
  backfillContextVersionProvenance(
    `project:${input.projectId}:folder:${input.relativePath}`,
    input.childHash,
    input.provenance
  )
}

export function pruneDocumentFolderContexts(projectId: string, keepPaths: string[]): void {
  const keep = new Set(keepPaths)
  const rows = db.prepare('SELECT id, folder_path FROM document_folder_contexts WHERE project_id = ?').all(projectId) as Array<{ id: string; folder_path: string }>
  const stale = rows.filter((row) => !keep.has(row.folder_path)).map((row) => row.id)
  if (stale.length === 0) return
  const stmt = db.prepare('DELETE FROM document_folder_contexts WHERE id = ?')
  runInTransaction(() => {
    for (const id of stale) stmt.run(id)
  })
}

export interface StoredConversationContext {
  conversationId: string
  title: string
  messageHash: string
  contextShort: string
  context: string
  provenance: ContextProvenance | null
  updatedAt: string
}

function mapConversationContext(row: {
  conversation_id: string
  title: string
  message_hash: string
  context_short: string
  context: string
  provenance_json: string | null
  updated_at: string
}): StoredConversationContext {
  return {
    conversationId: row.conversation_id,
    title: row.title,
    messageHash: row.message_hash,
    contextShort: row.context_short,
    context: row.context,
    provenance: row.provenance_json ? JSON.parse(row.provenance_json) as ContextProvenance : null,
    updatedAt: row.updated_at,
  }
}

export function getConversationContext(conversationId: string): StoredConversationContext | null {
  const row = db
    .prepare(
      `SELECT cc.conversation_id, c.title, cc.message_hash, cc.context_short, cc.context, cc.provenance_json, cc.updated_at
       FROM conversation_contexts AS cc
       JOIN conversations AS c ON c.id = cc.conversation_id
       WHERE cc.conversation_id = ?`
    )
    .get(conversationId) as Parameters<typeof mapConversationContext>[0] | undefined
  return row ? mapConversationContext(row) : null
}

// Every conversation context belonging to one project, newest first. The context
// itself is shared: a conversation filed under three projects is summarized once.
export function listProjectConversationContexts(projectId: string): StoredConversationContext[] {
  const rows = db
    .prepare(
      `SELECT cc.conversation_id, c.title, cc.message_hash, cc.context_short, cc.context, cc.provenance_json, cc.updated_at
       FROM conversation_contexts AS cc
       JOIN conversation_projects AS cp ON cp.conversation_id = cc.conversation_id
       JOIN conversations AS c ON c.id = cc.conversation_id
       WHERE cp.project_id = ?
       ORDER BY c.updated_at DESC`
    )
    .all(projectId) as Array<Parameters<typeof mapConversationContext>[0]>
  return rows.map(mapConversationContext)
}

export function upsertConversationContext(input: {
  conversationId: string
  messageHash: string
  contextShort: string
  context: string
  provenance?: ContextProvenance | null
}): void {
  const now = new Date().toISOString()
  const provenanceJson = input.provenance ? JSON.stringify(input.provenance) : null
  const existing = db
    .prepare(
      `SELECT cc.id, cc.context, cc.context_short, cc.message_hash, c.title
       FROM conversation_contexts AS cc
       JOIN conversations AS c ON c.id = cc.conversation_id
       WHERE cc.conversation_id = ?`
    )
    .get(input.conversationId) as
      | { id: string; context: string; context_short: string; message_hash: string; title: string }
      | undefined
  // Nothing generated is ever destroyed: the outgoing summary is archived before
  // the new one lands.
  if (existing && existing.context !== input.context) {
    archiveContextVersion({
      sourceType: 'conversation',
      sourceRef: `conversation:${input.conversationId}`,
      sourceLabel: `Conversation · ${existing.title}`,
      projectId: listConversationProjectIds(input.conversationId)[0] ?? null,
      contentHash: existing.message_hash,
      contextShort: existing.context_short,
      context: existing.context,
    })
  }
  db.prepare(
    `INSERT INTO conversation_contexts (id, conversation_id, message_hash, context_short, context, provenance_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       message_hash = excluded.message_hash,
       context_short = excluded.context_short,
       context = excluded.context,
       provenance_json = excluded.provenance_json,
       updated_at = excluded.updated_at`
  ).run(uuidv4(), input.conversationId, input.messageHash, input.contextShort, input.context, provenanceJson, now)
}

// --- Role session notes -----------------------------------------------------

function mapRoleSessionNote(row: {
  id: string
  conversation_id: string
  title: string
  conversation_title: string
  role_id: string
  project_id: string | null
  session_date: string
  model: string | null
  summary: string
  risk: string
  sections_json: string
  content: string
  turns: number
  file_path: string | null
  generated_at: number
}): RoleSessionNote {
  let sections: RoleSessionNoteSection[] = []
  try {
    const parsed = JSON.parse(row.sections_json) as unknown
    if (Array.isArray(parsed)) sections = parsed as RoleSessionNoteSection[]
  } catch {
    // A note whose sections cannot be read is still worth its prose.
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    roleId: row.role_id,
    projectId: row.project_id,
    sessionDate: row.session_date,
    generatedAt: row.generated_at,
    model: row.model,
    title: row.title,
    summary: row.summary,
    risk: (row.risk as RoleSessionNote['risk']) || 'none',
    sections,
    content: row.content,
    turns: row.turns,
    filePath: row.file_path,
  }
}

const SESSION_NOTE_COLUMNS = `n.id, n.conversation_id, n.title, c.title AS conversation_title, n.role_id, n.project_id,
   n.session_date, n.model, n.summary, n.risk, n.sections_json, n.content, n.turns, n.file_path, n.generated_at`

export function getRoleSessionNote(conversationId: string): RoleSessionNote | null {
  const row = db
    .prepare(
      `SELECT ${SESSION_NOTE_COLUMNS}
       FROM role_session_notes AS n
       JOIN conversations AS c ON c.id = n.conversation_id
       WHERE n.conversation_id = ?`
    )
    .get(conversationId) as Parameters<typeof mapRoleSessionNote>[0] | undefined
  return row ? mapRoleSessionNote(row) : null
}

/** The message hash a stored note was generated from, without loading the note. */
export function getRoleSessionNoteHash(conversationId: string): string | null {
  const row = db
    .prepare('SELECT message_hash FROM role_session_notes WHERE conversation_id = ?')
    .get(conversationId) as { message_hash: string } | undefined
  return row?.message_hash ?? null
}

export function listRoleSessionNotes(filter?: { projectId?: string; roleId?: string; limit?: number }): RoleSessionNote[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter?.projectId) {
    clauses.push('n.project_id = ?')
    params.push(filter.projectId)
  }
  if (filter?.roleId) {
    clauses.push('n.role_id = ?')
    params.push(filter.roleId)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(1000, Math.max(1, Math.floor(filter?.limit ?? 200)))
  const rows = db
    .prepare(
      `SELECT ${SESSION_NOTE_COLUMNS}
       FROM role_session_notes AS n
       JOIN conversations AS c ON c.id = n.conversation_id
       ${where}
       ORDER BY n.session_date DESC, n.generated_at DESC
       LIMIT ${limit}`
    )
    .all(...params) as Array<Parameters<typeof mapRoleSessionNote>[0]>
  return rows.map(mapRoleSessionNote)
}

export function upsertRoleSessionNote(input: {
  conversationId: string
  roleId: string
  projectId: string | null
  sessionDate: string
  messageHash: string
  model: string | null
  title: string
  summary: string
  risk: RoleSessionNote['risk']
  sections: RoleSessionNoteSection[]
  content: string
  turns: number
  filePath: string | null
  sourceLabel: string
}): void {
  const existing = db
    .prepare('SELECT id, content, summary, message_hash FROM role_session_notes WHERE conversation_id = ?')
    .get(input.conversationId) as
      | { id: string; content: string; summary: string; message_hash: string }
      | undefined
  // Nothing generated is ever destroyed: a re-analysed session archives the
  // note it replaces, so the earlier reading of the same conversation survives.
  if (existing && existing.content !== input.content) {
    archiveContextVersion({
      sourceType: 'session-note',
      sourceRef: `session-note:${input.conversationId}`,
      sourceLabel: input.sourceLabel,
      projectId: input.projectId,
      contentHash: existing.message_hash,
      contextShort: existing.summary,
      context: existing.content,
    })
  }
  db.prepare(
    `INSERT INTO role_session_notes
       (id, conversation_id, role_id, project_id, session_date, message_hash, model, title, summary, risk, sections_json, content, turns, file_path, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       role_id = excluded.role_id,
       project_id = excluded.project_id,
       session_date = excluded.session_date,
       message_hash = excluded.message_hash,
       model = excluded.model,
       title = excluded.title,
       summary = excluded.summary,
       risk = excluded.risk,
       sections_json = excluded.sections_json,
       content = excluded.content,
       turns = excluded.turns,
       file_path = excluded.file_path,
       generated_at = excluded.generated_at`
  ).run(
    uuidv4(),
    input.conversationId,
    input.roleId,
    input.projectId,
    input.sessionDate,
    input.messageHash,
    input.model,
    input.title,
    input.summary,
    input.risk,
    JSON.stringify(input.sections),
    input.content,
    input.turns,
    input.filePath,
    Date.now()
  )
}

export function deleteRoleSessionNote(conversationId: string): void {
  db.prepare('DELETE FROM role_session_notes WHERE conversation_id = ?').run(conversationId)
}

// Projects the user has cut off from the life picture. Everything life-scoped —
// the user super-context, memory extraction, the life timeline — filters on this.
export function listSeparateContextProjectIds(): string[] {
  const rows = db
    .prepare(`SELECT id FROM projects WHERE context_scope = 'separate'`)
    .all() as Array<{ id: string }>
  return rows.map((row) => row.id)
}

// Conversations filed under at least one separate-context project. Those are the
// ones memory must not read.
export function listSeparateContextConversationIds(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT cp.conversation_id AS id
       FROM conversation_projects AS cp
       JOIN projects AS p ON p.id = cp.project_id
       WHERE p.context_scope = 'separate'`
    )
    .all() as Array<{ id: string }>
  return rows.map((row) => row.id)
}

// Counts only. The Data page shows one line per source and would otherwise pull
// every file context — thousands of rows of prose — just to render "326 files".
export interface DocumentContextCounts {
  fileCount: number
  folderCount: number
  updatedAt: string | null
  /** File count recorded by the last run that completed over every source. */
  completedFileCount: number | null
  /** Absolute paths of the source roots that have a folder context. */
  rootPaths: string[]
}

export function countDocumentContexts(): Map<string, DocumentContextCounts> {
  const counts = new Map<string, DocumentContextCounts>()
  const entry = (projectId: string) => {
    const existing = counts.get(projectId)
    if (existing) return existing
    const created: DocumentContextCounts = {
      fileCount: 0,
      folderCount: 0,
      updatedAt: null,
      completedFileCount: null,
      rootPaths: [],
    }
    counts.set(projectId, created)
    return created
  }
  const files = db.prepare('SELECT project_id, COUNT(*) AS n FROM document_file_contexts GROUP BY project_id').all() as Array<{ project_id: string; n: number }>
  for (const row of files) entry(row.project_id).fileCount = row.n
  const folders = db.prepare('SELECT project_id, COUNT(*) AS n FROM document_folder_contexts GROUP BY project_id').all() as Array<{ project_id: string; n: number }>
  for (const row of folders) entry(row.project_id).folderCount = row.n
  // document_summary is only written by a run that read every source through to
  // the end, which is what makes it evidence of a *complete* index.
  const meta = db.prepare('SELECT project_id, updated_at, file_count FROM document_summary').all() as Array<{ project_id: string; updated_at: string; file_count: number }>
  for (const row of meta) {
    const record = entry(row.project_id)
    record.updatedAt = row.updated_at
    record.completedFileCount = row.file_count
  }
  const roots = db
    .prepare(`SELECT project_id, folder_path FROM document_folder_contexts WHERE relative_path = '.'`)
    .all() as Array<{ project_id: string; folder_path: string }>
  for (const row of roots) entry(row.project_id).rootPaths.push(row.folder_path)
  return counts
}

export function getDocumentSummaryMeta(projectId: string): { rootPath: string | null; signature: string | null; fileCount: number; folderCount: number; updatedAt: string } | null {
  const row = db
    .prepare('SELECT root_path, signature, file_count, folder_count, updated_at FROM document_summary WHERE project_id = ?')
    .get(projectId) as
    | { root_path: string | null; signature: string | null; file_count: number; folder_count: number; updated_at: string }
    | undefined
  if (!row) return null
  return { rootPath: row.root_path, signature: row.signature, fileCount: row.file_count, folderCount: row.folder_count, updatedAt: row.updated_at }
}

// The project-level synthesis across all connected sources. Only written when a
// project has more than one source; a single-source project reads its lone
// source root directly, so there is no extra LLM call and nothing stored here.
export function getProjectSuperContext(projectId: string): { contextShort: string; context: string; inputHash: string | null } | null {
  const row = db
    .prepare('SELECT context_short, context, input_hash FROM document_summary WHERE project_id = ?')
    .get(projectId) as { context_short: string; context: string; input_hash: string | null } | undefined
  if (!row || !row.context.trim()) return null
  return { contextShort: row.context_short, context: row.context, inputHash: row.input_hash }
}

export function setProjectSuperContext(input: {
  projectId: string
  contextShort: string
  context: string
  inputHash: string
}): void {
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM document_summary WHERE project_id = ?').get(input.projectId) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE document_summary SET context_short = ?, context = ?, input_hash = ?, updated_at = ? WHERE project_id = ?')
      .run(input.contextShort, input.context, input.inputHash, now, input.projectId)
  } else {
    db.prepare('INSERT INTO document_summary (id, project_id, root_path, signature, context_short, context, input_hash, file_count, folder_count, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, 0, 0, ?)')
      .run(uuidv4(), input.projectId, input.contextShort, input.context, input.inputHash, now)
  }
}

export function clearProjectSuperContext(projectId: string): void {
  db.prepare("UPDATE document_summary SET context_short = '', context = '', input_hash = NULL WHERE project_id = ?").run(projectId)
}

export function setDocumentSummaryMeta(input: {
  projectId: string
  rootPath: string | null
  signature: string | null
  fileCount: number
  folderCount: number
}): void {
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM document_summary WHERE project_id = ?').get(input.projectId) as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE document_summary SET root_path = ?, signature = ?, file_count = ?, folder_count = ?, updated_at = ? WHERE project_id = ?').run(
      input.rootPath,
      input.signature,
      input.fileCount,
      input.folderCount,
      now,
      input.projectId
    )
  } else {
    db.prepare(
      'INSERT INTO document_summary (id, project_id, root_path, signature, file_count, folder_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), input.projectId, input.rootPath, input.signature, input.fileCount, input.folderCount, now)
  }
}

export interface ProjectRootContext {
  projectId: string
  projectName: string
  folderPath: string
  childHash: string
  fileCount: number
  contextShort: string
  context: string
}

// Life-scoped only: a project the user marked `separate` is deliberately not
// part of the unified picture, so it never reaches the apex prompt.
export function listProjectRootContexts(): ProjectRootContext[] {
  const rows = db
    .prepare(
      `SELECT f.project_id AS project_id, p.name AS project_name, f.folder_path AS folder_path,
              f.child_hash AS child_hash, f.file_count AS file_count, f.context_short AS context_short, f.context AS context
       FROM document_folder_contexts f
       JOIN projects p ON p.id = f.project_id
       WHERE f.relative_path = '.'
         AND p.context_scope = 'life'
       ORDER BY p.name`
    )
    .all() as Array<{ project_id: string; project_name: string; folder_path: string; child_hash: string; file_count: number; context_short: string; context: string }>
  const mapped: ProjectRootContext[] = rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    folderPath: row.folder_path,
    childHash: row.child_hash,
    fileCount: row.file_count,
    contextShort: row.context_short,
    context: row.context,
  }))

  // A multi-source project has one folder row per source root. The user
  // super-context must see ONE entry per project, or a project with three
  // sources would outvote the rest of the profile three to one — so the
  // project-level synthesis replaces its own source roots where it exists.
  const byProject = new Map<string, ProjectRootContext[]>()
  for (const row of mapped) {
    const list = byProject.get(row.projectId) ?? []
    list.push(row)
    byProject.set(row.projectId, list)
  }

  const out: ProjectRootContext[] = []
  for (const [projectId, roots] of byProject) {
    if (roots.length === 1) {
      out.push(roots[0])
      continue
    }
    const combined = getProjectSuperContext(projectId)
    if (combined) {
      out.push({
        projectId,
        projectName: roots[0].projectName,
        folderPath: `project:${projectId}`,
        childHash: combined.inputHash ?? '',
        fileCount: roots.reduce((sum, r) => sum + r.fileCount, 0),
        contextShort: combined.contextShort,
        context: combined.context,
      })
    } else {
      // Not yet synthesized (sources added but not re-indexed): fall back to the
      // source roots rather than dropping the project out of the profile.
      out.push(...roots)
    }
  }
  return out.sort((a, b) => a.projectName.localeCompare(b.projectName))
}

// Root lookup by project, for walking a provenance chain down from the apex.
export function getProjectRootFolderContext(projectId: string): StoredFolderContext | null {
  const row = db
    .prepare("SELECT folder_path FROM document_folder_contexts WHERE project_id = ? AND relative_path = '.'")
    .get(projectId) as { folder_path: string } | undefined
  return row ? getDocumentFolderContext(projectId, row.folder_path) : null
}

export function getUserSuperContext(): (UserSuperContext & { inputHash: string | null }) | null {
  const row = db
    .prepare('SELECT context_short, context, input_hash, project_count, provenance_json, updated_at FROM user_super_context WHERE id = ?')
    .get('user') as
    | { context_short: string; context: string; input_hash: string | null; project_count: number; provenance_json: string | null; updated_at: string }
    | undefined
  if (!row) return null
  return {
    contextShort: row.context_short,
    context: row.context,
    inputHash: row.input_hash,
    projectCount: row.project_count,
    provenance: parseProvenance(row.provenance_json),
    updatedAt: row.updated_at,
  }
}

export function setUserSuperContext(input: {
  contextShort: string
  context: string
  inputHash: string | null
  projectCount: number
  provenance?: ContextProvenance | null
}): void {
  const now = new Date().toISOString()
  const provenanceJson = input.provenance ? JSON.stringify(input.provenance) : null
  if (input.context.trim() && !isFailedContext(input.context)) {
    archiveContextVersion({
      sourceType: 'user-super-context',
      sourceRef: 'user:super-context',
      sourceLabel: 'User super-context',
      projectId: null,
      contentHash: input.inputHash ?? deriveContextShort(input.context),
      contextShort: deriveContextShort(input.context, input.contextShort),
      context: input.context,
      provenance: input.provenance ?? null,
    })
  }
  const existing = db.prepare('SELECT id FROM user_super_context WHERE id = ?').get('user') as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE user_super_context SET context_short = ?, context = ?, input_hash = ?, project_count = ?, provenance_json = ?, updated_at = ? WHERE id = ?').run(
      input.contextShort,
      input.context,
      input.inputHash,
      input.projectCount,
      provenanceJson,
      now,
      'user'
    )
  } else {
    db.prepare(
      'INSERT INTO user_super_context (id, context_short, context, input_hash, project_count, provenance_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('user', input.contextShort, input.context, input.inputHash, input.projectCount, provenanceJson, now)
  }
}

// Cached-path / backfill writer for the apex node. See setDocumentFileContextProvenance.
export function setUserSuperContextProvenance(inputHash: string, provenance: ContextProvenance): void {
  const changed = db
    .prepare('UPDATE user_super_context SET provenance_json = ? WHERE id = ? AND input_hash = ?')
    .run(JSON.stringify(provenance), 'user', inputHash).changes
  if (changed === 0) return
  backfillContextVersionProvenance('user:super-context', inputHash, provenance)
}

export function getProjectActivityAnalysis(projectId: string): ActivityAnalysis | null {
  const row = db.prepare('SELECT activity_analysis FROM projects WHERE id = ?').get(projectId) as
    | { activity_analysis: string | null }
    | undefined
  if (!row || !row.activity_analysis) return null
  return parseStoredJson<ActivityAnalysis | null>(row.activity_analysis, null)
}

export function updateProjectActivityAnalysis(projectId: string, analysis: ActivityAnalysis | null): void {
  if (analysis) archiveAnalysisVersion('activity-analysis', projectId, 'activity analysis', analysis, analysis.summary)
  db.prepare('UPDATE projects SET activity_analysis = ?, updated_at = ? WHERE id = ?').run(
    analysis ? JSON.stringify(analysis) : null,
    Date.now(),
    projectId
  )
}

export function getProjectFinancesSummary(projectId: string): FinancesSummary | null {
  const row = db.prepare('SELECT finances_summary FROM projects WHERE id = ?').get(projectId) as
    | { finances_summary: string | null }
    | undefined
  if (!row || !row.finances_summary) return null
  return parseStoredJson<FinancesSummary | null>(row.finances_summary, null)
}

export function updateProjectFinancesSummary(projectId: string, summary: FinancesSummary | null): void {
  if (summary) archiveAnalysisVersion('finances-summary', projectId, 'finances summary', summary, summary.summary)
  db.prepare('UPDATE projects SET finances_summary = ?, updated_at = ? WHERE id = ?').run(
    summary ? JSON.stringify(summary) : null,
    Date.now(),
    projectId
  )
}



interface TimelineEventRow {
  id: string
  source_type: string
  source_ref: string
  source_label: string
  project_id: string | null
  project_name: string | null
  category: string
  title: string
  detail: string
  start_date: string
  end_date: string | null
  precision: string
  confidence: number | null
  archived_at: string | null
  last_seen_at: string | null
  context_version_id: string | null
  created_at: string
  updated_at: string
}

function mapTimelineEvent(row: TimelineEventRow): TimelineEvent {
  return {
    id: row.id,
    sourceType: row.source_type as TimelineSourceType,
    sourceRef: row.source_ref,
    sourceLabel: row.source_label,
    projectId: row.project_id,
    projectName: row.project_name,
    category: row.category as TimelineCategory,
    title: row.title,
    detail: row.detail,
    startDate: row.start_date,
    endDate: row.end_date,
    precision: row.precision as TimelinePrecision,
    confidence: row.confidence,
    archivedAt: row.archived_at,
    lastSeenAt: row.last_seen_at,
    contextVersionId: row.context_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const TIMELINE_SELECT = `SELECT e.id, e.source_type, e.source_ref, e.source_label, e.project_id,
    p.name AS project_name, e.category, e.title, e.detail, e.start_date, e.end_date,
    e.precision, e.confidence, e.archived_at, e.last_seen_at, e.context_version_id,
    e.created_at, e.updated_at
  FROM timeline_events e
  LEFT JOIN projects p ON p.id = e.project_id`

export function listTimelineEvents(filter?: TimelineFilter): TimelineEvent[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filter?.includeArchived === false) {
    clauses.push('e.archived_at IS NULL')
  }
  if (filter?.categories && filter.categories.length > 0) {
    clauses.push(`e.category IN (${filter.categories.map(() => '?').join(',')})`)
    params.push(...filter.categories)
  }
  if (filter?.sourceTypes && filter.sourceTypes.length > 0) {
    clauses.push(`e.source_type IN (${filter.sourceTypes.map(() => '?').join(',')})`)
    params.push(...filter.sourceTypes)
  }
  if (filter?.projectIds && filter.projectIds.length > 0) {
    clauses.push(`e.project_id IN (${filter.projectIds.map(() => '?').join(',')})`)
    params.push(...filter.projectIds)
  }
  // Events with no project (memory, the user super-context, manual entries) are
  // life events by definition, so an exclusion must not drop them.
  if (filter?.excludeProjectIds && filter.excludeProjectIds.length > 0) {
    clauses.push(
      `(e.project_id IS NULL OR e.project_id NOT IN (${filter.excludeProjectIds.map(() => '?').join(',')}))`
    )
    params.push(...filter.excludeProjectIds)
  }
  if (filter?.from) {
    clauses.push('(e.end_date IS NULL AND e.start_date >= ? OR e.end_date >= ?)')
    params.push(filter.from, filter.from)
  }
  if (filter?.to) {
    clauses.push('e.start_date <= ?')
    params.push(filter.to)
  }
  if (filter?.search && filter.search.trim()) {
    clauses.push('(e.title LIKE ? OR e.detail LIKE ? OR e.source_label LIKE ?)')
    const like = `%${filter.search.trim()}%`
    params.push(like, like, like)
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const limit = filter?.limit && filter.limit > 0 ? ` LIMIT ${Math.floor(filter.limit)}` : ''
  const rows = db
    .prepare(`${TIMELINE_SELECT}${where} ORDER BY e.start_date ASC, e.title ASC${limit}`)
    .all(...params) as TimelineEventRow[]
  return rows.map(mapTimelineEvent)
}

export function getTimelineEventById(id: string): TimelineEvent | null {
  const row = db.prepare(`${TIMELINE_SELECT} WHERE e.id = ?`).get(id) as TimelineEventRow | undefined
  return row ? mapTimelineEvent(row) : null
}

const TIMELINE_INSERT_SQL = `INSERT OR IGNORE INTO timeline_events
   (id, source_type, source_ref, source_label, project_id, category, title, detail, start_date, end_date, precision, confidence, dedupe_key, archived_at, last_seen_at, context_version_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`

export function insertTimelineEvent(input: TimelineEventInput & { dedupeKey: string; contextVersionId?: string | null }): TimelineEvent | null {
  const now = new Date().toISOString()
  const id = uuidv4()
  const result = db
    .prepare(TIMELINE_INSERT_SQL)
    .run(
      id,
      input.sourceType,
      input.sourceRef,
      input.sourceLabel,
      input.projectId,
      input.category,
      input.title,
      input.detail,
      input.startDate,
      input.endDate,
      input.precision,
      input.confidence,
      input.dedupeKey,
      now,
      input.contextVersionId ?? null,
      now,
      now
    )
  if (result.changes === 0) return null
  return getTimelineEventById(id)
}

// A rebuild refreshes derived rows in place. An event that no longer appears in
// any current context is NOT deleted: it is marked archived, because the context
// it came from was true when it was written. Manual rows are never touched.
export function mergeDerivedTimelineEvents(
  events: Array<TimelineEventInput & { dedupeKey: string; contextVersionId?: string | null }>
): { inserted: number; updated: number; archived: number; manualPreserved: number } {
  const now = new Date().toISOString()
  const existing = db
    .prepare('SELECT id, dedupe_key, source_type, archived_at FROM timeline_events')
    .all() as Array<{ id: string; dedupe_key: string; source_type: string; archived_at: string | null }>
  const byKey = new Map(existing.map((row) => [row.dedupe_key, row]))
  const manualPreserved = existing.filter((row) => row.source_type === 'manual').length

  const insert = db.prepare(TIMELINE_INSERT_SQL)
  const update = db.prepare(
    `UPDATE timeline_events
     SET source_type = ?, source_ref = ?, source_label = ?, project_id = ?, category = ?, title = ?,
         detail = ?, start_date = ?, end_date = ?, precision = ?, confidence = ?,
         archived_at = NULL, last_seen_at = ?, context_version_id = ?, updated_at = ?
     WHERE id = ?`
  )
  const archive = db.prepare('UPDATE timeline_events SET archived_at = ?, updated_at = ? WHERE id = ?')

  let inserted = 0
  let updated = 0
  let archived = 0
  const seen = new Set<string>()

  runInTransaction(() => {
    for (const event of events) {
      seen.add(event.dedupeKey)
      const match = byKey.get(event.dedupeKey)
      if (match) {
        if (match.source_type === 'manual') continue
        update.run(
          event.sourceType,
          event.sourceRef,
          event.sourceLabel,
          event.projectId,
          event.category,
          event.title,
          event.detail,
          event.startDate,
          event.endDate,
          event.precision,
          event.confidence,
          now,
          event.contextVersionId ?? null,
          now,
          match.id
        )
        updated += 1
        continue
      }
      const result = insert.run(
        uuidv4(),
        event.sourceType,
        event.sourceRef,
        event.sourceLabel,
        event.projectId,
        event.category,
        event.title,
        event.detail,
        event.startDate,
        event.endDate,
        event.precision,
        event.confidence,
        event.dedupeKey,
        now,
        event.contextVersionId ?? null,
        now,
        now
      )
      if (result.changes > 0) inserted += 1
    }

    for (const row of existing) {
      if (row.source_type === 'manual') continue
      if (seen.has(row.dedupe_key)) continue
      if (row.archived_at) continue
      archive.run(now, now, row.id)
      archived += 1
    }
  })

  return { inserted, updated, archived, manualPreserved }
}

export function deleteTimelineEvent(id: string): void {
  db.prepare('DELETE FROM timeline_events WHERE id = ?').run(id)
}

export function countTimelineEvents(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM timeline_events').get() as { count: number }).count
}

export function getTimelineEventsHash(): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(MIN(start_date), '') AS first_date,
              COALESCE(MAX(start_date), '') AS last_date,
              COALESCE(SUM(LENGTH(title) + LENGTH(detail)), 0) AS char_total
       FROM timeline_events
       -- The hash gates the LIFE narrative, so a separate project's events must
       -- not make it look stale.
       WHERE project_id IS NULL OR project_id NOT IN (
         SELECT id FROM projects WHERE context_scope = 'separate'
       )`
    )
    .get() as { count: number; first_date: string; last_date: string; char_total: number }
  return `${row.count}:${row.first_date}:${row.last_date}:${row.char_total}`
}

export function getTimelineSummary(): {
  narrative: string
  eras: TimelineEra[]
  inputHash: string | null
  eventCount: number
  updatedAt: string
} | null {
  const row = db
    .prepare('SELECT narrative, eras_json, input_hash, event_count, updated_at FROM timeline_summary WHERE id = ?')
    .get('user') as
    | { narrative: string; eras_json: string; input_hash: string | null; event_count: number; updated_at: string }
    | undefined
  if (!row) return null
  return {
    narrative: row.narrative,
    eras: parseStoredJson<TimelineEra[]>(row.eras_json, []),
    inputHash: row.input_hash,
    eventCount: row.event_count,
    updatedAt: row.updated_at,
  }
}

export function setTimelineSummary(input: {
  narrative: string
  eras: TimelineEra[]
  inputHash: string | null
  eventCount: number
}): void {
  const now = new Date().toISOString()
  const erasJson = JSON.stringify(input.eras)
  const existing = db.prepare('SELECT id FROM timeline_summary WHERE id = ?').get('user') as { id: string } | undefined
  if (existing) {
    db.prepare('UPDATE timeline_summary SET narrative = ?, eras_json = ?, input_hash = ?, event_count = ?, updated_at = ? WHERE id = ?').run(
      input.narrative,
      erasJson,
      input.inputHash,
      input.eventCount,
      now,
      'user'
    )
  } else {
    db.prepare(
      'INSERT INTO timeline_summary (id, narrative, eras_json, input_hash, event_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('user', input.narrative, erasJson, input.inputHash, input.eventCount, now)
  }
}

// --- per-year super-contexts -------------------------------------------------

interface TimelineYearRow {
  year: number
  context_short: string
  context: string
  input_hash: string
  event_count: number
  synthesized: number
  updated_at: string
}

function mapTimelineYear(row: TimelineYearRow): TimelineYearContext {
  return {
    year: row.year,
    contextShort: row.context_short,
    context: row.context,
    eventCount: row.event_count,
    synthesized: row.synthesized === 1,
    updatedAt: row.updated_at,
  }
}

export function listTimelineYearContexts(): TimelineYearContext[] {
  const rows = db
    .prepare('SELECT year, context_short, context, input_hash, event_count, synthesized, updated_at FROM timeline_year_contexts ORDER BY year ASC')
    .all() as TimelineYearRow[]
  return rows.map(mapTimelineYear)
}

/** The stored input hash per year, for deciding what needs regenerating without loading every synthesis. */
export function getTimelineYearHashes(): Map<number, string> {
  const rows = db.prepare('SELECT year, input_hash FROM timeline_year_contexts').all() as Array<{ year: number; input_hash: string }>
  return new Map(rows.map((row) => [row.year, row.input_hash]))
}

export function upsertTimelineYearContext(input: {
  year: number
  contextShort: string
  context: string
  inputHash: string
  eventCount: number
  synthesized: boolean
}): void {
  const now = new Date().toISOString()
  // Same never-destroy contract as every other generated context: the outgoing
  // year synthesis is versioned before the new one lands. A verbatim year is not
  // archived — it is the events themselves, which are already stored.
  if (input.synthesized && input.context.trim()) {
    archiveContextVersion({
      sourceType: 'timeline-year',
      sourceRef: `timeline:year:${input.year}`,
      sourceLabel: `Timeline ${input.year}`,
      projectId: null,
      contentHash: input.inputHash,
      contextShort: input.contextShort,
      context: input.context,
    })
  }
  db.prepare(
    `INSERT INTO timeline_year_contexts (year, context_short, context, input_hash, event_count, synthesized, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(year) DO UPDATE SET
       context_short = excluded.context_short,
       context = excluded.context,
       input_hash = excluded.input_hash,
       event_count = excluded.event_count,
       synthesized = excluded.synthesized,
       updated_at = excluded.updated_at`
  ).run(input.year, input.contextShort, input.context, input.inputHash, input.eventCount, input.synthesized ? 1 : 0, now)
}

/** Drops years that no longer have any events at all — the record they described is gone. */
export function pruneTimelineYearContexts(keepYears: number[]): number {
  const keep = new Set(keepYears)
  const rows = db.prepare('SELECT year FROM timeline_year_contexts').all() as Array<{ year: number }>
  const stale = rows.map((row) => row.year).filter((year) => !keep.has(year))
  if (stale.length === 0) return 0
  const stmt = db.prepare('DELETE FROM timeline_year_contexts WHERE year = ?')
  runInTransaction(() => {
    for (const year of stale) stmt.run(year)
  })
  return stale.length
}

interface ContextVersionRow {
  id: string
  source_type: string
  source_ref: string
  source_label: string
  project_id: string | null
  project_name: string | null
  version: number
  content_hash: string
  context_short: string
  context: string
  provenance_json: string | null
  generated_at: string
  superseded_at: string | null
}

const CONTEXT_VERSION_SELECT = `SELECT v.id, v.source_type, v.source_ref, v.source_label, v.project_id,
    p.name AS project_name, v.version, v.content_hash, v.context_short, v.context,
    v.provenance_json, v.generated_at, v.superseded_at
  FROM context_versions v
  LEFT JOIN projects p ON p.id = v.project_id`

function mapContextVersion(row: ContextVersionRow): ContextVersion {
  return {
    id: row.id,
    sourceType: row.source_type as ContextVersionSourceType,
    sourceRef: row.source_ref,
    sourceLabel: row.source_label,
    projectId: row.project_id,
    projectName: row.project_name,
    version: row.version,
    contentHash: row.content_hash,
    contextShort: row.context_short,
    context: row.context,
    provenance: parseProvenance(row.provenance_json),
    generatedAt: row.generated_at,
    supersededAt: row.superseded_at,
  }
}

// Records a generated context as a numbered version. Regeneration that produces
// identical content is not a new version; anything else supersedes the previous
// row rather than overwriting it, so no analysis is ever lost.
export function archiveContextVersion(input: {
  sourceType: ContextVersionSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  contentHash: string
  contextShort: string
  context: string
  provenance?: ContextProvenance | null
}): ContextVersion | null {
  if (!input.context.trim()) return null

  const latest = db
    .prepare('SELECT id, version, content_hash FROM context_versions WHERE source_ref = ? ORDER BY version DESC LIMIT 1')
    .get(input.sourceRef) as { id: string; version: number; content_hash: string } | undefined

  if (latest && latest.content_hash === input.contentHash) return null

  const now = new Date().toISOString()
  const id = uuidv4()
  const version = (latest?.version ?? 0) + 1

  runInTransaction(() => {
    if (latest) {
      db.prepare('UPDATE context_versions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL').run(now, latest.id)
    }
    db.prepare(
      `INSERT INTO context_versions
       (id, source_type, source_ref, source_label, project_id, version, content_hash, context_short, context, provenance_json, generated_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(
      id,
      input.sourceType,
      input.sourceRef,
      input.sourceLabel,
      input.projectId,
      version,
      input.contentHash,
      input.contextShort,
      input.context,
      input.provenance ? JSON.stringify(input.provenance) : null,
      now
    )
  })

  const row = db.prepare(`${CONTEXT_VERSION_SELECT} WHERE v.id = ?`).get(id) as ContextVersionRow | undefined
  return row ? mapContextVersion(row) : null
}

// Attaches provenance to an archived version that predates it. Matched on
// content hash so a chain can only ever land on the exact text it explains.
export function backfillContextVersionProvenance(
  sourceRef: string,
  contentHash: string,
  provenance: ContextProvenance
): void {
  db.prepare(
    'UPDATE context_versions SET provenance_json = ? WHERE source_ref = ? AND content_hash = ? AND provenance_json IS NULL'
  ).run(JSON.stringify(provenance), sourceRef, contentHash)
}

export function getContextVersion(id: string): ContextVersion | null {
  const row = db.prepare(`${CONTEXT_VERSION_SELECT} WHERE v.id = ?`).get(id) as ContextVersionRow | undefined
  return row ? mapContextVersion(row) : null
}

export function listContextVersions(filter?: ContextVersionFilter): ContextVersionSummary[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter?.sourceTypes && filter.sourceTypes.length > 0) {
    clauses.push(`v.source_type IN (${filter.sourceTypes.map(() => '?').join(',')})`)
    params.push(...filter.sourceTypes)
  }
  if (filter?.sourceRef) {
    clauses.push('v.source_ref = ?')
    params.push(filter.sourceRef)
  }
  if (filter?.projectIds && filter.projectIds.length > 0) {
    clauses.push(`v.project_id IN (${filter.projectIds.map(() => '?').join(',')})`)
    params.push(...filter.projectIds)
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const limit = filter?.limit && filter.limit > 0 ? ` LIMIT ${Math.floor(filter.limit)}` : ''
  const rows = db
    .prepare(
      `SELECT v.id, v.source_type, v.source_ref, v.source_label, v.project_id, p.name AS project_name,
              v.version, v.context_short, LENGTH(v.context) AS char_count, v.generated_at, v.superseded_at
       FROM context_versions v
       LEFT JOIN projects p ON p.id = v.project_id${where}
       ORDER BY v.generated_at DESC, v.version DESC${limit}`
    )
    .all(...params) as Array<Omit<ContextVersionRow, 'content_hash' | 'context'> & { char_count: number }>

  return rows.map((row) => ({
    id: row.id,
    sourceType: row.source_type as ContextVersionSourceType,
    sourceRef: row.source_ref,
    sourceLabel: row.source_label,
    projectId: row.project_id,
    projectName: row.project_name,
    version: row.version,
    contextShort: row.context_short,
    charCount: row.char_count,
    generatedAt: row.generated_at,
    supersededAt: row.superseded_at,
  }))
}

export function listAllContextVersions(): ContextVersion[] {
  const rows = db
    .prepare(`${CONTEXT_VERSION_SELECT} ORDER BY v.generated_at ASC, v.version ASC`)
    .all() as ContextVersionRow[]
  return rows.map(mapContextVersion)
}

export function countContextVersions(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM context_versions').get() as { count: number }).count
}

export function getProjectName(projectId: string | null): string | null {
  if (!projectId) return null
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined
  return row?.name ?? null
}

function labelWithProject(projectId: string | null, label: string): string {
  const name = getProjectName(projectId)
  return name ? `${name} · ${label}` : label
}

// Structured analyses live as JSON on the project row. The whole object is
// archived so a superseded analysis stays inspectable, not just its prose.
function archiveAnalysisVersion(
  sourceType: ContextVersionSourceType,
  projectId: string,
  label: string,
  analysis: unknown,
  summary: string | undefined
): void {
  try {
    const serialized = JSON.stringify(analysis)
    if (!serialized || serialized === 'null') return
    archiveContextVersion({
      sourceType,
      sourceRef: `project:${projectId}:${sourceType}`,
      sourceLabel: labelWithProject(projectId, label),
      projectId,
      contentHash: hashText(serialized),
      contextShort: deriveContextShort(summary ?? ''),
      context: serialized,
    })
  } catch {
    // Archiving must never block storing the analysis itself.
  }
}

function hashText(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return `${value.length}:${hash}`
}

// --- People ------------------------------------------------------------------

interface PersonRow {
  id: string
  person_key: string
  display_name: string
  relation: string
  role: string
  status: string
  is_pseudonym: number
  is_self: number
  seed_source: string | null
  mention_count: number
  source_count: number
  message_count: number
  sent_count: number
  days_active: number
  first_seen: string | null
  last_seen: string | null
  score: number
  confidence: number
  project_ids_json: string
  platforms_json: string
  dossier_short: string
  dossier: string
  dossier_hash: string | null
  dossier_updated_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

function mapPerson(row: PersonRow, aliases: PersonAlias[] = []): Person {
  return {
    id: row.id,
    personKey: row.person_key,
    displayName: row.display_name,
    relation: row.relation as PersonRelation,
    role: row.role,
    status: row.status as PersonStatus,
    isPseudonym: row.is_pseudonym === 1,
    isSelf: row.is_self === 1,
    seedSource: (row.seed_source as PersonSeedSource | null) ?? null,
    mentionCount: row.mention_count,
    sourceCount: row.source_count,
    messageCount: row.message_count,
    sentCount: row.sent_count,
    daysActive: row.days_active,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    score: row.score,
    confidence: row.confidence,
    projectIds: parseStoredJson<string[]>(row.project_ids_json, []),
    platforms: parseStoredJson<PersonPlatform[]>(row.platforms_json, []),
    dossierShort: row.dossier_short,
    dossier: row.dossier,
    dossierHash: row.dossier_hash,
    dossierUpdatedAt: row.dossier_updated_at,
    archivedAt: row.archived_at,
    aliases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPersonAlias(row: {
  id: string
  person_id: string
  alias: string
  alias_key: string
  kind: string
  origin: string
  created_at: string
}): PersonAlias {
  return {
    id: row.id,
    personId: row.person_id,
    alias: row.alias,
    aliasKey: row.alias_key,
    kind: row.kind as PersonAliasKind,
    origin: row.origin as PersonAliasOrigin,
    createdAt: row.created_at,
  }
}

function aliasesByPerson(personIds: string[]): Map<string, PersonAlias[]> {
  const out = new Map<string, PersonAlias[]>()
  if (personIds.length === 0) return out
  const rows = db
    .prepare(`SELECT * FROM people_aliases WHERE person_id IN (${personIds.map(() => '?').join(',')}) ORDER BY alias_key`)
    .all(...personIds) as Array<Parameters<typeof mapPersonAlias>[0]>
  for (const row of rows) {
    const alias = mapPersonAlias(row)
    const bucket = out.get(alias.personId)
    if (bucket) bucket.push(alias)
    else out.set(alias.personId, [alias])
  }
  return out
}

export function listPeople(filter?: PeopleFilter): Person[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (!filter?.includeArchived) clauses.push('p.archived_at IS NULL')
  if (!filter?.includeIgnored) clauses.push("p.status <> 'ignored'")
  if (!filter?.includePseudonyms) clauses.push('p.is_pseudonym = 0')
  // The archive's owner is never one of the people in it.
  clauses.push('p.is_self = 0')

  if (filter?.relations?.length) {
    clauses.push(`p.relation IN (${filter.relations.map(() => '?').join(',')})`)
    params.push(...filter.relations)
  }
  if (typeof filter?.minScore === 'number') {
    clauses.push('p.score >= ?')
    params.push(filter.minScore)
  }
  if (filter?.search) {
    clauses.push('(p.display_name LIKE ? OR p.role LIKE ?)')
    params.push(`%${filter.search}%`, `%${filter.search}%`)
  }
  // Scoping goes through the mention table: a person belongs to a project only
  // because some source inside it named them.
  if (filter?.projectIds?.length) {
    clauses.push(
      `EXISTS (SELECT 1 FROM people_mentions m WHERE m.person_id = p.id AND m.archived_at IS NULL AND m.project_id IN (${filter.projectIds.map(() => '?').join(',')}))`
    )
    params.push(...filter.projectIds)
  }
  if (filter?.excludeProjectIds?.length) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM people_mentions m WHERE m.person_id = p.id AND m.archived_at IS NULL AND m.project_id IN (${filter.excludeProjectIds.map(() => '?').join(',')}))`
    )
    params.push(...filter.excludeProjectIds)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = typeof filter?.limit === 'number' && filter.limit > 0 ? `LIMIT ${Math.floor(filter.limit)}` : ''
  const rows = db
    .prepare(`SELECT p.* FROM people p ${where} ORDER BY p.score DESC, p.message_count DESC, p.source_count DESC, p.display_name ASC ${limit}`)
    .all(...params) as PersonRow[]

  const aliases = aliasesByPerson(rows.map((row) => row.id))
  return rows.map((row) => mapPerson(row, aliases.get(row.id) ?? []))
}

export function getPersonById(id: string): Person | null {
  const row = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined
  if (!row) return null
  return mapPerson(row, aliasesByPerson([row.id]).get(row.id) ?? [])
}

export function getPersonByKey(personKey: string): Person | null {
  const row = db.prepare('SELECT * FROM people WHERE person_key = ?').get(personKey) as PersonRow | undefined
  if (!row) return null
  return mapPerson(row, aliasesByPerson([row.id]).get(row.id) ?? [])
}

function mapPersonMention(row: {
  id: string
  person_id: string | null
  mention_key: string
  raw_name: string
  name_key: string
  handle_key: string | null
  relation: string
  role: string
  aka_json: string
  evidence: string
  source_type: string
  source_ref: string
  source_label: string
  project_id: string | null
  project_name: string | null
  confidence: number
  resolution_rule: string
  archived_at: string | null
  created_at: string
  updated_at: string
}): PersonMention {
  return {
    id: row.id,
    personId: row.person_id,
    mentionKey: row.mention_key,
    rawName: row.raw_name,
    nameKey: row.name_key,
    handleKey: row.handle_key,
    relation: row.relation as PersonRelation,
    role: row.role,
    aka: parseStoredJson<string[]>(row.aka_json, []),
    evidence: row.evidence,
    sourceType: row.source_type as PersonSourceType,
    sourceRef: row.source_ref,
    sourceLabel: row.source_label,
    projectId: row.project_id,
    projectName: row.project_name,
    confidence: row.confidence,
    resolutionRule: row.resolution_rule,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const PERSON_MENTION_SELECT = `
  SELECT m.*, pr.name AS project_name
  FROM people_mentions m
  LEFT JOIN projects pr ON pr.id = m.project_id
`

export function listPersonMentions(personId: string, options?: { includeArchived?: boolean }): PersonMention[] {
  const archived = options?.includeArchived ? '' : 'AND m.archived_at IS NULL'
  const rows = db
    .prepare(`${PERSON_MENTION_SELECT} WHERE m.person_id = ? ${archived} ORDER BY m.confidence DESC, m.source_ref ASC`)
    .all(personId) as Array<Parameters<typeof mapPersonMention>[0]>
  return rows.map(mapPersonMention)
}

export function listAllPersonMentions(options?: { includeArchived?: boolean }): PersonMention[] {
  const archived = options?.includeArchived ? '' : 'WHERE m.archived_at IS NULL'
  const rows = db
    .prepare(`${PERSON_MENTION_SELECT} ${archived} ORDER BY m.mention_key ASC`)
    .all() as Array<Parameters<typeof mapPersonMention>[0]>
  return rows.map(mapPersonMention)
}

export interface StoredPersonInput {
  personKey: string
  displayName: string
  relation: PersonRelation
  role: string
  status: PersonStatus
  isPseudonym: boolean
  isSelf: boolean
  seedSource: PersonSeedSource | null
  mentionCount: number
  sourceCount: number
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
  score: number
  confidence: number
  projectIds: string[]
  platforms: PersonPlatform[]
  aliases: Array<{ alias: string; aliasKey: string; kind: PersonAliasKind; origin: PersonAliasOrigin }>
}

export interface StoredPersonMentionInput {
  mentionKey: string
  personKey: string
  rawName: string
  nameKey: string
  handleKey: string | null
  relation: PersonRelation
  role: string
  aka: string[]
  evidence: string
  sourceType: PersonSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  confidence: number
  resolutionRule: string
}

/**
 * Writes a resolved pass. Merge, never replace — a person whose sources have all
 * gone quiet is marked `archived_at` and keeps their dossier and their history,
 * exactly as `mergeDerivedTimelineEvents` does for events. Returning to the
 * evidence un-archives them.
 *
 * The generated dossier is never touched here: it is keyed on `person_key`,
 * which is stable, so a rebuild that recomputes every statistic still leaves the
 * expensive artifact in place.
 */
export function mergeDerivedPeople(
  people: StoredPersonInput[],
  mentions: StoredPersonMentionInput[]
): { inserted: number; updated: number; archived: number } {
  const now = new Date().toISOString()
  let inserted = 0
  let updated = 0
  let archived = 0

  return runInTransaction(() => {
    const existing = db.prepare('SELECT id, person_key FROM people').all() as Array<{ id: string; person_key: string }>
    const idByKey = new Map(existing.map((row) => [row.person_key, row.id]))
    const seen = new Set<string>()

    const insertPerson = db.prepare(`
      INSERT INTO people (
        id, person_key, display_name, relation, role, status, is_pseudonym, is_self, seed_source,
        mention_count, source_count, message_count, sent_count, days_active, first_seen, last_seen,
        score, confidence, project_ids_json, platforms_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updatePerson = db.prepare(`
      UPDATE people SET
        display_name = ?, relation = ?, role = ?, status = ?, is_pseudonym = ?, is_self = ?,
        seed_source = ?, mention_count = ?, source_count = ?, message_count = ?, sent_count = ?,
        days_active = ?, first_seen = ?, last_seen = ?, score = ?, confidence = ?,
        project_ids_json = ?, platforms_json = ?, archived_at = NULL, updated_at = ?
      WHERE id = ?
    `)
    const clearAliases = db.prepare("DELETE FROM people_aliases WHERE person_id = ? AND origin <> 'manual'")
    const insertAlias = db.prepare(`
      INSERT OR IGNORE INTO people_aliases (id, person_id, alias, alias_key, kind, origin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    for (const person of people) {
      seen.add(person.personKey)
      const projectIds = JSON.stringify(person.projectIds)
      let id = idByKey.get(person.personKey)
      if (id) {
        updatePerson.run(
          person.displayName, person.relation, person.role, person.status,
          person.isPseudonym ? 1 : 0, person.isSelf ? 1 : 0, person.seedSource,
          person.mentionCount, person.sourceCount, person.messageCount, person.sentCount,
          person.daysActive, person.firstSeen, person.lastSeen, person.score, person.confidence,
          projectIds, JSON.stringify(person.platforms), now, id
        )
        updated += 1
      } else {
        id = uuidv4()
        insertPerson.run(
          id, person.personKey, person.displayName, person.relation, person.role, person.status,
          person.isPseudonym ? 1 : 0, person.isSelf ? 1 : 0, person.seedSource,
          person.mentionCount, person.sourceCount, person.messageCount, person.sentCount,
          person.daysActive, person.firstSeen, person.lastSeen, person.score, person.confidence,
          projectIds, JSON.stringify(person.platforms), now, now
        )
        idByKey.set(person.personKey, id)
        inserted += 1
      }
      clearAliases.run(id)
      for (const alias of person.aliases) {
        insertAlias.run(uuidv4(), id, alias.alias, alias.aliasKey, alias.kind, alias.origin, now)
      }
    }

    const archiveStmt = db.prepare('UPDATE people SET archived_at = ?, updated_at = ? WHERE id = ?')
    for (const row of existing) {
      if (seen.has(row.person_key)) continue
      archiveStmt.run(now, now, row.id)
      archived += 1
    }

    // Mentions: upsert by mention_key, then archive the ones no source reports.
    const existingMentions = db.prepare('SELECT id, mention_key FROM people_mentions').all() as Array<{ id: string; mention_key: string }>
    const mentionIdByKey = new Map(existingMentions.map((row) => [row.mention_key, row.id]))
    const seenMentions = new Set<string>()

    const insertMention = db.prepare(`
      INSERT INTO people_mentions (
        id, person_id, mention_key, raw_name, name_key, handle_key, relation, role, aka_json,
        evidence, source_type, source_ref, source_label, project_id, confidence, resolution_rule,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const updateMention = db.prepare(`
      UPDATE people_mentions SET
        person_id = ?, raw_name = ?, name_key = ?, handle_key = ?, relation = ?, role = ?,
        aka_json = ?, evidence = ?, source_type = ?, source_ref = ?, source_label = ?,
        project_id = ?, confidence = ?, resolution_rule = ?, archived_at = NULL, updated_at = ?
      WHERE id = ?
    `)

    for (const mention of mentions) {
      seenMentions.add(mention.mentionKey)
      const personId = idByKey.get(mention.personKey) ?? null
      const aka = JSON.stringify(mention.aka)
      const id = mentionIdByKey.get(mention.mentionKey)
      if (id) {
        updateMention.run(
          personId, mention.rawName, mention.nameKey, mention.handleKey, mention.relation,
          mention.role, aka, mention.evidence, mention.sourceType, mention.sourceRef,
          mention.sourceLabel, mention.projectId, mention.confidence, mention.resolutionRule, now, id
        )
      } else {
        insertMention.run(
          uuidv4(), personId, mention.mentionKey, mention.rawName, mention.nameKey, mention.handleKey,
          mention.relation, mention.role, aka, mention.evidence, mention.sourceType, mention.sourceRef,
          mention.sourceLabel, mention.projectId, mention.confidence, mention.resolutionRule, now, now
        )
      }
    }

    const archiveMention = db.prepare('UPDATE people_mentions SET archived_at = ?, updated_at = ? WHERE id = ?')
    for (const row of existingMentions) {
      if (seenMentions.has(row.mention_key)) continue
      archiveMention.run(now, now, row.id)
    }

    return { inserted, updated, archived }
  })
}

export function setPersonDossier(input: {
  personKey: string
  contextShort: string
  context: string
  dossierHash: string
}): void {
  const row = db.prepare('SELECT id, display_name FROM people WHERE person_key = ?').get(input.personKey) as
    | { id: string; display_name: string }
    | undefined
  if (!row) return
  if (isFailedContext(input.context)) return

  // Nothing generated is ever destroyed: the outgoing dossier is versioned first.
  archiveContextVersion({
    sourceType: 'person-dossier',
    sourceRef: `person:${input.personKey}`,
    sourceLabel: `Person · ${row.display_name}`,
    projectId: null,
    contentHash: input.dossierHash,
    contextShort: input.contextShort,
    context: input.context,
  })

  const now = new Date().toISOString()
  db.prepare(
    'UPDATE people SET dossier_short = ?, dossier = ?, dossier_hash = ?, dossier_updated_at = ?, updated_at = ? WHERE id = ?'
  ).run(input.contextShort, input.context, input.dossierHash, now, now, row.id)
}

export function listPeopleOverrides(): PersonOverride[] {
  const rows = db.prepare('SELECT * FROM people_overrides ORDER BY created_at ASC').all() as Array<{
    id: string
    kind: string
    subject: string
    target: string | null
    created_at: string
  }>
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as PersonOverrideKind,
    subject: row.subject,
    target: row.target,
    createdAt: row.created_at,
  }))
}

export function setPeopleOverride(kind: PersonOverrideKind, subject: string, target: string | null): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO people_overrides (id, kind, subject, target, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (kind, subject) DO UPDATE SET target = excluded.target
  `).run(uuidv4(), kind, subject, target, now)
}

export function clearPeopleOverride(kind: PersonOverrideKind, subject: string): void {
  db.prepare('DELETE FROM people_overrides WHERE kind = ? AND subject = ?').run(kind, subject)
}

/**
 * Per-counterparty messaging statistics, straight out of `account_events`.
 *
 * This is the People seed layer's spine: 200k iMessage rows already carry a
 * contact-resolved `counterparty`, so every statistic the retired relationship
 * analysis claimed to produce comes from here instead — deterministically, with
 * no model call and no iMessage database access.
 */
export function listMessagingCounterparties(minMessages = 1): Array<{
  name: string
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
}> {
  const rows = db.prepare(`
    SELECT counterparty AS name,
           COUNT(*) AS message_count,
           SUM(CASE WHEN json_extract(source_meta_json, '$.direction') = 'sent' THEN 1 ELSE 0 END) AS sent_count,
           COUNT(DISTINCT substr(occurred_at, 1, 10)) AS days_active,
           MIN(occurred_at) AS first_seen,
           MAX(occurred_at) AS last_seen
    FROM account_events
    WHERE counterparty IS NOT NULL AND counterparty <> ''
    GROUP BY counterparty
    HAVING COUNT(*) >= ?
    ORDER BY message_count DESC
  `).all(minMessages) as Array<{
    name: string
    message_count: number
    sent_count: number | null
    days_active: number
    first_seen: string | null
    last_seen: string | null
  }>
  return rows.map((row) => ({
    name: row.name,
    messageCount: row.message_count,
    sentCount: row.sent_count ?? 0,
    daysActive: row.days_active,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }))
}

/**
 * Per-counterparty statistics broken down by platform.
 *
 * Kept separate from the collapsed total because the breakdown is the answer to
 * "where does this relationship actually live" — a person you message daily and
 * a person you only share a professional network with are not the same
 * relationship, and one summed number cannot tell them apart.
 */
export function listMessagingPlatforms(minMessages = 1): Array<{
  name: string
  provider: string
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
}> {
  const rows = db.prepare(`
    SELECT counterparty AS name, provider,
           COUNT(*) AS message_count,
           SUM(CASE WHEN json_extract(source_meta_json, '$.direction') = 'sent' THEN 1 ELSE 0 END) AS sent_count,
           COUNT(DISTINCT substr(occurred_at, 1, 10)) AS days_active,
           MIN(occurred_at) AS first_seen,
           MAX(occurred_at) AS last_seen
    FROM account_events
    WHERE counterparty IS NOT NULL AND counterparty <> ''
    GROUP BY counterparty, provider
    HAVING COUNT(*) >= ?
    ORDER BY message_count DESC
  `).all(minMessages) as Array<{
    name: string
    provider: string
    message_count: number
    sent_count: number | null
    days_active: number
    first_seen: string | null
    last_seen: string | null
  }>
  return rows.map((row) => ({
    name: row.name,
    provider: row.provider,
    messageCount: row.message_count,
    sentCount: row.sent_count ?? 0,
    daysActive: row.days_active,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }))
}

/** Which calendar years a counterparty has message history in, and how much. */
export function listCounterpartyYears(names: string[]): Array<{ name: string; year: number; messageCount: number }> {
  if (names.length === 0) return []
  const rows = db
    .prepare(`
      SELECT counterparty AS name, CAST(substr(occurred_at, 1, 4) AS INTEGER) AS year, COUNT(*) AS n
      FROM account_events
      WHERE counterparty IN (${names.map(() => '?').join(',')})
      GROUP BY counterparty, year
      ORDER BY name, year
    `)
    .all(...names) as Array<{ name: string; year: number; n: number }>
  return rows.map((row) => ({ name: row.name, year: row.year, messageCount: row.n }))
}

/**
 * One year of a counterparty's messages, evenly sampled down to `limit`.
 *
 * The stride is the point: a busy year holds thousands of messages against a
 * bounded prompt, and taking the first or last N would describe one week and
 * call it a year. `NTILE` spreads the sample across the whole year so the
 * summary reflects it.
 */
export function listCounterpartyMessages(
  name: string,
  year: number,
  limit: number
): Array<{ occurredAt: string; direction: string; text: string }> {
  const rows = db
    .prepare(`
      SELECT occurred_at, source_meta_json, detail FROM (
        SELECT occurred_at, source_meta_json, detail,
               ROW_NUMBER() OVER (ORDER BY occurred_at) AS rn,
               COUNT(*) OVER () AS total
        FROM account_events
        WHERE counterparty = ? AND CAST(substr(occurred_at, 1, 4) AS INTEGER) = ?
          AND detail IS NOT NULL AND detail <> ''
      )
      WHERE total <= ? OR (rn - 1) % CAST(MAX(total / ?, 1) AS INTEGER) = 0
      ORDER BY occurred_at
      LIMIT ?
    `)
    .all(name, year, limit, limit, limit) as Array<{
      occurred_at: string
      source_meta_json: string
      detail: string
    }>
  return rows.map((row) => ({
    occurredAt: row.occurred_at,
    direction: parseStoredJson<{ direction?: string }>(row.source_meta_json, {}).direction === 'sent' ? 'sent' : 'received',
    text: row.detail,
  }))
}

function mapPersonYearContext(row: {
  person_key: string
  year: number
  context: string
  message_count: number
  sampled_count: number
  updated_at: string
}): PersonYearContext {
  return {
    personKey: row.person_key,
    year: row.year,
    context: row.context,
    messageCount: row.message_count,
    sampledCount: row.sampled_count,
    updatedAt: row.updated_at,
  }
}

export function listPersonYearContexts(personKey: string): PersonYearContext[] {
  const rows = db
    .prepare('SELECT * FROM people_year_contexts WHERE person_key = ? ORDER BY year')
    .all(personKey) as Array<Parameters<typeof mapPersonYearContext>[0]>
  return rows.map(mapPersonYearContext)
}

export function getPersonYearHashes(): Map<string, string> {
  const rows = db.prepare('SELECT person_key, year, input_hash FROM people_year_contexts').all() as Array<{
    person_key: string
    year: number
    input_hash: string
  }>
  return new Map(rows.map((row) => [`${row.person_key}:${row.year}`, row.input_hash]))
}

export function upsertPersonYearContext(input: {
  personKey: string
  displayName: string
  year: number
  context: string
  messageCount: number
  sampledCount: number
  inputHash: string
}): void {
  if (isFailedContext(input.context)) return
  archiveContextVersion({
    sourceType: 'person-year',
    sourceRef: `person:${input.personKey}:year:${input.year}`,
    sourceLabel: `${input.displayName} · ${input.year}`,
    projectId: null,
    contentHash: input.inputHash,
    contextShort: deriveContextShort(input.context),
    context: input.context,
  })
  const now = new Date().toISOString()
  const existing = db
    .prepare('SELECT id FROM people_year_contexts WHERE person_key = ? AND year = ?')
    .get(input.personKey, input.year) as { id: string } | undefined
  if (existing) {
    db.prepare(
      'UPDATE people_year_contexts SET context = ?, message_count = ?, sampled_count = ?, input_hash = ?, updated_at = ? WHERE id = ?'
    ).run(input.context, input.messageCount, input.sampledCount, input.inputHash, now, existing.id)
  } else {
    db.prepare(
      'INSERT INTO people_year_contexts (id, person_key, year, context, message_count, sampled_count, input_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), input.personKey, input.year, input.context, input.messageCount, input.sampledCount, input.inputHash, now)
  }
}

/**
 * Absorbs any stored iMessage relationship analysis into People, then clears the
 * column so it can never be absorbed twice.
 *
 * On the machine this was written for every row is already NULL, and always was:
 * the analysis depended on `buildContactMap()`, which shells out to osascript and
 * silently returns nothing. The pass exists so a database where it *did* run does
 * not lose the only structured people data it had.
 */
export function absorbRelationshipAnalyses(): number {
  const rows = db
    .prepare('SELECT id, name, relationship_analysis FROM projects WHERE relationship_analysis IS NOT NULL')
    .all() as Array<{ id: string; name: string; relationship_analysis: string }>
  if (rows.length === 0) return 0

  const now = new Date().toISOString()
  let absorbed = 0
  runInTransaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO people_mentions (
        id, person_id, mention_key, raw_name, name_key, handle_key, relation, role, aka_json,
        evidence, source_type, source_ref, source_label, project_id, confidence, resolution_rule,
        created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, '[]', ?, 'relationship-analysis', ?, ?, ?, 0.5, '', ?, ?)
    `)
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.relationship_analysis) as { relationships?: Array<Record<string, unknown>> }
        for (const entry of parsed.relationships ?? []) {
          const name = typeof entry.name === 'string' ? entry.name.trim() : ''
          if (!name) continue
          const sourceRef = `project:${row.id}:relationship-analysis`
          insert.run(
            uuidv4(), `${sourceRef}::${name.toLowerCase()}`, name, name.toLowerCase(),
            typeof entry.type === 'string' ? entry.type : 'unknown', '',
            typeof entry.insight === 'string' ? entry.insight : '',
            sourceRef, `${row.name} relationship analysis`, row.id, now, now
          )
          absorbed += 1
        }
      } catch {
        // A malformed blob is not worth failing a migration over.
      }
      db.prepare('UPDATE projects SET relationship_analysis = NULL WHERE id = ?').run(row.id)
    }
  })
  return absorbed
}

// ---------------------------------------------------------------------------
// Library
//
// The shelf and the reading record. Note what is absent: no book text. Chapter
// content is re-derived from the file on disk on every read, which is what keeps
// book prose out of the database — and therefore out of memory, recall and the
// document indexer — entirely.
// ---------------------------------------------------------------------------

function mapBook(row: {
  id: string
  project_id: string
  source_path: string
  file_path: string
  relative_path: string
  format: string
  identity_hash: string
  text_hash: string
  file_size: number
  title: string
  subtitle: string | null
  authors_json: string
  publisher: string | null
  published_date: string | null
  language: string | null
  identifier: string | null
  subjects_json: string
  description: string | null
  cover_data_url: string | null
  chapter_count: number
  word_count: number
  status: string
  scan_error: string | null
  missing_since: string | null
  added_at: number
  updated_at: number
}): Book {
  const parseList = (value: string): string[] => {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    sourcePath: row.source_path,
    filePath: row.file_path,
    relativePath: row.relative_path,
    format: row.format === 'pdf' ? 'pdf' : 'epub',
    identityHash: row.identity_hash,
    textHash: row.text_hash,
    fileSize: row.file_size,
    title: row.title,
    subtitle: row.subtitle,
    authors: parseList(row.authors_json),
    publisher: row.publisher,
    publishedDate: row.published_date,
    language: row.language,
    identifier: row.identifier,
    subjects: parseList(row.subjects_json),
    description: row.description,
    coverDataUrl: row.cover_data_url,
    chapterCount: row.chapter_count,
    wordCount: row.word_count,
    status: row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : 'pending',
    scanError: row.scan_error,
    missingSince: row.missing_since,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  }
}

const BOOK_COLUMNS = `id, project_id, source_path, file_path, relative_path, format, identity_hash,
  text_hash, file_size, title, subtitle, authors_json, publisher, published_date, language,
  identifier, subjects_json, description, cover_data_url, chapter_count, word_count, status,
  scan_error, missing_since, added_at, updated_at`

type BookRow = Parameters<typeof mapBook>[0]

export function getBookById(id: string): Book | null {
  const row = db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`).get(id) as BookRow | undefined
  return row ? mapBook(row) : null
}

export function getBookByPath(projectId: string, filePath: string): Book | null {
  const row = db
    .prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE project_id = ? AND file_path = ?`)
    .get(projectId, filePath) as BookRow | undefined
  return row ? mapBook(row) : null
}

export function listBooks(projectId?: string): Book[] {
  const rows = (projectId
    ? db.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE project_id = ? ORDER BY title COLLATE NOCASE ASC`).all(projectId)
    : db.prepare(`SELECT ${BOOK_COLUMNS} FROM books ORDER BY title COLLATE NOCASE ASC`).all()) as BookRow[]
  return rows.map(mapBook)
}

export interface BookUpsert {
  projectId: string
  sourcePath: string
  filePath: string
  relativePath: string
  format: BookFormat
  identityHash: string
  textHash: string
  fileSize: number
  title: string
  subtitle: string | null
  authors: string[]
  publisher: string | null
  publishedDate: string | null
  language: string | null
  identifier: string | null
  subjects: string[]
  description: string | null
  coverDataUrl: string | null
  chapterCount: number
  wordCount: number
  status: BookScanStatus
  scanError: string | null
}

/** Upsert on (project_id, file_path): the same file re-scanned keeps its id, and
 *  therefore keeps its reading state, lessons and annotations. */
export function upsertBook(input: BookUpsert): Book {
  const now = Date.now()
  const existing = getBookByPath(input.projectId, input.filePath)
  const id = existing?.id ?? uuidv4()
  db.prepare(
    `INSERT INTO books (${BOOK_COLUMNS})
     VALUES (@id, @project_id, @source_path, @file_path, @relative_path, @format, @identity_hash,
             @text_hash, @file_size, @title, @subtitle, @authors_json, @publisher, @published_date,
             @language, @identifier, @subjects_json, @description, @cover_data_url, @chapter_count,
             @word_count, @status, @scan_error, NULL, @added_at, @updated_at)
     ON CONFLICT(project_id, file_path) DO UPDATE SET
       source_path = excluded.source_path,
       relative_path = excluded.relative_path,
       format = excluded.format,
       identity_hash = excluded.identity_hash,
       text_hash = excluded.text_hash,
       file_size = excluded.file_size,
       title = excluded.title,
       subtitle = excluded.subtitle,
       authors_json = excluded.authors_json,
       publisher = excluded.publisher,
       published_date = excluded.published_date,
       language = excluded.language,
       identifier = excluded.identifier,
       subjects_json = excluded.subjects_json,
       description = excluded.description,
       cover_data_url = excluded.cover_data_url,
       chapter_count = excluded.chapter_count,
       word_count = excluded.word_count,
       status = excluded.status,
       scan_error = excluded.scan_error,
       missing_since = NULL,
       updated_at = excluded.updated_at`
  ).run({
    id,
    project_id: input.projectId,
    source_path: input.sourcePath,
    file_path: input.filePath,
    relative_path: input.relativePath,
    format: input.format,
    identity_hash: input.identityHash,
    text_hash: input.textHash,
    file_size: input.fileSize,
    title: input.title,
    subtitle: input.subtitle,
    authors_json: JSON.stringify(input.authors),
    publisher: input.publisher,
    published_date: input.publishedDate,
    language: input.language,
    identifier: input.identifier,
    subjects_json: JSON.stringify(input.subjects),
    description: input.description,
    cover_data_url: input.coverDataUrl,
    chapter_count: input.chapterCount,
    word_count: input.wordCount,
    status: input.status,
    scan_error: input.scanError,
    added_at: existing?.addedAt ?? now,
    updated_at: now,
  })
  ensureReadingState(id)
  return getBookById(id)!
}

/** A file that vanished is marked, never deleted: an unplugged drive must not
 *  destroy a reading history. Pruning is a separate, gated decision. */
export function markBookMissing(id: string, missingSince: string): void {
  db.prepare('UPDATE books SET missing_since = ?, updated_at = ? WHERE id = ?').run(missingSince, Date.now(), id)
}

export function deleteBook(id: string): void {
  db.prepare('DELETE FROM books WHERE id = ?').run(id)
}

export function replaceBookChapters(bookId: string, chapters: Array<Omit<BookChapter, 'id' | 'bookId'>>): void {
  const now = Date.now()
  runInTransaction(() => {
    db.prepare('DELETE FROM book_chapters WHERE book_id = ?').run(bookId)
    const insert = db.prepare(
      `INSERT INTO book_chapters (id, book_id, spine_index, href, anchor, title, nav_depth,
         char_start, char_end, word_count, page_start, page_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const chapter of chapters) {
      insert.run(
        uuidv4(), bookId, chapter.spineIndex, chapter.href, chapter.anchor, chapter.title,
        chapter.navDepth, chapter.charStart, chapter.charEnd, chapter.wordCount,
        chapter.pageStart, chapter.pageEnd, now
      )
    }
  })
}

export function listBookChapters(bookId: string): BookChapter[] {
  const rows = db
    .prepare(
      `SELECT id, book_id, spine_index, href, anchor, title, nav_depth, char_start, char_end,
              word_count, page_start, page_end
       FROM book_chapters WHERE book_id = ? ORDER BY spine_index ASC`
    )
    .all(bookId) as Array<{
    id: string; book_id: string; spine_index: number; href: string; anchor: string | null
    title: string; nav_depth: number; char_start: number; char_end: number; word_count: number
    page_start: number | null; page_end: number | null
  }>
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    spineIndex: row.spine_index,
    href: row.href,
    anchor: row.anchor,
    title: row.title,
    navDepth: row.nav_depth,
    charStart: row.char_start,
    charEnd: row.char_end,
    wordCount: row.word_count,
    pageStart: row.page_start,
    pageEnd: row.page_end,
  }))
}

function mapReadingState(row: {
  book_id: string; status: string; last_chapter_index: number; last_char_offset: number
  furthest_char_offset: number; progress_percent: number; rating: number | null
  started_at: string | null; finished_at: string | null; seconds_read: number
  notes: string; updated_at: number
}): BookReadingState {
  const status = BOOK_READING_STATUSES.includes(row.status as BookReadingStatus)
    ? (row.status as BookReadingStatus)
    : 'unread'
  return {
    bookId: row.book_id,
    status,
    lastChapterIndex: row.last_chapter_index,
    lastCharOffset: row.last_char_offset,
    furthestCharOffset: row.furthest_char_offset,
    progressPercent: row.progress_percent,
    rating: row.rating,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    secondsRead: row.seconds_read,
    notes: row.notes,
    updatedAt: row.updated_at,
  }
}

const READING_STATE_COLUMNS = `book_id, status, last_chapter_index, last_char_offset,
  furthest_char_offset, progress_percent, rating, started_at, finished_at, seconds_read,
  notes, updated_at`

export function ensureReadingState(bookId: string): BookReadingState {
  db.prepare(
    `INSERT OR IGNORE INTO book_reading_state (book_id, updated_at) VALUES (?, ?)`
  ).run(bookId, Date.now())
  return getReadingState(bookId)!
}

export function getReadingState(bookId: string): BookReadingState | null {
  const row = db
    .prepare(`SELECT ${READING_STATE_COLUMNS} FROM book_reading_state WHERE book_id = ?`)
    .get(bookId) as Parameters<typeof mapReadingState>[0] | undefined
  return row ? mapReadingState(row) : null
}

export function listReadingStates(bookIds: string[]): Map<string, BookReadingState> {
  if (bookIds.length === 0) return new Map()
  const placeholders = bookIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT ${READING_STATE_COLUMNS} FROM book_reading_state WHERE book_id IN (${placeholders})`)
    .all(...bookIds) as Array<Parameters<typeof mapReadingState>[0]>
  return new Map(rows.map((row) => [row.book_id, mapReadingState(row)]))
}

export function updateReadingState(
  bookId: string,
  patch: Partial<Omit<BookReadingState, 'bookId' | 'updatedAt'>>
): BookReadingState {
  ensureReadingState(bookId)
  const columns: Record<keyof Omit<BookReadingState, 'bookId' | 'updatedAt'>, string> = {
    status: 'status',
    lastChapterIndex: 'last_chapter_index',
    lastCharOffset: 'last_char_offset',
    furthestCharOffset: 'furthest_char_offset',
    progressPercent: 'progress_percent',
    rating: 'rating',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    secondsRead: 'seconds_read',
    notes: 'notes',
  }
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key as keyof typeof columns]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE book_reading_state SET ${sets.join(', ')}, updated_at = ? WHERE book_id = ?`)
      .run(...values, Date.now(), bookId)
  }
  return getReadingState(bookId)!
}

export function recordReadingSession(input: Omit<BookReadingSession, 'id'>): void {
  db.prepare(
    `INSERT INTO book_reading_sessions (id, book_id, started_at, ended_at, chapter_start, chapter_end, chars_advanced, seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(), input.bookId, input.startedAt, input.endedAt,
    input.chapterStart, input.chapterEnd, input.charsAdvanced, input.seconds
  )
}

export function listReadingSessions(bookId?: string): BookReadingSession[] {
  const rows = (bookId
    ? db.prepare('SELECT * FROM book_reading_sessions WHERE book_id = ? ORDER BY started_at ASC').all(bookId)
    : db.prepare('SELECT * FROM book_reading_sessions ORDER BY started_at ASC').all()) as Array<{
    id: string; book_id: string; started_at: string; ended_at: string
    chapter_start: number; chapter_end: number; chars_advanced: number; seconds: number
  }>
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    chapterStart: row.chapter_start,
    chapterEnd: row.chapter_end,
    charsAdvanced: row.chars_advanced,
    seconds: row.seconds,
  }))
}

/** Cheap per-book artifact counts for the shelf — never the artifacts themselves. */
export function countBookArtifacts(bookIds: string[]): Map<string, { lessons: number; annotations: number }> {
  const counts = new Map<string, { lessons: number; annotations: number }>()
  if (bookIds.length === 0) return counts
  for (const id of bookIds) counts.set(id, { lessons: 0, annotations: 0 })
  const placeholders = bookIds.map(() => '?').join(',')
  const lessons = db
    .prepare(`SELECT book_id, COUNT(*) AS count FROM book_lessons WHERE book_id IN (${placeholders}) GROUP BY book_id`)
    .all(...bookIds) as Array<{ book_id: string; count: number }>
  for (const row of lessons) {
    const entry = counts.get(row.book_id)
    if (entry) entry.lessons = row.count
  }
  const annotations = db
    .prepare(`SELECT book_id, COUNT(*) AS count FROM book_annotations WHERE book_id IN (${placeholders}) GROUP BY book_id`)
    .all(...bookIds) as Array<{ book_id: string; count: number }>
  for (const row of annotations) {
    const entry = counts.get(row.book_id)
    if (entry) entry.annotations = row.count
  }
  return counts
}

// --- annotations -----------------------------------------------------------

function mapAnnotationRun(row: {
  id: string; book_id: string; focus_key: string; focus_label: string; custom_focus: string | null
  prompt_version: string; chapter_start: number; chapter_end: number; text_hash: string
  model: string; status: string; error: string | null; annotation_count: number
  dropped_count: number; cost_usd: number | null; input_tokens: number; output_tokens: number
  created_at: string; updated_at: string
}): BookAnnotationRun {
  return {
    id: row.id,
    bookId: row.book_id,
    focusKey: row.focus_key,
    focusLabel: row.focus_label,
    customFocus: row.custom_focus,
    promptVersion: row.prompt_version,
    chapterStart: row.chapter_start,
    chapterEnd: row.chapter_end,
    textHash: row.text_hash,
    model: row.model,
    status: row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : 'pending',
    error: row.error,
    annotationCount: row.annotation_count,
    droppedCount: row.dropped_count,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const ANNOTATION_RUN_COLUMNS = `id, book_id, focus_key, focus_label, custom_focus, prompt_version,
  chapter_start, chapter_end, text_hash, model, status, error, annotation_count, dropped_count,
  cost_usd, input_tokens, output_tokens, created_at, updated_at`

export function getAnnotationRun(
  bookId: string,
  chapterStart: number,
  chapterEnd: number,
  promptVersion: string
): BookAnnotationRun | null {
  const row = db
    .prepare(
      `SELECT ${ANNOTATION_RUN_COLUMNS} FROM book_annotation_runs
       WHERE book_id = ? AND chapter_start = ? AND chapter_end = ? AND prompt_version = ?`
    )
    .get(bookId, chapterStart, chapterEnd, promptVersion) as Parameters<typeof mapAnnotationRun>[0] | undefined
  return row ? mapAnnotationRun(row) : null
}

export function listAnnotationRuns(bookId: string): BookAnnotationRun[] {
  const rows = db
    .prepare(`SELECT ${ANNOTATION_RUN_COLUMNS} FROM book_annotation_runs WHERE book_id = ? ORDER BY created_at ASC`)
    .all(bookId) as Array<Parameters<typeof mapAnnotationRun>[0]>
  return rows.map(mapAnnotationRun)
}

export function upsertAnnotationRun(input: {
  bookId: string; focusKey: string; focusLabel: string; customFocus: string | null
  promptVersion: string; chapterStart: number; chapterEnd: number; textHash: string
  model: string; status: BookScanStatus; error: string | null
}): BookAnnotationRun {
  const now = new Date().toISOString()
  const existing = getAnnotationRun(input.bookId, input.chapterStart, input.chapterEnd, input.promptVersion)
  const id = existing?.id ?? uuidv4()
  db.prepare(
    `INSERT INTO book_annotation_runs (id, book_id, focus_key, focus_label, custom_focus, prompt_version,
       chapter_start, chapter_end, text_hash, model, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, chapter_start, chapter_end, prompt_version) DO UPDATE SET
       focus_label = excluded.focus_label,
       custom_focus = excluded.custom_focus,
       text_hash = excluded.text_hash,
       model = excluded.model,
       status = excluded.status,
       error = excluded.error,
       updated_at = excluded.updated_at`
  ).run(
    id, input.bookId, input.focusKey, input.focusLabel, input.customFocus, input.promptVersion,
    input.chapterStart, input.chapterEnd, input.textHash, input.model, input.status, input.error,
    existing?.createdAt ?? now, now
  )
  return getAnnotationRun(input.bookId, input.chapterStart, input.chapterEnd, input.promptVersion)!
}

export function updateAnnotationRun(
  runId: string,
  patch: Partial<Pick<BookAnnotationRun, 'status' | 'error' | 'annotationCount' | 'droppedCount' | 'costUsd' | 'inputTokens' | 'outputTokens'>>
): void {
  const columns: Record<string, string> = {
    status: 'status', error: 'error', annotationCount: 'annotation_count',
    droppedCount: 'dropped_count', costUsd: 'cost_usd',
    inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  }
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key as keyof typeof patch]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (sets.length === 0) return
  db.prepare(`UPDATE book_annotation_runs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), runId)
}

export function deleteAnnotationRun(runId: string): void {
  db.prepare('DELETE FROM book_annotation_runs WHERE id = ?').run(runId)
}

function mapAnnotation(row: {
  id: string; run_id: string | null; book_id: string; chapter_index: number
  char_start: number; char_end: number; quote: string; prefix: string; suffix: string
  kind: string; label: string; body: string; origin: string; pinned: number
  anchor_status: string; created_at: number; updated_at: number
}): BookAnnotation {
  return {
    id: row.id,
    runId: row.run_id,
    bookId: row.book_id,
    chapterIndex: row.chapter_index,
    charStart: row.char_start,
    charEnd: row.char_end,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    kind: row.kind,
    label: row.label,
    body: row.body,
    origin: row.origin === 'manual' ? 'manual' : 'ai',
    pinned: row.pinned === 1,
    anchorStatus:
      row.anchor_status === 'shifted' ? 'shifted' : row.anchor_status === 'orphaned' ? 'orphaned' : 'exact',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const ANNOTATION_COLUMNS = `id, run_id, book_id, chapter_index, char_start, char_end, quote,
  prefix, suffix, kind, label, body, origin, pinned, anchor_status, created_at, updated_at`

export function listBookAnnotations(bookId: string, chapterIndex?: number): BookAnnotation[] {
  const rows = (chapterIndex === undefined
    ? db.prepare(`SELECT ${ANNOTATION_COLUMNS} FROM book_annotations WHERE book_id = ? ORDER BY char_start ASC`).all(bookId)
    : db
        .prepare(`SELECT ${ANNOTATION_COLUMNS} FROM book_annotations WHERE book_id = ? AND chapter_index = ? ORDER BY char_start ASC`)
        .all(bookId, chapterIndex)) as Array<Parameters<typeof mapAnnotation>[0]>
  return rows.map(mapAnnotation)
}

export function insertBookAnnotation(input: Omit<BookAnnotation, 'id' | 'createdAt' | 'updatedAt'>): BookAnnotation {
  const id = uuidv4()
  const now = Date.now()
  db.prepare(
    `INSERT INTO book_annotations (${ANNOTATION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.runId, input.bookId, input.chapterIndex, input.charStart, input.charEnd,
    input.quote, input.prefix, input.suffix, input.kind, input.label, input.body,
    input.origin, input.pinned ? 1 : 0, input.anchorStatus, now, now
  )
  return { ...input, id, createdAt: now, updatedAt: now }
}

/** Replaces one run's annotations. Manual highlights have no run and survive. */
export function replaceRunAnnotations(
  runId: string,
  annotations: Array<Omit<BookAnnotation, 'id' | 'createdAt' | 'updatedAt'>>
): void {
  runInTransaction(() => {
    db.prepare('DELETE FROM book_annotations WHERE run_id = ?').run(runId)
    for (const annotation of annotations) insertBookAnnotation(annotation)
  })
}

export function updateBookAnnotationAnchor(
  id: string,
  charStart: number,
  charEnd: number,
  anchorStatus: AnnotationAnchorStatus,
  chapterIndex: number
): void {
  db.prepare(
    'UPDATE book_annotations SET char_start = ?, char_end = ?, anchor_status = ?, chapter_index = ?, updated_at = ? WHERE id = ?'
  ).run(charStart, charEnd, anchorStatus, chapterIndex, Date.now(), id)
}

export function setBookAnnotationPinned(id: string, pinned: boolean): void {
  db.prepare('UPDATE book_annotations SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id)
}

export function deleteBookAnnotation(id: string): void {
  db.prepare('DELETE FROM book_annotations WHERE id = ?').run(id)
}

// --- lessons ---------------------------------------------------------------

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function mapLesson(row: {
  id: string; book_id: string; chapter_start: number; chapter_end: number; title: string
  overview: string; objectives_json: string; concepts_json: string; questions_json: string
  steps_json: string; prompt_version: string; model: string; status: string; error: string | null
  cost_usd: number | null; input_tokens: number; output_tokens: number; generated_at: string
}): BookLesson {
  return {
    id: row.id,
    bookId: row.book_id,
    chapterStart: row.chapter_start,
    chapterEnd: row.chapter_end,
    title: row.title,
    overview: row.overview,
    objectives: parseJsonArray<string>(row.objectives_json),
    concepts: parseJsonArray<BookLessonConcept>(row.concepts_json),
    questions: parseJsonArray<BookLessonQuestion>(row.questions_json),
    steps: parseJsonArray<BookLessonStep>(row.steps_json),
    promptVersion: row.prompt_version,
    model: row.model,
    status: row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : 'pending',
    error: row.error,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    generatedAt: row.generated_at,
  }
}

const LESSON_COLUMNS = `id, book_id, chapter_start, chapter_end, title, overview, objectives_json,
  concepts_json, questions_json, steps_json, prompt_version, model, status, error, cost_usd,
  input_tokens, output_tokens, generated_at`

export function getBookLesson(bookId: string, chapterStart: number, chapterEnd: number): BookLesson | null {
  const row = db
    .prepare(`SELECT ${LESSON_COLUMNS} FROM book_lessons WHERE book_id = ? AND chapter_start = ? AND chapter_end = ?`)
    .get(bookId, chapterStart, chapterEnd) as Parameters<typeof mapLesson>[0] | undefined
  return row ? mapLesson(row) : null
}

export function getBookLessonById(id: string): BookLesson | null {
  const row = db.prepare(`SELECT ${LESSON_COLUMNS} FROM book_lessons WHERE id = ?`).get(id) as
    | Parameters<typeof mapLesson>[0]
    | undefined
  return row ? mapLesson(row) : null
}

/** The cache gate, read separately so the lesson type carries no internal hash. */
export function getBookLessonInputHash(id: string): string | null {
  const row = db.prepare('SELECT input_hash FROM book_lessons WHERE id = ?').get(id) as
    | { input_hash: string }
    | undefined
  return row?.input_hash ?? null
}

export function listBookLessons(bookId: string): BookLesson[] {
  const rows = db
    .prepare(`SELECT ${LESSON_COLUMNS} FROM book_lessons WHERE book_id = ? ORDER BY chapter_start ASC`)
    .all(bookId) as Array<Parameters<typeof mapLesson>[0]>
  return rows.map(mapLesson)
}

export function upsertBookLesson(input: {
  bookId: string; chapterStart: number; chapterEnd: number; title: string; overview: string
  objectives: string[]; concepts: BookLessonConcept[]; questions: BookLessonQuestion[]
  steps: BookLessonStep[]; promptVersion: string; inputHash: string; textHash: string
  model: string; status: BookScanStatus; error: string | null; costUsd: number | null
  inputTokens: number; outputTokens: number
}): BookLesson {
  const now = new Date().toISOString()
  const existing = getBookLesson(input.bookId, input.chapterStart, input.chapterEnd)
  const id = existing?.id ?? uuidv4()
  db.prepare(
    `INSERT INTO book_lessons (id, book_id, chapter_start, chapter_end, title, overview, objectives_json,
       concepts_json, questions_json, steps_json, prompt_version, input_hash, text_hash, model, status,
       error, cost_usd, input_tokens, output_tokens, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, chapter_start, chapter_end) DO UPDATE SET
       title = excluded.title, overview = excluded.overview, objectives_json = excluded.objectives_json,
       concepts_json = excluded.concepts_json, questions_json = excluded.questions_json,
       steps_json = excluded.steps_json, prompt_version = excluded.prompt_version,
       input_hash = excluded.input_hash, text_hash = excluded.text_hash, model = excluded.model,
       status = excluded.status, error = excluded.error, cost_usd = excluded.cost_usd,
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       generated_at = excluded.generated_at`
  ).run(
    id, input.bookId, input.chapterStart, input.chapterEnd, input.title, input.overview,
    JSON.stringify(input.objectives), JSON.stringify(input.concepts), JSON.stringify(input.questions),
    JSON.stringify(input.steps), input.promptVersion, input.inputHash, input.textHash, input.model,
    input.status, input.error, input.costUsd, input.inputTokens, input.outputTokens, now
  )
  return getBookLesson(input.bookId, input.chapterStart, input.chapterEnd)!
}

export function deleteBookLesson(id: string): void {
  db.prepare('DELETE FROM book_lessons WHERE id = ?').run(id)
}

/** Every attempt is kept: answering the same question three times is the record. */
export function recordLessonAttempt(input: Omit<BookLessonAttempt, 'id' | 'createdAt'>): BookLessonAttempt {
  const id = uuidv4()
  const now = Date.now()
  db.prepare(
    `INSERT INTO book_lesson_attempts (id, lesson_id, question_id, answer, choice_index, correct, self_rating, revealed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.lessonId, input.questionId, input.answer, input.choiceIndex,
    input.correct === null ? null : input.correct ? 1 : 0,
    input.selfRating, input.revealed ? 1 : 0, now
  )
  return { ...input, id, createdAt: now }
}

export function listLessonAttempts(lessonId: string): BookLessonAttempt[] {
  const rows = db
    .prepare('SELECT * FROM book_lesson_attempts WHERE lesson_id = ? ORDER BY created_at ASC')
    .all(lessonId) as Array<{
    id: string; lesson_id: string; question_id: string; answer: string; choice_index: number | null
    correct: number | null; self_rating: number | null; revealed: number; created_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    lessonId: row.lesson_id,
    questionId: row.question_id,
    answer: row.answer,
    choiceIndex: row.choice_index,
    correct: row.correct === null ? null : row.correct === 1,
    selfRating: row.self_rating,
    revealed: row.revealed === 1,
    createdAt: row.created_at,
  }))
}

// --- book conversations ----------------------------------------------------
// Discussions are filed in General, never under the Books project — see the
// table comment. This is how the Library still finds them.

export function linkBookConversation(input: {
  bookId: string; conversationId: string; chapterIndex: number | null
  lessonId: string | null; stepId: string | null
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO book_conversations (id, book_id, conversation_id, chapter_index, lesson_id, step_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), input.bookId, input.conversationId, input.chapterIndex, input.lessonId, input.stepId, Date.now())
  // A book discussion carries chapter text in its system prompt, so it is kept
  // out of the global idle memory extractor — see listIdleConversations.
  db.prepare('UPDATE conversations SET book_discussion = 1 WHERE id = ?').run(input.conversationId)
}

export function listBookConversations(bookId: string): BookConversationLink[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.book_id, c.conversation_id, c.chapter_index, c.lesson_id, c.step_id, c.created_at
       FROM book_conversations c
       JOIN conversations conv ON conv.id = c.conversation_id
       WHERE c.book_id = ? ORDER BY c.created_at DESC`
    )
    .all(bookId) as Array<{
    id: string; book_id: string; conversation_id: string; chapter_index: number | null
    lesson_id: string | null; step_id: string | null; created_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    bookId: row.book_id,
    conversationId: row.conversation_id,
    chapterIndex: row.chapter_index,
    lessonId: row.lesson_id,
    stepId: row.step_id,
    createdAt: row.created_at,
  }))
}

// Provider call history ------------------------------------------------------

/**
 * How many calls are kept. A single photo index run makes thousands, so this is
 * a rolling window rather than a permanent ledger: the page is for seeing what
 * the app has been sending and what it cost, not for accounting since install.
 */
export const MAX_PROVIDER_CALL_ROWS = 2000

export interface ProviderCallInsert {
  createdAt: number
  feature: string | null
  provider: CalledService
  endpoint: string
  url: string
  model: string | null
  streamed: boolean
  status: number | null
  ok: boolean
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  charCount: number | null
  costUsd: number | null
  costSource: ProviderCallCostSource | null
  request: string
  requestTruncated: boolean
  response: string
  responseTruncated: boolean
  error: string | null
}

interface ProviderCallRow {
  id: string
  created_at: number
  feature: string | null
  provider: string
  endpoint: string
  url: string
  model: string | null
  streamed: number
  status: number | null
  ok: number
  duration_ms: number
  input_tokens: number | null
  output_tokens: number | null
  char_count: number | null
  cost_usd: number | null
  cost_source: string | null
  request: string
  request_truncated: number
  response: string
  response_truncated: number
  error: string | null
}

function mapProviderCallSummary(row: Omit<ProviderCallRow, 'request' | 'response'> & {
  request_chars: number
  response_chars: number
}): ProviderCallSummary {
  return {
    id: row.id,
    createdAt: row.created_at,
    feature: row.feature,
    provider: row.provider as CalledService,
    endpoint: row.endpoint,
    model: row.model,
    streamed: row.streamed === 1,
    status: row.status,
    ok: row.ok === 1,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    charCount: row.char_count,
    costUsd: row.cost_usd,
    costSource: (row.cost_source as ProviderCallCostSource | null) ?? null,
    requestChars: row.request_chars,
    responseChars: row.response_chars,
    error: row.error,
  }
}

export function insertProviderCall(input: ProviderCallInsert): string {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO provider_calls
     (id, created_at, feature, provider, endpoint, url, model, streamed, status, ok, duration_ms,
      input_tokens, output_tokens, char_count, cost_usd, cost_source, request, request_truncated,
      response, response_truncated, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.createdAt,
    input.feature,
    input.provider,
    input.endpoint,
    input.url,
    input.model,
    input.streamed ? 1 : 0,
    input.status,
    input.ok ? 1 : 0,
    Math.round(input.durationMs),
    input.inputTokens,
    input.outputTokens,
    input.charCount,
    input.costUsd,
    input.costSource,
    input.request,
    input.requestTruncated ? 1 : 0,
    input.response,
    input.responseTruncated ? 1 : 0,
    input.error
  )
  return id
}

// Keeps the window at MAX_PROVIDER_CALL_ROWS. Called after inserts rather than
// on a timer so the table cannot grow unbounded between app launches.
export function pruneProviderCalls(): number {
  const result = db
    .prepare(
      `DELETE FROM provider_calls WHERE id IN (
         SELECT id FROM provider_calls ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
       )`
    )
    .run(MAX_PROVIDER_CALL_ROWS)
  return result.changes
}

function providerCallWhere(filter?: ProviderCallFilter): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter?.completionsOnly) {
    clauses.push("endpoint LIKE '%completions%' OR endpoint LIKE '%generations%' OR endpoint LIKE '%responses%'")
  }
  if (filter?.failedOnly) clauses.push('ok = 0')
  const search = filter?.search?.trim()
  if (search) {
    clauses.push(
      '(model LIKE ? OR feature LIKE ? OR endpoint LIKE ? OR request LIKE ? OR response LIKE ? OR error LIKE ?)'
    )
    const needle = `%${search.replace(/[%_]/g, (char) => `\\${char}`)}%`
    params.push(needle, needle, needle, needle, needle, needle)
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.map((clause) => `(${clause})`).join(' AND ')}` : ''
  return { where, params }
}

export function listProviderCalls(filter?: ProviderCallFilter): ProviderCallSummary[] {
  const { where, params } = providerCallWhere(filter)
  const limit = filter?.limit && filter.limit > 0 ? Math.floor(filter.limit) : 100
  const offset = filter?.offset && filter.offset > 0 ? Math.floor(filter.offset) : 0
  const rows = db
    .prepare(
      `SELECT id, created_at, feature, provider, endpoint, url, model, streamed, status, ok, duration_ms,
              input_tokens, output_tokens, char_count, cost_usd, cost_source,
              LENGTH(request) AS request_chars, request_truncated,
              LENGTH(response) AS response_chars, response_truncated, error
       FROM provider_calls${where}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Array<
    Omit<ProviderCallRow, 'request' | 'response'> & { request_chars: number; response_chars: number }
  >
  return rows.map(mapProviderCallSummary)
}

export function getProviderCall(id: string): ProviderCall | null {
  const row = db.prepare('SELECT * FROM provider_calls WHERE id = ?').get(id) as ProviderCallRow | undefined
  if (!row) return null
  return {
    ...mapProviderCallSummary({
      ...row,
      request_chars: row.request.length,
      response_chars: row.response.length,
    }),
    url: row.url,
    request: row.request,
    requestTruncated: row.request_truncated === 1,
    response: row.response,
    responseTruncated: row.response_truncated === 1,
  }
}

export function getProviderCallStats(filter?: ProviderCallFilter): ProviderCallStats {
  const { where, params } = providerCallWhere(filter)
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced_calls,
              SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed_calls,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              MIN(created_at) AS first_call_at,
              MAX(created_at) AS last_call_at
       FROM provider_calls${where}`
    )
    .get(...params) as {
    calls: number
    priced_calls: number | null
    failed_calls: number | null
    cost_usd: number
    input_tokens: number
    output_tokens: number
    first_call_at: number | null
    last_call_at: number | null
  }
  return {
    calls: row.calls,
    pricedCalls: row.priced_calls ?? 0,
    failedCalls: row.failed_calls ?? 0,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    firstCallAt: row.first_call_at,
    lastCallAt: row.last_call_at,
  }
}

/**
 * Rows logged while the model list was still cold carry no cost. The Call
 * History page fills them in from the live price table when it loads, so a
 * price that arrives late still lands on the calls it belongs to.
 */
export function setProviderCallCost(id: string, costUsd: number, costSource: ProviderCallCostSource): void {
  db.prepare('UPDATE provider_calls SET cost_usd = ?, cost_source = ? WHERE id = ? AND cost_usd IS NULL')
    .run(costUsd, costSource, id)
}

export function listUnpricedProviderCalls(limit = 500): Array<{
  id: string
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
}> {
  const rows = db
    .prepare(
      `SELECT id, model, input_tokens, output_tokens FROM provider_calls
       WHERE cost_usd IS NULL AND model IS NOT NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(Math.floor(limit)) as Array<{ id: string; model: string | null; input_tokens: number | null; output_tokens: number | null }>
  return rows.map((row) => ({
    id: row.id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  }))
}

export function clearProviderCalls(): void {
  db.prepare('DELETE FROM provider_calls').run()
}

// --- audiobooks ------------------------------------------------------------

function mapAudiobook(row: {
  id: string; book_id: string; chapter_index: number; provider: string; voice_id: string; voice_name: string
  model_id: string; text_hash: string; char_start: number; char_end: number
  character_count: number; duration_seconds: number; status: string; error: string | null
  created_at: number; updated_at: number
}): Audiobook {
  const status = row.status === 'ready' ? 'ready'
    : row.status === 'failed' ? 'failed'
    : row.status === 'generating' ? 'generating' : 'pending'
  return {
    id: row.id,
    bookId: row.book_id,
    chapterIndex: row.chapter_index,
    provider: row.provider === 'speechify' ? 'speechify' : 'elevenlabs',
    voiceId: row.voice_id,
    voiceName: row.voice_name,
    modelId: row.model_id,
    textHash: row.text_hash,
    charStart: row.char_start,
    charEnd: row.char_end,
    characterCount: row.character_count,
    durationSeconds: row.duration_seconds,
    status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const AUDIOBOOK_COLUMNS = `id, book_id, chapter_index, provider, voice_id, voice_name, model_id, text_hash,
  char_start, char_end, character_count, duration_seconds, status, error, created_at, updated_at`

export function getAudiobook(bookId: string, chapterIndex: number): Audiobook | null {
  const row = db
    .prepare(`SELECT ${AUDIOBOOK_COLUMNS} FROM audiobook_chapters WHERE book_id = ? AND chapter_index = ?`)
    .get(bookId, chapterIndex) as Parameters<typeof mapAudiobook>[0] | undefined
  return row ? mapAudiobook(row) : null
}

export function listAudiobooks(bookId: string): Audiobook[] {
  const rows = db
    .prepare(`SELECT ${AUDIOBOOK_COLUMNS} FROM audiobook_chapters WHERE book_id = ? ORDER BY chapter_index ASC`)
    .all(bookId) as Array<Parameters<typeof mapAudiobook>[0]>
  return rows.map(mapAudiobook)
}

export function upsertAudiobook(input: {
  bookId: string; chapterIndex: number; provider: SpeechProviderId; voiceId: string; voiceName: string; modelId: string
  textHash: string; charStart: number; charEnd: number; characterCount: number
  durationSeconds: number; status: AudiobookStatus; error: string | null
}): Audiobook {
  const now = Date.now()
  const existing = getAudiobook(input.bookId, input.chapterIndex)
  const id = existing?.id ?? uuidv4()
  db.prepare(
    `INSERT INTO audiobook_chapters (${AUDIOBOOK_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(book_id, chapter_index) DO UPDATE SET
       provider = excluded.provider,
       voice_id = excluded.voice_id, voice_name = excluded.voice_name,
       model_id = excluded.model_id, text_hash = excluded.text_hash,
       char_start = excluded.char_start, char_end = excluded.char_end,
       character_count = excluded.character_count, duration_seconds = excluded.duration_seconds,
       status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`
  ).run(
    id, input.bookId, input.chapterIndex, input.provider, input.voiceId, input.voiceName, input.modelId,
    input.textHash, input.charStart, input.charEnd, input.characterCount, input.durationSeconds,
    input.status, input.error, existing?.createdAt ?? now, now
  )
  return getAudiobook(input.bookId, input.chapterIndex)!
}

export function deleteAudiobook(id: string): void {
  db.prepare('DELETE FROM audiobook_chapters WHERE id = ?').run(id)
}

export interface AudiobookSegmentRow {
  id: string
  audiobookId: string
  bookId: string
  segmentIndex: number
  filePath: string
  mimeType: string
  byteSize: number
  charStart: number
  charEnd: number
  durationSeconds: number
  offsetSeconds: number
  requestId: string | null
  words: AudiobookWordTimings
}

function mapSegment(row: {
  id: string; audiobook_id: string; book_id: string; segment_index: number; file_path: string
  mime_type: string; byte_size: number; char_start: number; char_end: number; duration_seconds: number
  offset_seconds: number; request_id: string | null; words_json: string
}): AudiobookSegmentRow {
  let words: AudiobookWordTimings = { charStart: [], charEnd: [], startSeconds: [], endSeconds: [] }
  try {
    const parsed = JSON.parse(row.words_json) as Partial<AudiobookWordTimings>
    if (Array.isArray(parsed.charStart)) {
      words = {
        charStart: parsed.charStart,
        charEnd: parsed.charEnd ?? [],
        startSeconds: parsed.startSeconds ?? [],
        endSeconds: parsed.endSeconds ?? [],
      }
    }
  } catch {
    // Unreadable timings mean playback without highlighting, not a broken book.
  }
  return {
    id: row.id,
    audiobookId: row.audiobook_id,
    bookId: row.book_id,
    segmentIndex: row.segment_index,
    filePath: row.file_path,
    mimeType: row.mime_type || 'audio/mpeg',
    byteSize: row.byte_size,
    charStart: row.char_start,
    charEnd: row.char_end,
    durationSeconds: row.duration_seconds,
    offsetSeconds: row.offset_seconds,
    requestId: row.request_id,
    words,
  }
}

const SEGMENT_COLUMNS = `id, audiobook_id, book_id, segment_index, file_path, mime_type, byte_size,
  char_start, char_end, duration_seconds, offset_seconds, request_id, words_json`

/** The protocol handler's only lookup: an opaque id in, a file path out. */
export function getAudiobookSegmentById(id: string): AudiobookSegmentRow | null {
  const row = db.prepare(`SELECT ${SEGMENT_COLUMNS} FROM audiobook_segments WHERE id = ?`).get(id) as
    | Parameters<typeof mapSegment>[0]
    | undefined
  return row ? mapSegment(row) : null
}

export function listAudiobookSegments(audiobookId: string): AudiobookSegmentRow[] {
  const rows = db
    .prepare(`SELECT ${SEGMENT_COLUMNS} FROM audiobook_segments WHERE audiobook_id = ? ORDER BY segment_index ASC`)
    .all(audiobookId) as Array<Parameters<typeof mapSegment>[0]>
  return rows.map(mapSegment)
}

export function insertAudiobookSegment(input: Omit<AudiobookSegmentRow, 'id'>): AudiobookSegmentRow {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO audiobook_segments (${SEGMENT_COLUMNS}, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.audiobookId, input.bookId, input.segmentIndex, input.filePath, input.mimeType, input.byteSize,
    input.charStart, input.charEnd, input.durationSeconds, input.offsetSeconds, input.requestId,
    JSON.stringify(input.words), Date.now()
  )
  return { ...input, id }
}

export function deleteAudiobookSegments(audiobookId: string): void {
  db.prepare('DELETE FROM audiobook_segments WHERE audiobook_id = ?').run(audiobookId)
}

/**
 * Re-points a shelf entry after its file was moved on disk.
 *
 * The identity hash is stat-based and includes the path, so it must be
 * recomputed by the caller and written here — otherwise the next scan sees a
 * changed identity and re-parses a book whose contents did not change.
 */
export function updateBookLocation(
  id: string,
  input: { filePath: string; relativePath: string; identityHash: string }
): void {
  db.prepare(
    'UPDATE books SET file_path = ?, relative_path = ?, identity_hash = ?, updated_at = ? WHERE id = ?'
  ).run(input.filePath, input.relativePath, input.identityHash, Date.now(), id)
}

function mapRemoteDevice(row: {
  id: string
  name: string
  platform: string
  public_key: string
  created_at: number
  last_seen_at: number | null
}): RemoteDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    publicKey: row.public_key,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  }
}

export function listRemoteDevices(): RemoteDevice[] {
  const rows = db
    .prepare('SELECT * FROM remote_devices ORDER BY created_at ASC')
    .all() as Array<Parameters<typeof mapRemoteDevice>[0]>
  return rows.map(mapRemoteDevice)
}

export function getRemoteDeviceById(id: string): RemoteDevice | null {
  const row = db.prepare('SELECT * FROM remote_devices WHERE id = ?').get(id) as
    | Parameters<typeof mapRemoteDevice>[0]
    | undefined
  return row ? mapRemoteDevice(row) : null
}

export function createRemoteDevice(input: { name: string; platform: string; publicKey: string }): RemoteDevice {
  const id = uuidv4()
  const now = Date.now()
  db.prepare(
    'INSERT INTO remote_devices (id, name, platform, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)'
  ).run(id, input.name, input.platform, input.publicKey, now)
  return { id, name: input.name, platform: input.platform, publicKey: input.publicKey, createdAt: now, lastSeenAt: null }
}

export function touchRemoteDevice(id: string): void {
  db.prepare('UPDATE remote_devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id)
}

export function renameRemoteDevice(id: string, name: string): void {
  db.prepare('UPDATE remote_devices SET name = ? WHERE id = ?').run(name, id)
}

export function deleteRemoteDevice(id: string): void {
  db.prepare('DELETE FROM remote_devices WHERE id = ?').run(id)
}
