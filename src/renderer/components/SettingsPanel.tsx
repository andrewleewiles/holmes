import { type FC, useState, useEffect, useMemo } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faCloudArrowDown,
  faDatabase,
  faFolderOpen,
  faGlobe,
  faPlay,
  faImages,
  faLayerGroup,
  faShieldHalved,
  faSignature,
  faSpinner,
  faTrash,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import type { AppSettings, FileAccessScopeMode, ModelInfo, ModelTier, ModelTierConfig, ProviderConfig, ProviderType, ReasoningEffort, ClaudeImportOptions, ClaudeImportProgress, ClaudeImportResult, WebSearchProvider } from '@shared/types'
import { MODEL_TIERS, modelAcceptsImages } from '@shared/types'
import { MEMORY_CATALOG, MEMORY_CATEGORY_KEYS } from '@shared/memoryCatalog'
import { DEFAULT_ASSISTANT_NAME } from '@shared/assistantIdentity'
import { DEFAULT_OLLAMA_BASE_URL } from '@shared/providerConfig'
import { DEFAULT_WELCOME_LINES, WELCOME_NAME_TOKEN } from '../welcomeLines'
import { ModelSelector } from './ModelSelector'
import { IconPicker } from './IconPicker'
import { AssistantMark } from './AssistantMark'
import { RemoteAccessPanel } from './RemoteAccessPanel'

const EMPTY_MODEL_TIERS: ModelTierConfig = {
  budget: { textModel: '', visionModel: '' },
  mid: { textModel: '', visionModel: '' },
  frontier: { textModel: '', visionModel: '' },
}

const TIER_LABELS: Record<ModelTier, string> = {
  budget: 'Budget',
  mid: 'Mid',
  frontier: 'Frontier',
}

const TIER_HINTS: Record<ModelTier, string> = {
  budget: 'Cheapest pass. Best for large photo trees where volume dominates cost.',
  mid: 'Default for background work — memory, timeline, health and activity synthesis.',
  frontier: 'Highest quality, highest cost. Reserve for small or important sources.',
}

interface SettingsPanelProps {
  settings: AppSettings | null
  models: ModelInfo[]
  onUpdateSettings: (partial: Partial<AppSettings>) => Promise<void>
  onUpdateProvider: (config: ProviderConfig) => Promise<void>
  onClose: () => void
}

