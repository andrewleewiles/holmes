import { type FC, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faChevronRight, faCircleInfo, faFileLines, faFolderOpen, faGlobe, faLayerGroup,
  faPenRuler, faSearch, faSpinner, faTriangleExclamation, faWrench,
} from '@fortawesome/free-solid-svg-icons'
import type { ToolStep } from './turnGrouping'

type Icon = typeof faWrench

/**
 * How each tool announces itself: an icon, and what it is doing versus what it
 * did. Past tense once it has finished is what makes a finished turn read as a
 * record of work rather than a list of pending intentions.
 *
 * A tool with no entry still renders — the name is humanised and it gets the
 * generic wrench — so adding a tool never requires touching this file.
 */
const TOOLS: Record<string, { icon: Icon; running: string; done: string }> = {
  web_search: { icon: faGlobe, running: 'Searching the web', done: 'Searched the web' },
  search_files: { icon: faSearch, running: 'Searching files', done: 'Searched files' },
  read_file: { icon: faFileLines, running: 'Reading', done: 'Read' },
  list_directory: { icon: faFolderOpen, running: 'Listing folder', done: 'Listed folder' },
  get_file_info: { icon: faCircleInfo, running: 'Checking file', done: 'Checked file' },
  context_search: { icon: faLayerGroup, running: 'Searching context', done: 'Searched context' },
  work_document_info: { icon: faFileLines, running: 'Reading the document', done: 'Read the document' },
  work_insert_text: { icon: faPenRuler, running: 'Writing', done: 'Wrote to the document' },
  work_replace_text: { icon: faPenRuler, running: 'Replacing text', done: 'Replaced text' },
  work_apply_outline: { icon: faPenRuler, running: 'Drafting', done: 'Drafted the document' },
  work_set_cells: { icon: faPenRuler, running: 'Filling cells', done: 'Filled cells' },
  work_add_slide: { icon: faPenRuler, running: 'Adding a slide', done: 'Added a slide' },
  work_create_document: { icon: faFileLines, running: 'Creating a document', done: 'Created a document' },
  design_create: { icon: faPenRuler, running: 'Opening a canvas', done: 'Opened a canvas' },
  design_document_info: { icon: faLayerGroup, running: 'Reading the canvas', done: 'Read the canvas' },
  design_read_svg: { icon: faLayerGroup, running: 'Reading the canvas', done: 'Read the canvas' },
  design_paste_svg: { icon: faPenRuler, running: 'Drawing', done: 'Added to the canvas' },
  design_generate_image_layer: { icon: faPenRuler, running: 'Generating a layer', done: 'Added a generated layer' },
}

function humanise(name: string): string {
  const words = name.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The short bit of context beside the label — the query, the file, the heading —
 * so a collapsed row still says what it was about. Falls back to nothing rather
 * than dumping raw JSON into the line.
 */
function summarise(name: string, args: string): string {
  if (!args.trim()) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const fields = parsed as Record<string, unknown>

  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = fields[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  const path = first('path')
  if (path) return path.split('/').pop() || path
  return first('query', 'prompt', 'find', 'name', 'kind', 'anchor', 'title', 'text')
}

/** Result payloads run to 200KB. Enough to inspect, never enough to hang a frame. */
const MAX_PAYLOAD_CHARS = 4_000

function formatPayload(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  let pretty = text
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // Not JSON: shown as it came.
  }
  return pretty.length > MAX_PAYLOAD_CHARS
    ? `${pretty.slice(0, MAX_PAYLOAD_CHARS)}\n\n… truncated (${pretty.length.toLocaleString()} characters total)`
    : pretty
}

const Payload: FC<{ title: string; body: string }> = ({ title, body }) => (
  <div>
    <div className="mb-1 text-[10px] uppercase tracking-wide text-white/25">{title}</div>
    <pre className="max-h-64 overflow-auto scrollbar-thin whitespace-pre-wrap break-words rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-white/50">
      {body}
    </pre>
  </div>
)

/**
 * One tool call, with its result folded in: a single quiet row that expands to the
 * arguments and what came back. Previously the call and the result were two
 * separate blocks in different places, which read as two unrelated events.
 */
export const ToolStepRow: FC<{ step: ToolStep }> = ({ step }) => {
  const [open, setOpen] = useState(false)
  const spec = TOOLS[step.name]
  const running = step.status === 'running'
  const failed = step.status === 'error'

  const label = spec
    ? (running ? spec.running : spec.done)
    : humanise(step.name)
  const detail = summarise(step.name, step.arguments)
  const args = formatPayload(step.arguments)
  const result = step.result === undefined ? '' : formatPayload(step.result)
  const expandable = Boolean(args || result)

  return (
    <div className={`overflow-hidden rounded-lg border transition-colors ${
      failed ? 'border-red-400/20 bg-red-400/[0.03]' : 'border-white/[0.07] bg-white/[0.02]'
    }`}>
      <button
        type="button"
        onClick={() => expandable && setOpen((value) => !value)}
        aria-expanded={expandable ? open : undefined}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] ${
          expandable ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-default'
        }`}
      >
        <FontAwesomeIcon
          icon={faChevronRight}
          className={`w-2.5 shrink-0 text-white/25 transition-transform ${open ? 'rotate-90' : ''} ${expandable ? '' : 'invisible'}`}
        />
        <FontAwesomeIcon
          icon={failed ? faTriangleExclamation : spec?.icon ?? faWrench}
          className={`w-3 shrink-0 ${failed ? 'text-red-300/60' : 'text-holmes-primary/60'}`}
        />
        <span className={failed ? 'text-red-200/70' : 'text-white/55'}>{label}</span>
        {detail && <span className="truncate text-white/30">{detail}</span>}
        {/* A finished row says nothing here on purpose: the past-tense label is
            already the outcome, and a row of green ticks is noise. */}
        {step.status !== 'done' && (
          <span className="ml-auto shrink-0 pl-2 text-white/25">
            {running && <FontAwesomeIcon icon={faSpinner} className="animate-spin" />}
            {failed && 'failed'}
            {step.status === 'interrupted' && 'no result'}
          </span>
        )}
      </button>

      {open && expandable && (
        <div className="space-y-2 border-t border-white/[0.06] px-2.5 py-2">
          {args && <Payload title="Arguments" body={args} />}
          {result && <Payload title={failed ? 'Error' : 'Result'} body={result} />}
        </div>
      )}
    </div>
  )
}
