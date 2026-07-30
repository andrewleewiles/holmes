/**
 * Search over the contexts Holmes has already generated.
 *
 * The index hierarchy — file → folder → source root → project → user — is built
 * to be *injected*: a conversation gets the root or the apex synthesis and
 * nothing else. That leaves everything below the root unreachable, so a question
 * about one file or one folder is answered from a summary of a summary when the
 * specific context for it is sitting in the database. This module makes those
 * nodes findable, by topic or by path, without re-reading a single source file.
 *
 * Retrieval is two-stage on purpose. The two big tables go through FTS5, which
 * is the only thing that scales to a photo project's tens of thousands of rows;
 * the small tables (project syntheses, the apex, conversation contexts) are read
 * whole. Everything that comes back is then scored by ONE scorer here, because
 * bm25 and a hand-rolled score are different scales and mixing them ranks by
 * which table a hit came from rather than by how well it matches.
 */

import * as database from './database'
// The canonical sentinel list — `documentContext.ts` keeps a local copy, but the
// shared one is the contract and carries the apex "Unified synthesis
// unavailable." marker too.
import { isFailedContext } from '../shared/contextVersions'
import { isLibraryProject, isVideoProject } from '../shared/defaultProjects'
import type { DocumentContextMatch } from './database'
import type { Project } from '../shared/types'

/** Where in the hierarchy a hit sits. `sourceRoot` is a project's top folder. */
export type ContextSearchLevel = 'file' | 'folder' | 'sourceRoot' | 'project' | 'user' | 'conversation'

export interface ContextSearchHit {
  level: ContextSearchLevel
  /** Absolute file or folder path; null for the levels that are not a place on disk. */
  path: string | null
  /** Human label: the relative path, the project name, or the conversation title. */
  label: string
  projectId: string | null
  projectName: string | null
  /** Photo contexts come from a vision pass over the image rather than its text. */
  kind: 'text' | 'image' | null
  /** The generated context itself, capped. This is the payload — not a pointer to it. */
  context: string
  /** The folder-level one-paragraph version, where the level stores one. */
  contextShort: string
  /** Files beneath this node; 1 for a file. */
  fileCount: number
  score: number
  updatedAt: string
  conversationId: string | null
}

export interface ContextSearchOptions {
  limit?: number
  /** Restrict to one or more levels, e.g. only folders and roots. */
  levels?: ContextSearchLevel[]
  /** Restrict to one project. */
  projectId?: string
  /** Characters of context text returned per hit. */
  maxContextChars?: number
}

export interface ContextSearchOutcome {
  query: string
  terms: string[]
  hits: ContextSearchHit[]
  /** True when there is nothing indexed at all — a different answer from "no matches". */
  empty: boolean
  notice?: string
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 40
const DEFAULT_MAX_CONTEXT_CHARS = 6_000
/** Retrieval width per big table: enough that the JS rescore can reorder meaningfully. */
const FTS_CANDIDATES = 120
const MAX_CONVERSATION_CONTEXTS = 400
const MAX_QUERY_TERMS = 12
/** No more than this many file hits from any one folder, so one directory cannot fill the page. */
const MAX_FILES_PER_FOLDER = 3

const STOP_WORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'get', 'had', 'has', 'have', 'he', 'her', 'him',
  'his', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or', 'our',
  'out', 'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
])

/**
 * A synthesis is worth more than one leaf for a topic question — it is the
 * level that already did the comparing — but only enough to break near-ties.
 * Weighted higher than this, an apex context that mentions everything would win
 * every search and bury the specific evidence the question was about.
 */
