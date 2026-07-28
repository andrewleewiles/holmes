export const TOKEN_ESTIMATE_DISCLAIMER = 'Approximate — every model tokenizes differently'

const WHITESPACE = /\s/
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_]/u
const CJK_CHAR =
  /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏ㇰ-ㇿ㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/

type CharClass = 'space' | 'word' | 'cjk' | 'other'

function classify(char: string): CharClass {
  if (WHITESPACE.test(char)) return 'space'
  if (CJK_CHAR.test(char)) return 'cjk'
  if (WORD_CHAR.test(char)) return 'word'
  return 'other'
}

function runCost(kind: CharClass, length: number): number {
  switch (kind) {
    case 'word':
      return Math.ceil((length + 1) / 6)
    case 'cjk':
      return length
    case 'space':
      return Math.max(0, length - 1) * 0.5
    case 'other':
      return length * 0.5
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  let total = 0
  let index = 0
  while (index < text.length) {
    const kind = classify(text[index])
    let end = index + 1
    while (end < text.length && classify(text[end]) === kind) end += 1
    total += runCost(kind, end - index)
    index = end
  }
  return Math.max(1, Math.round(total))
}

export function estimateBlockTokens(blocks: ReadonlyArray<{ content: string }>): number[] {
  return blocks.map((block) => estimateTokens(block.content))
}

export function estimateTotalTokens(blocks: ReadonlyArray<{ content: string }>): number {
  return estimateBlockTokens(blocks).reduce((sum, tokens) => sum + tokens, 0)
}

export function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`
  return `${Math.round(tokens / 1000)}k`
}
