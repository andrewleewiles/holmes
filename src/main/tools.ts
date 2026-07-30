import path from 'path'
import { readFile, readdir, stat } from 'fs/promises'
import { assertPathAllowed, getResolvedRoots, isPathEverywhere } from './fileScope'
import { searchRecallFilesForQuery } from './recall'
import { getGeneratedContextForPath, searchGeneratedContexts } from './contextSearch'
import type { ContextSearchLevel } from './contextSearch'
import { getImageGenerationModel, getProvider, getWebSearchSettings } from './settings'
import { executeWebSearch } from './webSearch'
import { generateImage } from './provider'
import { redactMemoryContent } from './memory'
import type { ToolCall, ToolResult } from '../shared/types'

import { openWorkDocument, requestEditor } from './officeBridge'

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
      name: 'search_contexts',
      description: "Search the contexts Holmes has already generated about the user's own data — one per indexed file, one per folder, one per source root and project, the unified model of the user, and one per past conversation. Use this BEFORE search_files or read_file for any question about the user's life, habits, projects, documents or photographs: it searches conclusions already drawn from those files, so it answers in one call what reading the files would take many. Returns the context text itself, with the path it came from.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to look for: a topic, activity, place, interest, or file/folder name. Natural phrasing is fine.',
          },
          levels: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['file', 'folder', 'sourceRoot', 'project', 'user', 'conversation'],
            },
            description: 'Restrict to certain levels of the hierarchy. Omit to search all of them. Use ["file"] for specific evidence, ["folder", "project"] for the bigger picture.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of contexts to return (default 8, max 20).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_context',
      description: 'The generated context for one specific file or folder, plus the summaries of the folders it feeds into. Give any trailing part of the path — "Training/Running.xlsx" is enough, the absolute path is not required. Use this when you already know which file or folder the question is about; use search_contexts when you do not.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file or folder path, or the end of it (e.g. "Training/Running.xlsx" or "archives/activity").',
          },
        },
        required: ['path'],
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
  {
    type: 'function',
    function: {
      name: 'work_document_info',
      description: "What is currently open in the user's Work tab: its name, kind, and the text it contains. Call this before editing so you are working from what is actually there rather than from memory.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_insert_text',
      description: 'Insert text into the open Work document at the cursor, or at the end. Use for adding a paragraph or a sentence — for building a whole document use work_apply_outline instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to insert. Plain text; newlines start new paragraphs.' },
          position: { type: 'string', enum: ['cursor', 'end'], description: 'Where to put it. Defaults to the cursor.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_replace_text',
      description: 'Find and replace text throughout the open Work document.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'The exact text to find.' },
          replace: { type: 'string', description: 'What to put in its place.' },
          matchCase: { type: 'boolean', description: 'Whether the search is case-sensitive. Defaults to true.' },
        },
        required: ['find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_apply_outline',
      description: 'Write a whole document in one call: a sequence of headings and paragraphs, appended to the open Work document. This is the tool to use when drafting from scratch — it is one round trip instead of fifty.',
      parameters: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            description: 'The sections, in order.',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Section heading. Omit for body-only text.' },
                level: { type: 'number', description: 'Heading level 1-3. Defaults to 1.' },
                paragraphs: { type: 'array', items: { type: 'string' }, description: 'Body paragraphs under the heading.' },
              },
            },
          },
        },
        required: ['sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_set_cells',
      description: 'Write a block of values into the open Work spreadsheet, starting at an anchor cell. Rows of values, filled left to right and top to bottom.',
      parameters: {
        type: 'object',
        properties: {
          anchor: { type: 'string', description: 'Top-left cell, e.g. "A1".' },
          values: {
            type: 'array',
            description: 'Rows of cell values.',
            items: { type: 'array', items: { type: 'string' } },
          },
        },
        required: ['anchor', 'values'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_add_slide',
      description: 'Append a slide to the open Work presentation, with a title and bullet points.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The slide title.' },
          bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points on the slide.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_create_document',
      description: "Open a new, empty document in the user's Work tab and switch them to it. Use this when the user asks you to make, write, or draft a document, spreadsheet or presentation. It returns once the editor is ready, after which you can fill it in with work_apply_outline, work_set_cells or work_add_slide. Do not paste the whole document into the chat as well — put it in the document.",
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['document', 'spreadsheet', 'presentation'],
            description: 'Which kind to create. A document for prose, a spreadsheet for tables and figures, a presentation for slides.',
          },
          name: { type: 'string', description: 'A file name for it, e.g. "Quarterly review.docx". Optional.' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_create',
      description: "Open a new, blank design canvas (the Graphite editor) in the user's Work tab and switch them to it. The kind decides what Save produces: 'vector' saves SVG — right for logos, layouts, diagrams and UI work; 'image' saves PNG — right for photographic or painterly composites. Either way you draw with design_paste_svg and design_generate_image_layer, and read the canvas back with design_read_svg. It returns once the editor is ready. Do not describe the whole design in chat as well — put it on the canvas.",
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['image', 'vector'],
            description: 'What Save exports: image (.png) or vector (.svg).',
          },
          name: { type: 'string', description: 'A file name for it, e.g. "Logo draft.svg". Optional.' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_document_info',
      description: 'The layer tree of the open design canvas: every layer with its name, type, nesting depth and visibility, plus whether there are unsaved changes. Call this before adding to the canvas so you know what is already there.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_read_svg',
      description: 'The whole open design canvas, rendered to SVG source — including what the user drew or changed since you last looked. Call this before and after editing so you are working from what is actually there rather than from memory. Raster layers appear as embedded images whose pixels you cannot judge; ask the user when appearance matters.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_paste_svg',
      description: 'Add SVG content to the open design canvas. It lands as native, editable layers the user can move, restyle and build on — this ADDS to the canvas, it does not replace it. Draw with shapes, paths and styles. SVG <text> elements are NOT imported: set type as <path> outlines, or place a shape where the type goes and tell the user to set it with the text tool. Scripts never execute.',
      parameters: {
        type: 'object',
        properties: {
          svg: { type: 'string', description: 'A complete SVG fragment or document, e.g. "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"800\\" height=\\"600\\">…</svg>".' },
          name: { type: 'string', description: 'A name for the layer group this creates, e.g. "Header lockup". Optional.' },
        },
        required: ['svg'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'design_generate_image_layer',
      description: 'Generate an image from a prompt and add it to the open design canvas as a new layer. The user can then move, mask and blend it with the other layers. Use one call per element you want to composite.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to generate, described the way you would brief an illustrator.' },
          name: { type: 'string', description: 'A short layer name, e.g. "Sky backdrop". Optional.' },
        },
        required: ['prompt'],
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

const CONTEXT_LEVELS: ContextSearchLevel[] = ['file', 'folder', 'sourceRoot', 'project', 'user', 'conversation']

/**
 * The generated contexts are already redacted at generation time, so what comes
 * back here needs no further filtering — but it is long-form prose, and eight
 * folder syntheses would be 70k characters of tool result. The per-hit cap is
 * what keeps a search from spending the whole context window.
 */
const MAX_TOOL_CONTEXT_CHARS = 4_000

function executeSearchContexts(args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new Error('query is required')
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(Math.floor(args.limit), 20))
    : 8
  const requested = Array.isArray(args.levels)
    ? args.levels.filter((level): level is ContextSearchLevel => (
      typeof level === 'string' && (CONTEXT_LEVELS as string[]).includes(level)
    ))
    : []

  const outcome = searchGeneratedContexts(query, {
    limit,
    maxContextChars: MAX_TOOL_CONTEXT_CHARS,
    ...(requested.length > 0 ? { levels: requested } : {}),
  })

  return JSON.stringify({
    query: outcome.query,
    terms: outcome.terms,
    results: outcome.hits.map((hit) => ({
      level: hit.level,
      label: hit.label,
      path: hit.path,
      project: hit.projectName,
      kind: hit.kind,
      fileCount: hit.fileCount,
      updatedAt: hit.updatedAt,
      context: hit.context,
    })),
    ...(outcome.notice ? { notice: outcome.notice } : {}),
  })
}

function executeGetContext(args: Record<string, unknown>): string {
  const target = typeof args.path === 'string' ? args.path.trim() : ''
  if (!target) throw new Error('path is required')
  const result = getGeneratedContextForPath(target, { maxContextChars: MAX_TOOL_CONTEXT_CHARS })
  if (!result.found || !result.node) {
    return JSON.stringify({ found: false, notice: result.notice })
  }
  return JSON.stringify({
    found: true,
    level: result.node.level,
    path: result.node.path,
    project: result.node.projectName,
    kind: result.node.kind,
    fileCount: result.node.fileCount,
    updatedAt: result.node.updatedAt,
    context: result.node.context,
    // The summaries this node was folded into: what Holmes concluded from it
    // alongside its siblings, which the node's own context does not say.
    enclosingFolders: result.ancestors.map((ancestor) => ({
      level: ancestor.level,
      path: ancestor.path,
      summary: ancestor.contextShort || ancestor.context,
    })),
    ...(result.candidates.length > 0 ? { otherMatches: result.candidates } : {}),
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

/**
 * The tools that only mean anything while a Work document is open.
 *
 * `work_create_document` is deliberately NOT in here: it is the tool that makes
 * a document open, so gating it on one already being open would mean the model
 * could never start. It is offered from anywhere, including the home screen.
 */
export const WORK_TOOL_NAMES = new Set([
  'work_document_info', 'work_insert_text', 'work_replace_text',
  'work_apply_outline', 'work_set_cells', 'work_add_slide',
])

/**
 * The tools that only mean anything while a design canvas is open. One set for
 * both kinds: Graphite is a single editor whose canvases all hold vector and
 * raster layers — the kind only decides what Save exports. `design_create` is
 * deliberately NOT in here, for the same reason work_create_document is
 * ungated: it is the tool that opens the canvas.
 */
export const DESIGN_TOOL_NAMES = new Set([
  'design_document_info', 'design_read_svg', 'design_paste_svg', 'design_generate_image_layer',
])

/** The tools that have nothing to search until something has been indexed. */
export const CONTEXT_TOOL_NAMES = new Set(['search_contexts', 'get_context'])

export function getToolDefinitions(
  options: {
    webSearchEnabled?: boolean
    workEditorOpen?: boolean
    designEditorKind?: 'image' | 'vector' | null
    contextSearchAvailable?: boolean
  } = {},
): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((definition) => {
    const name = definition.function.name
    if (name === 'web_search') return Boolean(options.webSearchEnabled)
    // Offered only when there is a corpus: a model told it can search contexts
    // will search them, and an empty index turns that into a wasted round trip
    // on every question about the user.
    if (CONTEXT_TOOL_NAMES.has(name)) return Boolean(options.contextSearchAvailable)
    // A model that cannot see these cannot try to edit a document that is not
    // open — cheaper than explaining the failure afterwards.
    if (WORK_TOOL_NAMES.has(name)) return Boolean(options.workEditorOpen)
    if (DESIGN_TOOL_NAMES.has(name)) return options.designEditorKind != null
    return true
  })
}

/**
 * Generate an image and composite it onto the open raster canvas as a layer.
 *
 * The generation runs HERE, in main, and only the data URL crosses to the
 * editor — the base64 never enters the model's context, and the tool result is
 * a summary rather than the pixels, so one generated layer cannot blow the
 * tool budget. The prompt is redacted before it leaves, the same rule as every
 * other outbound generation path (ipc.ts runGenerationTurn, landmine #5).
 */
async function generateImageLayer(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) throw new Error('A prompt is required')
  const model = getImageGenerationModel()
  if (!model) throw new Error('No image generation model is configured in Settings')
  const media = await generateImage(getProvider(), model, redactMemoryContent(prompt), signal)
  const name = typeof args.name === 'string' && args.name ? args.name : 'Generated layer'
  const outcome = (await requestEditor('design_add_image_layer', { name, dataUrl: media.dataUrl })) as {
    layers?: unknown[]
  }
  return {
    added: true,
    name,
    model: media.model,
    approxBytes: Math.floor(media.dataUrl.length * 0.75),
    layers: Array.isArray(outcome?.layers) ? outcome.layers : undefined,
  }
}

export async function executeToolCall(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const args = safeParseArgs(call.arguments)
    let result: string

    switch (call.name) {
      case 'work_create_document':
        result = JSON.stringify(await openWorkDocument(String(args.kind ?? 'document'), args.name as string | undefined))
        break

      case 'design_create':
        result = JSON.stringify(await openWorkDocument(args.kind === 'vector' ? 'vector' : 'image', args.name as string | undefined))
        break

      case 'work_document_info':
      case 'work_insert_text':
      case 'work_replace_text':
      case 'work_apply_outline':
      case 'work_set_cells':
      case 'work_add_slide':
      case 'design_document_info':
      case 'design_read_svg':
      case 'design_paste_svg':
        // Every one of these is the same shape: hand the arguments to the open
        // editor and report what it says. The arguments cross as DATA — see the
        // note in src/office-shell/shell.ts (and its design-shell twins) about
        // why they are never built into anything executable.
        result = JSON.stringify(await requestEditor(call.name, args as Record<string, unknown>))
        break

      case 'design_generate_image_layer':
        result = JSON.stringify(await generateImageLayer(args, signal))
        break
      case 'search_files':
        result = await executeSearchFiles(args, signal)
        break
      case 'search_contexts':
        result = executeSearchContexts(args)
        break
      case 'get_context':
        result = executeGetContext(args)
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
