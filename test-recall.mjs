import assert from 'node:assert/strict'
import {
  allocateGroundingBudget,
  buildLocalRecallExpansions,
  buildRecallCandidateTerms,
  buildRecallConversationSystemPrompt,
  buildSpotlightQueries,
  contentDensityScore,
  createRecallSnippet,
  isNoiseRecallPath,
  looksLikeListQuestion,
  parseSpotlightTextContent,
  parseRecallSearchRequest,
  rankRecallConversations,
  scoreRecallFileCandidate,
  scoreRecallText,
  selectBalancedResults,
  shouldAnswerRecallQuery,
  tokenVariants,
} from './src/main/recall.ts'

const request = parseRecallSearchRequest({
  query: '  notes about moving home  ',
  source: 'all',
  semantic: true,
  limit: 500,
})

assert.equal(request.query, 'notes about moving home')
assert.equal(request.limit, 100)
assert.throws(() => parseRecallSearchRequest({ ...request, scope: 'all' }), /unsupported field/)
assert.throws(() => parseRecallSearchRequest({ ...request, extra: true }), /unsupported field/)
assert.throws(() => parseRecallSearchRequest({ ...request, query: ' ' }), /query is required/)

const terms = buildRecallCandidateTerms(request.query, ['relocation plans', 'changing residence'])
assert.ok(terms.includes('moving'))
assert.ok(terms.includes('relocation'))
assert.ok(!terms.includes('about'))
assert.equal(shouldAnswerRecallQuery('What was my first job?'), true)
assert.equal(shouldAnswerRecallQuery('resume files'), false)
assert.deepEqual(
  buildLocalRecallExpansions('What was my first job?'),
  ['resume', 'curriculum vitae', 'employment history', 'work experience']
)
assert.ok(buildLocalRecallExpansions('Where did I go to college?').includes('transcript'))

const conversationPrompt = buildRecallConversationSystemPrompt(
  'What was my first job?',
  'Your first job was at Acme.',
  [{ resultId: 'file:resume', title: 'Resume.pdf', content: 'Acme - 2019' }]
)
assert.match(conversationPrompt, /UNTRUSTED ORIGINAL RECALL QUESTION:\nWhat was my first job\?/)
assert.match(conversationPrompt, /UNTRUSTED PRIOR GROUNDED ANSWER:\nYour first job was at Acme\./)
assert.match(conversationPrompt, /SOURCE 1: Resume\.pdf/)
assert.match(conversationPrompt, /untrusted reference data/)

assert.equal(
  parseSpotlightTextContent('kMDItemTextContent = "First role\\nCaf\\U00e9 manager";'),
  'First role\nCafé manager'
)

const snippet = createRecallSnippet(
  `${'Earlier context. '.repeat(30)}The relocation plan starts in September and includes a new lease.${' Later context.'.repeat(30)}`,
  terms,
  120
)
assert.match(snippet, /relocation plan starts in September/)
assert.ok(snippet.length <= 126)

const now = Date.now()
const ranked = rankRecallConversations([
  {
    messageId: 'message-1',
    conversationId: 'conversation-1',
    conversationTitle: 'Apartment planning',
    role: 'user',
    content: 'Our relocation plans include ending the lease and moving closer to work.',
    createdAt: now,
  },
  {
    messageId: 'message-2',
    conversationId: 'conversation-2',
    conversationTitle: 'Insurance renewal',
    role: 'assistant',
    content: 'The annual premium is due in September.',
    createdAt: now,
  },
  {
    messageId: 'message-3',
    conversationId: 'conversation-1',
    conversationTitle: 'Apartment planning',
    role: 'assistant',
    content: 'The relocation plans also mention a moving company.',
    createdAt: now - 1000,
  },
], request.query, ['relocation plans'])

assert.equal(ranked.length, 1)
assert.equal(ranked[0].conversationId, 'conversation-1')
assert.equal(ranked[0].context, 'You message')
assert.match(ranked[0].snippet, /relocation plans/)
assert.ok(scoreRecallText('My first job was at Acme.', 'Career notes', 'first job', ['work experience']) > 0)

const syntheticResult = (id, source, score) => ({
  id,
  source,
  title: id,
  context: '',
  snippet: '',
  score,
  modifiedAt: now,
})
const balanced = selectBalancedResults(
  Array.from({ length: 5 }, (_, index) => syntheticResult(`file-${index}`, 'file', 1)),
  Array.from({ length: 30 }, (_, index) => syntheticResult(`chat-${index}`, 'conversation', 100 - index)),
  [],
  10
)
assert.equal(balanced.filter((result) => result.source === 'file').length, 3)

// --- Spotlight query construction --------------------------------------------
// mdfind ANDs every word of a plain query, so a question handed over verbatim
// demands the file contain "what", "are", "my" and "favorite". A list of movie
// ratings contains none of them, which is how the whole feature missed it.
const movieQueries = buildSpotlightQueries('What are my favorite movies?', ['movies', 'film ratings'])
assert.ok(movieQueries.every((query) => !/\b(what|are|my)\b/.test(query.text)))
assert.ok(movieQueries.some((query) => query.text.trim() === 'favorite movies'))
// The question words are stripped, but the topic word must still be reachable
// on its own, because no list of films describes itself as "favorite".
assert.ok(movieQueries.some((query) => query.text.includes('kMDItemTextContent == "movies"')))
// A ranking question is asked of a table, so ask Spotlight for the topic and
// the shape of the answer together.
assert.ok(movieQueries.some((query) => (
  query.text.includes('kMDItemContentTypeTree == "public.spreadsheet"') && query.text.includes('"movies"')
)))
assert.ok(movieQueries.length <= 10)

