export type DefaultProjectCategory = 'life' | 'media'

/**
 * What a project IS, structurally — as opposed to what it is called.
 * - `standard` — an ordinary data source: folders of documents, read by the
 *   document indexer into per-file and folder contexts.
 * - `library` — a shelf of e-books. Its folders are scanned into the Library,
 *   never into document contexts, and only the *reading record* reaches the
 *   life picture. See `src/main/booksContext.ts`.
 * - `video` — archived video from the Play feed. Same bargain as `library`: the
 *   watch record reaches the life picture, the transcripts never do. Document
 *   indexing would otherwise try to read gigabytes of mp4 as text.
 *
 * This is a column on `projects` rather than a name comparison on purpose:
 * `projects:update` accepts any name, and a renamed Books source that fell back
 * to standard handling would silently deep-index every PDF on the shelf.
 */
export type ProjectKind = 'standard' | 'library' | 'video'

export interface DefaultProjectDefinition {
  name: string
  icon: string
  color: string
  /** Which heading the Data page files it under. */
  category: DefaultProjectCategory
}

/** The source that stands for Holmes' file access scope rather than a folder. */
export const FILE_SYSTEM_PROJECT_NAME = 'File System'

/** The e-book shelf. Its row is the only `library`-kind project. */
export const BOOKS_PROJECT_NAME = 'Books'

/** Where the Play feed archives video. The only `video`-kind project. */
export const VIDEOS_PROJECT_NAME = 'Videos'

export const DEFAULT_PROJECTS: readonly DefaultProjectDefinition[] = [
  { name: 'Psychology', icon: 'brain', color: '#8b5cf6', category: 'life' },
  { name: 'Health', icon: 'heart', color: '#22c55e', category: 'life' },
  { name: 'Activity', icon: 'compass', color: '#fbbf24', category: 'life' },
  { name: 'Finances', icon: 'sack-dollar', color: '#f59e0b', category: 'life' },
  // There is no "Data" source: the Data page IS the view of every source, so a
  // row for itself was redundant.
  { name: FILE_SYSTEM_PROJECT_NAME, icon: 'folder-open', color: '#3b82f6', category: 'life' },
  { name: 'Training', icon: 'dumbbell', color: '#ef4444', category: 'life' },
  { name: BOOKS_PROJECT_NAME, icon: 'book-open', color: '#a78bfa', category: 'media' },
  { name: VIDEOS_PROJECT_NAME, icon: 'film', color: '#f472b6', category: 'media' },
] as const

export const DEFAULT_PROJECT_NAMES: ReadonlySet<string> = new Set(
  DEFAULT_PROJECTS.map((project) => project.name)
)

const CATEGORY_BY_NAME: ReadonlyMap<string, DefaultProjectCategory> = new Map(
  DEFAULT_PROJECTS.map((project) => [project.name, project.category])
)

export function isDefaultProjectName(name: string): boolean {
  return DEFAULT_PROJECT_NAMES.has(name)
}

export function defaultProjectCategory(name: string): DefaultProjectCategory | null {
  return CATEGORY_BY_NAME.get(name) ?? null
}

/** Media sources are a built-in group, but not part of the life picture's core. */
export function isMediaProjectName(name: string): boolean {
  return CATEGORY_BY_NAME.get(name) === 'media'
}

/**
 * Media is no longer one kind. Keyed off the name rather than the category
 * because both media sources are built-in and each has its own reader — a new
 * media source that fell through to `library` would be scanned as e-books.
 */
export function projectKindForCategory(
  category: DefaultProjectCategory,
  name?: string
): ProjectKind {
  if (category !== 'media') return 'standard'
  return name === VIDEOS_PROJECT_NAME ? 'video' : 'library'
}

/** A video archive: not document-indexed, and read by the Play feed alone. */
export function isVideoProject(project: { kind?: string | null; name?: string }): boolean {
  if (project.kind) return project.kind === 'video'
  return project.name === VIDEOS_PROJECT_NAME
}

/**
 * Sources whose files are never read into document contexts. Both media kinds
 * make the same bargain: the record of what you consumed reaches the life
 * picture, the content itself does not.
 */
export function isMediaKindProject(project: { kind?: string | null; name?: string }): boolean {
  return isLibraryProject(project) || isVideoProject(project)
}

/**
 * A library project is read into the Library, never into document contexts.
 * Keyed on `kind` so a rename cannot re-enable generic indexing; the name is
 * only a fallback for a row written before the column existed.
 */
export function isLibraryProject(project: { kind?: string | null; name?: string }): boolean {
  if (project.kind) return project.kind === 'library'
  return project.name === BOOKS_PROJECT_NAME
}

/**
 * Which sources the Dashboard offers as ordinary life-source cards. File System
 * stands for an access scope rather than a folder, and media sources have their
 * own page, so neither belongs in that grid.
 */
export function isDashboardProject(name: string): boolean {
  return name !== FILE_SYSTEM_PROJECT_NAME && !isMediaProjectName(name)
}
