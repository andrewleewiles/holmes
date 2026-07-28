import assert from 'node:assert/strict'

import {
  ROLES,
  ROLE_PROMPT_VERSION,
  THERAPIST_SESSION_SECTIONS,
  getRole,
  isRoleId,
  normalizeSessionRisk,
  parseSessionNote,
  renderSessionNoteMarkdown,
  roleSystemMessage,
  rolesWithSessionAnalysis,
} from './src/shared/roles.ts'
import { extractTimelineBlock, parseTimelineBlock, stripTimelineBlock } from './src/shared/timeline.ts'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

console.log('roles: catalog')

check('the catalog is non-empty and every role is well-formed', () => {
  assert.ok(ROLES.length > 0)
  for (const role of ROLES) {
    assert.ok(role.id && role.name && role.specialty && role.icon && role.color && role.description)
    assert.ok(role.document.length > 500, `${role.id} role document is suspiciously short`)
  }
})

check('role ids are unique', () => {
  assert.equal(new Set(ROLES.map((role) => role.id)).size, ROLES.length)
})

check('the prompt version is a non-empty string', () => {
  // The SHAPE, never the literal: a legitimate prompt revision must not break this.
  assert.equal(typeof ROLE_PROMPT_VERSION, 'string')
  assert.ok(ROLE_PROMPT_VERSION.length > 0)
})

check('getRole resolves known ids and rejects everything else', () => {
  assert.equal(getRole('therapist')?.name, 'Therapist')
  assert.equal(getRole('not-a-role'), null)
  assert.equal(getRole(null), null)
  assert.equal(getRole(undefined), null)
  assert.equal(getRole(''), null)
})

check('isRoleId is the guard the IPC layer relies on', () => {
  assert.equal(isRoleId('therapist'), true)
  assert.equal(isRoleId('Therapist'), false)
  assert.equal(isRoleId(42), false)
  assert.equal(isRoleId(null), false)
  assert.equal(isRoleId({ id: 'therapist' }), false)
})

check('the therapist document states its limits and its crisis duty', () => {
  const document = getRole('therapist').document.toLowerCase()
  for (const required of ['not a licensed clinician', 'diagnos', 'crisis', 'emergency']) {
    assert.ok(document.includes(required), `therapist document is missing "${required}"`)
  }
})

check('roleSystemMessage carries the document and refuses to let it override safety', () => {
  const role = getRole('therapist')
  const message = roleSystemMessage(role)
  assert.ok(message.includes(role.document))
  assert.ok(/safety obligations/i.test(message))
})

console.log('roles: session analysis spec')

check('the therapist writes a session note filed under Psychology', () => {
  const spec = getRole('therapist').sessionAnalysis
  assert.ok(spec)
  assert.equal(spec.projectName, 'Psychology')
  assert.ok(spec.minTurns >= 2)
  assert.ok(spec.sections.length > 0)
  assert.ok(spec.disclaimer.length > 0)
})

check('rolesWithSessionAnalysis returns exactly the note-writing roles', () => {
  const withNotes = rolesWithSessionAnalysis()
  assert.deepEqual(
    withNotes.map((role) => role.id),
    ROLES.filter((role) => role.sessionAnalysis).map((role) => role.id)
  )
})

check('section keys are unique and every one reaches the prompt', () => {
  const spec = getRole('therapist').sessionAnalysis
  assert.equal(new Set(spec.sections.map((section) => section.key)).size, spec.sections.length)
  for (const section of spec.sections) {
    assert.ok(spec.systemPrompt.includes(section.heading), `prompt omits "${section.heading}"`)
    assert.ok(spec.systemPrompt.includes(section.instruction), `prompt omits the instruction for "${section.heading}"`)
  }
})

check('the risk screen is a required section', () => {
  const spec = getRole('therapist').sessionAnalysis
  assert.ok(spec.sections.some((section) => section.key === 'risk'))
})

check('the session prompt asks for the TIMELINE block', () => {
  const spec = getRole('therapist').sessionAnalysis
  assert.ok(spec.systemPrompt.includes('TIMELINE:'))
  assert.ok(spec.systemPrompt.includes(String(spec.maxTimelineEntries)))
})

console.log('roles: risk normalization')

