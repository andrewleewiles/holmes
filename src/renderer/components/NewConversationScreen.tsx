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
import { boilFontsReady } from '../boil/boilFonts'
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
 * Milliseconds per character of the greeting. A typical line lands in about two
 * seconds — long enough to read as speech against the talking clip, short enough
 * that the composer isn't waiting on it.
 */
const GREETING_TYPE_MS = 34

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

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
  // How much of the greeting has been printed. The rest is still in the DOM but
  // invisible, so the line never reflows as it types. The line it counts is
  // stored with it: a re-roll (role change, edited lines) would otherwise paint
  // the new greeting at the old line's count for one frame before resetting.
  const [typed, setTyped] = useState({ line: '', count: 0 })
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [identityLoaded, setIdentityLoaded] = useState(false)
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
  const settingsLoaded = useSettingsStore((state) => state.settings !== null)
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
    }).finally(() => setIdentityLoaded(true))
    inputRef.current?.focus()
  }, [])

  // Held until the name and the stored lines are both in: each of those arrives
  // asynchronously and would otherwise re-roll the greeting a beat after mount,
  // which the typewriter turns from an invisible swap into a visible restart.
  useEffect(() => {
    if (!identityLoaded || !settingsLoaded) return
    setGreeting(pickWelcomeLine(welcomeLines, firstName))
  }, [identityLoaded, settingsLoaded, welcomeLines, firstName])

  // Holmes speaks his line rather than having it already said: one character at
  // a time, with the mark on its talking clip until the last one lands.
  useEffect(() => {
    if (!greeting) return
    if (prefersReducedMotion()) {
      setTyped({ line: greeting, count: greeting.length })
      return
    }
    setTyped({ line: greeting, count: 0 })
    let printed = 0
    const timer = window.setInterval(() => {
      printed += 1
      setTyped({ line: greeting, count: printed })
      if (printed >= greeting.length) window.clearInterval(timer)
    }, GREETING_TYPE_MS)
    return () => window.clearInterval(timer)
  }, [greeting])

  const typedCount = typed.line === greeting ? typed.count : 0
  const isSpeaking = greeting.length > 0 && typedCount < greeting.length

  useLayoutEffect(() => {
    const heading = greetingRef.current
    const column = columnRef.current
    if (!heading || !column || !greeting) return

    // Measured rather than computed from a ratio: the display face does not
    // scale perfectly linearly, and a borderline line landing on the wrong side
    // of the floor is the difference between one tidy line and a two-word orphan.
    const fitGreeting = () => {
      // A late arrival (a font landing after the screen was left) would measure
      // a detached node, where every size "fits".
      if (!heading.isConnected) return
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

    // Until the display face is actually loaded the browser measures a fallback,
    // which is wider — that alone decides whether a borderline line gets one
    // tidy row or a two-word orphan. `fonts.ready` can resolve before the
    // heading's own faces are requested, so wait on the boil faces by name
    // (boilFontsReady does exactly that, and it is what un-hides this text), and
    // catch any later arrival through loadingdone.
    void document.fonts?.ready.then(fitGreeting)
    void boilFontsReady().then(fitGreeting)
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
            <AnimatedMark
              state={isSpeaking ? 'talking' : 'idle'}
              className="h-10 w-10 shrink-0"
              color={character.color}
            />
            {/* flex-1, so the heading measures against the row's remaining space
                rather than its own text — a content-sized box always "fits".

                boil-reveal keeps the lockup invisible until the display face is
                loaded (index.css + boil/boilFonts.ts). This is the one piece of
                display type on screen from the very first frame, and the ten
                boil faces arriving one keyframe at a time made the wordmark
                visibly re-set itself for the first second. Laid out either way,
                so nothing around it moves when it appears. */}
            <div className="boil-reveal min-w-0 flex-1">
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
                {greeting.slice(0, typedCount)}
                {/* The unsaid remainder, invisible but still laid out: it keeps
                    the fitted size and the line count fixed from the first
                    character, so nothing under the greeting shifts as it prints,
                    and it is what the size measurement below is taken against.
                    Not aria-hidden — a screen reader should get the whole line
                    at once rather than watch it appear. */}
                {typedCount < greeting.length && (
                  <span className="opacity-0">{greeting.slice(typedCount)}</span>
                )}
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
              // `block` is load-bearing: a textarea is inline-block and sits on
              // the text baseline, which leaves ~6px of line-box under it inside
              // the relative wrapper. The Send and attach buttons are positioned
              // against that wrapper, so `bottom-3` measured 6px from the box's
              // visible edge while `right-3`/`left-3` measured the full 12px, and
              // the corners looked lopsided. Taking the textarea out of the line
              // box makes the wrapper exactly the box, and the insets equal.
              className={`block h-36 max-h-60 w-full resize-none rounded-[18px] bg-[#3b3a3a] px-5 pt-4 pb-14 pr-14 text-sm text-white placeholder-white/25 outline-none transition-colors focus:bg-[#403f3f] ${
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
              className={`group absolute right-3 bottom-3 p-2 bg-holmes-primary hover:bg-holmes-primary-dark disabled:bg-holmes-primary/40 disabled:cursor-not-allowed text-white rounded-lg transition-all duration-150 flex items-center justify-center ${
                input.trim() || attachments.length > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              {/* A closed block arrow rather than a stroked line, so the glyph
                  has an inside: hollow at rest, flooded white on hover. The fill
                  is `transparent` and not `none` because only the former can be
                  transitioned, and a fill that snaps reads as a different icon
                  swapping in rather than the same one filling up.

                  `data-boil-always` opts the arrow into the icon boil. That
                  effect finds its icons by their turquoise, and this one is white
                  on a turquoise chip, so it has to ask. */}
              <svg
                data-boil-always
                className="h-5 w-5 fill-transparent transition-[fill] duration-150 group-hover:fill-white"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.8}
                  d="M4.4 10.1H12.3V5.6L19.6 12L12.3 18.4V13.9H4.4Z"
                />
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
