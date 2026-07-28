/**
 * Loads pdfjs-dist in a form that works in the Electron MAIN process.
 *
 * The package's default entry is the modern browser build: it reaches for DOM
 * globals at module scope and throws `ReferenceError: DOMMatrix is not defined`
 * the moment a document is opened in a Node context. Nothing catches that as a
 * PDF-specific problem — the health ingester left the record stuck on 'pending'
 * and the document indexer skipped the file with no row at all — so every PDF in
 * the app silently produced nothing.
 *
 * The `legacy` build ships the shims for exactly this environment. Every
 * main-process PDF read must go through here rather than importing the package
 * directly, or it will reintroduce the same silent failure.
 */
export async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as typeof import('pdfjs-dist')
}
