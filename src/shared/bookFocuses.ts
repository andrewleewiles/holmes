// The lenses a book can be annotated under.
//
// Pure — no runtime imports — so it can be unit-tested without the module
// bootstrap, and so the renderer can render the picker from the same list the
// main process generates from.

export type AnnotationFocusKey =
  | 'key_arguments'
  | 'definitions'
  | 'evidence'
  | 'counterarguments'
  | 'style'
  | 'personal_relevance'
  | 'custom'

export interface AnnotationFocus {
  key: AnnotationFocusKey
  label: string
  description: string
  /** Tailwind colour stem; each focus underlines in its own hue. */
  accent: string
}

export const ANNOTATION_FOCUSES: readonly AnnotationFocus[] = [
  {
    key: 'key_arguments',
    label: 'Key arguments',
    description: 'The claims the text is actually making, and what each one rests on.',
    accent: 'violet',
  },
  {
    key: 'definitions',
    label: 'Definitions & terms',
    description: 'Terms the text defines or uses in a particular way.',
    accent: 'sky',
  },
  {
    key: 'evidence',
    label: 'Evidence & citations',
    description: 'Data, studies, examples and sources offered in support.',
    accent: 'emerald',
  },
  {
    key: 'counterarguments',
    label: 'Counterarguments',
    description: 'Objections raised, conceded, answered — or conspicuously not raised.',
    accent: 'amber',
  },
  {
    key: 'style',
    label: 'Style & craft',
    description: 'How the writing works: structure, rhetoric, imagery, voice.',
    accent: 'rose',
  },
  {
    key: 'personal_relevance',
    label: 'Personal relevance',
    description: 'Passages worth returning to, acting on, or arguing with.',
    accent: 'cyan',
  },
  {
    key: 'custom',
    label: 'Custom focus',
    description: 'Describe your own lens in your own words.',
    accent: 'slate',
  },
] as const

export function annotationFocus(key: string): AnnotationFocus | null {
  return ANNOTATION_FOCUSES.find((focus) => focus.key === key) ?? null
}

export interface ParsedAnnotation {
  kind: string
  label: string
  quote: string
  note: string
}

/**
 * Parses the `ANNOTATIONS:` block, in the pipe convention the TIMELINE and
 * PEOPLE blocks already use.
 *
 * Deliberately tolerant, and deliberately not JSON: the payload is a VERBATIM
 * quote, and JSON escaping of long quotes carrying curly quotes, em-dashes and
 * newlines is exactly where models fail. A line that cannot be read is skipped
 * rather than throwing away the whole run.
 */
export function parseAnnotationBlock(text: string): ParsedAnnotation[] {
  const marker = text.search(/^\s*ANNOTATIONS:\s*$/mi)
  const body = marker === -1 ? text : text.slice(marker)
  const out: ParsedAnnotation[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('-')) continue
    const parts = line.slice(1).split('|').map((part) => part.trim())
    if (parts.length < 3) continue
    const [kind, label, quote, ...rest] = parts
    if (!quote) continue
    out.push({
      kind: kind || 'note',
      label: label || kind || 'Note',
      quote,
      // A note containing a pipe is rejoined rather than truncated.
      note: rest.join(' | ').trim(),
    })
  }
  return out
}

export function stripAnnotationBlock(text: string): string {
  const marker = text.search(/^\s*ANNOTATIONS:\s*$/mi)
  return marker === -1 ? text.trim() : text.slice(0, marker).trim()
}
