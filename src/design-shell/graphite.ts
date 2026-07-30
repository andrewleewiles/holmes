// The design editor shell: Graphite, wrapped for the Work tab.
//
// Graphite is a Rust editor compiled to wasm; its frontend drives it through
// a generated command API (EditorWrapper) and receives FrontendMessages back.
// Two small vendored patches (see PATCHES.md) expose that pair to this page:
// the editor window publishes `holmesEditor` (the command API) and calls
// `holmesTap(type, data)` with every FrontendMessage before the frontend's own
// router sees it. A truthy return from the tap consumes the message — that is
// how an export this shell requested becomes bytes for Holmes instead of a
// browser download.
//
// THE RULE from office-shell/shell.ts still governs: model output is DATA.
// Payloads reach the editor only as typed command arguments — an SVG string
// through pasteSvg (parsed into native layers, never executed), raw RGBA
// pixels through pasteImage. Nothing is ever evaluated.
import { createEditorFrame, installShell, post, until } from './shared'

/** The slice of the generated command API this shell relies on. */
interface GraphiteEditor {
  pasteSvg: (name: string | undefined, svg: string, mouseX?: number, mouseY?: number, insertParentId?: bigint, insertIndex?: number) => void
  pasteImage: (name: string | undefined, imageData: Uint8Array, width: number, height: number, mouseX?: number, mouseY?: number, insertParentId?: bigint, insertIndex?: number) => void
  holmesExportDocument: (fileType: string, scaleFactor: number) => void
  holmesSaveDocument: () => void
  holmesMarkSaved: () => void
  holmesNewDocument: (name: string) => void
  deselectAllLayers: () => void
}
interface GraphiteWindow extends Window {
  holmesEditor?: GraphiteEditor
  holmesTap?: (messageType: string, messageData: unknown) => boolean
}

interface LayerDetails {
  id: number | bigint
  alias?: string
  implementationName?: string
  visible?: boolean
  unlocked?: boolean
}

const DEFAULT_NAME = 'Untitled design'
/** Same cap as work_document_info: a huge design must not blow the tool budget. */
const READ_CAP = 60_000
const EXPORT_TIMEOUT_MS = 20_000

/**
 * Holmes' palette over Graphite's own.
 *
 * Graphite themes itself through a sixteen-step neutral ramp on :root
 * (--color-0-black … --color-f-white), each with an -rgb twin used inside
 * rgba() compositions — so the whole chrome retunes by warming that ramp onto
 * Holmes' tones and both variables must move together. Injected as a <style>
 * appended after the app's single static sheet, which wins the cascade at
 * equal specificity; unlike ONLYOFFICE there is no lazy theme sheet to race,
 * so one injection holds. In-canvas overlays (selection outlines, handles)
 * are drawn by the wasm renderer and keep Graphite's own colors.
 */
const HOLMES_RAMP: Record<string, string> = {
  '0-black': '#141312',
  '1-nearblack': '#1a1917',
  '2-mildblack': '#20201e', // holmes-bg
  '3-darkgray': '#2e2d2a',
  '4-dimgray': '#3a3833',
  '5-dullgray': '#4a4741',
  '6-lowergray': '#575349',
  '7-middlegray': '#6a655c',
  '8-uppergray': '#7d786e',
  '9-palegray': '#8f8a80',
  'a-softgray': '#a29d93',
  'b-lightgray': '#b3aca7',
  'c-brightgray': '#c7c0bb',
  'd-mildwhite': '#d8d3cd',
  'e-nearwhite': '#e8e3df', // holmes text
  'f-white': '#f4f0ed',
}

/**
 * Chrome that belongs to a standalone app, not to a panel inside Holmes.
 *
 * The logo is the one `button` in the menu bar's widget row — every actual
 * menu beside it is a `div.text-button-container`, so the element selector is
 * what distinguishes them rather than a position. `.window-buttons` holds only
 * the window controls: in this embed that resolves to the fullscreen button,
 * which the iframe's permissions policy blocks anyway ("Permissions policy
 * violation: fullscreen is not allowed in this document").
 *
 * Done in CSS rather than as a fourth vendor patch: it is presentation, it
 * lives beside the palette it belongs with, and the worst case if Graphite
 * renames a class is that the chrome reappears — cosmetic, not broken.
 */
const HOLMES_CHROME = `
.menu-bar .widget-span.row > button.text-button.flush { display: none; }
.title-bar .window-buttons { display: none; }
`

