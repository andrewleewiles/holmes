import { type FC, useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGear, faHeart, faHouse, faTableColumns } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment, ContextSelection, ReasoningEffort, Project, PsychologicalTestId } from '@shared/types'
import { hasProviderCredentials } from '@shared/providerConfig'
import { stackedProjectIds } from '@shared/contextSelection'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { WelcomeScreen } from './components/WelcomeScreen'
import { NewConversationScreen } from './components/NewConversationScreen'
import { Dashboard } from './components/Dashboard'
import { ProjectsPage } from './components/ProjectsPage'
import { ProductSearchPage } from './components/ProductSearchPage'
import { WebSearchPage } from './components/WebSearchPage'
import { RecallPage } from './components/RecallPage'
import { MemoryPage } from './components/MemoryPage'
import { PsychologyPage } from './components/PsychologyPage'
import { HealthPage } from './components/HealthPage'
import { ActivityPage } from './components/ActivityPage'
import { DataPage } from './components/DataPage'
import { TimelinePage } from './components/TimelinePage'
import { WorkPage } from './components/WorkPage'
import { WorkspaceView } from './components/WorkspaceView'
import type { EditorFrameHandle } from './components/WorkspaceView'
import { PaperSaveDialog } from './components/PaperSaveDialog'
import type { PaperState } from './components/OfficeEditorFrame'
import { isWorkDocumentKind, type WorkDocumentKind } from '@shared/workDocuments'
import { getWorkRole } from '@shared/workRoles'
import { LibraryPage } from './components/LibraryPage'
import { PlayPage } from './components/PlayPage'
import { CallHistoryPage } from './components/CallHistoryPage'
import { ChatHistoryPage } from './components/ChatHistoryPage'
import { SettingsPanel } from './components/SettingsPanel'
import { ProviderCreditBanner } from './components/ProviderCreditBanner'
import { useChat } from './hooks/useChat'
import { useSettings } from './hooks/useSettings'
import { useChatStore } from './store/chatStore'
import { useSettingsStore } from './store/settingsStore'
import { isDefaultProjectName } from '@shared/defaultProjects'
import { startIconBoil } from './boil/iconBoil'

