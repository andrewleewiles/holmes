import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGear, faHeart, faHouse, faTableColumns } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment, ReasoningEffort, Project, PsychologicalTestId } from '@shared/types'
import { hasProviderCredentials } from '@shared/providerConfig'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { WelcomeScreen } from './components/WelcomeScreen'
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
import { LibraryPage } from './components/LibraryPage'
import { CallHistoryPage } from './components/CallHistoryPage'
import { SettingsPanel } from './components/SettingsPanel'
import { ProviderCreditBanner } from './components/ProviderCreditBanner'
import { useChat } from './hooks/useChat'
import { useSettings } from './hooks/useSettings'
import { useChatStore } from './store/chatStore'
import { useSettingsStore } from './store/settingsStore'
import { isDefaultProjectName } from '@shared/defaultProjects'

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
  const [showCallHistory, setShowCallHistory] = useState(false)
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

  useEffect(() => {
    loadSettings().then(() => {
      return loadConversations()
    })
  }, [])

  useEffect(() => {
    window.electronAPI.projects.list().then(setProjects)
  }, [])

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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
    setShowTimeline(true)
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
    setShowLibrary(true)
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
    setShowCallHistory(true)
  }

  const handleMentalCoach = () => {
    const project = projects.find((candidate) => candidate.name === 'Psychology')
    if (!project) {
      handleDashboard()
      return
    }
    setShowRecall(false)
    setShowProjects(false)
    setShowDashboard(false)
    setShowProductSearch(false)
    setShowWebSearch(false)
    setShowMemory(false)
    setShowTimeline(false)
    setShowLibrary(false)
    setShowCallHistory(false)
    setPsychologyProjectId(project.id)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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

  // The only path that creates a plain conversation: the welcome screen is a
  // draft until the first message lands, so this is where the sidebar row and
  // the generated title come from.
  const handleWelcomeSend = async (content: string) => {
    // Mirror the model the welcome screen was actually showing. `selectedModel`
    // is empty until the user picks one, and sending an empty model id fails
    // the request.
    const model = selectedModel || settings?.defaultModel || models[0]?.id || ''
    const conversation = await window.electronAPI.conversations.create(model, selectedEffort, undefined, memoryMode, selectedContext, selectedRoleId)
    await loadConversations()
    await useChatStore.getState().selectConversation(conversation.id)
    await useChatStore.getState().sendMessage(content, model, selectedEffort)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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
    setShowCallHistory(false)
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

  return (
    <div className="flex flex-col h-screen bg-holmes-bg text-white">
      <div className="relative z-20 h-8 shrink-0">
        <div className="window-drag absolute inset-y-0 left-[154px] right-0" />
        <div className="absolute left-[74px] top-[7px] z-10 flex items-center gap-2">
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
            onCallHistory={handleCallHistory}
            onOpenIndexRun={handleOpenIndexRun}
            activeSection={
              psychologyProject
                ? 'mental-coach'
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

        <div className="min-w-0 flex-1 flex flex-col">
          {psychologyProject ? (
            <PsychologyPage
              project={psychologyProject}
              onBack={() => setPsychologyProjectId(null)}
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
              onBack={() => setHealthProjectId(null)}
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
              onBack={() => setActivityProjectId(null)}
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
          ) : showCallHistory ? (
            <CallHistoryPage onBack={() => setShowCallHistory(false)} />
          ) : showLibrary ? (
            <LibraryPage
              onBack={() => setShowLibrary(false)}
              onOpenData={handleData}
              onDiscuss={handleBookConversation}
            />
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
            <TimelinePage onBack={() => setShowTimeline(false)} />
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
              onContextChange={setSelectedContext}
              selectedRoleId={selectedRoleId}
              onRoleChange={setSelectedRole}
            />
          )}
        </div>

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
