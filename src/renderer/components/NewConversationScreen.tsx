import { type FC, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBolt, faPlus, faImage } from '@fortawesome/free-solid-svg-icons'
import type { ChatAttachment, ModelInfo, ReasoningEffort, MemoryMode, ContextSelection } from '@shared/types'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@shared/attachments'
import { useAttachmentDraft } from '../hooks/useAttachmentDraft'
import { useDraftSystemPrompt } from '../hooks/useDraftSystemPrompt'
import { AttachmentTray } from './AttachmentTray'
import { SystemPromptPanel } from './SystemPromptPanel'
import { ModelSelector } from './ModelSelector'
import { PillDropdown } from './PillDropdown'
import { MemoryDropdown } from './MemoryDropdown'
import { ContextDropdown } from './ContextDropdown'
import { RoleDropdown } from './RoleDropdown'
import { AnimatedMark } from './AnimatedMark'
import { useAssistantIdentity } from '../hooks/useAssistantIdentity'
import { renderWelcomeLine } from '../welcomeLines'
import { getCharacter, isDefaultCharacter } from '../characters'
import { useSettingsStore } from '../store/settingsStore'
import { hasProviderCredentials } from '@shared/providerConfig'

interface NewConversationScreenProps {
  onSend: (message: string, attachments?: ChatAttachment[]) => void
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
  /**
   * Suggested openers under the composer. The home screen passes the generated
   * set; a purpose-built conversation (Mental Coach) passes none, because a
   * session that starts with a preset role and context does not want to be
   * steered somewhere else on the way in.
   */
  ideas?: string[]
}

function pickWelcomeLine(lines: string[], firstName: string): string {
  if (lines.length === 0) return ''
  const line = lines[Math.floor(Math.random() * lines.length)]
  return renderWelcomeLine(line, firstName)
}

/** Three ideas to a page, which is what the carousel dots below them count. */
const IDEAS_PER_PAGE = 3

/**
 * The greeting sets at MAX and shrinks to hold one line — a quote that spills
 * two words onto a second line reads worse than one set slightly smaller. The
 * floor is the point past which shrinking costs more than the break does: below
 * it the greeting goes back to full size and wraps.
 */
const MAX_GREETING_PX = 38
const MIN_GREETING_PX = 30

/**
 * The screen a conversation starts from: greeting, the model/effort/memory/
 * context/role pills, and the composer. Rendered both as the home screen (via
 * WelcomeScreen, which adds the generated ideas) and on its own for a
 * conversation opened with its settings already chosen.
 */
