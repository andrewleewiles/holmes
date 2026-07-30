import path from 'path'
import type { CitedSource, ToolResult } from '../shared/types'

/**
 * Turning tool results into numbered, citable sources.
 *
 * The contract is deliberately one-directional: ids are minted HERE, from tool
 * results Holmes ran itself, and handed to the model inside the result it is
 * already reading. The model can only point at them. It can never mint one — so a
 * marker in its prose either matches a source the turn really read, or is
 * provably invented and gets dropped before the user sees it. This is the same
 * rule the document-context claim markers follow (see documentContext.ts).
 */

/** How many sources one conversation may number. Past this, results stay uncited. */
const MAX_SOURCES = 200

/**
 * Paths Holmes has recorded as a file source, and will therefore open on click.
 *
 * Process-wide rather than per-window (as Recall's equivalent is) because a chat
 * source stays openable for as long as the message is on screen, across window
 * reloads and branch switches. Scope is still enforced at open time by
 * assertPathAllowed — this set only limits WHICH files a pill may name.
 */
const openableSourcePaths = new Set<string>()
const MAX_OPENABLE_PATHS = 5_000

export function rememberOpenableSourcePaths(sources: CitedSource[]): void {
  for (const source of sources) {
    if (!source.path) continue
    // A bounded set that forgets its oldest entries: Set preserves insertion
    // order, so the first key is the least recently recorded.
    if (openableSourcePaths.size >= MAX_OPENABLE_PATHS) {
      const oldest = openableSourcePaths.values().next().value
      if (oldest !== undefined) openableSourcePaths.delete(oldest)
    }
    openableSourcePaths.add(source.path)
  }
}

export function isOpenableSourcePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false
  return openableSourcePaths.has(path.resolve(filePath))
}

/** The hostname a pill shows, or null if this is not a web URL worth linking. */
export function citableHost(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.hostname.replace(/^www\./i, '') || null
  } catch {
    return null
  }
}

function firstLine(value: unknown, limit = 120): string {
  if (typeof value !== 'string') return ''
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The registry for one turn, seeded with what the conversation has already read.
 *
 * Numbering has to be per conversation rather than per turn, because the model
 * replays earlier turns' tool results in its history and can re-cite an id from
 * one. If each turn restarted at S1 that stale `[S1]` would resolve against a
 * different page — and a citation pointing at the wrong source is worse than no
 * citation at all, because it looks checked.
 */
export interface TurnCitations {
  /**
   * Numbers whatever `result` cites and rewrites its content so each entry
   * carries its own id. Returns the rewritten content — the caller stores and
   * sends that, so the model and the database agree on the numbering.
   */
  annotate: (result: ToolResult) => string
  /** Everything the conversation has read up to now, in id order. */
  list: () => CitedSource[]
}

/**
 * @param known Sources already recorded on this conversation's active branch.
 *   Their ids are kept exactly as they were, and new sources number on from the
 *   highest one, so an id never changes meaning mid-conversation.
 */
export function createTurnCitations(known: CitedSource[] = []): TurnCitations {
  const sources: CitedSource[] = []
  // Keyed by url/path so the same page read in two rounds keeps one number.
  const byKey = new Map<string, CitedSource>()
  const usedIds = new Set<string>()
  let nextIndex = 1

  for (const source of known) {
    // Advanced past every seeded id, including the ones dropped below: the model
    // was shown those numbers too, so handing one to a different source later
    // would silently re-point a citation it may already have written.
    const index = Number(/^S(\d+)$/.exec(source.id)?.[1])
    if (Number.isFinite(index) && index >= nextIndex) nextIndex = index + 1

    const key = source.url || source.path
    // Malformed, or a duplicate of one already seeded: the first id wins, since
    // that is the one the model was shown and may already have cited.
    if (!key || byKey.has(key) || usedIds.has(source.id)) continue
    sources.push(source)
    byKey.set(key, source)
    usedIds.add(source.id)
  }

  function mint(candidate: Omit<CitedSource, 'id'>): CitedSource | null {
    const key = candidate.url || candidate.path
    if (!key) return null
    const existing = byKey.get(key)
    if (existing) return existing
    if (sources.length >= MAX_SOURCES) return null
    const source: CitedSource = { ...candidate, id: `S${nextIndex}` }
    nextIndex += 1
    sources.push(source)
    byKey.set(key, source)
    usedIds.add(source.id)
    return source
  }

  function citeWebEntry(entry: Record<string, unknown>, tool: string): CitedSource | null {
    const host = citableHost(entry.url)
    if (!host) return null
    const title = firstLine(entry.title) || host
    return mint({ kind: 'web', label: host, title, url: String(entry.url), tool })
  }

  function citeFileEntry(entry: Record<string, unknown>, tool: string): CitedSource | null {
    const raw = entry.path
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) return null
    const resolved = path.resolve(raw)
    const base = path.basename(resolved)
    return mint({
      kind: 'file',
      label: base,
      title: firstLine(entry.title) || base,
      path: resolved,
      tool,
    })
  }

  /**
   * Marks up the entries of a `{ results: [...] }` payload in place, using
   * `cite` to carry each id. Returns how many were numbered.
   */
  function citeResultList(
    payload: Record<string, unknown>,
    tool: string,
    citeEntry: (entry: Record<string, unknown>, tool: string) => CitedSource | null,
  ): number {
    if (!Array.isArray(payload.results)) return 0
    let numbered = 0
    for (const entry of payload.results) {
      if (!isRecord(entry)) continue
      const source = citeEntry(entry, tool)
      if (!source) continue
      entry.cite = source.id
      numbered += 1
    }
    return numbered
  }

  return {
    annotate(result: ToolResult): string {
      if (result.error) return result.content
      let payload: unknown
      try {
        payload = JSON.parse(result.content)
      } catch {
        // Not every tool returns JSON, and one that does not simply has nothing
        // citable — the content goes to the model untouched.
        return result.content
      }
      if (!isRecord(payload)) return result.content

      let numbered = 0
      switch (result.name) {
        case 'web_search':
          numbered = citeResultList(payload, result.name, citeWebEntry)
          break
        case 'search_files':
          numbered = citeResultList(payload, result.name, citeFileEntry)
          break
        case 'read_file': {
          const source = citeFileEntry(payload, result.name)
          if (source) {
            payload.cite = source.id
            numbered = 1
          }
          break
        }
        default:
          // Every other tool acts on the user's own workspace rather than
          // reporting a source, so there is nothing to attribute.
          return result.content
      }

      if (numbered === 0) return result.content
      return JSON.stringify(payload)
    },

    list(): CitedSource[] {
      return sources.slice()
    },
  }
}