check('the three defined levels round-trip', () => {
  assert.equal(normalizeSessionRisk('none'), 'none')
  assert.equal(normalizeSessionRisk('  Monitor  '), 'monitor')
  assert.equal(normalizeSessionRisk('URGENT'), 'urgent')
  assert.equal(normalizeSessionRisk('urgent: plan and means disclosed'), 'urgent')
})

check('an absent value is none and an unrecognized one is escalated, never silently cleared', () => {
  assert.equal(normalizeSessionRisk(''), 'none')
  assert.equal(normalizeSessionRisk(undefined), 'none')
  assert.equal(normalizeSessionRisk(null), 'none')
  // The one failure mode this field must not have: a model that wrote something
  // else was trying to say something, so it surfaces rather than reading clean.
  assert.equal(normalizeSessionRisk('elevated'), 'monitor')
  assert.equal(normalizeSessionRisk('some concern'), 'monitor')
})

console.log('roles: note parsing')

const SECTIONS = THERAPIST_SESSION_SECTIONS

const WELL_FORMED = `TITLE: Sleep loss and the promotion decision
SUMMARY: The client described three weeks of broken sleep since being offered a team lead role.
They framed the decision as a test they could fail.
RISK: none

## Presenting Concerns
Broken sleep, described as "lying there arguing with myself".

## Session Narrative
Explored the timing of the sleep change against the promotion offer.

## Affect and Presentation
Engaged throughout; terser when the conversation turned to their manager.

## Risk and Safety Screen
Self-harm and suicide were not raised at any point in the session.

## Working Formulation
Hypothesis: the promotion has reactivated a performance-evaluation fear.

TIMELINE:
- 2026-06 | month | work | Offered team lead role | The client dated the offer to "about three weeks ago".
- 2026-07-28 | day | health | Three weeks of disrupted sleep reported | Stated in this session.`

check('a well-formed note parses into title, summary, risk and ordered sections', () => {
  const note = parseSessionNote(WELL_FORMED, SECTIONS)
  assert.ok(note)
  assert.equal(note.title, 'Sleep loss and the promotion decision')
  assert.equal(note.risk, 'none')
  assert.ok(note.summary.startsWith('The client described three weeks'))
  // The SUMMARY line wrapped, and the continuation belongs to it.
  assert.ok(note.summary.includes('a test they could fail'))
  assert.deepEqual(
    note.sections.map((section) => section.key),
    ['presenting', 'narrative', 'affect', 'risk', 'formulation']
  )
  assert.equal(note.sections[0].heading, 'Presenting Concerns')
})

check('the TIMELINE block never leaks into the last section body', () => {
  const note = parseSessionNote(WELL_FORMED, SECTIONS)
  for (const section of note.sections) {
    assert.ok(!section.body.includes('TIMELINE:'), `TIMELINE leaked into "${section.heading}"`)
    assert.ok(!section.body.includes('| month |'), `a timeline row leaked into "${section.heading}"`)
  }
})

check('the TIMELINE block is still parseable off the raw note', () => {
  const entries = parseTimelineBlock(WELL_FORMED)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].precision, 'month')
  assert.equal(entries[1].category, 'health')
})

check('extractTimelineBlock is the exact complement of stripTimelineBlock', () => {
  const block = extractTimelineBlock(WELL_FORMED)
  assert.ok(block.startsWith('TIMELINE:'))
  assert.equal(parseTimelineBlock(block).length, 2)
  assert.ok(!stripTimelineBlock(WELL_FORMED).includes('TIMELINE:'))
  assert.equal(extractTimelineBlock('no block here'), '')
})

check('a note wrapped in a code fence still parses', () => {
  const note = parseSessionNote('```markdown\n' + WELL_FORMED + '\n```', SECTIONS)
  assert.ok(note)
  assert.equal(note.title, 'Sleep loss and the promotion decision')
})

check('a missing TITLE line does not lose the note', () => {
  const note = parseSessionNote(WELL_FORMED.split('\n').slice(1).join('\n'), SECTIONS)
  assert.ok(note)
  assert.equal(note.title, 'Session note')
  assert.ok(note.sections.length > 0)
})

check('a heading the catalog does not know is kept, not dropped', () => {
  const note = parseSessionNote(`${WELL_FORMED}\n\n## Clinician Referral\nDiscussed finding a therapist locally.`, SECTIONS)
  const extra = note.sections.find((section) => section.heading === 'Clinician Referral')
  assert.ok(extra, 'an unrecognized heading was discarded')
  assert.ok(extra.body.includes('finding a therapist'))
  // Known sections keep their catalog order; the extra one lands after them.
  assert.equal(note.sections[note.sections.length - 1].key, 'clinician-referral')
})

