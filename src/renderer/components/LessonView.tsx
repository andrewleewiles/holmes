import { type FC, useEffect, useMemo, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronLeft, faChevronRight, faComments, faQuoteLeft, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { BookCitation, BookLesson, BookLessonStep } from '@shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'

interface LessonViewProps {
  lesson: BookLesson
  /** Citations navigate the reader; the lesson does not scroll itself. */
  onJumpToCitation: (citation: BookCitation) => void
  onDiscuss: (step: BookLessonStep) => void
  onClose: () => void
}

const CitationChips: FC<{ citations: BookCitation[]; onJump: (citation: BookCitation) => void }> = ({ citations, onJump }) => {
  if (citations.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {citations.map((citation) => (
        <button
          key={`${citation.charStart}-${citation.charEnd}`}
          onClick={() => onJump(citation)}
          title="Show this passage in the book"
          className="flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-holmes-primary/25 bg-holmes-primary/[0.07] px-2.5 py-1 text-[10px] text-holmes-primary-light/85 transition-colors hover:border-holmes-primary/50"
        >
          <FontAwesomeIcon icon={faQuoteLeft} className="shrink-0 text-[8px]" />
          <span className="truncate italic">{citation.quote}</span>
        </button>
      ))}
    </div>
  )
}

export const LessonView: FC<LessonViewProps> = ({ lesson, onJumpToCitation, onDiscuss, onClose }) => {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, { choiceIndex?: number; text?: string; revealed?: boolean }>>({})

  const step = lesson.steps[index]
  const concept = useMemo(
    () => (step?.conceptId ? lesson.concepts.find((entry) => entry.id === step.conceptId) ?? null : null),
    [step, lesson.concepts]
  )
  const question = useMemo(
    () => (step?.questionId ? lesson.questions.find((entry) => entry.id === step.questionId) ?? null : null),
    [step, lesson.questions]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight') setIndex((current) => Math.min(lesson.steps.length - 1, current + 1))
      if (event.key === 'ArrowLeft') setIndex((current) => Math.max(0, current - 1))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, lesson.steps.length])

  if (!step) return null

  const answer = answers[step.questionId ?? ''] ?? {}

  const record = (patch: { choiceIndex?: number; text?: string; revealed?: boolean }) => {
    if (!question) return
    const next = { ...answer, ...patch }
    setAnswers((current) => ({ ...current, [question.id]: next }))
    // Every answer and every reveal is stored: repeated attempts are the record
    // of learning, so nothing here overwrites what came before.
    void window.electronAPI.library.recordAttempt({
      lessonId: lesson.id,
      questionId: question.id,
      answer: next.text ?? '',
      choiceIndex: next.choiceIndex ?? null,
      correct:
        question.kind === 'multiple_choice' && next.choiceIndex !== undefined && question.correctIndex !== null
          ? next.choiceIndex === question.correctIndex
          : null,
      selfRating: null,
      revealed: Boolean(next.revealed),
    }).catch(() => { /* A lost attempt must never block the lesson. */ })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-holmes-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-serif-display text-[17px] text-white/85">{lesson.title}</h2>
          <p className="text-[10px] text-white/30">
            Step {index + 1} of {lesson.steps.length}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => onDiscuss(step)}
            title="Open a conversation about this step"
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-holmes-primary/25 bg-holmes-primary/[0.07] px-2.5 py-1 text-[10px] text-holmes-primary-light/85 transition-colors hover:border-holmes-primary/50"
          >
            <FontAwesomeIcon icon={faComments} />
            Discuss with Holmes
          </button>
          <button onClick={onClose} className="cursor-pointer text-white/30 hover:text-white/70">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>
      </div>

      <div className="flex shrink-0 gap-1 px-6 pt-3">
        {lesson.steps.map((entry, entryIndex) => (
          <button
            key={entry.id}
            onClick={() => setIndex(entryIndex)}
            title={entry.title}
            className={`h-1 flex-1 cursor-pointer rounded-full transition-colors ${
              entryIndex === index ? 'bg-holmes-primary' : entryIndex < index ? 'bg-holmes-primary/35' : 'bg-white/[0.08]'
            }`}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-white/25">
            {step.kind === 'question' ? question?.kind === 'multiple_choice' ? 'Multiple choice' : 'Open question' : step.kind}
          </div>
          <h3 className="mb-3 font-serif-display text-[21px] leading-snug text-white/85">{step.title}</h3>

          {step.kind === 'objectives' ? (
            <>
              <MarkdownRenderer content={step.body} />
              {lesson.objectives.length > 0 && (
                <ul className="mt-4 space-y-1.5">
                  {lesson.objectives.map((objective) => (
                    <li key={objective} className="flex gap-2 text-[13px] leading-relaxed text-white/60">
                      <span className="text-holmes-primary/60">→</span>
                      <span>{objective}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : step.kind === 'concept' && concept ? (
            <>
              <MarkdownRenderer content={concept.explanation} />
              <CitationChips citations={concept.citations} onJump={onJumpToCitation} />
            </>
          ) : step.kind === 'question' && question ? (
            <>
              <p className="text-[15px] leading-relaxed text-white/75">{question.prompt}</p>

              {question.kind === 'multiple_choice' ? (
                <div className="mt-4 space-y-1.5">
                  {question.choices.map((choice, choiceIndex) => {
                    const chosen = answer.choiceIndex === choiceIndex
                    const isCorrect = question.correctIndex === choiceIndex
                    const settled = answer.choiceIndex !== undefined
                    return (
                      <button
                        key={choice}
                        onClick={() => record({ choiceIndex })}
                        className={`block w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left text-[13px] transition-colors ${
                          settled && isCorrect
                            ? 'border-emerald-400/35 bg-emerald-400/[0.08] text-emerald-100/85'
                            : chosen
                              ? 'border-red-400/35 bg-red-400/[0.07] text-red-100/80'
                              : 'border-white/[0.07] bg-white/[0.02] text-white/65 hover:border-white/20'
                        }`}
                      >
                        {choice}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <textarea
                  value={answer.text ?? ''}
                  onChange={(event) => setAnswers((current) => ({
                    ...current,
                    [question.id]: { ...answer, text: event.target.value },
                  }))}
                  onBlur={() => { if (answer.text?.trim()) record({ text: answer.text }) }}
                  rows={5}
                  placeholder="Your answer…"
                  className="mt-4 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-[13px] leading-relaxed text-white/75 outline-none placeholder:text-white/20 focus:border-holmes-primary/35"
                />
              )}

              {answer.revealed || (question.kind === 'multiple_choice' && answer.choiceIndex !== undefined) ? (
                <div className="mt-4 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                  <div className="mb-1 text-[9px] uppercase tracking-wider text-white/30">Model answer</div>
                  <MarkdownRenderer content={question.modelAnswer} />
                  {question.explanation && (
                    <p className="mt-2 text-[12px] leading-relaxed text-white/45">{question.explanation}</p>
                  )}
                  <CitationChips citations={question.citations} onJump={onJumpToCitation} />
                </div>
              ) : (
                <button
                  onClick={() => record({ revealed: true })}
                  className="mt-3 cursor-pointer text-[11px] text-white/35 transition-colors hover:text-white/70"
                >
                  Show model answer
                </button>
              )}
            </>
          ) : (
            <MarkdownRenderer content={step.body} />
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-6 py-3">
        <button
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
          disabled={index === 0}
          className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/40 hover:text-white/75 disabled:opacity-25"
        >
          <FontAwesomeIcon icon={faChevronLeft} className="text-[9px]" />
          Back
        </button>
        {index < lesson.steps.length - 1 ? (
          <button
            onClick={() => setIndex((current) => current + 1)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-holmes-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-holmes-primary-light"
          >
            Next
            <FontAwesomeIcon icon={faChevronRight} className="text-[9px]" />
          </button>
        ) : (
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-holmes-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-holmes-primary-light"
          >
            Done
          </button>
        )}
      </div>
    </div>
  )
}
