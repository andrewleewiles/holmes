// The Work tab's editor, running inside the frame rather than in Holmes.
//
// Why this exists at all: the vendored wrapper drives ONLYOFFICE by reaching
// into the editor iframe and replacing its XHR/fetch/socket.io with an
// in-memory server. That requires same-origin access. Holmes' renderer is
// `file://` and the editor is `holmes-office://`, so it cannot do that — the
// browser blocks it, and M0 proved it does.
//
// So the wrapper runs HERE, in a page served from `holmes-office://` that is
// same-origin with the editor iframe it creates. Holmes' renderer only ever
// embeds this page and talks to it by postMessage. No ONLYOFFICE code, and no
// `unsafe-eval`, ever enters Holmes' own origin.
import { OnlyOfficeManager } from './vendor/core/onlyoffice-manager'
import { editorManagerFactory } from './vendor/core/editor-manager'
import { FILE_TYPE, OFFICE_THEME, type FileType } from './vendor/const'

/** Mirrors WorkDocumentKind on the Holmes side; kept as strings across the wire. */
type Kind = 'document' | 'spreadsheet' | 'presentation'

// The wrapper's own constants — uppercase, and what exportAsBlob lowercases.
const KIND_FILE_TYPE: Record<Kind, FileType> = {
  document: FILE_TYPE.DOCX,
  spreadsheet: FILE_TYPE.XLSX,
  presentation: FILE_TYPE.PPTX,
}
const DEFAULT_NAME: Record<Kind, string> = {
  document: 'Untitled document.docx',
  spreadsheet: 'Untitled spreadsheet.xlsx',
  presentation: 'Untitled presentation.pptx',
}

const CONTAINER_ID = 'holmes-office-editor'

/**
 * The bundle is served flat, but the wrapper addresses it the way a real
 * deployment lays it out. The protocol handler maps that prefix back onto the
 * bundle root, so this needs no patch to the vendored code.
 */
OnlyOfficeManager.registerStaticResource({
  cdnOrigin: 'holmes-office://editor',
  onlyofficeVersion: '9.4.0',
})

/**
 * Holmes' palette, applied over ONLYOFFICE's built-in `theme-night`.
 *
 * Retuning ~35 variables beats authoring a custom theme: the built-in already
 * sets all 275, and this only has to move the ones carrying the visual
 * identity — the neutral greys onto Holmes' warm near-black, the blue accent
 * onto the teal. Anything unlisted keeps the built-in dark value, which is the
 * right fallback when ONLYOFFICE adds a variable.
 *
 * Set as inline custom properties with `important` rather than as a <style>
 * tag: the editor loads its theme stylesheet lazily, so an injected tag ends up
 * EARLIER in the cascade than the rules it is meant to beat and silently does
 * nothing. An inline important declaration does not depend on ordering.
 */
