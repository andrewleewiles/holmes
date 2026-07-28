import { type FC, useEffect } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faArrowRight, faFolderTree, faTriangleExclamation, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { OrganizePlan, OrganizeResult } from '@shared/types'

interface OrganizeBooksDialogProps {
  plan: OrganizePlan | null
  planning: boolean
  applying: boolean
  result: OrganizeResult | null
  error: string | null
  onApply: () => void
  onClose: () => void
}

export const OrganizeBooksDialog: FC<OrganizeBooksDialogProps> = ({
  plan,
  planning,
  applying,
  result,
  error,
  onApply,
  onClose,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, applying])

  const moves = plan?.entries.filter((entry) => entry.targetPath && !entry.skipped) ?? []
  const skips = plan?.entries.filter((entry) => entry.skipped) ?? []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={applying ? undefined : onClose}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <FontAwesomeIcon icon={faFolderTree} className="text-[13px] text-violet-300/70" />
          <h2 className="font-serif-display text-[17px] text-white/85">Organise book files</h2>
          <button
            onClick={onClose}
            disabled={applying}
            className="ml-auto cursor-pointer text-white/30 hover:text-white/70 disabled:opacity-30"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-3">
          {/* This moves real files, so it says so before it does anything. */}
          <p className="mb-3 text-[11px] leading-relaxed text-white/45">
            Each book moves into a <span className="text-white/70">[Author] - [Title]</span> folder beside where it
            sits now. Covers and metadata files sharing its name travel with it. Nothing leaves the folder you
            connected, and nothing is overwritten.
          </p>

          {planning ? (
            <p className="text-[11px] text-white/30">Working out the names…</p>
          ) : result ? (
            <div className="space-y-2">
              <div className="rounded-lg border border-holmes-primary/20 bg-holmes-primary/[0.07] px-3 py-2 text-[11px] text-holmes-primary-light/80">
                Moved {result.moved} book{result.moved === 1 ? '' : 's'}
                {result.skipped > 0 && `, left ${result.skipped} where they were`}.
              </div>
              {result.failed.length > 0 && (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2 text-[11px] text-amber-200/80">
                  <div className="mb-1 flex items-center gap-1.5">
                    <FontAwesomeIcon icon={faTriangleExclamation} />
                    {result.failed.length} could not be moved:
                  </div>
                  <ul className="space-y-0.5">
                    {result.failed.map((failure) => (
                      <li key={failure.bookId} className="text-[10px] text-amber-200/65">
                        {failure.title} — {failure.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : !plan ? (
            <p className="text-[11px] text-white/30">Nothing to organise yet.</p>
          ) : (
            <>
              {moves.length === 0 ? (
                <p className="text-[11px] text-white/30">Every book is already filed.</p>
              ) : (
                <div className="space-y-1">
                  {moves.map((entry) => (
                    <div
                      key={entry.bookId}
                      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-white/45" title={entry.currentPath}>
                          {entry.currentPath.split('/').slice(-1)[0]}
                        </span>
                        <FontAwesomeIcon icon={faArrowRight} className="shrink-0 text-[9px] text-white/20" />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-white/75" title={entry.targetPath ?? ''}>
                          {entry.folderName}/
                        </span>
                      </div>
                      {entry.sidecars.length > 0 && (
                        <div className="mt-0.5 text-[9px] text-white/25">
                          + {entry.sidecars.length} companion file{entry.sidecars.length === 1 ? '' : 's'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {skips.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-white/25">
                    {skips.length} left alone
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {skips.map((entry) => (
                      <li key={entry.bookId} className="text-[10px] text-white/30">
                        {entry.title} — {entry.skipped}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {error && <p className="mt-3 text-[10px] leading-relaxed text-red-200/75">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3">
          <span className="text-[10px] tabular-nums text-white/30">
            {plan && !result ? `${moves.length} to move · ${skips.length} unchanged` : ''}
          </span>
          <button
            onClick={onClose}
            disabled={applying}
            className="ml-auto cursor-pointer rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/50 hover:border-white/20 hover:text-white/75 disabled:opacity-40"
          >
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={onApply}
              disabled={applying || planning || moves.length === 0}
              className="cursor-pointer rounded-lg bg-holmes-primary px-3 py-2 text-xs font-medium text-white hover:bg-holmes-primary-light disabled:opacity-40"
            >
              {applying ? 'Moving…' : `Move ${moves.length} file${moves.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
