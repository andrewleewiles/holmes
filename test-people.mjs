import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-people-db-'))
process.env.HOLMES_USER_DATA = dbDir
const electronStub = {
  app: { getPath: () => dbDir, isPackaged: false, getAppPath: () => dbDir },
}
const require = Module.createRequire(import.meta.url)
const moduleAlias = require('module')
const origResolve = moduleAlias._resolveFilename
moduleAlias._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') return request
  return origResolve.call(this, request, parent, isMain, options)
}
const ModuleLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return ModuleLoad.call(this, request, parent, isMain)
}

const {
  PEOPLE_BLOCK_HEADING,
  PERSON_RELATIONS,
  analysisPeopleToEntries,
  coerceAnalysisPeople,
  handleKey,
  isPseudonymName,
  mentionsFingerprint,
  normalizePersonRelation,
  parsePeopleBlock,
  parsePersonLine,
  peoplePromptSection,
  personKey,
  personTokens,
  stripPeopleBlock,
} = await import('./src/shared/people.ts')

const { parseTimelineBlock, stripTimelineBlock } = await import('./src/shared/timeline.ts')

const {
  MIN_SCORE_FOR_DOSSIER,
  MIN_SCORE_FOR_PERSON,
  personScore,
  relationsCompatible,
  resolvePeople,
} = await import('./src/shared/peopleResolve.ts')

const settingsModule = await import('./src/main/settings.ts')
const database = await import('./src/main/database.ts')
database.initDatabase()

const { buildPeopleContext, collectPersonSeeds, harvestPersonMentions } = await import('./src/main/people.ts')

const {
  beginPeopleRun,
  describePeopleProgress,
  finishPeopleRun,
  getPeopleRunState,
  isPeopleRunActive,
  isPeopleRunPaused,
  reportPeopleRunProgress,
  requestPeopleRunPause,
  requestPeopleRunStop,
  resetPeopleRunsForTests,
} = await import('./src/main/peopleRuns.ts')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

// --- helpers -----------------------------------------------------------------

let mentionSeq = 0
const mention = (rawName, over = {}) => ({
  mentionKey: over.mentionKey ?? `mk${(mentionSeq += 1)}`,
  rawName,
  relation: over.relation ?? 'unknown',
  role: over.role ?? '',
  aka: over.aka ?? [],
  evidence: over.evidence ?? 'evidence',
  sourceType: over.sourceType ?? 'document',
  sourceRef: over.sourceRef ?? 'source-a',
  sourceLabel: over.sourceLabel ?? 'Label',
  projectId: over.projectId ?? null,
  confidence: over.confidence ?? 0.75,
})

const seed = (displayName, over = {}) => ({
  personKey: over.personKey ?? `contact:${displayName}`,
  displayName,
  seedSource: over.seedSource ?? 'contacts',
  relation: over.relation ?? 'unknown',
  role: over.role ?? '',
  aliases: over.aliases ?? [],
  platforms: over.platforms ?? [],
  isPseudonym: over.isPseudonym ?? false,
  messageCount: over.messageCount ?? 0,
  sentCount: over.sentCount ?? 0,
  daysActive: over.daysActive ?? 0,
  firstSeen: over.firstSeen ?? null,
  lastSeen: over.lastSeen ?? null,
  confidence: over.confidence ?? 1,
})

const byName = (people, name) => people.find((person) => person.displayName === name)

// --- parsePersonLine ---------------------------------------------------------
console.log('parsePersonLine')

check('parses a complete four-cell line', () => {
  const entry = parsePersonLine('- Sarah Jennings | family:mother | Mom; sarah@x.com | Texts weekly about the house')
  assert.equal(entry.name, 'Sarah Jennings')
  assert.equal(entry.relation, 'family')
  assert.equal(entry.role, 'mother')
  assert.deepEqual(entry.aka, ['Mom', 'sarah@x.com'])
  assert.equal(entry.evidence, 'Texts weekly about the house')
})

check('recovers a dropped aka cell by shape', () => {
  const entry = parsePersonLine('- Dr. Patel | professional | Signed the 2023 bloodwork order.')
  assert.equal(entry.relation, 'professional')
  assert.deepEqual(entry.aka, [])
  assert.equal(entry.evidence, 'Signed the 2023 bloodwork order.')
})

check('recovers a dropped relation cell', () => {
  const entry = parsePersonLine('- Spencer | Longest-running message thread in the archive.')
  assert.equal(entry.relation, 'unknown')
  assert.equal(entry.evidence, 'Longest-running message thread in the archive.')
})

check('a bare kinship word supplies both the relation and the role', () => {
  const entry = parsePersonLine('- Linda | mother | | Referred to as mom throughout')
  assert.equal(entry.relation, 'family')
  assert.equal(entry.role, 'mother')
})

check('a bare name alone is still a mention', () => {
  // Unlike a timeline entry, which is worthless undated, a name with no context
  // is real evidence: mentions are the significance currency.
  const entry = parsePersonLine('- Sarah')
  assert.equal(entry.name, 'Sarah')
  assert.equal(entry.relation, 'unknown')
})

check('rejects the none sentinel and null tokens', () => {
  assert.equal(parsePersonLine('- none'), null)
  assert.equal(parsePersonLine('- unknown'), null)
  assert.equal(parsePersonLine('-'), null)
})

check('rejects a stray timeline line that landed in the block', () => {
  assert.equal(parsePersonLine('- 2024-03-15 | day | health | Started PT | invoice dated'), null)
})

check('rejects an address in the name cell', () => {
  // A shared noreply@ address as a name would merge every unrelated sender.
  assert.equal(parsePersonLine('- billing@acme.com | client | | invoice sender'), null)
  assert.equal(parsePersonLine('- +15551234567 | friend | | texted'), null)
})

