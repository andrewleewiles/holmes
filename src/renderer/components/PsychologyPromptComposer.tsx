import { type FC, useState } from 'react'
import type { ModelInfo, Project, ReasoningEffort } from '@shared/types'
import { ModelSelector } from './ModelSelector'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'

interface PsychologyPromptComposerProps {
  project: Project
  models: ModelInfo[]
  selectedModel: string
  selectedEffort: ReasoningEffort
  onModelChange: (model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onSubmit: (prompt: string, model: string, effort: ReasoningEffort) => Promise<void>
}

export const PsychologyPromptComposer: FC<PsychologyPromptComposerProps> = ({
  project,
  models,
  selectedModel,
  selectedEffort,
  onModelChange,
  onEffortChange,
  onSubmit,
}) => {
  const { name: assistantName } = useAssistantIdentity()
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const content = prompt.trim()
    if (!content || !selectedModel || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(content, selectedModel, selectedEffort)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the contextual conversation')
      setSubmitting(false)
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-holmes-primary/25 bg-gradient-to-br from-holmes-primary/[0.09] to-violet-500/[0.05]">
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-holmes-primary/15 text-holmes-primary-light">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
                </svg>
              </span>
              <div>
                <h2 className="text-sm font-medium text-white/80 font-serif-display">Ask {assistantName} about your Psychology project</h2>
                <p className="mt-0.5 text-[11px] text-white/35">Starts a normal conversation with live project context on every turn.</p>
              </div>
            </div>
          </div>
          <span className="rounded-full border border-holmes-primary/25 bg-holmes-primary/10 px-2 py-1 text-[9px] font-semibold tracking-[0.13em] text-holmes-primary-light">
            LIVE CONTEXT
          </span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
          <span className={`rounded-full px-2 py-1 ${project.analysis ? 'bg-emerald-400/10 text-emerald-200/70' : 'bg-white/[0.05] text-white/25'}`}>
            {project.analysis ? 'Profile included' : 'No profile yet'}
          </span>
          <span className={`rounded-full px-2 py-1 ${project.path || project.files.length ? 'bg-violet-400/10 text-violet-200/70' : 'bg-white/[0.05] text-white/25'}`}>
            {project.path ? 'Project directory included' : `${project.files.length} explicit files`}
          </span>
        </div>
      </div>

      <div className="p-4">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          rows={3}
          disabled={submitting}
          placeholder="Ask about patterns across your profile, assessments, relationships, or documents..."
          className="w-full resize-none rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-sm leading-relaxed text-white/80 outline-none placeholder:text-white/25 focus:border-holmes-primary/40 disabled:opacity-50"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-56 flex-1">
            <ModelSelector models={models} selectedModel={selectedModel} onSelect={onModelChange} disabled={submitting} />
          </div>
          <select
            value={selectedEffort}
            onChange={(event) => onEffortChange(event.target.value as ReasoningEffort)}
            disabled={submitting}
            className="rounded-lg border border-white/10 bg-holmes-surface px-3 py-2 text-xs text-white/65 outline-none disabled:opacity-50"
          >
            <option value="low">Low effort</option>
            <option value="medium">Medium effort</option>
            <option value="high">High effort</option>
          </select>
          <button
            onClick={() => void submit()}
            disabled={!prompt.trim() || !selectedModel || submitting}
            className="rounded-lg bg-holmes-primary px-4 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-40 transition-colors cursor-pointer"
          >
            {submitting ? 'Starting...' : 'Start conversation'}
          </button>
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-white/25">
          Your saved profile, relationship analysis, and supported project documents are sent to the configured AI provider, up to an 80,000-character context budget. {assistantName} identifies truncation in the model context.
        </p>
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      </div>
    </section>
  )
}
