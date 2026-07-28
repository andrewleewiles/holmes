import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  advancePsychologicalTest,
  getPsychologicalTest,
  scorePsychologicalTest,
  SKIPPED_TEST_ANSWER,
} from './src/shared/psychologicalTests.ts'
import { buildPsychologyProjectContext, readProjectFileContext } from './src/main/projectContext.ts'

function score(testId, answers) {
  const result = scorePsychologicalTest(testId, answers)
  assert.ok(result.explanation.headline)
  assert.ok(result.explanation.scoreMeaning)
  return result
}

assert.deepEqual(
  score('mini_ipip_20', Array(20).fill(5)).scores.map((entry) => entry.value),
  [12, 12, 12, 12, 8]
)
assert.equal(score('gad_7', Array(7).fill(0)).scores[0].value, 0)
assert.equal(score('gad_7', Array(7).fill(3)).scores[0].value, 21)

const phqMinimum = score('phq_9', [0, 0, 0, 0, 0, 0, 0, 0, 0, SKIPPED_TEST_ANSWER])
assert.equal(phqMinimum.scores[0].value, 0)
assert.equal(phqMinimum.safetyFlag, false)
const phqMaximum = score('phq_9', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3])
assert.equal(phqMaximum.scores[0].value, 27)
assert.equal(phqMaximum.safetyFlag, true)

assert.equal(
  score('rosenberg_self_esteem', [3, 3, 0, 3, 0, 3, 3, 0, 0, 0]).scores[0].value,
  30
)
assert.deepEqual(score('who_5', [5, 5, 5, 5, 5]).scores.map((entry) => entry.value), [25, 100])
assert.equal(score('pss_10', Array(10).fill(0)).scores[0].value, 16)

const traumaTest = getPsychologicalTest('pc_ptsd_5')
const traumaSkipped = advancePsychologicalTest(traumaTest, 0, [0])
assert.equal(traumaSkipped.nextIndex, null)
assert.deepEqual(traumaSkipped.answers, [0, -1, -1, -1, -1, -1])
assert.equal(score('pc_ptsd_5', traumaSkipped.answers).scores[0].value, 0)
assert.equal(score('pc_ptsd_5', [1, 1, 1, 1, 1, 0]).scores[0].value, 4)

assert.equal(score('audit_c', [0, -1, -1]).scores[0].value, 0)
assert.equal(score('audit_c', [4, 4, 4]).scores[0].value, 12)
assert.equal(score('asrs_6', [2, 2, 2, 3, 0, 0]).scores[0].value, 4)
assert.throws(() => scorePsychologicalTest('pc_ptsd_5', [0, 0, 0, 0, 0, 0]))

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-context-'))
try {
  fs.writeFileSync(path.join(tempDirectory, 'assessment.md'), '# Assessment\nLocal result')
  fs.writeFileSync(path.join(tempDirectory, 'secret.env'), 'SHOULD_NOT_BE_INCLUDED=1')
  const files = readProjectFileContext([], tempDirectory)
  assert.equal(files.fileCount, 1)
  assert.match(files.content, /Local result/)
  assert.doesNotMatch(files.content, /SHOULD_NOT_BE_INCLUDED/)

  fs.writeFileSync(path.join(tempDirectory, 'large.md'), 'A'.repeat(1_100_000))
  const boundedFiles = readProjectFileContext([], tempDirectory, 200)
  assert.ok(boundedFiles.content.length <= 202)
  assert.equal(boundedFiles.truncated, true)

  const projectContext = buildPsychologyProjectContext({
    id: 'psychology',
    name: 'Psychology',
    icon: '',
    color: '',
    path: tempDirectory,
    files: [],
    analysis: {
      bigFive: { openness: 1, conscientiousness: 2, extraversion: 3, agreeableness: 4, neuroticism: 5 },
      emotionalIntelligence: 6,
      cognitiveStyle: { label: 'Test', description: 'Test context', score: 7 },
      wellBeing: 8,
      summary: 'Profile summary',
    },
    createdAt: 0,
    updatedAt: 0,
  })
  assert.match(projectContext.content, /Profile summary/)
  assert.match(projectContext.content, /Local result/)
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true })
}

console.log('Psychological assessment and project context checks passed')
