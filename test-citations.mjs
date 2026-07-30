import assert from 'node:assert/strict'

import {
  citableHost,
  createTurnCitations,
  isOpenableSourcePath,
  rememberOpenableSourcePaths,
} from './src/main/citations.ts'
import {
  hasSourceMarker,
  rehypeSourcePills,
  stripTrailingPartialMarker,
} from './src/renderer/components/sourceMarkers.ts'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

function toolResult(name, payload, extra = {}) {
  return {
    callId: 'call-1',
    name,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...extra,
  }
}

function webSearch(results) {
  return toolResult('web_search', { query: 'q', results })
}

console.log('citations: minting ids from tool results')

check('web_search results are numbered from S1 and carry their id inline', () => {
  const citations = createTurnCitations()
  const content = citations.annotate(webSearch([
    { title: 'Refund policy', url: 'https://www.example.com/refunds', snippet: '30 days' },
    { title: 'Shipping', url: 'https://help.other.org/shipping', snippet: 'free' },
  ]))

  const payload = JSON.parse(content)
  assert.deepEqual(payload.results.map((r) => r.cite), ['S1', 'S2'])

  const sources = citations.list()
  assert.equal(sources.length, 2)
  // The label is what the pill shows, so it is the bare host: no scheme, no www.
  assert.equal(sources[0].label, 'example.com')
  assert.equal(sources[0].kind, 'web')
  assert.equal(sources[0].title, 'Refund policy')
  assert.equal(sources[0].url, 'https://www.example.com/refunds')
  assert.equal(sources[1].label, 'help.other.org')
})

check('a result with no usable URL is left uncited rather than numbered', () => {
  const citations = createTurnCitations()
  const content = citations.annotate(webSearch([
    { title: 'Local', url: 'file:///etc/passwd' },
    { title: 'Script', url: 'javascript:alert(1)' },
    { title: 'Real', url: 'https://example.com/a' },
  ]))

  const payload = JSON.parse(content)
  assert.equal(payload.results[0].cite, undefined)
  assert.equal(payload.results[1].cite, undefined)
  assert.equal(payload.results[2].cite, 'S1')
  assert.equal(citations.list().length, 1)
})

check('the same URL cited in a later round keeps its first number', () => {
  const citations = createTurnCitations()
  citations.annotate(webSearch([{ title: 'A', url: 'https://example.com/a' }]))
  const second = JSON.parse(citations.annotate(webSearch([
    { title: 'B', url: 'https://example.com/b' },
    { title: 'A again', url: 'https://example.com/a' },
  ])))

  assert.equal(second.results[0].cite, 'S2')
  assert.equal(second.results[1].cite, 'S1')
  // Re-citing must not mint a duplicate: the turn read two pages, not three.
  assert.equal(citations.list().length, 2)
})

check('search_files results become file sources labelled by basename', () => {
  const citations = createTurnCitations()
  const content = citations.annotate(toolResult('search_files', {
    results: [
      { title: 'Q3 notes', path: '/Users/test/Documents/q3-notes.md' },
      { title: 'Relative', path: 'not/absolute.md' },
    ],
  }))

  const payload = JSON.parse(content)
  assert.equal(payload.results[0].cite, 'S1')
  // A relative path cannot be opened or verified, so it is never a source.
  assert.equal(payload.results[1].cite, undefined)

  const [source] = citations.list()
  assert.equal(source.kind, 'file')
  assert.equal(source.label, 'q3-notes.md')
  assert.equal(source.path, '/Users/test/Documents/q3-notes.md')
})

check('read_file cites the one file it read, on the payload itself', () => {
  const citations = createTurnCitations()
  const payload = JSON.parse(citations.annotate(toolResult('read_file', {
    path: '/Users/test/budget.csv',
    content: 'a,b,c',
  })))

  assert.equal(payload.cite, 'S1')
  assert.equal(citations.list()[0].label, 'budget.csv')
})

