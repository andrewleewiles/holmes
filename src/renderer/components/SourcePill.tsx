import { type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faGlobe, faFileLines } from '@fortawesome/free-solid-svg-icons'
import type { CitedSource } from '@shared/types'

/**
 * An inline attribution: the small chip a `[S1]` marker becomes.
 *
 * Sans-serif against the response's serif body on purpose — it is a piece of
 * interface sitting inside prose, and reading as one keeps it from being mistaken
 * for the text it supports.
 *
 * A web source shows its hostname, not a favicon: fetching one would mean a
 * request to the site (or worse, a favicon service) for every source in every
 * answer, which is a per-source disclosure of what the user is reading.
 */
export const SourcePill: FC<{ source: CitedSource }> = ({ source }) => {
  const isWeb = source.kind === 'web'
  const target = isWeb ? source.url : source.path

  const open = () => {
    if (isWeb && source.url) {
      void window.electronAPI.app.openExternal(source.url)
      return
    }
    if (source.path) void window.electronAPI.app.openSourcePath(source.path)
  }

  const tooltip = [
    source.title,
    target,
    isWeb ? null : 'Click to show in Finder',
  ].filter(Boolean).join('\n')

  return (
    <button
      type="button"
      onClick={open}
      title={tooltip}
      className="mx-0.5 inline-flex max-w-[13rem] cursor-pointer items-center gap-1 rounded-md border border-white/[0.12] bg-white/[0.06] px-1.5 py-px align-baseline font-sans text-[0.72em] leading-normal text-white/55 transition-colors hover:border-holmes-primary/40 hover:bg-holmes-primary/10 hover:text-white"
    >
      <FontAwesomeIcon icon={isWeb ? faGlobe : faFileLines} className="shrink-0 opacity-70" />
      <span className="truncate">{source.label}</span>
    </button>
  )
}
