import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipcChannels'
import type { ChatAttachment, ElectronAPI, StreamChunk, AppSettings, ProviderConfig, Conversation, Message, ModelInfo, SearchResult, ReasoningEffort, Project, PsychologyAnalysis, HealthAnalysis, HealthRecord, HealthObservation, HealthSummary, HealthIngestProgress, HealthLiveStatus, HealthLiveSyncProgress, HealthSyncResult, DirectoryScanResult, PsychologicalTestId, PsychologicalTestResult, ProductSearchRequest, ProductSearchResult, WebSearchRequest, WebSearchResult, RecallSearchRequest, RecallSearchResponse, RecallHistoryEntry, MemoryField, MemoryValue, MemoryUpdateRequest, MemoryCreateFieldRequest, MemorySuggestion, MemoryExtractionRequest, MemoryExtractionResult, MemorySuggestionReviewRequest, ClaudeImportOptions, ClaudeImportResult, ClaudeImportProgress, MemoryMode, ContextSelection, FsReadResult, FsWriteRequest, FsWriteResult, FsListItem, SystemPromptEntry, ActivityRecord, ActivitySourceType, ActivityIngestProgress, ActivityEventsBySource, ActivitySummary, ActivityLiveStatus, ActivitySyncResult, ActivityAccount, ActivityAccountUpdate, ActivityAccountSyncResult, ActivityAnalysisEstimate, ActivityRunState, DocumentContextResult, DocumentContextTree, DocumentContextProgress, DocumentIndexAllResult, DocumentIndexState, ProvenanceChain, SourceExcerpt, UserSuperContext, ModelTier, IndexGranularity, IndexEstimate, ProjectSource, ProjectInput, ProjectIndexSummary, TimelineEvent, TimelineEventInput, TimelineFilter, TimelineSummary, TimelineYearContext, TimelineYearsView, TimelineRunState, TimelineRebuildResult, TimelineRebuildProgress, ContextVersion, ContextVersionSummary, ContextVersionFilter, RoleSummary, RoleSessionNote, RoleSessionNoteFilter, RoleSessionNoteResult, CreditBreakerState, HomeIdeasResult, ProviderCall, ProviderCallFilter, ProviderCallStats, ProviderCallSummary, Person, PersonMention, PersonRelation, PeopleFilter, PeopleRebuildProgress, PeopleRebuildResult, PeopleRunState, Book, BookChapter, BookChapterContent, BookReadingSession, BookReadingState, BookReadingStatus, BookResource, LibraryBook, LibraryRunState, LibraryScanProgress, LibraryScanResult, LibrarySnapshotResult, BookAnnotation, BookAnnotationRun, AnnotationRunSummary, BookLesson, BookLessonAttempt, BookConversationLink, BookDiscussionScope, LessonRunSummary, Audiobook, AudiobookChapter, AudiobookEstimate, AudiobookProgress, SpeechProviderId, SpeechProviderInfo, SpeechModel, SpeechVoice, SpeechKeyResult, OrganizePlan, OrganizeResult } from '../shared/types'
import type { RemoteDevice, RemotePairingOffer, RemoteScope, RemoteServerStatus } from '../shared/remote'
import type { RemoteMediaKind, RemoteMediaTicket } from '../shared/remoteMedia'

