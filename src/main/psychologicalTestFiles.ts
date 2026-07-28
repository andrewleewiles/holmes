import fs from 'fs'
import path from 'path'
import { getAssistantName } from '../shared/assistantIdentity'
import * as database from './database'
import {
  getPsychologicalTest,
  getPsychologicalTestOptions,
  scorePsychologicalTest,
  SKIPPED_TEST_ANSWER,
} from '../shared/psychologicalTests'
import type { PsychologicalTestId, PsychologicalTestResult } from '../shared/types'

export async function completePsychologicalTest(
  projectId: string,
  testId: PsychologicalTestId,
  answers: number[]
): Promise<PsychologicalTestResult> {
  const project = database.listProjects().find((candidate) => candidate.id === projectId)
  if (!project) throw new Error('Psychology project not found')
  if (!project.path) throw new Error('Set a local directory for the Psychology project before taking a test')

  const directory = path.resolve(project.path)
  let directoryStats: fs.Stats
  try {
    directoryStats = await fs.promises.stat(directory)
  } catch {
    throw new Error('The configured Psychology directory is not accessible')
  }
  if (!directoryStats.isDirectory()) throw new Error('The configured Psychology path is not a directory')

  const test = getPsychologicalTest(testId)
  const scored = scorePsychologicalTest(testId, answers)
  const completedAt = Date.now()
  const completedIso = new Date(completedAt).toISOString()
  const fileStamp = completedIso.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const fileName = `${fileStamp}_${test.shortName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`
  const filePath = path.join(directory, fileName)

  const resultLines = scored.scores.map((score) => {
    const interpretation = score.interpretation ? ` - ${score.interpretation}` : ''
    return `- **${score.label}:** ${score.value}/${score.maxValue}${interpretation}`
  })
  const responseLines = test.questions.flatMap((question, index) => {
    const answer = answers[index]
    if (answer === SKIPPED_TEST_ANSWER) {
      return [
        `### ${index + 1}. ${question.prompt}`,
        '- Response: **Not administered (conditional question)**',
        '',
      ]
    }
    const option = getPsychologicalTestOptions(test, question).find((candidate) => candidate.value === answer)
    const scoringNote = question.scored === false
      ? 'Unscored context item'
      : question.reverse
        ? 'Reverse-scored item'
        : 'Scored item'
    return [
      `### ${index + 1}. ${question.prompt}`,
      `- Response: **${option?.label || 'Unknown'}**`,
      `- Recorded value: ${answer}`,
      `- ${scoringNote}`,
      '',
    ]
  })
  const safetyLines = scored.safetyFlag && test.safetyNotice
    ? [
        '## Safety Follow-up',
        '',
        `**${test.safetyNotice.title}**`,
        '',
        test.safetyNotice.message,
        '',
      ]
    : []

  const markdown = [
    '---',
    'document_type: holmes_psychological_test',
    `test_id: ${test.id}`,
    `test_name: ${test.shortName}`,
    `completed_at: ${completedIso}`,
    `safety_follow_up_required: ${scored.safetyFlag}`,
    '---',
    '',
    `# ${test.name}`,
    '',
    `Completed: ${completedIso}`,
    '',
    '> This document contains sensitive self-reported mental health information. Store and share it carefully.',
    '',
    '## Results',
    '',
    ...resultLines,
    '',
    scored.summary,
    '',
    '## Understanding This Result',
    '',
    `### ${scored.explanation.headline}`,
    '',
    '**What it measures**',
    '',
    scored.explanation.whatItMeasures,
    '',
    '**How to read the score**',
    '',
    scored.explanation.scoreMeaning,
    '',
    '**What it cannot tell you**',
    '',
    ...scored.explanation.limitations.map((limitation) => `- ${limitation}`),
    '',
    '**Possible next steps**',
    '',
    ...scored.explanation.nextSteps.map((nextStep) => `- ${nextStep}`),
    '',
    ...safetyLines,
    '## Responses',
    '',
    ...responseLines,
    '## Important Context',
    '',
    test.disclaimer,
    '',
    `Source: ${test.sourceUrl}`,
    '',
    test.attribution,
    '',
    `License: ${test.license.name} (${test.license.url})`,
    '',
    `_Generated locally by ${getAssistantName()}._`,
    '',
  ].join('\n')

  await fs.promises.writeFile(filePath, markdown, { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  try {
    database.addProjectFile(projectId, filePath)
  } catch {
    // The private document is already saved; project indexing is best-effort.
  }

  return {
    testId,
    testName: test.name,
    completedAt,
    answers: [...answers],
    scores: scored.scores,
    summary: scored.summary,
    explanation: scored.explanation,
    safetyFlag: scored.safetyFlag,
    filePath,
  }
}
