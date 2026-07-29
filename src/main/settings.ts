import Store from 'electron-store'
import type { AppSettings, DocumentIndexPauseRecord,
  PeopleIndexPauseRecord, FileAccessScope, FileAccessScopeMode, ModelTier, ModelTierConfig, ProviderConfig, ProviderType, ReasoningEffort, TierModels, WebSearchProvider } from '../shared/types'
import { MODEL_TIERS } from '../shared/types'
import { DEFAULT_ASSISTANT_NAME, normalizeAssistantName, setAssistantName } from '../shared/assistantIdentity'
import { DEFAULT_OLLAMA_BASE_URL } from './providerEndpoint'
import { DEFAULT_REQUESTS_PER_MINUTE } from './rateLimit'
import { clearProviderCreditBlock } from './providerCredit'
import { REMOTE_DEFAULT_PORT } from '../shared/remote'
import { generateStaticKeyPair } from './remoteCrypto'

const DEFAULT_FILE_ACCESS_SCOPE: FileAccessScope = { mode: 'custom', roots: [] }

const store = new Store<{
  provider: ProviderConfig
  theme: 'light' | 'dark' | 'system'
  assistantName?: string
  assistantIcon?: string
  welcomeLines?: string[]
  boilEffectEnabled?: boolean
  defaultModel: string
  defaultEffort: ReasoningEffort
  systemModel?: string
  analysisModel?: string
  visionModel?: string
  modelTiers?: ModelTierConfig
  defaultTier?: ModelTier
  imageGenerationModel?: string
  videoGenerationModel?: string
  memoryAutoExtractionEnabled: boolean
  healthAnalysisEnabled: boolean
  healthLiveSyncEnabled?: boolean
  fileAccessScope: FileAccessScope
  webSearchEnabled?: boolean
  webSearchProvider?: WebSearchProvider
  webSearchApiKey?: string
  activityIngestEnabled?: boolean
  activitySyncEnabled?: boolean
  activityEmailAllowedAddress?: string
  activityKnowledgePermissionPrompted?: boolean
  activityWeatherEnabled?: boolean
  activityLocationLatitude?: number | null
  activityLocationLongitude?: number | null
  activityAmazonCookiesStored?: boolean
  documentContextEnabled?: boolean
  librarySnapshotEnabled?: boolean
  superContextMemoryEnabled?: boolean
  timelineEnabled?: boolean
  peopleEnabled?: boolean
  automationPaused?: boolean
  documentIndexPause?: DocumentIndexPauseRecord | null
  peopleIndexPause?: PeopleIndexPauseRecord | null
  requestsPerMinute?: number
  remoteEnabled?: boolean
  remotePort?: number
  remoteServerKey?: { publicKey: string; privateKey: string } | null
}>({
  name: 'holmes-settings',
  encryptionKey: 'holmes-local-encryption-key',
  defaults: {
    provider: {
      type: 'openrouter',
      openrouterApiKey: '',
      customBaseUrl: '',
      customApiKey: '',
      customModel: '',
      ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    },
    theme: 'system',
    assistantName: DEFAULT_ASSISTANT_NAME,
    assistantIcon: '',
    welcomeLines: [],
    boilEffectEnabled: true,
    defaultModel: '',
    defaultEffort: 'medium',
    systemModel: '',
    visionModel: '',
    modelTiers: undefined,
    defaultTier: 'mid',
    imageGenerationModel: '',
    videoGenerationModel: '',
    memoryAutoExtractionEnabled: false,
    healthAnalysisEnabled: false,
    healthLiveSyncEnabled: false,
    fileAccessScope: DEFAULT_FILE_ACCESS_SCOPE,
    webSearchEnabled: false,
    webSearchProvider: 'tavily',
    webSearchApiKey: '',
    activityIngestEnabled: false,
    activitySyncEnabled: true,
    activityEmailAllowedAddress: '',
    activityKnowledgePermissionPrompted: false,
    activityWeatherEnabled: false,
    activityLocationLatitude: null,
    activityLocationLongitude: null,
    activityAmazonCookiesStored: false,
    documentContextEnabled: false,
    // Off by default, like document context: a reading-record snapshot is the
    // only paid thing the Library does, and reading works without it.
    librarySnapshotEnabled: false,
    superContextMemoryEnabled: false,
    timelineEnabled: true,
    peopleEnabled: true,
    automationPaused: false,
    documentIndexPause: null,
    peopleIndexPause: null,
    requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
    // Off by default. Opening a port on the machine that holds the health
    // record and the message graph is a decision the user makes deliberately.
    remoteEnabled: false,
    remotePort: REMOTE_DEFAULT_PORT,
    remoteServerKey: null,
  },
})

