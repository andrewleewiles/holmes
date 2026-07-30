import { type FC, useState } from 'react'

interface ThinkingDisclosureProps {
  reasoning: string
  /** True while this turn is still arriving. */
  isStreaming?: boolean
  /** True once the answer itself has started, which is what closes the block. */
  hasContent?: boolean
}

/**
 * The turn's reasoning, behind one quiet disclosure.
 *
 * Deliberately understated: sentence case rather than a shouted THINKING label,
 * and one per turn rather than one per stored row. While the model is still
 * thinking the label shimmers and the block is open, because that is the only
 * thing happening; the moment prose starts arriving it collapses on its own and
 * the answer takes over. Reopening is then the reader's choice, and stays theirs —
 * once toggled by hand it is never auto-closed underneath them.
 */
export const ThinkingDisclosure: FC<ThinkingDisclosureProps> = ({ reasoning, isStreaming, hasContent }) => {
  const [toggled, setToggled] = useState<boolean | null>(null)

  const thinkingNow = Boolean(isStreaming && !hasContent)
  const open = toggled ?? thinkingNow

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
      >
        <svg
          className={`h-2.5 w-2.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
        >
          <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={thinkingNow ? 'holmes-shimmer' : ''}>
          {thinkingNow ? 'Thinking' : 'Thought process'}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 max-h-72 overflow-y-auto scrollbar-thin whitespace-pre-wrap border-l border-white/10 pl-3 text-xs leading-relaxed text-white/40">
          {reasoning}
          {thinkingNow && (
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-white/40 align-middle" />
          )}
        </div>
      )}
    </div>
  )
}
