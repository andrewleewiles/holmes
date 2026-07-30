// The Activity account registry carries runtime data (the provider list), so it
// lives in its own module. Its types are re-exported here so `@shared/types`
// stays the one import every consumer needs.
import type { ActivityCredentialKind, ActivityProviderId } from './activityProviders'
// Same reasoning for the Library: its contract is large enough to own a module,
// and re-exporting here keeps `@shared/types` the one import consumers need.
import type { ProjectKind } from './defaultProjects'
import type { WorkDocumentKind } from './workDocuments'
import type {
  Book,
  BookChapter,
  BookChapterContent,
  BookReadingSession,
  BookReadingState,
  BookReadingStatus,
  BookResource,
  LibraryBook,
  LibraryRunState,
  LibraryScanProgress,
  LibraryScanResult,
  LibrarySnapshotResult,
  BookAnnotation,
  BookAnnotationRun,
  AnnotationRunSummary,
  BookLesson,
  BookLessonAttempt,
  BookConversationLink,
  BookDiscussionScope,
  LessonRunSummary,
  Audiobook,
  AudiobookChapter,
  AudiobookEstimate,
  AudiobookProgress,
  ElevenLabsKeyResult,
  ElevenLabsModel,
  ElevenLabsStatus,
  ElevenLabsVoice,
  SpeechProviderId,
  SpeechProviderInfo,
  SpeechModel,
  SpeechVoice,
  SpeechKeyResult,
  OrganizePlan,
  OrganizeResult,
} from './books'

// The credit breaker's shape is part of the renderer contract: the banner that
// explains why the app stopped calling the provider renders it.
import type { CreditBreakerState } from './creditBreaker'

export type { CreditBreakerState }
export type { ActivityCredentialKind, ActivityProviderId }
export type { ProjectKind, DefaultProjectCategory } from './defaultProjects'
export type * from './books'

export type ReasoningEffort = 'low' | 'medium' | 'high'

export type MemoryMode = 'detailed' | 'abridged' | 'anonymous'

export type ContextSelectionItem =
  | { kind: 'none' }
  | { kind: 'project'; projectId: string }
  | { kind: 'life' }
  | { kind: 'category'; categoryKey: string }

export type ContextSelection =
  | ContextSelectionItem
  | { kind: 'stack'; items: ContextSelection[] }

/**
 * How urgent the risk content in a session transcript was. Recorded rather than
 * reduced to a boolean: "nothing was said" and "distress but no plan" are
 * different findings, and collapsing them loses the one that matters.
 */
export type RoleSessionRisk = 'none' | 'monitor' | 'urgent'

/** One heading of a stored session note. */
export interface RoleSessionNoteSection {
  key: string
  heading: string
  body: string
}

/**
 * The formal analysis written from one role-led conversation. One per
 * conversation: continuing the conversation regenerates it, and the outgoing
 * version is archived in `context_versions` like every other generated context.
 */
export interface RoleSessionNote {
  id: string
  conversationId: string
  conversationTitle: string
  roleId: string
  projectId: string | null
  /** When the conversation itself happened, not when the note was written. */
  sessionDate: string
  generatedAt: number
  model: string | null
  title: string
  summary: string
  risk: RoleSessionRisk
  sections: RoleSessionNoteSection[]
  /** The note as generated, TIMELINE block included. */
  content: string
  turns: number
  /** The markdown copy written into the role's project folder, when one exists. */
  filePath: string | null
}

/**
 * A role as the renderer sees it. The role document and the session-note prompt
 * stay in the main process: the pill renders a name and a hint, not kilobytes of
 * prompt text.
 */
export interface RoleSummary {
  id: string
  name: string
  specialty: string
  icon: string
  color: string
  description: string
  writesSessionNote: boolean
  sessionProjectName: string | null
}

export interface RoleSessionNoteFilter {
  projectId?: string
  roleId?: string
  limit?: number
}

export interface RoleSessionNoteResult {
  conversationId: string
  outcome: 'generated' | 'cached' | 'empty' | 'skipped'
  note?: RoleSessionNote
  reason?: string
}

