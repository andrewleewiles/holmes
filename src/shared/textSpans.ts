/**
 * Splitting a string into runs by a set of marked spans.
 *
 * Two callers with different needs, one algorithm:
 *  - `ProvenanceText` marks cited claims, which are non-overlapping and ordered
 *    by construction.
 *  - the book reader marks annotations, which are NOT: two annotation runs under
 *    different focuses will happily underline overlapping sentences, and a
 *    naive splitter would drop one of them.
 *
 * So a segment carries the SET of spans active over it, and a boundary sweep
 * produces them. With non-overlapping input the output is identical to a simple
 * ordered walk, which is what makes this safe to put underneath the existing
 * provenance rendering.
 */
export interface TextSpan {
  id: string
  start: number
  end: number
}

export interface SpanSegment {
  text: string
  /** Ids of every span covering this run, in the order the spans were given. */
  spanIds: string[]
  key: string
}

export function buildSpanSegments(text: string, spans: TextSpan[], shift = 0): SpanSegment[] {
  if (text.length === 0) return []

  // Clamp into the text, drop anything that lands entirely outside it, and keep
  // the caller's ordering so "first span wins" is stable for colour choices.
  const placed = spans
    .map((span, index) => ({
      id: span.id,
      order: index,
      start: Math.max(0, Math.min(text.length, span.start + shift)),
      end: Math.max(0, Math.min(text.length, span.end + shift)),
    }))
    .filter((span) => span.end > span.start)

  if (placed.length === 0) return [{ text, spanIds: [], key: 'all' }]

  const boundaries = new Set<number>([0, text.length])
  for (const span of placed) {
    boundaries.add(span.start)
    boundaries.add(span.end)
  }
  const points = [...boundaries].sort((left, right) => left - right)

  const segments: SpanSegment[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]
    const to = points[i + 1]
    if (to <= from) continue
    const active = placed
      .filter((span) => span.start <= from && span.end >= to)
      .sort((left, right) => left.order - right.order)
    segments.push({
      text: text.slice(from, to),
      spanIds: active.map((span) => span.id),
      key: `${from}-${to}`,
    })
  }
  return segments
}
