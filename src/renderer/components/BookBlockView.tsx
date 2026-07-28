import { type FC, useEffect, useState } from 'react'
import type { BookAnnotation, BookBlock, BookInline } from '@shared/types'
import { AnnotatedInline, type AudioHighlight } from './AnnotatedInline'

interface AnnotationLayer {
  annotations: BookAnnotation[]
  accentFor: (annotation: BookAnnotation) => string
  activeId: string | null
  onActivate: (id: string | null) => void
}

interface BookBlockViewProps {
  bookId: string
  block: BookBlock
  onNavigate: (chapterIndex: number, anchor?: string) => void
  /** Absent while annotations are loading, or when there are none. */
  layer?: AnnotationLayer
  /** Where the narration has reached. Absent when nothing is playing. */
  audio?: AudioHighlight
  onSeekToOffset?: (offset: number) => void
}

const HEADING_CLASS: Record<string, string> = {
  h1: 'font-serif-display text-[26px] leading-tight text-white/85 mt-8 mb-4',
  h2: 'font-serif-display text-[22px] leading-tight text-white/85 mt-7 mb-3',
  h3: 'font-serif-display text-[19px] leading-snug text-white/80 mt-6 mb-2',
  h4: 'font-serif-display text-[17px] leading-snug text-white/75 mt-5 mb-2',
  h5: 'font-serif-display text-[15px] leading-snug text-white/70 mt-4 mb-2',
  h6: 'font-serif-display text-[14px] uppercase tracking-wider text-white/55 mt-4 mb-2',
}

const MARK_CLASS: Record<string, string> = {
  em: 'italic',
  strong: 'font-semibold text-white/90',
  code: 'font-mono text-[0.9em] text-holmes-primary-light',
  small: 'text-[0.85em] text-white/55',
}

/** An image is fetched on demand: inlining it would make a chapter payload multi-MB. */
const BookImage: FC<{ bookId: string; resourceId: string; alt?: string }> = ({ bookId, resourceId, alt }) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.library
      .getResource(bookId, resourceId)
      .then((resource) => { if (!cancelled) setDataUrl(resource.dataUrl) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [bookId, resourceId])

  if (failed) return null
  if (!dataUrl) return <div className="my-6 h-40 rounded-lg bg-white/[0.03]" />
  return (
    <figure className="my-6">
      <img src={dataUrl} alt={alt ?? ''} className="mx-auto max-h-[70vh] max-w-full rounded-lg" />
    </figure>
  )
}

const Inline: FC<{
  run: BookInline
  onNavigate: BookBlockViewProps['onNavigate']
  layer?: AnnotationLayer
  audio?: AudioHighlight
  onSeekToOffset?: (offset: number) => void
}> = ({ run, onNavigate, layer, audio, onSeekToOffset }) => {
  const className = (run.marks ?? []).map((mark) => MARK_CLASS[mark] ?? '').filter(Boolean).join(' ')
  const style = (children: React.ReactNode, key: string) => {
    let node = children
    // sup/sub need real elements; the rest are styling only.
    if (run.marks?.includes('sup')) node = <sup>{node}</sup>
    if (run.marks?.includes('sub')) node = <sub>{node}</sub>
    return className ? <span key={key} className={className}>{node}</span> : <span key={key}>{node}</span>
  }
  // Annotation spans are applied INSIDE the inline run, so a highlight that
  // covers half an italic phrase underlines exactly that half.
  const wrap = (children: React.ReactNode) => {
    const marked = (layer && layer.annotations.length > 0) || Boolean(audio?.word) || Boolean(audio?.sentence)
    if (!marked) return style(children, 'run')
    if (typeof children !== 'string') return style(children, 'run')
    return (
      <AnnotatedInline
        text={children}
        start={run.start}
        annotations={layer?.annotations ?? []}
        accentFor={layer?.accentFor ?? (() => 'slate')}
        activeId={layer?.activeId ?? null}
        onActivate={layer?.onActivate ?? (() => {})}
        audio={audio}
        onSeekToOffset={onSeekToOffset}
        wrap={style}
      />
    )
  }

  if (run.link?.kind === 'external') {
    const url = run.link.url
    return (
      <a
        href={url}
        onClick={(event) => {
          // Never a real navigation: the window's will-navigate is blocked, and
          // an in-app jump to a book's outbound link would be a trap.
          event.preventDefault()
          void window.electronAPI.app.openExternal(url)
        }}
        className="cursor-pointer text-holmes-primary-light underline decoration-holmes-primary/30 underline-offset-2 hover:decoration-holmes-primary"
      >
        {wrap(run.text)}
      </a>
    )
  }

  if (run.link?.kind === 'internal') {
    const link = run.link
    return (
      <button
        onClick={() => onNavigate(link.chapterIndex, link.anchor)}
        className="cursor-pointer text-holmes-primary-light/90 underline decoration-holmes-primary/25 underline-offset-2 hover:decoration-holmes-primary"
      >
        {wrap(run.text)}
      </button>
    )
  }

  return wrap(run.text)
}

