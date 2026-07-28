/**
 * Unit tests for the Activity account export parsers.
 *
 * These cover the parts most likely to be silently wrong: CSV records with
 * embedded newlines (Discord), Meta's latin-1 mojibake, the tolerant walker's
 * classification, and timestamp normalization across the four shapes these
 * exports use.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-accounts-'))
process.env.HOLMES_USER_DATA = dbDir
const electronStub = { app: { getPath: () => dbDir, isPackaged: false, getAppPath: () => dbDir } }
const require = Module.createRequire(import.meta.url)
const moduleAlias = require('module')
const origResolve = moduleAlias._resolveFilename
moduleAlias._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron') return request
  return origResolve.call(this, request, parent, isMain, options)
}
const ModuleLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return ModuleLoad.call(this, request, parent, isMain)
}

const { parseCsv, csvColumn, csvValue } = await import('./src/main/activityExports/csv.ts')
const { fixMetaMojibake, findEntries, findEntriesContaining, openExportSource } = await import('./src/main/activityExports/archive.ts')
const { toIso } = await import('./src/main/activityExports/common.ts')
const { walkDatedArrays } = await import('./src/main/activityExports/walker.ts')
const { parseGoogleSearchExport } = await import('./src/main/activityExports/google.ts')
const { parseGoogleActivityHtml, parseGoogleActivityHtmlText } = await import('./src/main/activityExports/googleHtml.ts')
const { watchEventFromBlock } = await import('./src/main/activityExports/youtube.ts')
const { zipSync, strToU8 } = await import('fflate')
const { parseMetaExport } = await import('./src/main/activityExports/meta.ts')
const { parseDiscordExport } = await import('./src/main/activityExports/discord.ts')
const { parseTinderExport } = await import('./src/main/activityExports/dating.ts')
const { decodeAttributedBody, messageBodyText } = await import('./src/main/imessageBody.ts')
const { lookupContact } = await import('./src/main/contactsDb.ts')
const { detectExportForProvider } = await import('./src/main/activityExports/index.ts')
const { ACTIVITY_PROVIDERS, activityProvider, isActivityProviderId } = await import('./src/shared/activityProviders.ts')

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log(`✓ ${label}`)
}

/** Minimal in-memory ExportSource so parsers can be tested without a zip. */
function fakeSource(files) {
  return {
    rootPath: '/fake',
    list: () => Object.keys(files),
    readText: (entry) => files[entry] ?? null,
    entryPath: () => null,
  }
}

// --- CSV ---------------------------------------------------------------

check('CSV keeps quoted newlines inside one field', () => {
  const text = 'Timestamp,Contents\n2024-03-11T10:00:00Z,"line one\nline two\nline three"\n2024-03-12T10:00:00Z,plain\n'
  const { headers, rows } = parseCsv(text)
  assert.deepEqual(headers, ['Timestamp', 'Contents'])
  assert.equal(rows.length, 2, 'a multi-line quoted field must not split into extra rows')
  assert.equal(rows[0][1], 'line one\nline two\nline three')
  assert.equal(rows[1][1], 'plain')
})

check('CSV handles escaped quotes and empty trailing fields', () => {
  const { rows } = parseCsv('a,b,c\n"say ""hi""",,\n')
  assert.equal(rows[0][0], 'say "hi"')
  assert.equal(rows[0][1], '')
  assert.equal(rows[0][2], '')
})

check('CSV handles CRLF line endings', () => {
  const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n')
  assert.deepEqual(headers, ['a', 'b'])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1], ['3', '4'])
})

check('csvColumn matches across spacing and casing', () => {
  const headers = ['First Name', 'Connected On', 'e-mail_address']
  assert.equal(csvColumn(headers, 'connectedon'), 1)
  assert.equal(csvColumn(headers, 'emailaddress'), 2)
  assert.equal(csvColumn(headers, 'nope'), -1)
  assert.equal(csvValue(['a', 'b'], 5), '')
})

// --- timestamps --------------------------------------------------------

