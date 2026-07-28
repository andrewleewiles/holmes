import path from 'path'
import { readFile, readdir, stat } from 'fs/promises'
import { assertPathAllowed, getResolvedRoots, isPathEverywhere } from './fileScope'
import { searchRecallFilesForQuery } from './recall'
import { getWebSearchSettings } from './settings'
import { executeWebSearch } from './webSearch'
import type { ToolCall, ToolResult } from '../shared/types'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required: string[]
    }
  }
}

const MAX_READ_BYTES = 200_000
const MAX_LIST_ENTRIES = 500
const MAX_SEARCH_RESULTS = 20

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files on the user\'s Mac using Spotlight (macOS system index). Use this to find files by name, content, or metadata when you don\'t know the exact path. Returns file paths, titles, and snippets. Works with documents, notes, code, PDFs, and most indexed file types.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query: a word, phrase, or topic to look for in file names and content.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default 20, max 25).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file as UTF-8 text. The path must be absolute and within the configured file access scope. Returns the text content (truncated to ~200KB). For binary files, consider using search_files instead.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file to read.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory. Returns names, types (file/directory), sizes, and modification dates. The path must be absolute and within the configured file access scope.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory to list.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_info',
      description: 'Get metadata about a file or directory: type, size, and last modified date. The path must be absolute and within the configured file access scope.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file or directory.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web with Tavily and return ranked results with titles, URLs, and snippet content. Use this for current events, recent prices, release notes, documentation that may have changed, library versions, or any factual question where the model\'s training data may be stale or insufficient. Returns up to 8 results plus an optional synthesized answer.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A focused search query: a question, a few keywords, or a specific topic. Avoid pasting long text into this field.',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default 8, max 20).',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news'],
            description: 'Use "news" for very recent events (last few days/weeks). Default is "general".',
          },
        },
        required: ['query'],
      },
    },
  },
]

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* malformed arguments */ }
  return {}
}

function resolveAndAssert(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error('Path must be absolute')
  }
  const resolved = path.resolve(filePath)
  assertPathAllowed(resolved)
  return resolved
}

async function executeSearchFiles(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new Error('query is required')
  const limit = typeof args.limit === 'number'
    ? Math.max(1, Math.min(Math.floor(args.limit), 25))
    : MAX_SEARCH_RESULTS

  if (!isPathEverywhere() && getResolvedRoots().length === 0) {
    return JSON.stringify({
      results: [],
      notice: 'No file access scope is configured. Ask the user to add allowed folders in Settings.',
    })
  }

  const scope = { everywhere: isPathEverywhere(), roots: getResolvedRoots() }
  const abortSignal = signal ?? new AbortController().signal
  const results = await searchRecallFilesForQuery(query, abortSignal, limit, scope)

  return JSON.stringify({
    results: results.map((r) => ({
      title: r.title,
      path: r.path,
      snippet: r.snippet,
      modifiedAt: r.modifiedAt,
      fileType: r.fileType,
    })),
  })
}

async function executeReadFile(args: Record<string, unknown>): Promise<string> {
  const filePath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!filePath) throw new Error('path is required')
  const resolved = resolveAndAssert(filePath)

  const info = await stat(resolved)
  if (!info.isFile()) throw new Error('Path is not a file')

  const maxBytes = Math.min(info.size, MAX_READ_BYTES)
  const { open } = await import('fs/promises')
  const handle = await open(resolved, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const content = buffer.subarray(0, bytesRead).toString('utf8')
    return JSON.stringify({
      path: resolved,
      content,
      bytes: bytesRead,
      truncated: info.size > bytesRead,
    })
  } finally {
    await handle.close()
  }
}

async function executeListDirectory(args: Record<string, unknown>): Promise<string> {
  const dirPath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!dirPath) throw new Error('path is required')
  const resolved = resolveAndAssert(dirPath)

  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error('Path is not a directory')

  const entries = await readdir(resolved, { withFileTypes: true })
  const results: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    if (results.length >= MAX_LIST_ENTRIES) break
    const entryPath = path.join(resolved, entry.name)
    let size: number | null = null
    let mtime: number | null = null
    try {
      const s = await stat(entryPath)
      size = s.size
      mtime = s.mtimeMs
    } catch { /* skip unreadable */ }
    results.push({
      name: entry.name,
      path: entryPath,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      size,
      modifiedAt: mtime,
    })
  }

  return JSON.stringify({
    path: resolved,
    entries: results,
    truncated: entries.length > MAX_LIST_ENTRIES,
  })
}

async function executeGetFileInfo(args: Record<string, unknown>): Promise<string> {
  const filePath = typeof args.path === 'string' ? args.path.trim() : ''
  if (!filePath) throw new Error('path is required')
  const resolved = resolveAndAssert(filePath)

  const info = await stat(resolved)
  return JSON.stringify({
    path: resolved,
    isFile: info.isFile(),
    isDirectory: info.isDirectory(),
    size: info.size,
    modifiedAt: info.mtimeMs,
  })
}

async function executeWebSearchTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new Error('query is required')
  const { enabled, provider, apiKey } = getWebSearchSettings()
  if (!enabled || !apiKey.trim()) {
    return JSON.stringify({
      results: [],
      notice: 'Web search is disabled or no API key is configured. Ask the user to enable it in Settings.',
    })
  }
  const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)
    ? Math.max(1, Math.min(Math.floor(args.maxResults), 20))
    : undefined
  const topic = args.topic === 'news' || args.topic === 'general' ? args.topic : undefined

  const abortSignal = signal ?? new AbortController().signal
  const result = await executeWebSearch(provider, apiKey, { query, ...(maxResults ? { maxResults } : {}), ...(topic ? { topic } : {}) }, abortSignal)

  return JSON.stringify({
    query: result.query,
    answer: result.answer,
    results: result.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      score: r.score,
    })),
    searchedAt: result.searchedAt,
  })
}

export function getToolDefinitions(options: { webSearchEnabled?: boolean } = {}): ToolDefinition[] {
  if (options.webSearchEnabled) return TOOL_DEFINITIONS
  return TOOL_DEFINITIONS.filter((definition) => definition.function.name !== 'web_search')
}

export async function executeToolCall(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const args = safeParseArgs(call.arguments)
    let result: string

    switch (call.name) {
      case 'search_files':
        result = await executeSearchFiles(args, signal)
        break
      case 'read_file':
        result = await executeReadFile(args)
        break
      case 'list_directory':
        result = await executeListDirectory(args)
        break
      case 'get_file_info':
        result = await executeGetFileInfo(args)
        break
      case 'web_search':
        result = await executeWebSearchTool(args, signal)
        break
      default:
        throw new Error(`Unknown tool: ${call.name}`)
    }

    return {
      callId: call.id,
      name: call.name,
      content: result,
    }
  } catch (error) {
    return {
      callId: call.id,
      name: call.name,
      content: error instanceof Error ? error.message : 'Tool execution failed',
      error: true,
    }
  }
}

export async function executeToolCalls(toolCalls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const call of toolCalls) {
    if (signal?.aborted) break
    const result = await executeToolCall(call, signal)
    results.push(result)
  }
  return results
}
