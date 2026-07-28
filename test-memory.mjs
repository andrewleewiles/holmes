import assert from 'node:assert/strict'
import { MEMORY_CATALOG, MEMORY_FIELDS } from './src/shared/memoryCatalog.ts'
import {
  buildMemoryExtractionPrompt,
  buildMemoryExtractionResponseSchema,
  parseMemoryExtractionRequest,
  parseMemoryExtractionResponse,
  parseMemoryProviderResponse,
  parseMemoryUpdateRequest,
  redactMemoryContent,
  validateMemoryValue,
} from './src/main/memory.ts'
import { appleDateToUnix } from './src/main/imessage.ts'

assert.ok(MEMORY_CATALOG.length >= 15)
assert.ok(MEMORY_FIELDS.length >= 120)
assert.equal(new Set(MEMORY_FIELDS.map((field) => field.key)).size, MEMORY_FIELDS.length)

const request = parseMemoryExtractionRequest({
  categories: ['identity', 'health', 'work', 'pets'],
  includeConversations: true,
  includeProjects: true,
  includeRecallFiles: false,
  includeIMessages: false,
  includeSettings: true,
  includeSensitive: false,
  confirmExternalProcessing: true,
})
assert.deepEqual(request.categories, ['identity', 'health', 'work', 'pets'])
assert.throws(() => parseMemoryExtractionRequest({ ...request, confirmExternalProcessing: false }), /Confirm external processing/)
assert.throws(() => parseMemoryExtractionRequest({ ...request, categories: ['unknown'] }), /category is invalid/)

assert.deepEqual(validateMemoryValue(['Dog', 'Dog', 'Cat'], 'list'), ['Dog', 'Cat'])
assert.equal(validateMemoryValue('2026-07-16', 'date'), '2026-07-16')
assert.throws(() => validateMemoryValue('July 16', 'date'), /YYYY-MM-DD/)
assert.throws(() => validateMemoryValue('2026-02-31', 'date'), /valid calendar date/)
assert.throws(() => validateMemoryValue(Number.NaN, 'number'), /finite number/)

const redacted = redactMemoryContent([
  'api_key=sk-1234567890abcdef',
  'password: hunter2',
  'password="correct horse battery staple"',
  'AWS_SECRET_ACCESS_KEY=very secret cloud credential',
  'Authorization: Bearer abcdefghijklmnop',
  'Card 4111 1111 1111 1111',
  'SSN 123-45-6789',
].join('\n'))
assert.doesNotMatch(redacted, /1234567890abcdef|hunter2|correct horse|secret cloud|abcdefghijklmnop|4111|123-45-6789/)

const appleSeconds = 790_000_000
assert.equal(appleDateToUnix(appleSeconds), appleDateToUnix(appleSeconds * 1_000_000_000))

const fields = [
  {
    id: 'preferred_name',
    fieldKey: 'preferred_name',
    category: 'identity',
    label: 'Preferred name',
    valueType: 'text',
    value: null,
    origin: null,
    confidence: null,
    locked: false,
    sensitive: false,
    custom: false,
    sortOrder: 1,
    sources: [],
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'pets',
    fieldKey: 'pets',
    category: 'pets',
    label: 'Pets',
    valueType: 'list',
    value: null,
    origin: null,
    confidence: null,
    locked: false,
    sensitive: false,
    custom: false,
    sortOrder: 2,
    sources: [],
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  },
]
const sources = [
  {
    id: 'source-1',
    type: 'conversation',
    reference: 'message-1',
    label: 'Your message in Introductions',
    content: 'Please call me Sam. I have a dog named Pixel.',
    capturedAt: 1,
  },
]

const prompt = buildMemoryExtractionPrompt(fields, sources)
assert.match(prompt.system, /Do not guess/)
assert.match(prompt.user, /source-1/)
assert.match(prompt.user, /Please call me Sam/)
const redactedPrompt = buildMemoryExtractionPrompt(fields, [{
  ...sources[0],
  label: 'Project password="label secret phrase"',
  content: 'AWS_SECRET_ACCESS_KEY=content secret phrase',
}])
assert.doesNotMatch(redactedPrompt.user, /label secret|content secret/)
const responseSchema = buildMemoryExtractionResponseSchema(fields, sources)
assert.match(JSON.stringify(responseSchema), /preferred_name/)
assert.match(JSON.stringify(responseSchema), /source-1/)

const candidates = parseMemoryExtractionResponse(JSON.stringify({
  candidates: [
    {
      fieldKey: 'preferred_name',
      value: 'Sam',
      confidence: 0.98,
      rationale: 'Direct first-person request.',
      sourceIds: ['source-1'],
    },
    {
      fieldKey: 'pets',
      value: ['Pixel, dog'],
      confidence: 0.95,
      rationale: 'Direct first-person statement.',
      sourceIds: ['source-1'],
    },
    {
      fieldKey: 'unknown_field',
      value: 'ignored',
      confidence: 1,
      rationale: 'Unknown field.',
      sourceIds: ['source-1'],
    },
  ],
}), fields, sources)
assert.equal(candidates.length, 2)
assert.equal(candidates[0].sources[0].reference, 'message-1')

const providerResult = parseMemoryProviderResponse({
  model: 'routed-model',
  choices: [{
    finish_reason: 'stop',
    message: {
      content: [{ type: 'text', text: JSON.stringify({ candidates: [{
        fieldKey: 'preferred_name',
        value: 'Sam',
        confidence: 0.98,
        rationale: 'Direct first-person request.',
        sourceIds: ['source-1'],
      }] }) }],
    },
  }],
}, fields, sources, 'requested-model')
assert.equal(providerResult.model, 'routed-model')
assert.equal(providerResult.candidates[0].value, 'Sam')
assert.deepEqual(parseMemoryProviderResponse({
  choices: [{ finish_reason: 'stop', message: { content: '{"candidates":[]}' } }],
}, fields, sources, 'requested-model').candidates, [])
assert.throws(() => parseMemoryProviderResponse({
  choices: [{ finish_reason: 'length', message: { content: null } }],
}, fields, sources, 'requested-model'), /output budget/)

const invalidCitationCandidates = parseMemoryExtractionResponse(JSON.stringify({
  candidates: [{
    fieldKey: 'preferred_name',
    value: 'Sam',
    confidence: 0.98,
    rationale: 'Includes a fabricated source ID.',
    sourceIds: ['source-1', 'invented-source'],
  }],
}), fields, sources)
assert.deepEqual(invalidCitationCandidates, [])

const conflictCandidates = parseMemoryExtractionResponse(JSON.stringify({
  candidates: [
    { fieldKey: 'preferred_name', value: 'Sam', confidence: 0.9, rationale: 'First value.', sourceIds: ['source-1'] },
    { fieldKey: 'preferred_name', value: 'Samuel', confidence: 0.9, rationale: 'Conflicting value.', sourceIds: ['source-1'] },
  ],
}), fields, sources)
assert.deepEqual(conflictCandidates, [])

assert.deepEqual(parseMemoryUpdateRequest({
  fieldId: 'pets',
  value: ['Pixel'],
  locked: true,
  expectedRevision: 0,
}, fields).value, ['Pixel'])
assert.throws(() => parseMemoryUpdateRequest({
  fieldId: 'pets',
  value: 'Pixel',
  locked: false,
  expectedRevision: 0,
}, fields), /Memory list is invalid/)

console.log('Memory catalog, validation, and extraction checks passed')