const HOLMES_SKIN: Record<string, string> = {
  // Surfaces: #222 -> holmes-bg, #404040 -> holmes-surface
  '--toolbar-header-document': '#20201e',
  '--toolbar-header-spreadsheet': '#20201e',
  '--toolbar-header-presentation': '#20201e',
  '--toolbar-header-pdf': '#20201e',
  '--toolbar-header-visio': '#20201e',
  '--background-normal': '#2a2a27',
  '--background-toolbar': '#252321',
  '--background-toolbar-tab': '#252321',
  '--background-toolbar-additional': '#2a2a27',
  '--background-pane': '#20201e',
  '--background-contrast-popover': '#2a2a27',
  '--background-statusbar': '#252321',
  '--canvas-background': '#20201e',
  '--canvas-ruler-background': '#20201e',
  '--canvas-cell-title-background': '#20201e',

  // Lines and controls
  '--border-divider': '#3a3733',
  '--border-regular-control': '#56554f',
  '--canvas-ruler-border': '#3a3733',
  '--canvas-ruler-margins-background': '#3a3733',
  '--highlight-button-hover': '#35312f',
  '--highlight-button-pressed': '#3f3a37',
  '--highlight-button-pressed-hover': '#4a4441',
  '--chb-background-normal-hover': '#35312f',
  '--rb-background-normal-hover': '#35312f',
  '--slider-track-background-normal': '#56554f',

  // Text, warmed to match the app
  '--text-normal': '#e8e3df',
  '--text-normal-pressed': '#f4f0ed',
  '--text-secondary': '#b3aca7',
  '--text-tertiary': '#9b948f',
  '--text-toolbar-header': '#e8e3df',
  '--icon-toolbar-header': '#c7c0bb',

  // Accent: every variable carrying ONLYOFFICE blue -> Holmes teal. The active
  // tab underline is its own per-editor variable, which is why the ribbon still
  // read blue when only --background-accent-button was moved.
  '--background-accent-button': '#47a08f',
  '--background-primary-dialog-button': '#47a08f',
  '--highlight-toolbar-tab-underline-document': '#47a08f',
  '--highlight-toolbar-tab-underline-spreadsheet': '#47a08f',
  '--highlight-toolbar-tab-underline-presentation': '#47a08f',
  '--highlight-toolbar-tab-underline-pdf': '#47a08f',
  '--highlight-toolbar-tab-underline-visio': '#47a08f',
  '--border-preview-select': '#47a08f',
  '--border-control-focus': '#47a08f',
  '--border-button-pressed-focus': '#47a08f',
  '--border-fill-input-focused': '#47a08f',
  '--chb-border-normal-focus': '#47a08f',
  '--chb-border-checked-focus': '#47a08f',
  '--rb-border-normal-focus': '#47a08f',
  '--rb-border-checked-focus': '#47a08f',
  '--slider-track-background-filled': '#47a08f',
  '--slider-thumb-background-normal': '#47a08f',
  '--slider-thumb-background-active': '#47a08f',
  '--text-link': '#5bbaa8',
  '--text-link-hover': '#5bbaa8',
  '--text-link-active': '#31786b',
  '--text-link-visited': '#5bbaa8',
}

/** The editor iframe is created by DocsAPI inside this page, so same-origin. */
function editorFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('iframe[name="frameEditor"]')
}

function editorDocument(): Document | null {
  try {
    return editorFrame()?.contentDocument ?? null
  } catch {
    return null
  }
}

/**
 * The editor's own api object — `Asc.editor` inside the frame.
 *
 * Same-origin property access, not evaluated code: this is the same reach the
 * skin already makes through `contentDocument`, and it is how the paper mode
 * gets at `asc_setContentDarkMode` and `asc_getPageColor`, which the wrapper
 * does not expose.
 */
function editorApi(): any | null {
  try {
    return (editorFrame()?.contentWindow as any)?.Asc?.editor ?? null
  } catch {
    return null
  }
}

/**
 * Paper mode: a new document is shown as Holmes rather than as a sheet of paper.
 *
 * The distinction that shapes all of this is which half is a VIEW and which half
 * is the FILE.
 *
 * Page colour and text colour are a view. ONLYOFFICE has a "dark document" mode
 * — `asc_setContentDarkMode` — that paints the page dark and draws automatic-
 * coloured text light, without touching the document. So the page reads as the
 * app background and the text reads as white while `styles.xml` still says
 * "automatic". Nothing to warn about, nothing to undo.
 *
 * The font is not a view. Glyphs come from real character formatting, so the
 * document genuinely is in Holmes Minion — it opens from a template that already
 * says so ({@link paperTemplate}). That is the half a reader elsewhere would see
 * differently, and the half the save dialog exists to ask about; the answer is
 * applied to the exported bytes in src/main/workPaper.ts.
 *
 * Documents only. A spreadsheet's cells and a slide's shapes carry their own
 * fills, so the same treatment would leave black text on a dark grid.
 */
const PAPER_PAGE_HEX = '#20201e'
const PAPER_PAGE_RGB = { r: 0x20, g: 0x20, b: 0x1e }
/** Must match PAPER_FONT in src/main/workPaper.ts and the committed template. */
const PAPER_FONT = 'Holmes Minion'

