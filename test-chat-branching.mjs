import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-branch-db-'))
process.env.HOLMES_USER_DATA = dbDir

const {
  initDatabase,
  closeDatabase,
  createConversation,
  addMessage,
  getMessages,
  getMessageById,
  getMessagesUpTo,
  findRetryTargetUserMessage,
  deactivateMessage,
  deactivateChildren,
  setActiveBranch,
} = await import('./src/main/database.ts')

initDatabase()

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ok - ${name}`)
}

const sab = new Int32Array(new SharedArrayBuffer(4))
function tick() {
  Atomics.wait(sab, 0, 0, 2)
}

function say(conversationId, role, content, parentId, extra = {}) {
  tick()
  return addMessage({ conversationId, role, content, parentId, ...extra })
}

console.log('findRetryTargetUserMessage')

const conv = createConversation('test-model')
const u1 = say(conv.id, 'user', 'first question')
const a1 = say(conv.id, 'assistant', 'first answer', u1.id)

check('a user message resolves to itself', () => {
  assert.equal(findRetryTargetUserMessage(u1.id)?.id, u1.id)
})

check('an assistant message resolves to its originating user message', () => {
  const target = findRetryTargetUserMessage(a1.id)
  assert.equal(target?.id, u1.id)
  assert.equal(target?.role, 'user')
  assert.equal(target?.content, 'first question')
})

const toolConv = createConversation('test-model')
const tu = say(toolConv.id, 'user', 'search my files', undefined, {
  attachments: [{ id: 'att-1', kind: 'image', name: 'a.png', mimeType: 'image/png', bytes: 10, dataUrl: 'data:image/png;base64,AA', origin: 'user' }],
})
const ta = say(toolConv.id, 'assistant', '', tu.id, { toolCalls: [{ id: 'c1', name: 'search_files', arguments: '{}' }] })
const tt = say(toolConv.id, 'tool', 'results', ta.id, { toolCallId: 'c1', toolName: 'search_files' })
const tfinal = say(toolConv.id, 'assistant', 'here is what I found', tt.id)

check('an assistant message behind a tool round resolves past tool + assistant links', () => {
  assert.equal(findRetryTargetUserMessage(tfinal.id)?.id, tu.id)
})

check('a tool message resolves to the originating user message', () => {
  assert.equal(findRetryTargetUserMessage(tt.id)?.id, tu.id)
})

check('resolution carries the user message attachments for vision/generation routing', () => {
  const target = findRetryTargetUserMessage(tfinal.id)
  assert.equal(target.attachments?.length, 1)
  assert.equal(target.attachments[0].name, 'a.png')
  assert.equal(target.content, 'search my files')
})

check('an unknown message id is unresolvable', () => {
  assert.equal(findRetryTargetUserMessage('does-not-exist'), null)
})

check('an assistant message with no ancestor user message is unresolvable', () => {
  const orphanConv = createConversation('test-model')
  const orphan = say(orphanConv.id, 'assistant', 'orphaned reply')
  assert.equal(findRetryTargetUserMessage(orphan.id), null)
})

console.log('retry from an assistant message')

deactivateChildren(findRetryTargetUserMessage(a1.id).id)
const a1b = say(conv.id, 'assistant', 'second answer', u1.id)

check('the regenerated reply is a sibling of the old reply, not a child of it', () => {
  assert.equal(getMessageById(a1b.id).parentId, u1.id)
  assert.equal(getMessageById(a1.id).parentId, u1.id)
})

check('the active path shows only the regenerated reply', () => {
  const active = getMessages(conv.id)
  assert.deepEqual(active.map((m) => m.id), [u1.id, a1b.id])
  assert.equal(active[1].content, 'second answer')
})

check('branch navigation sees both replies with the new one selected', () => {
  const active = getMessages(conv.id)
  const reply = active[1]
  assert.equal(reply.siblingCount, 2)
  assert.deepEqual(reply.siblingIds, [a1.id, a1b.id])
  assert.equal(reply.siblingIndex, 1)
  assert.equal(reply.siblingIds[reply.siblingIndex], a1b.id)
})

check('the retry prompt history stops at the user message and excludes the stale reply', () => {
  const history = getMessagesUpTo(conv.id, u1.id)
  assert.deepEqual(history.map((m) => m.id), [u1.id])
  assert.equal(history.every((m) => m.id !== a1.id), true)
})

console.log('branch switching after retry')

check('setActiveBranch restores the original reply', () => {
  setActiveBranch(a1.id)
  const active = getMessages(conv.id)
  assert.deepEqual(active.map((m) => m.id), [u1.id, a1.id])
  assert.equal(active[1].siblingIndex, 0)
  assert.equal(active[1].siblingCount, 2)
})

check('setActiveBranch switches forward again', () => {
  setActiveBranch(a1b.id)
  assert.deepEqual(getMessages(conv.id).map((m) => m.id), [u1.id, a1b.id])
})

console.log('retry from a user message')

deactivateChildren(findRetryTargetUserMessage(u1.id).id)
const a1c = say(conv.id, 'assistant', 'third answer', u1.id)

check('retrying the user message adds a third sibling branch', () => {
  const active = getMessages(conv.id)
  assert.deepEqual(active.map((m) => m.id), [u1.id, a1c.id])
  assert.equal(active[1].siblingCount, 3)
  assert.deepEqual(active[1].siblingIds, [a1.id, a1b.id, a1c.id])
  assert.equal(active[1].siblingIndex, 2)
})

check('no branch is orphaned or duplicated', () => {
  const replies = [a1.id, a1b.id, a1c.id].map((id) => getMessageById(id))
  assert.equal(replies.every((m) => m.parentId === u1.id), true)
  assert.equal(new Set(replies.map((m) => m.id)).size, 3)
})

console.log('retry from a later turn')

const u2 = say(conv.id, 'user', 'follow-up question', a1c.id)
const a2 = say(conv.id, 'assistant', 'follow-up answer', u2.id)

check('retrying a later assistant reply resolves to the later user message', () => {
  assert.equal(findRetryTargetUserMessage(a2.id)?.id, u2.id)
})

check('earlier turns are preserved in the retry prompt history', () => {
  deactivateChildren(u2.id)
  const history = getMessagesUpTo(conv.id, u2.id)
  assert.deepEqual(history.map((m) => m.id), [u1.id, a1c.id, u2.id])
  assert.equal(history.every((m) => m.id !== a2.id), true)
})

console.log('edit branch semantics')

check('editing a user message creates a sibling user branch and keeps the old one reachable', () => {
  const editConv = createConversation('test-model')
  const eu = say(editConv.id, 'user', 'original')
  const ea = say(editConv.id, 'assistant', 'reply to original', eu.id)
  deactivateMessage(eu.id)
  const eu2 = say(editConv.id, 'user', 'edited', undefined)
  const active = getMessages(editConv.id)
  assert.deepEqual(active.map((m) => m.id), [eu2.id])
  assert.equal(active[0].siblingCount, 2)
  assert.deepEqual(active[0].siblingIds, [eu.id, eu2.id])
  setActiveBranch(eu.id)
  assert.deepEqual(getMessages(editConv.id).map((m) => m.id), [eu.id, ea.id])
})

closeDatabase()
fs.rmSync(dbDir, { recursive: true, force: true })

console.log(`\n${passed} checks passed`)
