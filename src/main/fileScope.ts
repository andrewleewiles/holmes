import fs from 'fs'
import path from 'path'
import { getFileAccessScope, setFileAccessScope } from './settings'
import type { FileAccessScope } from '../shared/types'

export { getFileAccessScope, setFileAccessScope }
export type { FileAccessScope }

function resolveRealPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

function resolveExistingParent(filePath: string): string | null {
  try {
    const parent = path.dirname(filePath)
    return fs.realpathSync(parent)
  } catch {
    return null
  }
}

function isPathUnderRoot(target: string, root: string): boolean {
  if (target === root) return true
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target.startsWith(rootWithSep)
}

export function getResolvedRoots(scope: FileAccessScope = getFileAccessScope()): string[] {
  if (scope.mode === 'everywhere') return ['/']
  const seen = new Set<string>()
  const resolved: string[] = []
  for (const root of scope.roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue
    const real = resolveRealPath(root)
    const candidate = real || path.resolve(root)
    const key = candidate.endsWith(path.sep) ? candidate.slice(0, -1) : candidate
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push(candidate)
  }
  return resolved
}

export function isPathEverywhere(scope: FileAccessScope = getFileAccessScope()): boolean {
  return scope.mode === 'everywhere'
}

export function isPathAllowed(filePath: string, scope: FileAccessScope = getFileAccessScope()): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  if (!path.isAbsolute(filePath)) return false

  if (scope.mode === 'everywhere') return true

  const roots = getResolvedRoots(scope)
  if (roots.length === 0) return false

  const realTarget = resolveRealPath(filePath)
  const target = realTarget ?? resolveExistingParent(filePath) ?? path.resolve(filePath)

  return roots.some((root) => isPathUnderRoot(target, root))
}

export function assertPathAllowed(filePath: string, scope: FileAccessScope = getFileAccessScope()): void {
  if (isPathAllowed(filePath, scope)) return
  if (scope.mode === 'everywhere') {
    throw new Error(`Path is not accessible: ${filePath}`)
  }
  if (scope.roots.length === 0) {
    throw new Error('No file access scope is configured. Add allowed folders in Settings.')
  }
  throw new Error(`Path is outside the configured file access scope: ${filePath}`)
}

export function filterAllowedPaths(filePaths: string[], scope: FileAccessScope = getFileAccessScope()): string[] {
  return filePaths.filter((filePath) => isPathAllowed(filePath, scope))
}

export function describeScope(scope: FileAccessScope = getFileAccessScope()): string {
  if (scope.mode === 'everywhere') return 'Entire filesystem'
  if (scope.roots.length === 0) return 'No folders configured'
  if (scope.roots.length === 1) return scope.roots[0]
  return `${scope.roots.length} folders`
}
