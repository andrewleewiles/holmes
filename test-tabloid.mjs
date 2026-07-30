import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MAX_FLAGS_PER_VIDEO,
  MAX_RATIONALE_CHARS,
  classifyYoutubeError,
  formatClock,
  parseAnalysisResponse,
  parseClock,
  parseVtt,
  transcriptToPrompt,
  decodeHtmlEntities,
  parseCuratorResponse,
  parsePlannerResponse,
  tabloidItemKey,
  quotaDayPacific,
  salvageJsonObject,
  youtubeDurationToSeconds,
} from './src/shared/tabloidFeed.ts'

// --- ISO-8601 durations ------------------------------------------------------

// The shape videos.list actually returns.
assert.equal(youtubeDurationToSeconds('PT1H2M3S'), 3723)
assert.equal(youtubeDurationToSeconds('PT14M32S'), 872)
assert.equal(youtubeDurationToSeconds('PT45S'), 45)
assert.equal(youtubeDurationToSeconds('PT2H'), 7200)
assert.equal(youtubeDurationToSeconds('P1DT30S'), 86430)
assert.equal(youtubeDurationToSeconds('P1W'), 604800)

// Fractional seconds appear on some live recordings.
assert.equal(youtubeDurationToSeconds('PT1M30.5S'), 91)

// Junk is null, never zero: a video of unknown length must render as unknown,
// not as an instant.
assert.equal(youtubeDurationToSeconds('14:32'), null)
assert.equal(youtubeDurationToSeconds(''), null)
assert.equal(youtubeDurationToSeconds('P'), null)
assert.equal(youtubeDurationToSeconds('PT'), null)
assert.equal(youtubeDurationToSeconds(null), null)
assert.equal(youtubeDurationToSeconds(undefined), null)
assert.equal(youtubeDurationToSeconds(872), null)

// Years and months have no fixed length, so they are refused rather than
// guessed at 365/30 days.
assert.equal(youtubeDurationToSeconds('P1Y'), null)
assert.equal(youtubeDurationToSeconds('P2M'), null)

// --- HTML entities -----------------------------------------------------------

// search.list escapes every title, so this is what a channel name arrives as.
assert.equal(decodeHtmlEntities('Tom &amp; Jerry'), 'Tom & Jerry')
assert.equal(decodeHtmlEntities('It&#39;s a Wonderful Life'), "It's a Wonderful Life")
assert.equal(decodeHtmlEntities('&quot;Quoted&quot;'), '"Quoted"')
assert.equal(decodeHtmlEntities('&#x27;hex&#x27;'), "'hex'")
assert.equal(decodeHtmlEntities('nothing to do'), 'nothing to do')
// An entity that is not one is left exactly as it stands rather than eaten.
assert.equal(decodeHtmlEntities('100 &notreal; 200'), '100 &notreal; 200')

// --- identity ----------------------------------------------------------------

assert.equal(tabloidItemKey('video', 'youtube', 'abc123'), 'video|youtube|abc123')

// --- JSON salvage ------------------------------------------------------------

// The happy path: the model did as it was told.
assert.deepEqual(salvageJsonObject('{"picks":[1,2]}', 'picks'), { picks: [1, 2] })

// A budget model thinking out loud before it answers.
assert.deepEqual(
  salvageJsonObject('<think>hmm, {"picks": maybe}</think>\nSure!\n{"picks":[3]}', 'picks'),
  { picks: [3] }
)

// Wrapped in a markdown fence despite being told not to.
assert.deepEqual(salvageJsonObject('```json\n{"picks":[4]}\n```', 'picks'), { picks: [4] })

// Nothing parseable at all.
assert.equal(salvageJsonObject('I could not find anything.', 'picks'), null)

// --- planner parsing ---------------------------------------------------------

const REFS = {
  S1: { ref: 'user:super-context', kind: 'super-context', label: 'Profile', detail: 'restores boats', drillable: true },
  M2: { ref: 'memory:field:hobbies', kind: 'memory-field', label: 'Hobbies', detail: 'woodworking', drillable: false },
}