export const NewConversationScreen: FC<NewConversationScreenProps> = ({
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
  ideas = [],
}) => {
  const [input, setInput] = useState('')
  const [greeting, setGreeting] = useState('')
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [ideaPage, setIdeaPage] = useState(0)
  const [attaching, setAttaching] = useState(false)
  // Latched on the first keystroke: clearing the box hides the panel again, but
  // re-typing shouldn't rebuild a preview that hasn't changed.
  const [promptPreviewArmed, setPromptPreviewArmed] = useState(false)
  const {
    attachments,
    error: attachError,
    setError: setAttachError,
    add: addAttachments,
    remove: removeAttachment,
    clear: clearAttachments,
    handlePaste,
  } = useAttachmentDraft()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const greetingRef = useRef<HTMLHeadingElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const { name: assistantName } = useAssistantIdentity()
  const customWelcomeLines = useSettingsStore((state) => state.settings?.welcomeLines)
  const hasApiKey = useSettingsStore((state) => hasProviderCredentials(state.settings?.provider))

  // The role decides who is greeting you. Holmes is the app itself, so he keeps
  // the user's chosen assistant name and their edited greetings; a character
  // playing a role speaks with its own name and its own lines, which is the
  // whole point of switching to it.
  const isComposing = input.trim().length > 0
  const draftSystemPrompt = useDraftSystemPrompt(promptPreviewArmed, memoryMode, selectedContext, selectedRoleId)

  const character = getCharacter(selectedRoleId)
  const isHolmes = isDefaultCharacter(character)
  const displayName = isHolmes ? assistantName : character.name
  // Re-rolls when the user edits the lines in Settings, so the editor's effect
  // is visible without restarting the app — and when the role changes.
  const welcomeLines = isHolmes && customWelcomeLines?.length ? customWelcomeLines : character.lines

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

  useLayoutEffect(() => {
    const heading = greetingRef.current
    const column = columnRef.current
    if (!heading || !column || !greeting) return

    // Measured rather than computed from a ratio: the display face does not
    // scale perfectly linearly, and a borderline line landing on the wrong side
    // of the floor is the difference between one tidy line and a two-word orphan.
    const fitGreeting = () => {
      heading.style.whiteSpace = 'nowrap'
      const fitsAt = (px: number) => {
        heading.style.fontSize = `${px}px`
        return heading.scrollWidth <= heading.clientWidth
      }
      let best = 0
      let low = MIN_GREETING_PX
      let high = MAX_GREETING_PX
      while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        if (fitsAt(mid)) {
          best = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      heading.style.whiteSpace = ''
      // Nothing down to the floor holds one line, so the greeting is long enough
      // that a break is the right answer — set it full size and let it wrap.
      heading.style.fontSize = `${best || MAX_GREETING_PX}px`
    }

    fitGreeting()

    // Until EB Garamond is actually loaded the browser measures the fallback
    // face, which is wider — that alone decides whether a borderline line gets
    // one tidy row or a two-word orphan. `fonts.ready` can resolve before the
    // heading's own face is requested, so wait on that face by name too, and
    // catch any later arrival through loadingdone.
    void document.fonts?.ready.then(fitGreeting)
    void document.fonts?.load(`${MAX_GREETING_PX}px "EB Garamond"`).then(fitGreeting).catch(() => {})
    document.fonts?.addEventListener('loadingdone', fitGreeting)

    // The column, not the heading: observing the heading would re-fire on every
    // size it sets. The column only changes when the window or sidebar does.
    const observer = new ResizeObserver(fitGreeting)
    observer.observe(column)
    return () => {
      observer.disconnect()
      document.fonts?.removeEventListener('loadingdone', fitGreeting)
    }
  }, [greeting])

  const handleSubmit = () => {
    const trimmed = input.trim()
    if (!trimmed && attachments.length === 0) return
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    setInput('')
    clearAttachments()
  }

  const handleAttach = async () => {
    if (attaching) return
    setAttaching(true)
    setAttachError(null)
    try {
      addAttachments(await window.electronAPI.app.selectAttachments())
    } catch (err) {
      const message = err instanceof Error
        ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
        : 'Could not attach that file'
      setAttachError(message)
    } finally {
      setAttaching(false)
    }
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
      el.style.height = Math.min(Math.max(el.scrollHeight, 144), 240) + 'px'
      setIsOverflowing(el.scrollHeight > 240)
    }
  }, [input])

  useEffect(() => {
    if (isComposing) setPromptPreviewArmed(true)
  }, [isComposing])

  // An idea that trails off ("Give me creative ideas for…") is a starting point,
  // not a question — those land in the box for the user to finish. A complete
  // one goes straight out.
  const handleIdea = (idea: string) => {
    if (/(…|\.\.\.)$/.test(idea)) {
      setInput(idea.replace(/(…|\.\.\.)$/, ''))
      inputRef.current?.focus()
      return
    }
    // Anything already staged goes with it — clicking an idea shouldn't
    // silently drop an image the user just pasted.
    onSend(idea, attachments.length > 0 ? attachments : undefined)
    clearAttachments()
  }

  const pageCount = Math.max(1, Math.ceil(ideas.length / IDEAS_PER_PAGE))
  const safePage = Math.min(ideaPage, pageCount - 1)
  const visibleIdeas = ideas.slice(safePage * IDEAS_PER_PAGE, safePage * IDEAS_PER_PAGE + IDEAS_PER_PAGE)

  return (
    <div className="flex h-full flex-col bg-holmes-bg">
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div ref={columnRef} className="w-full max-w-[710px]">
          <div className="mb-7 flex items-center gap-5">
            {/* The mark boils gently at rest here rather than sitting static.
                AnimatedMark falls back to AssistantMark when a custom assistant
                icon is set, so a customised install is unaffected. */}
            <AnimatedMark state="idle" className="h-10 w-10 shrink-0" color={character.color} />
            {/* flex-1, so the heading measures against the row's remaining space
                rather than its own text — a content-sized box always "fits". */}
            <div className="min-w-0 flex-1">
              {/* Not a heading, so index.css's display-heading tracking rule
                  misses it — set the same tightening the greeting uses so the
                  two lines read as one lockup. */}
              <div
                className="font-serif-display text-[17px] leading-none tracking-[-0.06em]"
                style={{ color: character.color }}
              >
                {displayName}
              </div>
              {/* index.css tightens every display heading via this custom
                  property, and that rule outranks a `tracking-*` utility — so
                  the greeting tunes its own kerning through the variable. */}
              <h1
                ref={greetingRef}
                className="-mt-1 font-serif-display text-[38px] font-normal leading-[1.05] text-[#afad9e] [--holmes-heading-tracking:-0.06em]"
              >
                {greeting}
              </h1>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
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

          <AttachmentTray
            attachments={attachments}
            error={attachError}
            onRemove={removeAttachment}
            onDismissError={() => setAttachError(null)}
          />

          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Type your message here..."
              rows={6}
              className={`h-36 max-h-60 w-full resize-none rounded-[18px] bg-[#3b3a3a] px-5 pt-4 pb-14 pr-14 text-sm text-white placeholder-white/25 outline-none transition-colors focus:bg-[#403f3f] ${
                isOverflowing ? 'scrollbar-thin' : 'no-scrollbar'
              }`}
            />
            {/* The tray can be filled by paste alone, but a box that only
                accepts images from the clipboard is a feature you have to be
                told about — the plus sits in the composer, opposite Send. */}
            <button
              onClick={() => void handleAttach()}
              disabled={attaching || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              aria-label="Attach image or video"
              title={attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE ? `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments` : 'Attach image or video'}
              className="absolute left-3 bottom-3 flex h-9 w-9 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              <FontAwesomeIcon icon={attaching ? faImage : faPlus} className="w-4 h-4" />
            </button>
            <button
              onClick={handleSubmit}
              disabled={!input.trim() && attachments.length === 0}
              aria-label="Send"
              className={`absolute right-3 bottom-3 p-2 bg-holmes-primary hover:bg-holmes-primary-dark disabled:bg-holmes-primary/40 disabled:cursor-not-allowed text-white rounded-lg transition-all duration-150 flex items-center justify-center ${
                input.trim() || attachments.length > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
            {/* Out of flow and only faded in, so the composer and everything
                under it never move: on an untouched screen the disclosure is a
                row of chrome under an empty box, and a greeting that jumps when
                you start typing is worse than either. The opaque backing is the
                page colour, so an expanded panel covers the ideas rather than
                reading through them. */}
            <div
              aria-hidden={!isComposing}
              className={`absolute inset-x-0 top-full z-10 bg-holmes-bg pt-3 transition-opacity duration-300 ${
                isComposing ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              <SystemPromptPanel
                entries={draftSystemPrompt.entries}
                loading={draftSystemPrompt.loading}
              />
            </div>
          </div>

          {visibleIdeas.length > 0 && (
            <div className="mt-[54px]">
              <p className="font-serif-display text-[15px] text-[#6f6c62]">Ideas</p>
              <div className="mt-3 flex flex-col items-start gap-[11px]">
                {visibleIdeas.map((idea) => (
                  <button
                    key={idea}
                    onClick={() => handleIdea(idea)}
                    className="max-w-full truncate text-left text-[13px] text-white/75 transition-colors hover:text-white cursor-pointer"
                  >
                    {idea}
                  </button>
                ))}
              </div>

              {pageCount > 1 && (
                <div className="mt-11 flex items-center justify-center gap-1.5">
                  {Array.from({ length: pageCount }, (_, page) => (
                    <button
                      key={page}
                      onClick={() => setIdeaPage(page)}
                      aria-label={`Show ideas ${page + 1} of ${pageCount}`}
                      aria-current={page === safePage}
                      className={`shrink-0 rounded-full bg-[#635d59] transition-all cursor-pointer ${
                        page === safePage ? 'h-3 w-3' : 'h-[7px] w-[7px] opacity-80 hover:opacity-100'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Only until there is a key: once the app works, the footer is just noise
          under the ideas. */}
      {!hasApiKey && (
        <div className="py-4 text-center">
          <p className="text-xs text-white/20">
            {assistantName} v0.1 — Configure your API key in Settings to get started
          </p>
        </div>
      )}
    </div>
  )
}
