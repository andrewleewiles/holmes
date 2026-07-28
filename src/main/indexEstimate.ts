import fs from 'fs'
import path from 'path'
import type { IndexEstimate, IndexEstimateLine, ModelTier, ProviderConfig } from '../shared/types'
import { isLibraryProject } from '../shared/defaultProjects'
import * as database from './database'
import {
  collectProjectTextFiles,
  isImageExtension,
  INDEXABLE_EXTENSIONS,
  MAX_INDEXED_FILES,
  MAX_INDEXED_DIRECTORY_ENTRIES,
} from './projectContext'
import { estimateImageTokens, PHOTO_MAX_EDGE } from './photoContext'
import { getPriceTable, priceCall, type PriceTable } from './modelPricing'
import { estimateSecondsForCalls, DEFAULT_REQUESTS_PER_MINUTE } from './rateLimit'

// Rough but stable: 4 characters per token is the usual English approximation
// and the estimate is a decision aid, not an invoice.
const CHARS_PER_TOKEN = 4

// Mirrors documentContext.ts. Kept as local constants rather than imported so
// that estimating never pulls the generation module (and Electron) into scope.
const MAX_FILE_INPUT_CHARS = 40_000
const FILE_SYSTEM_PROMPT_TOKENS = 520
const FILE_OUTPUT_TOKENS = 700

const IMAGE_SYSTEM_PROMPT_TOKENS = 330
const IMAGE_HEADER_TOKENS = 60
const IMAGE_OUTPUT_TOKENS = 130

const FOLDER_INPUT_TOKENS = 6_000
const FOLDER_OUTPUT_TOKENS = 1_400

// Observed round-trip per call. At any real provider rate limit the limit, not
// concurrency, sets the wall clock: 146k calls at 20 rpm is 5 days regardless of
// how many workers are running.
const SECONDS_PER_CALL = 4
const FILE_CONCURRENCY = 4

function resolveBase(projectPath: string): string {
  try {
    return fs.realpathSync(path.resolve(projectPath))
  } catch {
    return path.resolve(projectPath)
  }
}

function estimateTextFileTokens(filePath: string): number {
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch { /* Unreadable files still cost a scan slot, not a call. */ }
  const usableChars = Math.min(size, MAX_FILE_INPUT_CHARS)
  return Math.ceil(usableChars / CHARS_PER_TOKEN) + FILE_SYSTEM_PROMPT_TOKENS
}

// Counts the folders the generation pass would visit: every directory that
// holds at least one indexable file, plus every ancestor up to the root.
export function countFolders(base: string, files: string[]): number {
  const folders = new Set<string>([base])
  for (const file of files) {
    let current = path.dirname(file)
    while (current === base || current.startsWith(`${base}${path.sep}`)) {
      folders.add(current)
      if (current === base) break
      current = path.dirname(current)
    }
  }
  return folders.size
}

export interface EstimateInput {
  projectId: string
  projectName: string | null
  projectPath: string | null
  projectFiles: string[]
  tier: ModelTier
  textModel: string
  visionModel: string
  priceTable: PriceTable
  requestsPerMinute?: number
  // Every connected source root. Falls back to projectPath for callers that
  // predate multi-source.
  sourcePaths?: string[]
  // Narrow the estimate to one connected source.
  sourcePath?: string
  // A forced run regenerates everything, so nothing counts as cached.
  force?: boolean
}