const DEFAULT_SYSTEM_MODEL = 'openai/gpt-4o-mini'
// Vision counterpart to DEFAULT_SYSTEM_MODEL. gpt-4o-mini accepts image input,
// so the two halves of an index run share one cheap default.
const DEFAULT_VISION_MODEL = 'openai/gpt-4o-mini'

const EMPTY_TIER: TierModels = { textModel: '', visionModel: '' }

export function normalizeModelTiers(value: unknown): ModelTierConfig {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<ModelTier, unknown>>
  const out = {} as ModelTierConfig
  for (const tier of MODEL_TIERS) {
    const entry = (raw[tier] && typeof raw[tier] === 'object' ? raw[tier] : {}) as Partial<TierModels>
    out[tier] = {
      textModel: typeof entry.textModel === 'string' ? entry.textModel.trim() : '',
      visionModel: typeof entry.visionModel === 'string' ? entry.visionModel.trim() : '',
    }
  }
  return out
}

export function normalizeModelTier(value: unknown): ModelTier {
  return MODEL_TIERS.includes(value as ModelTier) ? (value as ModelTier) : 'mid'
}

// One-time migration off the flat systemModel/visionModel pair. Whatever the
// user had configured becomes the mid tier, so background work keeps running on
// exactly the model it ran on before the tiers existed. Budget and frontier
// start empty and fall back to mid until the user fills them in.
if (!store.get('modelTiers')) {
  const legacyText = (store.get('systemModel') || store.get('analysisModel') || DEFAULT_SYSTEM_MODEL).trim()
  const legacyVision = (store.get('visionModel') ?? '').trim()
  store.set('modelTiers', {
    budget: { ...EMPTY_TIER },
    mid: { textModel: legacyText, visionModel: legacyVision },
    frontier: { ...EMPTY_TIER },
  })
}

export function getSettings(): AppSettings {
  return {
    provider: getProvider(),
    theme: store.get('theme'),
    assistantName: getAssistantName(),
    assistantIcon: getAssistantIcon(),
    welcomeLines: getWelcomeLines(),
    boilEffectEnabled: store.get('boilEffectEnabled') ?? true,
    defaultModel: store.get('defaultModel'),
    defaultEffort: store.get('defaultEffort'),
    modelTiers: getModelTiers(),
    defaultTier: getDefaultTier(),
    imageGenerationModel: getImageGenerationModel(),
    videoGenerationModel: getVideoGenerationModel(),
    memoryAutoExtractionEnabled: store.get('memoryAutoExtractionEnabled'),
    healthAnalysisEnabled: store.get('healthAnalysisEnabled'),
    healthLiveSyncEnabled: store.get('healthLiveSyncEnabled') ?? false,
    fileAccessScope: normalizeFileAccessScope(store.get('fileAccessScope')),
    webSearchEnabled: store.get('webSearchEnabled') ?? false,
    webSearchProvider: store.get('webSearchProvider') ?? 'tavily',
    webSearchApiKey: store.get('webSearchApiKey') ?? '',
    activityIngestEnabled: store.get('activityIngestEnabled') ?? false,
    activitySyncEnabled: store.get('activitySyncEnabled') ?? true,
    activityEmailAllowedAddress: store.get('activityEmailAllowedAddress') ?? '',
    activityKnowledgePermissionPrompted: store.get('activityKnowledgePermissionPrompted') ?? false,
    activityWeatherEnabled: store.get('activityWeatherEnabled') ?? false,
    activityLocationLatitude: store.get('activityLocationLatitude') ?? null,
    activityLocationLongitude: store.get('activityLocationLongitude') ?? null,
    activityAmazonCookiesStored: store.get('activityAmazonCookiesStored') ?? false,
    documentContextEnabled: store.get('documentContextEnabled') ?? false,
    librarySnapshotEnabled: store.get('librarySnapshotEnabled') ?? false,
    superContextMemoryEnabled: store.get('superContextMemoryEnabled') ?? false,
    timelineEnabled: store.get('timelineEnabled') ?? true,
    peopleEnabled: store.get('peopleEnabled') ?? true,
    automationPaused: isAutomationPaused(),
    requestsPerMinute: getRequestsPerMinute(),
  }
}