/**
 * ONLYOFFICE's dark document mode paints its own near-black (#3A3A3A) page on a
 * #616161 border, both hard-coded. That is a panel floating on Holmes' warmer
 * background rather than the page dissolving into it, so the two getters are
 * re-pointed at Holmes' own colour.
 *
 * Matched on the shape of the function rather than on its name: everything in
 * this build is minified, and the names rotate on every ONLYOFFICE release,
 * while the literals they return do not. If neither matches — because upstream
 * changed the colours or the mechanism — nothing is patched and the page simply
 * renders in ONLYOFFICE's grey, which is the failure worth having.
 */
const PAGE_FILL_SIGNATURE = /\?\s*\{\s*\w+:\s*58\s*,\s*\w+:\s*58\s*,\s*\w+:\s*58\s*\}/
const PAGE_BORDER_SIGNATURE = /\?\s*"#616161"/
const TINTED = '__holmesPaperTinted'

function retintDarkPaper(api: any): void {
  if (api[TINTED]) return
  api[TINTED] = true
  for (let target = api; target && target !== Object.prototype; target = Object.getPrototypeOf(target)) {
    for (const name of Object.getOwnPropertyNames(target)) {
      let source: string
      try {
        const value = target[name]
        if (typeof value !== 'function') continue
        source = Function.prototype.toString.call(value)
      } catch {
        continue
      }
      if (PAGE_FILL_SIGNATURE.test(source)) {
        const original = target[name]
        // The original still decides light-vs-dark; only the dark value moves.
        target[name] = function (this: any, ...args: unknown[]) {
          const value = original.apply(this, args)
          if (!value || value.ob !== 58) return value
          return { ...value, ob: PAPER_PAGE_RGB.r, Pc: PAPER_PAGE_RGB.g, Ib: PAPER_PAGE_RGB.b }
        }
      } else if (PAGE_BORDER_SIGNATURE.test(source)) {
        const original = target[name]
        target[name] = function (this: any, ...args: unknown[]) {
          const value = original.apply(this, args)
          return value === '#616161' ? PAPER_PAGE_HEX : value
        }
      }
    }
  }
}

/** True while the document is shown as Holmes rather than as white paper. */
let paperMode = false
/** Set once the user has answered the save dialog; stops it asking again. */
let paperSettled = false

/**
 * Re-asserted from the skin interval, not set once: the wrapper remounts the
 * editor frame when the document changes, and a remount builds a fresh api
 * object that has never heard of any of this.
 */
function keepPaperApplied(): void {
  const api = editorApi()
  if (!api) return

  // The user reaching for Layout > Page Color is them saying what the page
  // should look like. Holmes stops saying it — for good, not until the next
  // poll — and the real colour shows through.
  if (paperMode && pageColorIsSet(api)) {
    paperMode = false
    post({ type: 'paper', paper: false, settled: paperSettled })
  }

  if (typeof api.asc_setContentDarkMode !== 'function') return
  if (paperMode) retintDarkPaper(api)
  // Idempotent upstream: `trg` compares before it repaints.
  api.asc_setContentDarkMode(paperMode)
}

function pageColorIsSet(api: any): boolean {
  // Absent in older builds, in which case the Page Color button cannot have
  // been used either and there is nothing to defer to.
  if (typeof api.asc_getPageColor !== 'function') return false
  try {
    return api.asc_getPageColor() != null
  } catch {
    return false
  }
}

/**
 * The blank document paper mode opens, already set in Holmes Minion.
 *
 * Fetched rather than asking the editor for a blank one and then restyling it:
 * there is no working way to change document formatting from outside this
 * build's editor. The plugin connector's first `connect` is lost whenever it
 * lands before the editor's plugin runtime is listening, after which every
 * `callCommand` times out for the life of the document; and the editor api's
 * `put_TextPrFontName` moves the toolbar without reaching a single run — checked
 * against Liberation Serif as a control, which also changed nothing on the page.
 * A template needs neither: the font is in the file before the editor sees it.
 */
async function paperTemplate(): Promise<Uint8Array | null> {
  try {
    const response = await fetch('./paper.docx')
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  }
}

/**
 * Records how the save dialog was answered.
 *
 * Nothing is edited here. The choice is applied to the .docx that x2t exports,
 * in src/main/workPaper.ts — see the note there for why it cannot be done in the
 * editor. All this decides is whether to keep showing the document as Holmes.
 */