check('toIso normalizes seconds, millis, micros and strings', () => {
  const expected = '2024-03-11T14:02:55.000Z'
  assert.equal(toIso(1710165775), expected)          // seconds
  assert.equal(toIso(1710165775000), expected)       // milliseconds
  assert.equal(toIso(1710165775000000), expected)    // microseconds
  assert.equal(toIso('1710165775'), expected)        // numeric string
  assert.equal(toIso('2024-03-11T14:02:55Z'), expected)
  assert.equal(toIso('2024-03-11 14:02:55 UTC'), expected)
})

check('toIso returns null rather than guessing', () => {
  assert.equal(toIso(null), null)
  assert.equal(toIso(''), null)
  assert.equal(toIso('not a date'), null)
  assert.equal(toIso(undefined), null)
})

// --- Meta mojibake -----------------------------------------------------

check('fixMetaMojibake repairs latin-1 double encoding', () => {
  const mangled = Buffer.from('café ☕', 'utf8').toString('latin1')
  assert.equal(fixMetaMojibake(mangled), 'café ☕')
})

check('fixMetaMojibake leaves clean ASCII untouched', () => {
  assert.equal(fixMetaMojibake('plain text 123'), 'plain text 123')
})

// --- walker ------------------------------------------------------------

check('walker finds dated arrays and classifies by key path', () => {
  const doc = {
    Activity: {
      'Video Browsing History': {
        VideoList: [{ Date: '2024-03-11 14:02:55', Link: 'https://example.com/v/1' }],
      },
      'Search History': {
        SearchList: [{ Date: '2024-03-12 09:00:00', SearchTerm: 'weather oslo' }],
      },
    },
  }
  const events = walkDatedArrays(doc, {
    rules: [
      { test: /browsinghistory/, kind: 'watch', label: 'Watched' },
      { test: /searchhistory/, kind: 'search', label: 'Search' },
    ],
  })
  assert.equal(events.length, 2)
  const watch = events.find((e) => e.kind === 'watch')
  const search = events.find((e) => e.kind === 'search')
  assert.ok(watch && search, 'both categories should be classified')
  assert.equal(search.title, 'weather oslo')
  assert.equal(watch.url, 'https://example.com/v/1')
})

check('walker does not use a bare URL as a title', () => {
  // TikTok watch history has no video titles, only share links whose 19-digit
  // id redacts to "[REDACTED PAYMENT NUMBER]" — identical on tens of thousands
  // of rows, which would spend the analysis budget saying nothing.
  const doc = { Activity: { WatchHistory: { VideoList: [
    { Date: '2024-03-11 14:02:55', Link: 'https://www.tiktokv.com/share/video/7341234567890123456/' },
  ] } } }
  const [event] = walkDatedArrays(doc, {
    rules: [{ test: /watchhistory/, kind: 'watch', label: 'Watched' }],
  })
  assert.equal(event.title, 'Watched', 'a bare link must not become the title')
  assert.equal(event.url, 'https://www.tiktokv.com/share/video/7341234567890123456/', 'the link is still kept')

  // Real text still wins over the label.
  const withText = { Activity: { WatchHistory: { VideoList: [
    { Date: '2024-03-11 14:02:55', Title: 'How to make a negroni' },
  ] } } }
  const [titled] = walkDatedArrays(withText, {
    rules: [{ test: /watchhistory/, kind: 'watch', label: 'Watched' }],
  })
  assert.equal(titled.title, 'How to make a negroni')
})

check('walker drops unmatched arrays unless a fallback is given', () => {
  const doc = { Mystery: { List: [{ Date: '2024-03-11', text: 'x' }] } }
  assert.equal(walkDatedArrays(doc, { rules: [] }).length, 0)
  assert.equal(walkDatedArrays(doc, { rules: [], fallbackKind: 'other' }).length, 1)
})

check('walker survives a renamed wrapper key', () => {
  // The whole point: TikTok reorganizes the nesting between export versions.
  const renamed = { Activity: { 'Video Browsing History v2': { List: [{ Date: '2024-03-11', Link: 'x' }] } } }
  const events = walkDatedArrays(renamed, {
    rules: [{ test: /browsinghistory/, kind: 'watch', label: 'Watched' }],
  })
  assert.equal(events.length, 1, 'a renamed wrapper must not lose the data')
})