export function setSettings(partial: Partial<AppSettings>): void {
  if (partial.provider !== undefined) setProvider(partial.provider)
  if (partial.theme !== undefined) store.set('theme', partial.theme)
  if (partial.assistantName !== undefined) setStoredAssistantName(partial.assistantName)
  if (partial.assistantIcon !== undefined) store.set('assistantIcon', normalizeAssistantIcon(partial.assistantIcon))
  if (partial.welcomeLines !== undefined) store.set('welcomeLines', normalizeWelcomeLines(partial.welcomeLines))
  if (partial.boilEffectEnabled !== undefined) store.set('boilEffectEnabled', partial.boilEffectEnabled)
  if (partial.defaultModel !== undefined) store.set('defaultModel', partial.defaultModel)
  if (partial.defaultEffort !== undefined) store.set('defaultEffort', partial.defaultEffort)
  if (partial.modelTiers !== undefined) store.set('modelTiers', normalizeModelTiers(partial.modelTiers))
  if (partial.defaultTier !== undefined) store.set('defaultTier', normalizeModelTier(partial.defaultTier))
  if (partial.imageGenerationModel !== undefined) store.set('imageGenerationModel', partial.imageGenerationModel.trim())
  if (partial.videoGenerationModel !== undefined) store.set('videoGenerationModel', partial.videoGenerationModel.trim())
  if (partial.memoryAutoExtractionEnabled !== undefined) store.set('memoryAutoExtractionEnabled', partial.memoryAutoExtractionEnabled)
  if (partial.healthAnalysisEnabled !== undefined) store.set('healthAnalysisEnabled', partial.healthAnalysisEnabled)
  if (partial.healthLiveSyncEnabled !== undefined) store.set('healthLiveSyncEnabled', partial.healthLiveSyncEnabled)
  if (partial.fileAccessScope !== undefined) store.set('fileAccessScope', normalizeFileAccessScope(partial.fileAccessScope))
  if (partial.webSearchEnabled !== undefined) store.set('webSearchEnabled', partial.webSearchEnabled)
  if (partial.webSearchProvider !== undefined) store.set('webSearchProvider', partial.webSearchProvider)
  if (partial.webSearchApiKey !== undefined) store.set('webSearchApiKey', partial.webSearchApiKey)
  if (partial.activityIngestEnabled !== undefined) store.set('activityIngestEnabled', partial.activityIngestEnabled)
  if (partial.activitySyncEnabled !== undefined) store.set('activitySyncEnabled', partial.activitySyncEnabled)
  if (partial.activityEmailAllowedAddress !== undefined) store.set('activityEmailAllowedAddress', partial.activityEmailAllowedAddress)
  if (partial.activityKnowledgePermissionPrompted !== undefined) store.set('activityKnowledgePermissionPrompted', partial.activityKnowledgePermissionPrompted)
  if (partial.activityWeatherEnabled !== undefined) store.set('activityWeatherEnabled', partial.activityWeatherEnabled)
  if (partial.activityLocationLatitude !== undefined) store.set('activityLocationLatitude', partial.activityLocationLatitude)
  if (partial.activityLocationLongitude !== undefined) store.set('activityLocationLongitude', partial.activityLocationLongitude)
  if (partial.activityAmazonCookiesStored !== undefined) store.set('activityAmazonCookiesStored', partial.activityAmazonCookiesStored)
  if (partial.documentContextEnabled !== undefined) store.set('documentContextEnabled', partial.documentContextEnabled)
  if (partial.librarySnapshotEnabled !== undefined) store.set('librarySnapshotEnabled', partial.librarySnapshotEnabled)
  if (partial.superContextMemoryEnabled !== undefined) store.set('superContextMemoryEnabled', partial.superContextMemoryEnabled)
  if (partial.timelineEnabled !== undefined) store.set('timelineEnabled', partial.timelineEnabled)
  if (partial.peopleEnabled !== undefined) store.set('peopleEnabled', partial.peopleEnabled)
  if (partial.automationPaused !== undefined) store.set('automationPaused', partial.automationPaused)
  if (partial.requestsPerMinute !== undefined) {
    store.set('requestsPerMinute', Math.max(1, Math.floor(partial.requestsPerMinute)))
  }
}

/**
 * The master switch over the background ticks, read on every tick and inside the
 * fetch layer. Its own accessor rather than a getSettings() field read because
 * the fetch layer consults it per call, and getSettings() rebuilds the whole
 * settings object.
 */