function settlePaper(choice: 'keep' | 'plain'): void {
  paperSettled = true
  // 'keep' writes the dark page into the file, so the view and the file now
  // agree and the treatment stays. 'plain' makes the file an ordinary white
  // document, and leaving the dark view on would put the screen and the file
  // straight back into the disagreement the dialog just resolved.
  if (choice === 'plain') paperMode = false
}

/**
 * Kept on an interval rather than applied once: the wrapper remounts the editor
 * frame when the document or theme changes, and the editor swaps body classes
 * as it finishes booting.
 */
let lastDirty: boolean | null = null

/**
 * Whether the document has edits that are not on disk. The wrapper tracks this
 * from the editor's own document-state events; this only forwards the changes.
 * Holmes treats unsaved work as a task in flight, so the workspace is not torn
 * down underneath it when the user navigates away.
 */
function reportDirty(): void {
  let dirty = false
  try {
    dirty = editorManagerFactory.get(CONTAINER_ID).isDirty()
  } catch {
    return
  }
  if (dirty === lastDirty) return
  lastDirty = dirty
  post({ type: 'dirty', dirty })
}

function keepSkinApplied(): void {
  const apply = () => {
    reportDirty()
    keepPaperApplied()
    const doc = editorDocument()
    if (!doc?.body) return
    // Both, because different variables are read against different roots.
    for (const target of [doc.documentElement, doc.body]) {
      for (const [name, value] of Object.entries(HOLMES_SKIN)) {
        if (target.style.getPropertyValue(name) === value) continue
        target.style.setProperty(name, value, 'important')
      }
    }
  }
  apply()
  window.setInterval(apply, 500)
}

let manager: OnlyOfficeManager | null = null
let openFileName = ''
let openKind: Kind = 'document'

/** Only the embedding renderer may drive this page. */
function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ holmesOffice: true, ...message }, '*')
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function open(kind: Kind, name?: string): Promise<void> {
  const fileName = name || DEFAULT_NAME[kind]

  // A new text document starts from the paper template rather than from the
  // editor's own blank, so it is in Holmes Minion before the editor has parsed
  // it. Spreadsheets and presentations have no paper mode and take the blank.
  const template = kind === 'document' ? await paperTemplate() : null
  if (template) {
    await loadFile(fileName, template)
    startPaperMode(true)
    return
  }

  dropConnector()
  openFileName = fileName
  openKind = kind
  if (!manager) {
    manager = await OnlyOfficeManager.create({
      containerId: CONTAINER_ID,
      fileType: KIND_FILE_TYPE[kind],
      defaultFileName: fileName,
      lang: 'en',
      theme: OFFICE_THEME.NIGHT,
      user: { id: 'holmes-local', name: 'You' },
    })
  } else {
    await manager.openNew(fileName)
  }
  // The template is the only thing that puts the font in the document, so
  // without it there is nothing shown differently from how the file would save
  // and nothing for the save dialog to ask about.
  startPaperMode(false)
}

/**
 * New text documents only.
 *
 * A document opened from disk is someone else's formatting. Showing it dark is
 * harmless and reversible, but it is their black text on their white page, and
 * darkening the page under it would only make it unreadable.
 */
function startPaperMode(paper: boolean): void {
  paperMode = paper
  paperSettled = !paper
  keepPaperApplied()
  post({ type: 'paper', paper: paperMode, settled: paperSettled })
}

async function openFile(name: string, bytes: Uint8Array): Promise<void> {
  await loadFile(name, bytes)
  // Not a new document: leave its own formatting alone. See startPaperMode.
  startPaperMode(false)
}

