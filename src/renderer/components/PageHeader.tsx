import { type FC, type ReactNode } from 'react'

interface PageHeaderProps {
  /** Rendered at 25px in the primary colour — pass <FontAwesomeIcon icon={faX} className={PAGE_HEADER_ICON} />. */
  icon?: ReactNode
  title: string
  /** Small items that sit next to the title (counts, scope pickers). */
  aside?: ReactNode
  /** Buttons pushed to the right edge. */
  actions?: ReactNode
  /** A secondary row (filters, search) kept inside the sticky bar. */
  below?: ReactNode
}

/** Size and colour every page header icon shares. */
export const PAGE_HEADER_ICON = 'text-[25px] text-holmes-primary'

/**
 * The one page header. Every non-conversation page uses this so the bar,
 * the serif title, and the action row line up from page to page.
 */
export const PageHeader: FC<PageHeaderProps> = ({ icon, title, aside, actions, below }) => (
  <div className="sticky top-0 z-30 border-b border-white/[0.06] bg-holmes-bg/95 backdrop-blur">
    <div className="flex items-center gap-3 px-6 py-3.5">
      {icon}
      <h1 className="font-serif-display text-[27px] leading-none text-white/85">{title}</h1>
      {aside}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
    {below && <div className="px-6 pb-3">{below}</div>}
  </div>
)