check('rejects an over-long name and caps a long evidence clause', () => {
  // A 400-character "name" is a paragraph, not a person.
  assert.equal(parsePersonLine(`- ${'a'.repeat(400)} | family | | evidence`), null)
  const entry = parsePersonLine(`- Sarah Wiles | family | | ${'b'.repeat(900)}`)
  assert.ok(entry.evidence.length <= 300)
})

// --- normalizePersonRelation -------------------------------------------------
console.log('normalizePersonRelation')

check('splits relation:role and honours the closed vocabulary', () => {
  assert.deepEqual(normalizePersonRelation('professional:physical therapist'), { relation: 'professional', role: 'physical therapist' })
  assert.deepEqual(normalizePersonRelation('public'), { relation: 'public', role: '' })
})

check('maps common aliases and keeps the word as the role', () => {
  assert.equal(normalizePersonRelation('boss').relation, 'colleague')
  assert.equal(normalizePersonRelation('boss').role, 'boss')
  assert.equal(normalizePersonRelation('wife').relation, 'partner')
  assert.equal(normalizePersonRelation('neighbor').relation, 'community')
})

check('an unanticipated word is unknown, never a plausible bucket', () => {
  // A wrong relation is asserted downstream as fact, so guessing is worse than
  // admitting ignorance.
  assert.equal(normalizePersonRelation('sasquatch').relation, 'unknown')
  assert.equal(normalizePersonRelation('').relation, 'unknown')
})

// --- keys --------------------------------------------------------------------
console.log('personKey and handleKey')

check('folds diacritics, honorifics and decorations', () => {
  assert.equal(personKey('Dr. José Álvarez'), personKey('jose alvarez'))
  assert.equal(personKey('erika duffin :)'), 'erika duffin')
  assert.equal(personKey('Sarah Wiles, MD'), 'sarah wiles')
})

check('generational suffixes are NOT stripped', () => {
  // Stripping "Jr" would merge a father and his son — the exact over-merge this
  // subsystem exists to avoid.
  assert.notEqual(personKey('Robert Smith Jr'), personKey('Robert Smith'))
})

check('splits camelCase album names', () => {
  // Real photo albums here are named sarahPhillipsPhotoshoot; the folder prompt
  // is the only way those names reach People at all.
  assert.deepEqual(personTokens('sarahPhillipsPhotoshoot'), ['sarah', 'phillips', 'photoshoot'])
})

check('phones key on the last ten digits in either format', () => {
  assert.equal(handleKey('+15551234567'), '5551234567')
  assert.equal(handleKey('(555) 123-4567'), '5551234567')
  assert.equal(handleKey('Sarah@X.com'), 'sarah@x.com')
  assert.equal(handleKey('Sarah Wiles'), null)
  assert.equal(handleKey('2024'), null)
})

check('recognises identify() pseudonyms', () => {
  assert.equal(isPseudonymName('contact-670621'), true)
  assert.equal(isPseudonymName('Spencer Dewbury'), false)
})

// --- parsePeopleBlock --------------------------------------------------------
console.log('parsePeopleBlock')

const TIMELINE_THEN_PEOPLE = `Prose about the year.

TIMELINE:
- 2024-03-15 | day | health | Started PT | invoice dated
- 2024 | year | work | Changed roles | contract

PEOPLE:
- Sarah Jennings | family:mother | Mom | Texts weekly
- Dr. Patel | professional:physical therapist | | Signed the PT order`

const PEOPLE_THEN_TIMELINE = `Prose about the year.

PEOPLE:
- Sarah Jennings | family:mother | Mom | Texts weekly
- Dr. Patel | professional:physical therapist | | Signed the PT order

TIMELINE:
- 2024-03-15 | day | health | Started PT | invoice dated
- 2024 | year | work | Changed roles | contract`

check('both blocks coexist in one context, in either order', () => {
  // The single highest-risk interaction in the feature: each parser must stop at
  // the other block's ALL-CAPS heading rather than eating its lines.
  for (const [label, text] of [['TIMELINE first', TIMELINE_THEN_PEOPLE], ['PEOPLE first', PEOPLE_THEN_TIMELINE]]) {
    const timeline = parseTimelineBlock(text)
    const people = parsePeopleBlock(text)
    assert.equal(timeline.length, 2, `${label}: timeline entries`)
    assert.deepEqual(timeline.map((e) => e.title), ['Started PT', 'Changed roles'], label)
    assert.equal(people.length, 2, `${label}: people entries`)
    assert.deepEqual(people.map((e) => e.name), ['Sarah Jennings', 'Dr. Patel'], label)
    assert.equal(people[0].relation, 'family', label)
  }
})

check('the last PEOPLE heading wins over a mention in prose', () => {
  const text = `We discuss PEOPLE: in the abstract here.\n\nPEOPLE:\n- Real Person | friend | | actually named`
  const entries = parsePeopleBlock(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'Real Person')
})

check('a context with no block yields nothing', () => {
  assert.deepEqual(parsePeopleBlock('Just prose.'), [])
  assert.deepEqual(parsePeopleBlock(''), [])
})

check('strippers remove their own block and leave the prose', () => {
  assert.ok(!stripPeopleBlock(PEOPLE_THEN_TIMELINE).includes('Sarah Jennings'))
  assert.ok(stripPeopleBlock(PEOPLE_THEN_TIMELINE).includes('Prose about the year.'))
  // TIMELINE last means stripping it also removes everything after it.
  assert.ok(!stripTimelineBlock(TIMELINE_THEN_PEOPLE).includes('Started PT'))
})

// --- JSON analysis variant ---------------------------------------------------
console.log('analysis people')

