import { type FC, useState, useRef, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faBolt,
  faBullseye,
  faChartColumn,
  faFileLines,
  faLightbulb,
  faMagnifyingGlass,
  faPenNib,
} from '@fortawesome/free-solid-svg-icons'
import type { ModelInfo, ReasoningEffort, MemoryMode, ContextSelection } from '@shared/types'
import { ModelSelector } from './ModelSelector'
import { PillDropdown } from './PillDropdown'
import { MemoryDropdown } from './MemoryDropdown'
import { ContextDropdown } from './ContextDropdown'
import { RoleDropdown } from './RoleDropdown'
import { AssistantMark } from './AssistantMark'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'
import { DEFAULT_WELCOME_LINES, renderWelcomeLine } from '../welcomeLines'
import { useSettingsStore } from '../store/settingsStore'

interface WelcomeScreenProps {
  onSend: (message: string) => void
  models: ModelInfo[]
  selectedModel: string
  onModelChange: (model: string) => void
  selectedEffort: ReasoningEffort
  onEffortChange: (effort: ReasoningEffort) => void
  memoryMode: MemoryMode
  onMemoryModeChange: (mode: MemoryMode) => void
  selectedContext: ContextSelection
  onContextChange: (context: ContextSelection) => void
  selectedRoleId: string | null
  onRoleChange: (roleId: string | null) => void
}

function pickWelcomeLine(lines: string[], firstName: string): string {
  if (lines.length === 0) return ''
  const line = lines[Math.floor(Math.random() * lines.length)]
  return renderWelcomeLine(line, firstName)
}

const suggestions = [
  { icon: faPenNib, label: 'Write a draft', text: 'Help me write a professional email about...' },
  { icon: faLightbulb, label: 'Brainstorm ideas', text: 'Give me creative ideas for...' },
  { icon: faFileLines, label: 'Summarize', text: 'Can you summarize the key points of...' },
  { icon: faMagnifyingGlass, label: 'Research', text: 'Explain how quantum computing works' },
  { icon: faChartColumn, label: 'Analyze', text: 'Compare and contrast these two approaches...' },
  { icon: faBullseye, label: 'Plan', text: 'Help me create a study plan for...' },
]

export const WelcomeScreen: FC<WelcomeScreenProps> = ({
  onSend,
  models,
  selectedModel,
  onModelChange,
  selectedEffort,
  onEffortChange,
  memoryMode,
  onMemoryModeChange,
  selectedContext,
  onContextChange,
  selectedRoleId,
  onRoleChange,
}) => {
  const [input, setInput] = useState('')
  const [greeting, setGreeting] = useState('')
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [firstName, setFirstName] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { name: assistantName } = useAssistantIdentity()
  const customWelcomeLines = useSettingsStore((state) => state.settings?.welcomeLines)

  // Re-rolls when the user edits the lines in Settings, so the editor's effect
  // is visible without restarting the app.
  const welcomeLines = customWelcomeLines?.length ? customWelcomeLines : DEFAULT_WELCOME_LINES

  useEffect(() => {
    Promise.all([
      window.electronAPI.app.getUserInfo(),
      window.electronAPI.memory.get('identity', 'preferred_name'),
    ]).then(([info, prefName]) => {
      const first = prefName ? String(prefName) : info.firstName
      setFirstName(first)
    })
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setGreeting(pickWelcomeLine(welcomeLines, firstName))
  }, [welcomeLines, firstName])

  const handleSubmit = () => {
    const trimmed = input.trim()
    if (!trimmed) return
    onSend(trimmed)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
      setIsOverflowing(el.scrollHeight > 200)
    }
  }, [input])

  const handleSuggestion = (text: string) => {
    onSend(text)
  }

  return (
    <div className="flex flex-col h-full bg-holmes-bg">
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="max-w-2xl w-full">
          <div className="flex items-center justify-center gap-8 mb-10">
            <AssistantMark className="w-10 h-10 shrink-0" />
            <h1 className="text-2xl font-normal text-white/70 leading-snug max-w-lg font-serif-display">
              {greeting}
            </h1>
          </div>

          <div className="flex gap-3 mb-3 flex-wrap">
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              onSelect={onModelChange}
            />
            <PillDropdown
              icon={<FontAwesomeIcon icon={faBolt} className="w-4 h-4" />}
              label="Effort"
              value={selectedEffort}
              options={[
                { value: 'low', label: 'Low effort' },
                { value: 'medium', label: 'Medium effort' },
                { value: 'high', label: 'High effort' },
              ]}
              onSelect={(v) => onEffortChange(v as ReasoningEffort)}
            />
            <MemoryDropdown
              value={memoryMode}
              onChange={onMemoryModeChange}
            />
            <ContextDropdown
              value={selectedContext}
              onChange={onContextChange}
            />
            <RoleDropdown
              value={selectedRoleId}
              onChange={onRoleChange}
            />
          </div>

          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message here..."
              rows={2}
              className={`w-full bg-white/10 border border-white/10 rounded-xl px-4 py-4 pr-14 text-sm text-white placeholder-white/30 outline-none resize-none max-h-[200px] min-h-[56px] focus:border-white/30 transition-colors ${
                isOverflowing ? 'scrollbar-thin' : 'no-scrollbar'
              }`}
            />
            <button
              onClick={handleSubmit}
              disabled={!input.trim()}
              aria-label="Send"
              className={`absolute right-3 bottom-3 p-2 bg-holmes-primary hover:bg-holmes-primary-dark disabled:bg-holmes-primary/40 disabled:cursor-not-allowed text-white rounded-lg transition-all duration-150 flex items-center justify-center ${
                input.trim() ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          <div className="mt-8">
            <p className="text-xs text-white/30 text-center mb-4">Try asking about...</p>
            <div className="grid grid-cols-3 gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  onClick={() => handleSuggestion(s.text)}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-white/5 hover:bg-holmes-primary/10 border border-white/5 hover:border-holmes-primary/30 transition-all cursor-pointer group"
                >
                  <FontAwesomeIcon
                    icon={s.icon}
                    className="text-lg"
                    style={{ color: '#47a08f' }}
                  />
                  <span className="text-xs text-white/50 group-hover:text-holmes-primary-light transition-colors">
                    {s.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="py-4 text-center">
        <p className="text-xs text-white/20">
          {assistantName} v0.1 — Configure your API key in Settings to get started
        </p>
      </div>
    </div>
  )
}
