import { type FC } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

interface MarkdownRendererProps {
  content: string
}

export const MarkdownRenderer: FC<MarkdownRendererProps> = ({ content }) => {
  return (
    <div className="prose prose-invert max-w-none prose-headings:text-white prose-a:text-holmes-primary-light prose-code:text-holmes-primary prose-pre:bg-black/40 prose-pre:border prose-pre:border-white/10">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href) window.electronAPI.app.openExternal(href)
              }}
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
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
        {content}
      </ReactMarkdown>
    </div>
  )
}
