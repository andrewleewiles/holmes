import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT_ROOT = '/Volumes/andrews-ssd/projects/holmes'

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return nextResolve(pathToFileURL(path.join(PROJECT_ROOT, 'src/test/electron-stub.mjs')).href, context)
  }
  const parentUrl = context.parentURL
  if (
    parentUrl &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    parentUrl.startsWith(`file://${PROJECT_ROOT}/`)
  ) {
    const parentPath = fileURLToPath(parentUrl)
    const baseDir = path.dirname(parentPath)
    const target = path.resolve(baseDir, specifier)
    const candidates = [`${target}.ts`, `${target}.mjs`, `${target}.js`, `${target}/index.ts`]
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate)
        if (stat.isFile()) {
          return nextResolve(pathToFileURL(candidate).href, context)
        }
      } catch { /* try next */ }
    }
  }
  return nextResolve(specifier, context)
}