check('numbering is per turn, not per tool', () => {
  const citations = createTurnCitations()
  citations.annotate(webSearch([{ title: 'A', url: 'https://example.com/a' }]))
  const files = JSON.parse(citations.annotate(toolResult('search_files', {
    results: [{ title: 'Notes', path: '/Users/test/notes.md' }],
  })))

  assert.equal(files.results[0].cite, 'S2')
  assert.deepEqual(citations.list().map((s) => s.id), ['S1', 'S2'])
})

check('a failed tool result is passed through untouched', () => {
  const citations = createTurnCitations()
  const original = toolResult('web_search', { results: [{ title: 'A', url: 'https://example.com/a' }] }, { error: true })
  assert.equal(citations.annotate(original), original.content)
  assert.equal(citations.list().length, 0)
})

check('tools that act on the workspace cite nothing', () => {
  const citations = createTurnCitations()
  for (const name of ['work_apply_outline', 'design_paste_svg', 'list_directory', 'get_file_info']) {
    const result = toolResult(name, { path: '/Users/test/thing', results: [{ path: '/Users/test/x.md' }] })
    assert.equal(citations.annotate(result), result.content)
  }
  assert.equal(citations.list().length, 0)
})

check('content that is not JSON survives verbatim', () => {
  const citations = createTurnCitations()
  const result = toolResult('web_search', 'Web search is disabled.')
  assert.equal(citations.annotate(result), 'Web search is disabled.')
  assert.equal(citations.list().length, 0)
})

check('a result with nothing citable is not re-serialized', () => {
  const citations = createTurnCitations()
  // Byte-for-byte identity matters: an untouched result should not silently
  // change shape (key order, whitespace) on its way to the model.
  const result = toolResult('web_search', '{"results": [],  "notice": "none"}')
  assert.equal(citations.annotate(result), '{"results": [],  "notice": "none"}')
})

check('one turn cannot mint unbounded sources', () => {
  const citations = createTurnCitations()
  const many = Array.from({ length: 400 }, (_, i) => ({ title: `T${i}`, url: `https://example.com/${i}` }))
  const payload = JSON.parse(citations.annotate(webSearch(many)))

  const sources = citations.list()
  assert.ok(sources.length < many.length, 'expected the turn to stop numbering somewhere')
  // Whatever the cap is, the annotation and the list must agree on it exactly.
  assert.equal(payload.results.filter((r) => r.cite).length, sources.length)
  assert.deepEqual(
    sources.map((s) => s.id),
    sources.map((_, i) => `S${i + 1}`),
  )
})

console.log('citations: numbering is stable across a conversation')

check('a later turn numbers on from what earlier turns already read', () => {
  const first = createTurnCitations()
  first.annotate(webSearch([
    { title: 'A', url: 'https://example.com/a' },
    { title: 'B', url: 'https://example.com/b' },
  ]))

  const second = createTurnCitations(first.list())
  const payload = JSON.parse(second.annotate(webSearch([{ title: 'C', url: 'https://example.com/c' }])))

  // Not S1: that number already means example.com/a to this conversation, and
  // the model can still see the old tool result that told it so.
  assert.equal(payload.results[0].cite, 'S3')
  assert.deepEqual(second.list().map((s) => s.id), ['S1', 'S2', 'S3'])
})

check('re-reading an earlier page in a later turn reuses its original id', () => {
  const first = createTurnCitations()
  first.annotate(webSearch([{ title: 'A', url: 'https://example.com/a' }]))

  const second = createTurnCitations(first.list())
  const payload = JSON.parse(second.annotate(webSearch([{ title: 'A again', url: 'https://example.com/a' }])))

  assert.equal(payload.results[0].cite, 'S1')
  assert.equal(second.list().length, 1)
})

check('seeded sources are carried forward even when the turn reads nothing', () => {
  const first = createTurnCitations()
  first.annotate(webSearch([{ title: 'A', url: 'https://example.com/a' }]))
  // A follow-up question answered from history alone must still be able to
  // resolve the id it cites.
  assert.deepEqual(createTurnCitations(first.list()).list(), first.list())
})