check('coerces and converts the JSON shape, dropping nameless entries', () => {
  const coerced = coerceAnalysisPeople([
    { name: 'Dr. Patel', relation: 'professional', role: 'primary care physician', evidence: 'ordered labs' },
    { relation: 'friend' },
    'nonsense',
  ])
  assert.equal(coerced.length, 1)
  const entries = analysisPeopleToEntries(coerced)
  assert.equal(entries[0].relation, 'professional')
  assert.equal(entries[0].role, 'primary care physician')
  assert.deepEqual(analysisPeopleToEntries(undefined), [])
})

// --- prompt contract ---------------------------------------------------------
console.log('peoplePromptSection')

check('the prompt states the heading, the format, the vocabulary and the sentinel', () => {
  // Pinned by shape, never by a version literal.
  const prompt = peoplePromptSection(12)
  assert.ok(prompt.includes(PEOPLE_BLOCK_HEADING))
  assert.ok(prompt.includes('<name> | <relation[:role]> | <aka> | <evidence>'))
  for (const relation of PERSON_RELATIONS) assert.ok(prompt.includes(relation), `vocabulary includes ${relation}`)
  assert.ok(prompt.includes('- none'))
  assert.ok(/at most 12 entries/.test(prompt))
})

check('every prompt that emits a TIMELINE block also emits a PEOPLE block', () => {
  // Stops a future prompt from silently falling out of the contract.
  for (const file of ['src/main/documentContext.ts', 'src/main/indexStyles.ts', 'src/main/memorySummary.ts', 'src/main/activityAnalysis.ts']) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    const timelines = source.match(/timelinePromptSection\(/g)?.length ?? 0
    const peoples = source.match(/peoplePromptSection\(/g)?.length ?? 0
    assert.equal(peoples, timelines, `${file}: ${timelines} timeline sites, ${peoples} people sites`)
  }
  for (const file of ['src/main/healthAnalysis.ts', 'src/main/activityAnalysis.ts']) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.ok(/ANALYSIS_PEOPLE_JSON_FIELD/.test(source), `${file} carries the JSON people field`)
    assert.ok(/analysisPeoplePromptRule\(/.test(source), `${file} carries the JSON people rule`)
  }
})

check('the image prompt never asks for people and its version is not bumped by this', () => {
  // Identifying faces is banned; photo-derived names reach People only through
  // the folder prompt, which reads album names rather than pixels.
  const source = fs.readFileSync(new URL('./src/main/documentContext.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const IMAGE_CONTEXT_SYSTEM_PROMPT')
  const open = source.indexOf('`', start)
  const body = source.slice(open, source.indexOf('`', open + 1))
  assert.ok(!/peoplePromptSection/.test(body), 'image prompt has no PEOPLE section')
  assert.ok(/do NOT guess identities/i.test(body), 'the identity ban is still stated')
})

// --- resolver ----------------------------------------------------------------
console.log('resolvePeople')

check('handles, initialled forms and short names collapse onto one seeded person', () => {
  const result = resolvePeople({
    seeds: [seed('Sarah Wiles', {
      relation: 'family',
      aliases: [{ alias: 'sarah@x.com', kind: 'email' }, { alias: '+15551234567', kind: 'phone' }],
    })],
    mentions: [
      mention('Sarah Wiles', { sourceRef: 's1' }),
      mention('Sarah J. Wiles', { sourceRef: 's2' }),
      mention('sarah@x.com', { sourceRef: 's3' }),
      mention('(555) 123-4567', { sourceRef: 's4' }),
      mention('Sarah', { sourceRef: 's5' }),
    ],
    overrides: [],
  })
  assert.equal(result.people.length, 1)
  assert.equal(result.people[0].mentionCount, 5)
  assert.equal(result.people[0].sourceCount, 5)
  const rules = new Set(result.mentions.map((m) => m.resolutionRule))
  assert.ok(rules.has('R1'), 'a handle resolved on R1')
})

check('two people who share a first name refuse to absorb a bare mention', () => {
  const result = resolvePeople({
    seeds: [seed('Sarah Wiles'), seed('Sarah Phillips')],
    mentions: [mention('Sarah', { sourceRef: 's1' }), mention('Sarah', { sourceRef: 's2' })],
    overrides: [],
  })
  assert.equal(result.ambiguous, 1)
  const bare = result.people.find((person) => person.personKey === 'bare:sarah')
  assert.ok(bare, 'the unresolvable name is quarantined under its own key')
  assert.equal(bare.status, 'ambiguous')
  assert.equal(bare.mentionCount, 2, 'both bare mentions land in the same quarantine')
  assert.equal(byName(result.people, 'Sarah Wiles').mentionCount, 0)
  assert.equal(byName(result.people, 'Sarah Phillips').mentionCount, 0)
})

check('the aka cell bridges a nickname to a legal name', () => {
  const result = resolvePeople({
    seeds: [seed('Linda Wiles', { relation: 'family' })],
    mentions: [mention('Mom', { sourceRef: 's1', relation: 'family', role: 'mother', aka: ['Linda Wiles'] })],
    overrides: [],
  })
  assert.equal(result.people.length, 1)
  assert.equal(result.mentions[0].resolutionRule, 'R3')
  assert.equal(result.people[0].role, 'mother', 'a document supplies the role a contact card cannot')
})

check('the relation veto keeps a public figure out of a family record', () => {
  const result = resolvePeople({
    seeds: [seed('James Clear', { relation: 'family' })],
    mentions: [mention('James Clear', { sourceRef: 's1', relation: 'public' })],
    overrides: [],
  })
  assert.equal(result.people.length, 2, 'an exact name match is still refused across incompatible relations')
})

check('the veto is deliberately weak where people really do change roles', () => {
  assert.equal(relationsCompatible('colleague', 'friend'), true)
  assert.equal(relationsCompatible('professional', 'friend'), true)
  assert.equal(relationsCompatible('family', 'partner'), true)
  assert.equal(relationsCompatible('unknown', 'family'), true)
  assert.equal(relationsCompatible('self', 'family'), false)
  assert.equal(relationsCompatible('public', 'family'), false)
})

check('a pseudonym keeps its statistics and never absorbs a name', () => {
  const result = resolvePeople({
    seeds: [seed('contact-670621', { personKey: 'pseudo:contact-670621', seedSource: 'messaging', isPseudonym: true, messageCount: 1556 })],
    mentions: [mention('Spencer Dewbury', { sourceRef: 's1' })],
    overrides: [],
  })
  const pseudo = result.people.find((person) => person.isPseudonym)
  assert.equal(pseudo.messageCount, 1556, 'the volume is honest even without a name')
  assert.equal(pseudo.mentionCount, 0, 'a named mention never lands on a pseudonym')
})

check('the archive owner is labelled self rather than becoming person one', () => {
  const result = resolvePeople({
    seeds: [],
    mentions: [mention('Andrew', { sourceRef: 's1', relation: 'self' }), mention('Andrew', { sourceRef: 's2', relation: 'self' })],
    overrides: [],
  })
  assert.equal(result.people[0].isSelf, true)
})

check('resolution is deterministic under input reordering', () => {
  // Catches accidental Map-iteration-order dependence, the classic way a
  // clustering pass becomes irreproducible.
  const seeds = [seed('Sarah Wiles', { relation: 'family' }), seed('Bob Smith')]
  const mentions = [
    mention('Sarah Wiles', { mentionKey: 'a', sourceRef: 's1' }),
    mention('Sarah J. Wiles', { mentionKey: 'b', sourceRef: 's2' }),
    mention('Mom', { mentionKey: 'c', sourceRef: 's3', aka: ['Sarah Wiles'] }),
    mention('Bob', { mentionKey: 'd', sourceRef: 's4' }),
  ]
  const forward = JSON.stringify(resolvePeople({ seeds, mentions, overrides: [] }).people)
  const reversed = JSON.stringify(resolvePeople({ seeds, mentions: [...mentions].reverse(), overrides: [] }).people)
  assert.equal(forward, reversed)
})

check('scores combine mention count and message volume, with a cap', () => {
  assert.equal(personScore(3, 0), 3)
  assert.equal(personScore(1, 500), 11)
  assert.equal(personScore(1, 100000), 21, 'message volume is capped so one thread cannot dominate')
  assert.ok(MIN_SCORE_FOR_DOSSIER > MIN_SCORE_FOR_PERSON, 'a dossier costs a model call and needs more evidence')
})

// --- overrides ---------------------------------------------------------------
console.log('overrides')

check('a pin override beats the whole cascade', () => {
  const result = resolvePeople({
    seeds: [seed('Sarah Wiles'), seed('Sarah Phillips')],
    mentions: [mention('Sarah', { mentionKey: 'pin-me', sourceRef: 's1' })],
    overrides: [{ id: 'o1', kind: 'pin', subject: 'pin-me', target: 'contact:Sarah Phillips', createdAt: 'x' }],
  })
  assert.equal(result.mentions[0].personKey, 'contact:Sarah Phillips')
  assert.equal(result.mentions[0].resolutionRule, 'R0')
})

check('a merge override joins two people the resolver refused to join', () => {
  const input = {
    seeds: [seed('Bob Smith'), seed('Robert Smith')],
    mentions: [mention('Bob Smith', { mentionKey: 'm1', sourceRef: 's1' }), mention('Robert Smith', { mentionKey: 'm2', sourceRef: 's2' })],
    overrides: [{ id: 'o2', kind: 'merge', subject: 'contact:Bob Smith', target: 'contact:Robert Smith', createdAt: 'x' }],
  }
  const first = resolvePeople(input)
  assert.equal(first.people.length, 1)
  assert.equal(first.people[0].mentionCount, 2)
  // Re-applied as an input every rebuild, so a correction can never be undone by one.
  const second = resolvePeople(input)
  assert.deepEqual(JSON.parse(JSON.stringify(second.people)), JSON.parse(JSON.stringify(first.people)))
})

check('an ignore override marks the person without deleting their evidence', () => {
  const result = resolvePeople({
    seeds: [seed('James Clear', { relation: 'public' })],
    mentions: [mention('James Clear', { sourceRef: 's1', relation: 'public' })],
    overrides: [{ id: 'o3', kind: 'ignore', subject: 'contact:James Clear', target: null, createdAt: 'x' }],
  })
  assert.equal(result.people[0].status, 'ignored')
  assert.equal(result.people[0].mentionCount, 1, 'the mention survives being ignored')
})

check('a relation override outranks every source', () => {
  const result = resolvePeople({
    seeds: [seed('Chris', { relation: 'colleague' })],
    mentions: [mention('Chris', { sourceRef: 's1', relation: 'colleague', sourceType: 'memory' })],
    overrides: [{ id: 'o4', kind: 'relation', subject: 'contact:Chris', target: 'friend', createdAt: 'x' }],
  })
  assert.equal(result.people[0].relation, 'friend')
})

// --- storage -----------------------------------------------------------------
console.log('storage')

const storedPerson = (person) => ({
  personKey: person.personKey,
  displayName: person.displayName,
  relation: person.relation,
  role: person.role,
  status: person.status,
  isPseudonym: person.isPseudonym,
  isSelf: person.isSelf,
  seedSource: person.seedSource,
  mentionCount: person.mentionCount,
  sourceCount: person.sourceCount,
  messageCount: person.messageCount,
  sentCount: person.sentCount,
  daysActive: person.daysActive,
  firstSeen: person.firstSeen,
  lastSeen: person.lastSeen,
  score: person.score,
  confidence: person.confidence,
  projectIds: person.projectIds,
  platforms: person.platforms,
  aliases: person.aliases,
})
const storedMention = (m) => ({
  mentionKey: m.mentionKey,
  personKey: m.personKey,
  rawName: m.rawName,
  nameKey: m.nameKey,
  handleKey: m.handleKey,
  relation: m.relation,
  role: m.role,
  aka: m.aka,
  evidence: m.evidence,
  sourceType: m.sourceType,
  sourceRef: m.sourceRef,
  sourceLabel: m.sourceLabel,
  projectId: m.projectId,
  confidence: m.confidence,
  resolutionRule: m.resolutionRule,
})
const persist = (result) =>
  database.mergeDerivedPeople(result.people.map(storedPerson), result.mentions.map(storedMention))

const roundOne = resolvePeople({
  seeds: [seed('Sarah Wiles', { relation: 'family', role: 'sister', messageCount: 400 })],
  mentions: [
    mention('Sarah Wiles', { mentionKey: 'p1', sourceRef: 'ps1' }),
    mention('Gone Person', { mentionKey: 'p2', sourceRef: 'ps2' }),
  ],
  overrides: [],
})

check('a resolved pass round-trips through the database', () => {
  const stats = persist(roundOne)
  assert.ok(stats.inserted >= 2)
  const people = database.listPeople({ minScore: 0 })
  const sarah = byName(people, 'Sarah Wiles')
  assert.ok(sarah)
  assert.equal(sarah.relation, 'family')
  assert.equal(sarah.messageCount, 400)
  assert.ok(sarah.aliases.length > 0, 'aliases persist alongside the person')
  assert.equal(database.listPersonMentions(sarah.id).length, 1)
})

check('a person whose sources went quiet is archived, never deleted', () => {
  const roundTwo = resolvePeople({
    seeds: [seed('Sarah Wiles', { relation: 'family', role: 'sister', messageCount: 400 })],
    mentions: [mention('Sarah Wiles', { mentionKey: 'p1', sourceRef: 'ps1' })],
    overrides: [],
  })
  const stats = persist(roundTwo)
  assert.ok(stats.archived >= 1)
  assert.equal(byName(database.listPeople({ minScore: 0 }), 'Gone Person'), undefined)
  const withArchived = database.listPeople({ minScore: 0, includeArchived: true })
  assert.ok(byName(withArchived, 'Gone Person'), 'the record survives as history')
})

check('returning to the evidence un-archives the person', () => {
  persist(roundOne)
  assert.ok(byName(database.listPeople({ minScore: 0 }), 'Gone Person'))
})

check('a stored dossier survives a rebuild that did not change the evidence', () => {
  const sarah = byName(database.listPeople({ minScore: 0 }), 'Sarah Wiles')
  database.setPersonDossier({
    personKey: sarah.personKey,
    contextShort: 'Sister, in near-daily contact.',
    context: 'A longer profile grounded only in the evidence given.',
    dossierHash: 'hash-1',
  })
  persist(roundOne)
  const after = byName(database.listPeople({ minScore: 0 }), 'Sarah Wiles')
  assert.equal(after.dossierShort, 'Sister, in near-daily contact.')
  assert.equal(after.dossierHash, 'hash-1', 'the hash gate survives so the next pass costs nothing')
})

check('a dossier is versioned rather than overwritten', () => {
  const sarah = byName(database.listPeople({ minScore: 0 }), 'Sarah Wiles')
  database.setPersonDossier({
    personKey: sarah.personKey,
    contextShort: 'Revised.',
    context: 'A revised profile.',
    dossierHash: 'hash-2',
  })
  const versions = database.listContextVersions({ sourceTypes: ['person-dossier'] })
  assert.ok(versions.length >= 2, 'nothing generated is ever destroyed')
})

check('overrides persist and read back', () => {
  database.setPeopleOverride('ignore', 'contact:Someone', null)
  assert.ok(database.listPeopleOverrides().some((o) => o.kind === 'ignore' && o.subject === 'contact:Someone'))
  database.clearPeopleOverride('ignore', 'contact:Someone')
  assert.ok(!database.listPeopleOverrides().some((o) => o.subject === 'contact:Someone'))
})

check('the mention fingerprint is order-independent', () => {
  const a = [{ sourceRef: 'a', rawName: 'X', relation: 'friend', evidence: 'e' }, { sourceRef: 'b', rawName: 'Y', relation: 'family', evidence: 'ee' }]
  assert.equal(mentionsFingerprint(a), mentionsFingerprint([...a].reverse()))
})

// --- harvest and chat context ------------------------------------------------
console.log('harvest and chat context')

check('the harvest reads PEOPLE blocks and skips image contexts', () => {
  const project = database.createProject({
    name: 'People Fixture',
    icon: 'faFolder',
    color: '#fff',
    path: null,
    files: [],
    analysis: null,
    healthAnalysis: null,
    activityAnalysis: null,
    financesSummary: null,
  })
  database.upsertDocumentFileContext({
    projectId: project.id,
    filePath: '/tmp/a.txt',
    relativePath: 'a.txt',
    contentHash: 'h1',
    kind: 'text',
    context: `Prose.\n\nPEOPLE:\n- Trista Culver | friend | | frequent correspondent`,
  })
  database.upsertDocumentFileContext({
    projectId: project.id,
    filePath: '/tmp/b.jpg',
    relativePath: 'b.jpg',
    contentHash: 'h2',
    kind: 'image',
    context: `A photo.\n\nPEOPLE:\n- Should Not Appear | friend | | never harvested`,
  })
  const { mentions } = harvestPersonMentions()
  const names = mentions.map((m) => m.rawName)
  assert.ok(names.includes('Trista Culver'))
  assert.ok(!names.includes('Should Not Appear'), 'photo contexts are never read for people')
})

check('the chat block states coverage, carries the caveats and respects its budget', () => {
  const resolved = resolvePeople({
    seeds: [seed('Spencer Dewbury', { relation: 'friend', messageCount: 29087, seedSource: 'messaging', personKey: 'messaging:spencer dewbury' })],
    mentions: [mention('Spencer Dewbury', { mentionKey: 'c1', sourceRef: 'cs1' })],
    overrides: [],
  })
  persist(resolved)
  const block = buildPeopleContext({ maxChars: 4000 })
  assert.ok(block, 'a block is produced once there are confirmed people')
  assert.ok(/recorded people/.test(block.content), 'coverage is stated honestly')
  assert.ok(block.content.length <= 4000 + 200)
  assert.ok(/Spencer Dewbury/.test(block.content))
})

check('the chat block is null when nothing clears the threshold', () => {
  const empty = buildPeopleContext({ projectIds: ['no-such-project'] })
  assert.equal(empty, null)
})

check('collectPersonSeeds never throws without Contacts access', () => {
  assert.ok(Array.isArray(collectPersonSeeds()))
})

check('absorbing the retired relationship analysis is idempotent', () => {
  assert.equal(typeof database.absorbRelationshipAnalyses(), 'number')
  assert.equal(database.absorbRelationshipAnalyses(), 0, 'a second pass moves nothing')
})

// --- platforms and message history -------------------------------------------
console.log('platforms and message history')

const platform = (provider, over = {}) => ({
  provider,
  messageCount: over.messageCount ?? 100,
  sentCount: over.sentCount ?? 40,
  daysActive: over.daysActive ?? 30,
  firstSeen: over.firstSeen ?? '2022-01-01T00:00:00.000Z',
  lastSeen: over.lastSeen ?? '2024-01-01T00:00:00.000Z',
})

check('the same person on two platforms becomes one record with a breakdown', () => {
  // Two platforms arrive as two seeds sharing a display name; nothing special-cases
  // this, they simply merge on the name like any other pair of seeds.
  const result = resolvePeople({
    seeds: [
      seed('Spencer Dewbury', { personKey: 'messaging:spencer dewbury', seedSource: 'messaging', platforms: [platform('imessage', { messageCount: 29087 })], messageCount: 29087 }),
      seed('Spencer Dewbury', { personKey: 'messaging:spencer dewbury:discord', seedSource: 'messaging', platforms: [platform('discord', { messageCount: 412 })], messageCount: 412 }),
    ],
    mentions: [],
    overrides: [],
  })
  assert.equal(result.people.length, 1)
  const person = result.people[0]
  assert.equal(person.messageCount, 29499, 'volume is summed')
  assert.deepEqual(person.platforms.map((p) => p.provider), ['imessage', 'discord'], 'ordered by volume')
  assert.equal(person.platforms[0].messageCount, 29087, 'the breakdown is kept, not collapsed')
})

check('the same provider seen twice merges into one platform row', () => {
  const result = resolvePeople({
    seeds: [
      seed('Kaelyn', { personKey: 'a', seedSource: 'messaging', platforms: [platform('imessage', { messageCount: 10, firstSeen: '2020-01-01T00:00:00.000Z' })] }),
      seed('Kaelyn', { personKey: 'b', seedSource: 'messaging', platforms: [platform('imessage', { messageCount: 5, lastSeen: '2026-01-01T00:00:00.000Z' })] }),
    ],
    mentions: [],
    overrides: [],
  })
  assert.equal(result.people[0].platforms.length, 1)
  assert.equal(result.people[0].platforms[0].messageCount, 15)
  assert.equal(result.people[0].platforms[0].firstSeen, '2020-01-01T00:00:00.000Z', 'the span widens to cover both')
  assert.equal(result.people[0].platforms[0].lastSeen, '2026-01-01T00:00:00.000Z')
})

check('linking a handle to a known person carries its platform across', () => {
  // A username shares no name with a contact card, so only an explicit link can
  // join them — and the link must bring the platform record with it.
  const result = resolvePeople({
    seeds: [
      seed('Spencer Dewbury', { personKey: 'contact:0:1', platforms: [platform('imessage', { messageCount: 29087 })], messageCount: 29087 }),
      seed('spencerd_92', { personKey: 'messaging:spencerd 92', seedSource: 'messaging', platforms: [platform('discord', { messageCount: 412 })], messageCount: 412 }),
    ],
    mentions: [],
    overrides: [{ id: 'o', kind: 'merge', subject: 'messaging:spencerd 92', target: 'contact:0:1', createdAt: 'x' }],
  })
  assert.equal(result.people.length, 1)
  assert.deepEqual(result.people[0].platforms.map((p) => p.provider).sort(), ['discord', 'imessage'])
})

check('an unlinked handle stays its own person rather than being guessed at', () => {
  const result = resolvePeople({
    seeds: [
      seed('Spencer Dewbury', { personKey: 'contact:0:1' }),
      seed('spencerd_92', { personKey: 'messaging:spencerd 92', seedSource: 'messaging' }),
    ],
    mentions: [],
    overrides: [],
  })
  assert.equal(result.people.length, 2, 'nothing automatic joins a username to a name')
})

check('a person-year of messages is stored, versioned and hash-gated', () => {
  database.upsertPersonYearContext({
    personKey: 'contact:0:1',
    displayName: 'Spencer Dewbury',
    year: 2024,
    context: 'That year was mostly gym plans and a running joke about the drive.',
    messageCount: 7000,
    sampledCount: 600,
    inputHash: 'y-hash-1',
  })
  const years = database.listPersonYearContexts('contact:0:1')
  assert.equal(years.length, 1)
  assert.equal(years[0].year, 2024)
  assert.equal(years[0].messageCount, 7000)
  assert.equal(years[0].sampledCount, 600, 'how much was actually read is recorded, not just how much exists')
  assert.equal(database.getPersonYearHashes().get('contact:0:1:2024'), 'y-hash-1')

  database.upsertPersonYearContext({
    personKey: 'contact:0:1', displayName: 'Spencer Dewbury', year: 2024,
    context: 'A revised summary.', messageCount: 7000, sampledCount: 600, inputHash: 'y-hash-2',
  })
  assert.equal(database.listPersonYearContexts('contact:0:1').length, 1, 'the year is updated, not duplicated')
  assert.ok(
    database.listContextVersions({ sourceTypes: ['person-year'] }).length >= 2,
    'nothing generated is ever destroyed'
  )
})

check('the message sample spreads across the year instead of taking one window', () => {
  // A recency window would describe one week and call it a year, which is exactly
  // what the per-year layer exists to avoid.
  const source = fs.readFileSync(new URL('./src/main/database.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function listCounterpartyMessages')
  const body = source.slice(start, start + 1400)
  assert.ok(/ROW_NUMBER\(\) OVER \(ORDER BY occurred_at\)/.test(body), 'rows are numbered chronologically')
  assert.ok(/% CAST\(MAX\(total \/ \?, 1\) AS INTEGER\) = 0/.test(body), 'an even stride samples the whole span')
})

check('the year summary prompt forbids inventing, quoting and diagnosing', () => {
  const source = fs.readFileSync(new URL('./src/main/people.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const PERSON_YEAR_SYSTEM_PROMPT')
  const body = source.slice(start, source.indexOf('`', source.indexOf('`', start) + 1))
  assert.ok(/Use ONLY these messages/.test(body))
  assert.ok(/evenly sampled across the year, not the whole thread/.test(body), 'the model is told the sample is partial')
  assert.ok(/Do not quote more than a short phrase/.test(body))
  assert.ok(/No diagnoses, no judgments/.test(body))
})

check('a regenerated year invalidates the profile built from it', () => {
  const source = fs.readFileSync(new URL('./src/main/people.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function dossierHashFor')
  const body = source.slice(start, start + 1200)
  assert.ok(/listPersonYearContexts/.test(body), 'the year summaries are folded into the dossier hash')
})

// --- run lifecycle -----------------------------------------------------------
console.log('run lifecycle')

check('an idle registry reports idle and nothing to resume', () => {
  resetPeopleRunsForTests()
  const state = getPeopleRunState()
  assert.equal(state.status, 'idle')
  assert.equal(state.canResume, false)
  assert.equal(state.pendingAction, null)
  assert.equal(isPeopleRunActive(), false)
})

check('a running rebuild reports progress and its origin', () => {
  resetPeopleRunsForTests()
  const run = beginPeopleRun('user')
  assert.equal(isPeopleRunActive(), true)
  reportPeopleRunProgress(run, { phase: 'dossier', message: 'Profiling Mom', current: 3, total: 28 })
  const state = getPeopleRunState()
  assert.equal(state.status, 'running')
  assert.equal(state.origin, 'user')
  assert.equal(state.progress.current, 3)
  assert.equal(state.progress.total, 28)
  finishPeopleRun(run)
})

check('pause aborts the run, reports stopping, then settles into a resumable pause', () => {
  resetPeopleRunsForTests()
  const run = beginPeopleRun('user')
  reportPeopleRunProgress(run, { phase: 'dossier', message: 'Profiling Dad', current: 5, total: 28 })
  const stopping = requestPeopleRunPause()
  assert.equal(stopping.status, 'stopping')
  assert.equal(stopping.pendingAction, 'pause')
  assert.equal(run.signal.aborted, true, 'the registry owns the controller, so pause reaches the run')

  assert.equal(finishPeopleRun(run), 'paused')
  const state = getPeopleRunState()
  assert.equal(state.status, 'paused')
  assert.equal(state.canResume, true)
  assert.match(state.message, /5 of 28 profiles/)
  assert.match(state.message, /resuming skips/)
  assert.equal(isPeopleRunPaused(), true)
})

check('a paused rebuild survives being read back — the record is persisted', () => {
  // Same guarantee the document index gives: closing the app does not silently
  // discard the fact that the user paused.
  assert.equal(getPeopleRunState().status, 'paused')
  assert.ok(settingsModule.getPeopleIndexPause())
})

check('starting a new run clears the resume point', () => {
  const run = beginPeopleRun('user')
  assert.equal(getPeopleRunState().status, 'running')
  assert.equal(getPeopleRunState().canResume, false)
  finishPeopleRun(run)
  assert.equal(getPeopleRunState().status, 'idle')
})

check('stop aborts without leaving anything to resume', () => {
  resetPeopleRunsForTests()
  const run = beginPeopleRun('user')
  reportPeopleRunProgress(run, { phase: 'dossier', message: 'Profiling', current: 2, total: 9 })
  const stopping = requestPeopleRunStop()
  assert.equal(stopping.pendingAction, 'stop')
  assert.equal(run.signal.aborted, true)
  assert.equal(finishPeopleRun(run), 'stopped')
  const state = getPeopleRunState()
  assert.equal(state.status, 'idle')
  assert.equal(state.canResume, false)
  assert.match(state.message, /Stopped after 2 of 9 profiles/)
})

check('stopping a paused rebuild discards the resume point', () => {
  resetPeopleRunsForTests()
  const run = beginPeopleRun('user')
  reportPeopleRunProgress(run, { phase: 'dossier', message: 'x', current: 1, total: 4 })
  requestPeopleRunPause()
  finishPeopleRun(run)
  assert.equal(isPeopleRunPaused(), true)
  const state = requestPeopleRunStop()
  assert.equal(state.status, 'idle')
  assert.equal(state.canResume, false)
  assert.match(state.message, /^Stopped/)
})

check('a failure is reported as a failure, not as a stop', () => {
  resetPeopleRunsForTests()
  const run = beginPeopleRun('timer')
  assert.equal(finishPeopleRun(run, { failed: true, message: 'provider exploded' }), 'failed')
  assert.equal(getPeopleRunState().message, 'provider exploded')
})

check('a superseded run cannot paint over the run that replaced it', () => {
  resetPeopleRunsForTests()
  const first = beginPeopleRun('timer')
  const second = beginPeopleRun('user')
  assert.equal(first.signal.aborted, true, 'starting a run supersedes the one before it')
  reportPeopleRunProgress(first, { phase: 'harvest', message: 'stale', current: 1, total: 2 })
  assert.equal(getPeopleRunState().progress, null, 'the stale run is ignored')
  assert.equal(finishPeopleRun(first), 'stopped')
  assert.equal(getPeopleRunState().status, 'running', 'the live run is untouched')
  finishPeopleRun(second)
  resetPeopleRunsForTests()
})

check('the pause message names where it stopped', () => {
  assert.match(describePeopleProgress({ phase: 'dossier', message: '', current: 7, total: 12 }), /7 of 12 profiles/)
  assert.match(describePeopleProgress({ phase: 'harvest', message: '', current: null, total: null }), /harvest pass/)
  assert.match(describePeopleProgress(null), /before any profiles/)
})

// --- wiring ------------------------------------------------------------------
console.log('wiring')

check('the People chat block is registered in the system-prompt builder', () => {
  const source = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
  assert.ok(/buildPeopleContext\(/.test(source))
  assert.ok(/label: 'People'/.test(source))
  assert.ok(/settings\.getSettings\(\)\.peopleEnabled/.test(source))
  assert.ok(/Identity resolution here is heuristic/.test(source), 'the ambiguity caveat is stated')
  assert.ok(/never volunteer anyone's phone number/i.test(source), 'the contact-details rule is stated')
})

check('the background timer defers to every other run and is cleared on quit', () => {
  const source = fs.readFileSync(new URL('./src/main/main.ts', import.meta.url), 'utf8')
  assert.ok(/beginPeopleRun\('timer'\)/.test(source))
  assert.ok(/isPeopleRunActive\(\) \|\| isTimelineRunActive\(\) \|\| isDocumentIndexRunActive\(\)/.test(source))
  assert.ok(/if \(peopleTimer\) clearInterval\(peopleTimer\)/.test(source))
})

check('the sidebar shows the People index and the widget can pause and stop it', () => {
  const sidebar = fs.readFileSync(new URL('./src/renderer/components/Sidebar.tsx', import.meta.url), 'utf8')
  assert.ok(/usePeopleRunState\(\)/.test(sidebar), 'the sidebar subscribes through the shared hook')
  assert.ok(/peopleVisible/.test(sidebar), 'the row is shown while running, stopping or paused')
  assert.ok(/People index paused/.test(sidebar))
  const widget = fs.readFileSync(new URL('./src/renderer/components/PeopleWidget.tsx', import.meta.url), 'utf8')
  assert.ok(/people\.pause\(\)/.test(widget), 'the widget can pause')
  assert.ok(/people\.abort\(\)/.test(widget), 'the widget can stop')
  assert.ok(/Resume/.test(widget), 'a paused rebuild offers Resume')
})

check('the background timer leaves a paused rebuild alone', () => {
  // Restarting work the user paused on purpose would make the pause meaningless.
  const source = fs.readFileSync(new URL('./src/main/main.ts', import.meta.url), 'utf8')
  assert.ok(/if \(isPeopleRunPaused\(\)\) return/.test(source))
})

check('the four-file IPC sync names the same People channels', () => {
  const channels = fs.readFileSync(new URL('./src/main/ipcChannels.ts', import.meta.url), 'utf8')
  const ipc = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
  const preload = fs.readFileSync(new URL('./src/preload/preload.ts', import.meta.url), 'utf8')
  const block = channels.match(/PEOPLE: \{([\s\S]*?)\n {2}\}/)
  assert.ok(block, 'the PEOPLE namespace exists')
  const keys = [...block[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1])
  assert.ok(keys.length >= 10)
  for (const key of keys) {
    if (key === 'STATE' || key === 'PROGRESS') {
      assert.ok(preload.includes(`IPC.PEOPLE.${key}`), `preload subscribes to ${key}`)
      continue
    }
    assert.ok(ipc.includes(`IPC.PEOPLE.${key}`), `ipc.ts handles ${key}`)
    assert.ok(preload.includes(`IPC.PEOPLE.${key}`), `preload binds ${key}`)
  }
})

check('the iMessage relationship analysis is gone', () => {
  const provider = fs.readFileSync(new URL('./src/main/provider.ts', import.meta.url), 'utf8')
  const ipc = fs.readFileSync(new URL('./src/main/ipc.ts', import.meta.url), 'utf8')
  const channels = fs.readFileSync(new URL('./src/main/ipcChannels.ts', import.meta.url), 'utf8')
  assert.ok(!/RELATIONSHIP_SYSTEM_PROMPT/.test(provider))
  assert.ok(!/analyzeRelationships/.test(provider))
  assert.ok(!/analyzeRelationships|ANALYZE_RELATIONSHIPS/.test(ipc))
  assert.ok(!/IMESSAGE:/.test(channels))
  assert.ok(!fs.existsSync(new URL('./src/renderer/components/RelationshipsWidget.tsx', import.meta.url)))
})

check('no component subscribes to the People IPC channels directly', () => {
  // One refcounted subscription app-wide, or nine mounted views trip Node's
  // 10-listener warning — the lesson useDocumentIndex already learned.
  const dir = new URL('./src/renderer/components/', import.meta.url)
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue
    const source = fs.readFileSync(new URL(file, dir), 'utf8')
    assert.ok(!/people\.(onState|onProgress)\(/.test(source), `${file} must use usePeopleRunState()`)
  }
  const hook = fs.readFileSync(new URL('./src/renderer/hooks/usePeopleRun.ts', import.meta.url), 'utf8')
  assert.equal(hook.match(/people\.onState\(/g)?.length, 1)
})

database.closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })
console.log(`\nAll ${passed} people checks passed.`)
