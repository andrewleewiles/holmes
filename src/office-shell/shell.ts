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
 * Retuning ~30 variables beats authoring a custom theme: the built-in already
 * sets all 275, and this only has to move the ones that carry the visual
 * identity — the neutral greys onto Holmes' warm near-black, and the blue
 * accent onto the teal. Anything not listed keeps the built-in dark value,
 * which is the right fallback when ONLYOFFICE adds a variable.
 *
 * Injected into the editor frame rather than shipped as a stylesheet because
 * the frame's markup is third-party and this page is same-origin with it.
 */
const HOLMES_SKIN = `
:root, .theme-night {
  /* Surfaces: #222 -> holmes-bg, #404040 -> holmes-surface */
  --toolbar-header-document: #20201e;
  --toolbar-header-spreadsheet: #20201e;
  --toolbar-header-presentation: #20201e;
  --toolbar-header-pdf: #20201e;
  --toolbar-header-visio: #20201e;
  --background-normal: #2a2a27;
  --background-toolbar: #252321;
  --background-toolbar-tab: #252321;
  --background-toolbar-additional: #2a2a27;
  --background-pane: #20201e;
  --background-contrast-popover: #2a2a27;
  --background-statusbar: #252321;
  --canvas-background: #20201e;
  --canvas-ruler-background: #20201e;
  --canvas-cell-title-background: #20201e;

  /* Lines and controls: #585858 -> #3a3733, #686868 -> #56554f */
  --border-divider: #3a3733;
  --border-regular-control: #56554f;
  --canvas-ruler-border: #3a3733;
  --canvas-ruler-margins-background: #3a3733;
  --highlight-button-hover: #35312f;
  --highlight-button-pressed: #3f3a37;
  --highlight-button-pressed-hover: #4a4441;
  --chb-background-normal-hover: #35312f;
  --rb-background-normal-hover: #35312f;
  --slider-track-background-normal: #56554f;

  /* Text, warmed to match the app */
  --text-normal: #e8e3df;
  --text-normal-pressed: #f4f0ed;
  --text-secondary: #b3aca7;
  --text-tertiary: #9b948f;
  --text-toolbar-header: #e8e3df;
  --icon-toolbar-header: #c7c0bb;

  /* Accent: every variable that carries ONLYOFFICE blue -> Holmes teal.
     The active-tab underline is its own per-editor variable, which is why the
     ribbon still read blue when only --background-accent-button was moved. */
  --background-accent-button: #47a08f;
  --background-primary-dialog-button: #47a08f;
  --highlight-toolbar-tab-underline-document: #47a08f;
  --highlight-toolbar-tab-underline-spreadsheet: #47a08f;
  --highlight-toolbar-tab-underline-presentation: #47a08f;
  --highlight-toolbar-tab-underline-pdf: #47a08f;
  --highlight-toolbar-tab-underline-visio: #47a08f;
  --border-preview-select: #47a08f;
  --border-control-focus: #47a08f;
  --border-button-pressed-focus: #47a08f;
  --border-fill-input-focused: #47a08f;
  --chb-border-normal-focus: #47a08f;
  --chb-border-checked-focus: #47a08f;
  --rb-border-normal-focus: #47a08f;
  --rb-border-checked-focus: #47a08f;
  --slider-track-background-filled: #47a08f;
  --slider-thumb-background-normal: #47a08f;
  --slider-thumb-background-active: #47a08f;
  --text-link: #5bbaa8;
  --text-link-hover: #5bbaa8;
  --text-link-active: #31786b;
  --text-link-visited: #5bbaa8;
}
`

/** The editor iframe is created by DocsAPI inside this page, so same-origin. */
function editorDocument(): Document | null {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[name="frameEditor"]')
  try {
    return frame?.contentDocument ?? null
  } catch {
    return null
  }
}

/**
 * Kept on an interval rather than applied once: the wrapper remounts the editor
 * frame when the document or theme changes, which drops the injected tag.
 */
function keepSkinApplied(): void {
  const apply = () => {
    const doc = editorDocument()
    if (!doc?.head || doc.getElementById('holmes-skin')) return
    const style = doc.createElement('style')
    style.id = 'holmes-skin'
    style.textContent = HOLMES_SKIN
    doc.head.appendChild(style)
  }
  apply()
  window.setInterval(apply, 500)
}

let manager: OnlyOfficeManager | null = null

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
}

async function openFile(name: string, bytes: Uint8Array): Promise<void> {
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
    case 'setReadOnly':
      if (!manager) throw new Error('No document is open')
      await manager.setReadOnly(Boolean(payload.value))
      return { readOnly: Boolean(payload.value) }
    case 'ping':
      return { ok: true, hasManager: Boolean(manager) }
    default:
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
