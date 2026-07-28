export type GenerationIntentKind = 'image' | 'video'

export interface GenerationIntent {
  kind: GenerationIntentKind
  prompt: string
  matched: string
}

const MAX_INTENT_LENGTH = 1500

const VERBS = [
  'generate',
  'create',
  'make',
  'draw',
  'paint',
  'render',
  'illustrate',
  'sketch',
  'produce',
  'design',
  'animate',
]

const IMAGE_NOUNS = [
  'image',
  'images',
  'picture',
  'pictures',
  'pic',
  'pics',
  'photo',
  'photos',
  'photograph',
  'photographs',
  'illustration',
  'illustrations',
  'drawing',
  'drawings',
  'painting',
  'paintings',
  'artwork',
  'poster',
  'posters',
  'wallpaper',
  'wallpapers',
  'portrait',
  'portraits',
  'logo',
  'logos',
  'sketch',
  'sketches',
  'render',
  'rendering',
  'mockup',
  'thumbnail',
  'thumbnails',
]

const VIDEO_NOUNS = [
  'video',
  'videos',
  'clip',
  'clips',
  'animation',
  'animations',
  'movie',
  'movies',
  'film',
  'films',
  'gif',
  'gifs',
  'reel',
  'reels',
]

const FILLER_WORDS = new Set([
  'me',
  'us',
  'a',
  'an',
  'the',
  'some',
  'one',
  'two',
  'three',
  'another',
  'new',
  'quick',
  'short',
  'small',
  'large',
  'simple',
  'nice',
  'cool',
  'realistic',
  'detailed',
  'stylized',
  'cute',
  'funny',
  'my',
  'your',
  'our',
  'for',
  'couple',
  'few',
  'pair',
  'of',
  'brief',
  'high',
  'quality',
  'hd',
  '2',
  '3',
  '4',
])

const POST_NOUN_CONNECTORS = new Set([
  'of',
  'showing',
  'showcasing',
  'depicting',
  'featuring',
  'illustrating',
  'representing',
  'containing',
  'with',
  'that',
  'which',
  'where',
  'from',
  'in',
  'into',
  'for',
  'about',
  'based',
  'inspired',
  'like',
  'using',
  'set',
  'please',
  'now',
  'quickly',
  'thanks',
  'too',
  'again',
  'asap',
])

const TECHNICAL_CONTEXT = /\b(code|codebase|function|functions|script|scripts|component|components|html|css|svg|react|typescript|javascript|python|api|endpoint|regex|sql|schema|migration|json|yaml|xml|test|tests|commit|pull request|repo|repository|terminal|shell|bash|npm|docker|prompt|prompts|caption|captions|alt text|placeholder|url|urls|link|links|tag|tags)\b/

const NEGATION = /\b(don'?t|do not|never|without|stop|avoid|instead of|rather than|no need to|not to)\b/

const QUESTION_LEAD = /^(?:how|what|what'?s|why|when|where|who|which|whether)\b/

const NON_REQUEST_QUESTION = /^(?:do|does|did|is|are|was|were|should|shall|has|have|had|may|might)\s+(?:i|we|it|they|he|she|that|this|there|holmes|you)\b/

const REQUEST_PREFIX = new RegExp(
  '^' +
  '(?:(?:hey|hi|hello|ok|okay|yo|holmes)[,\\s]+)*' +
  '(?:please\\s+|pls\\s+)?' +
  '(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?' +
  '(?:' +
    '(?:i\\s+(?:want|need)\\s+(?:you\\s+to\\s+)?)' +
    '|(?:i(?:\'d|\\s+would)\\s+like\\s+(?:you\\s+to\\s+)?)' +
    '|(?:you\\s+should\\s+)' +
    '|(?:let\'?s\\s+)' +
    '|(?:help\\s+me\\s+)' +
    '|(?:try\\s+(?:to\\s+)?)' +
    '|(?:go\\s+ahead\\s+and\\s+)' +
    '|(?:just\\s+)' +
  ')?' +
  '(?:please\\s+|pls\\s+)?' +
  '$'
)

interface Token {
  word: string
  start: number
  end: number
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function tokenize(lower: string): Token[] {
  const tokens: Token[] = []
  const pattern = /[a-z0-9']+/g
  let match = pattern.exec(lower)
  while (match) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length })
    match = pattern.exec(lower)
  }
  return tokens
}

function isRequestPosition(before: string): boolean {
  const clauses = before.split(/[.!?;:\n]|,\s*|\band\b|\bthen\b|\balso\b/)
  const clause = normalize(clauses[clauses.length - 1] ?? '')
  if (!clause) return true
  if (NEGATION.test(clause)) return false
  return REQUEST_PREFIX.test(`${clause} `)
}

function isDescriptiveTail(lower: string, tokens: Token[], nounIndex: number): boolean {
  const noun = tokens[nounIndex]
  const nextChar = lower[noun.end]
  if (nextChar === undefined) return true
  if (nextChar !== ' ') return true
  const next = tokens[nounIndex + 1]
  if (!next) return true
  return POST_NOUN_CONNECTORS.has(next.word)
}

interface NounHit {
  kind: GenerationIntentKind
  index: number
  matched: string
}

function findNounAfterVerb(lower: string, tokens: Token[], verbIndex: number): NounHit | null {
  for (let offset = 1; offset <= 4; offset += 1) {
    const index = verbIndex + offset
    if (index >= tokens.length) return null
    const word = tokens[index].word
    const isVideo = VIDEO_NOUNS.includes(word)
    const isImage = IMAGE_NOUNS.includes(word)
    if (isVideo || isImage) {
      if (!isDescriptiveTail(lower, tokens, index)) return null
      const matched = tokens.slice(verbIndex, index + 1).map((token) => token.word).join(' ')
      return { kind: isVideo ? 'video' : 'image', index, matched }
    }
    if (!FILLER_WORDS.has(word)) return null
  }
  return null
}

export function detectGenerationIntent(rawText: string): GenerationIntent | null {
  if (typeof rawText !== 'string') return null
  const text = normalize(rawText)
  if (!text || text.length > MAX_INTENT_LENGTH) return null
  if (text.includes('```')) return null

  const lower = text.toLowerCase()
  if (TECHNICAL_CONTEXT.test(lower)) return null
  if (QUESTION_LEAD.test(lower)) return null
  if (NON_REQUEST_QUESTION.test(lower)) return null

  const tokens = tokenize(lower)

  let best: NounHit | null = null

  for (let i = 0; i < tokens.length; i += 1) {
    if (!VERBS.includes(tokens[i].word)) continue
    const hit = findNounAfterVerb(lower, tokens, i)
    if (!hit) continue
    if (!isRequestPosition(lower.slice(0, tokens[i].start))) continue
    if (!best || hit.index < best.index) best = hit
  }

  if (!best) return null

  return { kind: best.kind, prompt: text, matched: best.matched }
}
