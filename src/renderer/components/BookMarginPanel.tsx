import type { FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faThumbtack, faTrash, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { BookAnnotation, BookAnnotationRun, BookLesson } from '@shared/types'

interface BookMarginPanelProps {
  annotations: BookAnnotation[]
  runs: BookAnnotationRun[]
  lessons: BookLesson[]
  chapterIndex: number
  activeId: string | null
  accentFor: (annotation: BookAnnotation) => string
  onActivate: (id: string | null) => void
  onScrollTo: (annotation: BookAnnotation) => void
  onTogglePin: (annotation: BookAnnotation) => void
  onDelete: (annotation: BookAnnotation) => void
  onDeleteRun: (run: BookAnnotationRun) => void
  onOpenLesson: (lesson: BookLesson) => void
}

const DOT_COLOR: Record<string, string> = {
  violet: 'bg-violet-400', sky: 'bg-sky-400', emerald: 'bg-emerald-400',
  amber: 'bg-amber-400', rose: 'bg-rose-400', cyan: 'bg-cyan-400', slate: 'bg-slate-300',
}

export const BookMarginPanel: FC<BookMarginPanelProps> = ({
  annotations,
  runs,
  lessons,
  chapterIndex,
  activeId,
  accentFor,
  onActivate,
  onScrollTo,
  onTogglePin,
  onDelete,
  onDeleteRun,
  onOpenLesson,
}) => {
  const inChapter = annotations.filter((annotation) => annotation.chapterIndex === chapterIndex)
  const located = inChapter.filter((annotation) => annotation.anchorStatus !== 'orphaned')
  const orphaned = inChapter.filter((annotation) => annotation.anchorStatus === 'orphaned')
  const chapterLessons = lessons.filter(
    (lesson) => chapterIndex >= lesson.chapterStart && chapterIndex <= lesson.chapterEnd
  )
  const runsHere = runs.filter((run) => chapterIndex >= run.chapterStart && chapterIndex <= run.chapterEnd)
  const droppedTotal = runsHere.reduce((sum, run) => sum + run.droppedCount, 0)

  const renderAnnotation = (annotation: BookAnnotation) => (
    <div
      key={annotation.id}
      onMouseEnter={() => onActivate(annotation.id)}
      onMouseLeave={() => onActivate(null)}
      className={`group rounded-lg border px-2.5 py-2 transition-colors ${
        activeId === annotation.id ? 'border-white/20 bg-white/[0.05]' : 'border-white/[0.06] bg-white/[0.02]'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT_COLOR[accentFor(annotation)] ?? DOT_COLOR.slate}`} />
        <button
          onClick={() => onScrollTo(annotation)}
          className="min-w-0 flex-1 cursor-pointer text-left"
          title="Jump to this passage"
        >
          <div className="text-[11px] leading-snug text-white/75">{annotation.label}</div>
          <div className="mt-0.5 line-clamp-2 text-[10px] italic leading-snug text-white/35">“{annotation.quote}”</div>
          {annotation.body && (
            <div className="mt-1 text-[10px] leading-relaxed text-white/50">{annotation.body}</div>
          )}
        </button>
        <div className="flex shrink-0 flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => onTogglePin(annotation)}
            title={annotation.pinned ? 'Unpin' : 'Pin'}
            className={`cursor-pointer text-[9px] ${annotation.pinned ? 'text-amber-300/80' : 'text-white/25 hover:text-white/60'}`}
          >
            <FontAwesomeIcon icon={faThumbtack} />
          </button>
          <button
            onClick={() => onDelete(annotation)}
            title="Delete"
            className="cursor-pointer text-[9px] text-white/25 hover:text-red-300/80"
          >
            <FontAwesomeIcon icon={faTrash} />
          </button>
        </div>
      </div>
      {annotation.anchorStatus === 'shifted' && (
        <div className="mt-1 text-[9px] text-white/25">Re-located after the book changed</div>
      )}
    </div>
  )

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-white/[0.06] bg-holmes-surface/40 px-3 py-3 scrollbar-thin">
      {chapterLessons.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-[9px] uppercase tracking-wider text-white/30">Lessons</div>
          <div className="space-y-1">
            {chapterLessons.map((lesson) => (
              <button
                key={lesson.id}
                onClick={() => onOpenLesson(lesson)}
                className="block w-full cursor-pointer rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-holmes-primary/30"
              >
                <div className="text-[11px] leading-snug text-white/75">{lesson.title}</div>
                <div className="text-[10px] text-white/30">
                  {lesson.questions.length} question{lesson.questions.length === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[9px] uppercase tracking-wider text-white/30">Annotations</span>
        <span className="text-[9px] tabular-nums text-white/20">{located.length}</span>
      </div>

      {runsHere.length > 0 && (
        <div className="mb-2 space-y-1">
          {runsHere.map((run) => (
            <div key={run.id} className="group flex items-center gap-1.5 text-[9px] text-white/30">
              <span className="min-w-0 flex-1 truncate">{run.focusLabel}</span>
              <span className="tabular-nums">{run.annotationCount}</span>
              <button
                onClick={() => onDeleteRun(run)}
                title="Remove this focus run"
                className="cursor-pointer opacity-0 transition-opacity hover:text-red-300/80 group-hover:opacity-100"
              >
                <FontAwesomeIcon icon={faTrash} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* An annotation the model produced but whose quote could not be found is
          reported, never quietly dropped: a run that looks complete when it is
          not is the failure mode worth guarding against. */}
      {droppedTotal > 0 && (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-2.5 py-1.5 text-[9px] leading-snug text-amber-200/75">
          <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5 shrink-0" />
          <span>
            {droppedTotal} annotation{droppedTotal === 1 ? '' : 's'} could not be located in the text and {droppedTotal === 1 ? 'was' : 'were'} discarded.
          </span>
        </div>
      )}

      {located.length === 0 && orphaned.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-white/25">
          Nothing annotated in this chapter yet. Use Annotate above to read it under a focus.
        </p>
      ) : (
        <div className="space-y-1.5">{located.map(renderAnnotation)}</div>
      )}

      {orphaned.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[9px] uppercase tracking-wider text-white/25">
            Could not be located in this version
          </div>
          <div className="space-y-1.5 opacity-60">{orphaned.map(renderAnnotation)}</div>
        </div>
      )}
    </aside>
  )
}