const App: FC = () => {
  const {
    conversations,
    currentConversation,
    currentConversationId,
    messages,
    isStreaming,
    streamingText,
    streamingReasoning,
    streamingToolInteractions,
    error,
    activeModel,
    activeEffort,
    selectedModel,
    selectedEffort,
    memoryMode,
    selectedContext,
    selectedRoleId,
    lastSystemPrompt,
    loadConversations,
    startDraftConversation,
    deleteConversation,
    renameConversation,
    updateConversationModel,
    updateConversationEffort,
    selectConversation,
    sendMessage,
    editMessage,
    retryMessage,
    setActiveBranch,
    abortStream,
    clearError,
    setSelectedModel,
    setSelectedEffort,
    setMemoryMode,
    setSelectedContext,
    setSelectedRole,
  } = useChat()

  const {
    settings,
    models,
    showSettings,
    loadSettings,
    updateSettings,
    updateProvider,
    loadModels,
    toggleSettings,
    closeSettings,
  } = useSettings()

  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [projects, setProjects] = useState<Project[]>([])
  const [showRecall, setShowRecall] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [showDashboard, setShowDashboard] = useState(false)
  const [showProductSearch, setShowProductSearch] = useState(false)
  const [showWebSearch, setShowWebSearch] = useState(false)
  const [webSearchPendingQuery, setWebSearchPendingQuery] = useState<string | undefined>(undefined)
  const [showMemory, setShowMemory] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showPlay, setShowPlay] = useState(false)
  const [showWork, setShowWork] = useState(false)
  // Which "New …" the sidebar asked for; null means Work was opened on its own.
  const [workKind, setWorkKind] = useState<WorkDocumentKind | null>(null)
  // The role and tool the sidebar last invoked, so the page can name them.
  const [workTool, setWorkTool] = useState<{ tool: string; roleId: string } | null>(null)
  // The sidebar's project filter. It scopes the conversation list AND decides
  // where a Work document is saved, so it lives here rather than in Sidebar.
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null)
  // A work_create_document tool call, waiting on the editor to come up. The
  // answer is deferred until the frame reports ready so the model's next call
  // lands on a live document instead of racing a cold start.
  const pendingWorkOpen = useRef<string | null>(null)
  // The conversation that asked for the document, shown alongside it.
  const [workConversationId, setWorkConversationId] = useState<string | null>(null)
  const workEditorRef = useRef<EditorFrameHandle>(null)
  const [workSaving, setWorkSaving] = useState(false)
  const [workSavedPath, setWorkSavedPath] = useState<string | null>(null)
  const [workSaveError, setWorkSaveError] = useState<string | null>(null)
  const [workDirty, setWorkDirty] = useState(false)
  // Non-null while the save dialog is up; holds what the shell reported.
  const [workPaperPrompt, setWorkPaperPrompt] = useState<PaperState | null>(null)
  // The answer, kept for every later save of the same document — the dialog
  // asks once, but the rewrite has to be applied to every export after it.
  const [workPaperChoice, setWorkPaperChoice] = useState<'keep' | 'plain' | null>(null)
  // What counts as work in flight: a turn Holmes is midway through (which may
  // be mid tool-call against the document), a save partway through, or edits
  // that are not on disk yet. Tearing the editor down in any of those states
  // destroys something; tearing it down otherwise just frees a wasm heap.
  const workBusy = isStreaming || workSaving || workDirty
  const [showCallHistory, setShowCallHistory] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // A draft opened with its settings already chosen (Mental Coach) rather than
  // from the home screen. Only meaningful while there is no conversation yet:
  // it decides which of the two start screens the draft shows.
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [psychologyProjectId, setPsychologyProjectId] = useState<string | null>(null)
  const [healthProjectId, setHealthProjectId] = useState<string | null>(null)
  const [activityProjectId, setActivityProjectId] = useState<string | null>(null)
  // The Data page is a view of every source, not a project of its own.
  const [showData, setShowData] = useState(false)
  const [dataFocusProjectId, setDataFocusProjectId] = useState<string | null>(null)
  const psychologyProject = projects.find((project) => project.id === psychologyProjectId)
  const healthProject = projects.find((project) => project.id === healthProjectId)
  const activityProject = projects.find((project) => project.id === activityProjectId)
  // Hidden sources are switched off everywhere but the Data page, which is the
  // one place they can be switched back on.
  const visibleProjects = projects.filter((project) => project.visible)
  const defaultProjects = visibleProjects.filter((project) => isDefaultProjectName(project.name))
  const userProjects = visibleProjects.filter((project) => !isDefaultProjectName(project.name))

  useEffect(() => {
    if (settings?.defaultModel) {
      setSelectedModel(settings.defaultModel)
    } else if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].id)
      void updateSettings({ defaultModel: models[0].id })
    }
  }, [models, settings?.defaultModel])

  useEffect(() => {
    if (settings?.defaultEffort) {
      setSelectedEffort(settings.defaultEffort)
    }
  }, [settings?.defaultEffort])

  // index.css freezes the boiling display face on `:root[data-boil='off']`, so
  // the switch is one attribute rather than a class on every heading.
  useEffect(() => {
    const off = settings?.boilEffectEnabled === false
    if (off) document.documentElement.setAttribute('data-boil', 'off')
    else document.documentElement.removeAttribute('data-boil')
  }, [settings?.boilEffectEnabled])

  // Icons drawn in the turquoise boil too, driven from here rather than from
  // the 200-odd places that render one. It reads the same data-boil attribute
  // the display face does, so the Settings switch covers both.
  useEffect(() => startIconBoil().stop, [])

  useEffect(() => {
    loadSettings().then(() => {
      return loadConversations()
    })
  }, [])

  useEffect(() => {
    window.electronAPI.projects.list().then(setProjects)
  }, [])

  // Holmes asking to open a document — from a conversation anywhere in the app.
  useEffect(() => {
    return window.electronAPI.work.onOpenDocument((request) => {
      const kind = request.payload?.kind
      pendingWorkOpen.current = request.requestId
      // Whatever the user is talking in right now is the conversation that
      // routed here; it travels with the document.
      setWorkConversationId(useChatStore.getState().currentConversationId)
      handleWork(isWorkDocumentKind(kind) ? kind : 'document')
    })
  }, [])

  // Once the workspace is torn down, forget it. Otherwise returning to Work
  // would remount and open a NEW blank document while still looking like the
  // one that was there — the picker is the honest thing to show instead.
  useEffect(() => {
    if (showWork || workBusy || !workKind) return
    setWorkKind(null)
    setWorkTool(null)
    setWorkSavedPath(null)
    setWorkSaveError(null)
    setWorkConversationId(null)
    setWorkDirty(false)
    setWorkPaperPrompt(null)
    setWorkPaperChoice(null)
  }, [showWork, workBusy, workKind])

  // Answer the tool call once the editor can actually take an edit.
  const handleWorkEditorReady = (ready: boolean) => {
    const requestId = pendingWorkOpen.current
    if (!ready || !requestId) return
    pendingWorkOpen.current = null
    void (async () => {
      // Order matters: main gates the work_* editing tools on isEditorOpen(),
      // and recomputes them at the top of each tool round. Answering first
      // would let the next round start before main knows the editor is live,
      // so the model would be told the document exists and simultaneously be
      // offered no way to write to it. The kind rides along so main offers the
      // right tool set — office, raster or vector.
      await window.electronAPI.work.setEditorOpen(true, workKind ?? undefined)
      await window.electronAPI.work.respondToEditor({ requestId, ok: true, value: { opened: true } })
    })()
  }

  const handleProjectUpdate = async (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => {
    await window.electronAPI.projects.update(id, data)
    const list = await window.electronAPI.projects.list()
    setProjects(list)
  }

  const handleProjectDelete = async (id: string) => {
    await window.electronAPI.projects.delete(id)
    const list = await window.electronAPI.projects.list()
    setProjects(list)
  }

  const handleReorderProjects = async (orderedIds: string[]) => {
    setProjects(await window.electronAPI.projects.reorder(orderedIds))
  }

  const handleAddSource = async (projectId: string, sourcePath: string) => {
    await window.electronAPI.projects.addSource(projectId, sourcePath)
    setProjects(await window.electronAPI.projects.list())
  }

  const handleRemoveSource = async (projectId: string, sourcePath: string) => {
    await window.electronAPI.projects.removeSource(projectId, sourcePath)
    setProjects(await window.electronAPI.projects.list())
  }

  const handleAddFile = async (projectId: string, filePath: string) => {
    await window.electronAPI.projects.addFile(projectId, filePath)
    const list = await window.electronAPI.projects.list()
    setProjects(list)
  }

  const handleRemoveFile = async (projectId: string, filePath: string) => {
    await window.electronAPI.projects.removeFile(projectId, filePath)
    const list = await window.electronAPI.projects.list()
    setProjects(list)
  }

  const handleAnalyzePsychology = async (projectId: string) => {
    const analysis = await window.electronAPI.projects.analyzePsychology(projectId)
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, analysis } : p))
    )
  }

  const handleAnalyzeHealth = async (projectId: string) => {
    const analysis = await window.electronAPI.projects.analyzeHealth(projectId)
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? { ...p, healthAnalysis: analysis } : p))
    )
  }

  const handleCreateProject = async (data: { name: string; icon: string; color: string }): Promise<Project> => {
    const created = await window.electronAPI.projects.create({
      name: data.name,
      icon: data.icon,
      color: data.color,
      path: null,
      sources: [],
      files: [],
      analysis: null,
      healthAnalysis: null,
      activityAnalysis: null,
      financesSummary: null,
    })
    const list = await window.electronAPI.projects.list()
    setProjects(list)
    return created
  }

  const handleProjects = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowProjects(true)
  }

  const handleDashboard = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowDashboard(true)
  }

  const handleHome = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    closeSettings()
    useChatStore.setState({
      currentConversationId: null,
      messages: [],
      streamingText: '',
      streamingReasoning: '',
      streamingToolInteractions: [],
      error: null,
    })
  }

  const handleProductSearch = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowProductSearch(true)
  }

  const handleWebSearch = (initialQuery?: string) => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    if (initialQuery) setWebSearchPendingQuery(initialQuery)
    setShowWebSearch(true)
  }

  const handleRecall = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowRecall(true)
  }

  const handleMemory = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowMemory(true)
  }

  const handleTimeline = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowTimeline(true)
  }

  // A kind means the sidebar asked for a new one; null just opens the page.
  const handleWork = (kind: WorkDocumentKind | null) => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setWorkKind(kind)
    setWorkTool(null)
    setShowWork(true)
  }

  const handleWorkTool = (tool: string, roleId: string) => {
    handleWork(null)
    setWorkTool({ tool, roleId })
  }

  /**
   * Saving a document that is being shown in paper mode asks first.
   *
   * The question has to be answered before the export, not after: `exportDocument`
   * runs the in-memory document through x2t, so whichever way the user answers
   * has to already be in the document by then. Hence the two-step — this opens
   * the dialog and returns, and `handleWorkPaperChoice` restarts the save.
   */
  const handleWorkSave = async () => {
    if (!workEditorRef.current || workSaving || workPaperPrompt) return
    const paper = await workEditorRef.current.paperState?.()
    if (paper?.paper && !paper.settled) {
      setWorkPaperPrompt(paper)
      return
    }
    await writeWorkDocument()
  }

  const handleWorkPaperChoice = async (keep: boolean) => {
    const editor = workEditorRef.current
    const choice = keep ? 'keep' : 'plain'
    setWorkPaperPrompt(null)
    setWorkPaperChoice(choice)
    // Tells the shell to stop asking and, for 'plain', to stop showing the
    // document as Holmes. The rewrite itself happens in main, on the bytes.
    if (keep) void editor?.keepPaper?.()
    else void editor?.dropPaper?.()
    await writeWorkDocument(choice)
  }

  const writeWorkDocument = async (paper: 'keep' | 'plain' | null = workPaperChoice) => {
    if (!workEditorRef.current || workSaving) return
    setWorkSaving(true)
    setWorkSaveError(null)
    try {
      const { bytes, fileName } = await workEditorRef.current.exportDocument()
      const result = await window.electronAPI.work.saveDocument({
        projectId: filterProjectId,
        fileName,
        bytes,
        ...(paper ? { paper } : {}),
        ...(workSavedPath ? { existingPath: workSavedPath } : {}),
      })
      setWorkSavedPath(result.path)
      setWorkDirty(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Backing out of the system dialog is not a failure worth reporting.
      if (!/cancel/i.test(message)) setWorkSaveError(message)
    } finally {
      setWorkSaving(false)
    }
  }

  const handleLibrary = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowWork(false)
    setShowPlay(false)
    setShowLibrary(true)
  }

  const handlePlay = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setShowWork(false)
    setShowLibrary(false)
    setShowPlay(true)
  }

  const handleCallHistory = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowHistory(false)
    setShowCallHistory(true)
  }

  const handleHistory = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(true)
  }

  /**
   * Opens a fresh therapy session rather than the Psychology page: a new
   * conversation preset to detailed memory, the Psychology project as context,
   * and the Therapist role. It stays a draft until the first message like any
   * other new chat, but shows the new-conversation screen instead of the home
   * screen — the ideas there would only steer the session elsewhere. The
   * Psychology page itself is still reached from Data.
   */
  const handleMentalCoach = () => {
    const project = projects.find((candidate) => candidate.name === 'Psychology')
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    startDraftConversation()
    setShowNewConversation(true)
    setMemoryMode('detailed')
    // No Psychology project means a broken default install; the role and memory
    // preset still apply rather than clearing whatever context was selected.
    if (project) setSelectedContext({ kind: 'project', projectId: project.id })
    setSelectedRole('therapist')
  }

  const handleHealth = () => {
    const project = projects.find((candidate) => candidate.name === 'Health')
    if (!project) {
      handleDashboard()
      return
    }
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setHealthProjectId(project.id)
  }

  const handleActivity = () => {
    const project = projects.find((candidate) => candidate.name === 'Activity')
    if (!project) {
      handleDashboard()
      return
    }
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setActivityProjectId(project.id)
  }

  const handleData = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    setDataFocusProjectId(null)
    setShowData(true)
  }

  const handleOpenIndexRun = (projectId: string | null) => {
    handleData()
    setDataFocusProjectId(projectId)
  }

  const handleNewFromDashboard = () => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    // A plain new chat is the home screen, whatever the last draft was.
    setShowNewConversation(false)
    startDraftConversation()
  }

  const handleSelectFromDashboard = (id: string) => {
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    selectConversation(id)
  }

  useEffect(() => {
    if (settings && settings.provider) {
      loadModels()
    }
  }, [settings?.provider])

  useEffect(() => {
    if (settings && !hasProviderCredentials(settings.provider)) {
      useSettingsStore.setState({ showSettings: true })
    }
  }, [settings])

  const handlePreferenceModelChange = async (modelId: string) => {
    setSelectedModel(modelId)
    await updateSettings({ defaultModel: modelId })
  }

  const handlePreferenceEffortChange = async (effort: ReasoningEffort) => {
    setSelectedEffort(effort)
    await updateSettings({ defaultEffort: effort })
  }

  // The home screen's Context pill also aims the sidebar: choosing a project's
  // context there switches the conversation list to that project, so the list
  // shows the conversations the new one will join. A context with no project of
  // its own (Life, a category) goes back to General — which is exactly where a
  // conversation started under it gets filed. The first project wins in a stack.
  const handleHomeContextChange = (context: ContextSelection) => {
    setSelectedContext(context)
    setFilterProjectId(stackedProjectIds(context)[0] ?? null)
  }

  const handleModelChange = async (modelId: string) => {
    if (currentConversationId) {
      await updateConversationModel(currentConversationId, modelId)
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === currentConversationId ? { ...c, model: modelId } : c
        ),
      }))
    }
  }

  const handleEffortChange = async (effort: ReasoningEffort) => {
    if (currentConversationId) {
      await updateConversationEffort(currentConversationId, effort)
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === currentConversationId ? { ...c, reasoningEffort: effort } : c
        ),
      }))
    }
  }

  const handleSend = (content: string, attachments?: ChatAttachment[]) => {
    sendMessage(content, activeModel, activeEffort, attachments)
  }

  // The only path that creates a plain conversation: both start screens are a
  // draft until the first message lands, so this is where the sidebar row and
  // the generated title come from — carrying whatever the pills were set to.
  const handleWelcomeSend = async (content: string, attachments?: ChatAttachment[]) => {
    // Mirror the model the welcome screen was actually showing. `selectedModel`
    // is empty until the user picks one, and sending an empty model id fails
    // the request.
    const model = selectedModel || settings?.defaultModel || models[0]?.id || ''
    const conversation = await window.electronAPI.conversations.create(model, selectedEffort, undefined, memoryMode, selectedContext, selectedRoleId)
    await loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    await useChatStore.getState().sendMessage(content, model, selectedEffort, attachments)
  }

  const handlePsychologyConversation = async (
    projectId: string,
    content: string,
    model: string,
    effort: ReasoningEffort
  ) => {
    // A conversation started from the Psychology page carries whatever role the
    // pill is set to, so opening a session here behaves like opening it in chat.
    const conversation = await window.electronAPI.conversations.create(model, effort, projectId, undefined, undefined, selectedRoleId)
    await loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    setSelectedEffort(effort)
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    await useChatStore.getState().sendMessage(content, model, effort)
  }

  /**
   * Opens a book/chapter-scoped conversation.
   *
   * Deliberately created with NO projectId. A project's conversations are
   * summarized into conversation_contexts, which feed the project super-context
   * and the life timeline — filing a book discussion under Books would put book
   * prose into the profile by exactly the back door the Library is built to
   * avoid. `library.linkConversation` gives the Library its listing instead, and
   * also flags the row so the idle memory extractor skips it.
   */
  const handleBookConversation = async (
    bookId: string,
    chapterIndex: number,
    lessonId?: string,
    stepId?: string
  ) => {
    const model = selectedModel || settings?.defaultModel || models[0]?.id || ''
    const scope = await window.electronAPI.library.buildDiscussionPrompt(bookId, chapterIndex, lessonId, stepId)
    const conversation = await window.electronAPI.conversations.create(model, selectedEffort)
    await window.electronAPI.conversations.updateSystemPrompt(conversation.id, scope.systemPrompt)
    await window.electronAPI.conversations.rename(conversation.id, scope.title)
    await window.electronAPI.library.linkConversation(bookId, conversation.id, { chapterIndex, lessonId, stepId })
    await loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    await useChatStore.getState().sendMessage(scope.seedPrompt, model, selectedEffort)
  }

  const handleHealthConversation = async (
    projectId: string,
    content: string,
    model: string,
    effort: ReasoningEffort
  ) => {
    const conversation = await window.electronAPI.conversations.create(model, effort, projectId)
    await loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    setSelectedEffort(effort)
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    await useChatStore.getState().sendMessage(content, model, effort)
  }

  const handleRecallFollowUp = async (content: string) => {
    if (useChatStore.getState().isStreaming) {
      throw new Error('Wait for the current response to finish before starting a Recall follow-up')
    }
    const model = selectedModel || settings?.defaultModel || models[0]?.id || ''
    if (!model) throw new Error('Select a chat model before continuing')

    const conversation = await window.electronAPI.recall.startConversation(model, selectedEffort)
    await loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    setPsychologyProjectId(null)
    setHealthProjectId(null)
    setActivityProjectId(null)
    setShowData(false)
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowPlay(false)
    setShowWork(false)
    setShowCallHistory(false)
    setShowHistory(false)
    await useChatStore.getState().sendMessage(content, model, selectedEffort)
  }

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'n') {
        e.preventDefault()
        handleNewFromDashboard()
      }
      if (meta && e.key.toLocaleLowerCase() === 'k') {
        e.preventDefault()
        handleRecall()
      }
      if (meta && e.shiftKey && e.key === ',') {
        e.preventDefault()
        toggleSettings()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedModel, selectedEffort, settings?.defaultModel])

  // Menu event listeners from main process
  useEffect(() => {
    const cleanNewChat = window.electronAPI.app.onNewChat(handleNewFromDashboard)
    const cleanSettings = window.electronAPI.app.onSettings(() => toggleSettings())
    return () => {
      cleanNewChat()
      cleanSettings()
    }
  }, [selectedModel, selectedEffort, settings?.defaultModel])

  // Once the draft becomes a real conversation — or another one is opened — the
  // preset start screen has done its job. Retiring it here rather than in each
  // handler also covers deleting the open conversation, which drops back to a
  // draft that should be the ordinary home screen.
  useEffect(() => {
    if (currentConversationId) setShowNewConversation(false)
  }, [currentConversationId])

  // Refresh conversations list after sending (auto-title may update)
  useEffect(() => {
    if (!isStreaming && currentConversationId) {
      loadConversations()
    }
  }, [isStreaming])

  // The generated title arrives after the stream is already finished, so the
  // effect above can miss it. Main broadcasts once the rename lands.
  useEffect(() => {
    return window.electronAPI.conversations.onUpdated(() => {
      void loadConversations()
    })
  }, [])

  const workConversationPanel = (
    <ChatView
      messages={messages}
      isStreaming={isStreaming}
      streamingText={streamingText}
      streamingReasoning={streamingReasoning}
      streamingToolInteractions={streamingToolInteractions}
      error={error}
      models={models}
      selectedModel={activeModel}
      selectedEffort={activeEffort}
      memoryMode={memoryMode}
      selectedContext={selectedContext}
      selectedRoleId={selectedRoleId}
      lastSystemPrompt={lastSystemPrompt}
      onSend={handleSend}
      onAbort={abortStream}
      onModelChange={handleModelChange}
      onEffortChange={handleEffortChange}
      onMemoryModeChange={setMemoryMode}
      onContextChange={setSelectedContext}
      onRoleChange={setSelectedRole}
      onClearError={clearError}
      title={currentConversation?.title || 'New Chat'}
      onRename={(title) => void renameConversation(currentConversationId!, title)}
      onEditMessage={(messageId, newContent) => void editMessage(messageId, newContent, activeModel, activeEffort)}
      onRetryMessage={(messageId) => void retryMessage(messageId, activeModel, activeEffort)}
      onSetActiveBranch={(messageId) => void setActiveBranch(messageId)}
      onWebSearchCommand={(query) => handleWebSearch(query)}
    />
  )

  return (
    <div className="flex flex-col h-screen bg-holmes-bg text-white">
      <div className="relative z-20 h-8 shrink-0">
        <div className="window-drag absolute inset-y-0 left-[210px] right-0" />
        {/* Centred on the traffic lights (main.ts pins them at y=21, so their
            12px circles centre on 27). The dots end at x=66; starting at 90
            leaves 24px between the two groups — wider than the 10px inside this
            one, so they read as separate sets of controls. */}
        <div className="absolute left-[90px] top-[17px] z-10 flex items-center gap-2.5">
          <button
            onClick={() => setSidebarOpen((open) => !open)}
            className="window-no-drag flex h-5 w-5 items-center justify-center text-[#99928d] transition-colors hover:text-white cursor-pointer"
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Show sidebar'}
            title={sidebarOpen ? 'Collapse sidebar' : 'Show sidebar'}
          >
            <FontAwesomeIcon icon={faTableColumns} />
          </button>
          <button
            onClick={handleHome}
            className="window-no-drag flex h-5 w-5 items-center justify-center text-[#99928d] transition-colors hover:text-white cursor-pointer"
            aria-label="Home"
            title="Home"
          >
            <FontAwesomeIcon icon={faHouse} />
          </button>
          <button
            onClick={toggleSettings}
            className={`window-no-drag flex h-5 w-5 items-center justify-center transition-colors hover:text-white cursor-pointer ${
              showSettings ? 'text-white' : 'text-[#99928d]'
            }`}
            aria-label="Settings"
            title="Settings"
          >
            <FontAwesomeIcon icon={faGear} />
          </button>
          <button
            onClick={() => void window.electronAPI.app.openExternal('https://ko-fi.com/wilescreative')}
            className="window-no-drag flex h-5 w-5 items-center justify-center text-[#99928d] transition-colors hover:text-white cursor-pointer"
            aria-label="Support Holmes on Ko-fi"
            title="Support Holmes on Ko-fi"
          >
            <FontAwesomeIcon icon={faHeart} />
          </button>
        </div>
      </div>

      <ProviderCreditBanner />

      <div className="flex flex-1 min-h-0">
        {sidebarOpen && (
          <Sidebar
            conversations={conversations}
            projects={visibleProjects}
            currentConversationId={currentConversationId}
onSelect={handleSelectFromDashboard}
            onNew={handleNewFromDashboard}
            onDelete={deleteConversation}
            onRename={renameConversation}
            onRecall={handleRecall}
            onProjects={handleProjects}
            onDashboard={handleDashboard}
            onData={handleData}
            onProductSearch={handleProductSearch}
            onMentalCoach={handleMentalCoach}
            onMemory={handleMemory}
            onTimeline={handleTimeline}
            onLibrary={handleLibrary}
            onPlay={handlePlay}
            onWork={handleWork}
            onWorkTool={handleWorkTool}
            selectedRoleId={selectedRoleId}
            filterProjectId={filterProjectId}
            onFilterProjectChange={setFilterProjectId}
            onCallHistory={handleCallHistory}
            onHistory={handleHistory}
            onOpenIndexRun={handleOpenIndexRun}
            activeSection={
              // The unsent session counts as being in Mental Coach, as does the
              // Psychology page it used to open.
              showNewConversation || psychologyProject
                ? 'mental-coach'
                : showHistory
                  ? 'history'
                  : showRecall
                  ? 'recall'
                  : showProjects
                    ? 'projects'
                    : showProductSearch
                      ? 'product-search'
                      : showMemory
                        ? 'memory'
                        : showCallHistory
                          ? 'call-history'
                          : showLibrary
                          ? 'library'
                          : showPlay
                          ? 'play'
                          : showWork
                          ? 'work'
                          : showTimeline
                          ? 'timeline'
                          : showData
                            ? 'data'
                            : showDashboard
                              ? 'dashboard'
                              : null
            }
          />
        )}

        <div className="relative min-w-0 flex-1 flex flex-col">
          {psychologyProject ? (
            <PsychologyPage
              project={psychologyProject}
              onCompleteTest={async (testId: PsychologicalTestId, answers: number[]) => {
                const result = await window.electronAPI.projects.completePsychologyTest(psychologyProject.id, testId, answers)
                try {
                  setProjects(await window.electronAPI.projects.list())
                } catch {
                  // The result is already saved; refreshing the file list is noncritical.
                }
                return result
              }}
              onChooseDirectory={async () => {
                const directory = await window.electronAPI.app.selectDirectory()
                if (directory) await handleProjectUpdate(psychologyProject.id, { path: directory })
              }}
              onOpenExternal={(url) => window.electronAPI.app.openExternal(url)}
              models={models}
              selectedModel={selectedModel || settings?.defaultModel || models[0]?.id || ''}
              selectedEffort={selectedEffort}
              onModelChange={(model) => void handlePreferenceModelChange(model)}
              onEffortChange={(effort) => void handlePreferenceEffortChange(effort)}
              onStartConversation={(prompt, model, effort) => handlePsychologyConversation(
                psychologyProject.id,
                prompt,
                model,
                effort
              )}
              onOpenConversation={handleSelectFromDashboard}
            />
          ) : healthProject ? (
            <HealthPage
              project={healthProject}
              healthAnalysisEnabled={settings?.healthAnalysisEnabled ?? false}
              healthLiveSyncEnabled={settings?.healthLiveSyncEnabled ?? false}
              onAnalyzeHealth={handleAnalyzeHealth}
              onChooseDirectory={async () => {
                const directory = await window.electronAPI.app.selectDirectory()
                if (directory) {
                  await handleProjectUpdate(healthProject.id, { path: directory })
                  void window.electronAPI.health.scanDirectory(healthProject.id).catch(() => {})
                }
              }}
              onClearDirectory={async (id) => {
                await handleProjectUpdate(id, { path: null })
              }}
              onAddFiles={async (projectId) => {
                const files = await window.electronAPI.app.selectFiles()
                for (const file of files) {
                  await handleAddFile(projectId, file)
                }
              }}
              onRemoveFile={handleRemoveFile}
              models={models}
              selectedModel={selectedModel || settings?.defaultModel || models[0]?.id || ''}
              selectedEffort={selectedEffort}
              onModelChange={(model) => void handlePreferenceModelChange(model)}
              onEffortChange={(effort) => void handlePreferenceEffortChange(effort)}
              onStartConversation={(prompt, model, effort) => handleHealthConversation(
                healthProject.id,
                prompt,
                model,
                effort
              )}
            />
          ) : activityProject ? (
            <ActivityPage
              projectId={activityProject.id}
              activityIngestEnabled={settings?.activityIngestEnabled ?? false}
            />
          ) : showData ? (
            <DataPage
              projects={projects}
              onBack={() => setShowData(false)}
              onOpenPsychology={setPsychologyProjectId}
              onOpenHealth={setHealthProjectId}
              onOpenActivity={setActivityProjectId}
              onUpdate={handleProjectUpdate}
              onCreateProject={handleCreateProject}
              onDeleteProject={handleProjectDelete}
              onReorder={handleReorderProjects}
              onSelectImage={() => window.electronAPI.app.selectImage()}
              onAddSource={handleAddSource}
              onRemoveSource={handleRemoveSource}
              onSelectDirectory={() => window.electronAPI.app.selectDirectory()}
              onOpenLibrary={handleLibrary}
              focusProjectId={dataFocusProjectId}
              onFocusHandled={() => setDataFocusProjectId(null)}
            />
          ) : showHistory ? (
            <ChatHistoryPage
              conversations={conversations}
              projects={visibleProjects}
              currentConversationId={currentConversationId}
              onSelect={handleSelectFromDashboard}
              onNew={handleNewFromDashboard}
              onDelete={deleteConversation}
              onRename={renameConversation}
            />
          ) : showCallHistory ? (
            <CallHistoryPage />
          ) : showPlay ? (
            <PlayPage
              onOpenSettings={() => useSettingsStore.setState({ showSettings: true })}
              onOpenData={handleData}
            />
          ) : showLibrary ? (
            <LibraryPage
              onBack={() => setShowLibrary(false)}
              onOpenData={handleData}
              onDiscuss={handleBookConversation}
            />
          ) : showWork ? (
            // Only the picker lives in the cascade. Once a document is open the
            // workspace overlays this whole area, and rendering the picker
            // underneath it just leaves an invisible click target.
            workKind ? null : (
              <WorkPage
                onRequestKind={(kind) => { setWorkKind(kind) }}
                designFirst={workTool?.roleId === 'designer'}
              />
            )
          ) : showRecall ? (
            <RecallPage
              onSelectConversation={handleSelectFromDashboard}
              onFollowUp={handleRecallFollowUp}
              followUpDisabled={isStreaming}
            />
          ) : showProductSearch ? (
            <ProductSearchPage
              models={models}
              selectedModel={selectedModel || settings?.defaultModel || models[0]?.id || ''}
              selectedEffort={selectedEffort}
              providerType={settings?.provider.type || 'openrouter'}
              onModelChange={(model) => void handlePreferenceModelChange(model)}
              onEffortChange={(effort) => void handlePreferenceEffortChange(effort)}
              onOpenExternal={(url) => window.electronAPI.app.openExternal(url)}
            />
          ) : showWebSearch ? (
            <WebSearchPage
              enabled={settings?.webSearchEnabled ?? false}
              apiKeyConfigured={Boolean(settings?.webSearchApiKey?.trim())}
              pendingQuery={webSearchPendingQuery}
              onConsumePendingQuery={() => setWebSearchPendingQuery(undefined)}
              onOpenExternal={(url) => window.electronAPI.app.openExternal(url)}
              onOpenSettings={toggleSettings}
            />
          ) : showMemory ? (
            <MemoryPage />
          ) : showTimeline ? (
            <TimelinePage />
          ) : showProjects ? (
            <ProjectsPage
              projects={userProjects}
              onCreate={handleCreateProject}
              onUpdate={handleProjectUpdate}
              onDelete={handleProjectDelete}
              onSelectDirectory={() => window.electronAPI.app.selectDirectory()}
              onAddFile={handleAddFile}
              onRemoveFile={handleRemoveFile}
              onSelectFiles={() => window.electronAPI.app.selectFiles()}
              onSelectImage={() => window.electronAPI.app.selectImage()}
            />
          ) : showDashboard ? (
            <Dashboard
              projects={defaultProjects}
              onUpdate={handleProjectUpdate}
              onDelete={handleProjectDelete}
              onSelectDirectory={() => window.electronAPI.app.selectDirectory()}
              onAddFile={handleAddFile}
              onRemoveFile={handleRemoveFile}
              onSelectFiles={() => window.electronAPI.app.selectFiles()}
              onAnalyzePsychology={handleAnalyzePsychology}
              onAnalyzeHealth={handleAnalyzeHealth}
              onAnalyzeActivity={async (projectId) => {
                await window.electronAPI.activity.refreshSummary(projectId)
                const list = await window.electronAPI.projects.list()
                setProjects(list)
              }}
              healthAnalysisEnabled={settings?.healthAnalysisEnabled ?? false}
              activityIngestEnabled={settings?.activityIngestEnabled ?? false}
              onRestoreDefaults={async () => {
                const list = await window.electronAPI.projects.restoreDefaults()
                setProjects(list)
              }}
              onOpenPsychology={setPsychologyProjectId}
              onOpenHealth={setHealthProjectId}
              onOpenActivity={setActivityProjectId}
              onOpenData={handleData}
            />
          ) : currentConversationId ? (
            <ChatView
              messages={messages}
              isStreaming={isStreaming}
              streamingText={streamingText}
              streamingReasoning={streamingReasoning}
              streamingToolInteractions={streamingToolInteractions}
              error={error}
              models={models}
              selectedModel={activeModel}
              selectedEffort={activeEffort}
              memoryMode={memoryMode}
              selectedContext={selectedContext}
              selectedRoleId={selectedRoleId}
              lastSystemPrompt={lastSystemPrompt}
              onSend={handleSend}
              onAbort={abortStream}
              onModelChange={handleModelChange}
              onEffortChange={handleEffortChange}
              onMemoryModeChange={setMemoryMode}
              onContextChange={setSelectedContext}
              onRoleChange={setSelectedRole}
              onClearError={clearError}
              title={currentConversation?.title || 'New Chat'}
              onRename={(title) => void renameConversation(currentConversationId!, title)}
              onEditMessage={(messageId, newContent) => void editMessage(messageId, newContent, activeModel, activeEffort)}
              onRetryMessage={(messageId) => void retryMessage(messageId, activeModel, activeEffort)}
              onSetActiveBranch={(messageId) => void setActiveBranch(messageId)}
              onWebSearchCommand={(query) => handleWebSearch(query)}
            />
          ) : showNewConversation ? (
            <NewConversationScreen
              onSend={handleWelcomeSend}
              models={models}
              selectedModel={selectedModel || settings?.defaultModel || models[0]?.id || ''}
              onModelChange={(model) => void handlePreferenceModelChange(model)}
              selectedEffort={selectedEffort}
              onEffortChange={(effort) => void handlePreferenceEffortChange(effort)}
              memoryMode={memoryMode}
              onMemoryModeChange={setMemoryMode}
              selectedContext={selectedContext}
              onContextChange={handleHomeContextChange}
              selectedRoleId={selectedRoleId}
              onRoleChange={setSelectedRole}
            />
          ) : (
            <WelcomeScreen
              onSend={handleWelcomeSend}
              models={models}
              selectedModel={selectedModel || settings?.defaultModel || models[0]?.id || ''}
              onModelChange={(model) => void handlePreferenceModelChange(model)}
              selectedEffort={selectedEffort}
              onEffortChange={(effort) => void handlePreferenceEffortChange(effort)}
              memoryMode={memoryMode}
              onMemoryModeChange={setMemoryMode}
              selectedContext={selectedContext}
              onContextChange={handleHomeContextChange}
              selectedRoleId={selectedRoleId}
              onRoleChange={setSelectedRole}
            />
          )}

        {/* The embedded-document workspace.
            Mounted outside the page cascade so that navigating away does not
            unmount it WHILE THERE IS WORK IN FLIGHT — unmounting destroys the
            iframe, which would kill a run Holmes is midway through. Once
            everything is idle it is torn down on leaving rather than kept
            alive: it holds a 63 MB wasm heap and an editor process, which is
            not something to leave running for a document nobody is touching.
            The same rule should govern any future embedded app. */}
        {workKind && (showWork || workBusy) && (
          <div
            className={
              showWork
                ? 'absolute inset-0 z-10 flex flex-col bg-holmes-bg'
                : // visibility, not display: display:none collapses the editor
                  // to zero and it comes back blank until something resizes it.
                  'pointer-events-none invisible absolute inset-0 -z-10 flex flex-col'
            }
            aria-hidden={!showWork}
          >
            <WorkspaceView
              ref={workEditorRef}
              kind={workKind}
              role={getWorkRole(workTool?.roleId ?? null)}
              tool={workTool?.tool ?? null}
              projectName={projects.find((project) => project.id === filterProjectId)?.name ?? null}
              saving={workSaving}
              savedPath={workSavedPath}
              saveError={workSaveError}
              onSave={() => void handleWorkSave()}
              onClose={() => setShowWork(false)}
              onEditorReady={handleWorkEditorReady}
              onDirtyChange={setWorkDirty}
              conversation={workConversationId ? workConversationPanel : undefined}
            />
          </div>
        )}
        </div>

        {workPaperPrompt && (
          <PaperSaveDialog
            font={workPaperPrompt.font}
            onKeep={() => void handleWorkPaperChoice(true)}
            onDrop={() => void handleWorkPaperChoice(false)}
            onCancel={() => setWorkPaperPrompt(null)}
          />
        )}

        {showSettings && (
          <SettingsPanel
            settings={settings}
            models={models}
            onUpdateSettings={updateSettings}
            onUpdateProvider={updateProvider}
            onClose={closeSettings}
          />
        )}
      </div>
    </div>
  )
}

export default App