const plannerReply = JSON.stringify({
  intents: [
    { id: 'x9', kind: 'video', query: 'wooden boat restoration', rationale: 'they restore boats', sources: ['S1'] },
    { id: 'x8', kind: 'video', query: 'hand tool woodworking', rationale: 'woodworking', sources: ['M2', 'NOPE'] },
    // An unsupported kind. V1 retrieves video only, so this is dropped rather
    // than silently retrieved by the wrong retriever.
    { id: 'x7', kind: 'podcast', query: 'boatyard economics', rationale: 'x', sources: ['S1'] },
    // A duplicate query, case-insensitively.
    { id: 'x6', kind: 'video', query: 'Wooden Boat Restoration', rationale: 'dupe', sources: ['S1'] },
    // No query at all.
    { id: 'x5', kind: 'video', query: '', rationale: 'empty', sources: ['S1'] },
  ],
})

const intents = parsePlannerResponse(plannerReply, {
  allowedKinds: ['video'],
  refsByTag: REFS,
  maxIntents: 10,
})

assert.equal(intents.length, 2)
// Ids are reassigned densely: the curator cites them back, so they must be ours.
assert.deepEqual(intents.map((intent) => intent.id), ['i1', 'i2'])
assert.equal(intents[0].query, 'wooden boat restoration')
assert.equal(intents[0].kind, 'video')

// A tag the prompt never issued is dropped — only facts the model was shown got
// a tag, so a citation to anything else can only be invented.
assert.deepEqual(intents[1].sourceRefs.map((ref) => ref.ref), ['memory:field:hobbies'])

// Unparseable replies yield no intents rather than throwing.
assert.deepEqual(parsePlannerResponse('no json here', { allowedKinds: ['video'], refsByTag: REFS, maxIntents: 10 }), [])

// The cap is honoured.
const many = JSON.stringify({
  intents: Array.from({ length: 20 }, (_, index) => ({
    kind: 'video',
    query: `query number ${index}`,
    rationale: 'r',
    sources: ['S1'],
  })),
})
assert.equal(parsePlannerResponse(many, { allowedKinds: ['video'], refsByTag: REFS, maxIntents: 6 }).length, 6)

// Filters are validated, not trusted.
const filtered = parsePlannerResponse(
  JSON.stringify({
    intents: [
      {
        kind: 'video',
        query: 'long form documentaries',
        rationale: 'r',
        sources: [],
        filters: { minMinutes: 20, maxMinutes: 999999, publishedAfter: '2024-03-01', language: 'EN', junk: 'x' },
      },
    ],
  }),
  { allowedKinds: ['video'], refsByTag: REFS, maxIntents: 4 }
)
assert.equal(filtered[0].filters.minMinutes, 20)
assert.equal(filtered[0].filters.maxMinutes, 600)
assert.equal(filtered[0].filters.publishedAfter, '2024-03-01')
assert.equal(filtered[0].filters.language, 'en')
assert.equal(filtered[0].filters.junk, undefined)

// --- curator parsing ---------------------------------------------------------

const curatorReply = JSON.stringify({
  picks: [
    { candidateId: 'c1', intentIds: ['i1'], rationale: 'Because you restore boats.', memoryFieldKey: 'hobbies', memoryValue: 'Sampson Boat Co' },
    // A candidate that was never offered. This is the hallucination case, and it
    // must not become a card pointing at nothing.
    { candidateId: 'c99', intentIds: ['i1'], rationale: 'invented', memoryFieldKey: null, memoryValue: null },
    // An intent id that was not in the plan is dropped, but the pick survives.
    { candidateId: 'c2', intentIds: ['i1', 'i77'], rationale: 'ok', memoryFieldKey: null, memoryValue: null },
    // A memory field outside the allowed catalog set.
    { candidateId: 'c3', intentIds: [], rationale: 'ok', memoryFieldKey: 'bank_password', memoryValue: 'nope' },
    // A repeat of one already picked.
    { candidateId: 'c1', intentIds: ['i1'], rationale: 'again', memoryFieldKey: null, memoryValue: null },
  ],
})

