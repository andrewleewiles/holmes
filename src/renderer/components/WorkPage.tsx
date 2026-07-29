import { type FC } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBriefcase, faFileLines, faFilePowerpoint, faTable } from '@fortawesome/free-solid-svg-icons'
import { WORK_DOCUMENT_TYPES, type WorkDocumentKind } from '@shared/workDocuments'
import type { WorkRole } from '@shared/workRoles'
import { PageHeader, PAGE_HEADER_ICON } from './PageHeader'
import { OfficeEditorFrame } from './OfficeEditorFrame'

const KIND_ICONS: Record<WorkDocumentKind, typeof faFileLines> = {
  document: faFileLines,
  spreadsheet: faTable,
  presentation: faFilePowerpoint,
}

interface WorkPageProps {
  /** The kind the sidebar asked for, or null when Work was opened on its own. */
  requestedKind: WorkDocumentKind | null
  onRequestKind: (kind: WorkDocumentKind | null) => void
  /** Set when a role's tool was picked from the sidebar instead of a kind. */
  role: WorkRole | null
  tool: string | null
}

/**
 * The Work tab's landing page.
 *
 * The editor itself is not embedded yet, so this is deliberately explicit about
 * that rather than showing a blank canvas that looks broken. What it does carry
 * is the real choice of document kind, so the sidebar entries lead somewhere
 * that reflects what was picked.
 */
export const WorkPage: FC<WorkPageProps> = ({ requestedKind, onRequestKind, role, tool }) => {
  const requested = WORK_DOCUMENT_TYPES.find((type) => type.kind === requestedKind) ?? null

  if (requestedKind) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader
          icon={<FontAwesomeIcon icon={faBriefcase} className={PAGE_HEADER_ICON} />}
          title="Work"
          aside={
            <span className="flex items-center gap-2 text-[13px] text-white/45">
              {role && tool && (
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: role.color }} />
              )}
              {role && tool ? `${role.role} · ${tool}` : requested?.defaultBaseName}
            </span>
          }
          actions={
            <button
              onClick={() => onRequestKind(null)}
              className="rounded-md border border-white/[0.12] px-2.5 py-1 text-[13px] text-white/60 transition-colors hover:border-white/25 hover:text-white/85 cursor-pointer"
            >
              Close
            </button>
          }
        />
        <OfficeEditorFrame kind={requestedKind} />
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        icon={<FontAwesomeIcon icon={faBriefcase} className={PAGE_HEADER_ICON} />}
        title="Work"
        aside={
          role && tool ? (
            <span className="flex items-center gap-2 text-[13px] text-white/45">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: role.color }} />
              {role.role} · {tool}
            </span>
          ) : requested ? (
            <span className="text-[13px] text-white/45">{requested.defaultBaseName}</span>
          ) : null
        }
      />

      <div className="px-6 py-6">
        <div className="grid max-w-3xl gap-3 sm:grid-cols-3">
          {WORK_DOCUMENT_TYPES.map((type) => {
            const active = type.kind === requestedKind
            return (
              <button
                key={type.kind}
                onClick={() => onRequestKind(type.kind)}
                aria-pressed={active}
                className={`flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors cursor-pointer ${
                  active
                    ? 'border-holmes-primary/50 bg-holmes-primary/10'
                    : 'border-white/[0.08] bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                }`}
              >
                <FontAwesomeIcon
                  icon={KIND_ICONS[type.kind]}
                  className={`text-[20px] ${active ? 'text-holmes-primary' : 'text-white/40'}`}
                />
                <span className="text-[15px] text-white/85">{type.label}</span>
                <span className="text-[13px] leading-snug text-white/45">{type.description}</span>
                <span className="mt-1 font-mono text-[11px] text-white/30">{type.extension}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-8 max-w-3xl rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
          <p className="text-[14px] text-white/70">
            {role && tool
              ? `${tool} — the ${role.role} step ${role.character} would take you through.`
              : requested
                ? `A new ${requested.label.toLowerCase()} would open here.`
                : 'Pick a kind of document to start.'}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">
            The editor is not embedded yet. The conversion pipeline behind it has been proven —
            Word, Excel and PowerPoint files convert and save back with their content intact — but
            the editing surface itself is still to come.
          </p>
        </div>
      </div>
    </div>
  )
}