// Pure projection, so it is directly testable without a provider or a DB.
export function computeIndexEstimate(input: EstimateInput): IndexEstimate {
  const { projectId, projectName, projectPath, projectFiles, tier, textModel, visionModel, priceTable } = input
  const requestsPerMinute = input.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE

  // Must match documentContext.resolveBase: the collector returns realpath'd
  // files, so a symlinked project root (every macOS tmpdir, via /var ->
  // /private/var) would otherwise match no folders and under-count the run.
  // One entry per connected source; `sourcePath` narrows to a single one.
  const roots = (input.sourcePaths ?? (projectPath ? [projectPath] : []))
    .filter((candidate) => !input.sourcePath || candidate === input.sourcePath)

  const base = roots.length > 0 ? resolveBase(roots[0]) : null
  const files = roots.flatMap((root, index) =>
    collectProjectTextFiles(index === 0 ? projectFiles : [], root, INDEXABLE_EXTENSIONS, {
      maxFiles: MAX_INDEXED_FILES,
      maxEntries: MAX_INDEXED_DIRECTORY_ENTRIES,
    })
  )

  // A forced run regenerates every file, so the cache cannot discount anything.
  const cached = input.force ? new Set<string>() : new Set(database.listIndexedFilePaths(projectId))

  const textFiles: string[] = []
  const imageFiles: string[] = []
  let cachedFiles = 0
  for (const file of files) {
    // A cache hit costs nothing, so quoting it would overstate the bill. This
    // is why a re-index of an unchanged tree estimates near zero.
    if (cached.has(file)) {
      cachedFiles += 1
      continue
    }
    if (isImageExtension(file)) imageFiles.push(file)
    else textFiles.push(file)
  }

  const lines: IndexEstimateLine[] = []

  let textInput = 0
  for (const file of textFiles) textInput += estimateTextFileTokens(file)
  const textOutput = textFiles.length * FILE_OUTPUT_TOKENS
  if (textFiles.length > 0) {
    lines.push({
      label: 'Documents',
      fileCount: textFiles.length,
      callCount: textFiles.length,
      inputTokens: textInput,
      outputTokens: textOutput,
      costUsd: priceCall(priceTable, textModel, textInput, textOutput),
    })
  }

  const perImageInput = estimateImageTokens(PHOTO_MAX_EDGE) + IMAGE_SYSTEM_PROMPT_TOKENS + IMAGE_HEADER_TOKENS
  const imageInput = imageFiles.length * perImageInput
  const imageOutput = imageFiles.length * IMAGE_OUTPUT_TOKENS
  if (imageFiles.length > 0) {
    lines.push({
      label: 'Photos',
      fileCount: imageFiles.length,
      callCount: imageFiles.length,
      inputTokens: imageInput,
      outputTokens: imageOutput,
      costUsd: visionModel ? priceCall(priceTable, visionModel, imageInput, imageOutput, imageFiles.length) : null,
    })
  }

  // Folder syntheses only rerun when their children changed, so a run with no
  // regenerated files also has no folder cost.
  const changedFiles = textFiles.length + imageFiles.length
  const folders = roots.reduce((sum, root) => sum + countFolders(resolveBase(root), files), 0)
  const foldersToBuild = changedFiles > 0 ? folders : 0
  const folderInput = foldersToBuild * FOLDER_INPUT_TOKENS
  const folderOutput = foldersToBuild * FOLDER_OUTPUT_TOKENS
  if (foldersToBuild > 0) {
    lines.push({
      label: 'Folder synthesis',
      fileCount: 0,
      callCount: foldersToBuild,
      inputTokens: folderInput,
      outputTokens: folderOutput,
      costUsd: priceCall(priceTable, textModel, folderInput, folderOutput),
    })
  }

  const inputTokens = textInput + imageInput + folderInput
  const outputTokens = textOutput + imageOutput + folderOutput
  const totalCalls = textFiles.length + imageFiles.length + foldersToBuild

  // Any unpriced leg makes the whole total unknown rather than partial — quoting
  // a number that silently omits the photo half would be worse than saying so.
  const pricingUnavailable = lines.some((line) => line.costUsd === null)
  const costUsd = pricingUnavailable
    ? null
    : lines.reduce((sum, line) => sum + (line.costUsd ?? 0), 0)

  const visionCapable = priceTable.get(visionModel)

  return {
    projectId,
    projectName,
    tier,
    textModel,
    visionModel,
    textFiles: textFiles.length,
    imageFiles: imageFiles.length,
    skippedFiles: 0,
    cachedFiles,
    folders: foldersToBuild,
    lines,
    inputTokens,
    outputTokens,
    costUsd,
    estimatedSeconds: estimateSecondsForCalls(totalCalls, requestsPerMinute, FILE_CONCURRENCY, SECONDS_PER_CALL),
    visionModelMissing: imageFiles.length > 0 && !visionModel,
    visionModelUnsupported: Boolean(visionModel) && visionCapable !== undefined && !visionCapable.acceptsImages,
    pricingUnavailable,
    truncatedAtCap: files.length >= MAX_INDEXED_FILES,
    scannedFiles: files.length,
  }
}

export async function estimateProjectIndex(
  projectId: string,
  tier: ModelTier,
  textModel: string,
  visionModel: string,
  config: ProviderConfig,
  requestsPerMinute?: number,
  scope: { sourcePath?: string; force?: boolean } = {}
): Promise<IndexEstimate> {
  const project = database.getProjectById(projectId)
  // Belt and braces alongside the IPC guard: quoting a price for indexing a
  // library would mean walking a folder of books that will never be indexed.
  if (project && isLibraryProject(project)) {
    return combineEstimates([], tier, textModel, visionModel)
  }
  const priceTable = await getPriceTable(config)
  const stored = database.listProjectSources(projectId).map((source) => source.path)
  // Same fallback as the indexer: a legacy path with no source row still counts.
  const sourcePaths = stored.length > 0 ? stored : (project?.path ? [project.path] : [])
  return computeIndexEstimate({
    projectId,
    projectName: project?.name ?? null,
    projectPath: project?.path ?? null,
    projectFiles: project?.files ?? [],
    tier,
    textModel,
    visionModel,
    priceTable,
    requestsPerMinute,
    sourcePaths: sourcePaths.length > 0 ? sourcePaths : undefined,
    sourcePath: scope.sourcePath,
    force: scope.force,
  })
}

// Sums the per-project estimates for an "Index all" run, which processes
// connected projects sequentially through the same pipeline.
export function combineEstimates(estimates: IndexEstimate[], tier: ModelTier, textModel: string, visionModel: string): IndexEstimate {
  const pricingUnavailable = estimates.some((estimate) => estimate.pricingUnavailable)
  const sum = (pick: (estimate: IndexEstimate) => number): number =>
    estimates.reduce((total, estimate) => total + pick(estimate), 0)

  return {
    projectId: null,
    projectName: null,
    tier,
    textModel,
    visionModel,
    textFiles: sum((e) => e.textFiles),
    imageFiles: sum((e) => e.imageFiles),
    skippedFiles: sum((e) => e.skippedFiles),
    cachedFiles: sum((e) => e.cachedFiles),
    folders: sum((e) => e.folders),
    lines: [],
    inputTokens: sum((e) => e.inputTokens),
    outputTokens: sum((e) => e.outputTokens),
    costUsd: pricingUnavailable ? null : sum((e) => e.costUsd ?? 0),
    estimatedSeconds: sum((e) => e.estimatedSeconds),
    visionModelMissing: estimates.some((e) => e.visionModelMissing),
    visionModelUnsupported: estimates.some((e) => e.visionModelUnsupported),
    pricingUnavailable,
    truncatedAtCap: estimates.some((e) => e.truncatedAtCap),
    scannedFiles: sum((e) => e.scannedFiles),
  }
}
