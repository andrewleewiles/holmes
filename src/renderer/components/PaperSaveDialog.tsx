import { type FC, useEffect } from 'react'

/**
 * Asked once, the first time a document shown in paper mode is saved.
 *
 * The whole point is that the screen and the file disagree. Holmes draws a new
 * document as itself — no page, white text, set in Holmes Minion — but the page
 * and the text colour are a view treatment that lives in the editor, not in the
 * .docx. Save it and the look is gone: white paper, black text, and a font
 * nobody else has.
 *
 * So the choice is put plainly rather than hidden behind a "don't show again":
 * make the look real, or write the ordinary document. Both are one click, and
 * whichever is chosen the document stops being in two states at once, which is
 * why this never asks a second time.
 */

interface PaperSaveDialogProps {
  /** The face the document is currently set in. */
  font: string
  onKeep: () => void
  onDrop: () => void
  onCancel: () => void
}

const CHOICE =
  'w-full rounded-xl border px-4 py-3 text-left transition-colors cursor-pointer'

export const PaperSaveDialog: FC<PaperSaveDialogProps> = ({ font, onKeep, onDrop, onCancel }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onMouseDown={onCancel}>
      <div
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-holmes-surface shadow-2xl"
      >
        <div className="border-b border-white/[0.07] px-5 py-3.5">
          <h2 className="font-serif-display text-lg text-white/85">This is not how it will save</h2>
        </div>

        <div className="px-5 py-4">
          <p className="text-[13px] leading-relaxed text-white/55">
            The dark page and the white text are how Holmes shows the document, not
            what is in it. Saved as it stands, the file is an ordinary white page
            with black text — set in {font}, which other machines do not have.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={onKeep}
              className={`${CHOICE} border-holmes-primary/40 bg-holmes-primary/[0.07] hover:border-holmes-primary hover:bg-holmes-primary/[0.12]`}
            >
              <span className="block text-[14px] text-white/85">Keep the Holmes look</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-white/45">
                Writes the dark page and the white text into the document, so it
                stays legible. Word shows page colours but does not print them.
              </span>
            </button>

            <button
              onClick={onDrop}
              className={`${CHOICE} border-white/[0.12] hover:border-white/25 hover:bg-white/[0.03]`}
            >
              <span className="block text-[14px] text-white/85">Save an ordinary document</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-white/45">
                Puts the default font back and drops the treatment. What you see
                from here on is what the file holds.
              </span>
            </button>
          </div>
        </div>

        <div className="flex justify-end border-t border-white/[0.07] px-5 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/[0.12] px-2.5 py-1 text-[13px] text-white/60 transition-colors hover:border-white/25 hover:text-white/85 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