/** Hands bytes to the editor, whether they came from disk or from the template. */
async function loadFile(name: string, bytes: Uint8Array): Promise<void> {
  // A remount builds a fresh editor and a fresh connector; whatever was proven
  // against the last document does not carry over.
  dropConnector()
  openFileName = name
  // A File is what the wrapper's x2t path expects; it never touches the disk.
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name)
  const kind = name.endsWith('.xlsx') ? 'spreadsheet' : name.endsWith('.pptx') ? 'presentation' : 'document'
  if (!manager) {
    manager = await OnlyOfficeManager.createWithFile(
      {
        containerId: CONTAINER_ID,
        fileType: KIND_FILE_TYPE[kind],
        defaultFileName: name,
        lang: 'en',
        theme: OFFICE_THEME.NIGHT,
        user: { id: 'holmes-local', name: 'You' },
      },
      file,
    )
  } else {
    await manager.openFile(file)
  }
  openKind = kind
}

/**
 * Driving the editor on the model's behalf.
 *
 * THE RULE, and it is the whole of the security story here: model output is
 * DATA. `callCommand` stringifies the function you hand it and evaluates it
 * inside the editor frame — but it JSON-serialises `Asc.scope` separately and
 * injects that as a value. So every command function below is a LITERAL,
 * written here once, and everything variable reaches it through `Asc.scope`.
 *
 * Building a command by concatenating model output would hand arbitrary code
 * execution to whatever the model last read — including a .docx from an
 * untrusted source. Never pass a string to callCommand, and never build the
 * function body from a payload.
 */
type ConnectorLike = {
  callCommand: (fn: () => void, callback?: (value: unknown) => void) => void
  executeMethod: (name: string, args?: unknown[], callback?: (value: unknown) => void) => void
  /** DocsAPI internals — see the note on {@link liveConnector}. */
  callbacks?: unknown[]
  tasks?: unknown[]
  sendMessage?: (data: Record<string, unknown>) => void
}

declare const Api: any
declare const Asc: any

function connector(): ConnectorLike {
  if (!manager) throw new Error('No document is open')
  return manager.createConnector() as unknown as ConnectorLike
}

/**
 * A connector that has been PROVEN to answer, rather than one that merely says
 * it is connected.
 *
 * DocsAPI's connector serialises commands through a callback queue, and the
 * queue is what makes a single lost reply permanent
 * (`web-apps/apps/api/documents/api.js`):
 *
 *     this.callbacks.push(callback)
 *     if (1 !== this.callbacks.length) this.tasks.push(command)
 *     else this.sendMessage(command)
 *
 * A command is only actually SENT when it is the sole outstanding callback.
 * So the first command that never comes back leaves `callbacks` one entry deep
 * for good, and every command after it is parked in `tasks` and never sent —
 * one dropped reply wedges the connector for the life of the document. And what
 * drops it is the handshake: `connect()` fires `{type:"register"}` at the editor
 * with no acknowledgement, so a register that lands before the editor's plugin
 * runtime is listening is simply lost, and the first command then goes
 * unanswered. Opening a document is exactly when that race is live.
 *
 * `disconnect()` is no way out — it removes the listener and sends `unregister`
 * but leaves `callbacks` and `tasks` exactly as they were, so a reconnected
 * connector is still wedged. That is why simply reconnecting never recovered it.
 *
 * So: clear both queues, re-register, and prove the connector with a command
 * cheap enough to throw away. Only a connector that answers the probe is handed
 * out, and the moment one stops answering it is dropped and the next call
 * handshakes again.
 */
let live: Promise<ConnectorLike> | null = null

/** ~30s of trying. The editor normally answers on the first or second probe. */
const CONNECT_ATTEMPTS = 20
const PROBE_TIMEOUT_MS = 1500

function liveConnector(): Promise<ConnectorLike> {
  live ??= handshake().catch((error) => {
    live = null
    throw error
  })
  return live
}

/** After a dropped reply, or a document swap: the next call starts clean. */
function dropConnector(): void {
  live = null
}

async function handshake(): Promise<ConnectorLike> {
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    const candidate = connector()
    drainQueues(candidate)
    // Not `connect()`: that guards on `isConnected` and would either refuse or
    // add a second `message` listener, and two listeners shift two callbacks
    // off the queue for every one reply.
    try {
      candidate.sendMessage?.({ type: 'register' })
    } catch {
      // No frame yet. The wait below, then try again.
    }
    if (await probe(candidate)) return candidate
    await new Promise((resolve) => window.setTimeout(resolve, 500))
  }
  throw new Error('The editor never answered its connector')
}

