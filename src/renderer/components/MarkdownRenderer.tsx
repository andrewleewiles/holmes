import { type FC, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { CitedSource } from '@shared/types'
import { SourcePill } from './SourcePill'
import { hasSourceMarker, rehypeSourcePills, stripTrailingPartialMarker } from './sourceMarkers'

interface MarkdownRendererProps {
  content: string
  /**
   * Extra classes for the prose root. Size modifiers (`prose-lg`) have to land
   * here rather than on a parent: `.prose` sets its own font-size, so a size set
   * further up never reaches the paragraphs.
   */
  className?: string
  /**
   * The sources the turn behind this text read, if any. `[S1]` markers resolve
   * against these and render as pills; a marker that matches nothing here is
   * dropped rather than shown.
   */
  sources?: CitedSource[]
  /** True while this text is still arriving, so a half-typed marker stays hidden. */
  isStreaming?: boolean
}

export const MarkdownRenderer: FC<MarkdownRendererProps> = ({ content, className, sources, isStreaming }) => {
  const cited = sources && sources.length > 0 ? sources : null

  const text = useMemo(
    () => (isStreaming && cited && hasSourceMarker(content) ? stripTrailingPartialMarker(content) : content),
    [content, isStreaming, cited],
  )

  const rehypePlugins = useMemo(
    () => (cited ? [rehypeHighlight, rehypeSourcePills(cited)] : [rehypeHighlight]),
    [cited],
  )

  const sourceById = useMemo(() => new Map((cited ?? []).map((source) => [source.id, source])), [cited])

  return (
    <div
      className={`prose prose-invert max-w-none prose-headings:text-white prose-a:text-holmes-primary-light prose-code:text-holmes-primary prose-pre:bg-black/40 prose-pre:border prose-pre:border-white/10${
        className ? ` ${className}` : ''
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          a: ({ href, children, ...props }) => {
            // rehypeSourcePills marks its anchors so they can be picked out of
            // the ordinary links here rather than needing a tag of their own.
            const sourceId = (props as Record<string, unknown>)['data-source-id']
            if (typeof sourceId === 'string') {
              const source = sourceById.get(sourceId)
              return source ? <SourcePill source={source} /> : null
            }
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href) window.electronAPI.app.openExternal(href)
                }}
              >
                {children}
              </a>
            )
          },
          // `node` is react-markdown's own hast node. It arrives alongside the
          // element props and has to be dropped here, or spreading the rest onto
          // <code> writes it out as node="[object Object]".
          code: ({ className, children, node: _node, ...props }) => {
            const isInline = !className
            if (isInline) {
              return (
                <code className="bg-white/10 px-1 rounded text-sm" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
