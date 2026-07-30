import assert from 'node:assert/strict'

import {
  groupTurns,
  streamingSegments,
  toolStepsFromInteractions,
} from './src/renderer/components/turnGrouping.ts'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

let clock = 1_000
function msg(role, content, extra = {}) {
  clock += 1
  return { id: `m${clock}`, conversationId: 'c1', role, content, createdAt: clock, ...extra }
}

const CALL = { id: 'call-1', name: 'web_search', arguments: '{"query":"gatsby"}' }

console.log('turns: grouping the transcript')

check('a user message is its own turn', () => {
  const user = msg('user', 'hello')
  const turns = groupTurns([user])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].kind, 'user')
  assert.equal(turns[0].message.id, user.id)
  assert.equal(turns[0].key, user.id)
})

check('a plain reply is one turn with one segment and no steps', () => {
  const turns = groupTurns([msg('user', 'hi'), msg('assistant', 'hello there', { model: 'glm' })])
  assert.equal(turns.length, 2)
  const reply = turns[1]
  assert.equal(reply.kind, 'assistant')
  assert.equal(reply.segments.length, 1)
  assert.equal(reply.segments[0].content, 'hello there')
  assert.deepEqual(reply.segments[0].steps, [])
  assert.equal(reply.model, 'glm')
})

check('a tool-using reply is ONE turn, with the result folded into its call', () => {
  // This is the whole point: three stored rows, one reply on screen.
  const user = msg('user', 'is gatsby public domain?')
  const asked = msg('assistant', '', { toolCalls: [CALL] })
  const result = msg('tool', '{"results":[]}', { toolCallId: 'call-1', toolName: 'web_search' })
  const answered = msg('assistant', 'Yes, since 2021.', { model: 'glm' })

  const turns = groupTurns([user, asked, result, answered])
  assert.equal(turns.length, 2, 'expected one user turn and one assistant turn')

  const reply = turns[1]
  assert.equal(reply.kind, 'assistant')
  // Two segments: the row that called the tool, then the row that answered.
  assert.equal(reply.segments.length, 2)
  assert.equal(reply.segments[0].steps.length, 1)
  assert.equal(reply.segments[0].steps[0].name, 'web_search')
  assert.equal(reply.segments[0].steps[0].result, '{"results":[]}')
  assert.equal(reply.segments[0].steps[0].status, 'done')
  assert.equal(reply.segments[1].content, 'Yes, since 2021.')
  assert.deepEqual(reply.segments[1].steps, [])
})

check('a failed tool result renders as failed, not as done', () => {
  const turns = groupTurns([
    msg('user', 'q'),
    msg('assistant', '', { toolCalls: [CALL] }),
    msg('tool', 'network unreachable', { toolCallId: 'call-1', toolName: 'web_search', toolError: true }),
    msg('assistant', 'I could not check.'),
  ])
  assert.equal(turns[1].segments[0].steps[0].status, 'error')
})

check('a stored call whose result never landed reads as interrupted, never as running', () => {
  // A spinner here would wait forever on a result that is not coming.
  const turns = groupTurns([
    msg('user', 'q'),
    msg('assistant', '', { toolCalls: [CALL] }),
  ])
  assert.equal(turns[1].segments[0].steps[0].status, 'interrupted')
})

check('prose the model wrote before a tool call keeps its place', () => {
  const turns = groupTurns([
    msg('user', 'q'),
    msg('assistant', 'Let me look that up.', { toolCalls: [CALL] }),
    msg('tool', '{}', { toolCallId: 'call-1', toolName: 'web_search' }),
    msg('assistant', 'Here is the answer.'),
  ])
  const reply = turns[1]
  assert.equal(reply.segments.length, 2)
  // Segment one carries BOTH the sentence and the call it preceded.
  assert.equal(reply.segments[0].content, 'Let me look that up.')
  assert.equal(reply.segments[0].steps.length, 1)
  assert.equal(reply.segments[1].content, 'Here is the answer.')
})

check('the turn shows one combined thinking block, not one per row', () => {
  const turns = groupTurns([
    msg('user', 'q'),
    msg('assistant', '', { toolCalls: [CALL], reasoning: 'first I should search' }),
    msg('tool', '{}', { toolCallId: 'call-1', toolName: 'web_search' }),
    msg('assistant', 'answer', { reasoning: 'the results say 2021' }),
  ])
  assert.equal(turns[1].reasoning, 'first I should search\n\nthe results say 2021')
})

check('a row with only thinking contributes no empty segment', () => {
  const turns = groupTurns([
    msg('user', 'q'),
    msg('assistant', '', { reasoning: 'hmm' }),
  ])
  assert.equal(turns[1].segments.length, 0)
  assert.equal(turns[1].reasoning, 'hmm')
})

