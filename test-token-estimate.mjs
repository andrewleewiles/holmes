import assert from 'node:assert/strict'
import {
  TOKEN_ESTIMATE_DISCLAIMER,
  estimateBlockTokens,
  estimateTokens,
  estimateTotalTokens,
  formatTokenEstimate,
} from './src/shared/tokenEstimate.ts'

// Empty input costs nothing; any non-empty input costs at least one token.
assert.equal(estimateTokens(''), 0)
assert.equal(estimateTokens(' '), 1)
assert.equal(estimateTokens('a'), 1)
assert.equal(estimateTokens('\n'), 1)

// Reference sentence: real BPE tokenizers (cl100k/o200k) put this at 10 tokens.
assert.equal(estimateTokens('The quick brown fox jumps over the lazy dog.'), 10)

// Short function words each cost a token — naive chars/4 underestimates this badly.
const shortWords = 'I am a fan of it'
assert.equal(estimateTokens(shortWords), 6)
assert.ok(estimateTokens(shortWords) > Math.round(shortWords.length / 4))

// Punctuation-dense structured text is denser than 4 chars/token.
const json = '{"name": "Andrew", "age": 42}'
assert.ok(estimateTokens(json) > Math.round(json.length / 4))
assert.ok(estimateTokens(json) >= 9 && estimateTokens(json) <= 14)

// CJK runs at roughly one token per character, not one per four.
assert.equal(estimateTokens('你好世界'), 4)
assert.equal(estimateTokens('こんにちは'), 5)
assert.equal(estimateTokens('안녕하세요'), 5)

// Long rare words cost more than short ones.
assert.ok(estimateTokens('internationalization') > estimateTokens('cat'))

// Repeated whitespace (indentation, blank lines) is not free but is cheap.
assert.ok(estimateTokens('a\n\n\n\n\n\n\nb') > estimateTokens('a b'))
assert.ok(estimateTokens('word word') < estimateTokens('word     word'))

// Monotonic: appending text never lowers the estimate.
let previous = 0
let grown = ''
for (const chunk of ['Holmes ', 'builds ', 'a system prompt ', 'from context blocks.']) {
  grown += chunk
  const current = estimateTokens(grown)
  assert.ok(current >= previous)
  previous = current
}

// English prose calibrates near the widely cited ~4 characters per token.
const prose =
  'You are Holmes, a local-first desktop assistant. You have access to the user memory catalog, ' +
  'their project files, and a dated timeline of their life. Answer plainly, cite the context block ' +
  'you used, and never invent a date that is not present in the supplied evidence.'
const charsPerToken = prose.length / estimateTokens(prose)
assert.ok(charsPerToken > 3.4 && charsPerToken < 4.6, `chars per token was ${charsPerToken}`)

// Block helpers: the total is exactly the sum of the parts, so the UI never disagrees with itself.
const blocks = [{ content: 'Alpha block content.' }, { content: 'Beta block content, slightly longer.' }, { content: '' }]
const perBlock = estimateBlockTokens(blocks)
assert.equal(perBlock.length, 3)
assert.equal(perBlock[2], 0)
assert.equal(estimateTotalTokens(blocks), perBlock.reduce((sum, n) => sum + n, 0))
assert.equal(estimateTotalTokens([]), 0)

// Formatting stays compact and never claims false precision.
assert.equal(formatTokenEstimate(0), '0')
assert.equal(formatTokenEstimate(999), '999')
assert.equal(formatTokenEstimate(1000), '1.0k')
assert.equal(formatTokenEstimate(1240), '1.2k')
assert.equal(formatTokenEstimate(9999), '10.0k')
assert.equal(formatTokenEstimate(12480), '12k')

assert.ok(TOKEN_ESTIMATE_DISCLAIMER.toLowerCase().includes('approximate'))

// Large inputs stay fast enough to run on every render.
const large = prose.repeat(400)
const started = Date.now()
const largeTokens = estimateTokens(large)
assert.ok(largeTokens > 0)
assert.ok(Date.now() - started < 500)

console.log('token estimate tests passed')
