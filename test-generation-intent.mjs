import assert from 'node:assert/strict'
import { detectGenerationIntent } from './src/main/generationIntent.ts'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  classifyAttachment,
  parseAttachments,
} from './src/shared/attachments.ts'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  }
}

function expectKind(text, kind) {
  check(`${kind.toUpperCase()} <- ${JSON.stringify(text)}`, () => {
    const result = detectGenerationIntent(text)
    assert.notEqual(result, null, 'expected an intent, got null')
    assert.equal(result.kind, kind)
    assert.equal(result.prompt, text.replace(/\s+/g, ' ').trim())
  })
}

function expectNone(text) {
  check(`NONE <- ${JSON.stringify(text)}`, () => {
    const result = detectGenerationIntent(text)
    assert.equal(result, null, `expected null, got ${JSON.stringify(result)}`)
  })
}

console.log('\nImage generation intents')
expectKind('generate an image of a cat wearing a top hat', 'image')
expectKind('Can you generate a photo of a sunset over the ocean?', 'image')
expectKind('please make me a picture of a dragon', 'image')
expectKind('draw a sketch of my house', 'image')
expectKind('I want you to create an illustration of a robot gardener', 'image')
expectKind("I'd like you to design a logo for my coffee shop", 'image')
expectKind('hey holmes, render a wallpaper of a misty forest', 'image')
expectKind("let's make a poster with bold typography", 'image')
expectKind('paint a portrait of my dog', 'image')
expectKind('generate two images of vintage cars', 'image')
expectKind('just generate an image', 'image')
expectKind('go ahead and create a detailed painting of a storm', 'image')
expectKind('write a haiku and then make a picture of it', 'image')

console.log('\nVideo generation intents')
expectKind('generate a video of a cat playing piano', 'video')
expectKind('make me a short clip of waves crashing on rocks', 'video')
expectKind('create an animation of a rocket launch', 'video')
expectKind('could you produce a film about deep sea life', 'video')
expectKind('animate a gif of a spinning globe', 'video')

console.log('\nEarliest match wins (video before image)')
check('video wins when it comes first', () => {
  const result = detectGenerationIntent('make a video of a painting being restored')
  assert.notEqual(result, null)
  assert.equal(result.kind, 'video')
})

console.log('\nNon-intents (must not hijack a normal chat turn)')
expectNone('')
expectNone('   ')
expectNone('how do I generate an image with stable diffusion?')
expectNone("what's the best model to generate images with?")
expectNone('which image generator should I use')
expectNone('do you generate images?')
expectNone('I already generated an image yesterday')
expectNone('she drew a picture of her family')
expectNone("don't make a picture, just describe the scene")
expectNone('write code to generate an image thumbnail')
expectNone('can you make a video call with me')
expectNone('make a picture frame out of reclaimed wood')
expectNone('create a photo album for the wedding')
expectNone('summarize this article about AI image generation')
expectNone('make a plan for the trip')
expectNone('create a table of the quarterly results')
expectNone('the photo I sent earlier looks great')
expectNone('tell me about the painting in the Louvre')
expectNone('generate a react component that renders an image')
expectNone('```\ngenerate an image of a cat\n```')
expectNone('design a video game level with three rooms')
expectNone('I asked my friend to make a picture of a cat')

console.log('\nGuards')
check('rejects oversized input', () => {
  const long = 'generate an image of a cat ' + 'x'.repeat(2000)
  assert.equal(detectGenerationIntent(long), null)
})
check('rejects non-string input', () => {
  assert.equal(detectGenerationIntent(null), null)
  assert.equal(detectGenerationIntent(undefined), null)
  assert.equal(detectGenerationIntent(42), null)
})
check('reports the matched span', () => {
  const result = detectGenerationIntent('please make me a picture of a dragon')
  assert.equal(result.matched, 'make me a picture')
})

console.log('\nAttachment allowlist')
check('accepts allowed image extensions', () => {
  assert.deepEqual(classifyAttachment('cat.PNG'), { kind: 'image', mimeType: 'image/png' })
  assert.deepEqual(classifyAttachment('shot.jpeg'), { kind: 'image', mimeType: 'image/jpeg' })
  assert.deepEqual(classifyAttachment('live.heic'), { kind: 'image', mimeType: 'image/heic' })
})
check('accepts allowed video extensions', () => {
  assert.deepEqual(classifyAttachment('clip.mp4'), { kind: 'video', mimeType: 'video/mp4' })
  assert.deepEqual(classifyAttachment('clip.MOV'), { kind: 'video', mimeType: 'video/quicktime' })
})
check('rejects everything else', () => {
  for (const name of ['notes.pdf', 'run.sh', 'archive.zip', 'icon.svg', 'noextension', 'payload.png.exe']) {
    assert.equal(classifyAttachment(name), null, `expected ${name} to be rejected`)
  }
})

function attachment(overrides = {}) {
  return {
    id: 'a1',
    kind: 'image',
    name: 'cat.png',
    mimeType: 'image/png',
    bytes: 1024,
    dataUrl: 'data:image/png;base64,AAAA',
    origin: 'user',
    ...overrides,
  }
}

console.log('\nAttachment validation')
check('accepts a well-formed attachment', () => {
  assert.equal(parseAttachments([attachment()]).length, 1)
})
check('drops malformed attachments', () => {
  assert.equal(parseAttachments([attachment({ dataUrl: 'https://evil.example/x.png' })]).length, 0)
  assert.equal(parseAttachments([attachment({ kind: 'audio' })]).length, 0)
  assert.equal(parseAttachments([attachment({ origin: 'system' })]).length, 0)
  assert.equal(parseAttachments([attachment({ bytes: -1 })]).length, 0)
  assert.equal(parseAttachments([attachment({ id: '' })]).length, 0)
  assert.equal(parseAttachments(['nope']).length, 0)
  assert.equal(parseAttachments(null).length, 0)
})
check('enforces the size cap', () => {
  assert.equal(parseAttachments([attachment({ bytes: MAX_ATTACHMENT_BYTES })]).length, 1)
  assert.equal(parseAttachments([attachment({ bytes: MAX_ATTACHMENT_BYTES + 1 })]).length, 0)
})
check('enforces the per-message count cap', () => {
  const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 4 }, (_, i) => attachment({ id: `a${i}` }))
  assert.equal(parseAttachments(many).length, MAX_ATTACHMENTS_PER_MESSAGE)
})
check('strips unknown fields', () => {
  const [parsed] = parseAttachments([attachment({ evil: 'payload' })])
  assert.deepEqual(Object.keys(parsed).sort(), ['bytes', 'dataUrl', 'id', 'kind', 'mimeType', 'name', 'origin'])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