const LEVEL_WEIGHT: Record<ContextSearchLevel, number> = {
  file: 1,
  conversation: 1.05,
  folder: 1.15,
  sourceRoot: 1.2,
  project: 1.25,
  user: 1.25,
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function tokenizeContextQuery(query: string): string[] {
  const tokens = normalize(query).toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []
  const kept: string[] = []
  for (const token of tokens) {
    const trimmed = token.replace(/^['-]+|['-]+$/g, '')
    if (trimmed.length < 2 || STOP_WORDS.has(trimmed)) continue
    if (!kept.includes(trimmed)) kept.push(trimmed)
    if (kept.length >= MAX_QUERY_TERMS) break
  }
  return kept
}

/**
 * Turns a natural-language question into an FTS5 MATCH expression.
 *
 * OR rather than AND: a question carries words the answer never contains
 * ("favorite", "roughly"), and one absent word must not zero the whole query —
 * the rescore below is what decides how much of the question was actually met.
 * Every token is double-quoted so nothing the user typed can be read as FTS
 * syntax, and tokens of three characters or more get a prefix wildcard so
 * "run" reaches "running" without "car" reaching "career".
 */
export function buildContextMatchExpression(terms: string[]): string {
  const clauses = terms
    .map((term) => term.replace(/"/g, ''))
    .filter(Boolean)
    .map((term) => (term.length >= 3 ? `"${term}"*` : `"${term}"`))
  return clauses.join(' OR ')
}

interface Scorable {
  text: string
  label: string
}

/**
 * One score for every level, so hits can be compared across tables.
 *
 * Coverage dominates: a context that touches five of the six question words is
 * a better answer than one that repeats a single word thirty times, and squaring
 * it makes that decisive rather than advisory.
 */
export function scoreContextMatch(candidate: Scorable, terms: string[]): number {
  if (terms.length === 0) return 0
  const haystack = candidate.text.toLocaleLowerCase()
  const label = candidate.label.toLocaleLowerCase()

  let matched = 0
  let hits = 0
  let labelHits = 0
  for (const term of terms) {
    const occurrences = countOccurrences(haystack, term)
    const inLabel = label.includes(term)
    if (occurrences === 0 && !inLabel) continue
    matched += 1
    hits += occurrences
    if (inLabel) labelHits += 1
  }
  if (matched === 0) return 0

  const coverage = matched / terms.length
  const density = 1 + Math.log1p(hits)
  // A name match is strong evidence on its own: "the Training folder" should
  // find the folder called Training even if its summary never says the word.
  const labelBonus = 1 + Math.min(0.4, labelHits * 0.2)
  return coverage * coverage * density * labelBonus
}

function countOccurrences(haystack: string, term: string): number {
  if (!term) return 0
  let count = 0
  let index = haystack.indexOf(term)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(term, index + term.length)
  }
  return count
}

interface ProjectMeta {
  name: string
  searchable: boolean
}

/**
 * Which projects a search may return.
 *
 * A hidden source is hidden here too, the same rule the indexer applies when it
 * skips one — an eye toggle that only changed the Data page would be cosmetic.
 * Books and archived video are excluded for the stronger reason: their text is
 * deliberately not part of the profile, so it must not become searchable by a
 * side door either.
 */
function projectMetadata(projects: Project[], onlyProjectId?: string): Map<string, ProjectMeta> {
  const meta = new Map<string, ProjectMeta>()
  for (const project of projects) {
    meta.set(project.id, {
      name: project.name,
      searchable: project.visible
        && !isLibraryProject(project)
        && !isVideoProject(project)
        && (!onlyProjectId || project.id === onlyProjectId),
    })
  }
  return meta
}

function clampContext(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars).trimEnd()}…`
}

export function hasGeneratedContexts(): boolean {
  const counts = database.countGeneratedContexts()
  return counts.files + counts.folders + counts.projects + counts.conversations > 0
}

/**
 * Search every generated context by topic.
 *
 * Returns the context text itself rather than a pointer to it: the caller — a
 * chat tool round, or a Recall result — needs the reading, and re-fetching it
 * would cost another round trip for text that is already in hand.
 */
export function searchGeneratedContexts(query: string, options: ContextSearchOptions = {}): ContextSearchOutcome {
  const terms = tokenizeContextQuery(query)
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
  const maxContextChars = Math.max(200, options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS)
  const levels = options.levels && options.levels.length > 0 ? new Set(options.levels) : null
  const wants = (level: ContextSearchLevel): boolean => !levels || levels.has(level)

  const counts = database.countGeneratedContexts()
  const empty = counts.files + counts.folders + counts.projects + counts.conversations === 0
  if (empty) {
    return {
      query,
      terms,
      hits: [],
      empty: true,
      notice: 'Nothing has been indexed yet. Contexts are generated from the Data page ("Index all") or by the hourly sweep.',
    }
  }
  if (terms.length === 0) {
    return { query, terms, hits: [], empty: false, notice: 'The query had no searchable words.' }
  }

  const meta = projectMetadata(database.listProjects(), options.projectId)
  const scored: ContextSearchHit[] = []
  let notice: string | undefined
  const push = (hit: Omit<ContextSearchHit, 'score'>, scorable: Scorable): void => {
    const base = scoreContextMatch(scorable, terms)
    if (base <= 0) return
    scored.push({ ...hit, score: base * LEVEL_WEIGHT[hit.level] })
  }

  const wantsDocumentLevels = wants('file') || wants('folder') || wants('sourceRoot')
  if (wantsDocumentLevels) {
    const match = buildContextMatchExpression(terms)
    const candidates: DocumentContextMatch[] = []
    if (database.hasContextSearchIndex()) {
      if (wants('file')) candidates.push(...database.searchDocumentFileContexts(match, FTS_CANDIDATES))
      if (wants('folder') || wants('sourceRoot')) {
        candidates.push(...database.searchDocumentFolderContexts(match, FTS_CANDIDATES))
      }
    } else {
      // The syntheses are still searchable without it, so say what was skipped
      // rather than returning nothing at all.
      notice = 'The file and folder search index is unavailable; only project-level syntheses were searched.'
    }

    for (const candidate of candidates) {
      const projectMeta = meta.get(candidate.projectId)
      if (!projectMeta?.searchable) continue
      if (isFailedContext(candidate.context)) continue
      // A folder row whose relative path is '.' IS the source root, and reads as
      // one in the results rather than as a folder called '.'.
      const level: ContextSearchLevel = candidate.level === 'folder'
        ? (candidate.relativePath === '.' ? 'sourceRoot' : 'folder')
        : 'file'
      if (!wants(level)) continue
      const label = level === 'sourceRoot' ? `${projectMeta.name} — ${candidate.path}` : candidate.relativePath
      push(
        {
          level,
          path: candidate.path,
          label,
          projectId: candidate.projectId,
          projectName: projectMeta.name,
          kind: candidate.kind,
          context: clampContext(candidate.context, maxContextChars),
          contextShort: candidate.contextShort,
          fileCount: candidate.fileCount,
          updatedAt: candidate.updatedAt,
          conversationId: null,
        },
        { text: `${candidate.contextShort}\n${candidate.context}`, label: `${candidate.relativePath} ${projectMeta.name}` }
      )
    }
  }

  if (wants('project')) {
    for (const summary of database.listProjectSuperContexts()) {
      const projectMeta = meta.get(summary.projectId)
      if (!projectMeta?.searchable) continue
      push(
        {
          level: 'project',
          path: null,
          label: projectMeta.name,
          projectId: summary.projectId,
          projectName: projectMeta.name,
          kind: null,
          context: clampContext(summary.context, maxContextChars),
          contextShort: summary.contextShort,
          fileCount: summary.fileCount,
          updatedAt: summary.updatedAt,
          conversationId: null,
        },
        { text: `${summary.contextShort}\n${summary.context}`, label: projectMeta.name }
      )
    }
  }

  // The apex belongs to no single project, so a project-scoped search skips it.
  if (wants('user') && !options.projectId) {
    const apex = database.getUserSuperContext()
    if (apex && apex.context.trim()) {
      push(
        {
          level: 'user',
          path: null,
          label: 'Unified model of the user',
          projectId: null,
          projectName: null,
          kind: null,
          context: clampContext(apex.context, maxContextChars),
          contextShort: apex.contextShort,
          fileCount: 0,
          updatedAt: apex.updatedAt ?? '',
          conversationId: null,
        },
        { text: `${apex.contextShort}\n${apex.context}`, label: 'user profile unified model' }
      )
    }
  }

  if (wants('conversation')) {
    const conversations = options.projectId
      ? database.listProjectConversationContexts(options.projectId)
      : database.listAllConversationContexts(MAX_CONVERSATION_CONTEXTS)
    for (const conversation of conversations) {
      push(
        {
          level: 'conversation',
          path: null,
          label: conversation.title || 'Untitled conversation',
          projectId: null,
          projectName: null,
          kind: null,
          context: clampContext(conversation.context, maxContextChars),
          contextShort: conversation.contextShort,
          fileCount: 0,
          updatedAt: conversation.updatedAt,
          conversationId: conversation.conversationId,
        },
        { text: `${conversation.contextShort}\n${conversation.context}`, label: conversation.title || '' }
      )
    }
  }

  return {
    query,
    terms,
    hits: selectDiverseHits(scored, limit),
    empty: false,
    ...(notice ? { notice } : {}),
  }
}

/**
 * Rank, then thin out same-folder runs.
 *
 * Without this a query that matches one directory's naming convention returns
 * ten siblings and hides every other part of the picture; the capped-out files
 * are still reachable by asking about that folder directly.
 */
export function selectDiverseHits(hits: ContextSearchHit[], limit: number): ContextSearchHit[] {
  const ranked = [...hits].sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
  const perFolder = new Map<string, number>()
  const selected: ContextSearchHit[] = []
  const deferred: ContextSearchHit[] = []

  for (const hit of ranked) {
    if (hit.level !== 'file' || !hit.path) {
      selected.push(hit)
      continue
    }
    const folder = hit.path.slice(0, hit.path.lastIndexOf('/') + 1)
    const taken = perFolder.get(folder) ?? 0
    if (taken >= MAX_FILES_PER_FOLDER) {
      deferred.push(hit)
      continue
    }
    perFolder.set(folder, taken + 1)
    selected.push(hit)
  }

  // Both lists are already in score order, and they are concatenated rather than
  // re-sorted together: a re-sort would let a high-scoring fourth sibling back in
  // ahead of the diverse hit the cap was there to protect. The overflow only
  // appears when the page would otherwise be short.
  return [...selected, ...deferred].slice(0, limit)
}

export interface ContextForPathResult {
  found: boolean
  /** Exact node asked about, when one is indexed. */
  node: ContextSearchHit | null
  /** Enclosing folders and the source root, nearest first — the summaries this file fed into. */
  ancestors: ContextSearchHit[]
  /** Other indexed paths that matched the fragment, when it was ambiguous. */
  candidates: Array<{ level: 'file' | 'folder'; path: string; projectName: string | null }>
  notice?: string
}

/**
 * The generated context for one specific file or folder.
 *
 * Answers the direct question ("what do you know about Running.xlsx") without a
 * topic search, and hands back the enclosing folder summaries too: those are the
 * nodes this file's context was folded into, so they say what Holmes concluded
 * from it in company rather than alone.
 */
export function getGeneratedContextForPath(
  target: string,
  options: { maxContextChars?: number } = {}
): ContextForPathResult {
  const fragment = normalize(target).replace(/\/+$/, '')
  if (!fragment) {
    return { found: false, node: null, ancestors: [], candidates: [], notice: 'A file or folder path is required.' }
  }
  const maxContextChars = Math.max(200, options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS)
  const meta = projectMetadata(database.listProjects())
  const matches = database
    .findDocumentContextsByPath(fragment, 12)
    .filter((candidate) => meta.get(candidate.projectId)?.searchable)

  if (matches.length === 0) {
    return {
      found: false,
      node: null,
      ancestors: [],
      candidates: [],
      notice: `No generated context is stored for a path ending in "${fragment}". It may not be indexed, or it may belong to a hidden source.`,
    }
  }

  // A path can be indexed by two sources at once (a folder inside a project that
  // also sits under a broader one), and a failed pass leaves a sentinel where the
  // summary should be. So: prefer a real summary over a failure marker, then the
  // shortest path, since an exact path is shorter than any path merely ending
  // with it and beats a deeper namesake.
  const usable = matches.filter((candidate) => !isFailedContext(candidate.context))
  const preferred = usable.length > 0 ? usable : matches
  const best = preferred.reduce((shortest, candidate) => (
    candidate.path.length < shortest.path.length ? candidate : shortest
  ))
  const onlyFailures = usable.length === 0

  const toHit = (candidate: DocumentContextMatch): ContextSearchHit => {
    const level: ContextSearchLevel = candidate.level === 'folder'
      ? (candidate.relativePath === '.' ? 'sourceRoot' : 'folder')
      : 'file'
    const projectName = meta.get(candidate.projectId)?.name ?? null
    return {
      level,
      path: candidate.path,
      label: level === 'sourceRoot' && projectName ? `${projectName} — ${candidate.path}` : candidate.relativePath,
      projectId: candidate.projectId,
      projectName,
      kind: candidate.kind,
      context: clampContext(candidate.context, maxContextChars),
      contextShort: candidate.contextShort,
      fileCount: candidate.fileCount,
      score: 0,
      updatedAt: candidate.updatedAt,
      conversationId: null,
    }
  }

  const ancestors: ContextSearchHit[] = []
  let parent = best.path.slice(0, best.path.lastIndexOf('/'))
  while (parent.length > 1) {
    const folder = database.getDocumentFolderContext(best.projectId, parent)
    // A folder whose own synthesis failed is skipped rather than reported: a
    // stored error message is not a summary of anything.
    if (folder && !isFailedContext(folder.context)) {
      ancestors.push(toHit({
        level: 'folder',
        projectId: best.projectId,
        path: folder.folderPath,
        relativePath: folder.relativePath,
        kind: null,
        contextShort: folder.contextShort,
        context: folder.context,
        fileCount: folder.fileCount,
        bm25: 0,
        updatedAt: folder.updatedAt,
      }))
      if (folder.relativePath === '.') break
    }
    const next = parent.slice(0, parent.lastIndexOf('/'))
    if (next === parent) break
    parent = next
  }

  const seenPaths = new Set([best.path])
  const candidates: ContextForPathResult['candidates'] = []
  for (const candidate of matches) {
    if (seenPaths.has(candidate.path)) continue
    seenPaths.add(candidate.path)
    candidates.push({
      level: candidate.level,
      path: candidate.path,
      projectName: meta.get(candidate.projectId)?.name ?? null,
    })
  }

  return {
    found: true,
    node: toHit(best),
    ancestors,
    candidates,
    // Said plainly rather than passed off as a finding: this text is an error
    // message the indexer stored, not something Holmes concluded.
    ...(onlyFailures
      ? { notice: 'This path is indexed but its summary failed to generate — what follows is the stored failure marker, not a finding. Re-index the source to retry.' }
      : {}),
  }
}