export interface Conversation {
  id: string
  title: string
  model: string | null
  systemPrompt: string
  /** Head of `projectIds` — kept because older queries and features read it. */
  projectId: string | null
  /** Every project this conversation is filed under, in context-stack order. */
  projectIds: string[]
  reasoningEffort: ReasoningEffort
  memoryMode: MemoryMode
  context: ContextSelection
  /** The role the assistant takes for this conversation; null is no role. */
  roleId: string | null
  createdAt: number
  updatedAt: number
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolResult {
  callId: string
  name: string
  content: string
  error?: boolean
}

export type ChatAttachmentKind = 'image' | 'video'

export type ChatAttachmentOrigin = 'user' | 'generated'

export interface ChatAttachment {
  id: string
  kind: ChatAttachmentKind
  name: string
  mimeType: string
  bytes: number
  dataUrl: string
  origin: ChatAttachmentOrigin
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  reasoning?: string
  createdAt: number
  tokenCount?: number
  model?: string
  parentId?: string
  siblingCount?: number
  siblingIndex?: number
  siblingIds?: string[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  /**
   * Whether this tool result was a failure. Persisted because the unified tool row
   * shows the outcome: without it a call that failed reads as having succeeded
   * once the conversation is reloaded.
   */
  toolError?: boolean
  attachments?: ChatAttachment[]
  /**
   * The numbered sources the turn that produced this message actually read.
   * Carried on every assistant message of the turn so `[S1]` markers anywhere in
   * its prose can be resolved, and persisted so they still resolve after reload.
   */
  sources?: CitedSource[]
}

/**
 * One source Holmes read during a turn, numbered so the model can point at it
 * from inside its prose and the renderer can draw it as a pill.
 *
 * These are minted from tool results Holmes ran itself — never from anything the
 * model wrote — which is what makes an id either resolvable or provably invented.
 */
export interface CitedSource {
  /** `S1`, `S2`, … assigned in the order the turn encountered them. */
  id: string
  kind: 'web' | 'file'
  /** The pill's text: a hostname for the web, a file's name on disk. */
  label: string
  /** The full title, for the hover tooltip. Falls back to `label`. */
  title: string
  /** Web sources only: the http(s) URL the pill opens. */
  url?: string
  /** File sources only: the absolute path the pill opens. */
  path?: string
  /** The tool that surfaced it, so the tooltip can say where it came from. */
  tool: string
}

export type ProviderType = 'openrouter' | 'custom' | 'ollama'

export interface ProviderConfig {
  type: ProviderType
  openrouterApiKey: string
  customBaseUrl: string
  customApiKey: string
  customModel: string
  // Ollama's OpenAI-compatible surface lives under /v1 on a local daemon and
  // needs no key at all, so it gets its own host field rather than reusing the
  // custom endpoint's — switching between a cloud endpoint and the local one
  // should not make the user retype either URL.
  ollamaBaseUrl: string
}

export type FileAccessScopeMode = 'everywhere' | 'custom'

export interface FileAccessScope {
  mode: FileAccessScopeMode
  roots: string[]
}

// Intelligence tiers for background/system work. Distinct from ReasoningEffort,
// which is the per-request `reasoning: { effort }` knob on a single model.
export type ModelTier = 'budget' | 'mid' | 'frontier'

export const MODEL_TIERS: readonly ModelTier[] = ['budget', 'mid', 'frontier'] as const

// Each tier resolves to both models an index run needs: text for document
// contexts and every folder/root synthesis, vision for image files.
export interface TierModels {
  textModel: string
  visionModel: string
}

export type ModelTierConfig = Record<ModelTier, TierModels>

// How much of a photo tree an index run reads. Orthogonal to ModelTier (which
// model looks) — granularity decides how many photos it looks at. Text
// documents are always indexed in full: sampling only ever drops photos,
// because photos are where a source's file count explodes into six figures.
export type IndexGranularity = 'low' | 'medium' | 'full'

export const INDEX_GRANULARITIES: readonly IndexGranularity[] = ['low', 'medium', 'full'] as const

export function normalizeIndexGranularity(value: unknown): IndexGranularity {
  return INDEX_GRANULARITIES.includes(value as IndexGranularity) ? (value as IndexGranularity) : 'full'
}

export interface AppSettings {
  provider: ProviderConfig
  theme: 'light' | 'dark' | 'system'
  // What the assistant is called. Flows into the identity system prompt,
  // transcript speaker labels inside generated contexts, and the UI chrome.
  assistantName: string
  // A PROJECT_ICON_REGISTRY key or a data: URL, exactly like Project.icon.
  // Empty means the bundled Holmes symbol.
  assistantIcon: string
  // Rotating greetings on the welcome screen. Empty means the bundled defaults.
  welcomeLines: string[]
  /**
   * The hand-drawn display face's frame-by-frame "boil". Off freezes it on one
   * frame — the lettering keeps its drawn character without the motion, which
   * is also what `prefers-reduced-motion` does on its own.
   */
  boilEffectEnabled: boolean
  defaultModel: string
  defaultEffort: ReasoningEffort
  modelTiers: ModelTierConfig
  defaultTier: ModelTier
  imageGenerationModel: string
  videoGenerationModel: string
  memoryAutoExtractionEnabled: boolean
  healthAnalysisEnabled: boolean
  healthLiveSyncEnabled: boolean
  fileAccessScope: FileAccessScope
  webSearchEnabled: boolean
  webSearchProvider: WebSearchProvider
  webSearchApiKey: string
  /** YouTube Data API v3 key. Without it the Play feed has nothing to retrieve. */
  youtubeApiKey: string
  /** Gates the AI analysis pass over activity events. */
  activityIngestEnabled: boolean
  /**
   * Gates background live sync and watched-folder scanning. Split from
   * `activityIngestEnabled` because that flag used to gate both, so turning off
   * AI analysis silently stopped every account from syncing.
   */
  activitySyncEnabled: boolean
  activityEmailAllowedAddress: string
  activityKnowledgePermissionPrompted: boolean
  activityWeatherEnabled: boolean
  activityLocationLatitude: number | null
  activityLocationLongitude: number | null
  activityAmazonCookiesStored: boolean
  documentContextEnabled: boolean
  /**
   * Gates ONLY the paid reading-record snapshot. Scanning, the shelf, the
   * reader and reading progress work with no provider configured at all.
   */
  librarySnapshotEnabled: boolean
  /**
   * Auto-file newly scanned books into `Author - Title` folders when a scan
   * finishes. Uses the same model-named plan as the Organise button but only
   * moves unambiguous entries, and each book is considered exactly once. Does
   * nothing without provider credentials.
   */
  libraryAutoOrganizeEnabled: boolean
  superContextMemoryEnabled: boolean
  timelineEnabled: boolean
  peopleEnabled: boolean
  /**
   * The master switch over every background tick. Set from the Call History
   * page, where the cost of the automated passes is visible, and deliberately
   * one flag rather than per-feature toggles: the point is to stop all of it at
   * once without losing the settings behind each feature. Chat, indexing the
   * user starts, and anything else they ask for still run.
   */
  automationPaused: boolean
  requestsPerMinute: number
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  description?: string
  free?: boolean
  supportedParameters?: string[]
  // Pricing is USD per token, straight from OpenRouter. Absent for custom
  // OpenAI-compatible endpoints, which report no pricing at all — every
  // consumer must treat these as optional and degrade to "cost unknown".
  promptPrice?: number
  completionPrice?: number
  imagePrice?: number
  contextLength?: number
  inputModalities?: string[]
}

export function modelAcceptsImages(model: ModelInfo): boolean {
  return Array.isArray(model.inputModalities) && model.inputModalities.includes('image')
}

export interface StreamChunk {
  text: string
  reasoning?: string
  done: boolean
  error?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  model?: string
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  /**
   * The turn's sources so far, resent whole on each tool round rather than as a
   * delta: the in-flight bubble has to resolve a `[S1]` the moment it streams in,
   * and a chunk the renderer missed must not leave a permanent hole.
   */
  sources?: CitedSource[]
}

export interface SystemPromptEntry {
  role: 'system'
  content: string
  label: string
  /**
   * Set when this block's text is a derived context node, so the prompt preview
   * can show what the model is being told from and follow it back to source
   * files. Absent for blocks written by hand or assembled from raw fields.
   */
  provenanceRef?: {
    ref: string
    projectId: string | null
    /**
     * Index in `content` where the traced context text begins, so recorded claim
     * offsets line up with the framing prose wrapped around it. Omitted when the
     * block carries a condensed or truncated version of the context — the spans
     * describe the full text and would land on the wrong words otherwise.
     */
    textOffset?: number
  }
}

export interface ProductSearchPriorities {
  price: number
  quality: number
  brand: number
  availability: number
}

export interface ProductSearchRequest {
  query: string
  priorities: ProductSearchPriorities
  budget?: {
    amount: number
    currency: string
  }
  market?: string
  notes?: string
  model: string
  reasoningEffort: ReasoningEffort
}

export type ProductAvailability =
  | 'in_stock'
  | 'limited'
  | 'preorder'
  | 'out_of_stock'
  | 'unknown'

export interface ProductRecommendation {
  rank: number
  name: string
  brand: string
  model: string | null
  priceDisplay: string
  priceAmount: number | null
  currency: string | null
  availability: ProductAvailability
  overallScore: number
  scoreBreakdown: ProductSearchPriorities
  bestFor: string
  rationale: string
  highlights: string[]
  tradeoffs: string[]
  sourceIds: string[]
}

export interface ProductSearchCitation {
  id: string
  title: string
  url: string
  domain: string
}

export interface ProductSearchResult {
  query: string
  summary: string
  methodology: string
  recommendations: ProductRecommendation[]
  buyingAdvice: string[]
  citations: ProductSearchCitation[]
  model: string
  webSearches?: number
  researchedAt: number
}

export type MemoryValueType = 'text' | 'multiline' | 'number' | 'boolean' | 'date' | 'list'
export type MemoryValue = string | number | boolean | string[]
export type MemoryOrigin = 'manual' | 'ai'
export type MemorySourceType =
  | 'manual'
  | 'conversation'
  | 'project-file'
  | 'recall-file'
  | 'psychology-analysis'
  | 'imessage-metadata'
  | 'os-account'
  | 'settings'
  | 'claude-import'
  | 'activity-events'
  | 'super-context'
  /** A thumbs-up in the Play feed. Provenance for a taste, not a body of evidence. */
  | 'play-reaction'

export interface MemorySource {
  type: MemorySourceType
  reference: string
  label: string
  capturedAt: number
}

export interface MemoryField {
  id: string
  fieldKey: string
  category: string
  label: string
  valueType: MemoryValueType
  value: MemoryValue | null
  origin: MemoryOrigin | null
  confidence: number | null
  locked: boolean
  sensitive: boolean
  custom: boolean
  sortOrder: number
  sources: MemorySource[]
  revision: number
  createdAt: number
  updatedAt: number
}

export interface MemorySuggestion {
  id: string
  fieldId: string
  fieldKey: string
  fieldLabel: string
  category: string
  value: MemoryValue
  confidence: number
  rationale: string
  sources: MemorySource[]
  baseRevision: number
  createdAt: number
  mergeStrategy: MemoryMergeStrategy
}

export interface MemoryCandidate {
  fieldKey: string
  value: MemoryValue
  confidence: number
  rationale: string
  sources: MemorySource[]
  mergeStrategy: MemoryMergeStrategy
}

export type MemoryMergeStrategy = 'replace' | 'merge' | 'supplement'

export interface MemoryUpdateRequest {
  fieldId: string
  value: MemoryValue | null
  locked: boolean
  expectedRevision: number
}

export interface MemoryCreateFieldRequest {
  category: string
  label: string
  valueType: MemoryValueType
  sensitive: boolean
}

export interface MemoryExtractionRequest {
  categories: string[]
  includeConversations: boolean
  includeProjects: boolean
  includeRecallFiles: boolean
  includeIMessages: boolean
  includeSettings: boolean
  includeSensitive: boolean
  confirmExternalProcessing: true
}

export interface MemoryExtractionResult {
  fields: MemoryField[]
  suggestions: MemorySuggestion[]
  autoFilled: number
  suggestionsCreated: number
  candidatesFound: number
  sourceCounts: Partial<Record<MemorySourceType, number>>
  contextTruncated: boolean
  model: string
}

export interface MemorySuggestionReviewRequest {
  suggestionId: string
  decision: 'accept' | 'reject'
  expectedRevision: number
  confirmOverwriteManual?: boolean
  applyAsMerge?: boolean
}

export interface ClaudeImportOptions {
  importConversations: boolean
  importProjects: boolean
  importMemories: boolean
  includeSensitive: boolean
  categories: string[]
  confirmExternalProcessing: true
}

export interface ClaudeImportProgress {
  phase: 'reading' | 'projects' | 'conversations' | 'memories' | 'finalizing'
  message: string
  current: number
  total: number
}

export interface ClaudeImportResult {
  projectsImported: number
  projectsSkipped: number
  conversationsImported: number
  conversationsSkipped: number
  messagesImported: number
  memoryAutoFilled: number
  memorySuggestionsCreated: number
  memoryCandidatesFound: number
  memoryModel: string | null
  memorySkipped: boolean
  memoryError: string | null
}

export interface BigFiveScores {
  openness: number
  conscientiousness: number
  extraversion: number
  agreeableness: number
  neuroticism: number
}

export interface PsychologyAnalysis {
  bigFive: BigFiveScores
  emotionalIntelligence: number
  cognitiveStyle: {
    label: string
    description: string
    score: number
  }
  wellBeing: number
  summary: string
}

export type HealthDomainKey =
  | 'cardiovascular'
  | 'metabolic'
  | 'endocrine'
  | 'dermatologic'
  | 'hair'
  | 'cognitive'
  | 'musculoskeletal'
  | 'mental'
  | 'sleep'
  | 'nutrition'
  | 'other'

export type HealthTrend = 'up' | 'down' | 'stable' | 'unknown'

export interface HealthDomainScore {
  domain: HealthDomainKey
  label: string
  score: number
  status: string
  trend?: HealthTrend
  notes: string
}

export interface HealthRegimenEntry {
  name: string
  dose?: string
  schedule?: string
  category?: 'medication' | 'supplement' | 'topical' | 'other'
  notes?: string
}

export type HealthInteractionSeverity = 'low' | 'medium' | 'high'

export interface HealthInteraction {
  description: string
  severity: HealthInteractionSeverity
  agents: string[]
}

export type HealthThreadPriority = 'low' | 'medium' | 'high'
export type HealthThreadStatus = 'open' | 'scheduled' | 'done'

export interface HealthThread {
  title: string
  detail: string
  priority: HealthThreadPriority
  status: HealthThreadStatus
  dueDate?: string
}

export type HealthLabStatus = 'pending' | 'ordered' | 'completed'

export interface HealthLabRecommendation {
  name: string
  rationale: string
  status: HealthLabStatus
}

export interface HealthRecentObservation {
  name: string
  value: string
  date: string
  flag?: 'low' | 'high' | 'normal' | 'abnormal'
}

export interface HealthAnalysis {
  generatedAt: string
  domainScores: HealthDomainScore[]
  regimen: {
    medications: HealthRegimenEntry[]
    supplements: HealthRegimenEntry[]
    notes?: string
  }
  interactions: HealthInteraction[]
  openThreads: HealthThread[]
  recommendedLabs: HealthLabRecommendation[]
  recentObservations: HealthRecentObservation[]
  timeline?: AnalysisTimelineEntry[]
  people?: AnalysisPersonEntry[]
  summary: string
}

export interface ActivityAnalysis {
  generatedAt: string
  topInterests: string[]
  mediaConsumption: Array<{ topic: string; hoursWeekly: number }>
  spendingPatterns: Array<{ category: string; monthlyCents: number }>
  communicationPatterns: Array<{ contact: string; frequency: string }>
  digitalBehavior: Array<{ app: string; hoursWeekly: number; mood?: string }>
  locationPatterns: Array<{ place: string; visitsMonthly: number }>
  weatherMoodCorrelations: string[]
  openThreads: string[]
  timeline?: AnalysisTimelineEntry[]
  people?: AnalysisPersonEntry[]
  summary: string
}

export interface FinancesSummary {
  generatedAt: string
  totalMonthlyCents: number
  activeSubscriptions: Array<{ provider: string; planName: string; amountCents: number; cadence: string }>
  recentChanges: string[]
  timeline?: AnalysisTimelineEntry[]
  summary: string
}

/** Where an in-flight activity analysis has got to. */
export interface ActivityAnalysisProgress {
  /** Calls completed. */
  current: number
  /** Calls the run will make in total, from the same plan the estimate priced. */
  total: number
  /** The source being read, e.g. "iMessage". */
  label: string
  /** Human line for the sidebar, e.g. "iMessage — part 3 of 11". */
  message: string
}

export interface ActivityRunState {
  status: 'idle' | 'running'
  origin: 'user' | 'timer' | null
  progress: ActivityAnalysisProgress | null
  message: string | null
  updatedAt: string
}

export interface ActivityAnalysisEstimateLine {
  label: string
  /** Events standing behind this call, after the per-source cap. */
  eventCount: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

/**
 * Pre-flight projection for one Activity analysis run, mirroring
 * `IndexEstimate`. `costUsd` is null when the provider reports no pricing,
 * which the UI must show as "unknown" rather than as free.
 */
export interface ActivityAnalysisEstimate {
  projectId: string
  tier: ModelTier
  textModel: string
  /** One line per source analysis, plus the final synthesis. */
  lines: ActivityAnalysisEstimateLine[]
  /** LLM calls the run will make. */
  callCount: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  estimatedSeconds: number
  pricingUnavailable: boolean
  /** Events considered across every source, before per-source caps. */
  totalEvents: number
  /**
   * True when the stored analysis is already current for this data, so running
   * again would spend the whole estimate to reproduce what exists.
   */
  upToDate: boolean
  /** Accounts with events that the per-run cap excluded. */
  skippedAccounts: string[]
}

export interface SourceAnalysis {
  sourceType: ActivitySourceType
  /**
   * Set when `sourceType` is `account`: which of the registry accounts this
   * analysis covers. The `account` bucket holds every provider's events at
   * once, so without this an Instagram analysis and a Tinder analysis would be
   * indistinguishable once stored.
   */
  provider?: ActivityProviderId
  analysis: string
  generatedAt: string
}

export interface ActivitySummary {
  projectId: string
  summary: ActivityAnalysis | null
  sourceAnalyses: SourceAnalysis[]
  fieldHash: string | null
  updatedAt: string
}

export type PsychologicalTestId =
  | 'mini_ipip_20'
  | 'gad_7'
  | 'phq_9'
  | 'rosenberg_self_esteem'
  | 'who_5'
  | 'pss_10'
  | 'pc_ptsd_5'
  | 'audit_c'
  | 'asrs_6'

export interface PsychologicalTestOption {
  value: number
  label: string
}

export interface PsychologicalTestQuestion {
  id: string
  prompt: string
  options?: PsychologicalTestOption[]
  scored?: boolean
  reverse?: boolean
  domain?: string
  condition?:
    | { kind: 'answer'; questionId: string; values: number[] }
    | { kind: 'any-answer'; questionIds: string[]; minimumValue: number }
}

export interface PsychologicalTestDefinition {
  id: PsychologicalTestId
  name: string
  shortName: string
  category: string
  description: string
  instructions: string
  estimatedMinutes: number
  options: PsychologicalTestOption[]
  questions: PsychologicalTestQuestion[]
  sourceUrl: string
  attribution: string
  disclaimer: string
  whatItMeasures: string
  limitations: string[]
  nextSteps: string[]
  contentNotice?: string
  license: {
    name: string
    url: string
  }
  safetyNotice?: {
    questionId: string
    minimumValue: number
    title: string
    message: string
  }
}

export interface PsychologicalTestScore {
  key: string
  label: string
  value: number
  maxValue: number
  interpretation?: string
}

export interface PsychologicalTestExplanation {
  headline: string
  whatItMeasures: string
  scoreMeaning: string
  limitations: string[]
  nextSteps: string[]
}

export interface PsychologicalTestResult {
  testId: PsychologicalTestId
  testName: string
  completedAt: number
  answers: number[]
  scores: PsychologicalTestScore[]
  summary: string
  explanation: PsychologicalTestExplanation
  safetyFlag: boolean
  filePath: string
}

// One indexable root directory on a project. A project may connect several.
// `Project.path` remains the FIRST source: subsystems that predate multi-source
// (Health, Activity, Psychology, memory evidence, psychological test files) still
// read it, and it is kept in sync rather than removed.
export interface ProjectSource {
  id: string
  projectId: string
  path: string
  sortOrder: number
  createdAt: number
}

export type ProjectContextScope = 'life' | 'separate'

/**
 * What every prompt in a project's index run is asked to produce.
 * - `behavioral` — the default: the material read as evidence about the person.
 * - `work` — the material read on its own merits: what it is, how it is built,
 *   what state it is in, what decisions and open threads it carries.
 * - `reference` — neutral description and organisation, no interpretation.
 */
export type IndexStyle = 'behavioral' | 'work' | 'reference'

export const INDEX_STYLES: readonly IndexStyle[] = ['behavioral', 'work', 'reference'] as const

/**
 * Saving a Work document. The target folder comes from the project selected in
 * the sidebar filter — the same selection that scopes the conversation list —
 * so a document lands with the material it belongs to and gets indexed with it.
 */
export interface WorkSaveRequest {
  /** The sidebar's active project, or null for General. */
  projectId: string | null
  fileName: string
  bytes: Uint8Array
  /** Set on re-save to overwrite in place instead of picking a new name. */
  existingPath?: string
  /**
   * How the save dialog was answered for a document shown in paper mode: 'keep'
   * writes the dark page and white text into the file, 'plain' puts the default
   * font back. Absent when nothing was shown differently from how it saves.
   */
  paper?: 'keep' | 'plain'
}

export interface WorkSaveResult {
  path: string
  bytes: number
  /** The project it was filed under, or null when it went somewhere chosen by hand. */
  projectId: string | null
  /** True when the user was asked where to put it (no project folder available). */
  chosenByUser: boolean
}

/** One instruction from the model to the open editor. */
export interface WorkEditorRequest {
  requestId: string
  action: string
  payload: Record<string, unknown>
}

export interface WorkEditorResponse {
  requestId: string
  ok: boolean
  value: unknown
}

export interface Project {
  id: string
  name: string
  icon: string
  color: string
  path: string | null
  /**
   * What the project structurally IS — see `ProjectKind`. A `library` project's
   * folders are scanned into the Library and never into document contexts.
   */
  kind: ProjectKind
  /** Hidden sources stay in the database but are skipped by indexing and offered nowhere. */
  visible: boolean
  /** Position in the hand-arranged Data page list. */
  sortOrder: number
  /**
   * `life` folds this project into the unified user super-context, memory and the
   * life timeline. `separate` keeps it to itself: it is context you select
   * deliberately, with its own timeline, and it never feeds the life picture.
   */
  contextScope: ProjectContextScope
  /** How its material is read — see `IndexStyle`. Chosen before indexing. */
  indexStyle: IndexStyle
  sources: ProjectSource[]
  files: string[]
  analysis: PsychologyAnalysis | null
  healthAnalysis: HealthAnalysis | null
  activityAnalysis: ActivityAnalysis | null
  financesSummary: FinancesSummary | null
  createdAt: number
  updatedAt: number
}

/** What a caller must supply to create a project — placement and visibility default. */
// `kind` is deliberately absent: a project the user creates is always
// `standard`. The library kind is provisioned by the seeder alone, so nothing
// reachable from the renderer can mint a source that skips document indexing.
export type ProjectInput = Omit<
  Project,
  'id' | 'createdAt' | 'updatedAt' | 'visible' | 'sortOrder' | 'contextScope' | 'indexStyle' | 'kind'
> & {
  visible?: boolean
  sortOrder?: number
  contextScope?: ProjectContextScope
  indexStyle?: IndexStyle
}

/** Cheap per-project index facts for the Data list: counts, not contexts. */
export interface ProjectIndexSummary {
  projectId: string
  fileCount: number
  folderCount: number
  sourceCount: number
  /**
   * True only when a run completed over every connected source and nothing has
   * changed the stored count since. The Data row reserves the accent dot for
   * this; a source that is merely part-indexed stays green.
   */
  fullyIndexed: boolean
  /** Connected directories that no longer exist or cannot be read. */
  missingSources: string[]
  indexedAt: string | null
}

export interface SearchResult {
  messageId: string
  conversationId: string
  content: string
  conversationTitle: string
}

export type RecallSearchSource = 'all' | 'files' | 'conversations' | 'contexts'

/** Which level of the generated-context hierarchy a Recall context result came from. */
export type RecallContextLevel = 'file' | 'folder' | 'sourceRoot' | 'project' | 'user' | 'conversation'

export interface RecallSearchRequest {
  query: string
  source: RecallSearchSource
  semantic: boolean
  limit?: number
}

export interface RecallSearchResult {
  id: string
  source: 'file' | 'conversation' | 'activity' | 'context'
  title: string
  context: string
  snippet: string
  score: number
  modifiedAt: number
  path?: string
  fileType?: string
  conversationId?: string
  messageId?: string
  role?: Message['role']
  /** Set on `context` results: where in the file → folder → project → user hierarchy this sits. */
  contextLevel?: RecallContextLevel
  /** The source a `context` result belongs to, where it belongs to one. */
  projectId?: string
}

export interface RecallAnswer {
  text: string
  sourceIds: string[]
  model: string
}

export interface RecallSearchResponse {
  query: string
  results: RecallSearchResult[]
  answer: RecallAnswer | null
  resultCounts: {
    files: number
    conversations: number
    activity: number
    contexts: number
  }
  expandedQueries: string[]
  semanticApplied: boolean
  fileSearchAvailable: boolean
  notices: string[]
  durationMs: number
}

/**
 * One source the stored answer cited, kept so a past answer stays inspectable
 * and its files stay openable after the live search state is gone.
 */
export interface RecallHistorySource {
  resultId: string
  title: string
  context: string
  path?: string
  conversationId?: string
}

/**
 * A completed Recall search, as kept for the history list.
 *
 * The ranked result list is deliberately not stored: it is search state that
 * goes stale as files change, and re-running the query rebuilds it. What is
 * worth keeping is the question, the answer, and what the answer was based on.
 */
export interface RecallHistoryEntry {
  id: string
  createdAt: number
  query: string
  source: RecallSearchSource
  semantic: boolean
  answer: string | null
  answerModel: string | null
  sources: RecallHistorySource[]
  resultCount: number
  expandedQueries: string[]
  notices: string[]
  durationMs: number
}

export interface FsListItem {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  size: number
  modifiedAt: number
}

export interface FsReadResult {
  path: string
  content: string
  bytes: number
  truncated: boolean
  encoding: 'utf8' | 'base64'
}

export interface FsWriteRequest {
  path: string
  content: string
  encoding?: 'utf8' | 'base64'
  overwrite?: boolean
  createParentDirs?: boolean
}

export interface FsWriteResult {
  path: string
  bytes: number
  created: boolean
}

export type HealthSourceType = 'apple_health' | 'mychart' | 'bloodwork' | 'other'

export interface HealthRecord {
  id: string
  projectId: string
  sourceType: HealthSourceType
  filename: string
  fileSize: number
  contentHash: string | null
  /** Absolute path this was ingested from. Null on records predating folder-based ingestion. */
  sourcePath: string | null
  /**
   * Cheap identity for the file on disk (path + size + mtime), so a rescan can
   * recognize what it has already ingested without re-reading it. Stat-based
   * rather than a content hash because a health export can be hundreds of MB.
   */
  identityHash: string | null
  importedAt: number
  status: 'pending' | 'parsed' | 'failed'
  parseError: string | null
  observationsCount: number
}

export type HealthObservationType =
  | 'lab'
  | 'vital'
  | 'workout'
  | 'medication'
  | 'observation'
  | 'condition'

export interface HealthObservation {
  id: string
  recordId: string
  type: HealthObservationType
  code: string | null
  displayName: string
  valueReal: number | null
  valueText: string | null
  unit: string | null
  refLow: number | null
  refHigh: number | null
  effectiveDate: string | null
  sourceMeta: Record<string, unknown>
  createdAt: number
}

export interface HealthSummary {
  projectId: string
  summary: string
  fieldHash: string
  updatedAt: number
}

export interface HealthIngestProgress {
  phase: 'reading' | 'parsing' | 'extracting' | 'storing' | 'complete' | 'error'
  message: string
  current: number
  total: number
  recordId?: string
}

export type HealthLiveAuthorization = 'authorized' | 'denied' | 'notDetermined' | 'unavailable'

export interface HealthLiveStatus {
  available: boolean
  authorized: HealthLiveAuthorization
  sidecarPath: string | null
  lastSyncAt: number | null
}

export type HealthLiveSyncPhase = 'querying' | 'storing' | 'summarizing' | 'complete' | 'error'

export interface HealthLiveSyncProgress {
  phase: HealthLiveSyncPhase
  message: string
  typesQueried: string[]
  observationsInserted: number
}

export interface HealthKitObservationInput {
  type: HealthObservationType
  code: string
  displayName: string
  valueReal?: number | null
  valueText?: string | null
  unit?: string | null
  refLow?: number | null
  refHigh?: number | null
  effectiveDate?: string | null
  sourceMeta?: {
    source?: string
    device?: string | null
    sourceName?: string | null
  } | Record<string, unknown>
}

export interface HealthKitQueryResult {
  observations: HealthKitObservationInput[]
  queryDate: string
  typesQueried: string[]
  error?: string
}

export interface HealthSyncResult {
  recordId: string
  observationsInserted: number
  observationsSkipped: number
  error?: string
}

export interface DirectoryScanResult {
  scanned: number
  ingested: number
  /** Files that errored during ingestion. Not the same as unchanged files. */
  skipped: number
  errors: string[]
  /** Files a previous scan already ingested, so this pass did no work for them. */
  unchanged?: number
}

export type DocumentFileKind = 'text' | 'image'

// --- Provenance --------------------------------------------------------------
// Every derived context node records the exact inputs it was synthesized from,
// so any summary can be walked back down to the ground-truth files on disk. The
// edges are recorded at synthesis time rather than re-derived from the current
// file tree: files get added, deleted and dropped by input budgets, and a chain
// reconstructed later would describe a tree that no longer produced this text.

// `book` is a LEAF that terminates the chain: a shelf entry is the ground
// truth for the reading record, and there is deliberately no stored text under
// it to walk into.
export type ProvenanceSourceKind = 'file' | 'folder' | 'project-root' | 'memory' | 'conversation' | 'book'

export interface ProvenanceEdge {
  kind: ProvenanceSourceKind
  /** Absolute path for file/folder; `project:<id>` for a project root; `memory:profile` for the stored memory profile. */
  ref: string
  label: string
  /** The child's content-hash (file) or child-hash (folder) at the moment this node was synthesized. */
  hash: string
  /** False when the input char budget dropped this child from the prompt. */
  included: boolean
}

/**
 * A span of a synthesis and the direct sources the model attributed it to.
 * Offsets index the STORED context text — citation markers are stripped before
 * storage so nothing downstream (chat context, memory extraction, timeline
 * harvesting) ever sees them.
 */
export interface ProvenanceClaim {
  start: number
  end: number
  sourceRefs: string[]
  /**
   * 1-based, inclusive line range in the source document. Present only on
   * file-level claims, the one level whose model actually reads source text —
   * a folder synthesis reads child summaries and has never seen a source line.
   * Validated against the file as it was read, so a range here always exists.
   */
  sourceLines?: { start: number; end: number }
}

/** A verbatim slice of a source file, read at display time — never model-generated. */
export interface SourceExcerpt {
  filePath: string
  /** Absent for an image source, where `imageDataUrl` carries the evidence instead. */
  lines?: Array<{ number: number; text: string; cited: boolean }>
  imageDataUrl?: string
  totalLines: number
  /** Set when the file is gone, unreadable, or outside the configured file-access scope. */
  unavailable?: string
}

export interface ContextProvenance {
  /** Prompt version of the pass that produced this node — a chain built under an older prompt is visibly stale. */
  promptVersion: string
  model: string
  generatedAt: string
  /** Direct inputs only. Recursively resolvable down to leaf files. */
  sources: ProvenanceEdge[]
  /** Direct children that existed but exceeded the per-node record cap, so are not listed in `sources`. */
  unrecordedCount: number
  /** Direct children present in the tree but dropped from the prompt by the input char budget. */
  omittedCount: number
  /** Ground-truth files beneath this node; 1 for a leaf. */
  leafCount: number
  /** Characters actually fed to the model, and whether the source had to be cut to fit. */
  inputChars: number
  truncated: boolean
  /**
   * Per-claim attribution, present only on syntheses generated by a prompt that
   * asked for citations. Absent (not empty) when the node predates that, which
   * the UI must show as "not recorded" rather than "nothing cited".
   */
  claims?: ProvenanceClaim[]
}

export interface DocumentFileContext {
  filePath: string
  relativePath: string
  context: string
  contentHash: string
  kind: DocumentFileKind
  provenance: ContextProvenance | null
  updatedAt: string
}

export interface DocumentFolderContext {
  folderPath: string
  relativePath: string
  contextShort: string
  context: string
  fileCount: number
  provenance: ContextProvenance | null
  updatedAt: string
}

/** One node of a resolved provenance walk, ordered breadth-first from the node asked about. */
export interface ProvenanceChainNode {
  /** `user` is the apex node only — it is never an edge, since nothing is built from it. */
  kind: ProvenanceSourceKind | 'user'
  ref: string
  label: string
  /** 0 for the node the walk started at. */
  depth: number
  projectId: string | null
  included: boolean
  contextShort: string
  provenance: ContextProvenance | null
}

export interface ProvenanceChain {
  ref: string
  found: boolean
  nodes: ProvenanceChainNode[]
  /** Ground-truth file paths reached by the walk. */
  leafFiles: string[]
  /** True when the walk hit its node cap and the chain shown is partial. */
  truncated: boolean
}

export interface DocumentSourceSummary {
  path: string
  rootContextShort: string | null
  rootContext: string | null
  fileCount: number
  folderCount: number
}

/** A conversation held about a project, summarized as one of its sources. */
export interface ConversationContext {
  conversationId: string
  title: string
  contextShort: string
  context: string
  provenance: ContextProvenance | null
  updatedAt: string
}

export interface DocumentContextTree {
  projectId: string
  rootPath: string | null
  sources: DocumentSourceSummary[]
  rootContextShort: string | null
  rootContext: string | null
  files: DocumentFileContext[]
  folders: DocumentFolderContext[]
  conversations: ConversationContext[]
  fileCount: number
  folderCount: number
  updatedAt: string | null
}

export interface UserSuperContext {
  contextShort: string
  context: string
  projectCount: number
  provenance: ContextProvenance | null
  updatedAt: string | null
}

export interface DocumentContextProgress {
  phase: 'scanning' | 'file' | 'folder' | 'complete'
  message: string
  current: number | null
  total: number | null
  batchLabel?: string
}

export type DocumentIndexScope = 'project' | 'all' | 'user'

export type DocumentIndexStatus = 'idle' | 'running' | 'stopping' | 'paused'

export type DocumentIndexOutcome = 'completed' | 'paused' | 'stopped' | 'failed'

export interface DocumentIndexPauseRecord {
  scope: DocumentIndexScope
  projectId: string | null
  projectName: string | null
  message: string
  pausedAt: string
}

export interface DocumentIndexState {
  status: DocumentIndexStatus
  scope: DocumentIndexScope | null
  projectId: string | null
  projectName: string | null
  pendingAction: 'pause' | 'stop' | null
  origin: 'user' | 'timer' | null
  progress: DocumentContextProgress | null
  message: string | null
  canResume: boolean
  updatedAt: string
}

export interface DocumentIndexAllResult {
  projectsIndexed: number
  projectsSkipped: number
  outcome?: DocumentIndexOutcome
}

export interface DocumentContextResult {
  filesProcessed: number
  filesGenerated: number
  filesCached: number
  /**
   * Photos the run's granularity sampled out — counted so "Indexed N items"
   * can never silently include photos the model was told not to look at.
   */
  filesSampledOut?: number
  foldersProcessed: number
  foldersGenerated: number
  rootContextShort: string | null
  rootContext: string | null
  outcome?: DocumentIndexOutcome
  spent?: IndexSpend
  /**
   * At least one connected source directory could not be read (disconnected
   * drive, permission denied). Its cached contexts were left untouched rather
   * than pruned, so the run is incomplete rather than authoritative.
   */
  sourceUnavailable?: boolean
}

/**
 * One stored context node to re-synthesize in place: a folder super-context
 * (including a source root), or the project-level combined synthesis. The
 * regen reads the child contexts already in the database — no file is
 * re-read, no descendant or ancestor is touched.
 */
export type RegenerateContextTarget =
  | { kind: 'folder'; folderPath: string }
  | { kind: 'project' }

export interface RegenerateContextResult {
  kind: 'folder' | 'project'
  /** The node that was regenerated: its folder path, or `project:<id>` for the combined synthesis. */
  ref: string
  contextShort: string | null
  context: string | null
  spent?: IndexSpend
}

// What an index run has actually consumed so far, accumulated from each
// response's `usage` envelope. Priced with the same table as the estimate so
// the two are directly comparable.
export interface IndexSpend {
  inputTokens: number
  outputTokens: number
  costUsd: number
  callsMade: number
}

export interface IndexEstimateLine {
  label: string
  fileCount: number
  callCount: number
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

// Pre-flight projection for one index run. `costUsd` is null when the provider
// reports no pricing (custom endpoints), which the UI must show as "unknown"
// rather than as free.
export interface IndexEstimate {
  projectId: string | null
  projectName: string | null
  tier: ModelTier
  granularity: IndexGranularity
  textModel: string
  visionModel: string
  textFiles: number
  imageFiles: number
  skippedFiles: number
  // Photos the selected granularity samples out: never scanned by the model,
  // never billed. Distinct from cachedFiles (already summarized, also free).
  sampledOutFiles: number
  cachedFiles: number
  folders: number
  lines: IndexEstimateLine[]
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  estimatedSeconds: number
  visionModelMissing: boolean
  visionModelUnsupported: boolean
  pricingUnavailable: boolean
  truncatedAtCap: boolean
  scannedFiles: number
}

export type TimelinePrecision = 'day' | 'month' | 'year'

export type ContextVersionSourceType =
  | 'document-file'
  | 'document-folder'
  | 'conversation'
  | 'user-super-context'
  | 'memory-summary'
  | 'health-analysis'
  | 'activity-analysis'
  | 'finances-summary'
  | 'timeline-year'
  | 'person-dossier'
  | 'person-year'
  | 'session-note'

// A generated context as it stood before it was replaced. Regeneration archives
// the outgoing version rather than discarding it.
export interface ContextVersion {
  id: string
  sourceType: ContextVersionSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  projectName: string | null
  version: number
  contentHash: string
  contextShort: string
  context: string
  provenance: ContextProvenance | null
  generatedAt: string
  supersededAt: string | null
}

export interface ContextVersionSummary {
  id: string
  sourceType: ContextVersionSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  projectName: string | null
  version: number
  contextShort: string
  charCount: number
  generatedAt: string
  supersededAt: string | null
}

export interface ContextVersionFilter {
  sourceTypes?: ContextVersionSourceType[]
  sourceRef?: string
  projectIds?: string[]
  limit?: number
}

/**
 * One outbound HTTP call to the connected provider, as it was actually sent.
 *
 * Every subsystem that talks to the provider is recorded here — chat, the
 * document/photo indexers, Timeline, People, Memory, Health, the title
 * generator, even the model listing — because the record is taken in the fetch
 * layer rather than at each call site.
 */
export interface ProviderCallSummary {
  id: string
  createdAt: number
  /**
   * What asked for the call: the IPC channel it was made under
   * ("timeline:rebuild") or the background timer ("timer:document-index").
   * Null when a call happens outside both, e.g. during startup.
   */
  feature: string | null
  provider: CalledService
  /** Path below the provider base URL, e.g. `/chat/completions`. */
  endpoint: string
  model: string | null
  streamed: boolean
  /** HTTP status, or null when the request never got a response. */
  status: number | null
  ok: boolean
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  /**
   * Characters sent, for services billed per character rather than per token.
   * Null for LLM calls, where tokens are the unit that means something.
   */
  charCount: number | null
  costUsd: number | null
  /**
   * `provider` when the endpoint reported the charge itself (OpenRouter does),
   * `estimated` when it was priced from the model list, null when unknown.
   */
  costSource: ProviderCallCostSource | null
  requestChars: number
  responseChars: number
  error: string | null
}

export type ProviderCallCostSource = 'provider' | 'estimated'

/**
 * Which service a logged call went to. Wider than `ProviderType` because speech
 * is a second paid endpoint with its own billing unit, and the history has to be
 * able to say which one it is looking at.
 */
export type CalledService = ProviderType | SpeechProviderId

export interface ProviderCall extends ProviderCallSummary {
  url: string
  /** The request body verbatim, as JSON text. Truncated past the storage cap. */
  request: string
  requestTruncated: boolean
  /**
   * The assistant text the call produced, reassembled from SSE deltas for a
   * streamed call. Falls back to the raw response body when there is no message
   * to extract (an error payload, or a non-chat endpoint).
   */
  response: string
  responseTruncated: boolean
}

export interface ProviderCallFilter {
  limit?: number
  offset?: number
  /** Substring match over model, feature, endpoint, and both bodies. */
  search?: string
  /** Hide `/models` and other bookkeeping calls that cost nothing. */
  completionsOnly?: boolean
  failedOnly?: boolean
}

export interface ProviderCallStats {
  calls: number
  /** Calls whose cost is known; the rest are missing from `costUsd`. */
  pricedCalls: number
  failedCalls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  firstCallAt: number | null
  lastCallAt: number | null
}

export type TimelineCategory =
  | 'milestone'
  | 'health'
  | 'training'
  | 'work'
  | 'education'
  | 'finance'
  | 'travel'
  | 'relationships'
  | 'media'
  | 'technology'
  | 'home'
  | 'life'
  | 'other'
  // Not offered to the models: reserved for the record of the record — when a
  // context was generated or replaced.
  | 'record'

export type TimelineSourceType =
  | 'document'
  | 'folder'
  | 'project'
  | 'conversation'
  | 'user-context'
  | 'health'
  | 'activity'
  | 'finances'
  | 'memory'
  | 'manual'
  | 'context-version'
  | 'session-note'

// One dated line parsed out of a generated context's TIMELINE block.
export interface ParsedTimelineEntry {
  startDate: string
  endDate: string | null
  precision: TimelinePrecision
  category: TimelineCategory
  title: string
  detail: string
}

export interface TimelineEvent {
  id: string
  sourceType: TimelineSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  projectName: string | null
  category: TimelineCategory
  title: string
  detail: string
  startDate: string
  endDate: string | null
  precision: TimelinePrecision
  confidence: number | null
  // Set when a rebuild no longer finds this event in any current context: the
  // event is kept as history rather than deleted.
  archivedAt: string | null
  lastSeenAt: string | null
  contextVersionId: string | null
  createdAt: string
  updatedAt: string
}

export interface TimelineEventInput {
  sourceType: TimelineSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  category: TimelineCategory
  title: string
  detail: string
  startDate: string
  endDate: string | null
  precision: TimelinePrecision
  confidence: number | null
}

export interface TimelineEra {
  label: string
  startDate: string
  endDate: string | null
  summary: string
}

/**
 * The home screen's "Ideas" prompts — opening lines generated from the user's
 * own profile, paged three at a time.
 */
export interface HomeIdeasResult {
  ideas: string[]
  updatedAt: number
  /** False when these are the built-in starters rather than profile-grounded. */
  personalized: boolean
  /** True when a refresh would produce a new set. */
  stale: boolean
}

// The Play feed — curated media picked against the user's own record.
//
// The pipeline is plan -> retrieve -> curate: a model turns the profile into
// search intents, real retrieval answers them, and a second model ranks what
// came back and says why each pick suits this person. Retrieval is real so the
// links work; the ranking is the profile, which is the part a public
// recommender structurally cannot copy.
//
// V1 retrieves `video` only. The rest of the union is here because the schema,
// the dispatch table and the card layout are all keyed by it, and adding a kind
// later should be a new retriever rather than a migration.
export type PlayItemKind = 'video' | 'article' | 'podcast' | 'book' | 'audiobook'
export const PLAY_ITEM_KINDS: readonly PlayItemKind[] = [
  'video',
  'article',
  'podcast',
  'book',
  'audiobook',
]

/** Which retriever produced a candidate. V1 dispatches only `youtube`. */
export type PlayRetrieverId = 'youtube' | 'tavily' | 'openrouter-web' | 'library'

export type PlayReaction = 'up' | 'down'

/**
 * Why a refresh produced what it did. Every non-`ok` value is a state the page
 * explains rather than an error it swallows: a Refresh the user pressed that
 * silently returns the same twelve cards reads as broken.
 */
export type PlayFeedStatus = 'ok' | 'no-api-key' | 'no-profile' | 'no-credentials' | 'quota' | 'error'

/**
 * Where a pick came from in the user's own record. `drillable` marks the refs
 * that `resolveProvenanceChain` understands, so the chip can open the existing
 * provenance explorer; the rest are terminal and show their `detail` alone.
 */
export type PlaySourceRefKind =
  | 'super-context'
  | 'memory-field'
  | 'timeline'
  | 'person'
  | 'watch-history'
  | 'book'
  | 'project'
  | 'reaction'

export interface PlaySourceRef {
  /** Drillable refs use the vocabulary `resolveProvenanceChain` already resolves. */
  ref: string
  kind: PlaySourceRefKind
  label: string
  /** The exact fact, quoted from the profile. This is what the card shows. */
  detail: string
  drillable: boolean
}

/**
 * One search intent: the literal string handed to a retriever, plus the facts
 * that motivated it. The planner emits these rather than recommendations —
 * it has no way to know what actually exists.
 */
export interface PlayIntent {
  /** `i1`..`iN`, stable within one feed. The curator cites these and nothing else. */
  id: string
  kind: PlayItemKind
  query: string
  rationale: string
  sourceRefs: PlaySourceRef[]
  /** Retriever hints. A retriever that does not understand one ignores it. */
  filters?: {
    publishedAfter?: string
    minMinutes?: number
    maxMinutes?: number
    channelHint?: string
    language?: string
  }
}

export interface PlayItem {
  id: string
  kind: PlayItemKind
  provider: PlayRetrieverId
  externalId: string
  url: string
  title: string
  creator: string | null
  description: string | null
  publishedAt: string | null
  durationSeconds: number | null
  thumbnailUrl: string | null
  /** `holmes-media://thumb/<id>` once cached; null while uncached or on failure. */
  thumbnailMediaId: string | null
  /** False for an item the platform refuses to embed — the card links out instead. */
  embeddable: boolean
  rationale: string
  intentIds: string[]
  /**
   * The deduped union of the cited intents' refs. Computed from `intentIds`,
   * never authored by a model: a ref the code did not build cannot be verified.
   */
  sourceRefs: PlaySourceRef[]
  rank: number
  /**
   * Which refresh produced this pick. A refresh adds a batch above the last one
   * rather than replacing it, so the page groups by this, newest first.
   */
  batch: number
  /** When that batch was built — the heading above the group. */
  batchAt: number
  reaction: PlayReaction | null
  reactedAt: number | null
  shownAt: number
  /** Null until the transcript pass has run for this item. */
  analysis: PlayAnalysis | null
  /** Resume point and how much has been seen — see PlayWatchState. */
  watch: PlayWatchState | null
  archive: PlayArchive | null
}

/**
 * Playback position, keyed by the video rather than the feed row so it survives
 * the item dropping out of the feed and being suggested again months later.
 *
 * `furthestSeconds` is monotonic, exactly as `book_reading_state` does it:
 * scrubbing back to rewatch a section must not undo the progress bar.
 */
export interface PlayWatchState {
  positionSeconds: number
  furthestSeconds: number
  durationSeconds: number | null
  completedAt: number | null
  updatedAt: number
}

export interface PlayArchive {
  status: PlayArchiveStatus
  filePath: string | null
  byteSize: number
  archivedAt: number | null
  error: string | null
}

/**
 * What kind of problem a flag is. Kept narrow and concrete: a taxonomy with
 * twenty entries produces twenty flags per video, and a feed that flags
 * everything says nothing.
 */
export type PlayFlagKind =
  | 'unsupported'
  | 'false'
  | 'misleading'
  | 'bias'
  | 'omission'
  | 'outdated'
  | 'speculation'

export type PlayFlagSeverity = 'low' | 'medium' | 'high'

/** One timestamped problem found in a video's transcript. */
export interface PlayFlag {
  id: string
  kind: PlayFlagKind
  severity: PlayFlagSeverity
  /** Seconds into the video, snapped to the transcript cue that carries it. */
  startSeconds: number
  /** The claim as made, quoted from the transcript so it can be checked. */
  quote: string
  /** What is wrong with it, in one or two sentences. */
  note: string
}

export type PlayAnalysisStatus =
  | 'pending'
  | 'ok'
  | 'no-transcript'
  | 'unavailable'
  | 'failed'

export interface PlayAnalysis {
  status: PlayAnalysisStatus
  /** A one-line characterisation of how the video handles its subject. */
  summary: string
  flags: PlayFlag[]
  /** Transcript language actually used, so a translated track is never silent. */
  language: string | null
  analyzedAt: number
  error: string | null
}

/**
 * Where a build has got to. The refresh is a multi-minute job — two model calls
 * around real retrieval, then a transcript download and an analysis call for
 * every pick — so it reports like the indexing passes do rather than spinning a
 * button for four minutes.
 */
export type PlayRunPhase = 'planning' | 'retrieving' | 'curating' | 'transcribing' | 'analysing'

export interface PlayRunProgress {
  phase: PlayRunPhase
  /** Position within a per-item phase; both 0 for the whole-step phases. */
  completed: number
  total: number
  /** What is being worked on right now — a query, or a video title. */
  detail: string
}

export type PlayArchiveStatus = 'queued' | 'downloading' | 'done' | 'failed'

export interface PlayArchiveProgress {
  itemId: string
  title: string
  status: PlayArchiveStatus
  /** 0-1, or null while yt-dlp has not reported a percentage yet. */
  fraction: number | null
  detail: string
  error: string | null
}

export interface PlayRunState {
  status: 'idle' | 'building'
  origin: 'user' | null
  progress: PlayRunProgress | null
  message: string | null
  /**
   * Downloads run alongside a build rather than queueing behind it: archiving is
   * the user's own decision about one video and must not wait on a feed refresh.
   */
  archives: PlayArchiveProgress[]
  updatedAt: string
}

export interface PlayFeed {
  items: PlayItem[]
  intents: PlayIntent[]
  generatedAt: number
  /** False before anything has been generated against a real profile. */
  personalized: boolean
  /** True when a refresh would produce a different set. */
  stale: boolean
  status: PlayFeedStatus
  lastError: string | null
  provenance: ContextProvenance | null
  /** The YouTube quota ledger, so a bounded daily spend is visible rather than mysterious. */
  searchUnitsUsedToday: number
  searchUnitBudget: number
}

export interface TimelineSummary {
  narrative: string
  eras: TimelineEra[]
  eventCount: number
  updatedAt: string | null
}

/**
 * One calendar year of the dated record, compressed into prose.
 *
 * The whole life record is far larger than any chat context can hold — 5,000+
 * events against a budget that fits ~60 lines — so the chat block carries one of
 * these per year instead of an arbitrary prefix of the raw events. Every year
 * that has events gets one, which is what makes the block span the whole life
 * rather than stopping wherever the character budget ran out.
 *
 * A year thin enough to fit verbatim is not sent to a model at all: `synthesized`
 * is false and `context` holds its actual event lines, which is both cheaper and
 * more faithful than a summary of four facts.
 */
export interface TimelineYearContext {
  year: number
  contextShort: string
  context: string
  eventCount: number
  synthesized: boolean
  updatedAt: string
}

/**
 * The in-flight timeline rebuild, broadcast to every window so the sidebar can
 * show a background rebuild it did not start.
 */
export interface TimelineRunState {
  status: 'idle' | 'running'
  origin: 'user' | 'timer' | null
  progress: TimelineRebuildProgress | null
  message: string | null
  updatedAt: string
}

export interface TimelineYearsView {
  years: TimelineYearContext[]
  /**
   * From the Memory profile. Years before it hold real record — an inherited
   * book's publication date, family papers — but they are not years of this
   * person's life, so the UI folds them away rather than opening the timeline
   * decades before they existed. Null when Memory has no birth date, and then
   * every year is shown rather than guessed at.
   */
  birthYear: number | null
}

export interface TimelineFilter {
  includeArchived?: boolean
  categories?: TimelineCategory[]
  sourceTypes?: TimelineSourceType[]
  projectIds?: string[]
  /** Used by the life scope to leave separate-context projects out of it. */
  excludeProjectIds?: string[]
  search?: string
  from?: string
  to?: string
  limit?: number
}

export interface TimelineRebuildProgress {
  phase: 'harvest' | 'merge' | 'narrative' | 'complete'
  message: string
  current: number | null
  total: number | null
}

export interface TimelineRebuildResult {
  sourcesScanned: number
  entriesHarvested: number
  eventsStored: number
  eventsUpdated: number
  eventsArchived: number
  duplicatesMerged: number
  manualPreserved: number
  contextVersionsSeen: number
  narrativeGenerated: boolean
  summary: TimelineSummary | null
  /** Years whose super-context was (re)generated this pass; unchanged years cost nothing. */
  yearsGenerated: number
  /** Years covered by a year super-context after this pass, synthesized or verbatim. */
  yearsCovered: number
  /**
   * Years whose synthesis failed. Reported rather than swallowed: a rebuild where
   * every model call failed otherwise looks identical to one with nothing to do.
   */
  yearsFailed: number
  /** The first failure's message, so the UI can say what actually went wrong. */
  yearsError: string | null
}

// The timeline slice a JSON analysis (health, activity, finances) carries.
export interface AnalysisTimelineEntry {
  date: string
  endDate?: string
  precision?: TimelinePrecision
  category?: string
  title: string
  detail?: string
}

/**
 * How a person stands to the user. A closed vocabulary, so a mention's relation
 * cell can be recognized by exact match rather than by shape — which is what
 * lets the parser tell the role "mother" from the relation `family`.
 *
 * Two values earn their place against specific failure modes seen in the real
 * corpus: `public` buckets the hundreds of authors a document folder names, who
 * would otherwise flood `unknown` and drown the significance threshold; and
 * `self` is the explicit bucket for the archive's owner, without which the user
 * becomes the highest-scoring person in their own life and gets a dossier
 * written about themselves.
 */
export type PersonRelation =
  | 'family'
  | 'partner'
  | 'friend'
  | 'colleague'
  | 'client'
  | 'professional'
  | 'community'
  | 'acquaintance'
  | 'public'
  | 'self'
  | 'unknown'

export type PersonSourceType =
  | 'document'
  | 'folder'
  | 'project'
  | 'conversation'
  | 'user-context'
  | 'health'
  | 'activity'
  | 'finances'
  | 'memory'
  | 'contacts'
  | 'messaging'
  | 'relationship-analysis'
  | 'manual'

/**
 * `ambiguous` is a resolution outcome, not an error: a bare "Sarah" with two
 * candidate Sarahs and no way to tell which was meant. Such a person is kept,
 * kept apart, and kept out of dossiers and chat — see the under-merge bias in
 * `peopleResolve.ts`.
 */
export type PersonStatus = 'unverified' | 'confirmed' | 'ambiguous' | 'ignored'

export type PersonSeedSource = 'contacts' | 'messaging' | 'memory'

export type PersonAliasKind = 'name' | 'email' | 'phone' | 'handle'

export type PersonAliasOrigin = 'seed' | 'derived' | 'manual'

/** A user correction, re-applied on every rebuild so it can never be undone by one. */
export type PersonOverrideKind = 'pin' | 'merge' | 'ignore' | 'relation'

// One line parsed out of a generated context's PEOPLE block.
export interface ParsedPersonEntry {
  name: string
  relation: PersonRelation
  role: string
  /** Other names/handles this source showed for the same person. The co-reference bridge. */
  aka: string[]
  evidence: string
}

// The people slice a JSON analysis (health, activity, finances) carries.
export interface AnalysisPersonEntry {
  name: string
  relation?: string
  role?: string
  aka?: string[]
  evidence?: string
}

export interface Person {
  id: string
  /** Stable identity: `contact:<pk>` | `handle:<h>` | `name:<key>` | `bare:<token>`. */
  personKey: string
  displayName: string
  relation: PersonRelation
  role: string
  status: PersonStatus
  /** An `identify()` pseudonym: real statistics, no name, never given a dossier. */
  isPseudonym: boolean
  isSelf: boolean
  seedSource: PersonSeedSource | null
  mentionCount: number
  /** Distinct context nodes naming this person — the significance signal. */
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
  dossierShort: string
  dossier: string
  dossierHash: string | null
  dossierUpdatedAt: string | null
  /** Set when a rebuild no longer finds this person: kept as history, never deleted. */
  archivedAt: string | null
  aliases: PersonAlias[]
  createdAt: string
  updatedAt: string
}

export interface PersonAlias {
  id: string
  personId: string
  alias: string
  aliasKey: string
  kind: PersonAliasKind
  origin: PersonAliasOrigin
  createdAt: string
}

export interface PersonMention {
  id: string
  personId: string | null
  mentionKey: string
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
  projectName: string | null
  confidence: number
  /** Which cascade rule attached this mention (R0..R7) — how a bad merge gets diagnosed. */
  resolutionRule: string
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

/** Per-platform interaction volume, so a dossier can say where a relationship lives. */
export interface PersonPlatform {
  provider: string
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
}

/**
 * One year of a person's message history, compressed into prose.
 *
 * The reason this layer exists: the largest single thread here is ~29,000
 * messages against a 30,000-character dossier budget, so the messages cannot be
 * read directly. Compressing per year first is the same file -> folder -> root
 * move the document index makes, and it is what lets a dossier describe how a
 * relationship changed rather than only how large it is.
 */
export interface PersonYearContext {
  personKey: string
  year: number
  context: string
  messageCount: number
  /** How many of that year's messages actually reached the model. */
  sampledCount: number
  updatedAt: string
}

export interface PersonMentionInput {
  rawName: string
  relation: PersonRelation
  role: string
  aka: string[]
  evidence: string
  sourceType: PersonSourceType
  sourceRef: string
  sourceLabel: string
  projectId: string | null
  confidence: number
}

/** Deterministic per-person statistics, straight from `account_events`. No model involved. */
export interface PersonSeed {
  personKey: string
  displayName: string
  seedSource: PersonSeedSource
  relation: PersonRelation
  role: string
  aliases: Array<{ alias: string; kind: PersonAliasKind }>
  platforms: PersonPlatform[]
  isPseudonym: boolean
  messageCount: number
  sentCount: number
  daysActive: number
  firstSeen: string | null
  lastSeen: string | null
  confidence: number
}

export interface PersonOverride {
  id: string
  kind: PersonOverrideKind
  subject: string
  target: string | null
  createdAt: string
}

export interface PeopleSummary {
  narrative: string
  personCount: number
  updatedAt: string | null
}

export interface PeopleFilter {
  includeIgnored?: boolean
  includeArchived?: boolean
  includePseudonyms?: boolean
  relations?: PersonRelation[]
  minScore?: number
  projectIds?: string[]
  /** Used by the life scope to leave separate-context projects out of it. */
  excludeProjectIds?: string[]
  search?: string
  limit?: number
}

export interface PeopleRebuildProgress {
  phase: 'seed' | 'harvest' | 'resolve' | 'messages' | 'dossier' | 'complete'
  message: string
  current: number | null
  total: number | null
}

export type PeopleRunStatus = 'idle' | 'running' | 'stopping' | 'paused'

export type PeopleRunOutcome = 'completed' | 'paused' | 'stopped' | 'failed'

/**
 * Why this is far smaller than `DocumentIndexPauseRecord`: People has one scope,
 * and every profile it writes is committed as it is produced and gated on a hash
 * of that person's evidence. Resuming is therefore just running again — the pass
 * skips everyone already done — so the record only has to carry what the UI says,
 * not where to pick back up.
 */
export interface PeopleIndexPauseRecord {
  message: string
  pausedAt: string
}

export interface PeopleRunState {
  status: PeopleRunStatus
  pendingAction: 'pause' | 'stop' | null
  origin: 'user' | 'timer' | null
  progress: PeopleRebuildProgress | null
  message: string | null
  canResume: boolean
  updatedAt: string
}

export interface PeopleRebuildResult {
  sourcesScanned: number
  mentionsHarvested: number
  seedsCollected: number
  peopleStored: number
  peopleUpdated: number
  peopleArchived: number
  ambiguous: number
  overridesApplied: number
  /** Dossiers (re)generated this pass; an unchanged evidence set costs nothing. */
  dossiersGenerated: number
  dossiersCovered: number
  dossiersFailed: number
  dossiersError: string | null
  /** Person-years of message history compressed this pass; unchanged years cost nothing. */
  yearsGenerated: number
  yearsCovered: number
  yearsFailed: number
}

/**
 * `account` is the catch-all for the named external accounts in
 * `activityProviders.ts` whose events do not fit one of the older typed tables.
 * The nine values before it predate the account registry and stay as they are.
 */
export type ActivitySourceType =
  | 'browser'
  | 'youtube'
  | 'amazon'
  | 'email'
  | 'knowledge'
  | 'photos'
  | 'location'
  | 'weather'
  | 'subscription'
  | 'account'

export const ACTIVITY_SOURCE_TYPES: readonly ActivitySourceType[] = [
  'browser',
  'youtube',
  'amazon',
  'email',
  'knowledge',
  'photos',
  'location',
  'weather',
  'subscription',
  'account',
] as const

export function isActivitySourceType(value: unknown): value is ActivitySourceType {
  return typeof value === 'string' && (ACTIVITY_SOURCE_TYPES as readonly string[]).includes(value)
}

export interface ActivityRecord {
  id: string
  projectId: string
  sourceType: ActivitySourceType
  filename: string | null
  fileSize: number | null
  contentHash: string | null
  importedAt: string
  status: 'pending' | 'parsed' | 'failed' | 'needs_permission'
  parseError: string | null
  eventsCount: number
}

export interface BrowserEvent {
  id: string
  recordId: string
  kind: 'visit' | 'bookmark' | 'download'
  occurredAt: string
  title: string | null
  url: string | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface YoutubeEvent {
  id: string
  recordId: string
  occurredAt: string
  title: string | null
  channel: string | null
  url: string | null
  durationSeconds: number | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface AmazonEvent {
  id: string
  recordId: string
  occurredAt: string
  orderId: string | null
  title: string | null
  totalCents: number | null
  items: Array<{ title: string; quantity: number; priceCents: number | null }>
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface EmailEvent {
  id: string
  recordId: string
  kind: 'received' | 'sent'
  occurredAt: string
  fromAddress: string | null
  toAddresses: string[]
  subject: string | null
  bodyExcerpt: string | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface KnowledgeEvent {
  id: string
  recordId: string
  occurredAt: string
  bundleId: string | null
  appName: string | null
  eventType: 'app_open' | 'screen_on' | 'notification'
  durationSeconds: number | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface PhotoEvent {
  id: string
  recordId: string
  occurredAt: string
  assetKind: string | null
  locationName: string | null
  faces: string[]
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface LocationEvent {
  id: string
  recordId: string
  occurredAt: string
  lat: number | null
  lng: number | null
  accuracyM: number | null
  source: string | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface WeatherEvent {
  id: string
  recordId: string
  occurredAt: string
  tempC: number | null
  humidityPct: number | null
  precipMm: number | null
  windKph: number | null
  conditions: string | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface SubscriptionEvent {
  id: string
  recordId: string
  occurredAt: string
  provider: string | null
  planName: string | null
  amountCents: number | null
  currency: string | null
  cadence: 'weekly' | 'monthly' | 'yearly' | 'unknown'
  sourceMeta: Record<string, unknown>
  createdAt: string
}

/**
 * The generic event row for accounts with no dedicated table. Deliberately thin:
 * a timestamp, a kind, and two text fields. Anything richer belongs in
 * `sourceMeta`, which is never sent to a model.
 */
export type AccountEventKind =
  | 'post'
  | 'comment'
  | 'message'
  | 'search'
  | 'watch'
  | 'like'
  | 'follow'
  | 'match'
  | 'swipe'
  | 'login'
  | 'purchase'
  | 'listen'
  | 'other'

export interface AccountEvent {
  id: string
  recordId: string
  provider: ActivityProviderId
  kind: AccountEventKind
  occurredAt: string
  title: string | null
  detail: string | null
  /** The other party on a message or match. Redacted like every other field. */
  counterparty: string | null
  url: string | null
  sourceMeta: Record<string, unknown>
  createdAt: string
}

export interface ActivityIngestProgress {
  phase: 'reading' | 'parsing' | 'extracting' | 'storing' | 'complete' | 'permission' | 'reauth'
  message: string
  current: number | null
  total: number | null
  recordId: string | null
  sourceType: ActivitySourceType | null
  /**
   * Set when the progress belongs to a specific account rather than a bare
   * source type. Optional so the nine pre-registry ingest paths stay untouched.
   */
  provider?: ActivityProviderId | null
}

export interface ActivityEventsBySource {
  browser: BrowserEvent[]
  youtube: YoutubeEvent[]
  amazon: AmazonEvent[]
  email: EmailEvent[]
  knowledge: KnowledgeEvent[]
  photos: PhotoEvent[]
  location: LocationEvent[]
  weather: WeatherEvent[]
  subscription: SubscriptionEvent[]
  account: AccountEvent[]
}

/**
 * One folder an account watches for export archives. Mirrors `ProjectSource`,
 * because it is the same idea one level down: a source with several connected
 * directories.
 */
export interface ActivityAccountSource {
  id: string
  accountId: string
  path: string
  sortOrder: number
  createdAt: number
}

export type ActivityAccountSyncStatus =
  | 'idle'
  | 'synced'
  | 'needs_permission'
  | 'needs_reauth'
  | 'error'

/**
 * One configured external account. Credentials never live here — only the fact
 * that one is stored, so the UI can render "connected" without touching the
 * keychain.
 */
export interface ActivityAccount {
  id: string
  projectId: string
  provider: ActivityProviderId
  enabled: boolean
  /**
   * Mirror of `sources[0]`, kept the way `Project.path` mirrors its first
   * source so single-folder consumers keep working. Null when no folder is set.
   */
  watchPath: string | null
  /** Every folder polled for this account's export archives. */
  sources: ActivityAccountSource[]
  credentialStored: boolean
  credentialKind: ActivityCredentialKind | null
  /** Per-provider settings: IMAP host/user, the ban-risk acknowledgement, etc. */
  config: ActivityAccountConfig
  lastSyncAt: string | null
  lastSyncStatus: ActivityAccountSyncStatus
  lastError: string | null
  /** When an export archive was last ingested, for the staleness nudge. */
  lastExportAt: string | null
  createdAt: string
  /** Denormalized for the Data page; not stored. */
  eventsCount: number
}

export interface ActivityAccountConfig {
  /** Gmail IMAP. Defaults to imap.gmail.com:993 when unset. */
  imapHost?: string
  imapPort?: number
  imapUser?: string
  /** Explicit opt-in required before a `ban-risk` live connector will run. */
  riskAccepted?: boolean
  [key: string]: unknown
}

export interface ActivityAccountUpdate {
  enabled?: boolean
  watchPath?: string | null
  config?: ActivityAccountConfig
}

export interface ActivityAccountSyncResult {
  provider: ActivityProviderId
  status: 'synced' | 'skipped' | 'needs_permission' | 'needs_reauth' | 'error'
  eventsCount: number
  message?: string
}

export interface ActivityLiveStatusSource {
  sourceType: ActivitySourceType
  status: 'idle' | 'syncing' | 'needs_permission' | 'needs_reauth' | 'error'
  lastSyncAt: string | null
}

export interface ActivityLiveStatus {
  sources: ActivityLiveStatusSource[]
}

export interface ActivitySyncResultItem {
  sourceType: ActivitySourceType
  status: 'synced' | 'skipped' | 'needs_permission' | 'needs_reauth' | 'error'
  eventsCount: number
}

export interface ActivitySyncResult {
  results: ActivitySyncResultItem[]
}

export type WebSearchProvider = 'tavily'

export type WebSearchTopic = 'general' | 'news'

export type WebSearchDepth = 'basic' | 'advanced'

export interface WebSearchRequest {
  query: string
  maxResults?: number
  searchDepth?: WebSearchDepth
  topic?: WebSearchTopic
}

export interface WebSearchResultItem {
  title: string
  url: string
  content: string
  score: number
}

export interface WebSearchResult {
  query: string
  answer: string | null
  results: WebSearchResultItem[]
  responseTimeMs: number | null
  searchedAt: number
}

export interface WebSearchSettings {
  enabled: boolean
  provider: WebSearchProvider
  apiKey: string
}

import type { RemoteDevice, RemotePairingOffer, RemoteScope, RemoteServerStatus } from './remote'
import type { RemoteMediaKind, RemoteMediaTicket } from './remoteMedia'

export interface ElectronAPI {
  conversations: {
    list: () => Promise<Conversation[]>
    create: (model?: string, effort?: ReasoningEffort, projectId?: string, memoryMode?: MemoryMode, context?: ContextSelection, roleId?: string | null) => Promise<Conversation>
    delete: (id: string) => Promise<void>
    rename: (id: string, title: string) => Promise<void>
    updateModel: (id: string, model: string) => Promise<void>
    updateEffort: (id: string, effort: ReasoningEffort) => Promise<void>
    updateMemoryMode: (id: string, mode: MemoryMode) => Promise<void>
    updateContext: (id: string, context: ContextSelection) => Promise<void>
    updateRole: (id: string, roleId: string | null) => Promise<void>
    updateSystemPrompt: (id: string, prompt: string) => Promise<void>
    getMessages: (id: string) => Promise<Message[]>
    search: (query: string) => Promise<SearchResult[]>
    onUpdated: (callback: () => void) => () => void
  }
  chat: {
    send: (conversationId: string, message: string, model: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection, attachments?: ChatAttachment[]) => Promise<void>
    editMessage: (messageId: string, newContent: string, model: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection) => Promise<void>
    retryMessage: (messageId: string, model: string, effort?: ReasoningEffort, memoryMode?: MemoryMode, context?: ContextSelection) => Promise<void>
    setActiveBranch: (messageId: string) => Promise<void>
    abort: () => void
    previewSystemPrompt: (conversationId: string, memoryMode: MemoryMode, context?: ContextSelection, roleId?: string | null) => Promise<SystemPromptEntry[]>
    onChunk: (callback: (chunk: StreamChunk) => void) => () => void
    onSystemPrompt: (callback: (messages: SystemPromptEntry[]) => void) => () => void
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (settings: Partial<AppSettings>) => Promise<void>
    getProvider: () => Promise<ProviderConfig>
    setProvider: (config: ProviderConfig) => Promise<void>
  }
  models: {
    list: () => Promise<ModelInfo[]>
  }
  productSearch: {
    search: (request: ProductSearchRequest) => Promise<ProductSearchResult>
    abort: () => Promise<void>
  }
  websearch: {
    search: (request: WebSearchRequest) => Promise<WebSearchResult>
    abort: () => Promise<void>
  }
  recall: {
    search: (request: RecallSearchRequest) => Promise<RecallSearchResponse>
    abort: () => Promise<void>
    clear: () => Promise<void>
    startConversation: (model: string, effort: ReasoningEffort) => Promise<Conversation>
    openFile: (path: string) => Promise<void>
    revealFile: (path: string) => Promise<void>
    history: () => Promise<RecallHistoryEntry[]>
    deleteHistory: (id: string) => Promise<RecallHistoryEntry[]>
    clearHistory: () => Promise<number>
  }
  memory: {
    list: () => Promise<MemoryField[]>
    get: (category: string, fieldKey: string) => Promise<MemoryValue | null>
    update: (request: MemoryUpdateRequest) => Promise<MemoryField[]>
    createField: (request: MemoryCreateFieldRequest) => Promise<MemoryField[]>
    deleteField: (fieldId: string) => Promise<MemoryField[]>
    suggestions: () => Promise<MemorySuggestion[]>
    extract: (request: MemoryExtractionRequest) => Promise<MemoryExtractionResult>
    abort: () => Promise<void>
    reviewSuggestion: (request: MemorySuggestionReviewRequest) => Promise<{
      fields: MemoryField[]
      suggestions: MemorySuggestion[]
    }>
  }
  projects: {
    list: () => Promise<Project[]>
    create: (project: ProjectInput) => Promise<Project>
    update: (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<void>
    delete: (id: string) => Promise<void>
    /** Persists the whole Data list in its new hand-arranged order. */
    reorder: (orderedIds: string[]) => Promise<Project[]>
    addFile: (projectId: string, filePath: string) => Promise<void>
    removeFile: (projectId: string, filePath: string) => Promise<void>
    addSource: (projectId: string, sourcePath: string) => Promise<ProjectSource[]>
    removeSource: (projectId: string, sourcePath: string) => Promise<ProjectSource[]>
    listSources: (projectId: string) => Promise<ProjectSource[]>
    analyzePsychology: (projectId: string) => Promise<PsychologyAnalysis>
    analyzeHealth: (projectId: string) => Promise<HealthAnalysis>
    completePsychologyTest: (projectId: string, testId: PsychologicalTestId, answers: number[]) => Promise<PsychologicalTestResult>
    restoreDefaults: () => Promise<Project[]>
  }
  app: {
    openExternal: (url: string) => Promise<void>
    /**
     * Opens a file a cited source points at. Only paths Holmes itself recorded as
     * a source are openable, so the renderer cannot name an arbitrary file.
     */
    openSourcePath: (path: string) => Promise<void>
    onNewChat: (callback: () => void) => () => void
    onSettings: (callback: () => void) => () => void
    getUserInfo: () => Promise<{ firstName: string }>
    selectDirectory: () => Promise<string | null>
    selectFiles: () => Promise<string[]>
    selectImage: () => Promise<string | null>
    selectAttachments: () => Promise<ChatAttachment[]>
  }
  importClaude: {
    start: (directory: string, options: ClaudeImportOptions) => Promise<ClaudeImportResult>
    abort: () => Promise<void>
    onProgress: (callback: (progress: ClaudeImportProgress) => void) => () => void
  }
  health: {
    ingest: (projectId: string, filePath: string) => Promise<HealthRecord>
    scanDirectory: (projectId: string) => Promise<DirectoryScanResult>
    abort: () => Promise<void>
    onProgress: (callback: (progress: HealthIngestProgress) => void) => () => void
    listRecords: (projectId: string) => Promise<HealthRecord[]>
    listObservations: (projectId: string, opts?: { type?: string; limit?: number }) => Promise<HealthObservation[]>
    deleteRecord: (recordId: string) => Promise<void>
    refreshSummary: (projectId: string) => Promise<HealthSummary>
    getSummary: (projectId: string) => Promise<HealthSummary | null>
    liveStatus: (projectId: string) => Promise<HealthLiveStatus>
    liveSync: (projectId: string, types?: string[]) => Promise<HealthSyncResult>
    liveAbort: () => Promise<void>
    onLiveSyncProgress: (callback: (progress: HealthLiveSyncProgress) => void) => () => void
  }
  activity: {
    ingest: (projectId: string, filePath: string, source: ActivitySourceType) => Promise<ActivityRecord>
    scanDirectory: (projectId: string) => Promise<DirectoryScanResult>
    abort: () => Promise<void>
    onProgress: (callback: (progress: ActivityIngestProgress) => void) => () => void
    listRecords: (projectId: string) => Promise<ActivityRecord[]>
    listEvents: (projectId: string, sourceType?: ActivitySourceType, limit?: number) => Promise<ActivityEventsBySource>
    deleteRecord: (recordId: string) => Promise<void>
    refreshSummary: (projectId: string, tier?: ModelTier) => Promise<ActivitySummary>
    estimateAnalysis: (projectId: string, tier?: ModelTier) => Promise<ActivityAnalysisEstimate>
    getRunState: () => Promise<ActivityRunState>
    onRunState: (callback: (state: ActivityRunState) => void) => () => void
    getSummary: (projectId: string) => Promise<ActivitySummary | null>
    liveStatus: (projectId: string) => Promise<ActivityLiveStatus>
    liveSync: (projectId: string, sourceTypes?: ActivitySourceType[]) => Promise<ActivitySyncResult>
    liveAbort: () => Promise<void>
    onLiveSyncProgress: (callback: (progress: ActivityIngestProgress) => void) => () => void
    grantPermission: () => Promise<void>
    setAmazonCookies: (cookies: string) => Promise<void>
    clearAmazonCookies: () => Promise<void>
    listAccounts: (projectId: string) => Promise<ActivityAccount[]>
    updateAccount: (accountId: string, update: ActivityAccountUpdate) => Promise<ActivityAccount>
    setAccountCredential: (accountId: string, secret: string) => Promise<ActivityAccount>
    clearAccountCredential: (accountId: string) => Promise<ActivityAccount>
    syncAccount: (accountId: string) => Promise<ActivityAccountSyncResult>
    importAccountExport: (accountId: string, filePath: string) => Promise<ActivityRecord>
    addAccountSource: (accountId: string, sourcePath: string) => Promise<ActivityAccount>
    removeAccountSource: (accountId: string, sourcePath: string) => Promise<ActivityAccount>
    scanAccountSources: (projectId: string) => Promise<{ ingested: number }>
    setLocation: (lat: number, lng: number) => Promise<void>
    getLocation: () => Promise<{ lat: number | null; lng: number | null }>
    fetchCurrentLocation: () => Promise<
      | { status: 'ok'; fix: { lat: number; lng: number; accuracyM: number } }
      | { status: 'needs_permission' }
      | { status: 'timeout' }
      | { status: 'unavailable' }
    >
    sidecarAvailable: () => Promise<boolean>
  }
  documents: {
    generate: (projectId: string, tier?: ModelTier, options?: { sourcePath?: string; force?: boolean; granularity?: IndexGranularity }) => Promise<DocumentContextResult>
    generateAll: (options?: { resume?: boolean; tier?: ModelTier; projectIds?: string[]; force?: boolean; granularity?: IndexGranularity }) => Promise<DocumentIndexAllResult>
    regenerateNode: (projectId: string, target: RegenerateContextTarget, tier?: ModelTier) => Promise<RegenerateContextResult>
    estimate: (projectId: string, tier?: ModelTier, options?: { sourcePath?: string; force?: boolean; granularity?: IndexGranularity }) => Promise<IndexEstimate>
    estimateAll: (tier?: ModelTier, options?: { projectIds?: string[]; force?: boolean; granularity?: IndexGranularity }) => Promise<IndexEstimate>
    getSummaries: () => Promise<ProjectIndexSummary[]>
    abort: () => Promise<DocumentIndexState>
    pause: () => Promise<DocumentIndexState>
    getState: () => Promise<DocumentIndexState>
    getTree: (projectId: string) => Promise<DocumentContextTree>
    getProvenance: (ref: string, projectId?: string | null, options?: { maxNodes?: number; maxDepth?: number }) => Promise<ProvenanceChain>
    getSourceExcerpt: (filePath: string, startLine: number, endLine: number, projectId?: string | null) => Promise<SourceExcerpt>
    getUserContext: () => Promise<UserSuperContext | null>
    refreshUserContext: () => Promise<UserSuperContext | null>
    onProgress: (callback: (progress: DocumentContextProgress) => void) => () => void
    onState: (callback: (state: DocumentIndexState) => void) => () => void
  }
  /**
   * The e-book Library. Nothing in this namespace consults a provider: scanning,
   * reading and progress are local I/O, and work with no API key configured.
   */
  library: {
    scan: (projectId: string) => Promise<LibraryScanResult>
    abortScan: () => Promise<boolean>
    getState: () => Promise<LibraryRunState>
    onState: (callback: (state: LibraryRunState) => void) => () => void
    onScanProgress: (callback: (progress: LibraryScanProgress) => void) => () => void
    listBooks: (projectId?: string) => Promise<LibraryBook[]>
    getBook: (bookId: string) => Promise<{ book: Book; chapters: BookChapter[]; reading: BookReadingState }>
    deleteBook: (bookId: string) => Promise<void>
    getChapter: (bookId: string, chapterIndex: number) => Promise<BookChapterContent>
    getResource: (bookId: string, resourceId: string) => Promise<BookResource>
    setReadingState: (
      bookId: string,
      patch: { status?: BookReadingStatus; rating?: number | null; notes?: string }
    ) => Promise<BookReadingState>
    setProgress: (bookId: string, chapterIndex: number, charOffset: number) => Promise<BookReadingState>
    recordSession: (session: Omit<BookReadingSession, 'id'>) => Promise<void>
    estimateSnapshot: (projectId: string, tier?: ModelTier) => Promise<IndexEstimate>
    refreshSnapshot: (projectId: string, tier?: ModelTier) => Promise<LibrarySnapshotResult>
    listAnnotationRuns: (bookId: string) => Promise<BookAnnotationRun[]>
    listAnnotations: (bookId: string, chapterIndex?: number) => Promise<BookAnnotation[]>
    estimateAnnotations: (bookId: string, chapterStart: number, chapterEnd: number, tier?: ModelTier) => Promise<IndexEstimate>
    generateAnnotations: (
      bookId: string,
      focus: { key: string; customText?: string },
      chapterStart: number,
      chapterEnd: number,
      tier?: ModelTier
    ) => Promise<AnnotationRunSummary>
    deleteAnnotationRun: (runId: string) => Promise<void>
    createAnnotation: (input: { bookId: string; chapterIndex: number; charStart: number; charEnd: number; label?: string; body?: string }) => Promise<BookAnnotation>
    setAnnotationPinned: (id: string, pinned: boolean) => Promise<void>
    deleteAnnotation: (id: string) => Promise<void>
    abortGeneration: () => Promise<boolean>
    listLessons: (bookId: string) => Promise<BookLesson[]>
    getLesson: (lessonId: string) => Promise<BookLesson | null>
    estimateLesson: (bookId: string, chapterStart: number, chapterEnd: number, tier?: ModelTier) => Promise<IndexEstimate>
    generateLesson: (bookId: string, chapterStart: number, chapterEnd: number, tier?: ModelTier) => Promise<LessonRunSummary>
    deleteLesson: (lessonId: string) => Promise<void>
    recordAttempt: (attempt: Omit<BookLessonAttempt, 'id' | 'createdAt'>) => Promise<BookLessonAttempt>
    listAttempts: (lessonId: string) => Promise<BookLessonAttempt[]>
    buildDiscussionPrompt: (bookId: string, chapterIndex: number, lessonId?: string, stepId?: string) => Promise<BookDiscussionScope>
    linkConversation: (bookId: string, conversationId: string, meta: { chapterIndex?: number; lessonId?: string; stepId?: string }) => Promise<void>
    listConversations: (bookId: string) => Promise<BookConversationLink[]>
    speechProviders: () => Promise<SpeechProviderInfo[]>
    setSpeechKey: (providerId: SpeechProviderId, key: string) => Promise<SpeechKeyResult>
    clearSpeechKey: (providerId: SpeechProviderId) => Promise<void>
    listVoices: (providerId: SpeechProviderId) => Promise<SpeechVoice[]>
    listNarrationModels: (providerId: SpeechProviderId) => Promise<SpeechModel[]>
    estimateAudiobook: (
      bookId: string,
      chapterIndex: number,
      providerId?: SpeechProviderId,
      modelId?: string
    ) => Promise<AudiobookEstimate>
    generateAudiobook: (
      bookId: string,
      chapterIndex: number,
      options: { providerId: SpeechProviderId; voiceId: string; voiceName?: string; modelId?: string; force?: boolean }
    ) => Promise<AudiobookChapter>
    getAudiobook: (bookId: string, chapterIndex: number) => Promise<AudiobookChapter | null>
    listAudiobooks: (bookId: string) => Promise<Audiobook[]>
    deleteAudiobook: (bookId: string, chapterIndex: number) => Promise<void>
    /**
     * A short-lived, signed HTTP URL for one book file or audiobook segment.
     * Remote devices only — from the desktop this throws, because the renderer
     * reads these files through the app's own protocols and does not need a
     * credential to do it.
     */
    getMediaUrl: (kind: RemoteMediaKind, id: string) => Promise<RemoteMediaTicket>
    planOrganize: (projectId: string, tier?: ModelTier) => Promise<OrganizePlan>
    applyOrganize: (plan: OrganizePlan) => Promise<OrganizeResult>
    onAudiobookProgress: (callback: (progress: AudiobookProgress) => void) => () => void
  }
  timeline: {
    list: (filter?: TimelineFilter) => Promise<TimelineEvent[]>
    getSummary: () => Promise<TimelineSummary | null>
    getYears: () => Promise<TimelineYearsView>
    rebuild: () => Promise<TimelineRebuildResult>
    abort: () => Promise<void>
    createEvent: (input: TimelineEventInput) => Promise<TimelineEvent>
    deleteEvent: (id: string) => Promise<void>
    onProgress: (callback: (progress: TimelineRebuildProgress) => void) => () => void
    getState: () => Promise<TimelineRunState>
    onState: (callback: (state: TimelineRunState) => void) => () => void
  }
  people: {
    list: (filter?: PeopleFilter) => Promise<Person[]>
    get: (id: string) => Promise<{ person: Person; mentions: PersonMention[] } | null>
    rebuild: () => Promise<PeopleRebuildResult>
    abort: () => Promise<PeopleRunState>
    pause: () => Promise<PeopleRunState>
    /** Detach one mention from its person — undoes a bad merge. */
    pin: (mentionKey: string, personKey: string | null) => Promise<void>
    /** Join two people the resolver refused to join. */
    merge: (sourceKey: string, targetKey: string) => Promise<void>
    ignore: (personKey: string, ignored: boolean) => Promise<void>
    setRelation: (personKey: string, relation: PersonRelation) => Promise<void>
    onProgress: (callback: (progress: PeopleRebuildProgress) => void) => () => void
    getState: () => Promise<PeopleRunState>
    onState: (callback: (state: PeopleRunState) => void) => () => void
  }
  contextVersions: {
    list: (filter?: ContextVersionFilter) => Promise<ContextVersionSummary[]>
    get: (id: string) => Promise<ContextVersion | null>
  }
  roles: {
    list: () => Promise<RoleSummary[]>
    getSessionNote: (conversationId: string) => Promise<RoleSessionNote | null>
    listSessionNotes: (filter?: RoleSessionNoteFilter) => Promise<RoleSessionNote[]>
    generateSessionNote: (conversationId: string, force?: boolean) => Promise<RoleSessionNoteResult>
    deleteSessionNote: (conversationId: string) => Promise<void>
    onSessionNoteAdded: (callback: () => void) => () => void
  }
  providerCredit: {
    get: () => Promise<CreditBreakerState>
    clear: () => Promise<void>
    onState: (callback: (state: CreditBreakerState) => void) => () => void
  }
  ideas: {
    get: () => Promise<HomeIdeasResult>
    refresh: (force?: boolean) => Promise<HomeIdeasResult>
  }
  play: {
    get: () => Promise<PlayFeed>
    refresh: (force?: boolean) => Promise<PlayFeed>
    react: (id: string, reaction: PlayReaction | null) => Promise<PlayFeed>
    stop: () => Promise<PlayRunState>
    getState: () => Promise<PlayRunState>
    setProgress: (id: string, positionSeconds: number, durationSeconds: number | null) => Promise<PlayWatchState | null>
    archive: (id: string) => Promise<PlayFeed>
    onState: (callback: (state: PlayRunState) => void) => () => void
  }
  callHistory: {
    list: (filter?: ProviderCallFilter) => Promise<ProviderCallSummary[]>
    get: (id: string) => Promise<ProviderCall | null>
    stats: (filter?: ProviderCallFilter) => Promise<ProviderCallStats>
    clear: () => Promise<void>
  }
  remote: {
    getStatus: () => Promise<RemoteServerStatus>
    setEnabled: (enabled: boolean) => Promise<RemoteServerStatus>
    createPairing: (scope: RemoteScope) => Promise<RemotePairingOffer>
    cancelPairing: () => Promise<void>
    listDevices: () => Promise<RemoteDevice[]>
    revokeDevice: (deviceId: string) => Promise<void>
    renameDevice: (deviceId: string, name: string) => Promise<void>
    onStatus: (callback: (status: RemoteServerStatus) => void) => () => void
  }
  work: {
    saveDocument: (request: WorkSaveRequest) => Promise<WorkSaveResult>
    /** The kind rides along so main offers the matching tool set — the office
     *  work_* tools, or the raster/vector design_* tools. */
    setEditorOpen: (open: boolean, kind?: WorkDocumentKind) => Promise<{ open: boolean }>
    respondToEditor: (response: WorkEditorResponse) => Promise<{ settled: boolean }>
    onOpenDocument: (callback: (request: WorkEditorRequest) => void) => () => void
    onEditorRequest: (callback: (request: WorkEditorRequest) => void) => () => void
  }
  fs: {
    readFile: (path: string, options?: { encoding?: 'utf8' | 'base64'; maxBytes?: number }) => Promise<FsReadResult>
    writeFile: (request: FsWriteRequest) => Promise<FsWriteResult>
    listDir: (path: string) => Promise<FsListItem[]>
    stat: (path: string) => Promise<{ path: string; isFile: boolean; isDirectory: boolean; size: number; modifiedAt: number }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
