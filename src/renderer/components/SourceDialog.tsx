import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { IconPicker } from './IconPicker'

export const PROJECT_COLOR_OPTIONS = ['#47a08f', '#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4']

interface SourceDialogProps {
  mode: 'create' | 'edit'
  initialName?: string
  initialIcon?: string
  initialColor?: string
  busy?: boolean
  error?: string | null
  onSelectImage: () => Promise<string | null>
  onSubmit: (value: { name: string; icon: string; color: string }) => void
  onClose: () => void
}

export const SourceDialog: FC<SourceDialogProps> = ({
  mode,
  initialName = '',
  initialIcon = 'folder',
  initialColor = PROJECT_COLOR_OPTIONS[0],
  busy,
  error,
  onSelectImage,
  onSubmit,
  onClose,
}) => {
  const [name, setName] = useState(initialName)
  const [icon, setIcon] = useState(initialIcon)
  const [color, setColor] = useState(initialColor)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    onSubmit({ name: trimmed, icon, color })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onClose}>
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-5 py-3.5">
          <h2 className="flex-1 font-serif-display text-lg text-white/85">
            {mode === 'create' ? 'Add new source' : 'Edit source'}
          </h2>
          <button
            onClick={onClose}
            className="text-white/35 transition-colors hover:text-white/70 cursor-pointer"
            aria-label="Close"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
          <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-white/35">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
            placeholder="Photos, Journals, Work…"
            className="mb-4 w-full rounded-md border border-white/15 bg-transparent px-3 py-2 text-sm text-white outline-none focus:border-holmes-primary"
          />

          <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-white/35">Icon</label>
          <div className="mb-4">
            <IconPicker value={icon} onChange={setIcon} onSelectImage={onSelectImage} />
          </div>

          <label className="mb-1.5 block text-[11px] uppercase tracking-wider text-white/35">Colour</label>
          <div className="mb-4 flex gap-2">
            {PROJECT_COLOR_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => setColor(option)}
                className={`h-6 w-6 rounded-full border-2 transition-transform cursor-pointer ${
                  color === option ? 'scale-110 border-white' : 'border-transparent'
                }`}
                style={{ backgroundColor: option }}
                title={option}
              />
            ))}
          </div>

          {error && <p className="mb-3 text-[11px] text-red-300/80">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={!name.trim() || busy}
              className="rounded-md bg-holmes-primary px-3 py-1.5 text-xs text-white transition-colors hover:bg-holmes-primary-light disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              {busy ? 'Saving…' : mode === 'create' ? 'Add source' : 'Save'}
            </button>
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-white/50 transition-colors hover:text-white/80 cursor-pointer"
            >
              Cancel
            </button>
            {mode === 'create' && (
              <span className="ml-auto text-[10px] text-white/30">Connect its directories after adding.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
