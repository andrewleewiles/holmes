// The kinds of document the Work tab creates and edits.
//
// One list, shared by the renderer and the main process, because the kind has
// to mean the same thing in three places that are easy to let drift: the
// sidebar's "New …" entries, the file the editor is asked to create, and the
// extension the document is eventually written to disk with.
//
// Deliberately free of Electron and React imports so both sides can use it.

export type WorkDocumentKind = 'document' | 'spreadsheet' | 'presentation' | 'image' | 'vector'

/** Which embedded app edits a kind — the office suite or the design editor. */
export type WorkEditor = 'office' | 'graphite'

export interface WorkDocumentType {
  kind: WorkDocumentKind
  /** What the thing is called on its own — page titles, empty states. */
  label: string
  /** The sidebar entry. Spelled out rather than built from `label` so a
   *  future rename of one does not silently rename the other. */
  newLabel: string
  /** The extension a new document of this kind is saved as. */
  extension: '.docx' | '.xlsx' | '.pptx' | '.png' | '.svg'
  /** Default basename, before the uniquifying suffix. */
  defaultBaseName: string
  /** One line describing what this kind is for, shown on the Work page. */
  description: string
  /** The frame that hosts it: OfficeEditorFrame or DesignEditorFrame. */
  editor: WorkEditor
}

export const WORK_DOCUMENT_TYPES: readonly WorkDocumentType[] = [
  {
    kind: 'document',
    label: 'Document',
    newLabel: 'New Document',
    extension: '.docx',
    defaultBaseName: 'Untitled document',
    description: 'Letters, notes, reports — anything that is mostly prose.',
    editor: 'office',
  },
  {
    kind: 'spreadsheet',
    label: 'Spreadsheet',
    newLabel: 'New Spreadsheet',
    extension: '.xlsx',
    defaultBaseName: 'Untitled spreadsheet',
    description: 'Tables, budgets, models — anything with rows and formulas.',
    editor: 'office',
  },
  {
    kind: 'presentation',
    label: 'Presentation',
    newLabel: 'New Presentation',
    extension: '.pptx',
    defaultBaseName: 'Untitled presentation',
    description: 'Slides for a talk, a pitch, or a walkthrough.',
    editor: 'office',
  },
  {
    kind: 'image',
    label: 'Image',
    newLabel: 'New Image',
    extension: '.png',
    defaultBaseName: 'Untitled image',
    description: 'Photographic and painterly work — composited layers, saved as pixels.',
    editor: 'graphite',
  },
  {
    kind: 'vector',
    label: 'Vector design',
    newLabel: 'New Vector',
    extension: '.svg',
    defaultBaseName: 'Untitled design',
    description: 'Logos, layouts, diagrams — shapes that stay sharp at any size.',
    editor: 'graphite',
  },
]

const BY_KIND = new Map<WorkDocumentKind, WorkDocumentType>(
  WORK_DOCUMENT_TYPES.map((type) => [type.kind, type]),
)

export function workDocumentType(kind: WorkDocumentKind): WorkDocumentType {
  const type = BY_KIND.get(kind)
  // The map is built from the same list the type union is written from, so a
  // miss means the two have drifted — worth failing loudly rather than
  // defaulting to 'document' and silently creating the wrong file.
  if (!type) throw new Error(`Unknown work document kind: ${kind}`)
  return type
}

/** The kind a file on disk opens as, or null when it is not an editable one. */
export function workDocumentKindForExtension(extension: string): WorkDocumentKind | null {
  const normalized = extension.toLowerCase()
  return WORK_DOCUMENT_TYPES.find((type) => type.extension === normalized)?.kind ?? null
}

export function isWorkDocumentKind(value: unknown): value is WorkDocumentKind {
  return typeof value === 'string' && BY_KIND.has(value as WorkDocumentKind)
}