export function isAutomationPaused(): boolean {
  return store.get('automationPaused') ?? false
}

export function getDocumentIndexPause(): DocumentIndexPauseRecord | null {
  const raw = store.get('documentIndexPause')
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<DocumentIndexPauseRecord>
  if (record.scope !== 'project' && record.scope !== 'all' && record.scope !== 'user') return null
  return {
    scope: record.scope,
    projectId: typeof record.projectId === 'string' ? record.projectId : null,
    projectName: typeof record.projectName === 'string' ? record.projectName : null,
    message: typeof record.message === 'string' ? record.message : 'Indexing paused.',
    pausedAt: typeof record.pausedAt === 'string' ? record.pausedAt : new Date().toISOString(),
  }
}

export function setDocumentIndexPause(record: DocumentIndexPauseRecord | null): void {
  store.set('documentIndexPause', record)
}

export function getPeopleIndexPause(): PeopleIndexPauseRecord | null {
  const raw = store.get('peopleIndexPause')
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<PeopleIndexPauseRecord>
  if (typeof record.message !== 'string') return null
  return {
    message: record.message,
    pausedAt: typeof record.pausedAt === 'string' ? record.pausedAt : new Date().toISOString(),
  }
}

export function setPeopleIndexPause(record: PeopleIndexPauseRecord | null): void {
  store.set('peopleIndexPause', record)
}

export function getFileAccessScope(): FileAccessScope {
  return normalizeFileAccessScope(store.get('fileAccessScope'))
}

export function setFileAccessScope(scope: FileAccessScope): void {
  store.set('fileAccessScope', normalizeFileAccessScope(scope))
}

function normalizeFileAccessScope(scope: unknown): FileAccessScope {
  if (!scope || typeof scope !== 'object') return { ...DEFAULT_FILE_ACCESS_SCOPE }
  const raw = scope as Partial<FileAccessScope>
  const mode: FileAccessScopeMode = raw.mode === 'everywhere' ? 'everywhere' : 'custom'
  const roots = Array.isArray(raw.roots)
    ? Array.from(new Set(
        raw.roots
          .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
          .map((root) => root.trim())
      ))
    : []
  return { mode, roots }
}

// Stored configs written before Ollama existed have no `ollamaBaseUrl`, and an
// unrecognized `type` (a downgrade after using Ollama) must not leave the app
// pointing at an endpoint it cannot resolve.
function normalizeProvider(raw: unknown): ProviderConfig {
  const config = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProviderConfig>
  const type: ProviderType =
    config.type === 'custom' || config.type === 'ollama' ? config.type : 'openrouter'
  return {
    type,
    openrouterApiKey: typeof config.openrouterApiKey === 'string' ? config.openrouterApiKey : '',
    customBaseUrl: typeof config.customBaseUrl === 'string' ? config.customBaseUrl : '',
    customApiKey: typeof config.customApiKey === 'string' ? config.customApiKey : '',
    customModel: typeof config.customModel === 'string' ? config.customModel : '',
    ollamaBaseUrl:
      typeof config.ollamaBaseUrl === 'string' && config.ollamaBaseUrl.trim()
        ? config.ollamaBaseUrl.trim()
        : DEFAULT_OLLAMA_BASE_URL,
  }
}

export function getProvider(): ProviderConfig {
  return normalizeProvider(store.get('provider'))
}

export function setProvider(config: ProviderConfig): void {
  const previous = getProvider()
  const next = normalizeProvider(config)
  store.set('provider', next)
  // Topping the account up is usually followed by pasting a key or switching
  // provider, and a block held over from the old credentials would refuse the
  // first call made with the new ones. Only on a real change: re-saving the same
  // settings must not hand an empty account three more calls to spend.
  if (credentialIdentity(previous) !== credentialIdentity(next)) {
    clearProviderCreditBlock()
  }
}

// What the breaker's verdict was about: the endpoint and the key, not the model
// or any other preference stored alongside them.
function credentialIdentity(config: ProviderConfig): string {
  return [config.type, config.openrouterApiKey, config.customApiKey, config.customBaseUrl, config.ollamaBaseUrl].join('|')
}

// The assistant's name is read on nearly every prompt build, so the process-wide
// cache in shared/assistantIdentity is the read path; this keeps it in sync with
// the store.
export function getAssistantName(): string {
  return normalizeAssistantName(store.get('assistantName'))
}