const plainQueries = buildSpotlightQueries('notes about moving home', [])
assert.ok(!plainQueries.some((query) => query.text.includes('public.spreadsheet')))

assert.equal(looksLikeListQuestion('What are my favorite movies?'), true)
assert.equal(looksLikeListQuestion('Which book did I rate highest?'), true)
assert.equal(looksLikeListQuestion('When did I move to Denver?'), false)

assert.ok(buildLocalRecallExpansions('What are my favorite movies?').includes('movies'))
assert.ok(buildLocalRecallExpansions('What books have I read?').includes('reading list'))

// --- Candidate filtering ------------------------------------------------------
// mdfind returns matches in index order with no relevance ranking, so machine
// state consumes the result cap ahead of the user's own documents.
assert.equal(isNoiseRecallPath('/Users/ada/Library/Caches/com.apple.Safari/index.db'), true)
assert.equal(isNoiseRecallPath('/Users/ada/projects/app/node_modules/pkg/readme.md'), true)
assert.equal(isNoiseRecallPath('/System/Library/Fonts/Helvetica.ttc'), true)
assert.equal(isNoiseRecallPath('/Users/ada/.cache/pip/notes.txt'), true)
assert.equal(isNoiseRecallPath('/Users/ada/Documents/Media.xlsx'), false)
assert.equal(isNoiseRecallPath('/Volumes/archive/media/Media.xlsx'), false)
// iCloud Drive and Mail live under Library but are the user's own content.
assert.equal(isNoiseRecallPath('/Users/ada/Library/Mobile Documents/com~apple~CloudDocs/taxes.pdf'), false)
assert.equal(isNoiseRecallPath('/Users/ada/Library/Mail/V10/message.emlx'), false)

// --- Candidate scoring --------------------------------------------------------
const ratingsQuery = 'What are my favorite movies?'
const ratingsExpansions = buildLocalRecallExpansions(ratingsQuery)
const sheetScore = scoreRecallFileCandidate('/Volumes/archive/media/Media.xlsx', 1, ratingsQuery, ratingsExpansions)
const jsonScore = scoreRecallFileCandidate('/Volumes/archive/dump/events.json', 1, ratingsQuery, ratingsExpansions)
// A ranking question is answered by a table, not by a log of events.
assert.ok(sheetScore > jsonScore, `${sheetScore} vs ${jsonScore}`)
// A file on a secondary drive is as much the user's as one in the home folder;
// scoring only the home directory hid every external archive.
assert.equal(
  scoreRecallFileCandidate('/Volumes/archive/media/Media.xlsx', 1, ratingsQuery, ratingsExpansions),
  scoreRecallFileCandidate(`${process.env.HOME}/media/Media.xlsx`, 1, ratingsQuery, ratingsExpansions)
)

// A question says "movies" where the column heading says "Movie".
assert.deepEqual(tokenVariants('movies').sort(), ['movie', 'movies'])
assert.deepEqual(tokenVariants('film').sort(), ['film', 'films'])

// Presence alone cannot tell a template that lists "Movies" as a category once
// from a log of every film watched, and only one of them answers the question.
const densityTerms = buildRecallCandidateTerms(ratingsQuery, ratingsExpansions)
const logDensity = contentDensityScore(`Movie\tRating\n${'Some Film\t9\n'.repeat(200)}`, densityTerms)
const mentionDensity = contentDensityScore('Category list: Movies, Books, Tools', densityTerms)
assert.ok(logDensity > mentionDensity, `${logDensity} vs ${mentionDensity}`)
assert.ok(contentDensityScore('unrelated text about gardening', densityTerms) === 0)

// --- Grounding budget ---------------------------------------------------------
// What a short source does not use is handed back, so one long record survives
// intact instead of every source being cut to the same fixed slice.
assert.deepEqual(allocateGroundingBudget([500, 40_000, 40_000], 60_000), [500, 29_750, 29_750])
assert.deepEqual(allocateGroundingBudget([100, 200], 60_000), [100, 200])
assert.deepEqual(allocateGroundingBudget([], 60_000), [])

// --- Reading a reasoning model's reply ----------------------------------------
// A model told to "return only JSON" thinks out loud first and puts the JSON
// last. Matching the first "{" to the final "}" swallows any braces in the
// prose, so the object is found by scanning for balanced braces.
const { extractJsonObject } = await import('./src/main/provider.ts')

assert.deepEqual(extractJsonObject('{"answer":"hi","sourceIds":["source-1"]}'), { answer: 'hi', sourceIds: ['source-1'] })
assert.deepEqual(extractJsonObject('```json\n{"queries":["a"]}\n```'), { queries: ['a'] })
assert.deepEqual(
  extractJsonObject('Movies rated 10:\n- Puss in Boots {great}\n\n{"answer":"Puss in Boots.","sourceIds":["source-2"]}'),
  { answer: 'Puss in Boots.', sourceIds: ['source-2'] }
)
assert.deepEqual(extractJsonObject('Consider {a: 1} then answer.\n{"queries":["films"]}'), { queries: ['films'] })
// Braces inside a string must not close the object early.
assert.deepEqual(extractJsonObject('note\n{"answer":"uses { and } chars","sourceIds":[]}'), { answer: 'uses { and } chars', sourceIds: [] })
// Cut off mid-JSON: no balanced object, so nothing is returned rather than a
// half-parsed one.
assert.equal(extractJsonObject('thinking...\n{"answer":"half writ'), undefined)
assert.equal(extractJsonObject('no json here at all'), undefined)

console.log('Recall request, question detection, extraction, snippet, and ranking checks passed')
