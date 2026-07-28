import fs from 'fs'
import path from 'path'
import type { Project } from '../shared/types'
import * as database from './database'

export const MAX_PROJECT_CONTEXT_CHARS = 80000
const MAX_DISCOVERED_PROJECT_FILES = 500
const MAX_DIRECTORY_ENTRIES = 5000
// A photo tree is a different order of magnitude from a document folder: the
// caller's own directory can hold 40k+ images across tens of thousands of
// entries. Document-context indexing raises both ceilings deliberately; the
// pre-flight estimate reports when a scan still hit them so a truncated index
// can never masquerade as a complete one.
export const MAX_INDEXED_FILES = 200_000
export const MAX_INDEXED_DIRECTORY_ENTRIES = 800_000
const MAX_DISCOVERED_DATA_FILES = 5000
const MAX_DATA_DIRECTORY_ENTRIES = 50000
const MAX_PROJECT_CONTEXT_FILE_SIZE = 10 * 1024 * 1024
const APPLE_HEALTH_EXPORT_FILES = new Set(['export.xml'])
const ACTIVITY_LARGE_FILES = new Set(['Records.json', 'Timeline.json', 'History.db', 'Envelope Index', 'Photos.sqlite', 'knowledgeC.db'])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.log', '.rtf',
])

// Broader set for the document-context feature, which can extract text from
// common binary document formats (PDF via pdfjs-dist, XLSX/DOCX via unzip).
export const DOCUMENT_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS, '.pdf', '.xlsx', '.docx',
])

// Images are summarized by a vision model rather than text-extracted. HEIC/HEIF
// decode through sips; the rest go through Electron's nativeImage.
export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tif', '.tiff',
])

export const INDEXABLE_EXTENSIONS = new Set([
  ...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS,
])

// E-books, scanned by the Library and by nothing else. Deliberately a SIBLING
// of DOCUMENT_EXTENSIONS rather than an addition to it: .epub must stay
// invisible to the document indexer, and .pdf appears in both sets because the
// same extension means "a book" under a library source and "a document"
// everywhere else. What separates them is the project, not the extension.
export const BOOK_EXTENSIONS = new Set(['.epub', '.pdf'])

export function isImageExtension(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

// Directories that only ever hold derivative or duplicate copies of images that
// already exist elsewhere in the tree. A .photoslibrary bundle is the important
// one: its originals/ and resources/ are sharded into hex UUID buckets, so
// indexing it would both double-count photos and produce folder super-contexts
// synthesized from 16 random shuffles of the user's life.
const DERIVATIVE_DIRECTORY_NAMES = new Set(['thumbs', 'thumbnails', 'backups', '.thumbnails'])

export function isDerivativeDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.endsWith('.photoslibrary') || lower.endsWith('.photolibrary')) return true
  if (lower.endsWith('.aplibrary') || lower.endsWith('.migratedaperturelibrary')) return true
  return DERIVATIVE_DIRECTORY_NAMES.has(lower)
}

export interface ProjectFileContext {
  content: string
  fileCount: number
  includedFileCount: number
  truncated: boolean
}

export interface PsychologyProjectContext extends ProjectFileContext {
  profileIncluded: boolean
}

export interface CollectFileLimits {
  maxFiles?: number
  maxEntries?: number
  /**
   * Per-file ceiling. Defaults to MAX_PROJECT_CONTEXT_FILE_SIZE so every
   * existing caller keeps the 10 MB rule that keeps a 900 MB Apple Health
   * export.xml out of the document indexer. The Library raises it: an ordinary
   * PDF book clears 10 MB, and dropping it silently would leave a book on the
   * shelf the user can see in Finder and not in Holmes.
   */
  maxFileSize?: number
}

/**
 * What a scan found AND how much of the tree it was actually able to see.
 *
 * The distinction matters because callers use the file list as evidence of what
 * still exists on disk: the indexer prunes cached contexts for files the scan
 * did not return. A disconnected drive, a directory the process cannot open, or
 * a walk that stopped at its own caps all yield a short list that says nothing
 * about whether those files are gone — so anything destructive must gate on
 * `complete`, never on the list alone.
 */
export interface ProjectFileScan {
  files: string[]
  /** The scan root itself could not be resolved or read (unmounted volume, deleted path, no permission). */
  rootUnreadable: boolean
  /** Directories or entries inside the tree that threw while being read; their files are missing from `files`. */
  unreadableEntries: number
  /** The walk stopped at maxFiles/maxEntries, so `files` is a partial view of the tree. */
  truncated: boolean
  /** The scan saw the whole tree: the list can be trusted as the complete set of indexable files. */
  complete: boolean
}