function applySkin(win: Window): void {
  const doc = win.document
  if (doc.getElementById('holmes-skin')) return
  const rgb = (hex: string) =>
    `${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}`
  const lines = Object.entries(HOLMES_RAMP).flatMap(([step, hex]) => [
    `--color-${step}: ${hex};`,
    `--color-${step}-rgb: ${rgb(hex)};`,
  ])
  const style = doc.createElement('style')
  style.id = 'holmes-skin'
  style.textContent = `:root {\n${lines.join('\n')}\n--color-data-general: #b3aca7;\n}\n${HOLMES_CHROME}`
  doc.head.appendChild(style)
}

let openFileName = DEFAULT_NAME
let openKind: 'image' | 'vector' = 'vector'
let editorRef: GraphiteEditor | null = null

// What the tap has learned from the message stream, observed non-destructively.
let documentSaved = true
let lastReportedDirty: boolean | null = null
const layerDetails = new Map<string, LayerDetails>()
let layerOrder: Array<{ id: string; depth: number }> = []

// One export can be in flight at a time; the tap settles it.
let pendingExport: { resolve: (value: Uint8Array) => void } | null = null

const frame = createEditorFrame()

function toBytes(content: unknown): Uint8Array {
  // The payload was created in the editor window's realm, so `instanceof
  // Uint8Array` is false here; ArrayBuffer.isView is realm-safe. Copied into
  // this realm so the bytes survive the frame being torn down.
  if (ArrayBuffer.isView(content)) {
    return new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength))
  }
  if (Array.isArray(content)) return new Uint8Array(content)
  return new TextEncoder().encode(String(content ?? ''))
}

function installTap(win: GraphiteWindow): void {
  if (win.holmesTap) return
  win.holmesTap = (messageType: string, messageData: unknown) => {
    const data = messageData as Record<string, unknown>
    switch (messageType) {
      // The editor renders exports itself (vello rasterizes PNG on the GPU)
      // and delivers the finished bytes as a TriggerSaveFile.
      case 'TriggerSaveFile': {
        if (!pendingExport) return false
        const payload = (data?.TriggerSaveFile ?? data) as { content: unknown }
        const settle = pendingExport
        pendingExport = null
        settle.resolve(toBytes(payload.content))
        return true // consumed: this render is bytes for Holmes, not a download
      }
      // A Holmes canvas is stateless: every mount boots blank, and Holmes owns
      // durability through Save. Consuming the read leaves the frontend's
      // IndexedDB untouched and unread; consuming the writes keeps a Holmes
      // session from leaking into it.
      case 'TriggerPersistenceReadState':
      case 'TriggerPersistenceReadDocument':
      case 'TriggerPersistenceWriteState':
      case 'TriggerPersistenceWriteDocument':
      case 'TriggerPersistenceDeleteDocument':
        return true
      case 'UpdateOpenDocumentsList': {
        const docs = ((data?.UpdateOpenDocumentsList ?? data) as { openDocuments?: Array<{ isSaved?: boolean; is_saved?: boolean }> })?.openDocuments
        if (Array.isArray(docs) && docs.length) {
          documentSaved = docs.every((doc) => doc.isSaved !== false && doc.is_saved !== false)
          reportDirty()
        }
        return false // observed, never consumed — the tab bar needs it too
      }
      case 'UpdateDocumentLayerStructure': {
        interface StructureEntry { layerId: unknown; children?: StructureEntry[] }
        const structure = ((data?.UpdateDocumentLayerStructure ?? data) as { layerStructure?: StructureEntry[] })?.layerStructure
        if (Array.isArray(structure)) {
          const flatten = (entries: StructureEntry[], depth: number): Array<{ id: string; depth: number }> =>
            entries.flatMap((entry) => [{ id: String(entry.layerId), depth }, ...flatten(entry.children ?? [], depth + 1)])
          layerOrder = flatten(structure, 0)
        }
        return false
      }
      case 'UpdateDocumentLayerDetails': {
        const details = ((data?.UpdateDocumentLayerDetails ?? data) as { data?: LayerDetails })?.data
        if (details && details.id !== undefined) layerDetails.set(String(details.id), details)
        return false
      }
      default:
        return false
    }
  }
}

function reportDirty(): void {
  const dirty = !documentSaved
  if (dirty === lastReportedDirty) return
  lastReportedDirty = dirty
  post({ type: 'dirty', dirty })
}

async function editor(): Promise<GraphiteEditor> {
  if (editorRef) return editorRef
  editorRef = await until(() => {
    const win = frame.contentWindow as GraphiteWindow | null
    if (!win) return null
    installTap(win)
    // Injected from inside the poll, not after it: the stylesheet then lands
    // before Svelte mounts the app, so the unstyled chrome never flashes.
    if (win.document?.head) applySkin(win)
    return win.holmesEditor ?? null
  }, 'the Graphite API', 30_000)
  return editorRef
}

