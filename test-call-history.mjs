import assert from 'node:assert/strict'
import {
  elideDataUrls,
  extractUsage,
  formatCallCost,
  formatTotalCost,
  looksLikeSse,
  parseJsonProviderResponse,
  parseProviderResponse,
  parseSseProviderResponse,
  renderMessageContent,
} from './src/shared/callHistory.ts'

// --- usage ------------------------------------------------------------------

// OpenAI-shaped and camelCase usage blocks both read.
assert.deepEqual(extractUsage({ prompt_tokens: 120, completion_tokens: 34 }), {
  inputTokens: 120,
  outputTokens: 34,
  costUsd: null,
})
assert.deepEqual(extractUsage({ promptTokens: 5, completionTokens: 6, cost: 0.0012 }), {
  inputTokens: 5,
  outputTokens: 6,
  costUsd: 0.0012,
})

// A missing usage block is unknown, never zero — zero would report a paid call as free.
assert.deepEqual(extractUsage(undefined), { inputTokens: null, outputTokens: null, costUsd: null })
assert.deepEqual(extractUsage({}), { inputTokens: null, outputTokens: null, costUsd: null })
// A zero cost the provider actually reported is kept as zero (free models).
assert.equal(extractUsage({ cost: 0 }).costUsd, 0)

// --- non-streamed responses -------------------------------------------------

const jsonBody = JSON.stringify({
  model: 'openai/gpt-4.1-mini',
  choices: [{ message: { role: 'assistant', content: 'Two sentences of answer.' } }],
  usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.00042 },
})
const json = parseJsonProviderResponse(jsonBody)
assert.equal(json.text, 'Two sentences of answer.')
assert.equal(json.model, 'openai/gpt-4.1-mini')
assert.equal(json.usage.inputTokens, 900)
assert.equal(json.usage.costUsd, 0.00042)
assert.equal(json.error, null)

// A reasoning model that returns no content still has something to show.
assert.equal(
  parseJsonProviderResponse(
    JSON.stringify({ choices: [{ message: { content: '', reasoning: 'thought it through' } }] })
  ).text,
  'thought it through'
)

// Tool calls are named rather than lost.
assert.match(
  parseJsonProviderResponse(
    JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'read_file', arguments: '{"p":"a"}' } }] } }],
    })
  ).text,
  /\[tool call\] read_file\(\{"p":"a"\}\)/
)

// An error payload keeps the message and shows the body rather than an empty cell.
const errored = parseJsonProviderResponse(JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
assert.equal(errored.error, 'Rate limit exceeded')
assert.match(errored.text, /Rate limit exceeded/)

// Non-JSON (an HTML error page from a proxy) survives verbatim instead of throwing.
assert.equal(parseJsonProviderResponse('<html>502</html>').text, '<html>502</html>')

// --- streamed responses -----------------------------------------------------

const sseBody = [
  'data: {"model":"z-ai/glm-4.7","choices":[{"delta":{"content":"Hel"}}]}',
  'data: {"choices":[{"delta":{"content":"lo."}}]}',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"cost":0.00001}}',
  'data: [DONE]',
  '',
].join('\n')

assert.equal(looksLikeSse('text/event-stream', ''), true)
assert.equal(looksLikeSse('application/json', sseBody), true)
assert.equal(looksLikeSse('application/json', jsonBody), false)

const sse = parseSseProviderResponse(sseBody)
// The deltas are replayed into the text the user actually saw.
assert.equal(sse.text, 'Hello.')
assert.equal(sse.model, 'z-ai/glm-4.7')
assert.equal(sse.usage.inputTokens, 7)
assert.equal(sse.usage.outputTokens, 3)
assert.equal(sse.usage.costUsd, 0.00001)

// Malformed frames are skipped, not fatal — a truncated stream still logs.
const partial = parseSseProviderResponse(
  ['data: {"choices":[{"delta":{"content":"half"}}]}', 'data: {"choices":[{"delta":{"cont'].join('\n')
)
assert.equal(partial.text, 'half')

// Reasoning-only streams fall back to the reasoning text.
assert.equal(
  parseSseProviderResponse('data: {"choices":[{"delta":{"reasoning":"weighing options"}}]}').text,
  'weighing options'
)

// Streamed tool calls are named.
assert.match(
  parseSseProviderResponse(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web_search"}}]}}]}'
  ).text,
  /\[tool calls\] web_search/
)

// The dispatcher picks the right parser from the content type.
assert.equal(parseProviderResponse(sseBody, 'text/event-stream').text, 'Hello.')
assert.equal(parseProviderResponse(jsonBody, 'application/json').text, 'Two sentences of answer.')
assert.deepEqual(parseProviderResponse('', 'application/json'), {
  text: '',
  model: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null },
  error: null,
})

// --- inline images ----------------------------------------------------------

// A photo-indexing prompt is mostly base64. The payload is named, not stored.
const image = `data:image/jpeg;base64,${'A'.repeat(4096)}`
const elided = elideDataUrls(`{"url":"${image}"}`)
assert.match(elided, /data:image\/jpeg;base64,\[4 KB elided\]/)
assert.equal(elided.includes('AAAA'), false)
// Short data URLs (an icon, a placeholder) are left alone.
assert.equal(elideDataUrls('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=')

// Vision message parts name their image instead of reproducing it.
const parts = renderMessageContent([
  { type: 'text', text: 'Describe this photo.' },
  { type: 'image_url', image_url: { url: image } },
])
assert.match(parts, /Describe this photo\./)
assert.match(parts, /\[image\/jpeg, \d+ KB inline\]/)
assert.equal(parts.includes('AAAA'), false)
assert.equal(renderMessageContent('plain text'), 'plain text')

// --- money ------------------------------------------------------------------

// A single call costs fractions of a cent; two decimals would read as free.
assert.equal(formatCallCost(0.00042), '$0.0004')
assert.equal(formatCallCost(0), '$0')
assert.equal(formatCallCost(null), '—')
assert.equal(formatCallCost(1.5), '$1.50')
assert.equal(formatTotalCost(0), '$0.00')
assert.equal(formatTotalCost(12.345), '$12.35')

console.log('call history tests passed')