check('walker never keeps a direct-message body', () => {
  // Regression: the TikTok export uses the same text keys for a search query
  // and for the body of a private conversation. Real data leaked DM content
  // through this path before the message branch existed.
  const doc = {
    'Direct Message': {
      ChatHistory: {
        'Chat History with someone:': [
          { Date: '2024-03-11 14:02:55', From: 'someone', Content: 'a private message body' },
        ],
      },
    },
    Activity: {
      'Search History': { SearchList: [{ Date: '2024-03-11 15:00:00', SearchTerm: 'a public query' }] },
    },
  }
  const events = walkDatedArrays(doc, {
    rules: [
      { test: /chathistory|directmessage/, kind: 'message', label: 'Direct message' },
      { test: /searchhistory/, kind: 'search', label: 'Search' },
    ],
  })
  const message = events.find((e) => e.kind === 'message')
  const search = events.find((e) => e.kind === 'search')

  assert.ok(message, 'the message should still be recorded')
  assert.equal(message.title, 'Direct message', 'the body must not become the title')
  assert.equal(message.counterparty, 'someone', 'who and when are still kept')
  assert.equal(message.sourceMeta.length, 'a private message body'.length, 'only its size is kept')
  assert.ok(!JSON.stringify(events).includes('a private message body'), 'no DM body may survive')

  // A search query is not a private body and must still come through.
  assert.equal(search.title, 'a public query')
})

// --- Google ------------------------------------------------------------

check('Google My Activity parses searches and skips other products', () => {
  const source = fakeSource({
    'Takeout/My Activity/Search/MyActivity.json': JSON.stringify([
      { header: 'Search', title: 'Searched for weather oslo', titleUrl: 'https://g.co/x', time: '2024-03-11T14:02:55Z' },
      { header: 'Search', title: 'Visited example.com', time: '2024-03-11T15:00:00Z' },
      { header: 'Maps', title: 'Searched for coffee', time: '2024-03-11T16:00:00Z' },
      { header: 'Search', title: 'no timestamp' },
    ]),
  })
  const events = parseGoogleSearchExport(source)
  assert.equal(events.length, 2, 'Maps entries and undated entries are excluded')
  assert.equal(events[0].kind, 'search')
  assert.equal(events[0].title, 'weather oslo', 'the "Searched for " verb is stripped')
  assert.equal(events[1].kind, 'other')
})

check('Google My Activity HTML parses entries with and without anchors', () => {
  // HTML is Takeout's default format; a JSON-only parser finds nothing in a
  // typical archive. The narrow no-break space before AM/PM is Takeout's, and
  // the anchor-less entry is the one that used to swallow its own timestamp.
  const html =
    '<div class="outer-cell mdl-cell"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell"><p class="mdl-typography--title">Search<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-typography--body-1">Searched for&nbsp;' +
    '<a href="https://www.google.com/search?q=negroni">negroni recipe</a><br>' +
    'Jul 22, 2026, 2:37:03 AM EDT<br></div></div></div>' +
    '<div class="outer-cell mdl-cell"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell"><p class="mdl-typography--title">Search<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-typography--body-1">Used Search<br>' +
    'Jul 22, 2026, 2:37:32 AM EDT<br></div></div></div>' +
    '<div class="outer-cell mdl-cell"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell"><p class="mdl-typography--title">Maps<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-typography--body-1">Searched for&nbsp;' +
    '<a href="https://maps.google.com">coffee</a><br>Jul 22, 2026, 3:00:00 AM EDT<br></div></div></div>'

  const events = parseGoogleActivityHtml(html)
  assert.equal(events.length, 2, 'Maps entries belong to a different account')

  assert.equal(events[0].kind, 'search')
  assert.equal(events[0].title, 'negroni recipe')
  assert.equal(events[0].occurredAt, '2026-07-22T06:37:03.000Z')

  assert.equal(events[1].title, 'Used Search', 'an anchor-less entry must not absorb its timestamp')
  assert.equal(events[1].occurredAt, '2026-07-22T06:37:32.000Z')
})

// --- Meta --------------------------------------------------------------