const api: ElectronAPI = {
  conversations: {
    list: () => ipcRenderer.invoke(IPC.CONVERSATIONS.LIST) as Promise<Conversation[]>,
    create: (model?: string, effort?: ReasoningEffort, projectId?: string, memoryMode?: MemoryMode, context?: ContextSelection, roleId?: string | null) => ipcRenderer.invoke(IPC.CONVERSATIONS.CREATE, model, effort, projectId, memoryMode, context, roleId) as Promise<Conversation>,
    delete: (id: string) => ipcRenderer.invoke(IPC.CONVERSATIONS.DELETE, id) as Promise<void>,
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.CONVERSATIONS.RENAME, id, title) as Promise<void>,
    updateModel: (id: string, model: string) => ipcRenderer.invoke(IPC.CONVERSATIONS.UPDATE_MODEL, id, model) as Promise<void>,
    updateEffort: (id: string, effort: ReasoningEffort) => ipcRenderer.invoke(IPC.CONVERSATIONS.UPDATE_EFFORT, id, effort) as Promise<void>,
    updateMemoryMode: (id: string, mode: MemoryMode) => ipcRenderer.invoke(IPC.CONVERSATIONS.UPDATE_MEMORY_MODE, id, mode) as Promise<void>,
    updateContext: (id: string, context: ContextSelection) => ipcRenderer.invoke(IPC.CONVERSATIONS.UPDATE_CONTEXT, id, context) as Promise<void>,
    updateRole: (id: string, roleId: string | null) => ipcRenderer.invoke(IPC.CONVERSATIONS.UPDATE_ROLE, id, roleId) as Promise<void>,
    updateSystemPrompt: (id: string, prompt: string) => ipcRenderer.invoke(IPC.CONVERSATIONS.UPDATE_SYSTEM_PROMPT, id, prompt) as Promise<void>,
    getMessages: (id: string) => ipcRenderer.invoke(IPC.CONVERSATIONS.GET_MESSAGES, id) as Promise<Message[]>,
    search: (query: string) => ipcRenderer.invoke(IPC.CONVERSATIONS.SEARCH, query) as Promise<SearchResult[]>,
    onUpdated: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC.CONVERSATIONS.UPDATED, handler)
      return () => ipcRenderer.removeListener(IPC.CONVERSATIONS.UPDATED, handler)
    },
  },
  chat: {
    send: (conversationId: string, message: string, model: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection, attachments?: ChatAttachment[]) =>
      ipcRenderer.invoke(IPC.CHAT.SEND, conversationId, message, model, effort, memoryMode, context, attachments) as Promise<void>,
    editMessage: (messageId: string, newContent: string, model: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection) =>
      ipcRenderer.invoke(IPC.CHAT.EDIT_MESSAGE, messageId, newContent, model, effort, memoryMode, context) as Promise<void>,
    retryMessage: (messageId: string, model: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection) =>
      ipcRenderer.invoke(IPC.CHAT.RETRY_MESSAGE, messageId, model, effort, memoryMode, context) as Promise<void>,
    setActiveBranch: (messageId: string) =>
      ipcRenderer.invoke(IPC.CHAT.SET_ACTIVE_BRANCH, messageId) as Promise<void>,
    abort: () => ipcRenderer.invoke(IPC.CHAT.ABORT),
    previewSystemPrompt: (conversationId: string, memoryMode: MemoryMode, context?: ContextSelection, roleId?: string | null) =>
      ipcRenderer.invoke(IPC.CHAT.PREVIEW_SYSTEM_PROMPT, conversationId, memoryMode, context, roleId) as Promise<SystemPromptEntry[]>,
    onChunk: (callback: (chunk: StreamChunk) => void) => {
      const handleChunk = (_event: Electron.IpcRendererEvent, chunk: StreamChunk) => callback(chunk)
      const handleDone = (_event: Electron.IpcRendererEvent, chunk: StreamChunk) => callback(chunk)

      ipcRenderer.on(IPC.CHAT.STREAM_CHUNK, handleChunk)
      ipcRenderer.on(IPC.CHAT.STREAM_DONE, handleDone)

      return () => {
        ipcRenderer.removeListener(IPC.CHAT.STREAM_CHUNK, handleChunk)
        ipcRenderer.removeListener(IPC.CHAT.STREAM_DONE, handleDone)
      }
    },
    onSystemPrompt: (callback: (messages: SystemPromptEntry[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, messages: SystemPromptEntry[]) => callback(messages)
      ipcRenderer.on(IPC.CHAT.SYSTEM_PROMPT, handler)
      return () => ipcRenderer.removeListener(IPC.CHAT.SYSTEM_PROMPT, handler)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS.GET) as Promise<AppSettings>,
    set: (partial: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS.SET, partial) as Promise<void>,
    getProvider: () => ipcRenderer.invoke(IPC.SETTINGS.GET_PROVIDER) as Promise<ProviderConfig>,
    setProvider: (config: ProviderConfig) => ipcRenderer.invoke(IPC.SETTINGS.SET_PROVIDER, config) as Promise<void>,
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.MODELS.LIST) as Promise<ModelInfo[]>,
  },
  productSearch: {
    search: (request: ProductSearchRequest) => ipcRenderer.invoke(IPC.PRODUCT_SEARCH.SEARCH, request) as Promise<ProductSearchResult>,
    abort: () => ipcRenderer.invoke(IPC.PRODUCT_SEARCH.ABORT) as Promise<void>,
  },
  websearch: {
    search: (request: WebSearchRequest) => ipcRenderer.invoke(IPC.WEBSEARCH.SEARCH, request) as Promise<WebSearchResult>,
    abort: () => ipcRenderer.invoke(IPC.WEBSEARCH.ABORT) as Promise<void>,
  },
  recall: {
    search: (request: RecallSearchRequest) => ipcRenderer.invoke(IPC.RECALL.SEARCH, request) as Promise<RecallSearchResponse>,
    abort: () => ipcRenderer.invoke(IPC.RECALL.ABORT) as Promise<void>,
    clear: () => ipcRenderer.invoke(IPC.RECALL.CLEAR) as Promise<void>,
    startConversation: (model: string, effort: ReasoningEffort) => ipcRenderer.invoke(IPC.RECALL.START_CONVERSATION, model, effort) as Promise<Conversation>,
    openFile: (path: string) => ipcRenderer.invoke(IPC.RECALL.OPEN_FILE, path) as Promise<void>,
    revealFile: (path: string) => ipcRenderer.invoke(IPC.RECALL.REVEAL_FILE, path) as Promise<void>,
    history: () => ipcRenderer.invoke(IPC.RECALL.HISTORY) as Promise<RecallHistoryEntry[]>,
    deleteHistory: (id: string) => ipcRenderer.invoke(IPC.RECALL.DELETE_HISTORY, id) as Promise<RecallHistoryEntry[]>,
    clearHistory: () => ipcRenderer.invoke(IPC.RECALL.CLEAR_HISTORY) as Promise<number>,
  },
  memory: {
    list: () => ipcRenderer.invoke(IPC.MEMORY.LIST) as Promise<MemoryField[]>,
    get: (category: string, fieldKey: string) => ipcRenderer.invoke(IPC.MEMORY.GET, category, fieldKey) as Promise<MemoryValue | null>,
    update: (request: MemoryUpdateRequest) => ipcRenderer.invoke(IPC.MEMORY.UPDATE, request) as Promise<MemoryField[]>,
    createField: (request: MemoryCreateFieldRequest) => ipcRenderer.invoke(IPC.MEMORY.CREATE_FIELD, request) as Promise<MemoryField[]>,
    deleteField: (fieldId: string) => ipcRenderer.invoke(IPC.MEMORY.DELETE_FIELD, fieldId) as Promise<MemoryField[]>,
    suggestions: () => ipcRenderer.invoke(IPC.MEMORY.SUGGESTIONS) as Promise<MemorySuggestion[]>,
    extract: (request: MemoryExtractionRequest) => ipcRenderer.invoke(IPC.MEMORY.EXTRACT, request) as Promise<MemoryExtractionResult>,
    abort: () => ipcRenderer.invoke(IPC.MEMORY.ABORT) as Promise<void>,
    reviewSuggestion: (request: MemorySuggestionReviewRequest) => ipcRenderer.invoke(IPC.MEMORY.REVIEW_SUGGESTION, request) as Promise<{ fields: MemoryField[]; suggestions: MemorySuggestion[] }>,
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.PROJECTS.LIST) as Promise<Project[]>,
    create: (data: ProjectInput) => ipcRenderer.invoke(IPC.PROJECTS.CREATE, data) as Promise<Project>,
    update: (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => ipcRenderer.invoke(IPC.PROJECTS.UPDATE, id, data) as Promise<void>,
    delete: (id: string) => ipcRenderer.invoke(IPC.PROJECTS.DELETE, id) as Promise<void>,
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC.PROJECTS.REORDER, orderedIds) as Promise<Project[]>,
    addFile: (projectId: string, filePath: string) => ipcRenderer.invoke(IPC.PROJECTS.ADD_FILE, projectId, filePath) as Promise<void>,
    removeFile: (projectId: string, filePath: string) => ipcRenderer.invoke(IPC.PROJECTS.REMOVE_FILE, projectId, filePath) as Promise<void>,
    addSource: (projectId: string, sourcePath: string) => ipcRenderer.invoke(IPC.PROJECTS.ADD_SOURCE, projectId, sourcePath) as Promise<ProjectSource[]>,
    removeSource: (projectId: string, sourcePath: string) => ipcRenderer.invoke(IPC.PROJECTS.REMOVE_SOURCE, projectId, sourcePath) as Promise<ProjectSource[]>,
    listSources: (projectId: string) => ipcRenderer.invoke(IPC.PROJECTS.LIST_SOURCES, projectId) as Promise<ProjectSource[]>,
    analyzePsychology: (projectId: string) => ipcRenderer.invoke(IPC.PROJECTS.ANALYZE_PSYCHOLOGY, projectId) as Promise<PsychologyAnalysis>,
    analyzeHealth: (projectId: string) => ipcRenderer.invoke(IPC.PROJECTS.ANALYZE_HEALTH, projectId) as Promise<HealthAnalysis>,
    completePsychologyTest: (projectId: string, testId: PsychologicalTestId, answers: number[]) => ipcRenderer.invoke(IPC.PROJECTS.COMPLETE_PSYCHOLOGY_TEST, projectId, testId, answers) as Promise<PsychologicalTestResult>,
    restoreDefaults: () => ipcRenderer.invoke(IPC.PROJECTS.RESTORE_DEFAULTS) as Promise<Project[]>,
  },
  app: {
    openExternal: (url: string) => ipcRenderer.invoke(IPC.APP.OPEN_EXTERNAL, url) as Promise<void>,
    selectDirectory: () => ipcRenderer.invoke(IPC.APP.SELECT_DIRECTORY) as Promise<string | null>,
    selectFiles: () => ipcRenderer.invoke(IPC.APP.SELECT_FILES) as Promise<string[]>,
    selectImage: () => ipcRenderer.invoke(IPC.APP.SELECT_IMAGE) as Promise<string | null>,
    selectAttachments: () => ipcRenderer.invoke(IPC.APP.SELECT_ATTACHMENTS) as Promise<ChatAttachment[]>,
    onNewChat: (callback: () => void) => {
      ipcRenderer.on(IPC.MENU.NEW_CHAT, () => callback())
      return () => ipcRenderer.removeAllListeners(IPC.MENU.NEW_CHAT)
    },
    onSettings: (callback: () => void) => {
      ipcRenderer.on(IPC.MENU.SETTINGS, () => callback())
      return () => ipcRenderer.removeAllListeners(IPC.MENU.SETTINGS)
    },
    getUserInfo: () => ipcRenderer.invoke(IPC.APP.GET_USER_INFO) as Promise<{ firstName: string }>,
  },
  importClaude: {
    start: (directory: string, options: ClaudeImportOptions) =>
      ipcRenderer.invoke(IPC.IMPORT_CLAUDE.START, directory, options) as Promise<ClaudeImportResult>,
    abort: () => ipcRenderer.invoke(IPC.IMPORT_CLAUDE.ABORT) as Promise<void>,
    onProgress: (callback: (progress: ClaudeImportProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ClaudeImportProgress) => callback(progress)
      ipcRenderer.on(IPC.IMPORT_CLAUDE.PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.IMPORT_CLAUDE.PROGRESS, handler)
    },
  },
  health: {
    ingest: (projectId: string, filePath: string) =>
      ipcRenderer.invoke(IPC.HEALTH.INGEST, projectId, filePath) as Promise<HealthRecord>,
    scanDirectory: (projectId: string) =>
      ipcRenderer.invoke(IPC.HEALTH.SCAN_DIRECTORY, projectId) as Promise<DirectoryScanResult>,
    abort: () => ipcRenderer.invoke(IPC.HEALTH.INGEST_ABORT) as Promise<void>,
    onProgress: (callback: (progress: HealthIngestProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: HealthIngestProgress) => callback(progress)
      ipcRenderer.on(IPC.HEALTH.INGEST_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.HEALTH.INGEST_PROGRESS, handler)
    },
    listRecords: (projectId: string) =>
      ipcRenderer.invoke(IPC.HEALTH.LIST_RECORDS, projectId) as Promise<HealthRecord[]>,
    listObservations: (projectId: string, opts?: { type?: string; limit?: number }) =>
      ipcRenderer.invoke(IPC.HEALTH.LIST_OBSERVATIONS, projectId, opts) as Promise<HealthObservation[]>,
    deleteRecord: (recordId: string) =>
      ipcRenderer.invoke(IPC.HEALTH.DELETE_RECORD, recordId) as Promise<void>,
    refreshSummary: (projectId: string) =>
      ipcRenderer.invoke(IPC.HEALTH.REFRESH_SUMMARY, projectId) as Promise<HealthSummary>,
    getSummary: (projectId: string) =>
      ipcRenderer.invoke(IPC.HEALTH.GET_SUMMARY, projectId) as Promise<HealthSummary | null>,
    liveStatus: (projectId: string) =>
      ipcRenderer.invoke(IPC.HEALTH.LIVE_STATUS, projectId) as Promise<HealthLiveStatus>,
    liveSync: (projectId: string, types?: string[]) =>
      ipcRenderer.invoke(IPC.HEALTH.LIVE_SYNC, projectId, types) as Promise<HealthSyncResult>,
    liveAbort: () =>
      ipcRenderer.invoke(IPC.HEALTH.LIVE_SYNC_ABORT) as Promise<void>,
    onLiveSyncProgress: (callback: (progress: HealthLiveSyncProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: HealthLiveSyncProgress) => callback(progress)
      ipcRenderer.on(IPC.HEALTH.LIVE_SYNC_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.HEALTH.LIVE_SYNC_PROGRESS, handler)
    },
  },
  activity: {
    ingest: (projectId: string, filePath: string, source: ActivitySourceType) =>
      ipcRenderer.invoke(IPC.ACTIVITY.INGEST, projectId, filePath, source) as Promise<ActivityRecord>,
    scanDirectory: (projectId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.SCAN_DIRECTORY, projectId) as Promise<DirectoryScanResult>,
    abort: () => ipcRenderer.invoke(IPC.ACTIVITY.INGEST_ABORT) as Promise<void>,
    onProgress: (callback: (progress: ActivityIngestProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ActivityIngestProgress) => callback(progress)
      ipcRenderer.on(IPC.ACTIVITY.INGEST_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.ACTIVITY.INGEST_PROGRESS, handler)
    },
    listRecords: (projectId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.LIST_RECORDS, projectId) as Promise<ActivityRecord[]>,
    listEvents: (projectId: string, sourceType?: ActivitySourceType, limit?: number) =>
      ipcRenderer.invoke(IPC.ACTIVITY.LIST_EVENTS, projectId, sourceType, limit) as Promise<ActivityEventsBySource>,
    deleteRecord: (recordId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.DELETE_RECORD, recordId) as Promise<void>,
    refreshSummary: (projectId: string, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.ACTIVITY.REFRESH_SUMMARY, projectId, tier) as Promise<ActivitySummary>,
    estimateAnalysis: (projectId: string, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.ACTIVITY.ESTIMATE_ANALYSIS, projectId, tier) as Promise<ActivityAnalysisEstimate>,
    getRunState: () => ipcRenderer.invoke(IPC.ACTIVITY.GET_RUN_STATE) as Promise<ActivityRunState>,
    onRunState: (callback: (state: ActivityRunState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: ActivityRunState) => callback(state)
      ipcRenderer.on(IPC.ACTIVITY.RUN_STATE, handler)
      return () => ipcRenderer.removeListener(IPC.ACTIVITY.RUN_STATE, handler)
    },
    getSummary: (projectId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.GET_SUMMARY, projectId) as Promise<ActivitySummary | null>,
    liveStatus: (projectId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.LIVE_STATUS, projectId) as Promise<ActivityLiveStatus>,
    liveSync: (projectId: string, sourceTypes?: ActivitySourceType[]) =>
      ipcRenderer.invoke(IPC.ACTIVITY.LIVE_SYNC, projectId, sourceTypes) as Promise<ActivitySyncResult>,
    liveAbort: () =>
      ipcRenderer.invoke(IPC.ACTIVITY.LIVE_SYNC_ABORT) as Promise<void>,
    onLiveSyncProgress: (callback: (progress: ActivityIngestProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ActivityIngestProgress) => callback(progress)
      ipcRenderer.on(IPC.ACTIVITY.LIVE_SYNC_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.ACTIVITY.LIVE_SYNC_PROGRESS, handler)
    },
    grantPermission: () =>
      ipcRenderer.invoke(IPC.ACTIVITY.GRANT_PERMISSION) as Promise<void>,
    setAmazonCookies: (cookies: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.SET_AMAZON_COOKIES, cookies) as Promise<void>,
    clearAmazonCookies: () =>
      ipcRenderer.invoke(IPC.ACTIVITY.CLEAR_AMAZON_COOKIES) as Promise<void>,
    listAccounts: (projectId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.LIST_ACCOUNTS, projectId) as Promise<ActivityAccount[]>,
    updateAccount: (accountId: string, update: ActivityAccountUpdate) =>
      ipcRenderer.invoke(IPC.ACTIVITY.UPDATE_ACCOUNT, accountId, update) as Promise<ActivityAccount>,
    setAccountCredential: (accountId: string, secret: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.SET_ACCOUNT_CREDENTIAL, accountId, secret) as Promise<ActivityAccount>,
    clearAccountCredential: (accountId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.CLEAR_ACCOUNT_CREDENTIAL, accountId) as Promise<ActivityAccount>,
    syncAccount: (accountId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.SYNC_ACCOUNT, accountId) as Promise<ActivityAccountSyncResult>,
    importAccountExport: (accountId: string, filePath: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.IMPORT_ACCOUNT_EXPORT, accountId, filePath) as Promise<ActivityRecord>,
    addAccountSource: (accountId: string, sourcePath: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.ADD_ACCOUNT_SOURCE, accountId, sourcePath) as Promise<ActivityAccount>,
    removeAccountSource: (accountId: string, sourcePath: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.REMOVE_ACCOUNT_SOURCE, accountId, sourcePath) as Promise<ActivityAccount>,
    scanAccountSources: (projectId: string) =>
      ipcRenderer.invoke(IPC.ACTIVITY.SCAN_ACCOUNT_SOURCES, projectId) as Promise<{ ingested: number }>,
    setLocation: (lat: number, lng: number) =>
      ipcRenderer.invoke(IPC.ACTIVITY.SET_LOCATION, lat, lng) as Promise<void>,
    getLocation: () =>
      ipcRenderer.invoke(IPC.ACTIVITY.GET_LOCATION) as Promise<{ lat: number | null; lng: number | null }>,
    fetchCurrentLocation: () =>
      ipcRenderer.invoke(IPC.ACTIVITY.FETCH_CURRENT_LOCATION) as Promise<
        | { status: 'ok'; fix: { lat: number; lng: number; accuracyM: number } }
        | { status: 'needs_permission' }
        | { status: 'timeout' }
        | { status: 'unavailable' }
      >,
    sidecarAvailable: () =>
      ipcRenderer.invoke(IPC.ACTIVITY.SIDECAR_AVAILABLE) as Promise<boolean>,
  },
  documents: {
    generate: (projectId: string, tier?: ModelTier, options?: { sourcePath?: string; force?: boolean; granularity?: IndexGranularity }) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GENERATE, projectId, tier, options) as Promise<DocumentContextResult>,
    generateAll: (options?: { resume?: boolean; tier?: ModelTier; projectIds?: string[]; force?: boolean; granularity?: IndexGranularity }) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GENERATE_ALL, options) as Promise<DocumentIndexAllResult>,
    estimate: (projectId: string, tier?: ModelTier, options?: { sourcePath?: string; force?: boolean; granularity?: IndexGranularity }) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.ESTIMATE, projectId, tier, options) as Promise<IndexEstimate>,
    estimateAll: (tier?: ModelTier, options?: { projectIds?: string[]; force?: boolean; granularity?: IndexGranularity }) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.ESTIMATE_ALL, tier, options) as Promise<IndexEstimate>,
    abort: () => ipcRenderer.invoke(IPC.DOCUMENTS.ABORT) as Promise<DocumentIndexState>,
    pause: () => ipcRenderer.invoke(IPC.DOCUMENTS.PAUSE) as Promise<DocumentIndexState>,
    getState: () => ipcRenderer.invoke(IPC.DOCUMENTS.GET_STATE) as Promise<DocumentIndexState>,
    getTree: (projectId: string) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GET_TREE, projectId) as Promise<DocumentContextTree>,
    getSummaries: () =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GET_SUMMARIES) as Promise<ProjectIndexSummary[]>,
    getProvenance: (ref: string, projectId?: string | null, options?: { maxNodes?: number; maxDepth?: number }) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GET_PROVENANCE, ref, projectId ?? null, options) as Promise<ProvenanceChain>,
    getSourceExcerpt: (filePath: string, startLine: number, endLine: number, projectId?: string | null) =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GET_SOURCE_EXCERPT, filePath, startLine, endLine, projectId ?? null) as Promise<SourceExcerpt>,
    getUserContext: () =>
      ipcRenderer.invoke(IPC.DOCUMENTS.GET_USER_CONTEXT) as Promise<UserSuperContext | null>,
    refreshUserContext: () =>
      ipcRenderer.invoke(IPC.DOCUMENTS.REFRESH_USER_CONTEXT) as Promise<UserSuperContext | null>,
    onProgress: (callback: (progress: DocumentContextProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DocumentContextProgress) => callback(progress)
      ipcRenderer.on(IPC.DOCUMENTS.PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.DOCUMENTS.PROGRESS, handler)
    },
    onState: (callback: (state: DocumentIndexState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: DocumentIndexState) => callback(state)
      ipcRenderer.on(IPC.DOCUMENTS.STATE, handler)
      return () => ipcRenderer.removeListener(IPC.DOCUMENTS.STATE, handler)
    },
  },
  timeline: {
    list: (filter?: TimelineFilter) =>
      ipcRenderer.invoke(IPC.TIMELINE.LIST, filter) as Promise<TimelineEvent[]>,
    getSummary: () =>
      ipcRenderer.invoke(IPC.TIMELINE.GET_SUMMARY) as Promise<TimelineSummary | null>,
    getYears: () =>
      ipcRenderer.invoke(IPC.TIMELINE.GET_YEARS) as Promise<TimelineYearsView>,
    rebuild: () => ipcRenderer.invoke(IPC.TIMELINE.REBUILD) as Promise<TimelineRebuildResult>,
    abort: () => ipcRenderer.invoke(IPC.TIMELINE.ABORT) as Promise<void>,
    createEvent: (input: TimelineEventInput) =>
      ipcRenderer.invoke(IPC.TIMELINE.CREATE_EVENT, input) as Promise<TimelineEvent>,
    deleteEvent: (id: string) => ipcRenderer.invoke(IPC.TIMELINE.DELETE_EVENT, id) as Promise<void>,
    onProgress: (callback: (progress: TimelineRebuildProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: TimelineRebuildProgress) => callback(progress)
      ipcRenderer.on(IPC.TIMELINE.PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.TIMELINE.PROGRESS, handler)
    },
    getState: () => ipcRenderer.invoke(IPC.TIMELINE.GET_STATE) as Promise<TimelineRunState>,
    onState: (callback: (state: TimelineRunState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: TimelineRunState) => callback(state)
      ipcRenderer.on(IPC.TIMELINE.STATE, handler)
      return () => ipcRenderer.removeListener(IPC.TIMELINE.STATE, handler)
    },
  },
  library: {
    scan: (projectId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.SCAN, projectId) as Promise<LibraryScanResult>,
    abortScan: () => ipcRenderer.invoke(IPC.LIBRARY.SCAN_ABORT) as Promise<boolean>,
    getState: () => ipcRenderer.invoke(IPC.LIBRARY.GET_STATE) as Promise<LibraryRunState>,
    onState: (callback: (state: LibraryRunState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: LibraryRunState) => callback(state)
      ipcRenderer.on(IPC.LIBRARY.STATE, handler)
      return () => ipcRenderer.removeListener(IPC.LIBRARY.STATE, handler)
    },
    onScanProgress: (callback: (progress: LibraryScanProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: LibraryScanProgress) => callback(progress)
      ipcRenderer.on(IPC.LIBRARY.SCAN_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.LIBRARY.SCAN_PROGRESS, handler)
    },
    listBooks: (projectId?: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_BOOKS, projectId) as Promise<LibraryBook[]>,
    getBook: (bookId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.GET_BOOK, bookId) as Promise<{ book: Book; chapters: BookChapter[]; reading: BookReadingState }>,
    deleteBook: (bookId: string) => ipcRenderer.invoke(IPC.LIBRARY.DELETE_BOOK, bookId) as Promise<void>,
    getChapter: (bookId: string, chapterIndex: number) =>
      ipcRenderer.invoke(IPC.LIBRARY.GET_CHAPTER, bookId, chapterIndex) as Promise<BookChapterContent>,
    getResource: (bookId: string, resourceId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.GET_RESOURCE, bookId, resourceId) as Promise<BookResource>,
    setReadingState: (bookId: string, patch: { status?: BookReadingStatus; rating?: number | null; notes?: string }) =>
      ipcRenderer.invoke(IPC.LIBRARY.SET_READING_STATE, bookId, patch) as Promise<BookReadingState>,
    setProgress: (bookId: string, chapterIndex: number, charOffset: number) =>
      ipcRenderer.invoke(IPC.LIBRARY.SET_PROGRESS, bookId, chapterIndex, charOffset) as Promise<BookReadingState>,
    recordSession: (session: Omit<BookReadingSession, 'id'>) =>
      ipcRenderer.invoke(IPC.LIBRARY.RECORD_SESSION, session) as Promise<void>,
    estimateSnapshot: (projectId: string, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.LIBRARY.ESTIMATE_SNAPSHOT, projectId, tier) as Promise<IndexEstimate>,
    refreshSnapshot: (projectId: string, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.LIBRARY.REFRESH_SNAPSHOT, projectId, tier) as Promise<LibrarySnapshotResult>,
    listAnnotationRuns: (bookId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_ANNOTATION_RUNS, bookId) as Promise<BookAnnotationRun[]>,
    listAnnotations: (bookId: string, chapterIndex?: number) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_ANNOTATIONS, bookId, chapterIndex) as Promise<BookAnnotation[]>,
    estimateAnnotations: (bookId: string, chapterStart: number, chapterEnd: number, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.LIBRARY.ESTIMATE_ANNOTATIONS, bookId, chapterStart, chapterEnd, tier) as Promise<IndexEstimate>,
    generateAnnotations: (
      bookId: string,
      focus: { key: string; customText?: string },
      chapterStart: number,
      chapterEnd: number,
      tier?: ModelTier
    ) =>
      ipcRenderer.invoke(IPC.LIBRARY.GENERATE_ANNOTATIONS, bookId, focus, chapterStart, chapterEnd, tier) as Promise<AnnotationRunSummary>,
    deleteAnnotationRun: (runId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.DELETE_ANNOTATION_RUN, runId) as Promise<void>,
    createAnnotation: (input: { bookId: string; chapterIndex: number; charStart: number; charEnd: number; label?: string; body?: string }) =>
      ipcRenderer.invoke(IPC.LIBRARY.CREATE_ANNOTATION, input) as Promise<BookAnnotation>,
    setAnnotationPinned: (id: string, pinned: boolean) =>
      ipcRenderer.invoke(IPC.LIBRARY.SET_ANNOTATION_PINNED, id, pinned) as Promise<void>,
    deleteAnnotation: (id: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.DELETE_ANNOTATION, id) as Promise<void>,
    abortGeneration: () => ipcRenderer.invoke(IPC.LIBRARY.ABORT_GENERATION) as Promise<boolean>,
    listLessons: (bookId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_LESSONS, bookId) as Promise<BookLesson[]>,
    getLesson: (lessonId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.GET_LESSON, lessonId) as Promise<BookLesson | null>,
    estimateLesson: (bookId: string, chapterStart: number, chapterEnd: number, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.LIBRARY.ESTIMATE_LESSON, bookId, chapterStart, chapterEnd, tier) as Promise<IndexEstimate>,
    generateLesson: (bookId: string, chapterStart: number, chapterEnd: number, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.LIBRARY.GENERATE_LESSON, bookId, chapterStart, chapterEnd, tier) as Promise<LessonRunSummary>,
    deleteLesson: (lessonId: string) => ipcRenderer.invoke(IPC.LIBRARY.DELETE_LESSON, lessonId) as Promise<void>,
    recordAttempt: (attempt: Omit<BookLessonAttempt, 'id' | 'createdAt'>) =>
      ipcRenderer.invoke(IPC.LIBRARY.RECORD_ATTEMPT, attempt) as Promise<BookLessonAttempt>,
    listAttempts: (lessonId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_ATTEMPTS, lessonId) as Promise<BookLessonAttempt[]>,
    buildDiscussionPrompt: (bookId: string, chapterIndex: number, lessonId?: string, stepId?: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.BUILD_DISCUSSION_PROMPT, bookId, chapterIndex, lessonId, stepId) as Promise<BookDiscussionScope>,
    linkConversation: (bookId: string, conversationId: string, meta: { chapterIndex?: number; lessonId?: string; stepId?: string }) =>
      ipcRenderer.invoke(IPC.LIBRARY.LINK_CONVERSATION, bookId, conversationId, meta) as Promise<void>,
    listConversations: (bookId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_CONVERSATIONS, bookId) as Promise<BookConversationLink[]>,
    speechProviders: () =>
      ipcRenderer.invoke(IPC.LIBRARY.SPEECH_PROVIDERS) as Promise<SpeechProviderInfo[]>,
    setSpeechKey: (providerId: SpeechProviderId, key: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.SET_SPEECH_KEY, providerId, key) as Promise<SpeechKeyResult>,
    clearSpeechKey: (providerId: SpeechProviderId) =>
      ipcRenderer.invoke(IPC.LIBRARY.CLEAR_SPEECH_KEY, providerId) as Promise<void>,
    listVoices: (providerId: SpeechProviderId) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_VOICES, providerId) as Promise<SpeechVoice[]>,
    listNarrationModels: (providerId: SpeechProviderId) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_NARRATION_MODELS, providerId) as Promise<SpeechModel[]>,
    estimateAudiobook: (bookId: string, chapterIndex: number, providerId?: SpeechProviderId, modelId?: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.ESTIMATE_AUDIOBOOK, bookId, chapterIndex, providerId, modelId) as Promise<AudiobookEstimate>,
    generateAudiobook: (
      bookId: string,
      chapterIndex: number,
      options: { providerId: SpeechProviderId; voiceId: string; voiceName?: string; modelId?: string; force?: boolean }
    ) =>
      ipcRenderer.invoke(IPC.LIBRARY.GENERATE_AUDIOBOOK, bookId, chapterIndex, options) as Promise<AudiobookChapter>,
    getAudiobook: (bookId: string, chapterIndex: number) =>
      ipcRenderer.invoke(IPC.LIBRARY.GET_AUDIOBOOK, bookId, chapterIndex) as Promise<AudiobookChapter | null>,
    listAudiobooks: (bookId: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.LIST_AUDIOBOOKS, bookId) as Promise<Audiobook[]>,
    deleteAudiobook: (bookId: string, chapterIndex: number) =>
      ipcRenderer.invoke(IPC.LIBRARY.DELETE_AUDIOBOOK, bookId, chapterIndex) as Promise<void>,
    getMediaUrl: (kind: RemoteMediaKind, id: string) =>
      ipcRenderer.invoke(IPC.LIBRARY.GET_MEDIA_URL, kind, id) as Promise<RemoteMediaTicket>,
    planOrganize: (projectId: string, tier?: ModelTier) =>
      ipcRenderer.invoke(IPC.LIBRARY.PLAN_ORGANIZE, projectId, tier) as Promise<OrganizePlan>,
    applyOrganize: (plan: OrganizePlan) =>
      ipcRenderer.invoke(IPC.LIBRARY.APPLY_ORGANIZE, plan) as Promise<OrganizeResult>,
    onAudiobookProgress: (callback: (progress: AudiobookProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: AudiobookProgress) => callback(progress)
      ipcRenderer.on(IPC.LIBRARY.AUDIOBOOK_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.LIBRARY.AUDIOBOOK_PROGRESS, handler)
    },
  },
  people: {
    list: (filter?: PeopleFilter) =>
      ipcRenderer.invoke(IPC.PEOPLE.LIST, filter) as Promise<Person[]>,
    get: (id: string) =>
      ipcRenderer.invoke(IPC.PEOPLE.GET, id) as Promise<{ person: Person; mentions: PersonMention[] } | null>,
    rebuild: () => ipcRenderer.invoke(IPC.PEOPLE.REBUILD) as Promise<PeopleRebuildResult>,
    abort: () => ipcRenderer.invoke(IPC.PEOPLE.ABORT) as Promise<PeopleRunState>,
    pause: () => ipcRenderer.invoke(IPC.PEOPLE.PAUSE) as Promise<PeopleRunState>,
    pin: (mentionKey: string, personKey: string | null) =>
      ipcRenderer.invoke(IPC.PEOPLE.PIN, mentionKey, personKey) as Promise<void>,
    merge: (sourceKey: string, targetKey: string) =>
      ipcRenderer.invoke(IPC.PEOPLE.MERGE, sourceKey, targetKey) as Promise<void>,
    ignore: (personKey: string, ignored: boolean) =>
      ipcRenderer.invoke(IPC.PEOPLE.IGNORE, personKey, ignored) as Promise<void>,
    setRelation: (personKey: string, relation: PersonRelation) =>
      ipcRenderer.invoke(IPC.PEOPLE.SET_RELATION, personKey, relation) as Promise<void>,
    onProgress: (callback: (progress: PeopleRebuildProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: PeopleRebuildProgress) => callback(progress)
      ipcRenderer.on(IPC.PEOPLE.PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.PEOPLE.PROGRESS, handler)
    },
    getState: () => ipcRenderer.invoke(IPC.PEOPLE.GET_STATE) as Promise<PeopleRunState>,
    onState: (callback: (state: PeopleRunState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: PeopleRunState) => callback(state)
      ipcRenderer.on(IPC.PEOPLE.STATE, handler)
      return () => ipcRenderer.removeListener(IPC.PEOPLE.STATE, handler)
    },
  },
  contextVersions: {
    list: (filter?: ContextVersionFilter) =>
      ipcRenderer.invoke(IPC.CONTEXT_VERSIONS.LIST, filter) as Promise<ContextVersionSummary[]>,
    get: (id: string) =>
      ipcRenderer.invoke(IPC.CONTEXT_VERSIONS.GET, id) as Promise<ContextVersion | null>,
  },
  roles: {
    list: () => ipcRenderer.invoke(IPC.ROLES.LIST) as Promise<RoleSummary[]>,
    getSessionNote: (conversationId: string) =>
      ipcRenderer.invoke(IPC.ROLES.GET_SESSION_NOTE, conversationId) as Promise<RoleSessionNote | null>,
    listSessionNotes: (filter?: RoleSessionNoteFilter) =>
      ipcRenderer.invoke(IPC.ROLES.LIST_SESSION_NOTES, filter) as Promise<RoleSessionNote[]>,
    generateSessionNote: (conversationId: string, force?: boolean) =>
      ipcRenderer.invoke(IPC.ROLES.GENERATE_SESSION_NOTE, conversationId, force) as Promise<RoleSessionNoteResult>,
    deleteSessionNote: (conversationId: string) =>
      ipcRenderer.invoke(IPC.ROLES.DELETE_SESSION_NOTE, conversationId) as Promise<void>,
    onSessionNoteAdded: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC.ROLES.SESSION_NOTE_ADDED, handler)
      return () => ipcRenderer.removeListener(IPC.ROLES.SESSION_NOTE_ADDED, handler)
    },
  },
  ideas: {
    get: () => ipcRenderer.invoke(IPC.IDEAS.GET) as Promise<HomeIdeasResult>,
    refresh: (force?: boolean) => ipcRenderer.invoke(IPC.IDEAS.REFRESH, force) as Promise<HomeIdeasResult>,
  },
  providerCredit: {
    get: () => ipcRenderer.invoke(IPC.PROVIDER_CREDIT.GET) as Promise<CreditBreakerState>,
    clear: () => ipcRenderer.invoke(IPC.PROVIDER_CREDIT.CLEAR) as Promise<void>,
    onState: (callback: (state: CreditBreakerState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: CreditBreakerState) => callback(state)
      ipcRenderer.on(IPC.PROVIDER_CREDIT.STATE, handler)
      return () => ipcRenderer.removeListener(IPC.PROVIDER_CREDIT.STATE, handler)
    },
  },
  callHistory: {
    list: (filter?: ProviderCallFilter) =>
      ipcRenderer.invoke(IPC.CALL_HISTORY.LIST, filter) as Promise<ProviderCallSummary[]>,
    get: (id: string) => ipcRenderer.invoke(IPC.CALL_HISTORY.GET, id) as Promise<ProviderCall | null>,
    stats: (filter?: ProviderCallFilter) =>
      ipcRenderer.invoke(IPC.CALL_HISTORY.STATS, filter) as Promise<ProviderCallStats>,
    clear: () => ipcRenderer.invoke(IPC.CALL_HISTORY.CLEAR) as Promise<void>,
  },
  remote: {
    getStatus: () => ipcRenderer.invoke(IPC.REMOTE.GET_STATUS) as Promise<RemoteServerStatus>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC.REMOTE.SET_ENABLED, enabled) as Promise<RemoteServerStatus>,
    createPairing: (scope: RemoteScope) =>
      ipcRenderer.invoke(IPC.REMOTE.CREATE_PAIRING, scope) as Promise<RemotePairingOffer>,
    cancelPairing: () => ipcRenderer.invoke(IPC.REMOTE.CANCEL_PAIRING) as Promise<void>,
    listDevices: () => ipcRenderer.invoke(IPC.REMOTE.LIST_DEVICES) as Promise<RemoteDevice[]>,
    revokeDevice: (deviceId: string) => ipcRenderer.invoke(IPC.REMOTE.REVOKE_DEVICE, deviceId) as Promise<void>,
    renameDevice: (deviceId: string, name: string) =>
      ipcRenderer.invoke(IPC.REMOTE.RENAME_DEVICE, deviceId, name) as Promise<void>,
    onStatus: (callback: (status: RemoteServerStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: RemoteServerStatus) => callback(status)
      ipcRenderer.on(IPC.REMOTE.STATUS, handler)
      return () => ipcRenderer.removeListener(IPC.REMOTE.STATUS, handler)
    },
  },
  fs: {
    readFile: (filePath: string, options?: { encoding?: 'utf8' | 'base64'; maxBytes?: number }) =>
      ipcRenderer.invoke(IPC.FS.READ_FILE, filePath, options) as Promise<FsReadResult>,
    writeFile: (request: FsWriteRequest) =>
      ipcRenderer.invoke(IPC.FS.WRITE_FILE, request) as Promise<FsWriteResult>,
    listDir: (filePath: string) =>
      ipcRenderer.invoke(IPC.FS.LIST_DIR, filePath) as Promise<FsListItem[]>,
    stat: (filePath: string) =>
      ipcRenderer.invoke(IPC.FS.STAT, filePath) as Promise<{ path: string; isFile: boolean; isDirectory: boolean; size: number; modifiedAt: number }>,
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