export function scanProjectTextFiles(
  filePaths: string[],
  directory: string | null,
  extensions: Set<string> = TEXT_EXTENSIONS,
  limits: CollectFileLimits = {}
): ProjectFileScan {
  const maxFiles = limits.maxFiles ?? MAX_DISCOVERED_PROJECT_FILES
  const maxEntries = limits.maxEntries ?? MAX_DIRECTORY_ENTRIES
  const maxFileSize = limits.maxFileSize ?? MAX_PROJECT_CONTEXT_FILE_SIZE
  const files = new Set<string>()
  let rootUnreadable = false
  let unreadableEntries = 0
  let truncated = false

  for (const filePath of filePaths) {
    if (files.size >= maxFiles) {
      truncated = true
      break
    }
    try {
      const resolved = path.resolve(filePath)
      const stat = fs.statSync(resolved)
      if (!stat.isFile() || !extensions.has(path.extname(resolved).toLowerCase())) continue
      if (APPLE_HEALTH_EXPORT_FILES.has(path.basename(resolved).toLowerCase())) continue
      if (ACTIVITY_LARGE_FILES.has(path.basename(resolved).toLowerCase())) continue
      if (stat.size > maxFileSize) continue
      files.add(resolved)
    } catch {
      // A missing or unreadable explicit file is indistinguishable from one on a
      // drive that happens to be offline, so it counts against completeness.
      unreadableEntries += 1
    }
  }

  if (directory) {
    try {
      const base = path.resolve(directory)
      const realBase = fs.realpathSync(base)
      const directories = [realBase]
      const visitedDirectories = new Set([realBase])
      let inspectedEntries = 0

      while (
        directories.length > 0 &&
        files.size < maxFiles &&
        inspectedEntries < maxEntries
      ) {
        const currentDirectory = directories.shift()!
        let directoryHandle: fs.Dir
        try {
          directoryHandle = fs.opendirSync(currentDirectory)
        } catch {
          unreadableEntries += 1
          continue
        }
        try {
          let entry: fs.Dirent | null
          while ((entry = directoryHandle.readSync()) !== null) {
            inspectedEntries += 1
            if (inspectedEntries > maxEntries || files.size >= maxFiles) {
              truncated = true
              break
            }
            if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue
            if (entry.name.startsWith('.') || ['node_modules', 'out', 'dist'].includes(entry.name)) continue
            if (isDerivativeDirectory(entry.name)) continue
            try {
              const realPath = fs.realpathSync(path.join(currentDirectory, entry.name))
              if (!realPath.startsWith(`${realBase}${path.sep}`)) continue
              const stat = fs.statSync(realPath)
              if (stat.isDirectory()) {
                if (!visitedDirectories.has(realPath)) {
                  visitedDirectories.add(realPath)
                  directories.push(realPath)
                }
              } else if (
              stat.isFile() &&
              extensions.has(path.extname(realPath).toLowerCase()) &&
              !APPLE_HEALTH_EXPORT_FILES.has(path.basename(realPath).toLowerCase()) &&
              !ACTIVITY_LARGE_FILES.has(path.basename(realPath).toLowerCase()) &&
              stat.size <= maxFileSize
              ) {
                files.add(realPath)
              }
            } catch {
              // An entry that cannot be stat'd hides whatever it points at.
              unreadableEntries += 1
            }
          }
        } finally {
          directoryHandle.closeSync()
        }
      }
      // The queue still holding directories means a cap cut the walk short.
      if (directories.length > 0) truncated = true
    } catch {
      // The root itself is gone or unreadable — an unmounted external drive is
      // the everyday case, and it must never read as "the tree is now empty".
      rootUnreadable = true
    }
  }

  return {
    files: [...files].sort((left, right) => left.localeCompare(right)),
    rootUnreadable,
    unreadableEntries,
    truncated,
    complete: !rootUnreadable && unreadableEntries === 0 && !truncated,
  }
}

export function collectProjectTextFiles(
  filePaths: string[],
  directory: string | null,
  extensions: Set<string> = TEXT_EXTENSIONS,
  limits: CollectFileLimits = {}
): string[] {
  return scanProjectTextFiles(filePaths, directory, extensions, limits).files
}