export const BookBlockView: FC<BookBlockViewProps> = ({ bookId, block, onNavigate, layer, audio, onSeekToOffset }) => {
  if (block.kind === 'img') {
    return block.resourceId
      ? <BookImage bookId={bookId} resourceId={block.resourceId} alt={block.alt} />
      : null
  }
  if (block.kind === 'hr') return <hr className="my-8 border-white/[0.08]" />
  // A page break is an anchor for citations, not something to render.
  if (block.kind === 'pagebreak') return null

  // Only the annotations that actually overlap this block reach it, so a chapter
  // with 200 annotations does not run the sweep 200 times per paragraph.
  const blockLayer = layer
    ? {
        ...layer,
        annotations: layer.annotations.filter(
          (annotation) => annotation.charEnd > block.start && annotation.charStart < block.end
        ),
      }
    : undefined

  // Only pass the audio marks down when they actually touch this block, so a
  // chapter of 300 paragraphs does not re-run the sweep on all of them each
  // time the spoken word advances.
  const blockAudio: AudioHighlight | undefined = audio
    ? {
        word: audio.word && audio.word.end > block.start && audio.word.start < block.end ? audio.word : null,
        sentence:
          audio.sentence && audio.sentence.end > block.start && audio.sentence.start < block.end
            ? audio.sentence
            : null,
      }
    : undefined
  const hasAudio = Boolean(blockAudio?.word || blockAudio?.sentence)

  const children = block.inlines.map((run, index) => (
    <Inline
      key={`${run.start}-${index}`}
      run={run}
      onNavigate={onNavigate}
      layer={blockLayer}
      audio={hasAudio ? blockAudio : undefined}
      onSeekToOffset={onSeekToOffset}
    />
  ))

  if (HEADING_CLASS[block.kind]) {
    const Tag = block.kind as 'h1'
    return <Tag id={block.anchorId} className={HEADING_CLASS[block.kind]}>{children}</Tag>
  }

  switch (block.kind) {
    case 'blockquote':
      return (
        <blockquote id={block.anchorId} className="my-5 border-l-2 border-white/15 pl-4 text-white/65 italic">
          {children}
        </blockquote>
      )
    case 'pre':
      return (
        <pre id={block.anchorId} className="my-5 overflow-x-auto rounded-lg bg-black/25 p-3 font-mono text-[13px] text-white/70">
          {children}
        </pre>
      )
    case 'li':
      return (
        <li
          id={block.anchorId}
          className="my-1.5 ml-6 list-outside"
          style={{
            listStyleType: block.listOrdered ? 'decimal' : 'disc',
            marginLeft: `${1.5 + (block.listDepth ?? 0)}rem`,
          }}
        >
          {children}
        </li>
      )
    case 'figcaption':
      return <figcaption id={block.anchorId} className="my-3 text-center text-[13px] text-white/45">{children}</figcaption>
    default:
      return <p id={block.anchorId} className="my-4">{children}</p>
  }
}
