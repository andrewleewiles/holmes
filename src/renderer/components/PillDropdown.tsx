import { type FC, type ReactNode, useEffect, useRef, useState } from 'react'

/**
 * The mockup's pill: 33px tall, a hairline outline on near-black, small label.
 * Exported so ModelSelector — which needs its own trigger markup for the "Free"
 * badge — stays the same shape as the rest of the row.
 */
export const PILL_TRIGGER_CLASS =
  'flex h-[33px] shrink-0 items-center gap-2 rounded-full border border-[#515149] bg-[#262626] px-3 text-xs text-white transition-colors hover:bg-[#323232] cursor-pointer disabled:opacity-50'

export const PillCaret: FC = () => (
  <svg className="h-2.5 w-2.5 shrink-0 text-white/45" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path d="M1 3.2h8L5 7.6z" />
  </svg>
)

export interface PillDropdownOption {
  value: string
  label: string
  icon?: ReactNode
  hint?: string
}

interface PillDropdownProps {
  icon: ReactNode
  label: string
  value: string
  options: PillDropdownOption[]
  onSelect: (value: string) => void
  disabled?: boolean
  align?: 'left' | 'right'
  renderPanel?: (close: () => void) => ReactNode
  iconOnly?: boolean
}

export const PillDropdown: FC<PillDropdownProps> = ({
  icon,
  label,
  value,
  options,
  onSelect,
  disabled,
  align = 'left',
  renderPanel,
  iconOnly,
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const close = () => setOpen(false)
  const selected = options.find((o) => o.value === value)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={PILL_TRIGGER_CLASS}
      >
        <span className="flex items-center justify-center text-white/90 shrink-0">{icon}</span>
        {!iconOnly && (
          <>
            <span className="max-w-[160px] truncate">{selected?.label || label}</span>
            <PillCaret />
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} min-w-56 max-h-80 bg-holmes-surface border border-white/10 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden`}
        >
          {renderPanel ? (
            renderPanel(close)
          ) : (
            <div className="overflow-y-auto flex-1 scrollbar-thin py-1">
              {options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    onSelect(option.value)
                    close()
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors cursor-pointer text-left ${
                    option.value === value
                      ? 'bg-holmes-primary/20 text-holmes-primary-light'
                      : 'text-white/70 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {option.icon && (
                    <span className="flex items-center justify-center w-4 h-4 shrink-0">{option.icon}</span>
                  )}
                  <span className="flex-1 truncate">{option.label}</span>
                  {option.hint && (
                    <span className="text-[10px] text-white/30 shrink-0">{option.hint}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
