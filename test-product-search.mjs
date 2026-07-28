import assert from 'node:assert/strict'
import {
  buildProductSearchPrompt,
  parseProductSearchRequest,
  parseProductSearchResponse,
} from './src/main/productSearch.ts'

const request = parseProductSearchRequest({
  query: 'A durable carry-on suitcase',
  priorities: { price: 80, quality: 100, brand: 20, availability: 50 },
  budget: { amount: 300, currency: 'usd' },
  market: 'United States',
  notes: 'Must fit common domestic airline limits',
  model: 'openai/gpt-5-mini',
  reasoningEffort: 'high',
})

assert.deepEqual(request.budget, { amount: 300, currency: 'USD' })
assert.match(buildProductSearchPrompt(request), /Highest quality and reliability/)
assert.match(buildProductSearchPrompt(request), /300 USD/)

assert.throws(() => parseProductSearchRequest({
  ...request,
  priorities: { price: 0, quality: 0, brand: 0, availability: 0 },
}), /Enable at least one product priority/)
assert.throws(() => parseProductSearchRequest({ ...request, unexpected: true }), /unsupported field/)
assert.throws(() => parseProductSearchRequest({ ...request, budget: { amount: -1, currency: 'USD' } }), /Budget amount/)

const structuredContent = {
  summary: 'The Alpha Carry is the strongest balance of durability and price.',
  methodology: 'Compared current manufacturer details, retailer listings, and independent testing.',
  recommendations: [
    {
      rank: 1,
      name: 'Alpha Carry 22',
      brand: 'Alpha',
      model: 'AC22',
      priceDisplay: '$249 USD',
      priceAmount: 249,
      currency: 'usd',
      availability: 'in_stock',
      overallScore: 91,
      scoreBreakdown: { price: 88, quality: 95, brand: 80, availability: 90 },
      bestFor: 'Frequent domestic travel',
      rationale: 'Strong independent durability results at a competitive current price.',
      highlights: ['Replaceable wheels', 'Lifetime shell warranty'],
      tradeoffs: ['Heavier than soft-sided alternatives'],
      sourceUrls: [
        'https://shop.example.com/products/alpha-carry?color=black',
        'https://reviews.example.com/luggage/alpha-carry#testing',
      ],
    },
  ],
  buyingAdvice: ['Confirm airline-specific dimensions before ordering.'],
}

const result = parseProductSearchResponse({
  model: 'openai/gpt-5-mini-2026-06-01',
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify(structuredContent),
        annotations: [
          {
            type: 'url_citation',
            url_citation: {
              url: 'https://shop.example.com/products/alpha-carry?color=black',
              title: 'Alpha Carry 22 product page',
              content: 'Untrusted excerpt is deliberately not returned.',
            },
          },
          {
            type: 'url_citation',
            url_citation: {
              url: 'https://reviews.example.com/luggage/alpha-carry',
              title: 'Alpha Carry durability test',
            },
          },
          {
            type: 'url_citation',
            url_citation: {
              url: 'https://shop.example.com/products/alpha-carry?color=blue',
              title: 'A different product variant',
            },
          },
          {
            type: 'url_citation',
            url_citation: { url: 'javascript:alert(1)', title: 'Unsafe' },
          },
        ],
      },
    },
  ],
  usage: { server_tool_use: { web_search_requests: 3 } },
}, request)

assert.equal(result.model, 'openai/gpt-5-mini-2026-06-01')
assert.equal(result.webSearches, 3)
assert.equal(result.citations.length, 3)
assert.deepEqual(result.recommendations[0].sourceIds, ['source-1', 'source-2'])
assert.equal(result.recommendations[0].currency, 'USD')
assert.equal('content' in result.citations[0], false)

assert.throws(() => parseProductSearchResponse({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structuredContent), annotations: [] } }],
}, request), /no verifiable web sources/)
assert.throws(() => parseProductSearchResponse({
  choices: [{ finish_reason: 'stop', message: { content: 'not json', annotations: [{
    type: 'url_citation',
    url_citation: { url: 'https://example.com', title: 'Example' },
  }] } }],
}, request), /invalid structured data/)
assert.throws(() => parseProductSearchResponse({
  choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({
      ...structuredContent,
      recommendations: [{
        ...structuredContent.recommendations[0],
        sourceUrls: ['https://shop.example.com/products/alpha-carry?id=expected'],
      }],
    }),
    annotations: [{
      type: 'url_citation',
      url_citation: {
        url: 'https://shop.example.com/products/alpha-carry?id=different',
        title: 'Different query-based product',
      },
    }],
  } }],
}, request), /no verifiable web source/)

console.log('Product search validation and response checks passed')
