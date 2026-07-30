import { type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faBriefcase,
  faFileLines,
  faFilePowerpoint,
  faImage,
  faPenNib,
  faTable,
} from '@fortawesome/free-solid-svg-icons'
import { WORK_DOCUMENT_TYPES, type WorkDocumentKind, type WorkDocumentType } from '@shared/workDocuments'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'

const KIND_ICONS: Record<WorkDocumentKind, typeof faFileLines> = {
  document: faFileLines,
  spreadsheet: faTable,
  presentation: faFilePowerpoint,
  image: faImage,
  vector: faPenNib,
}

interface WorkPageProps {
  onRequestKind: (kind: WorkDocumentKind) => void
  /** True when a Designer tool routed here: the design pair leads. */
  designFirst?: boolean
}

/**
 * The Work tab with nothing open: pick a kind of document to start.
 *
 * The live document is not here — it is `WorkspaceView`, mounted by App so that
 * navigating away cannot unmount it while Holmes is mid-task. This page is only
 * ever shown when there is no open document.
 */
export const WorkPage: FC<WorkPageProps> = ({ onRequestKind, designFirst = false }) => {
  const documents = WORK_DOCUMENT_TYPES.filter((type) => type.editor === 'office')
  const designs = WORK_DOCUMENT_TYPES.filter((type) => type.editor !== 'office')
  const groups: Array<{ label: string; types: WorkDocumentType[] }> = designFirst
    ? [
        { label: 'Design', types: designs },
        { label: 'Documents', types: documents },
      ]
    : [
        { label: 'Documents', types: documents },
        { label: 'Design', types: designs },
      ]

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        icon={<FontAwesomeIcon icon={faBriefcase} className={PAGE_HEADER_ICON} />}
        title="Work"
      />

      <div className="px-6 py-6">
        {groups.map((group) => (
          <div key={group.label} className="mb-6 max-w-3xl">
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wider text-white/35">{group.label}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {group.types.map((type) => (
                <button
                  key={type.kind}
                  onClick={() => onRequestKind(type.kind)}
                  className="flex cursor-pointer flex-col items-start gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-4 text-left transition-colors hover:border-white/20 hover:bg-white/[0.04]"
                >
                  <FontAwesomeIcon icon={KIND_ICONS[type.kind]} className="text-[20px] text-white/40" />
                  <span className="text-[15px] text-white/85">{type.label}</span>
                  <span className="text-[13px] leading-snug text-white/45">{type.description}</span>
                  <span className="mt-1 font-mono text-[11px] text-white/30">{type.extension}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <p className="mt-8 max-w-3xl text-[13px] leading-relaxed text-white/45">
          Pick a kind of document to start, or ask Holmes to make one. A document
          stays open while Holmes is working on it, even if you go elsewhere.
        </p>
      </div>
    </div>
  )
}