const picks = parseCuratorResponse(curatorReply, {
  allowedCandidateIds: ['c1', 'c2', 'c3'],
  allowedIntentIds: ['i1', 'i2'],
  allowedMemoryFieldKeys: ['hobbies', 'movies_and_tv'],
  maxPicks: 12,
})

assert.deepEqual(picks.map((pick) => pick.candidateId), ['c1', 'c2', 'c3'])
assert.equal(picks[0].memoryFieldKey, 'hobbies')
assert.equal(picks[0].memoryValue, 'Sampson Boat Co')
assert.deepEqual(picks[1].intentIds, ['i1'])

// A field key the catalog does not carry is refused, and its value goes with it
// so nothing can be written under a key that does not exist.
assert.equal(picks[2].memoryFieldKey, null)
assert.equal(picks[2].memoryValue, null)

// Rationales are clamped to one line.
const longRationale = parseCuratorResponse(
  JSON.stringify({ picks: [{ candidateId: 'c1', intentIds: [], rationale: 'x'.repeat(400) }] }),
  { allowedCandidateIds: ['c1'], allowedIntentIds: [], allowedMemoryFieldKeys: [], maxPicks: 12 }
)
assert.equal(longRationale[0].rationale.length, MAX_RATIONALE_CHARS)

// --- YouTube error classification -------------------------------------------

// A real quotaExceeded body, which must never read as a broken key.
const quotaBody = JSON.stringify({
  error: {
    code: 403,
    message: 'The request cannot be completed because you have exceeded your quota.',
    errors: [{ domain: 'youtube.quota', reason: 'quotaExceeded', message: 'quota' }],
  },
})
assert.equal(classifyYoutubeError(403, quotaBody).kind, 'quota')
// The copy has to name Pacific time, or "resets at midnight" is hours wrong.
assert.match(classifyYoutubeError(403, quotaBody).message, /Pacific/)

const badKeyBody = JSON.stringify({
  error: { code: 400, message: 'API key not valid.', errors: [{ reason: 'keyInvalid' }] },
})
assert.equal(classifyYoutubeError(400, badKeyBody).kind, 'key-invalid')

const notConfiguredBody = JSON.stringify({
  error: { code: 403, message: 'YouTube Data API has not been used', errors: [{ reason: 'accessNotConfigured' }] },
})
assert.equal(classifyYoutubeError(403, notConfiguredBody).kind, 'not-configured')

// Throttling and outages are transient — retrying is right, giving up is not.
assert.equal(classifyYoutubeError(429, '{}').kind, 'transient')
assert.equal(classifyYoutubeError(503, '{}').kind, 'transient')
assert.equal(
  classifyYoutubeError(403, JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } })).kind,
  'transient'
)

// A non-JSON body (an HTML page from a proxy) still classifies rather than throwing.
assert.equal(classifyYoutubeError(500, '<html>gateway</html>').kind, 'transient')

// --- the quota day -----------------------------------------------------------

// YouTube resets at Pacific midnight, so the ledger key is a Pacific date. This
// instant is 2026-03-02 in UTC but still 2026-03-01 in Los Angeles.
assert.equal(quotaDayPacific(Date.UTC(2026, 2, 2, 3, 0, 0)), '2026-03-01')
assert.equal(quotaDayPacific(Date.UTC(2026, 2, 2, 20, 0, 0)), '2026-03-02')

// --- VTT parsing ------------------------------------------------------------

// Verbatim shape of a real YouTube auto-caption file, down to the rolling
// repeats and the per-word timing tags. This is what actually comes back.
const ROLLING_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:04.390 align:start position:0%

[Music]

00:00:04.390 --> 00:00:04.400 align:start position:0%



00:00:04.400 --> 00:00:06.869 align:start position:0%

This<00:00:04.799><c> is</c><00:00:04.960><c> a</c><00:00:05.200><c> three.</c><00:00:05.920><c> It's</c><00:00:06.080><c> sloppily</c><00:00:06.640><c> written</c>

00:00:06.869 --> 00:00:06.879 align:start position:0%
This is a three. It's sloppily written


