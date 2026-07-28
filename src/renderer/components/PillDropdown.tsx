import { type FC, type ReactNode, useEffect, useRef, useState } from 'react'

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
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#2e2e2e] border border-[#444] text-sm text-white hover:bg-[#383838] transition-colors cursor-pointer disabled:opacity-50 h-9"
      >
        <span className="flex items-center justify-center text-white/80 shrink-0">{icon}</span>
        {!iconOnly && (
          <>
            <span className="max-w-[160px] truncate">{selected?.label || label}</span>
            <svg className="w-3 h-3 text-white/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
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
