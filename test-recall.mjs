import assert from 'node:assert/strict'
import {
  buildLocalRecallExpansions,
  buildRecallCandidateTerms,
  buildRecallConversationSystemPrompt,
  createRecallSnippet,
  parseSpotlightTextContent,
  parseRecallSearchRequest,
  rankRecallConversations,
  scoreRecallText,
  selectBalancedResults,
  shouldAnswerRecallQuery,
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

console.log('Recall request, question detection, extraction, snippet, and ranking checks passed')