check('branch navigation anchors on the first row, metadata on the last', () => {
  const asked = msg('assistant', '', { toolCalls: [CALL], siblingCount: 2, siblingIndex: 1, siblingIds: ['x', 'y'] })
  const result = msg('tool', '{}', { toolCallId: 'call-1', toolName: 'web_search' })
  const answered = msg('assistant', 'done', { model: 'glm-late' })
  const turns = groupTurns([msg('user', 'q'), asked, result, answered])
  const reply = turns[1]

  // Retry regenerates the whole answer, so it must fire at the row hanging off the
  // question — the later rows are its descendants, not its siblings.
  assert.equal(reply.branchMessage.id, asked.id)
  assert.equal(reply.branchMessage.siblingCount, 2)
  assert.equal(reply.key, asked.id)
  // The timestamp and model shown are the answer's, not the tool call's.
  assert.equal(reply.model, 'glm-late')
  assert.equal(reply.createdAt, answered.createdAt)
})

check('copy takes everything the assistant said in the turn', () => {
  const turns = groupTurns([
    msg('user', 'q'),
    msg('assistant', 'Looking it up.', { toolCalls: [CALL] }),
    msg('tool', '{}', { toolCallId: 'call-1', toolName: 'web_search' }),
    msg('assistant', 'The answer is 1925.'),
  ])
  assert.equal(turns[1].copyText, 'Looking it up.\n\nThe answer is 1925.')
})

check('sources ride along on the segment that cited them', () => {
  const sources = [{ id: 'S1', kind: 'web', label: 'a.com', title: 'A', url: 'https://a.com/', tool: 'web_search' }]
  const turns = groupTurns([msg('user', 'q'), msg('assistant', 'Yes [S1].', { sources })])
  assert.deepEqual(turns[1].segments[0].sources, sources)
})

check('several turns stay separate', () => {
  const turns = groupTurns([
    msg('user', 'one'), msg('assistant', 'first'),
    msg('user', 'two'), msg('assistant', 'second'),
  ])
  assert.deepEqual(turns.map((t) => t.kind), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(turns[3].segments[0].content, 'second')
})

check('an empty transcript groups to nothing', () => {
  assert.deepEqual(groupTurns([]), [])
})

console.log('turns: the live stream')

check('a call is running until its result arrives, then done — in the same row', () => {
  const running = toolStepsFromInteractions([{ type: 'call', toolCall: CALL }])
  assert.equal(running.length, 1)
  assert.equal(running[0].status, 'running')
  assert.equal(running[0].result, undefined)

  const finished = toolStepsFromInteractions([
    { type: 'call', toolCall: CALL },
    { type: 'result', toolResult: { callId: 'call-1', name: 'web_search', content: '{"results":[]}' } },
  ])
  // One row, not two: the call and its result were previously separate blocks.
  assert.equal(finished.length, 1)
  assert.equal(finished[0].status, 'done')
  assert.equal(finished[0].result, '{"results":[]}')
})

check('a streamed error marks the row failed', () => {
  const steps = toolStepsFromInteractions([
    { type: 'call', toolCall: CALL },
    { type: 'result', toolResult: { callId: 'call-1', name: 'web_search', content: 'boom', error: true } },
  ])
  assert.equal(steps[0].status, 'error')
})

check('a result with no announced call still gets a row', () => {
  const steps = toolStepsFromInteractions([
    { type: 'result', toolResult: { callId: 'orphan', name: 'read_file', content: 'x' } },
  ])
  assert.equal(steps.length, 1)
  assert.equal(steps[0].name, 'read_file')
  assert.equal(steps[0].status, 'done')
})

check('two calls keep their own rows and results', () => {
  const second = { id: 'call-2', name: 'read_file', arguments: '{"path":"/a"}' }
  const steps = toolStepsFromInteractions([
    { type: 'call', toolCall: CALL },
    { type: 'call', toolCall: second },
    { type: 'result', toolResult: { callId: 'call-2', name: 'read_file', content: 'second' } },
    { type: 'result', toolResult: { callId: 'call-1', name: 'web_search', content: 'first' } },
  ])
  assert.deepEqual(steps.map((s) => s.id), ['call-1', 'call-2'])
  assert.equal(steps[0].result, 'first')
  assert.equal(steps[1].result, 'second')
})

check('the streaming turn puts its tool rows above the prose', () => {
  const steps = toolStepsFromInteractions([{ type: 'call', toolCall: CALL }])
  const segments = streamingSegments('the answer so far', steps)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].steps.length, 1)
  assert.equal(segments[0].content, '')
  assert.equal(segments[1].content, 'the answer so far')
  assert.deepEqual(segments[1].steps, [])
})

check('a streaming turn with no tools is just its prose', () => {
  const segments = streamingSegments('hello', [])
  assert.equal(segments.length, 1)
  assert.equal(segments[0].content, 'hello')
})

console.log(`\nturns: ${checks} checks passed`)