check('headings are matched tolerantly on wording, not identity', () => {
  const note = parseSessionNote('TITLE: t\nRISK: monitor\n\n### 1. presenting concerns\nBody text.', SECTIONS)
  assert.equal(note.sections[0].key, 'presenting')
  assert.equal(note.sections[0].heading, 'Presenting Concerns')
  assert.equal(note.risk, 'monitor')
})

check('bolded field labels are read', () => {
  const note = parseSessionNote('**TITLE:** A session\n**RISK:** urgent\n\n## Session Narrative\nBody.', SECTIONS)
  assert.equal(note.title, 'A session')
  assert.equal(note.risk, 'urgent')
})

check('an empty section contributes nothing rather than an empty heading', () => {
  const note = parseSessionNote('TITLE: t\n\n## Presenting Concerns\n\n## Session Narrative\nReal content.', SECTIONS)
  assert.deepEqual(note.sections.map((section) => section.key), ['narrative'])
})

check('nothing usable returns null', () => {
  assert.equal(parseSessionNote('', SECTIONS), null)
  assert.equal(parseSessionNote('   \n\n  ', SECTIONS), null)
  assert.equal(parseSessionNote('TITLE: only a title', SECTIONS), null)
})

check('a summary-only note survives — the sections are what is missing, not the record', () => {
  const note = parseSessionNote('TITLE: t\nSUMMARY: The client cancelled after two turns.', SECTIONS)
  assert.ok(note)
  assert.equal(note.sections.length, 0)
  assert.ok(note.summary.includes('cancelled'))
})

console.log('roles: markdown rendering')

const RENDER_INPUT = {
  role: getRole('therapist'),
  note: parseSessionNote(WELL_FORMED, SECTIONS),
  conversationTitle: 'Thinking about the team lead thing',
  conversationId: '0f9d1c22-aaaa-bbbb-cccc-1234567890ab',
  sessionDate: '2026-07-28',
  generatedAt: '2026-07-28T19:04:11.000Z',
  model: 'test/model',
  turns: 18,
  assistantName: 'Holmes',
  timelineBlock: extractTimelineBlock(WELL_FORMED),
}

check('the file leads with frontmatter the indexer can recognize', () => {
  const markdown = renderSessionNoteMarkdown(RENDER_INPUT)
  const lines = markdown.split('\n')
  assert.equal(lines[0], '---')
  assert.ok(markdown.includes('document_type: holmes_session_note'))
  assert.ok(markdown.includes('role: therapist'))
  assert.ok(markdown.includes('conversation_id: 0f9d1c22-aaaa-bbbb-cccc-1234567890ab'))
  assert.ok(markdown.includes('session_date: 2026-07-28'))
  assert.ok(markdown.includes('risk: none'))
})

check('every section reaches the file', () => {
  const markdown = renderSessionNoteMarkdown(RENDER_INPUT)
  for (const section of RENDER_INPUT.note.sections) {
    assert.ok(markdown.includes(`## ${section.heading}`), `file omits "${section.heading}"`)
  }
})

check('the file carries the disclaimer and never claims to be clinical', () => {
  const markdown = renderSessionNoteMarkdown(RENDER_INPUT)
  assert.ok(markdown.includes(getRole('therapist').sessionAnalysis.disclaimer))
  assert.ok(/not a clinical record/i.test(markdown))
})

check('the TIMELINE block survives into the file and still parses from it', () => {
  const markdown = renderSessionNoteMarkdown(RENDER_INPUT)
  assert.equal(parseTimelineBlock(markdown).length, 2)
})

check('a risk finding is called out above the note, not buried in it', () => {
  const urgent = renderSessionNoteMarkdown({
    ...RENDER_INPUT,
    note: { ...RENDER_INPUT.note, risk: 'urgent' },
  })
  assert.ok(urgent.includes('risk: urgent'))
  assert.ok(/Risk screen: Urgent/.test(urgent))
  // A clean screen gets no banner: a warning that always shows is not a warning.
  assert.ok(!/Risk screen:/.test(renderSessionNoteMarkdown(RENDER_INPUT)))
})

console.log(`\nAll ${checks} role checks passed.`)