00:00:06.879 --> 00:00:08.549 align:start position:0%
This is a three. It's sloppily written
and<00:00:07.200><c> rendered</c><00:00:07.600><c> at</c><00:00:08.000><c> low</c><00:00:08.200><c> resolution</c>
`

const cues = parseVtt(ROLLING_VTT)

// Per-word timing tags and <c> spans are gone.
assert.ok(!cues.some((cue) => cue.text.includes('<')), 'no markup survives')

// The rolling duplicate is collapsed: the settled line does not become a second
// cue just because YouTube repeated it while scrolling.
const texts = cues.map((cue) => cue.text)
assert.equal(new Set(texts).size, texts.length, 'no duplicate lines')
assert.deepEqual(texts, [
  '[Music]',
  "This is a three. It's sloppily written",
  'and rendered at low resolution',
])

// The kept timestamp is the EARLIEST the line appeared — when the words were
// spoken. Taking the later repeat would put every flag a few seconds late.
assert.equal(cues[1].start, 4.4)

// The end is extended by the repeats rather than left at the first appearance.
assert.ok(cues[1].end >= 6.869)

// Whitespace-only cues are dropped rather than becoming empty lines.
assert.ok(!texts.includes(''))

// Header-only and junk input yield nothing rather than throwing.
assert.deepEqual(parseVtt('WEBVTT\n\n'), [])
assert.deepEqual(parseVtt(''), [])
assert.deepEqual(parseVtt('not a vtt file at all'), [])

// A cue with no hour component still parses; a 2h talk still gets its hours.
const shortForm = parseVtt('WEBVTT\n\n01:02.500 --> 01:05.000\nhello\n')
assert.equal(shortForm.length, 1)
assert.equal(shortForm[0].start, 62.5)

// --- clocks -----------------------------------------------------------------

assert.equal(formatClock(0), '0:00')
assert.equal(formatClock(62), '1:02')
assert.equal(formatClock(3723), '1:02:03')

assert.equal(parseClock('2:14'), 134)
assert.equal(parseClock('1:02:03'), 3723)
assert.equal(parseClock('134'), 134)
assert.equal(parseClock(134), 134)
assert.equal(parseClock('later on'), null)
assert.equal(parseClock(''), null)
assert.equal(parseClock('1:2:3:4'), null)

// --- transcript prompt formatting -------------------------------------------

const promptText = transcriptToPrompt(
  [
    { start: 0, end: 2, text: 'one' },
    { start: 2, end: 4, text: 'two' },
    { start: 4, end: 6, text: 'three' },
    { start: 6, end: 8, text: 'four' },
    { start: 8, end: 10, text: 'five' },
  ],
  4
)
// Every fourth line is stamped: enough for the model to place a claim without
// paying for a timestamp on every line.
assert.match(promptText, /^\[0:00\] one/)
assert.match(promptText, /\[0:08\] five/)
assert.ok(!promptText.includes('[0:02]'), 'unstamped lines carry no marker')

// --- analysis parsing -------------------------------------------------------

const ANALYSIS_CUES = [
  { start: 10, end: 14, text: 'the bridge carries ten thousand cars a day' },
  { start: 120, end: 126, text: 'it is the safest design ever built' },
  { start: 300, end: 306, text: 'nobody has ever questioned this' },
]

const analysis = parseAnalysisResponse(
  JSON.stringify({
    summary: 'Well sourced on engineering, thin on the safety record.',
    flags: [
      { at: '2:01', kind: 'unsupported', severity: 'high', quote: 'it is the safest design ever built', note: 'No source given.' },
      // Out of order on purpose — flags must come back chronological.
      { at: '0:11', kind: 'bias', severity: 'low', quote: 'the bridge carries ten thousand cars a day', note: 'Framed favourably.' },
      // Past the end of the video: the signature of an invented timestamp.
      { at: '99:00', kind: 'false', severity: 'high', quote: 'x', note: 'y' },
      // No quote, so a viewer could not check it.
      { at: '5:00', kind: 'bias', severity: 'low', quote: '', note: 'vague unease' },
      // Not in the taxonomy.
      { at: '5:00', kind: 'vibes', severity: 'low', quote: 'nobody has ever questioned this', note: 'n' },
      // No note.
      { at: '5:00', kind: 'omission', severity: 'low', quote: 'nobody has ever questioned this', note: '' },
    ],
  }),
  { cues: ANALYSIS_CUES, durationSeconds: 400 }
)

assert.equal(analysis.summary, 'Well sourced on engineering, thin on the safety record.')
assert.equal(analysis.flags.length, 2, 'four of six flags are refused')

// Chronological, and re-numbered after sorting so the ids match the order shown.
assert.deepEqual(analysis.flags.map((flag) => flag.id), ['f1', 'f2'])
assert.ok(analysis.flags[0].startSeconds < analysis.flags[1].startSeconds)

// Timestamps are snapped to the cue that actually carries the words, so clicking
// a flag seeks to the quote rather than a few seconds past it.
assert.equal(analysis.flags[0].startSeconds, 10)
assert.equal(analysis.flags[1].startSeconds, 120)

// An unknown severity degrades to medium rather than dropping the flag.
const severityFallback = parseAnalysisResponse(
  JSON.stringify({
    summary: '',
    flags: [{ at: '0:11', kind: 'bias', severity: 'catastrophic', quote: 'the bridge carries ten thousand cars a day', note: 'n' }],
  }),
  { cues: ANALYSIS_CUES, durationSeconds: 400 }
)
assert.equal(severityFallback.flags[0].severity, 'medium')

// "Nothing wrong here" is a real answer and must survive parsing intact.
const clean = parseAnalysisResponse(
  JSON.stringify({ summary: 'Carefully sourced throughout.', flags: [] }),
  { cues: ANALYSIS_CUES, durationSeconds: 400 }
)
assert.equal(clean.flags.length, 0)
assert.equal(clean.summary, 'Carefully sourced throughout.')

// A reply that is not JSON at all yields no flags rather than throwing.
assert.deepEqual(parseAnalysisResponse('I could not review this.', { cues: [], durationSeconds: null }).flags, [])

// The cap holds.
const manyFlags = parseAnalysisResponse(
  JSON.stringify({
    summary: '',
    flags: Array.from({ length: 40 }, (_, index) => ({
      at: '0:11',
      kind: 'bias',
      severity: 'low',
      quote: 'the bridge carries ten thousand cars a day',
      note: `distinct note ${index}`,
    })),
  }),
  { cues: ANALYSIS_CUES, durationSeconds: 400 }
)
assert.equal(manyFlags.flags.length, MAX_FLAGS_PER_VIDEO)

// --- renderer subscription discipline ---------------------------------------

// Same rule, and the same reason, as the documents/library run states: one IPC
// listener app-wide, fanned out. The Tabloid page, the sidebar strip and every card
// want this state, and a listener each crosses Node's 10-listener threshold.
const componentsDir = new URL('./src/renderer/components/', import.meta.url)
const offenders = fs
  .readdirSync(componentsDir)
  .filter((name) => name.endsWith('.tsx'))
  .filter((name) => /tabloid\.onState\(/.test(fs.readFileSync(new URL(name, componentsDir), 'utf8')))
assert.deepEqual(offenders, [], 'components must subscribe via the useTabloidRun hook, not directly')

const tabloidHook = fs.readFileSync(new URL('./src/renderer/hooks/useTabloidRun.ts', import.meta.url), 'utf8')
assert.equal((tabloidHook.match(/tabloid\.onState\(/g) ?? []).length, 1, 'exactly one onState subscription app-wide')
assert.ok(/listeners\.size === 0 && unsubscribe/.test(tabloidHook), 'torn down when the last consumer unmounts')
assert.ok(/if \(!initialFetch\)/.test(tabloidHook), 'the initial getState is deduped across consumers')

// --- the embed contract ------------------------------------------------------

// Both of these are required for the player to appear at all, and missing either
// gives a BLANK FRAME with nothing in the console naming the cause: the CSP
// refusal is silent for frame-src, and will-frame-navigate preventDefault is too.
const csp = fs.readFileSync(new URL('./src/renderer/index.html', import.meta.url), 'utf8')
assert.match(csp, /frame-src[^;]*https:\/\/www\.youtube-nocookie\.com/, 'frame-src allows the embed origin')
assert.match(csp, /img-src[^;]*holmes-media:/, 'img-src allows cached thumbnails')

const mainSource = fs.readFileSync(new URL('./src/main/main.ts', import.meta.url), 'utf8')
assert.match(
  mainSource,
  /will-frame-navigate[\s\S]{0,900}youtube-nocookie\.com/,
  'will-frame-navigate allows the embed origin'
)

// The IFrame JS API would need https://www.youtube.com in script-src. The player
// is driven by raw postMessage precisely so that never has to happen.
assert.ok(!/script-src[^;]*youtube/.test(csp), 'script-src is never widened for YouTube')

// The third silent failure: without a Referer YouTube considers valid, the frame
// loads and then reports "Error 153 — Video player configuration error". Neither
// renderer origin supplies one (http://localhost is refused, file:// sends none),
// so it is injected in main.
assert.match(
  mainSource,
  /onBeforeSendHeaders[\s\S]{0,600}Referer['"\]]*\s*=\s*'https:\/\/www\.youtube\.com\/'/,
  'a valid Referer is injected for the embed'
)
assert.match(
  mainSource,
  /onBeforeSendHeaders[\s\S]{0,400}youtube-nocookie\.com/,
  'the header filter covers the embed origin'
)

// The origin parameter is the postMessage TARGET, not a declaration. Setting it
// to anything but this page's real origin silently breaks the time sync, and
// this page's real origin is exactly what YouTube will not accept.
const playerSource = fs.readFileSync(new URL('./src/renderer/components/TabloidPlayer.tsx', import.meta.url), 'utf8')
const embedParams = /new URLSearchParams\(\{[\s\S]*?\}\)/.exec(playerSource)?.[0] ?? ''
assert.ok(!/\borigin\b/.test(embedParams), 'the embed URL carries no origin parameter')

// --- the feed stacks, it does not replace ------------------------------------

// A refresh adds a batch above the last one. These live in SQL, so they are
// pinned by shape here rather than executed — the DB-backed suites cover the
// rest, and each of these is a silent regression if it drifts.
const dbSource = fs.readFileSync(new URL('./src/main/database.ts', import.meta.url), 'utf8')

// The batch number is derived, so pruning whole batches cannot desynchronise it
// from a stored counter.
assert.match(dbSource, /COALESCE\(MAX\(feed_batch\), 0\) AS max FROM tabloid_items/, 'batch is MAX+1')

// replaceTabloidFeedItems must hand back ONLY what it just wrote: the analysis pass
// iterates its return value, and returning the whole page would re-review every
// batch on screen on every refresh.
assert.match(
  dbSource,
  /export function replaceTabloidFeedItems[\s\S]*?return listTabloidItems\(\{ maxBatches: 1 \}\)/,
  'replaceTabloidFeedItems returns only the new batch'
)

// Reacted items are never pruned, wherever they sit. They are the taste record
// the next plan reads, not display history — a dislike from months ago still
// has to keep that video out of the feed.
const pruneBody = /export function pruneTabloidItems[\s\S]*?\n}/.exec(dbSource)?.[0] ?? ''
assert.ok(pruneBody.includes('reaction IS NULL'), 'pruning only ever removes unreacted items')
assert.ok(pruneBody.includes('feed_batch <='), 'pruning only reaches below the visible window')

// The visible window is a batch count, not a row count: pruning a partial batch
// would punch holes in a page the user is looking at.
assert.match(
  dbSource,
  /feed_batch > COALESCE\(\(SELECT MAX\(feed_batch\) FROM tabloid_items\), 0\) - \?/,
  'the visible window is expressed in batches'
)

// The page renders one section per batch, newest first.
const pageSource = fs.readFileSync(new URL('./src/renderer/components/TabloidPage.tsx', import.meta.url), 'utf8')
assert.match(pageSource, /batches\.map\(/, 'the page groups by batch')
assert.match(pageSource, /current\.batch === item\.batch/, 'grouping relies on the feed order, not a re-sort')

console.log('test-tabloid.mjs: all assertions passed')