/**
 * Both queues, because they are two halves of the same jam: a stale entry in
 * `callbacks` stops anything being sent, and a stale entry in `tasks` would be
 * sent later against a command nobody is waiting for.
 */
function drainQueues(target: ConnectorLike): void {
  if (Array.isArray(target.callbacks)) target.callbacks.length = 0
  if (Array.isArray(target.tasks)) target.tasks.length = 0
}

/** The cheapest possible round trip: a literal that computes nothing. */
function probe(target: ConnectorLike): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const timer = window.setTimeout(() => {
      if (answered) return
      answered = true
      resolve(false)
    }, PROBE_TIMEOUT_MS)
    try {
      target.callCommand(function () {
        return true
      } as unknown as () => void, () => {
        if (answered) return
        answered = true
        window.clearTimeout(timer)
        resolve(true)
      })
    } catch {
      answered = true
      window.clearTimeout(timer)
      resolve(false)
    }
  })
}

/** Puts the payload where the literal command functions read it from. */
function setScope(data: Record<string, unknown>): void {
  const w = window as unknown as { Asc?: { scope?: unknown } }
  w.Asc = w.Asc || {}
  w.Asc.scope = data
}

async function runCommand(data: Record<string, unknown>, fn: () => void, timeoutMs = 20_000): Promise<unknown> {
  const target = await liveConnector()
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      // The reply is gone, so the queue is jammed behind a callback nobody will
      // ever shift off. Throw the connector away rather than let the next
      // command queue up behind the corpse of this one.
      dropConnector()
      drainQueues(target)
      reject(new Error('The editor did not finish the edit'))
    }, timeoutMs)
    try {
      // After the await, so a slow handshake cannot let another command's scope
      // land between this one being prepared and being sent.
      setScope(data)
      target.callCommand(fn, (value) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(value ?? null)
      })
    } catch (error) {
      settled = true
      window.clearTimeout(timer)
      dropConnector()
      reject(error)
    }
  })
}

/** The document as plain text, for the model to read before it edits. */
function readDocumentText(): Promise<unknown> {
  return runCommand({}, function () {
    return Api.GetDocument().GetText()
  } as unknown as () => void)
}

