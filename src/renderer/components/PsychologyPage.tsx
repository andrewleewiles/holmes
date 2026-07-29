import { type FC, useState } from 'react'
import type {
  Project,
  PsychologicalTestId,
  PsychologicalTestResult,
  ModelInfo,
  ReasoningEffort,
} from '@shared/types'
import { PSYCHOLOGICAL_TESTS } from '@shared/psychologicalTests'
import { PsychologyWidget } from './PsychologyWidget'
import { PsychologicalTestChat } from './PsychologicalTestChat'
import { PsychologyPromptComposer } from './PsychologyPromptComposer'
import { SessionNotesPanel } from './SessionNotesPanel'
import { ProjectIcon } from './ProjectIcon'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'

interface PsychologyPageProps {
  project: Project
  onCompleteTest: (testId: PsychologicalTestId, answers: number[]) => Promise<PsychologicalTestResult>
  onChooseDirectory: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  models: ModelInfo[]
  selectedModel: string
  selectedEffort: ReasoningEffort
  onModelChange: (model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onStartConversation: (prompt: string, model: string, effort: ReasoningEffort) => Promise<void>
  onOpenConversation?: (conversationId: string) => void
}

export const PsychologyPage: FC<PsychologyPageProps> = ({
  project,
  onCompleteTest,
  onChooseDirectory,
  onOpenExternal,
  models,
  selectedModel,
  selectedEffort,
  onModelChange,
  onEffortChange,
  onStartConversation,
  onOpenConversation,
}) => {
  const { name: assistantName } = useAssistantIdentity()
  const [activeTestId, setActiveTestId] = useState<PsychologicalTestId | null>(null)
  const activeTest = PSYCHOLOGICAL_TESTS.find((test) => test.id === activeTestId)

  if (activeTest) {
    return (
      <PsychologicalTestChat
        test={activeTest}
        onExit={() => setActiveTestId(null)}
        onComplete={onCompleteTest}
        onChooseDirectory={onChooseDirectory}
        onOpenExternal={onOpenExternal}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-holmes-bg">
      <PageHeader
        icon={<ProjectIcon icon={project.icon} className={PAGE_HEADER_ICON} />}
        title={project.name}
      />

      <div className="max-w-4xl w-full mx-auto px-8 py-6">
        <p className="text-xs text-white/40 mb-6">
          Psychological profile, standardized assessments, and relationship insights
        </p>

        <PsychologyPromptComposer
          project={project}
          models={models}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          onSubmit={onStartConversation}
        />

        {project.analysis ? (
          <div className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6">
            <PsychologyWidget analysis={project.analysis} />
          </div>
        ) : (
          <div className="bg-holmes-surface rounded-2xl border border-white/10 p-6 mb-6 text-center">
            <p className="text-sm text-white/40">No analysis yet. Add documents and run analysis from the dashboard.</p>
          </div>
        )}

        <SessionNotesPanel projectId={project.id} onOpenConversation={onOpenConversation} />

        <section className="bg-holmes-surface rounded-2xl border border-violet-400/15 p-6 mb-6">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-white/75 font-serif-display">Standardized Assessments</h2>
                <span className="rounded-full border border-violet-400/25 bg-violet-400/10 px-2 py-0.5 text-[9px] font-semibold tracking-[0.14em] text-violet-200/80">
                  TEST MODE
                </span>
              </div>
              <p className="text-xs text-white/35 mt-1">
                Guided like a {assistantName} conversation, scored from published keys, and saved locally as Markdown.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] uppercase tracking-wider text-white/25">Storage</div>
              <div className="mt-0.5 max-w-56 truncate text-[11px] text-white/45" title={project.path || undefined}>
                {project.path || 'No directory selected'}
              </div>
            </div>
          </div>

          {!project.path && (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.07] p-3">
              <p className="text-xs leading-relaxed text-amber-100/65">
                Choose a Psychology directory before starting so your completed result can be saved privately on this Mac.
              </p>
              <button
                onClick={() => void onChooseDirectory()}
                className="shrink-0 rounded-lg bg-amber-300/15 px-3 py-2 text-xs text-amber-100 hover:bg-amber-300/25 transition-colors cursor-pointer"
              >
                Choose directory
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PSYCHOLOGICAL_TESTS.map((test) => (
              <button
                key={test.id}
                onClick={() => setActiveTestId(test.id)}
                disabled={!project.path}
                className="group rounded-xl border border-white/[0.07] bg-black/10 p-4 text-left hover:border-violet-400/30 hover:bg-violet-400/[0.06] disabled:cursor-not-allowed disabled:opacity-40 transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-violet-300/65">{test.category}</div>
                    <h3 className="mt-1 text-sm font-medium text-white/75 group-hover:text-white/90 font-serif-display">{test.shortName}</h3>
                  </div>
                  <span className="rounded-full bg-white/[0.06] px-2 py-1 text-[10px] text-white/35">~{test.estimatedMinutes} min</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-white/40">{test.description}</p>
                <div className="mt-3 flex items-center justify-between text-[10px] text-white/25">
                  <span>{test.id === 'phq_9' ? '9 scored + 1 conditional' : `${test.questions.length} questions`}</span>
                  <span className="text-violet-300/65 group-hover:text-violet-200">Start test -&gt;</span>
                </div>
              </button>
            ))}
          </div>

          <p className="mt-4 text-[10px] leading-relaxed text-white/25">
            Results are self-reported screening or trait measures, not diagnoses. Completion saves locally and does not upload your responses. If you later run Analyze, Psychology project documents are sent to your configured AI provider. Your selected folder may also be cloud-synced by macOS or another service.
          </p>
        </section>

      </div>
    </div>
  )
}
