import { type ReactNode, forwardRef } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBriefcase } from '@fortawesome/free-solid-svg-icons'
import { WORK_DOCUMENT_TYPES, type WorkDocumentKind } from '@shared/workDocuments'
import type { WorkRole } from '@shared/workRoles'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { OfficeEditorFrame, type OfficeEditorHandle } from './OfficeEditorFrame'
import { DesignEditorFrame } from './DesignEditorFrame'

/** Both frames expose the same handle; the ref stays one type. */
export type EditorFrameHandle = OfficeEditorHandle

/**
 * The live document workspace: the conversation that asked for it on the left,
 * the editor on the right.
 *
 * Rendered by App rather than by the page cascade, and never unmounted by
 * navigation — see the comment at its call site. Leaving the Work tab has to
 * leave the document alone: unmounting this destroys the iframe, and with it
 * everything the user or Holmes has written that is not yet saved.
 */

interface WorkspaceViewProps {
  kind: WorkDocumentKind
  role: WorkRole | null
  tool: string | null
  projectName: string | null
  saving: boolean
  savedPath: string | null
  saveError: string | null
  onSave: () => void
  onClose: () => void
  onEditorReady: (ready: boolean) => void
  onDirtyChange: (dirty: boolean) => void
  /** The conversation that routed here, rendered alongside the document. */
  conversation?: ReactNode
}

export const WorkspaceView = forwardRef<EditorFrameHandle, WorkspaceViewProps>(function WorkspaceView(
  { kind, role, tool, projectName, saving, savedPath, saveError, onSave, onClose, onEditorReady, onDirtyChange, conversation },
  ref,
) {
  const type = WORK_DOCUMENT_TYPES.find((entry) => entry.kind === kind) ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={<FontAwesomeIcon icon={faBriefcase} className={PAGE_HEADER_ICON} />}
        title="Work"
        aside={
          <span className="flex items-center gap-2 text-[13px] text-white/45">
            {role && tool && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: role.color }} />}
            {role && tool ? `${role.role} · ${tool}` : type?.defaultBaseName}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-white/35">
              {saveError
                ? <span className="text-holmes-error">{saveError}</span>
                : savedPath
                  ? `Saved to ${savedPath.replace(/^.*\//, '')}`
                  : projectName
                    ? `Saves to ${projectName}`
                    : 'Saves where you choose'}
            </span>
            <button
              onClick={onSave}
              disabled={saving}
              title={projectName ? `Save into ${projectName}` : 'Choose where to save'}
              className={`rounded-md border px-2.5 py-1 text-[13px] transition-colors ${
                saving
                  ? 'border-white/[0.08] text-white/30 cursor-default'
                  : 'border-holmes-primary/40 text-holmes-primary-light hover:border-holmes-primary hover:bg-holmes-primary/10 cursor-pointer'
              }`}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={onClose}
              title="Leave the document open and go back"
              className="rounded-md border border-white/[0.12] px-2.5 py-1 text-[13px] text-white/60 transition-colors hover:border-white/25 hover:text-white/85 cursor-pointer"
            >
              Close
            </button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1">
        {conversation && (
          // Narrow enough to leave the document its page width, wide enough for
          // the conversation to read as itself rather than as a sidebar.
          <div className="flex w-[380px] shrink-0 flex-col border-r border-white/[0.06]">
            {conversation}
          </div>
        )}
        {type?.editor === 'office' ? (
          <OfficeEditorFrame
            ref={ref}
            kind={kind}
            onStateChange={(state) => onEditorReady(state === 'ready')}
            onDirtyChange={onDirtyChange}
          />
        ) : (
          <DesignEditorFrame
            ref={ref}
            kind={kind}
            onStateChange={(state) => onEditorReady(state === 'ready')}
            onDirtyChange={onDirtyChange}
          />
        )}
      </div>
    </div>
  )
})