check('a gap in the seeded ids does not cause a collision', () => {
  const seeded = [
    { id: 'S1', kind: 'web', label: 'a.com', title: 'A', url: 'https://a.com/', tool: 'web_search' },
    { id: 'S7', kind: 'web', label: 'b.com', title: 'B', url: 'https://b.com/', tool: 'web_search' },
  ]
  const citations = createTurnCitations(seeded)
  const payload = JSON.parse(citations.annotate(webSearch([{ title: 'C', url: 'https://c.com/' }])))
  assert.equal(payload.results[0].cite, 'S8')
})

check('duplicate or malformed seed entries are ignored rather than shadowing', () => {
  const seeded = [
    { id: 'S1', kind: 'web', label: 'a.com', title: 'A', url: 'https://a.com/', tool: 'web_search' },
    { id: 'S2', kind: 'web', label: 'a.com', title: 'A copy', url: 'https://a.com/', tool: 'web_search' },
    { id: 'S3', kind: 'web', label: 'no target', title: 'X', tool: 'web_search' },
  ]
  const citations = createTurnCitations(seeded)
  assert.deepEqual(citations.list().map((s) => s.id), ['S1'])

  // S1 still means a.com, and the next mint cannot land on a seeded id.
  const payload = JSON.parse(citations.annotate(webSearch([
    { title: 'A', url: 'https://a.com/' },
    { title: 'D', url: 'https://d.com/' },
  ])))
  assert.equal(payload.results[0].cite, 'S1')
  assert.equal(payload.results[1].cite, 'S4')
})

check('citableHost accepts only web URLs, and strips www', () => {
  assert.equal(citableHost('https://www.nytimes.com/x'), 'nytimes.com')
  assert.equal(citableHost('http://localhost:3000/a'), 'localhost')
  assert.equal(citableHost('mailto:a@b.com'), null)
  assert.equal(citableHost('/Users/test/a.md'), null)
  assert.equal(citableHost(''), null)
  assert.equal(citableHost(undefined), null)
})

console.log('citations: which files a pill may open')

check('only paths Holmes recorded as a source are openable', () => {
  const cited = '/Users/test/Documents/cited-source.md'
  assert.equal(isOpenableSourcePath(cited), false)

  rememberOpenableSourcePaths([{ id: 'S1', kind: 'file', label: 'a', title: 'a', path: cited, tool: 'search_files' }])
  assert.equal(isOpenableSourcePath(cited), true)

  // Never anything the renderer could simply name.
  assert.equal(isOpenableSourcePath('/etc/passwd'), false)
  assert.equal(isOpenableSourcePath('relative.md'), false)
  assert.equal(isOpenableSourcePath(undefined), false)
  assert.equal(isOpenableSourcePath(null), false)
})

check('a web source contributes no openable path', () => {
  rememberOpenableSourcePaths([
    { id: 'S1', kind: 'web', label: 'example.com', title: 'A', url: 'https://example.com/a', tool: 'web_search' },
  ])
  assert.equal(isOpenableSourcePath('https://example.com/a'), false)
})

console.log('citations: rendering markers as pills')

const SOURCES = [
  { id: 'S1', kind: 'web', label: 'example.com', title: 'A', url: 'https://example.com/a', tool: 'web_search' },
  { id: 'S2', kind: 'file', label: 'notes.md', title: 'Notes', path: '/Users/test/notes.md', tool: 'search_files' },
]

function render(tree, sources = SOURCES) {
  rehypeSourcePills(sources)()(tree)
  return tree
}

function paragraph(text) {
  return {
    type: 'root',
    children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: text }] }],
  }
}