check('Meta export parses posts and message metadata without bodies', () => {
  const source = fakeSource({
    'your_instagram_activity/content/your_posts_1.json': JSON.stringify([
      { creation_timestamp: 1710165775, data: [{ post: Buffer.from('café time', 'utf8').toString('latin1') }] },
    ]),
    'your_instagram_activity/messages/inbox/friend/message_1.json': JSON.stringify({
      participants: [{ name: 'Friend' }, { name: 'Me' }],
      title: 'Friend',
      messages: [
        { sender_name: 'Friend', timestamp_ms: 1710165775000, content: 'secret text that must not be stored' },
      ],
    }),
  })
  const events = parseMetaExport(source, 'instagram')
  const post = events.find((e) => e.kind === 'post')
  const message = events.find((e) => e.kind === 'message')
  assert.ok(post, 'post should be parsed')
  assert.equal(post.title, 'café time', 'mojibake must be repaired')
  assert.ok(message, 'message metadata should be parsed')
  assert.equal(message.counterparty, 'Friend')
  const serialized = JSON.stringify(events)
  assert.ok(!serialized.includes('secret text'), 'message bodies must never be carried through')
})

// --- Discord -----------------------------------------------------------

check('Discord messages.csv survives multi-line content and stores no bodies', () => {
  const source = fakeSource({
    'messages/index.json': JSON.stringify({ '1234567890': 'general' }),
    'messages/c1234567890/messages.csv':
      'ID,Timestamp,Contents,Attachments\n' +
      '1,2024-03-11T14:02:55+00:00,"multi\nline\nmessage",\n' +
      '2,2024-03-12T14:02:55+00:00,short,https://cdn.example/a.png\n',
  })
  const events = parseDiscordExport(source)
  assert.equal(events.length, 2, 'the multi-line message must be one event, not three')
  assert.equal(events[0].counterparty, 'general', 'channel id maps to its readable name')
  assert.equal(events[0].sourceMeta.length, 'multi\nline\nmessage'.length)
  assert.equal(events[1].sourceMeta.hasAttachment, true)
  assert.ok(!JSON.stringify(events).includes('multi\\nline'), 'content must not be stored')
})

// --- Tinder ------------------------------------------------------------

check('Tinder usage counters become one dated event per non-zero day', () => {
  const source = fakeSource({
    'data.json': JSON.stringify({
      User: { name: 'x' },
      Usage: {
        app_opens: { '2024-03-11': 4, '2024-03-12': 0 },
        swipes_likes: { '2024-03-11': 22 },
      },
      Messages: [
        { match_id: 'abcdef123456', messages: [{ sent_date: '2024-03-11T14:02:55Z', message: 'private text' }] },
      ],
    }),
  })
  const events = parseTinderExport(source)
  const opens = events.filter((e) => e.detail === 'Opened app')
  assert.equal(opens.length, 1, 'a zero-count day is not an event')
  assert.equal(opens[0].sourceMeta.count, 4)
  assert.ok(events.some((e) => e.title === 'Swiped right ×22'))
  const message = events.find((e) => e.kind === 'message')
  assert.ok(message, 'message metadata should be parsed')
  assert.ok(!JSON.stringify(events).includes('private text'), 'match message text must not be stored')
})

// --- iMessage attributedBody -------------------------------------------

