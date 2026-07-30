import type { CitedSource } from '@shared/types'

/**
 * Turns the `[S1]` markers Holmes writes into pill elements, in the rendered
 * tree rather than in the message text.
 *
 * The stored message keeps exactly what the model said — markers and all — so
 * nothing here is destructive and a copied response still carries its
 * attributions. What this does decide is what the reader sees: a marker whose id
 * the turn never minted is dropped rather than shown, because the ids come from
 * Holmes's own tool results and the model can only point at them. An id that
 * resolves to nothing was therefore invented, and printing a raw "[S7]" would
 * dress up a fabrication as a citation.
 */

// Structural subset of hast, declared locally: @types/hast is only here
// transitively through react-markdown, and this is the whole shape we touch.
interface HastText {
  type: 'text'
  value: string
}

interface HastElement {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }

interface HastParent {
  type: string
  children: HastNode[]
}

/** Code is quoted verbatim, so a marker inside it is content, not a citation. */
const SKIP_TAGS = new Set(['code', 'pre'])

/**
 * One capture group, so `split` returns the ids interleaved with the surrounding
 * text: ['The window is 30 days ', 'S2', '.'].
 */
const MARKER_SPLIT = /\[(S\d{1,3})\]/

/** A marker the model has started but not finished writing, at the very end. */
const TRAILING_PARTIAL_MARKER = /\[S\d{0,3}$/

function isParent(node: HastNode): node is HastParent {
  return 'children' in node && Array.isArray((node as HastParent).children)
}

function isText(node: HastNode): node is HastText {
  return node.type === 'text' && typeof (node as HastText).value === 'string'
}

/**
 * Hides a half-written marker while a response streams in, so the reader never
 * watches a "[S" appear and then rearrange itself into a pill. Anchored to the
 * end and requires the S, so a lone bracket in prose is left alone.
 */
export function stripTrailingPartialMarker(content: string): string {
  return content.replace(TRAILING_PARTIAL_MARKER, '')
}

export function hasSourceMarker(content: string): boolean {
  return MARKER_SPLIT.test(content)
}

/**
 * A rehype plugin, bound to the sources of one message.
 *
 * Emits anchors carrying `data-source-id` rather than a bespoke tag name, so
 * MarkdownRenderer can intercept them through the `a` component it already
 * overrides — and so a pill still renders as a plain link if that override is
 * ever removed.
 */
export function rehypeSourcePills(sources: CitedSource[]) {
  const byId = new Map(sources.map((source) => [source.id, source]))

  function pill(id: string, label: string): HastElement {
    return {
      type: 'element',
      tagName: 'a',
      properties: { 'data-source-id': id },
      children: [{ type: 'text', value: label }],
    }
  }

  function visit(node: HastNode): void {
    if (!isParent(node)) return
    if (node.type === 'element' && SKIP_TAGS.has((node as HastElement).tagName)) return

    const rebuilt: HastNode[] = []
    let replaced = false

    for (const child of node.children) {
      if (!isText(child)) {
        visit(child)
        rebuilt.push(child)
        continue
      }

      const parts = child.value.split(MARKER_SPLIT)
      if (parts.length === 1) {
        rebuilt.push(child)
        continue
      }
      replaced = true

      // Dropping a marker has to close the gap it leaves behind, or "read [S9]."
      // becomes "read ." and the fabrication is replaced by a typo.
      let pendingDrop = false

      parts.forEach((part, index) => {
        // Odd indexes are the captured ids; the rest is the text around them.
        if (index % 2 === 1) {
          const source = byId.get(part)
          if (source) {
            rebuilt.push(pill(source.id, source.label))
            return
          }
          pendingDrop = true
          const previous = rebuilt[rebuilt.length - 1]
          if (previous && isText(previous)) previous.value = previous.value.replace(/ $/, '')
          return
        }

        let text = part
        if (pendingDrop) {
          pendingDrop = false
          // Only when there was no preceding text to trim instead, so the two
          // sides of a dropped marker never both give up their space.
          const previous = rebuilt[rebuilt.length - 1]
          if (!previous || !isText(previous)) text = text.replace(/^ /, '')
        }
        if (text) rebuilt.push({ type: 'text', value: text })
      })
    }

    if (replaced) node.children = rebuilt
  }

  return function plugin() {
    return function transform(tree: HastNode): void {
      visit(tree)
    }
  }
}
