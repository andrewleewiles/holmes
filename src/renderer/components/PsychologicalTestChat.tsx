import { type FC, useEffect, useRef, useState } from 'react'
import type {
  PsychologicalTestDefinition,
  PsychologicalTestId,
  PsychologicalTestResult,
} from '@shared/types'
import {
  advancePsychologicalTest,
  getPsychologicalTestOptions,
  getVisiblePsychologicalTestQuestionIndices,
  SKIPPED_TEST_ANSWER,
} from '@shared/psychologicalTests'

interface PsychologicalTestChatProps {
  test: PsychologicalTestDefinition
  onExit: () => void
  onComplete: (testId: PsychologicalTestId, answers: number[]) => Promise<PsychologicalTestResult>
  onChooseDirectory: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
}

export const PsychologicalTestChat: FC<PsychologicalTestChatProps> = ({
  test,
  onExit,
  onComplete,
  onChooseDirectory,
  onOpenExternal,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<number[]>([])
  const [safetyPending, setSafetyPending] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [result, setResult] = useState<PsychologicalTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const safetyRef = useRef<HTMLDivElement>(null)

  const currentQuestion = test.questions[currentIndex]
  const visibleQuestionIndices = getVisiblePsychologicalTestQuestionIndices(test, answers)
  const currentPosition = visibleQuestionIndices.indexOf(currentIndex) + 1
  const answeredCount = visibleQuestionIndices.filter((index) => answers[index] !== undefined && answers[index] !== SKIPPED_TEST_ANSWER).length
  const awaitingAnswer = !result && !isSaving && !error && !safetyPending && answers[currentIndex] === undefined
  const progress = result ? 100 : Math.round((answeredCount / visibleQuestionIndices.length) * 100)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    if (safetyPending) safetyRef.current?.focus()
  }, [answers.length, safetyPending, isSaving, result, error])

  const saveResult = async (completedAnswers: number[]) => {
    setIsSaving(true)
    setError(null)
    try {
      const completed = await onComplete(test.id, completedAnswers)
      setResult(completed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the test result')
    } finally {
      setIsSaving(false)
    }
  }

  const advance = (nextAnswers: number[]) => {
    const advanced = advancePsychologicalTest(test, currentIndex, nextAnswers)
    setAnswers(advanced.answers)
    if (advanced.nextIndex === null) {
      void saveResult(advanced.answers)
      return
    }
    setCurrentIndex(advanced.nextIndex)
  }

  const handleAnswer = (value: number) => {
    if (!awaitingAnswer) return
    const nextAnswers = [...answers]
    nextAnswers[currentIndex] = value
    setAnswers(nextAnswers)

    const notice = test.safetyNotice
    if (
      notice &&
      currentQuestion.id === notice.questionId &&
      value >= notice.minimumValue
    ) {
      setSafetyPending(true)
      return
    }

    advance(nextAnswers)
  }

  const handleSafetyContinue = () => {
    setSafetyPending(false)
    advance(answers)
  }

  const handlePrevious = () => {
    const currentIsAnswered = answers[currentIndex] !== undefined && answers[currentIndex] !== SKIPPED_TEST_ANSWER
    const previousIndex = [...visibleQuestionIndices].reverse().find((index) => index < currentIndex)
    const targetIndex = currentIsAnswered ? currentIndex : previousIndex
    if (targetIndex === undefined || isSaving || result) return
    setError(null)
    setSafetyPending(false)
    setAnswers((previous) => previous.slice(0, targetIndex))
    setCurrentIndex(targetIndex)
  }

  const answerLabel = (index: number, answer: number): string => {
    const question = test.questions[index]
    return getPsychologicalTestOptions(test, question).find((option) => option.value === answer)?.label || String(answer)
  }

  const requestExit = () => {
    if (isSaving) return
    if (!result && answers.length > 0 && !window.confirm('Discard this unfinished assessment?')) return
    onExit()
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-holmes-bg">
      <header className="shrink-0 border-b border-violet-400/20 bg-violet-500/[0.04]">
        <div className="px-6 py-3 flex items-center gap-4">
          <button
            onClick={requestExit}
            disabled={isSaving}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/80 disabled:cursor-not-allowed disabled:opacity-30 transition-colors cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Assessments
          </button>
          <div className="h-5 w-px bg-white/10" />
          <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-1 text-[10px] font-semibold tracking-[0.16em] text-violet-200">
            TEST MODE
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-white/85 font-serif-display">{test.shortName}</h1>
            <p className="text-[11px] text-white/35">{test.category}</p>
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs text-white/50">
              {result ? 'Complete' : `${currentPosition} of ${visibleQuestionIndices.length}`}
            </div>
            <div className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-violet-400 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-5">
        <div className="mx-auto max-w-4xl">
          <div className="mb-4 flex justify-start">
            <div className="max-w-[82%] rounded-2xl rounded-bl-md border border-violet-400/15 bg-violet-400/10 px-4 py-3 text-white/85">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-400/20 text-xs text-violet-200">T</span>
                <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-violet-200/80">Standardized assessment</span>
              </div>
              <p className="text-sm font-medium">{test.name}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-white/65">{test.instructions}</p>
              {test.contentNotice && (
                <p className="mt-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.07] px-3 py-2 text-xs leading-relaxed text-amber-100/65">
                  {test.contentNotice}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-white/35">{test.disclaimer}</p>
            </div>
          </div>

          {answers.map((answer, index) => answer === SKIPPED_TEST_ANSWER ? null : (
            <div key={test.questions[index].id}>
              <div className="mb-3 flex justify-start">
                <div className="max-w-[78%] rounded-2xl rounded-bl-md border-l-2 border-violet-400 bg-white/[0.08] px-4 py-3 text-white/85">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-violet-300/70">
                    Question {visibleQuestionIndices.indexOf(index) + 1} of {visibleQuestionIndices.length}
                  </div>
                  <p className="text-sm leading-relaxed">{test.questions[index].prompt}</p>
                </div>
              </div>
              <div className="mb-4 flex justify-end">
                <div className="max-w-[70%] rounded-2xl rounded-br-md bg-holmes-primary px-4 py-3 text-sm text-white">
                  {answerLabel(index, answer)}
                </div>
              </div>
            </div>
          ))}

          {awaitingAnswer && currentQuestion && (
            <div className="mb-4 flex justify-start">
              <div className="max-w-[78%] rounded-2xl rounded-bl-md border-l-2 border-violet-400 bg-white/[0.08] px-4 py-3 text-white/85">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-violet-300/70">
                  Question {currentPosition} of {visibleQuestionIndices.length}
                </div>
                <p className="text-sm leading-relaxed">{currentQuestion.prompt}</p>
              </div>
            </div>
          )}

          {safetyPending && test.safetyNotice && (
            <div className="mb-4 flex justify-start">
              <div
                ref={safetyRef}
                role="alert"
                aria-live="assertive"
                tabIndex={-1}
                className="max-w-[86%] rounded-2xl rounded-bl-md border border-red-400/30 bg-red-500/10 px-4 py-4 outline-none"
              >
                <div className="mb-2 text-sm font-semibold text-red-200">{test.safetyNotice.title}</div>
                <p className="text-sm leading-relaxed text-red-100/80">{test.safetyNotice.message}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => void onOpenExternal('https://988lifeline.org/')}
                    className="rounded-lg bg-red-500 px-3 py-2 text-xs font-medium text-white hover:bg-red-400 transition-colors cursor-pointer"
                  >
                    Open 988 Lifeline
                  </button>
                  <button
                    onClick={handleSafetyContinue}
                    className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white/70 hover:bg-white/10 transition-colors cursor-pointer"
                  >
                    Continue assessment
                  </button>
                </div>
              </div>
            </div>
          )}

          {isSaving && (
            <div className="mb-4 flex justify-start">
              <div className="rounded-2xl rounded-bl-md border border-violet-400/15 bg-violet-400/10 px-4 py-3 text-sm text-white/60">
                Scoring your responses and saving the document locally...
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 flex justify-start">
              <div className="max-w-[82%] rounded-2xl rounded-bl-md border border-red-400/25 bg-red-500/10 px-4 py-3">
                <p className="text-sm text-red-200">{error}</p>
                <button
                  onClick={() => void saveResult(answers)}
                  className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/15 transition-colors cursor-pointer"
                >
                  Try saving again
                </button>
                <button
                  onClick={() => void onChooseDirectory()}
                  className="mt-3 ml-2 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  Change directory
                </button>
              </div>
            </div>
          )}

          {result && (
            <div className="mb-4 flex justify-start">
              <div className="w-full max-w-[86%] rounded-2xl rounded-bl-md border border-violet-400/20 bg-violet-400/[0.08] px-5 py-4">
                <div className="mb-4 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-400/20 text-violet-200">
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white/85">Assessment complete</p>
                    <p className="text-[11px] text-white/35">Scored locally from the published scoring key</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {result.scores.map((score) => (
                    <div key={score.key} className="rounded-xl border border-white/[0.06] bg-black/10 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs text-white/55">{score.label}</span>
                        <span className="text-base font-semibold text-white/85">{score.value}<span className="text-xs font-normal text-white/30">/{score.maxValue}</span></span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-violet-400" style={{ width: `${(score.value / score.maxValue) * 100}%` }} />
                      </div>
                      {score.interpretation && <p className="mt-1.5 text-[11px] text-violet-200/70">{score.interpretation}</p>}
                    </div>
                  ))}
                </div>

                <div className="mt-4 rounded-xl border border-violet-300/10 bg-black/10 p-4">
                  <h3 className="text-sm font-medium text-white/80 font-serif-display">{result.explanation.headline}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-white/55">{result.explanation.whatItMeasures}</p>
                  <div className="mt-3 border-t border-white/[0.06] pt-3">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-violet-200/60">How to read this score</div>
                    <p className="mt-1 text-xs leading-relaxed text-white/55">{result.explanation.scoreMeaning}</p>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/[0.06] bg-black/10 p-3">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-white/35">What it cannot tell you</div>
                    <ul className="mt-2 space-y-1.5">
                      {result.explanation.limitations.map((limitation) => (
                        <li key={limitation} className="flex gap-2 text-[11px] leading-relaxed text-white/50">
                          <span className="text-white/20">-</span>{limitation}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-xl border border-white/[0.06] bg-black/10 p-3">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-white/35">Possible next steps</div>
                    <ul className="mt-2 space-y-1.5">
                      {result.explanation.nextSteps.map((nextStep) => (
                        <li key={nextStep} className="flex gap-2 text-[11px] leading-relaxed text-white/50">
                          <span className="text-violet-300/50">-</span>{nextStep}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {result.safetyFlag && test.safetyNotice && (
                  <div className="mt-4 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs leading-relaxed text-red-100/80">
                    {test.safetyNotice.message}
                  </div>
                )}

                <div className="mt-4 rounded-xl border border-white/[0.06] bg-black/10 p-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-white/30">Saved document</div>
                  <div className="mt-1 break-all font-mono text-[11px] text-white/55">{result.filePath}</div>
                </div>

                <div className="mt-3 flex flex-wrap gap-3 text-[10px]">
                  <button onClick={() => void onOpenExternal(test.sourceUrl)} className="text-violet-300/60 hover:text-violet-200 cursor-pointer">Instrument source</button>
                  <button onClick={() => void onOpenExternal(test.license.url)} className="text-white/35 hover:text-white/60 cursor-pointer">{test.license.name}</button>
                </div>

                <button
                  onClick={requestExit}
                  className="mt-4 rounded-lg bg-violet-500 px-4 py-2 text-xs font-medium text-white hover:bg-violet-400 transition-colors cursor-pointer"
                >
                  Return to assessments
                </button>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {!result && !isSaving && !safetyPending && (
        <footer className="shrink-0 border-t border-white/10 bg-holmes-bg px-4 py-4">
          <div className="mx-auto max-w-4xl">
            {awaitingAnswer && currentQuestion && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {getPsychologicalTestOptions(test, currentQuestion).map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleAnswer(option.value)}
                    className="min-h-11 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-xs leading-snug text-white/65 hover:border-violet-400/40 hover:bg-violet-400/10 hover:text-white transition-colors cursor-pointer"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={handlePrevious}
                disabled={currentIndex === 0 && answers.length === 0}
                className="text-xs text-white/35 hover:text-white/65 disabled:invisible transition-colors cursor-pointer"
              >
                Previous question
              </button>
              <span className="text-[10px] text-white/25">Choose the response that fits best; there are no right answers.</span>
            </div>
          </div>
        </footer>
      )}
    </div>
  )
}