export function collectProjectDataFiles(directory: string | null): string[] {
  if (!directory) return []
  const files = new Set<string>()
  try {
    const base = path.resolve(directory)
    const realBase = fs.realpathSync(base)
    const directories = [realBase]
    const visitedDirectories = new Set([realBase])
    let inspectedEntries = 0

    while (
      directories.length > 0 &&
      files.size < MAX_DISCOVERED_DATA_FILES &&
      inspectedEntries < MAX_DATA_DIRECTORY_ENTRIES
    ) {
      const currentDirectory = directories.shift()!
      let directoryHandle: fs.Dir
      try {
        directoryHandle = fs.opendirSync(currentDirectory)
      } catch {
        continue
      }
      try {
        let entry: fs.Dirent | null
        while ((entry = directoryHandle.readSync()) !== null) {
          if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue
          if (entry.name.startsWith('.') || ['node_modules', 'out', 'dist'].includes(entry.name)) continue
          inspectedEntries += 1
          if (inspectedEntries > MAX_DATA_DIRECTORY_ENTRIES || files.size >= MAX_DISCOVERED_DATA_FILES) break
          try {
            const realPath = fs.realpathSync(path.join(currentDirectory, entry.name))
            if (!realPath.startsWith(`${realBase}${path.sep}`)) continue
            const stat = fs.statSync(realPath)
            if (stat.isDirectory()) {
              if (!visitedDirectories.has(realPath)) {
                visitedDirectories.add(realPath)
                directories.push(realPath)
              }
            } else if (stat.isFile()) {
              files.add(realPath)
            }
          } catch {
            // Skip unreadable entries.
          }
        }
      } finally {
        directoryHandle.closeSync()
      }
    }
  } catch { /* Skip an inaccessible project directory. */ }

  return [...files].sort((left, right) => left.localeCompare(right))
}

export function readTextFileBounded(filePath: string, maxChars: number): {
  text: string
  truncated: boolean
  modifiedAt: number
} {
  const stat = fs.statSync(filePath)
  const maxBytes = Math.max(1, Math.min(maxChars * 4, 1_000_000))
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytes))
  const descriptor = fs.openSync(filePath, 'r')
  let bytesRead = 0
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
  } finally {
    fs.closeSync(descriptor)
  }
  const decoded = buffer.subarray(0, bytesRead).toString('utf8')
  return {
    text: decoded.slice(0, maxChars),
    truncated: stat.size > bytesRead || decoded.length > maxChars,
    modifiedAt: stat.mtimeMs,
  }
}

export function readProjectFileContext(
  filePaths: string[],
  directory: string | null,
  maxChars: number = MAX_PROJECT_CONTEXT_CHARS
): ProjectFileContext {
  const files = collectProjectTextFiles(filePaths, directory)
  const parts: string[] = []
  const base = directory ? path.resolve(directory) : null
  let usedChars = 0
  let includedFileCount = 0
  let truncated = false

  for (const filePath of files) {
    if (usedChars >= maxChars) {
      truncated = true
      break
    }
    try {
      const relative = base && (filePath === base || filePath.startsWith(`${base}${path.sep}`))
        ? path.relative(base, filePath)
        : path.basename(filePath)
      const label = relative.replace(/[\r\n]/g, ' ')
      const start = `--- BEGIN DOCUMENT: ${label} ---\n`
      const end = `\n--- END DOCUMENT: ${label} ---`
      const available = maxChars - usedChars - start.length - end.length
      if (available <= 0) {
        truncated = true
        break
      }
      const result = readTextFileBounded(filePath, available)
      const raw = result.text
      const truncationMarker = '\n...[truncated]'
      const body = result.truncated || raw.length > available
        ? `${raw.slice(0, Math.max(0, available - truncationMarker.length))}${truncationMarker.slice(0, available)}`
        : raw
      parts.push(`${start}${body}${end}`)
      usedChars += start.length + body.length + end.length + 2
      includedFileCount += 1
      if (result.truncated || raw.length > available) truncated = true
    } catch { /* Skip files that cannot be decoded as text. */ }
  }

  if (includedFileCount < files.length) truncated = true
  return { content: parts.join('\n\n'), fileCount: files.length, includedFileCount, truncated }
}

/**
 * `sessionNotes` is passed in rather than read here: this module is loaded by a
 * test that runs without the extension-resolving bootstrap, so it must not gain
 * a runtime import of the note store (landmine #9 in AGENTS.md).
 */