function pillsOf(tree) {
  const found = []
  const walk = (node) => {
    if (node.type === 'element' && node.properties?.['data-source-id']) found.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return found
}

check('a marker becomes a pill and the prose around it is preserved', () => {
  const tree = render(paragraph('The window is 30 days [S1] from delivery.'))
  const children = tree.children[0].children

  assert.deepEqual(children.map((c) => c.type), ['text', 'element', 'text'])
  assert.equal(children[0].value, 'The window is 30 days ')
  assert.equal(children[1].tagName, 'a')
  assert.equal(children[1].properties['data-source-id'], 'S1')
  assert.equal(children[1].children[0].value, 'example.com')
  assert.equal(children[2].value, ' from delivery.')
})

check('adjacent markers become separate pills', () => {
  const tree = render(paragraph('Both agree [S1][S2].'))
  assert.deepEqual(pillsOf(tree).map((p) => p.properties['data-source-id']), ['S1', 'S2'])
})

check('a marker naming a source the turn never read is dropped, not shown', () => {
  // The whole point of minting ids in main: an id that resolves to nothing was
  // invented, and printing a raw "[S9]" would dress a fabrication as a citation.
  const tree = render(paragraph('Sales tripled [S9] last quarter.'))
  assert.equal(pillsOf(tree).length, 0)

  const text = tree.children[0].children.map((c) => c.value).join('')
  assert.equal(text, 'Sales tripled last quarter.')
  assert.ok(!text.includes('S9'))
})

check('dropping a marker closes the gap it leaves behind', () => {
  const cases = [
    ['Confirmed [S9].', 'Confirmed.'],
    ['Confirmed [S9] again.', 'Confirmed again.'],
    ['[S9] opened the quarter.', 'opened the quarter.'],
    ['Two bad ones [S8][S9] here.', 'Two bad ones here.'],
  ]
  for (const [input, expected] of cases) {
    const tree = render(paragraph(input))
    const text = tree.children[0].children.map((c) => c.value ?? '').join('')
    assert.equal(text, expected, `for "${input}"`)
  }
})

check('a real pill keeps the spacing around it', () => {
  const tree = render(paragraph('The window is 30 days [S1], from delivery.'))
  const children = tree.children[0].children
  assert.equal(children[0].value, 'The window is 30 days ')
  assert.equal(children[2].value, ', from delivery.')
})

check('markers inside code are left alone', () => {
  const tree = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'pre',
      properties: {},
      children: [{
        type: 'element',
        tagName: 'code',
        properties: {},
        children: [{ type: 'text', value: 'const a = arr[S1]' }],
      }],
    }],
  }
  render(tree)
  assert.equal(pillsOf(tree).length, 0)
  assert.equal(tree.children[0].children[0].children[0].value, 'const a = arr[S1]')
})

check('markers are found inside nested markup', () => {
  const tree = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'ul',
      properties: {},
      children: [{
        type: 'element',
        tagName: 'li',
        properties: {},
        children: [{
          type: 'element',
          tagName: 'strong',
          properties: {},
          children: [{ type: 'text', value: 'Confirmed [S2]' }],
        }],
      }],
    }],
  }
  render(tree)
  assert.deepEqual(pillsOf(tree).map((p) => p.properties['data-source-id']), ['S2'])
})

check('a tree with no markers is untouched', () => {
  const tree = paragraph('Nothing to cite here.')
  const before = tree.children[0].children
  render(tree)
  assert.equal(tree.children[0].children, before)
})

check('half-typed markers stay hidden while a response streams', () => {
  assert.equal(stripTrailingPartialMarker('The window is 30 days [S'), 'The window is 30 days ')
  assert.equal(stripTrailingPartialMarker('The window is 30 days [S1'), 'The window is 30 days ')
  // A completed marker is the renderer's job, not something to strip.
  assert.equal(stripTrailingPartialMarker('The window is 30 days [S1]'), 'The window is 30 days [S1]')
  // A bracket the author actually wrote is left alone.
  assert.equal(stripTrailingPartialMarker('an array literal ['), 'an array literal [')
  assert.equal(stripTrailingPartialMarker('mid [S1] sentence'), 'mid [S1] sentence')
})

check('hasSourceMarker detects only complete markers', () => {
  assert.equal(hasSourceMarker('a [S1] b'), true)
  assert.equal(hasSourceMarker('a [S b'), false)
  assert.equal(hasSourceMarker('a [1] b'), false)
})

console.log(`\ncitations: ${checks} checks passed`)