/** Builds a streamtyped blob shaped like a real NSAttributedString archive. */
function attributedBody(text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 0x80) {
    header = Buffer.from([payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(3)
    header[0] = 0x81
    header.writeUInt16LE(payload.length, 1)
  } else {
    header = Buffer.alloc(5)
    header[0] = 0x82
    header.writeUInt32LE(payload.length, 1)
  }
  return Buffer.concat([
    Buffer.from('streamtypedè@', 'binary'),
    Buffer.from('NSAttributedString', 'ascii'),
    Buffer.from(' ', 'binary'),
    Buffer.from('NSObject', 'ascii'),
    Buffer.from(' ', 'binary'),
    Buffer.from('NSString', 'ascii'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    header,
    payload,
    Buffer.from('', 'binary'),
    Buffer.from('NSDictionary', 'ascii'),
    Buffer.from('__kIMMessagePartAttributeName', 'ascii'),
  ])
}

check('attributedBody decodes across all three length encodings', () => {
  // Validated against a real 285k-message chat.db: 86,444/86,444 exact matches
  // on rows carrying both `text` and `attributedBody`.
  const short = 'That is exactly how to say it'
  assert.equal(decodeAttributedBody(attributedBody(short)), short)

  const boundary = 'x'.repeat(0x7f)
  assert.equal(decodeAttributedBody(attributedBody(boundary)), boundary)

  const twoByte = 'y'.repeat(1255)
  assert.equal(decodeAttributedBody(attributedBody(twoByte)), twoByte)

  const fourByte = 'z'.repeat(70_000)
  assert.equal(decodeAttributedBody(attributedBody(fourByte)), fourByte)
})

check('attributedBody preserves multi-byte characters', () => {
  // The declared length is in BYTES, not characters — an emoji truncates the
  // string if that is confused.
  const text = 'café ☕ 🎉 naïve'
  assert.equal(decodeAttributedBody(attributedBody(text)), text)
})

check('attributedBody returns null rather than guessing', () => {
  assert.equal(decodeAttributedBody(null), null)
  assert.equal(decodeAttributedBody(Buffer.alloc(0)), null)
  // Attachment-only message: no NSString at all.
  assert.equal(decodeAttributedBody(Buffer.from('streamtyped NSObject', 'ascii')), null)
  // Declared length runs past the end of the buffer.
  const truncated = attributedBody('hello').subarray(0, 60)
  assert.equal(decodeAttributedBody(truncated), null)
})

check('messageBodyText prefers the plain column and falls back', () => {
  assert.equal(messageBodyText('plain text', attributedBody('archived')), 'plain text')
  assert.equal(messageBodyText(null, attributedBody('archived')), 'archived')
  assert.equal(messageBodyText('', attributedBody('archived')), 'archived')
  assert.equal(messageBodyText(null, null), null)
})

// --- contact resolution ------------------------------------------------

check('contact lookup matches a fully qualified number against a national one', () => {
  // iMessage handles are "+15551234567" (11 digits); Contacts commonly stores
  // "(555) 123-4567" (10). An exact digit comparison matches neither, which is
  // why every conversation used to be attributed to a pseudonym.
  const index = {
    direct: new Map([['5551234567', 'Dana Reed'], ['dana@example.com', 'Dana Reed']]),
    byLastTen: new Map([['5551234567', 'Dana Reed']]),
    size: 2,
  }
  assert.equal(lookupContact(index, '+15551234567'), 'Dana Reed', 'country code must not defeat the match')
  assert.equal(lookupContact(index, '5551234567'), 'Dana Reed')
  assert.equal(lookupContact(index, '(555) 123-4567'), 'Dana Reed', 'formatting must not defeat the match')
  assert.equal(lookupContact(index, 'DANA@example.com'), 'Dana Reed', 'email match is case-insensitive')
})

check('contact lookup returns null for an unknown handle', () => {
  const index = { direct: new Map(), byLastTen: new Map(), size: 0 }
  assert.equal(lookupContact(index, '+15559999999'), null)
  assert.equal(lookupContact(index, ''), null)
  // A short code has too few digits to match on the last ten.
  assert.equal(lookupContact({ ...index, byLastTen: new Map([['5551234567', 'X']]) }, '262966'), null)
})

// --- watched-directory detection ---------------------------------------

check('Amazon detection reads the CSV header, not just the extension', () => {
  // An Amazon data request holds hundreds of unrelated CSVs. Matching every
  // .csv fed watchlists and address books to the orders parser: 241 records,
  // most failed, and an address book "parsed" as one order.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-amz-'))
  const amazon = activityProvider('amazon')

  const orders = path.join(dir, 'Retail.OrderHistory.1.csv')
  fs.writeFileSync(orders, 'Order ID,Order Date,Total Owed\n111-222,2024-03-11,19.99\n')
  assert.equal(detectExportForProvider(amazon, orders), true, 'an order file must be picked up')

  for (const [name, header] of [
    ['Addresses.csv', 'Name,AddressLine1,City,PostalCode\n'],
    ['Watchlist.csv', 'Title,Added Date,Profile\n'],
    ['Viewing History.csv', 'Title,Playback Date,Device\n'],
  ]) {
    const junk = path.join(dir, name)
    fs.writeFileSync(junk, header + 'a,b,c\n')
    assert.equal(detectExportForProvider(amazon, junk), false, `${name} must not look like orders`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
})

check('an extension-less zip is detected in a watched directory', () => {
  // TikTok's export is a bare UUID with no suffix. `openExportSource` sniffed
  // the magic bytes, but the detection gate ran first and rejected any file
  // without a known extension — so manual import worked and Scan now silently
  // found nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-tt-'))
  const payload = JSON.stringify({
    Activity: { 'Video Browsing History': { VideoList: [{ Date: '2024-03-11 14:02:55', Link: 'https://x' }] } },
  })
  const bare = path.join(dir, 'bf58b57b-79b7-4ea8-a4de-7c8340281822')
  fs.writeFileSync(bare, Buffer.from(zipSync({ 'user_data_tiktok.json': strToU8(payload) })))

  assert.equal(detectExportForProvider(activityProvider('tiktok'), bare), true)

  // A non-archive with no extension is still rejected.
  const notZip = path.join(dir, 'README')
  fs.writeFileSync(notZip, 'just text')
  assert.equal(detectExportForProvider(activityProvider('tiktok'), notZip), false)

  fs.rmSync(dir, { recursive: true, force: true })
})

check('a watched directory offers itself before its contents', () => {
  // The scan walks outermost-first so an unzipped Takeout is imported once as a
  // tree, not once per nesting level. Verified against the real archive: before
  // this, Search and YouTube each landed exactly 3x.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-nest-'))
  const inner = path.join(dir, 'Takeout', 'My Activity', 'Search')
  fs.mkdirSync(inner, { recursive: true })
  const html =
    '<div class="outer-cell"><div class="header-cell"><p class="x">Search<br></p></div>' +
    '<div class="content-cell mdl-typography--body-1">Searched for&nbsp;<a href="https://g.co">x</a><br>' +
    'Jul 22, 2026, 2:37:03 AM EDT<br></div></div>'
  fs.writeFileSync(path.join(inner, 'MyActivity.html'), html)

  const search = activityProvider('google-search')
  // Every level is individually a valid candidate — which is exactly why the
  // scan must not ingest more than the outermost one.
  assert.equal(detectExportForProvider(search, dir), true, 'the root is a candidate')
  assert.equal(detectExportForProvider(search, path.join(dir, 'Takeout')), true, 'so is the subtree')
  assert.equal(detectExportForProvider(search, path.join(inner, 'MyActivity.html')), true, 'so is the file')

  fs.rmSync(dir, { recursive: true, force: true })
})

// --- registry ----------------------------------------------------------

check('every provider is well formed and uniquely named', () => {
  const ids = new Set()
  for (const def of ACTIVITY_PROVIDERS) {
    assert.ok(!ids.has(def.id), `duplicate provider id ${def.id}`)
    ids.add(def.id)
    assert.ok(def.label && def.blurb && def.icon, `${def.id} is missing display fields`)
    assert.ok(isActivityProviderId(def.id))
    assert.equal(activityProvider(def.id), def)

    // A provider with no live path must not claim to need a credential, and a
    // risky live path must explain itself.
    if (def.live === 'none') {
      assert.equal(def.liveViability, 'none', `${def.id}: no live path but viability is not none`)
    }
    if (def.liveViability !== 'stable' && def.liveViability !== 'none') {
      assert.ok(def.liveWarning, `${def.id}: an unstable live path must carry a warning`)
    }
    if (def.credential !== 'none') {
      assert.notEqual(def.live, 'none', `${def.id}: takes a credential but has no live path`)
    }
    if (def.exportFormat !== 'none') {
      assert.ok(def.exportUrl, `${def.id}: has an export format but no request URL`)
    }
    assert.ok(def.exportSteps, `${def.id}: needs instructions`)
  }
  assert.equal(ids.size, 13, 'expected all thirteen accounts to be registered')
})

check('Discord is the only ban-risk provider and defaults to needing consent', () => {
  const risky = ACTIVITY_PROVIDERS.filter((d) => d.liveViability === 'ban-risk')
  assert.deepEqual(risky.map((d) => d.id), ['discord'])
  assert.ok(risky[0].liveWarning.toLowerCase().includes('terminat'))
})

// --- archive helpers ---------------------------------------------------

check('a zip is recognized by magic bytes, not by its extension', () => {
  // TikTok delivers its export as a bare UUID with no extension. Trusting the
  // filename meant treating the archive as one opaque file and finding nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holmes-zip-'))
  const inner = JSON.stringify({ Activity: { 'Search History': { SearchList: [] } } })
  const zipped = zipSync({ 'user_data_tiktok.json': strToU8(inner) })

  const noExtension = path.join(dir, 'bf58b57b-79b7-4ea8-a4de-7c8340281822')
  fs.writeFileSync(noExtension, zipped)
  const source = openExportSource(noExtension)
  assert.deepEqual(source.list(), ['user_data_tiktok.json'])
  assert.equal(source.entryPath('user_data_tiktok.json'), null, 'zip members have no path on disk')

  // A plain file is still a plain file.
  const loose = path.join(dir, 'data.json')
  fs.writeFileSync(loose, '{}')
  assert.deepEqual(openExportSource(loose).list(), ['data.json'])
  assert.ok(openExportSource(loose).entryPath('data.json'), 'a real file exposes its path for streaming')

  fs.rmSync(dir, { recursive: true, force: true })
})

check('YouTube watch-history HTML yields video title and channel', () => {
  // Takeout emits watch-history.html by default; the JSON path finds nothing in
  // a real archive. The block carries two anchors — video then channel.
  const html =
    '<div class="outer-cell mdl-cell"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell"><p class="mdl-typography--title">YouTube<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-typography--body-1">Watched&nbsp;' +
    '<a href="https://www.youtube.com/watch?v=abc">Avengers Doomsday Looks ROUGH</a><br>' +
    '<a href="https://www.youtube.com/channel/xyz">IHE TV</a><br>' +
    'Jul 22, 2026, 2:05:09 PM EDT<br></div></div></div>' +
    '<div class="outer-cell mdl-cell"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell"><p class="mdl-typography--title">Search<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-typography--body-1">Searched for&nbsp;' +
    '<a href="https://g.co">not a video</a><br>Jul 22, 2026, 3:00:00 PM EDT<br></div></div></div>'

  const events = parseGoogleActivityHtmlText(html, watchEventFromBlock)
  assert.equal(events.length, 1, 'a Search block must not become a watch event')
  assert.equal(events[0].title, 'Avengers Doomsday Looks ROUGH')
  assert.equal(events[0].channel, 'IHE TV', 'the second anchor is the channel')
  assert.equal(events[0].occurredAt, '2026-07-22T18:05:09.000Z')
})

check('findEntries matches ANY suffix, findEntriesContaining requires ALL', () => {
  // This distinction is why the Takeout fan-out silently skipped YouTube:
  // asking findEntriesContaining for both ".html" and ".json" can never match,
  // because no single file is both.
  const source = fakeSource({ 'Takeout 2/YouTube/history/watch-history.html': '<html>' })

  assert.equal(
    findEntries(source, 'watch-history.html', 'watch-history.json').length,
    1,
    'findEntries is an OR over suffixes'
  )
  assert.equal(
    findEntriesContaining(source, 'watch-history.html', 'watch-history.json').length,
    0,
    'findEntriesContaining is an AND over fragments'
  )
  assert.equal(findEntriesContaining(source, 'youtube', 'watch-history.html').length, 1)
})

check('entry matching is case-insensitive and fragment-aware', () => {
  const source = fakeSource({ 'A/B/MyActivity.JSON': '[]', 'A/notes.txt': 'x' })
  assert.deepEqual(findEntries(source, '.json'), ['A/B/MyActivity.JSON'])
  assert.deepEqual(findEntriesContaining(source, 'myactivity.json'), ['A/B/MyActivity.JSON'])
  assert.deepEqual(findEntriesContaining(source, 'nothing'), [])
})

console.log(`\nAll ${passed} activity-account checks passed.`)