export function buildPsychologyProjectContext(
  project: Project,
  maxChars: number = MAX_PROJECT_CONTEXT_CHARS,
  options: { sessionNotes?: string } = {}
): PsychologyProjectContext {
  const profileIncluded = Boolean(project.analysis)
  const sessionNotes = options.sessionNotes?.trim()
  const metadata = [
    `PROJECT: ${project.name}`,
    '',
    'PSYCHOLOGICAL PROFILE:',
    project.analysis ? JSON.stringify(project.analysis, null, 2) : 'No profile analysis is currently saved.',
    '',
    'RELATIONSHIP ANALYSIS:',
    '',
    'SESSION NOTES:',
    sessionNotes || 'No role-led session notes have been recorded.',
    '',
    'PROJECT DOCUMENTS:',
  ].join('\n')
  const fileBudget = Math.max(0, maxChars - metadata.length - 2)
  const files = readProjectFileContext(project.files, project.path, fileBudget)
  const combined = `${metadata}\n\n${files.content}`.slice(0, maxChars)

  return {
    ...files,
    content: combined,
    truncated: files.truncated || metadata.length > maxChars,
    profileIncluded,
  }
}

export interface HealthProjectContext extends ProjectFileContext {
  analysisIncluded: boolean
}

export function buildHealthProjectContext(
  project: Project,
  maxChars: number = MAX_PROJECT_CONTEXT_CHARS
): HealthProjectContext {
  const analysisIncluded = Boolean(project.healthAnalysis)
  const metadata = [
    `PROJECT: ${project.name}`,
    '',
    'HEALTH ANALYSIS:',
    project.healthAnalysis ? JSON.stringify(project.healthAnalysis, null, 2) : 'No health analysis is currently saved.',
    '',
    'PROJECT DOCUMENTS:',
  ].join('\n')
  const fileBudget = Math.max(0, maxChars - metadata.length - 2)
  const files = readProjectFileContext(project.files, project.path, fileBudget)
  const combined = `${metadata}\n\n${files.content}`.slice(0, maxChars)

  return {
    ...files,
    content: combined,
    truncated: files.truncated || metadata.length > maxChars,
    analysisIncluded,
  }
}

export interface ActivityProjectContext extends ProjectFileContext {
  analysisIncluded: boolean
}

export function buildActivityProjectContext(
  project: Project,
  maxChars: number = MAX_PROJECT_CONTEXT_CHARS
): ActivityProjectContext {
  const analysisIncluded = Boolean(project.activityAnalysis)
  const lines: string[] = [
    `PROJECT: ${project.name}`,
    '',
    'ACTIVITY ANALYSIS (super-context):',
    project.activityAnalysis ? JSON.stringify(project.activityAnalysis, null, 2) : 'No activity analysis is currently saved.',
  ]
  const summary = database.getActivitySummary(project.id)
  if (summary && summary.sourceAnalyses.length > 0) {
    lines.push('', 'PER-SOURCE ANALYSES:')
    for (const sa of summary.sourceAnalyses) {
      lines.push(`--- ${sa.sourceType} ---`, sa.analysis)
    }
  }
  lines.push('', 'PROJECT DOCUMENTS:')
  const metadata = lines.join('\n')
  const fileBudget = Math.max(0, maxChars - metadata.length - 2)
  const files = readProjectFileContext(project.files, project.path, fileBudget)
  const combined = `${metadata}\n\n${files.content}`.slice(0, maxChars)

  return {
    ...files,
    content: combined,
    truncated: files.truncated || metadata.length > maxChars,
    analysisIncluded,
  }
}

export interface FinancesProjectContext extends ProjectFileContext {
  summaryIncluded: boolean
}

export function buildFinancesProjectContext(
  project: Project,
  maxChars: number = MAX_PROJECT_CONTEXT_CHARS
): FinancesProjectContext {
  const summaryIncluded = Boolean(project.financesSummary)
  const metadata = [
    `PROJECT: ${project.name}`,
    '',
    'FINANCES SUMMARY:',
    project.financesSummary ? JSON.stringify(project.financesSummary, null, 2) : 'No finances summary is currently saved.',
    '',
    'PROJECT DOCUMENTS:',
  ].join('\n')
  const fileBudget = Math.max(0, maxChars - metadata.length - 2)
  const files = readProjectFileContext(project.files, project.path, fileBudget)
  const combined = `${metadata}\n\n${files.content}`.slice(0, maxChars)

  return {
    ...files,
    content: combined,
    truncated: files.truncated || metadata.length > maxChars,
    summaryIncluded,
  }
}