export const SettingsPanel: FC<SettingsPanelProps> = ({
  settings,
  models,
  onUpdateSettings,
  onUpdateProvider,
  onClose,
}) => {
  const [providerType, setProviderType] = useState<ProviderType>('openrouter')
  const [openrouterKey, setOpenrouterKey] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customKey, setCustomKey] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState(DEFAULT_OLLAMA_BASE_URL)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME)
  const [assistantIcon, setAssistantIcon] = useState('')
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [welcomeLines, setWelcomeLines] = useState<string[]>([])
  const [showWelcomeEditor, setShowWelcomeEditor] = useState(false)
  const [boilEffectEnabled, setBoilEffectEnabled] = useState(true)
  const [welcomeDraft, setWelcomeDraft] = useState('')
  const [defaultEffort, setDefaultEffort] = useState<ReasoningEffort>('medium')
  const [modelTiers, setModelTiers] = useState<ModelTierConfig>(EMPTY_MODEL_TIERS)
  const [defaultTier, setDefaultTier] = useState<ModelTier>('mid')
  const [requestsPerMinute, setRequestsPerMinute] = useState('20')
  const [imageGenerationModel, setImageGenerationModel] = useState('')
  const [videoGenerationModel, setVideoGenerationModel] = useState('')
  const [memoryAutoExtraction, setMemoryAutoExtraction] = useState(false)
  const [healthAnalysis, setHealthAnalysis] = useState(false)
  const [healthLiveSync, setHealthLiveSync] = useState(false)
  const [webSearch, setWebSearch] = useState(false)
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProvider>('tavily')
  const [webSearchApiKey, setWebSearchApiKey] = useState('')
  const [youtubeApiKey, setYoutubeApiKey] = useState('')
  const [showYoutubeKey, setShowYoutubeKey] = useState(false)
  const [activityIngest, setActivityIngest] = useState(false)
  const [documentContext, setDocumentContext] = useState(false)
  const [librarySnapshot, setLibrarySnapshot] = useState(false)
  const [libraryAutoOrganize, setLibraryAutoOrganize] = useState(true)
  const [superContextMemory, setSuperContextMemory] = useState(false)
  const [timelineEnabled, setTimelineEnabled] = useState(true)
  const [peopleEnabled, setPeopleEnabled] = useState(true)
  const [activityWeather, setActivityWeather] = useState(false)
  const [activityEmailAllowed, setActivityEmailAllowed] = useState('')
  const [activityLocationLat, setActivityLocationLat] = useState('')
  const [activityLocationLng, setActivityLocationLng] = useState('')
  const [activityLocationFetching, setActivityLocationFetching] = useState(false)
  const [activityLocationError, setActivityLocationError] = useState<string | null>(null)
  const [activitySidecarAvailable, setActivitySidecarAvailable] = useState<boolean | null>(null)
  const [activityAmazonCookies, setActivityAmazonCookies] = useState('')
  const [activityAmazonConnected, setActivityAmazonConnected] = useState(false)
  const [activityKnowledgePrompted, setActivityKnowledgePrompted] = useState(false)
  const [activitySavingLocation, setActivitySavingLocation] = useState(false)
  const [activitySavingCookies, setActivitySavingCookies] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)

  const [showImport, setShowImport] = useState(false)
  const [importDirectory, setImportDirectory] = useState('')
  const [importingConversations, setImportingConversations] = useState(true)
  const [importingProjects, setImportingProjects] = useState(true)
  const [importingMemories, setImportingMemories] = useState(true)
  const [importIncludeSensitive, setImportIncludeSensitive] = useState(false)
  const [importCategories, setImportCategories] = useState<string[]>([...MEMORY_CATEGORY_KEYS])
  const [importConfirmed, setImportConfirmed] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<ClaudeImportProgress | null>(null)
  const [importResult, setImportResult] = useState<ClaudeImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    if (!showImport) return
    const unsubscribe = window.electronAPI.importClaude.onProgress((progress) => {
      setImportProgress(progress)
    })
    return unsubscribe
  }, [showImport])

  useEffect(() => {
    if (settings) {
      setProviderType(settings.provider.type)
      setOpenrouterKey(settings.provider.openrouterApiKey)
      setCustomUrl(settings.provider.customBaseUrl)
      setCustomKey(settings.provider.customApiKey)
      setOllamaUrl(settings.provider.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL)
      setTheme(settings.theme)
      setAssistantName(settings.assistantName || DEFAULT_ASSISTANT_NAME)
      setAssistantIcon(settings.assistantIcon ?? '')
      setWelcomeLines(settings.welcomeLines ?? [])
      setBoilEffectEnabled(settings.boilEffectEnabled ?? true)
      setDefaultEffort(settings.defaultEffort || 'medium')
      setModelTiers(settings.modelTiers ?? EMPTY_MODEL_TIERS)
      setDefaultTier(settings.defaultTier ?? 'mid')
      setRequestsPerMinute(String(settings.requestsPerMinute ?? 20))
      setImageGenerationModel(settings.imageGenerationModel ?? '')
      setVideoGenerationModel(settings.videoGenerationModel ?? '')
      setMemoryAutoExtraction(settings.memoryAutoExtractionEnabled ?? false)
      setHealthAnalysis(settings.healthAnalysisEnabled ?? false)
      setHealthLiveSync(settings.healthLiveSyncEnabled ?? false)
      setWebSearch(settings.webSearchEnabled ?? false)
      setWebSearchProvider(settings.webSearchProvider ?? 'tavily')
      setWebSearchApiKey(settings.webSearchApiKey ?? '')
      setYoutubeApiKey(settings.youtubeApiKey ?? '')
      setActivityIngest(settings.activityIngestEnabled ?? false)
      setDocumentContext(settings.documentContextEnabled ?? false)
      setLibrarySnapshot(settings.librarySnapshotEnabled ?? false)
      setLibraryAutoOrganize(settings.libraryAutoOrganizeEnabled ?? true)
      setSuperContextMemory(settings.superContextMemoryEnabled ?? false)
      setTimelineEnabled(settings.timelineEnabled ?? true)
      setPeopleEnabled(settings.peopleEnabled ?? true)
      setActivityWeather(settings.activityWeatherEnabled ?? false)
      setActivityEmailAllowed(settings.activityEmailAllowedAddress ?? '')
      setActivityLocationLat(settings.activityLocationLatitude != null ? String(settings.activityLocationLatitude) : '')
      setActivityLocationLng(settings.activityLocationLongitude != null ? String(settings.activityLocationLongitude) : '')
      setActivityAmazonConnected(settings.activityAmazonCookiesStored ?? false)
      setActivityKnowledgePrompted(settings.activityKnowledgePermissionPrompted ?? false)
    }
  }, [settings])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.activity.sidecarAvailable()
      .then((available) => { if (!cancelled) setActivitySidecarAvailable(available) })
      .catch(() => { if (!cancelled) setActivitySidecarAvailable(null) })
    return () => { cancelled = true }
  }, [])

  // Custom OpenAI-compatible endpoints report no modality data at all, so an
  // empty result means "unknown", not "none" — fall back to the full list there
  // rather than presenting an empty picker.
  const visionCapableModels = useMemo(() => {
    const capable = models.filter(modelAcceptsImages)
    return capable.length > 0 ? capable : models
  }, [models])

  const handleSave = async () => {
    await onUpdateProvider({
      type: providerType,
      openrouterApiKey: openrouterKey,
      customBaseUrl: customUrl,
      customApiKey: customKey,
      customModel: settings?.provider.customModel || '',
      ollamaBaseUrl: ollamaUrl.trim() || DEFAULT_OLLAMA_BASE_URL,
    })
    await onUpdateSettings({
      theme,
      assistantName,
      assistantIcon,
      welcomeLines,
      boilEffectEnabled,
      defaultEffort,
      modelTiers,
      defaultTier,
      requestsPerMinute: Math.max(1, Number(requestsPerMinute) || 20),
      imageGenerationModel,
      videoGenerationModel,
      memoryAutoExtractionEnabled: memoryAutoExtraction,
      healthAnalysisEnabled: healthAnalysis,
      healthLiveSyncEnabled: healthLiveSync,
      webSearchEnabled: webSearch,
      webSearchProvider: webSearchProvider,
      webSearchApiKey: webSearchApiKey,
      youtubeApiKey: youtubeApiKey,
      activityIngestEnabled: activityIngest,
      documentContextEnabled: documentContext,
      librarySnapshotEnabled: librarySnapshot,
      libraryAutoOrganizeEnabled: libraryAutoOrganize,
      superContextMemoryEnabled: superContextMemory,
      timelineEnabled,
      peopleEnabled,
      activityWeatherEnabled: activityWeather,
      activityEmailAllowedAddress: activityEmailAllowed,
      activityLocationLatitude: activityLocationLat.trim() ? Number(activityLocationLat) : null,
      activityLocationLongitude: activityLocationLng.trim() ? Number(activityLocationLng) : null,
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  // The editor is a plain line-per-greeting textarea: the list is short, order
  // does not matter (one is picked at random), and a row-based editor would be
  // more chrome than the content deserves.
  const openWelcomeEditor = () => {
    setWelcomeDraft((welcomeLines.length > 0 ? welcomeLines : DEFAULT_WELCOME_LINES).join('\n'))
    setShowWelcomeEditor(true)
  }

  const saveWelcomeEditor = () => {
    const lines = welcomeDraft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    // Storing nothing is what "use the bundled defaults" means, so clearing the
    // box restores them rather than leaving the greeting blank. Saving an
    // unmodified list stores nothing too, so the app's own lines can still
    // change under a user who never customized them.
    const isDefault =
      lines.length === DEFAULT_WELCOME_LINES.length &&
      lines.every((line, index) => line === DEFAULT_WELCOME_LINES[index])
    setWelcomeLines(isDefault ? [] : lines)
    setShowWelcomeEditor(false)
  }

  const resetWelcomeEditor = () => {
    setWelcomeDraft(DEFAULT_WELCOME_LINES.join('\n'))
  }

  const cleanImportError = (error: unknown): string => {
    if (!(error instanceof Error)) return 'Claude import failed'
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
  }

  const chooseImportDirectory = async () => {
    const directory = await window.electronAPI.app.selectDirectory()
    if (directory) setImportDirectory(directory)
  }

  const handleGrantActivityPermission = async () => {
    try {
      await window.electronAPI.activity.grantPermission()
      setActivityKnowledgePrompted(true)
    } catch {
      // ignore — user can retry
    }
  }

  const handleSaveActivityLocation = async () => {
    setActivitySavingLocation(true)
    try {
      const lat = activityLocationLat.trim() ? Number(activityLocationLat) : null
      const lng = activityLocationLng.trim() ? Number(activityLocationLng) : null
      if (lat != null && lng != null) {
        await window.electronAPI.activity.setLocation(lat, lng)
      }
    } finally {
      setActivitySavingLocation(false)
    }
  }

  const handleFetchCurrentLocation = async () => {
    setActivityLocationFetching(true)
    setActivityLocationError(null)
    try {
      const result = await window.electronAPI.activity.fetchCurrentLocation()
      if (result.status === 'ok') {
        setActivityLocationLat(String(result.fix.lat))
        setActivityLocationLng(String(result.fix.lng))
        await window.electronAPI.activity.setLocation(result.fix.lat, result.fix.lng)
      } else if (result.status === 'needs_permission') {
        setActivityLocationError('Location permission denied. Grant it in System Settings > Privacy & Security > Location Services.')
      } else if (result.status === 'timeout') {
        setActivityLocationError('Could not get a location fix within 10 seconds. Try again.')
      } else if (result.status === 'unavailable') {
        setActivityLocationError('Location sidecar not available. Run pnpm build:sidecar:holmes.')
      }
    } catch (err) {
      setActivityLocationError(err instanceof Error ? err.message : 'Failed to fetch location')
    } finally {
      setActivityLocationFetching(false)
    }
  }

  const handleSaveAmazonCookies = async () => {
    if (!activityAmazonCookies.trim()) return
    setActivitySavingCookies(true)
    try {
      await window.electronAPI.activity.setAmazonCookies(activityAmazonCookies.trim())
      setActivityAmazonCookies('')
      setActivityAmazonConnected(true)
    } finally {
      setActivitySavingCookies(false)
    }
  }

  const handleDisconnectAmazon = async () => {
    await window.electronAPI.activity.clearAmazonCookies()
    setActivityAmazonConnected(false)
  }

  const openImport = () => {
    setImportError(null)
    setImportResult(null)
    setImportProgress(null)
    setImportConfirmed(false)
    setShowImport(true)
  }

  const closeImport = () => {
    if (importing) return
    setShowImport(false)
    setImportProgress(null)
    setImportResult(null)
    setImportError(null)
  }

  const startImport = async () => {
    if (!importDirectory || !importConfirmed) return
    if (!importingConversations && !importingProjects && !importingMemories) return
    setImporting(true)
    setImportError(null)
    setImportResult(null)
    setImportProgress({ phase: 'reading', message: 'Starting Claude import', current: 0, total: 0 })
    try {
      const options: ClaudeImportOptions = {
        importConversations: importingConversations,
        importProjects: importingProjects,
        importMemories: importingMemories,
        includeSensitive: importIncludeSensitive,
        categories: importCategories,
        confirmExternalProcessing: true,
      }
      const result = await window.electronAPI.importClaude.start(importDirectory, options)
      setImportResult(result)
    } catch (error) {
      setImportError(cleanImportError(error))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-holmes-surface rounded-2xl w-[520px] max-h-[80vh] overflow-y-auto border border-white/10 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <h2 className="text-lg font-medium text-white font-serif-display">Settings</h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white text-xl cursor-pointer"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Provider Selection */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-2">AI Provider</label>
            <div className="flex gap-2">
              {([
                { value: 'openrouter', label: 'OpenRouter' },
                { value: 'custom', label: 'Custom' },
                { value: 'ollama', label: 'Ollama' },
              ] as Array<{ value: ProviderType; label: string }>).map((option) => (
                <button
                  key={option.value}
                  onClick={() => setProviderType(option.value)}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                    providerType === option.value
                      ? 'bg-holmes-primary text-white'
                      : 'bg-white/5 text-white/60 hover:bg-holmes-primary/10'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* OpenRouter Settings */}
          {providerType === 'openrouter' && (
            <div>
              <label className="block text-sm font-medium text-white/80 mb-2">
                OpenRouter API Key
              </label>
              <div className="flex gap-2">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={openrouterKey}
                  onChange={(e) => setOpenrouterKey(e.target.value)}
                  placeholder="sk-or-v1-..."
                  className="flex-1 bg-white/10 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30"
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="px-3 py-2 bg-white/10 rounded-lg text-xs text-white/60 hover:bg-white/20 cursor-pointer"
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-white/40">
                Get your API key from{' '}
                <button
                  onClick={() => window.electronAPI.app.openExternal('https://openrouter.ai/keys')}
                  className="text-holmes-primary-light hover:underline cursor-pointer"
                >
                  openrouter.ai/keys
                </button>
              </p>
            </div>
          )}

          {/* Custom Provider Settings */}
          {providerType === 'custom' && (
            <>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-2">
                  Base URL
                </label>
                <input
                  type="text"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full bg-white/10 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-2">
                  API Key
                </label>
                <div className="flex gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={customKey}
                    onChange={(e) => setCustomKey(e.target.value)}
                    placeholder="sk-..."
                    className="flex-1 bg-white/10 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30"
                  />
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="px-3 py-2 bg-white/10 rounded-lg text-xs text-white/60 hover:bg-white/20 cursor-pointer"
                  >
                    {showKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-white/40">
                Must be an OpenAI-compatible API endpoint.
              </p>
            </>
          )}

          {/* Ollama Settings */}
          {providerType === 'ollama' && (
            <div>
              <label className="block text-sm font-medium text-white/80 mb-2">
                Ollama host
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder={DEFAULT_OLLAMA_BASE_URL}
                  className="flex-1 bg-white/10 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30"
                />
                <button
                  onClick={() => setOllamaUrl(DEFAULT_OLLAMA_BASE_URL)}
                  className="px-3 py-2 bg-white/10 rounded-lg text-xs text-white/60 hover:bg-white/20 cursor-pointer"
                >
                  Reset
                </button>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-white/40">
                Runs models on this machine — no API key, no data leaving your Mac. Start the daemon with{' '}
                <code className="rounded bg-white/10 px-1 py-0.5 text-white/60">ollama serve</code> and pull a model with{' '}
                <code className="rounded bg-white/10 px-1 py-0.5 text-white/60">ollama pull llama3.2</code>. Save, then reopen the
                model picker to see what is installed.
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/40">
                Local models are usually smaller than hosted ones: tool calling, image input, and reasoning effort depend on the
                specific model, and effort is not sent to Ollama at all.
              </p>
            </div>
          )}

          {/* Default Effort */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-2">Default Reasoning Effort</label>
            <div className="flex gap-2">
              {(['low', 'medium', 'high'] as ReasoningEffort[]).map((e) => (
                <button
                  key={e}
                  onClick={() => setDefaultEffort(e)}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium capitalize transition-colors cursor-pointer ${
                    defaultEffort === e
                    ? 'bg-holmes-primary text-white'
                    : 'bg-white/5 text-white/60 hover:bg-holmes-primary/10'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          {/* Model tiers */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <FontAwesomeIcon icon={faLayerGroup} className="text-holmes-primary" /> Model tiers
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/40">
                Every system feature runs on a tier rather than a single model. Each tier holds a text model for document and folder synthesis and a vision model for image files, so choosing a tier for an index run fixes both what it costs and how good it is. An empty tier falls back to Mid.
              </p>
            </div>

            <div className="mt-4">
              <label className="block text-sm font-medium text-white/80 mb-2">Default tier</label>
              <div className="flex gap-2">
                {MODEL_TIERS.map((tier) => (
                  <button
                    key={tier}
                    onClick={() => setDefaultTier(tier)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                      defaultTier === tier
                        ? 'bg-holmes-primary text-white'
                        : 'bg-white/5 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    {TIER_LABELS[tier]}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-white/40">
                Used by background work that has no tier of its own — memory extraction, the rolling summary, timeline rebuilds, health and activity synthesis, and chat image attachments.
              </p>
            </div>

            <div className="mt-4">
              <label className="block text-sm font-medium text-white/80 mb-2">Requests per minute</label>
              <input
                type="number"
                min={1}
                value={requestsPerMinute}
                onChange={(e) => setRequestsPerMinute(e.target.value)}
                className="w-28 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/80 focus:border-holmes-primary/50 focus:outline-none"
              />
              <p className="mt-1.5 text-xs text-white/40">
                Your provider's per-key rate limit. Indexing paces itself to this; setting it above the real limit turns into 429s and files recorded as failures. OpenRouter's default allowance is 20. At this rate the cost estimate's duration is set by the limit, not by how many files run in parallel.
              </p>
            </div>

            <div className="mt-4 space-y-4">
              {MODEL_TIERS.map((tier) => (
                <div key={tier} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-white/80">{TIER_LABELS[tier]}</span>
                    {defaultTier === tier && (
                      <span className="text-[10px] uppercase tracking-wide text-holmes-primary-light">Default</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-white/40">{TIER_HINTS[tier]}</p>

                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-white/60 mb-1.5">Text model</label>
                      <div className="[&>div>button]:w-full [&>div>button]:justify-between">
                        <ModelSelector
                          models={models}
                          selectedModel={modelTiers[tier].textModel}
                          onSelect={(id) => setModelTiers((prev) => ({ ...prev, [tier]: { ...prev[tier], textModel: id } }))}
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-white/60 mb-1.5">Vision model</label>
                      <div className="[&>div>button]:w-full [&>div>button]:justify-between">
                        <ModelSelector
                          models={visionCapableModels}
                          selectedModel={modelTiers[tier].visionModel}
                          onSelect={(id) => setModelTiers((prev) => ({ ...prev, [tier]: { ...prev[tier], visionModel: id } }))}
                        />
                      </div>
                    </div>
                  </div>

                  {(modelTiers[tier].textModel || modelTiers[tier].visionModel) && (
                    <button
                      onClick={() => setModelTiers((prev) => ({ ...prev, [tier]: { textModel: '', visionModel: '' } }))}
                      className="mt-2 text-xs text-white/40 hover:text-white transition-colors cursor-pointer"
                    >
                      Clear tier
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Multimodal models */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <FontAwesomeIcon icon={faImages} className="text-holmes-primary" /> Multimodal models
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/40">
                {assistantName} routes a chat turn away from your selected model when it needs a different capability. Asking to generate a picture or a video sends the turn to the matching generation model. Leave either empty to disable that route. Image attachments are handled by the default tier's vision model, set above.
              </p>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/80 mb-2">Photo Generation Model</label>
                <div className="[&>div>button]:w-full [&>div>button]:justify-between">
                  <ModelSelector
                    models={models}
                    selectedModel={imageGenerationModel}
                    onSelect={setImageGenerationModel}
                  />
                </div>
                <div className="mt-1.5 flex items-start justify-between gap-3">
                  <p className="text-xs text-white/40">
                    Used when a message asks you to generate a photo, picture, or illustration. Pick a model with image output. The generated image is saved into the conversation.
                  </p>
                  {imageGenerationModel && (
                    <button
                      onClick={() => setImageGenerationModel('')}
                      className="shrink-0 text-xs text-white/40 hover:text-white transition-colors cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-white/80 mb-2">Video Generation Model</label>
                <div className="[&>div>button]:w-full [&>div>button]:justify-between">
                  <ModelSelector
                    models={models}
                    selectedModel={videoGenerationModel}
                    onSelect={setVideoGenerationModel}
                  />
                </div>
                <div className="mt-1.5 flex items-start justify-between gap-3">
                  <p className="text-xs text-white/40">
                    Used when a message asks you to generate a video or clip. No video generation endpoint is reachable through the OpenAI-compatible chat API that Holmes speaks, so these requests currently fail with an explanation. Leave empty unless your provider adds one.
                  </p>
                  {videoGenerationModel && (
                    <button
                      onClick={() => setVideoGenerationModel('')}
                      className="shrink-0 text-xs text-white/40 hover:text-white transition-colors cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Assistant identity */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <FontAwesomeIcon icon={faSignature} className="text-holmes-primary" /> Identity
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/40">
                What the assistant is called and what it looks like. The name is used in its system prompt and in the
                transcripts that generated contexts are built from, so changing it renames it everywhere, not just on screen.
              </p>
            </div>

            <div className="mt-4 flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-white/60 mb-1.5">Name</label>
                <input
                  type="text"
                  value={assistantName}
                  onChange={(e) => setAssistantName(e.target.value)}
                  onBlur={() => setAssistantName((name) => name.trim() || DEFAULT_ASSISTANT_NAME)}
                  maxLength={40}
                  placeholder={DEFAULT_ASSISTANT_NAME}
                  className="w-full bg-white/10 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-white/60 mb-1.5">Icon</label>
                <button
                  onClick={() => setShowIconPicker((open) => !open)}
                  aria-expanded={showIconPicker}
                  title="Change icon"
                  className="flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-white/10 bg-white/10 text-lg hover:bg-white/20 cursor-pointer"
                >
                  <AssistantMark className="h-5 w-5" />
                </button>
              </div>
              {assistantIcon && (
                <button
                  onClick={() => setAssistantIcon('')}
                  className="pb-2.5 text-xs text-white/40 hover:text-white transition-colors cursor-pointer"
                >
                  Reset icon
                </button>
              )}
            </div>

            {showIconPicker && (
              <div className="mt-3">
                <IconPicker
                  value={assistantIcon}
                  onChange={(icon) => {
                    setAssistantIcon(icon)
                    setShowIconPicker(false)
                  }}
                  onSelectImage={() => window.electronAPI.app.selectImage()}
                />
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-black/10 p-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-white/70">Welcome screen greetings</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-white/40">
                  {welcomeLines.length > 0
                    ? `${welcomeLines.length} custom ${welcomeLines.length === 1 ? 'line' : 'lines'}`
                    : `${DEFAULT_WELCOME_LINES.length} default lines`}
                  {' — one is picked at random each time the home screen opens.'}
                </div>
              </div>
              <button
                onClick={openWelcomeEditor}
                className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/20 cursor-pointer"
              >
                Edit
              </button>
            </div>
          </div>

          {/* Theme */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-2">Theme</label>
            <div className="flex gap-2">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium capitalize transition-colors cursor-pointer ${
                    theme === t
                    ? 'bg-holmes-primary text-white'
                    : 'bg-white/5 text-white/60 hover:bg-holmes-primary/10'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Boiling type */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-serif-display text-sm font-medium text-white/80">Boiling line</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Headings and greetings are set in a hand-drawn face redrawn ten times over, cycling at eight frames a
                  second so the letters shimmer like ink still settling. Icons drawn in the green boil the same way,
                  from ten roughened copies of their own outline. Turning it off freezes both on a single
                  frame — they keep their drawn character, they simply stop moving. Off is also what
                  {' '}{assistantName} does automatically when your system asks for reduced motion.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={boilEffectEnabled}
                  onChange={(e) => setBoilEffectEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-holmes-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* File access scope now lives on the File System source in Data: it is
              that source, so editing it anywhere else would be a second place to
              look for the same setting. */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-white/80">
              <FontAwesomeIcon icon={faShieldHalved} className="text-holmes-primary" /> File access scope
            </div>
            <p className="mt-1 text-xs leading-relaxed text-white/40">
              Moved to the <span className="text-white/55">File System</span> source on the Data page — open it there to
              give Holmes the whole filesystem or limit it to specific folders.
            </p>
          </div>

          {/* Data import */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                  <FontAwesomeIcon icon={faCloudArrowDown} className="text-holmes-primary" /> Import from Claude
                </div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Bring your Claude conversations, projects, and analyzed memories into Holmes. Memories are sent to your configured AI provider for analysis into the Memory catalog.
                </p>
              </div>
              <button
                onClick={openImport}
                className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/60 hover:border-white/20 hover:text-white/80 cursor-pointer"
              >
                Start import
              </button>
            </div>
          </div>

          {/* Auto-extraction */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Auto-extract from conversations</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Automatically analyze conversations after 5 hours of inactivity and populate Memory with new facts. Creates custom fields for information that doesn't fit existing categories. Runs every 30 minutes in the background.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={memoryAutoExtraction}
                  onChange={(e) => setMemoryAutoExtraction(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-holmes-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* Health AI analysis */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Health AI analysis</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Allows the Health project to send your health documents to your configured AI provider for structured analysis. Documents are stored locally; analysis only runs when you click "Analyze with AI" in the Health project.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={healthAnalysis}
                  onChange={(e) => setHealthAnalysis(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-holmes-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* Auto-sync Apple Health */}
          <div className={`rounded-xl border p-4 ${healthAnalysis ? 'border-emerald-400/15 bg-emerald-500/[0.03]' : 'border-white/10 bg-white/[0.03] opacity-60'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Auto-sync Apple Health</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  {healthAnalysis
                    ? 'When the sidecar is built and authorized, the hourly background timer pulls the last 7 days of Apple Health observations (steps, heart rate, sleep, workouts, etc.) and stores them locally as observations. Data never leaves your Mac except during AI summary generation, which is gated by the Health AI analysis setting.'
                    : 'Enable "Health AI analysis" above to configure auto-sync.'}
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={healthLiveSync}
                  onChange={(e) => setHealthLiveSync(e.target.checked)}
                  disabled={!healthAnalysis}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-emerald-500 peer-disabled:opacity-40 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* Web search */}
          <div className={`rounded-xl border p-4 ${webSearch ? 'border-holmes-primary/20 bg-holmes-primary/[0.05]' : 'border-white/10 bg-white/[0.03] opacity-80'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                  <FontAwesomeIcon icon={faGlobe} className="text-holmes-primary" />
                  Web search
                </div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Lets the assistant and the Web Search page query the public web via Tavily. Searches run directly from your Mac; the API key is stored locally and never leaves the app except to call Tavily directly. Search queries are redacted for API keys, passwords, and payment numbers before being sent.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={webSearch}
                  onChange={(e) => setWebSearch(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-holmes-primary transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
            {webSearch && (
              <div className="mt-4 space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Provider</span>
                  <select
                    value={webSearchProvider}
                    onChange={(e) => setWebSearchProvider(e.target.value as WebSearchProvider)}
                    className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none focus:border-holmes-primary/40"
                  >
                    <option value="tavily">Tavily</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Tavily API key</span>
                  <div className="flex overflow-hidden rounded-lg border border-white/10 bg-black/15 focus-within:border-holmes-primary/40">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={webSearchApiKey}
                      onChange={(e) => setWebSearchApiKey(e.target.value)}
                      placeholder="tvly-..."
                      className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="border-l border-white/10 px-3 text-[10px] text-white/40 hover:text-white/70 cursor-pointer"
                    >
                      {showKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <span className="mt-1.5 block text-[10px] leading-relaxed text-white/25">
                    Get a free key at tavily.com — 1,000 searches per month on the free tier.
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Play feed retrieval */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-white/80">
                <FontAwesomeIcon icon={faPlay} className="text-holmes-primary" />
                Play feed
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/40">
                The Play tab suggests videos chosen against your own profile. Holmes turns what it knows about you into search terms, YouTube answers them, and a second pass picks and explains the results. Search terms are redacted for API keys, passwords, and payment numbers before being sent.
              </p>
            </div>
            <div className="mt-4">
              <label className="block">
                <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">YouTube Data API key</span>
                <div className="flex overflow-hidden rounded-lg border border-white/10 bg-black/15 focus-within:border-holmes-primary/40">
                  <input
                    type={showYoutubeKey ? 'text' : 'password'}
                    value={youtubeApiKey}
                    onChange={(e) => setYoutubeApiKey(e.target.value)}
                    placeholder="AIza..."
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowYoutubeKey((v) => !v)}
                    className="border-l border-white/10 px-3 text-[10px] text-white/40 hover:text-white/70 cursor-pointer"
                  >
                    {showYoutubeKey ? 'Hide' : 'Show'}
                  </button>
                </div>
                <span className="mt-1.5 block text-[10px] leading-relaxed text-white/25">
                  Create one in the Google Cloud console and enable YouTube Data API v3. The free tier is 10,000 quota units per day, which is about nine feed refreshes; it resets at midnight Pacific time.
                </span>
              </label>
            </div>
          </div>

          {/* Activity AI analysis */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Activity analysis</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Allows the Activity project to send your browser history, email, app usage, and other activity sources to your configured AI provider for structured analysis. Sources are stored locally; analysis only runs when you trigger it from the Activity project.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={activityIngest}
                  onChange={(e) => setActivityIngest(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-amber-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>

            {activityIngest && (
              <div className="mt-4 space-y-3">
                <label className="flex items-start justify-between gap-3 rounded-lg border border-white/[0.07] bg-black/10 p-3">
                  <span>
                    <span className="block text-xs text-white/70">Weather history</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-white/35">Fetch local weather observations for mood/health correlations. Uses your saved location.</span>
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      checked={activityWeather}
                      onChange={(e) => setActivityWeather(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-amber-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
                  </label>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-white/35">Your email address (for redaction allowlist)</span>
                  <input
                    type="email"
                    value={activityEmailAllowed}
                    onChange={(e) => setActivityEmailAllowed(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/70 outline-none placeholder:text-white/20 focus:border-amber-400/40"
                  />
                  <span className="mt-1.5 block text-[10px] leading-relaxed text-white/25">
                    Addresses on this list are kept in email exports; other addresses are hashed for privacy before analysis.
                  </span>
                </label>

                <div className="rounded-lg border border-white/[0.07] bg-black/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs text-white/70">Full Disk Access</div>
                      <div className="mt-0.5 text-[10px] leading-relaxed text-white/35">
                        Required to read Safari history, iMessage metadata, Photos library, and knowledge (app usage). macOS still protects these folders via TCC.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleGrantActivityPermission()}
                      className="shrink-0 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200/80 hover:border-amber-400/50 cursor-pointer"
                    >
                      {activityKnowledgePrompted ? 'Reveal in System Settings' : 'Grant Full Disk Access'}
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-white/[0.07] bg-black/10 p-3">
                  <div className="text-xs text-white/70">Amazon connection</div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-white/35">
                    Paste Amazon cookies (from a browser extension) to import order history. Cookies are stored locally and never leave your Mac except to call Amazon directly.
                  </div>
                  {activityAmazonConnected ? (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-emerald-300/80">Amazon cookies stored.</span>
                      <button
                        type="button"
                        onClick={() => void handleDisconnectAmazon()}
                        className="text-[10px] text-white/40 hover:text-red-300 cursor-pointer"
                      >
                        Disconnect Amazon
                      </button>
                    </div>
                  ) : (
                    <>
                      <textarea
                        value={activityAmazonCookies}
                        onChange={(e) => setActivityAmazonCookies(e.target.value)}
                        rows={3}
                        placeholder="Paste cookie header, e.g. ubid-main=...; session-id=..."
                        className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-[11px] text-white/70 outline-none placeholder:text-white/20 focus:border-amber-400/40"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveAmazonCookies()}
                        disabled={!activityAmazonCookies.trim() || activitySavingCookies}
                        className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200/80 hover:border-amber-400/50 disabled:opacity-40 cursor-pointer"
                      >
                        {activitySavingCookies ? 'Saving…' : 'Save Amazon cookies'}
                      </button>
                    </>
                  )}
                </div>

                <div className="rounded-lg border border-white/[0.07] bg-black/10 p-3">
                  <div className="text-xs text-white/70">Location</div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-white/35">
                    Used for weather history and location patterns. Set manually or use your current location via the bundled CoreLocation sidecar.
                    {activitySidecarAvailable === false && ' (Sidecar not built — run pnpm build:sidecar:holmes.)'}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      step="any"
                      value={activityLocationLat}
                      onChange={(e) => setActivityLocationLat(e.target.value)}
                      placeholder="lat"
                      className="w-24 rounded-lg border border-white/10 bg-black/15 px-2 py-2 text-[11px] text-white/70 outline-none placeholder:text-white/20 focus:border-amber-400/40"
                    />
                    <input
                      type="number"
                      step="any"
                      value={activityLocationLng}
                      onChange={(e) => setActivityLocationLng(e.target.value)}
                      placeholder="lng"
                      className="w-24 rounded-lg border border-white/10 bg-black/15 px-2 py-2 text-[11px] text-white/70 outline-none placeholder:text-white/20 focus:border-amber-400/40"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveActivityLocation()}
                      disabled={activitySavingLocation || !activityLocationLat.trim() || !activityLocationLng.trim()}
                      className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200/80 hover:border-amber-400/50 disabled:opacity-40 cursor-pointer"
                    >
                      {activitySavingLocation ? 'Saving…' : 'Set location'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleFetchCurrentLocation()}
                      disabled={activityLocationFetching || activitySidecarAvailable === false}
                      className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200/80 hover:border-amber-400/50 disabled:opacity-40 cursor-pointer"
                    >
                      {activityLocationFetching ? 'Locating…' : 'Use current location'}
                    </button>
                  </div>
                  {activityLocationError && (
                    <div className="mt-2 text-[10px] text-red-300/80">{activityLocationError}</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Document context */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Document context</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Builds a hierarchical AI index of any project with a connected directory: a short context per file, rolled up into folder-by-folder super-contexts. Content is redacted before it is sent to your AI provider, unchanged files are cached, and the root super-context grounds project chats. Runs when you trigger it from the Data page or hourly in the background.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={documentContext}
                  onChange={(e) => setDocumentContext(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-cyan-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          <RemoteAccessPanel />

          {/* Reading record */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Reading record</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Lets Holmes summarize your e-book library into your profile and timeline — what you acquire, start, abandon and finish, and how your subjects shift. It is given titles, authors, stated subjects and dates only: <span className="text-white/55">the text of your books is never sent anywhere</span>. Reading, scanning and the Library itself work whether this is on or off, and nothing runs until you press Refresh on the Books source.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={librarySnapshot}
                  onChange={(e) => setLibrarySnapshot(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-violet-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* Auto-file new books */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">File new books automatically</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  After a library scan, moves newly found books into <span className="text-white/55">[Author] - [Title]</span> folders inside their connected folder, the same way the Organise button does. Only books whose author is confidently identified are moved — everything else stays put for a reviewed Organise — and each book is considered once, so rescanning an unchanged shelf costs nothing. Needs a configured provider; the folder names come from a model call over the book&apos;s metadata.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={libraryAutoOrganize}
                  onChange={(e) => setLibraryAutoOrganize(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-violet-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* Populate Memory from super-contexts */}
          <div className={`rounded-xl border p-4 ${documentContext ? 'border-cyan-400/15 bg-cyan-500/[0.03]' : 'border-white/10 bg-white/[0.03] opacity-60'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Populate Memory from super-contexts</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  {documentContext
                    ? 'When a project super-context or the unified user super-context is regenerated, analyze it and fill Memory from it, creating new custom fields for facts no existing field covers. The synthesis is redacted before it is sent, sensitive categories (health, finances, contact, relationships, household) are excluded, and re-running on unchanged data does nothing.'
                    : 'Enable "Document context" above to configure Memory population.'}
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={superContextMemory}
                  onChange={(e) => setSuperContextMemory(e.target.checked)}
                  disabled={!documentContext}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-cyan-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* Timeline */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">Timeline</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Builds a dated timeline of your life from every context {assistantName} has already generated — document indexes, health, activity, finances and memory all emit their own dated entries, which are merged here at the precision each source actually supports. Harvesting runs locally; only the era narrative calls your AI provider, and only when the events have changed. The timeline is also given to the assistant as chat context.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={timelineEnabled}
                  onChange={(e) => setTimelineEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-sky-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>

          {/* People */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white/80">People</div>
                <p className="mt-1 text-xs leading-relaxed text-white/40">
                  Builds a record of the individuals in your life and how they relate to you, from your Contacts, your message history and every context {assistantName} has already generated. Resolution runs locally and errs toward keeping two records apart rather than merging the wrong people; only the per-person profiles call your AI provider, and only when someone&rsquo;s evidence has changed. The result is given to the assistant as chat context. These are real people who did not consent to being profiled — everything stays on this machine, and turning this off removes it from chat.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={peopleEnabled}
                  onChange={(e) => setPeopleEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-white/10 rounded-full peer peer-checked:bg-rose-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-transform peer-checked:after:translate-x-5"></div>
              </label>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 p-5 border-t border-white/10">
          {saved && <span className="text-sm text-green-400">Saved!</span>}
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-white/60 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-holmes-primary hover:bg-holmes-primary-dark text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>

      {showImport && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] p-5">
              <div>
                <h2 className="flex items-center gap-2 text-base font-medium text-white/80 font-serif-display">
                  <FontAwesomeIcon icon={faCloudArrowDown} className="text-holmes-primary" /> Import from Claude
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-white/35">
                  Select the folder exported from Claude (containing conversations.json, memories.json, and a projects/ directory).
                </p>
              </div>
              {!importing && <button onClick={closeImport} className="text-white/30 hover:text-white/60 cursor-pointer"><FontAwesomeIcon icon={faXmark} /></button>}
            </div>

            <div className="space-y-5 p-5">
              {importError && (
                <div className="flex items-start gap-3 rounded-xl border border-red-400/20 bg-red-400/[0.07] p-3 text-xs text-red-100/70">
                  <span className="min-w-0 flex-1">{importError}</span>
                  <button onClick={() => setImportError(null)} className="text-red-100/35 hover:text-red-100 cursor-pointer">Dismiss</button>
                </div>
              )}

              {importResult && (
                <div className="rounded-xl border border-holmes-primary/20 bg-holmes-primary/[0.07] p-4 text-xs text-holmes-primary-light/80">
                  <div className="mb-2 flex items-center gap-2 text-white/70"><FontAwesomeIcon icon={faDatabase} className="text-holmes-primary" /> Import complete</div>
                  <ul className="space-y-1 text-white/55">
                    <li>Projects: {importResult.projectsImported} imported{importResult.projectsSkipped ? `, ${importResult.projectsSkipped} skipped` : ''}</li>
                    <li>Conversations: {importResult.conversationsImported} imported{importResult.conversationsSkipped ? `, ${importResult.conversationsSkipped} skipped` : ''} ({importResult.messagesImported} messages)</li>
                    <li>
                      Memory: {importResult.memorySkipped
                        ? importResult.memoryError
                          ? `skipped — ${importResult.memoryError}`
                          : 'skipped (no memories.json or no analyzable fields)'
                        : `${importResult.memoryAutoFilled} auto-filled, ${importResult.memorySuggestionsCreated} suggestions, ${importResult.memoryCandidatesFound} facts found${importResult.memoryModel ? ` via ${importResult.memoryModel}` : ''}`}
                    </li>
                  </ul>
                </div>
              )}

              <div>
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35">Export folder</h3>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={importDirectory}
                    onChange={() => {}}
                    readOnly
                    placeholder="No folder selected"
                    className="flex-1 rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-xs text-white/60 outline-none placeholder:text-white/20"
                  />
                  <button
                    onClick={() => void chooseImportDirectory()}
                    disabled={importing}
                    className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/60 hover:border-white/20 hover:text-white/80 disabled:opacity-40 cursor-pointer"
                  >
                    <FontAwesomeIcon icon={faFolderOpen} /> Choose
                  </button>
                </div>
              </div>

              <div>
                <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35">What to import</h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    ['Conversations', importingConversations, setImportingConversations],
                    ['Projects', importingProjects, setImportingProjects],
                    ['Memories', importingMemories, setImportingMemories],
                  ].map(([label, checked, setter]) => (
                    <label key={String(label)} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-black/10 p-3">
                      <input
                        type="checkbox"
                        checked={checked as boolean}
                        onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)}
                        disabled={importing}
                        className="mt-0.5 accent-holmes-primary"
                      />
                      <span className="text-xs text-white/60">{label as string}</span>
                    </label>
                  ))}
                </div>
              </div>

              {importingMemories && (
                <>
                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-[10px] font-medium uppercase tracking-wider text-white/35">Memory categories</h3>
                      <button
                        onClick={() => {
                          setImportCategories(importCategories.length === MEMORY_CATEGORY_KEYS.length ? [] : [...MEMORY_CATEGORY_KEYS])
                          setImportConfirmed(false)
                        }}
                        disabled={importing}
                        className="text-[10px] text-holmes-primary-light/60 hover:text-holmes-primary-light cursor-pointer"
                      >
                        {importCategories.length === MEMORY_CATEGORY_KEYS.length ? 'Clear all' : 'Select all'}
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {MEMORY_CATALOG.map((item) => {
                        const selected = importCategories.includes(item.key)
                        return (
                          <button
                            key={item.key}
                            onClick={() => {
                              setImportCategories((current) => selected
                                ? current.filter((key) => key !== item.key)
                                : [...current, item.key])
                              setImportConfirmed(false)
                            }}
                            disabled={importing}
                            className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors cursor-pointer ${
                              selected
                                ? 'border-holmes-primary/30 bg-holmes-primary/10 text-holmes-primary-light'
                                : 'border-white/[0.07] text-white/25'
                            }`}
                          >
                            {item.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3">
                    <input
                      type="checkbox"
                      checked={importIncludeSensitive}
                      onChange={(event) => setImportIncludeSensitive(event.target.checked)}
                      disabled={importing}
                      className="mt-0.5 accent-holmes-primary"
                    />
                    <span>
                      <span className="block text-xs text-amber-100/65">Include sensitive fields</span>
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-white/30">Allows analysis into health, financial, contact, location, and relationship fields.</span>
                    </span>
                  </label>

                  <div className="rounded-xl border border-white/[0.07] bg-black/10 p-4 text-[10px] leading-relaxed text-white/35">
                    <div className="mb-2 flex items-center gap-2 text-white/55"><FontAwesomeIcon icon={faWandMagicSparkles} className="text-holmes-primary" /> Processing disclosure</div>
                    Claude memory summaries are plain text exported from your Claude account. Holmes will send bounded excerpts to your configured AI provider to extract facts into the Memory catalog. Existing Memory values are never overwritten without review. Nothing is uploaded except the memory summaries and selected Memory field descriptions.
                  </div>

                  <label className="flex cursor-pointer items-start gap-2 text-[10px] leading-relaxed text-white/45">
                    <input
                      type="checkbox"
                      checked={importConfirmed}
                      onChange={(event) => setImportConfirmed(event.target.checked)}
                      disabled={importing}
                      className="mt-0.5 accent-holmes-primary"
                    />
                    I understand the Claude memory summaries will be sent to my configured AI provider and Memory is stored locally in an unencrypted database.
                  </label>
                </>
              )}

              {importing && importProgress && (
                <div className="rounded-xl border border-white/[0.07] bg-black/10 p-4">
                  <div className="flex items-center gap-2 text-xs text-white/55">
                    <FontAwesomeIcon icon={faSpinner} spin className="text-holmes-primary" />
                    <span className="capitalize">{importProgress.phase}</span>
                    <span className="text-white/35">— {importProgress.message}</span>
                  </div>
                  {importProgress.total > 0 && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full bg-holmes-primary transition-all"
                        style={{ width: `${Math.min(100, Math.round((importProgress.current / importProgress.total) * 100))}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4">
                {importing ? (
                  <button onClick={() => void window.electronAPI.importClaude.abort()} className="rounded-lg border border-red-300/15 px-3 py-2 text-xs text-red-200/60 cursor-pointer">Cancel import</button>
                ) : (
                  <>
                    <button onClick={closeImport} className="px-3 py-2 text-xs text-white/35 hover:text-white/60 cursor-pointer">Close</button>
                    <button
                      onClick={() => void startImport()}
                      disabled={!importDirectory || !importConfirmed || (!importingConversations && !importingProjects && !importingMemories) || (importingMemories && importCategories.length === 0)}
                      className="rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                    >
                      Start import
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showWelcomeEditor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6">
          <div className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 p-5">
              <h2 className="text-base font-medium text-white font-serif-display">Welcome screen greetings</h2>
              <button
                onClick={() => setShowWelcomeEditor(false)}
                className="text-white/40 hover:text-white text-xl cursor-pointer"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
              <p className="text-xs leading-relaxed text-white/40">
                One greeting per line. The home screen shows a random one each time it opens. Write{' '}
                <code className="rounded bg-white/10 px-1 py-0.5 text-white/60">{WELCOME_NAME_TOKEN}</code> where the
                user's first name should appear.
              </p>
              <textarea
                value={welcomeDraft}
                onChange={(e) => setWelcomeDraft(e.target.value)}
                spellCheck={false}
                className="min-h-[240px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs leading-relaxed text-white/80 outline-none scrollbar-thin focus:border-white/30"
                placeholder={`It is upon logic that you should dwell.\nThe game is afoot.`}
              />
              <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-4">
                <button
                  onClick={resetWelcomeEditor}
                  className="px-3 py-2 text-xs text-white/35 hover:text-white/60 cursor-pointer"
                >
                  Restore defaults
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowWelcomeEditor(false)}
                    className="px-3 py-2 text-xs text-white/35 hover:text-white/60 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveWelcomeEditor}
                    className="rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light cursor-pointer"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