function setStoredAssistantName(name: string): void {
  const normalized = normalizeAssistantName(name)
  store.set('assistantName', normalized)
  setAssistantName(normalized)
}

export function getAssistantIcon(): string {
  const raw = store.get('assistantIcon')
  return typeof raw === 'string' ? raw.trim() : ''
}

function normalizeAssistantIcon(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

const MAX_WELCOME_LINES = 100
const MAX_WELCOME_LINE_LENGTH = 300

function normalizeWelcomeLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, MAX_WELCOME_LINE_LENGTH))
    .filter((line) => line.length > 0)
    .slice(0, MAX_WELCOME_LINES)
}

// Empty means "use the lines bundled with the app" — the renderer owns those
// defaults, so an untouched install stores nothing here.
export function getWelcomeLines(): string[] {
  return normalizeWelcomeLines(store.get('welcomeLines'))
}

// Seeds the shared cache at startup so main-process modules that render the
// assistant's name never see the default when the user has changed it.
setAssistantName(getAssistantName())

export function getModelTiers(): ModelTierConfig {
  return normalizeModelTiers(store.get('modelTiers'))
}

export function setModelTiers(tiers: ModelTierConfig): void {
  store.set('modelTiers', normalizeModelTiers(tiers))
}

export function getDefaultTier(): ModelTier {
  return normalizeModelTier(store.get('defaultTier'))
}

// Resolves the text model for a tier. An unfilled tier falls back to mid rather
// than to nothing, so selecting "frontier" before configuring it degrades to the
// working model instead of failing the run.
export function getTextModel(tier?: ModelTier): string {
  const tiers = getModelTiers()
  const requested = tier ?? getDefaultTier()
  return tiers[requested].textModel || tiers.mid.textModel || DEFAULT_SYSTEM_MODEL
}

// Empty string is the meaningful "no vision model configured" sentinel — callers
// surface an error rather than silently sending images to a text-only model.
export function getVisionModel(tier?: ModelTier): string {
  const tiers = getModelTiers()
  const requested = tier ?? getDefaultTier()
  return tiers[requested].visionModel || tiers.mid.visionModel || ''
}

// Indexing resolves vision differently from chat: a source directory is mixed by
// nature, so a run has to cover BOTH halves — documents via the text model and
// photos via a vision model. Falling through to the empty sentinel here indexed
// the documents and wrote every photo as a "no vision model configured" failure,
// which reads as "photos aren't supported" rather than "finish your settings".
// So indexing gets the same requested-tier -> mid -> default chain as text.
export function getIndexVisionModel(tier?: ModelTier): string {
  return getVisionModel(tier) || DEFAULT_VISION_MODEL
}

export function getImageGenerationModel(): string {
  return (store.get('imageGenerationModel') ?? '').trim()
}

export function getVideoGenerationModel(): string {
  return (store.get('videoGenerationModel') ?? '').trim()
}

export function getWebSearchSettings() {
  return {
    enabled: store.get('webSearchEnabled') ?? false,
    provider: store.get('webSearchProvider') ?? 'tavily',
    apiKey: store.get('webSearchApiKey') ?? '',
  }
}

// The provider's per-key requests-per-minute ceiling. Bulk indexing paces itself
// to this; exceeding it turns into 429s and spurious failure rows.
export function getRequestsPerMinute(): number {
  const raw = store.get('requestsPerMinute')
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_REQUESTS_PER_MINUTE
  return Math.max(1, value)
}

export function isRemoteEnabled(): boolean {
  return store.get('remoteEnabled') ?? false
}

export function setRemoteEnabled(enabled: boolean): void {
  store.set('remoteEnabled', enabled)
}

export function getRemotePort(): number {
  const raw = store.get('remotePort')
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : REMOTE_DEFAULT_PORT
  return value >= 1024 && value <= 65535 ? value : REMOTE_DEFAULT_PORT
}

export function setRemotePort(port: number): void {
  if (!Number.isFinite(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535')
  store.set('remotePort', Math.floor(port))
}

/**
 * The server's long-term identity. Generated once and kept: rotating it would
 * silently invalidate every paired device, which looks like a broken app rather
 * than a security event.
 */
export function getRemoteServerKey(): { publicKey: string; privateKey: string } {
  const existing = store.get('remoteServerKey')
  if (existing && existing.publicKey && existing.privateKey) return existing
  const generated = generateStaticKeyPair()
  store.set('remoteServerKey', generated)
  return generated
}