/** The whole document, rendered by the editor to finished file bytes. */
function exportDocument(fileType: 'svg' | 'png'): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (pendingExport) return reject(new Error('An export is already in flight'))
    const timer = window.setTimeout(() => {
      pendingExport = null
      // The editor reports export failures through a dialog layout this shell
      // does not parse, so all that is visible here is silence. The empty
      // canvas is by far the commonest cause (e.g. pasted SVG whose only
      // content was <text>, which the importer drops).
      reject(new Error('The editor did not produce the export — is the canvas empty?'))
    }, EXPORT_TIMEOUT_MS)
    pendingExport = {
      resolve: (bytes) => {
        window.clearTimeout(timer)
        resolve(bytes)
      },
    }
    editorRef!.holmesExportDocument(fileType, 1)
  })
}

/**
 * Marks the document clean in Graphite's own terms after Holmes has the bytes,
 * so the dirty flag tracks the editor's real state rather than a shadow
 * counter. Web documents have no path, so the editor's own save flow never
 * reaches MarkAsSaved for them — hence the patched command.
 */
function markSaved(): void {
  try {
    editorRef!.holmesMarkSaved()
  } catch { /* best-effort: a missed mark costs a stale dirty flag, not data */ }
}

/** Data URL images only: the payload is pixels, not a URL the frame would fetch. */
async function decodeImageDataUrl(value: unknown): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const url = String(value ?? '')
  if (!url.startsWith('data:image/')) throw new Error('An image data URL is required')
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The image could not be decoded'))
    image.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The shell could not decode the image')
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { pixels: new Uint8Array(data.data.buffer.slice(0)), width: canvas.width, height: canvas.height }
}

function layerList(): Array<Record<string, unknown>> {
  return layerOrder.map(({ id, depth }) => {
    const details = layerDetails.get(id)
    return {
      id,
      depth,
      name: details?.alias || details?.implementationName || 'Layer',
      type: details?.implementationName ?? null,
      visible: details?.visible ?? true,
      unlocked: details?.unlocked ?? true,
    }
  })
}

async function handle(action: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'open': {
      // Each open gets a freshly mounted frame (the WorkspaceView lifecycle).
      // With persistence severed the editor boots with an EMPTY document list,
      // which the frontend fills with its Welcome panel — so opening means
      // creating the named blank document a Work canvas is supposed to be.
      openKind = payload.kind === 'image' ? 'image' : 'vector'
      openFileName =
        typeof payload.name === 'string' && payload.name
          ? payload.name
          : `${DEFAULT_NAME}.${openKind === 'image' ? 'png' : 'svg'}`
      const api = await editor()
      api.holmesNewDocument(openFileName.replace(/\.[a-z]+$/i, ''))
      return { opened: true, kind: openKind }
    }

    case 'export': {
      await editor()
      const bytes = await exportDocument(openKind === 'image' ? 'png' : 'svg')
      markSaved()
      return { bytes, fileName: openFileName }
    }

    case 'design_document_info': {
      await editor()
      return {
        fileName: openFileName,
        kind: openKind,
        saved: documentSaved,
        layers: layerList(),
      }
    }

    case 'design_read_svg': {
      await editor()
      const svg = new TextDecoder().decode(await exportDocument('svg'))
      return {
        fileName: openFileName,
        kind: openKind,
        svg: svg.slice(0, READ_CAP),
        truncated: svg.length > READ_CAP,
        characters: svg.length,
      }
    }

    case 'design_paste_svg': {
      const api = await editor()
      const svg = String(payload.svg ?? '')
      if (!svg.trim()) throw new Error('An SVG document is required')
      const name = typeof payload.name === 'string' && payload.name ? payload.name : undefined
      // The string is parsed into native layers by the editor; never executed.
      api.pasteSvg(name, svg)
      return { pasted: true, name: name ?? null }
    }

    case 'design_add_image_layer': {
      const api = await editor()
      const { pixels, width, height } = await decodeImageDataUrl(payload.dataUrl)
      const name = typeof payload.name === 'string' && payload.name ? payload.name : 'Generated layer'
      api.pasteImage(name, pixels, width, height)
      return { added: true, name, width, height }
    }

    case 'ping':
      return { ok: true, ready: editorRef !== null }

    default:
      throw new Error(`Unknown action: ${action}`)
  }
}

installShell(handle)