async function editorAction(action: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'work_document_info': {
      const text = await readDocumentText().catch(() => '')
      const full = typeof text === 'string' ? text : ''
      return {
        fileName: openFileName,
        kind: openKind,
        // Capped: a long document must not blow the tool-result budget.
        text: full.slice(0, 60_000),
        truncated: full.length > 60_000,
        characters: full.length,
      }
    }

    case 'work_insert_text':
      return runCommand(
        { text: String(payload.text ?? ''), atEnd: payload.position === 'end' },
        function () {
          const doc = Api.GetDocument()
          const lines = String(Asc.scope.text).split('\n')
          if (Asc.scope.atEnd) {
            for (const line of lines) {
              const p = Api.CreateParagraph()
              p.AddText(line)
              doc.Push(p)
            }
          } else {
            for (const line of lines) {
              const p = Api.CreateParagraph()
              p.AddText(line)
              doc.InsertContent([p])
            }
          }
        } as unknown as () => void,
      )

    case 'work_replace_text':
      return runCommand(
        { find: String(payload.find ?? ''), replace: String(payload.replace ?? ''), matchCase: payload.matchCase !== false },
        function () {
          Api.GetDocument().SearchAndReplace({
            searchString: Asc.scope.find,
            replaceString: Asc.scope.replace,
            matchCase: Asc.scope.matchCase,
          })
        } as unknown as () => void,
      )

    case 'work_apply_outline':
      return runCommand(
        { sections: Array.isArray(payload.sections) ? payload.sections : [] },
        function () {
          const doc = Api.GetDocument()
          for (const section of Asc.scope.sections) {
            if (section.heading) {
              const h = Api.CreateParagraph()
              h.AddText(String(section.heading))
              const level = Math.min(3, Math.max(1, Number(section.level) || 1))
              try { h.SetStyle(doc.GetStyle('Heading ' + level)) } catch (e) { /* style may be absent */ }
              doc.Push(h)
            }
            for (const body of section.paragraphs || []) {
              const p = Api.CreateParagraph()
              p.AddText(String(body))
              doc.Push(p)
            }
          }
        } as unknown as () => void,
      )

    case 'work_set_cells':
      return runCommand(
        { anchor: String(payload.anchor ?? 'A1'), values: Array.isArray(payload.values) ? payload.values : [] },
        function () {
          const sheet = Api.GetActiveSheet()
          const start = sheet.GetRange(Asc.scope.anchor)
          const row0 = start.GetRow(), col0 = start.GetCol()
          for (let r = 0; r < Asc.scope.values.length; r++) {
            const row = Asc.scope.values[r] || []
            for (let c = 0; c < row.length; c++) {
              sheet.GetRangeByNumber(row0 + r, col0 + c).SetValue(String(row[c]))
            }
          }
        } as unknown as () => void,
      )

    case 'work_add_slide':
      return runCommand(
        { title: String(payload.title ?? ''), bullets: Array.isArray(payload.bullets) ? payload.bullets : [] },
        function () {
          const pres = Api.GetPresentation()
          const slide = Api.CreateSlide()
          pres.AddSlide(slide)
          const layout = pres.GetMaster(0).GetLayout(1)
          slide.ApplyLayout(layout)
          const title = Api.CreateShape('rect', 8000000, 1000000)
          title.GetContent().GetElement(0).AddText(Asc.scope.title)
          slide.AddObject(title)
          if (Asc.scope.bullets.length) {
            const body = Api.CreateShape('rect', 8000000, 3000000)
            const content = body.GetContent()
            for (let i = 0; i < Asc.scope.bullets.length; i++) {
              const p = i === 0 ? content.GetElement(0) : Api.CreateParagraph()
              p.AddText('• ' + String(Asc.scope.bullets[i]))
              if (i > 0) content.Push(p)
            }
            slide.AddObject(body)
          }
        } as unknown as () => void,
      )

    default:
      throw new Error(`Unknown editor action: ${action}`)
  }
}

async function handle(action: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'open':
      await open((payload.kind as Kind) ?? 'document', payload.name as string | undefined)
      return { opened: true }
    case 'openFile':
      await openFile(payload.name as string, new Uint8Array(payload.bytes as ArrayBuffer))
      return { opened: true }
    case 'export': {
      if (!manager) throw new Error('No document is open')
      // Bytes, not a download — Holmes writes the file itself, through its own
      // file-access scope. exportAsBlob is the one that runs Editor.bin through
      // x2t back into real OOXML; exportDocument returns the internal bin.
      const { blob, fileName } = await manager.exportAsBlob()
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { bytes, fileName }
    }
    // The save flow. Holmes asks `paper` what it is about to write, shows the
    // dialog if the answer is "a look that is not in the file", and sends back
    // whichever the user chose before it exports.
    case 'paper':
      return { paper: paperMode, settled: paperSettled, font: PAPER_FONT }
    case 'paperBake':
      settlePaper('keep')
      return { paper: paperMode, settled: paperSettled }
    case 'paperStrip':
      settlePaper('plain')
      return { paper: paperMode, settled: paperSettled }

    case 'setReadOnly':
      if (!manager) throw new Error('No document is open')
      await manager.setReadOnly(Boolean(payload.value))
      return { readOnly: Boolean(payload.value) }
    case 'ping':
      return { ok: true, hasManager: Boolean(manager) }
    default:
      // Everything the model drives arrives as a work_* action.
      if (action.startsWith('work_')) return await editorAction(action, payload)
      throw new Error(`Unknown action: ${action}`)
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { holmesOffice?: boolean; id?: number; action?: string } | null
  if (!data || data.holmesOffice !== true || typeof data.action !== 'string') return
  const id = data.id
  void handle(data.action, data as unknown as Record<string, unknown>)
    .then((result) => post({ type: 'result', id, result }))
    .catch((error) => post({ type: 'error', id, error: describe(error) }))
})

window.addEventListener('error', (event) => post({ type: 'crash', error: event.message }))

keepSkinApplied()
post({ type: 'shell-ready' })
